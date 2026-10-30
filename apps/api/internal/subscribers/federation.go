package subscribers

// SUB-023 — Cross-tenant subscriber federation for agency/MSP workspaces.
//
// Agency tenancy already exists (tenants.parent_tenant_id +
// tenants.is_agency_account, migration 0127). This file links a child-workspace
// subscriber to a *master* subscriber in the agency parent workspace, so the
// same human across several of an agency's client workspaces can be represented
// as one master identity.
//
// The link rows live in federated_subscriber_map (migration 0477), OWNED by the
// child tenant (tenant_id = the child workspace). RLS isolates on tenant_id
// exactly as every other tenant-scoped table, so there is NO privileged
// cross-tenant read path. The parent/child relationship is VERIFIED in
// application code against tenants.parent_tenant_id before a link is created, so
// a tenant cannot federate into an unrelated workspace.
//
// Surface (all scoped to the current/child tenant):
//
//	GET    /api/v1/subscribers/{id}/federated-links
//	POST   /api/v1/subscribers/{id}/federated-links
//	DELETE /api/v1/subscribers/{id}/federated-links/{parent_subscriber_id}

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrParentNotAgency is returned when the supplied parent_tenant_id is not the
// current tenant's agency parent (tenants.parent_tenant_id). Maps to 422.
var ErrParentNotAgency = errors.New("parent_tenant_id is not this workspace's agency parent")

// ErrFederatedMasterNotFound keeps an invalid parent-workspace subscriber
// reference from becoming a durable dangling identity link. The existence
// check intentionally discloses no parent profile data to the child tenant.
var ErrFederatedMasterNotFound = errors.New("master subscriber not found in agency parent")

