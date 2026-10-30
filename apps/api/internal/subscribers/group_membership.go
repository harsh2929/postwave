// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-117 — Group Membership API for storefront.
//
// Real-time group-membership query backed by the normalized
// subscriber_group_memberships junction table (migration 1112, backfilled by
// 1113). The production router exposes only the authenticated surface:
//
//   1. GET /api/v1/subscribers/{id}/groups  (auth-required, internal use)
//      — returns the group memberships for one subscriber, resolved by the
//      Moosewave id or email, with the group definition fields (category,
//      name, type) joined in so an operator UI can render labels.
//
// A dormant PublicGroupMembership handler is retained for a future storefront
// integration, but main.go deliberately does not mount it. A public site key
// proves only tenant identity, so that handler additionally requires a signed
// subscriber-subject proof verifier before it performs any lookup.
//
// The junction table makes both lookups a single composite-index probe
// (tenant_id, subscriber_id) rather than a GIN scan over the subscribers.groups
// jsonb array — the difference that makes a per-pageview storefront call
// viable.

package subscribers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// ErrInvalidSiteKey is returned by the public path when the supplied site
// key does not resolve to a tenant (missing, malformed, or revoked).
var ErrInvalidSiteKey = errors.New("group_membership: invalid or missing site key")

// GroupMembership is one row of the membership lookup. It joins the
// junction row to its subscriber_groups definition so a caller gets the
// human-facing group fields (category/name/type) without a second call.
type GroupMembership struct {
	GroupID  string    `json:"group_id"`
	Category string    `json:"category"`
	Name     string    `json:"name"`
	Type     string    `json:"type"`
	JoinedAt time.Time `json:"joined_at"`
}

// GroupMembershipResponse is the authenticated endpoint response.
// SubscriberID is the resolved Moosewave row id; Groups is the (possibly
// empty) list of memberships.
type GroupMembershipResponse struct {
	SubscriberID string            `json:"subscriber_id"`
	Groups       []GroupMembership `json:"groups"`
}

// MountGroupMembershipRoutes wires the SUB-117 auth-required membership
// endpoint. PublicGroupMembership is intentionally not mounted by main.go.
func MountGroupMembershipRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/groups",
			observability.RecordSurfaceFunc("subscribers", "groups_list", d.GroupMemberships))
}

// GroupMemberships GET /api/v1/subscribers/{id}/groups
func (d *Deps) GroupMemberships(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "subscriber id or email required"))
		return
	}
	subID, groups, err := d.Repo.ListGroupMemberships(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, GroupMembershipResponse{SubscriberID: subID, Groups: groups})
}

// PublicGroupMembership GET /api/public/subscribers/{identifier}/groups
//
// No tenant context — the tenant is resolved from the public site key the
// storefront ships in its JS. The site key arrives either as the
// `site_key` / `key` query param or the X-Postwave-Site-Key header. The
// {identifier} path segment is matched against email / external_id /
// profile_id (the identify precedence).
func (d *Deps) PublicGroupMembership(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "X-Postwave-Subject-Proof")
	siteKey := publicSiteKey(r)
	if siteKey == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_site_key", "site key required"))
		return
	}
	identifier := strings.TrimSpace(chi.URLParam(r, "identifier"))
	if identifier == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_identifier", "identifier required"))
		return
	}
	proof := strings.TrimSpace(r.Header.Get("X-Postwave-Subject-Proof"))
	if proof == "" {
		proof = strings.TrimSpace(r.URL.Query().Get("subject_token"))
	}
	if proof == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_subject_proof", "subscriber proof required"))
		return
	}
	if d == nil || d.VerifyPublicGroupSubject == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("subject_verifier_unavailable", "subject-authenticated membership lookup unavailable"))
		return
	}
	if err := d.VerifyPublicGroupSubject(r.Context(), siteKey, identifier, proof); err != nil {
		// Keep the response identical for invalid proofs and unknown subjects;
		// anonymous callers must not gain an existence oracle.
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
		return
	}
	subID, groups, err := d.Repo.PublicListGroupMemberships(r.Context(), siteKey, identifier)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidSiteKey):
			writeJSON(w, http.StatusUnauthorized, errEnv("invalid_site_key", "invalid site key"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	_ = subID // Public callers receive no stable internal subscriber UUID.
	writeJSON(w, http.StatusOK, struct {
		Groups []GroupMembership `json:"groups"`
	}{Groups: groups})
}

// publicSiteKey extracts the storefront site key from the request, accepting
// either the query param (site_key/key) or the X-Postwave-Site-Key header.
func publicSiteKey(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Postwave-Site-Key")); v != "" {
		return v
	}
	if v := strings.TrimSpace(r.URL.Query().Get("site_key")); v != "" {
		return v
	}
	return strings.TrimSpace(r.URL.Query().Get("key"))
}