// FederationLink is one cross-tenant master-identity link.
type FederationLink struct {
	ID                 string    `json:"id"`
	ChildSubscriberID  string    `json:"child_subscriber_id"`
	ParentTenantID     string    `json:"parent_tenant_id"`
	MasterSubscriberID string    `json:"master_subscriber_id"`
	MatchType          string    `json:"match_type"`
	MatchKey           string    `json:"match_key,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
	SubscriberVersion  string    `json:"subscriber_version,omitempty"`
}

// FederationLinksPage binds a federation snapshot to the exact child-profile
// revision clients must echo before changing the identity graph.
type FederationLinksPage struct {
	Items             []FederationLink `json:"items"`
	SubscriberVersion string           `json:"subscriber_version"`
}

// CreateFederationLinkInput is the POST body. ParentTenantID +
// MasterSubscriberID identify the agency-parent master row; MatchType /
// MatchKey are provenance (defaulted to "manual"/"" when omitted).
type CreateFederationLinkInput struct {
	ParentTenantID     string `json:"parent_tenant_id"`
	MasterSubscriberID string `json:"master_subscriber_id"`
	MatchType          string `json:"match_type"`
	MatchKey           string `json:"match_key"`
}

func validFederationMatchType(v string) bool {
	switch v {
	case "email", "external_id", "manual":
		return true
	}
	return false
}

// GetFederatedLinks returns every federation link for the child subscriber,
// newest-first. Returns ErrNotFound when the subscriber itself does not exist
// in the tenant.
func (r *Repo) GetFederatedLinks(ctx context.Context, tenantID, subscriberID string) (*FederationLinksPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, child_subscriber_id::text, parent_tenant_id::text,
       master_subscriber_id::text, match_type, COALESCE(match_key, ''),
       created_at, updated_at
  FROM federated_subscriber_map
 WHERE tenant_id = $1::uuid AND child_subscriber_id = $2::uuid
 ORDER BY created_at DESC`, tenantID, sub.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FederationLink{}
	for rows.Next() {
		var l FederationLink
		if err := rows.Scan(&l.ID, &l.ChildSubscriberID, &l.ParentTenantID,
			&l.MasterSubscriberID, &l.MatchType, &l.MatchKey,
			&l.CreatedAt, &l.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &FederationLinksPage{Items: out, SubscriberVersion: sub.Version}, nil
}

// CreateFederationLink links the child subscriber to a master subscriber in the
// agency parent workspace. The parent relationship is verified against
// tenants.parent_tenant_id inside the same tx (read via the tenant-resolver
// scope, since the parent tenants row is not visible under the child's
// app.tenant_id). Idempotent: re-linking the same (child, master) pair returns
// the existing row. Returns:
//   - ErrNotFound        when the child subscriber does not exist
//   - ErrParentNotAgency when parent_tenant_id is not the child's agency parent
func (r *Repo) CreateFederationLink(
	ctx context.Context,
	tenantID, subscriberID string,
	in CreateFederationLinkInput,
	ifMatchToken string,
	auditMeta db.AuditMeta,
) (*FederationLink, error) {
	parentTenant := strings.TrimSpace(in.ParentTenantID)
	master := strings.TrimSpace(in.MasterSubscriberID)
	matchType := strings.ToLower(strings.TrimSpace(in.MatchType))
	if matchType == "" {
		matchType = "manual"
	}
	if !validFederationMatchType(matchType) {
		return nil, ErrInvalidInput
	}
	if parentTenant == "" || master == "" {
		return nil, ErrInvalidInput
	}

	// Verify the agency parent relationship BEFORE binding the child tenant
	// scope. The tenants row for the child is only visible under the resolver
	// scope (see migration 0333 tenant_resolver policy); we confirm the child's
	// parent_tenant_id equals the supplied parent.
	if err := r.verifyAgencyParent(ctx, tenantID, parentTenant); err != nil {
		return nil, err
	}
	if err := r.verifyFederatedMaster(ctx, parentTenant, master); err != nil {
		return nil, err
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := scanSubscriber(tx.QueryRow(ctx, `
SELECT `+subscriberColumns+`
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, subscriberID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if strings.TrimSpace(ifMatchToken) == "" || ifMatchToken != sub.Version {
		return nil, ErrPreconditionFailed
	}
	var l FederationLink
	row := tx.QueryRow(ctx, `
INSERT INTO federated_subscriber_map
    (tenant_id, child_subscriber_id, parent_tenant_id, master_subscriber_id, match_type, match_key)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)
ON CONFLICT (tenant_id, child_subscriber_id, master_subscriber_id) DO UPDATE SET
    parent_tenant_id = EXCLUDED.parent_tenant_id,
    match_type       = EXCLUDED.match_type,
    match_key        = EXCLUDED.match_key,
    updated_at       = now()
RETURNING id::text, child_subscriber_id::text, parent_tenant_id::text,
          master_subscriber_id::text, match_type, COALESCE(match_key, ''),
          created_at, updated_at`,
		tenantID, sub.ID, parentTenant, master, matchType, strings.TrimSpace(in.MatchKey))
	if err := row.Scan(&l.ID, &l.ChildSubscriberID, &l.ParentTenantID,
		&l.MasterSubscriberID, &l.MatchType, &l.MatchKey,
		&l.CreatedAt, &l.UpdatedAt); err != nil {
		if isInvalidUUID(err) {
			return nil, ErrInvalidInput
		}
		return nil, err
	}
	refreshed, err := scanSubscriber(tx.QueryRow(ctx, `
UPDATE subscribers
   SET updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+subscriberColumns, tenantID, sub.ID))
	if err != nil {
		return nil, err
	}
	l.SubscriberVersion = refreshed.Version
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.federated_link_created", "subscriber", sub.ID, map[string]any{
		"link_id":              l.ID,
		"parent_tenant_id":     l.ParentTenantID,
		"master_subscriber_id": l.MasterSubscriberID,
		"match_type":           l.MatchType,
		"previous_version":     sub.Version,
		"new_version":          refreshed.Version,
	}); err != nil {
		return nil, fmt.Errorf("audit subscriber federation link: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &l, nil
}

// verifyFederatedMaster confirms only that the supplied UUID resolves in the
// already-verified agency parent. It returns no parent profile attributes and
// therefore does not turn federation into a cross-tenant PII read surface.
func (r *Repo) verifyFederatedMaster(ctx context.Context, parentTenant, master string) error {
	tx, err := db.WithTenant(ctx, r.Pool, parentTenant)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM subscribers
   WHERE tenant_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL
)`, parentTenant, master).Scan(&exists); err != nil {
		if isInvalidUUID(err) {
			return ErrFederatedMasterNotFound
		}
		return err
	}
	if !exists {
		return ErrFederatedMasterNotFound
	}
	return tx.Commit(ctx)
}

// verifyAgencyParent confirms that the child tenant's tenants.parent_tenant_id
// equals parentTenant. Uses the tenant-resolver scope to read the tenants row
// (the child's own row is otherwise invisible under a per-tenant SELECT). A
// mismatch (or a missing parent) returns ErrParentNotAgency.
func (r *Repo) verifyAgencyParent(ctx context.Context, childTenant, parentTenant string) error {
	tx, err := db.WithTenantResolver(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ok bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM tenants
   WHERE id = $1::uuid AND parent_tenant_id = $2::uuid
)`, childTenant, parentTenant).Scan(&ok); err != nil {
		if isInvalidUUID(err) {
			return ErrParentNotAgency
		}
		return err
	}
	if !ok {
		return ErrParentNotAgency
	}
	return tx.Commit(ctx)
}

// DeleteFederationLink removes the link between the child subscriber and the
// given master subscriber. Returns ErrNotFound when no matching link exists.
func (r *Repo) DeleteFederationLink(
	ctx context.Context,
	tenantID, subscriberID, masterSubscriberID, ifMatchToken string,
	auditMeta db.AuditMeta,
) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := scanSubscriber(tx.QueryRow(ctx, `
SELECT `+subscriberColumns+`
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, subscriberID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if strings.TrimSpace(ifMatchToken) == "" || ifMatchToken != sub.Version {
		return "", ErrPreconditionFailed
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM federated_subscriber_map
 WHERE tenant_id = $1::uuid
   AND child_subscriber_id = $2::uuid
   AND master_subscriber_id = $3::uuid`,
		tenantID, sub.ID, strings.TrimSpace(masterSubscriberID))
	if err != nil {
		if isInvalidUUID(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	if tag.RowsAffected() == 0 {
		return "", ErrNotFound
	}
	refreshed, err := scanSubscriber(tx.QueryRow(ctx, `
UPDATE subscribers
   SET updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+subscriberColumns, tenantID, sub.ID))
	if err != nil {
		return "", err
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.federated_link_deleted", "subscriber", sub.ID, map[string]any{
		"master_subscriber_id": strings.TrimSpace(masterSubscriberID),
		"previous_version":     sub.Version,
		"new_version":          refreshed.Version,
	}); err != nil {
		return "", fmt.Errorf("audit subscriber federation unlink: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return refreshed.Version, nil
}

// GetFederatedMasterID returns the master_subscriber_id of the most-recent
// federation link for the child subscriber, for hydrating
// Subscriber.FederatedMasterID on the detail GET (SUB-023). Returns ("", nil)
// when the subscriber has no federation link — the common (non-federated)
// case. A subscriber may in principle carry several links; the newest wins,
// matching GetFederatedLinks' created_at-DESC ordering.
//
// It does NOT call getInTx first: the detail GET has already loaded the
// subscriber, so a missing subscriber here simply yields no rows ("", nil).
func (r *Repo) GetFederatedMasterID(ctx context.Context, tenantID, subscriberID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var master string
	err = tx.QueryRow(ctx, `
SELECT master_subscriber_id::text
  FROM federated_subscriber_map
 WHERE tenant_id = $1::uuid AND child_subscriber_id = $2::uuid
 ORDER BY created_at DESC
 LIMIT 1`, tenantID, subscriberID).Scan(&master)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return master, nil
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

// MountFederationRoutes registers the SUB-023 federation surface. The read is
// read-scoped; the mutating create/delete require write:subscribers (they
// change the workspace's identity graph).
func MountFederationRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/federated-links", d.ListFederatedLinks)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/{id}/federated-links", d.CreateFederatedLink)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/subscribers/{id}/federated-links/{parent_subscriber_id}", d.DeleteFederatedLink)
}

// ListFederatedLinks GET /api/v1/subscribers/{id}/federated-links
func (d *Deps) ListFederatedLinks(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	page, err := d.Repo.GetFederatedLinks(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeFederationErr(w, r, err)
		return
	}
	w.Header().Set("ETag", page.SubscriberVersion)
	writeJSON(w, http.StatusOK, page)
}

// CreateFederatedLink POST /api/v1/subscribers/{id}/federated-links
func (d *Deps) CreateFederatedLink(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ifMatch, ok := requireExactFederationIfMatch(w, r)
	if !ok {
		return
	}
	var in CreateFederationLinkInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	link, err := d.Repo.CreateFederationLink(
		r.Context(),
		t.ID,
		chi.URLParam(r, "id"),
		in,
		ifMatch,
		middleware.AuditMetaFromRequest(r),
	)
	if err != nil {
		d.writeFederationErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.federated_link.created", map[string]any{
		"child_subscriber_id":  link.ChildSubscriberID,
		"parent_tenant_id":     link.ParentTenantID,
		"master_subscriber_id": link.MasterSubscriberID,
	})
	w.Header().Set("ETag", link.SubscriberVersion)
	writeJSON(w, http.StatusCreated, link)
}

// DeleteFederatedLink DELETE /api/v1/subscribers/{id}/federated-links/{parent_subscriber_id}
//
// The path param is named parent_subscriber_id per the gap-register spec; it is
// the master subscriber id in the parent workspace.
func (d *Deps) DeleteFederatedLink(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ifMatch, ok := requireExactFederationIfMatch(w, r)
	if !ok {
		return
	}
	master := chi.URLParam(r, "parent_subscriber_id")
	version, err := d.Repo.DeleteFederationLink(
		r.Context(),
		t.ID,
		chi.URLParam(r, "id"),
		master,
		ifMatch,
		middleware.AuditMetaFromRequest(r),
	)
	if err != nil {
		d.writeFederationErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.federated_link.deleted", map[string]any{
		"child_subscriber_id":  chi.URLParam(r, "id"),
		"master_subscriber_id": master,
	})
	w.Header().Set("ETag", version)
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted":            true,
		"subscriber_version": version,
	})
}

// requireExactFederationIfMatch rejects weak validators, wildcard existence
// checks, and multi-value lists. Identity-graph decisions always bind to one
// exact strong child-profile snapshot.
func requireExactFederationIfMatch(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if raw == "" || raw == "*" || strings.HasPrefix(raw, "W/") || strings.Contains(raw, ",") {
		httpcache.WritePreconditionRequired(w)
		return "", false
	}
	token, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard || strings.TrimSpace(token) == "" {
		httpcache.WritePreconditionRequired(w)
		return "", false
	}
	return token, true
}

// writeFederationErr maps a federation repo error to a safe HTTP response.
func (d *Deps) writeFederationErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
	case errors.Is(err, ErrParentNotAgency):
		httperror.WriteValidation(w, "parent_not_agency", err.Error())
	case errors.Is(err, ErrFederatedMasterNotFound):
		httperror.WriteValidation(w, "master_subscriber_not_found",
			"master_subscriber_id does not resolve in the verified agency parent")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "validation_failed",
			"parent_tenant_id and master_subscriber_id are required; match_type must be email, external_id, or manual")
	case errors.Is(err, ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	default:
		tenantID := ""
		if t, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = t.ID
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

// keep pgx imported for the shared pgx.ErrNoRows sentinel used via getInTx.
var _ = pgx.ErrNoRows