// hashSiteKey hashes the plaintext public site key for the
// conversion_tracking_keys lookup. SHA-256, matching
// conversions.HashTrackingKey (site keys are intended to be public, so no
// pepper) — kept package-local so subscribers does not import conversions.
func hashSiteKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// groupMembershipSelectSQL joins the junction table to its definitions. The
// WHERE/scope is appended by the caller so the same projection serves both
// the auth and public paths.
const groupMembershipSelectSQL = `
SELECT g.id::text, g.category, g.name, g.type, m.joined_at
  FROM subscriber_group_memberships m
  JOIN subscriber_groups g
    ON g.id = m.group_id
   AND g.tenant_id = m.tenant_id
`

// ListGroupMemberships resolves the subscriber (by id or email) and returns
// its group memberships. Auth path: binds app.tenant_id via db.WithTenant.
func (r *Repo) ListGroupMemberships(ctx context.Context, tenantID, id string) (string, []GroupMembership, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var subID string
	err = tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 LIMIT 1`, tenantID, id).Scan(&subID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}

	rows, err := tx.Query(ctx, groupMembershipSelectSQL+`
 WHERE m.tenant_id = $1::uuid AND m.subscriber_id = $2::uuid
 ORDER BY g.category, g.display_order, g.name`, tenantID, subID)
	if err != nil {
		return "", nil, err
	}
	groups, err := scanGroupMemberships(rows)
	if err != nil {
		return "", nil, err
	}
	return subID, groups, tx.Commit(ctx)
}

// PublicListGroupMemberships is the storefront read. It runs WITHOUT an
// app.tenant_id session: it resolves the tenant from the public site key
// (conversion_tracking_keys), binds app.public_group_tenant so the
// public_group_lookup RLS policy applies, resolves the identifier against
// email / external_id / profile_id, and returns the membership list.
func (r *Repo) PublicListGroupMemberships(ctx context.Context, siteKey, identifier string) (string, []GroupMembership, error) {
	if strings.TrimSpace(siteKey) == "" {
		return "", nil, ErrInvalidSiteKey
	}
	hash := hashSiteKey(siteKey)
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve tenant via the public-lookup policy on conversion_tracking_keys
	// (gated on app.conversion_track_hash — the established public site-key
	// mechanism). No app.tenant_id is bound at this point.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.conversion_track_hash', $1, true)`, hash); err != nil {
		return "", nil, err
	}
	var tenantID string
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text FROM conversion_tracking_keys
 WHERE key_hash = $1 AND revoked_at IS NULL
 LIMIT 1`, hash).Scan(&tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrInvalidSiteKey
	}
	if err != nil {
		return "", nil, err
	}

	// Bind the public-group tenant GUC so the subscribers + memberships +
	// groups reads below pass the public_group_lookup policy (memberships)
	// and the tenant-scoped reads on the joined tables.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_group_tenant', $1, true)`, tenantID); err != nil {
		return "", nil, err
	}
	// Also bind app.tenant_id so the subscribers / subscriber_groups RLS
	// (which only know the standard tenant GUC) admit the joined reads. The
	// tenant id came from an authenticated site key, so this is a legitimate
	// scoped session for exactly that tenant.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", nil, err
	}

	subID, err := resolvePublicSubscriberID(ctx, tx, tenantID, identifier)
	if err != nil {
		return "", nil, err
	}

	rows, err := tx.Query(ctx, groupMembershipSelectSQL+`
 WHERE m.tenant_id = $1::uuid AND m.subscriber_id = $2::uuid
 ORDER BY g.category, g.display_order, g.name`, tenantID, subID)
	if err != nil {
		return "", nil, err
	}
	groups, err := scanGroupMemberships(rows)
	if err != nil {
		return "", nil, err
	}
	return subID, groups, tx.Commit(ctx)
}

// resolvePublicSubscriberID matches the identifier against profile_id,
// external_id, then email (the identify precedence, minus phone which is a
// trait). Returns ErrNotFound when nothing matches.
func resolvePublicSubscriberID(ctx context.Context, tx pgx.Tx, tenantID, identifier string) (string, error) {
	identifier = strings.TrimSpace(identifier)
	// profile_id is a UUID; only attempt that lookup when it parses.
	if _, perr := uuid.Parse(identifier); perr == nil {
		var subID string
		err := tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND profile_id = $2::uuid
 ORDER BY updated_at DESC LIMIT 1`, tenantID, identifier).Scan(&subID)
		if err == nil {
			return subID, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
	}
	var subID string
	err := tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (external_id = $2 OR lower(email::text) = lower($2))
 ORDER BY updated_at DESC LIMIT 1`, tenantID, identifier).Scan(&subID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return subID, nil
}

// syncGroupMembershipsFromJSONB reconciles the subscriber_group_memberships
// junction rows for one subscriber against the canonical subscribers.groups
// jsonb (SUB-117). Called inside the same tx as the Upsert/Update write so the
// normalized membership table never drifts from the embedded jsonb the admin
// UI writes. Best-effort: a deployment that has not yet applied migration 1112
// (no junction table) silently no-ops rather than failing the mutation.
//
// The jsonb is an array of {name, category?, ...} objects (see
// compat.interestsToGroups). Each entry is resolved to a subscriber_groups
// definition by name (preferring an exact category match when present). We add
// any newly-present memberships and delete any that are no longer in the jsonb
// — a full reconcile rather than an append, so removing a group from the
// subscriber row removes the membership too.
func syncGroupMembershipsFromJSONB(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string, groups []map[string]any) error {
	// Collect (name, category) pairs from the jsonb. category "" means
	// "name-only match".
	type want struct{ name, category string }
	wants := make([]want, 0, len(groups))
	for _, g := range groups {
		name := strings.TrimSpace(toStr(g["name"]))
		if name == "" {
			continue
		}
		wants = append(wants, want{name: name, category: strings.TrimSpace(toStr(g["category"]))})
	}

	// Resolve each wanted (name, category) to a group_id. Skip names that do
	// not match a defined subscriber_groups row.
	wantIDs := map[string]struct{}{}
	for _, wnt := range wants {
		var groupID string
		err := tx.QueryRow(ctx, `
SELECT id::text FROM subscriber_groups
 WHERE tenant_id = $1::uuid
   AND name = $2
   AND ($3 = '' OR category = $3)
 ORDER BY display_order, category
 LIMIT 1`, tenantID, wnt.name, wnt.category).Scan(&groupID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			// A missing junction/definition table (pre-1112) surfaces here as a
			// query error; treat the whole sync as a no-op rather than failing
			// the mutation it piggybacks on.
			return nil //nolint:nilerr // best-effort sync; see doc comment
		}
		wantIDs[groupID] = struct{}{}
	}

	// Insert any wanted memberships not already present (idempotent).
	for groupID := range wantIDs {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_group_memberships (tenant_id, subscriber_id, group_id)
VALUES ($1::uuid, $2::uuid, $3::uuid)
ON CONFLICT (tenant_id, subscriber_id, group_id) DO NOTHING`,
			tenantID, subscriberID, groupID); err != nil {
			return nil //nolint:nilerr // best-effort sync; see doc comment
		}
	}

	// Delete any existing memberships no longer present in the jsonb.
	rows, err := tx.Query(ctx, `
SELECT group_id::text FROM subscriber_group_memberships
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID)
	if err != nil {
		return nil //nolint:nilerr // best-effort sync; see doc comment
	}
	var existing []string
	for rows.Next() {
		var gid string
		if scanErr := rows.Scan(&gid); scanErr != nil {
			rows.Close()
			return scanErr
		}
		existing = append(existing, gid)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, gid := range existing {
		if _, keep := wantIDs[gid]; keep {
			continue
		}
		if _, err := tx.Exec(ctx, `
DELETE FROM subscriber_group_memberships
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND group_id = $3::uuid`,
			tenantID, subscriberID, gid); err != nil {
			return err
		}
	}
	return nil
}

// toStr coerces an arbitrary jsonb-decoded value to a string. Used by the
// membership sync to read name/category off the groups jsonb entries.
func toStr(v any) string {
	if v == nil {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return s
}

func scanGroupMemberships(rows pgx.Rows) ([]GroupMembership, error) {
	defer rows.Close()
	out := []GroupMembership{}
	for rows.Next() {
		var gm GroupMembership
		if err := rows.Scan(&gm.GroupID, &gm.Category, &gm.Name, &gm.Type, &gm.JoinedAt); err != nil {
			return nil, err
		}
		out = append(out, gm)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
