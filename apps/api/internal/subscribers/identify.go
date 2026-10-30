// Identify-by-external-id (SUB-001).
//
// POST /api/v1/subscribers/identify is the cross-system identity entry
// point every modern ESP exposes (Klaviyo, Customer.io, Iterable, Braze,
// HubSpot). The caller provides a stable upstream identifier and
// optionally an email / phone / traits payload; the endpoint either
// creates a fresh profile, updates the existing row pointed to by the
// external_id, or — when an external_id claim collides with an
// email-only profile of the same email — merges them transactionally.
//
// One row per (tenant_id, external_id) is guaranteed by the partial
// UNIQUE index from migration 0243; one row per (tenant_id, email) is
// already guaranteed by the original (tenant_id, email) UNIQUE. The
// merge path is what reconciles these two indexes when the same
// subscriber arrives twice — once by email, once by external_id.

package subscribers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
)

// IdentifyInput is the request body for POST /api/v1/subscribers/identify.
// At minimum one supported identifier must be present — without one we have
// nothing to identify against. Traits land under
// custom_fields so they're discoverable by segmentation and the
// existing custom-field schema validator.
type IdentifyInput struct {
	// ProfileID, when supplied, is the SUB-017 top-of-hierarchy synthetic
	// identifier. An exact profile_id match wins outright before any other
	// key is consulted (profile_id > external_id > email > phone > anonymous).
	ProfileID  string `json:"profile_id"`
	ExternalID string `json:"external_id"`
	Email      string `json:"email"`
	Phone      string `json:"phone"`
	// AnonymousID, when supplied, ties this identify call to pre-identification
	// activity tracked under an anonymous_id (SUB-003). On creation it records
	// an anonymous profile; on identify it stitches the anonymous_id alias onto
	// the resolved profile and triggers a 72h retroactive replay.
	AnonymousID string         `json:"anonymous_id"`
	Traits      map[string]any `json:"traits"`
	// SubscriberVersions binds any collision-driven consolidation to every
	// resolved profile revision. It is keyed by subscriber UUID. Ordinary
	// create/update identifies may omit it; a merge may not.
	SubscriberVersions map[string]string `json:"subscriber_versions,omitempty"`
	AuditMeta          db.AuditMeta      `json:"-"`
}

// ErrInvalidProfileID is returned by normalizeIdentify when a supplied
// profile_id is not a well-formed UUID (SUB-017). The profile_id lookup binds
// it as ::uuid, so a malformed value would otherwise surface as a raw DB error
// / HTTP 500; this sentinel lets the handler return a clean 400 instead.
var ErrInvalidProfileID = errors.New("profile_id must be a valid UUID")

// IdentifyResult tells the caller what happened. Action is one of:
// "created" — fresh row, "updated" — existing row patched in place,
// "merged" — an email-only row and an external_id-claim collided and
// were consolidated. The merged row's id wins.
type IdentifyResult struct {
	Subscriber *Subscriber `json:"subscriber"`
	Action     string      `json:"action"`
}

// MountIdentifyRoutes registers the identify endpoint. Wrapped with
// observability.RecordSurfaceFunc so pw_subscribers_identify_total +
// pw_subscribers_duration_seconds are emitted (Phase 4
// p4d-recordsurface-wire-subscribers).
func MountIdentifyRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/identify",
			observability.RecordSurfaceFunc("subscribers", "identify", d.Identify))
}

// Identify POST /api/v1/subscribers/identify
func (d *Deps) Identify(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in IdentifyInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := normalizeIdentify(&in); err != nil {
		// SUB-017: a malformed profile_id is a 400 (bad request) — the value is
		// syntactically wrong, distinct from the 422 semantic-rule failures
		// below (e.g. "needs external_id or email"). Returning 400 keeps a
		// malformed UUID from reaching the ::uuid bind and surfacing as a 500.
		if errors.Is(err, ErrInvalidProfileID) {
			httperror.Write(w, http.StatusBadRequest, "invalid_profile_id", err.Error())
			return
		}
		// 422 (not 400): the body parsed fine but failed a semantic rule
		// (needs external_id or email) — matches the repo's
		// validation-error convention and this handler's contract test.
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	in.AuditMeta = middleware.AuditMetaFromRequest(r)
	in.AuditMeta.TenantID = t.ID
	out, err := d.Repo.Identify(r.Context(), t.ID, in)
	if err != nil {
		if writeCustomFieldsValidationError(w, err) {
			return
		}
		if errors.Is(err, ErrErasureBlocked) {
			writeJSON(w, http.StatusConflict, errEnv("erasure_blocked", erasureBlockedMessage))
			return
		}
		if errors.Is(err, ErrMergePreconditionRequired) {
			httpcache.WritePreconditionRequired(w)
			return
		}
		if errors.Is(err, ErrPreconditionFailed) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		if errors.Is(err, ErrMergeConflict) {
			httperror.Write(w, http.StatusConflict, "merge_conflict", "resolved profiles have conflicting protected relationships and require review")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.emit(t.ID, "subscriber."+out.Action, map[string]any{
		"id":          out.Subscriber.ID,
		"email":       out.Subscriber.Email,
		"external_id": out.Subscriber.ExternalID,
	})
	// SUB-003: post-commit retroactive trigger replay. Only fires when the
	// call carried an anonymous_id (there is pre-identification activity to
	// replay) and a replayer is wired. Best-effort: a replay failure is
	// logged but does not fail the identify response — the stitch + event
	// reparent already committed inside Repo.Identify.
	if in.AnonymousID != "" && d.TriggerReplayer != nil && out.Subscriber != nil {
		if _, rErr := d.TriggerReplayer.RetryIdentifiedEventsWithin(
			r.Context(), t.ID, out.Subscriber.Email, 0); rErr != nil && d.Logger != nil {
			d.Logger.Warn("trigger replay failed",
				"tenant_id", t.ID, "subscriber_id", out.Subscriber.ID, "err", rErr.Error())
		}
	}
	status := http.StatusOK
	if out.Action == "created" {
		status = http.StatusCreated
	}
	if out.Subscriber != nil && out.Subscriber.Version != "" {
		w.Header().Set("ETag", out.Subscriber.Version)
	}
	writeJSON(w, status, out)
}

func normalizeIdentify(in *IdentifyInput) error {
	in.ProfileID = strings.TrimSpace(in.ProfileID)
	in.ExternalID = strings.TrimSpace(in.ExternalID)
	in.AnonymousID = strings.TrimSpace(in.AnonymousID)
	// At least one resolvable identifier is required. profile_id and phone
	// join external_id/email as accepted entry points (SUB-017); an
	// anonymous_id alone is sufficient to register a pre-identification
	// profile (SUB-003).
	if in.ProfileID == "" && in.ExternalID == "" && in.AnonymousID == "" &&
		strings.TrimSpace(in.Email) == "" && strings.TrimSpace(in.Phone) == "" {
		return errors.New("at least one of profile_id, external_id, email, phone or anonymous_id is required")
	}
	// SUB-017: a supplied profile_id is bound as ::uuid in the lookup
	// (loadIdentifyRow). Reject a malformed value here with a typed sentinel
	// so the handler returns a clean 400 rather than letting Postgres raise an
	// invalid-uuid error → HTTP 500.
	if in.ProfileID != "" {
		parsed, err := uuid.Parse(in.ProfileID)
		if err != nil {
			return ErrInvalidProfileID
		}
		// UUID text is case-insensitive identity. Canonicalizing here makes a
		// profile-only placeholder deterministic across equivalent spellings and
		// ensures the exact caller-supplied identity is persisted on insert.
		in.ProfileID = parsed.String()
	}
	if len(in.ExternalID) > 256 {
		return errors.New("external_id exceeds 256-character limit")
	}
	if len(in.AnonymousID) > 512 {
		return errors.New("anonymous_id exceeds 512-character limit")
	}
	if strings.TrimSpace(in.Email) != "" {
		email, err := normalizeEmail(in.Email)
		if err != nil {
			return err
		}
		in.Email = email
	}
	// Phone normalization to E.164 happens at ingest (SUB-017). An invalid
	// phone is rejected so the phone lookup key is canonical.
	if strings.TrimSpace(in.Phone) != "" {
		phone, err := normalizeE164(in.Phone)
		if err != nil {
			return err
		}
		in.Phone = phone
	} else {
		in.Phone = ""
	}
	if in.Traits == nil {
		in.Traits = map[string]any{}
	}
	if in.Phone != "" {
		// Phone also lands as a trait so segmentation/SMS surfaces can read
		// it without a separate column on the subscribers schema.
		in.Traits["phone"] = in.Phone
	}
	return nil
}

// normalizeE164 canonicalises a phone number to E.164 (a leading '+' then
// 1..15 digits). It strips common separators (spaces, dashes, parens, dots)
// before validating. This is a deliberately conservative normaliser — it
// does not infer a country code, so a bare national number without a '+' is
// rejected rather than silently mis-prefixed.
func normalizeE164(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	var b strings.Builder
	for i, r := range raw {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '+' && i == 0:
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '(' || r == ')' || r == '.':
			// drop separators
		default:
			return "", errors.New("phone contains invalid characters; expected E.164")
		}
	}
	cleaned := b.String()
	if !strings.HasPrefix(cleaned, "+") {
		return "", errors.New("phone must be E.164 (include the leading + and country code)")
	}
	digits := cleaned[1:]
	if len(digits) < 1 || len(digits) > 15 {
		return "", errors.New("phone must be E.164 with 1..15 digits")
	}
	return cleaned, nil
}

// Identify upserts a subscriber row keyed first on external_id then on
// email. The transaction handles four shapes:
//
//  1. external_id matches an existing row → UPDATE in place. Email
//     change is permitted (upstream may have rotated the email);
//     custom_fields receive the trait diff.
//  2. external_id has no match AND email matches an existing row →
//     CLAIM the existing row by writing external_id onto it.
//  3. external_id matches row A AND email matches row B (A != B) →
//     MERGE. Row B's data is folded into A (tags unioned, custom_fields
//     merged with A winning, suppressions re-pointed) and B is deleted.
//     Emits subscriber.merged + an audit row.
//  4. Neither external_id nor email matches anything → INSERT a new
//     row carrying both.
//
// Concurrency: the whole thing runs inside a single tenant-scoped tx,
// so the partial-UNIQUE on (tenant_id, external_id) plus the original
// UNIQUE on (tenant_id, email) serialize the two ways a duplicate could
// race in. A losing-race second call sees a SQLSTATE 23505 from the
// UNIQUE and returns the error; the operator can retry.
func (r *Repo) Identify(ctx context.Context, tenantID string, in IdentifyInput) (*IdentifyResult, error) {
	if tenantID == "" {
		return nil, errors.New("identify: tenant required")
	}
	if in.ProfileID == "" && in.ExternalID == "" && in.Email == "" && in.Phone == "" && in.AnonymousID == "" {
		return nil, errors.New("identify: profile_id, external_id, email, phone or anonymous_id required")
	}
	// Reject a previously erased address before trait validation can auto-create
	// custom-field schema. The check is repeated inside the Identify transaction
	// below so a stale preflight can never make the local write fail open.
	if in.Email != "" {
		if err := r.PreflightUpsert(ctx, tenantID, in.Email, nil); err != nil {
			return nil, err
		}
	}
	if r.CustomFields != nil {
		traits, err := r.CustomFields.Validate(ctx, tenantID, nonNilMap(in.Traits))
		if err != nil {
			return nil, fmt.Errorf("validate identify traits: %w", err)
		}
		in.Traits = nonNilMap(traits)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Identify can rotate or merge the canonical email. Acquire the exclusive
	// identity fence before any subscriber lookup/row lock; frequency admission
	// holds the shared side through its authority check and commit.
	if in.Email != "" {
		if err := subscriberidentitylock.Tenant(ctx, tx, tenantID); err != nil {
			return nil, err
		}
	}

	// Erasure-suppression pre-check on email: a re-identified profile
	// whose email was previously DSR-deleted must NOT silently
	// resurrect. Mirrors the Upsert path's guard.
	if in.Email != "" {
		if err = rejectErasedAddress(ctx, tx, tenantID, in.Email); err != nil {
			return nil, err
		}
	}

	byProfile, byExternal, byEmail, byPhone, byAnonymous, err := resolveIdentifyCandidates(ctx, tx, tenantID, in)
	if err != nil {
		return nil, err
	}

	// Ranked candidates, most-authoritative first
	// (profile_id > external_id > email > phone > anonymous). pickPrimary keeps the
	// ranking in one place so the merge logic and tie-break rules stay in
	// lockstep and are unit-testable without a database.
	ranked := []*identifyRow{byProfile, byExternal, byEmail, byPhone, byAnonymous}
	primary := pickPrimary(ranked)
	if primary != nil {
		distinct := map[string]*identifyRow{}
		for _, candidate := range ranked {
			if candidate != nil {
				distinct[candidate.id] = candidate
			}
		}
		if len(distinct) > 1 {
			if len(in.SubscriberVersions) == 0 {
				return nil, ErrMergePreconditionRequired
			}
			for id, candidate := range distinct {
				expected := in.SubscriberVersions[id]
				if missingMergeVersion(expected) {
					return nil, ErrMergePreconditionRequired
				}
				if expected != candidate.version {
					return nil, ErrPreconditionFailed
				}
			}
		}
	}

	switch {
	case primary != nil:
		action := "updated"
		// Fold every distinct lower-ranking match into the primary. A
		// lower-ranking row that points at a different id is a duplicate
		// the precedence rule says to consolidate — the primary (higher
		// identifier) wins. We merge one duplicate at a time so each fold
		// reuses the proven two-way doIdentifyMerge invariants.
		for _, c := range ranked {
			if c == nil || c.id == primary.id {
				continue
			}
			sub, err := r.doIdentifyMerge(ctx, tx, tenantID, primary, c, in)
			if err != nil {
				return nil, err
			}
			// After a merge the primary's projected row is `sub`; refresh
			// the lightweight identifyRow so a subsequent fold compares
			// against the surviving id.
			primary = &identifyRow{
				id:           sub.ID,
				email:        sub.Email,
				externalID:   derefOrEmpty(sub.ExternalID),
				customFields: copyAnyMap(sub.CustomFields),
				mergeFields:  copyAnyMap(sub.MergeFields),
				tags:         append([]string(nil), sub.Tags...),
				profileID:    sub.ProfileID,
				version:      sub.Version,
			}
			action = "merged"
		}
		if action == "merged" {
			if err := r.stitchAnonymous(ctx, tx, tenantID, primary.id, primary.email, in); err != nil {
				return nil, err
			}
			row := tx.QueryRow(ctx, subscriberSelectSQL+`WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, primary.id)
			sub, err := scanSubscriber(row)
			if err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			// SUB-071: shadow-PII scan over the merged profile's traits
			// (best-effort, post-commit). Identify traits live in custom_fields;
			// audience merge fields remain an explicitly managed namespace.
			r.scanPII(ctx, tenantID, sub)
			r.attributeAnonymousAfterIdentify(ctx, tenantID, in, sub)
			return &IdentifyResult{Subscriber: sub, Action: action}, nil
		}
		// No collision — just patch the surviving primary in place.
		sub, err := r.doIdentifyUpdate(ctx, tx, tenantID, primary, in)
		if err != nil {
			return nil, err
		}
		if err := r.stitchAnonymous(ctx, tx, tenantID, sub.ID, sub.Email, in); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		// SUB-071: shadow-PII scan over the patched profile's traits.
		r.scanPII(ctx, tenantID, sub)
		r.attributeAnonymousAfterIdentify(ctx, tenantID, in, sub)
		return &IdentifyResult{Subscriber: sub, Action: action}, nil

	default:
		// Net-new row.
		sub, err := r.doIdentifyInsert(ctx, tx, tenantID, in)
		if err != nil {
			return nil, err
		}
		if err := r.stitchAnonymous(ctx, tx, tenantID, sub.ID, sub.Email, in); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		// SUB-071: shadow-PII scan over the new profile's traits.
		r.scanPII(ctx, tenantID, sub)
		r.attributeAnonymousAfterIdentify(ctx, tenantID, in, sub)
		return &IdentifyResult{Subscriber: sub, Action: "created"}, nil
	}
}

// SUB-017: resolve candidate rows in strict precedence order
// (profile_id > external_id > email > phone > anonymous). Each key is
// looked up independently; the highest-ranking match becomes the
// surviving primary, and any distinct lower-ranking match is a duplicate
// to be merged into it (the highest-ranking identifier always wins).
func resolveIdentifyCandidates(ctx context.Context, tx pgx.Tx, tenantID string, in IdentifyInput) (byProfile, byExternal, byEmail, byPhone, byAnonymous *identifyRow, err error) {
	if in.ProfileID != "" {
		if byProfile, err = loadIdentifyRow(ctx, tx, tenantID, "profile_id", in.ProfileID); err != nil {
			return nil, nil, nil, nil, nil, err
		}
	}
	if in.ExternalID != "" {
		if byExternal, err = loadIdentifyRow(ctx, tx, tenantID, "external_id", in.ExternalID); err != nil {
			return nil, nil, nil, nil, nil, err
		}
		// G-20: fall back to the alias index when no subscriber carries this
		// external_id on its row (it may live only as a profile_alias).
		if byExternal == nil {
			if byExternal, err = loadIdentifyRowByAlias(ctx, tx, tenantID, "external_id", in.ExternalID); err != nil {
				return nil, nil, nil, nil, nil, err
			}
		}
	}
	if in.Email != "" {
		if byEmail, err = loadIdentifyRow(ctx, tx, tenantID, "email", in.Email); err != nil {
			return nil, nil, nil, nil, nil, err
		}
		// A completed merge keeps every former canonical address as an
		// explicit email alias. The subscriber row can expose only one
		// canonical email, so this fallback prevents a later identify call on
		// either source address from forking a replacement profile.
		if byEmail == nil {
			if byEmail, err = loadIdentifyRowByAlias(ctx, tx, tenantID, "email", in.Email); err != nil {
				return nil, nil, nil, nil, nil, err
			}
		}
	}
	if in.Phone != "" {
		if byPhone, err = loadIdentifyRow(ctx, tx, tenantID, "phone", in.Phone); err != nil {
			return nil, nil, nil, nil, nil, err
		}
		if byPhone == nil {
			if byPhone, err = loadIdentifyRowByAlias(ctx, tx, tenantID, "phone", in.Phone); err != nil {
				return nil, nil, nil, nil, nil, err
			}
		}
	}
	if in.AnonymousID != "" {
		if byAnonymous, err = loadIdentifyRowByAnonymous(ctx, tx, tenantID, in.AnonymousID); err != nil {
			return nil, nil, nil, nil, nil, err
		}
		if byAnonymous == nil {
			// Compatibility fallback for rows created before the anonymous-profile
			// registry existed. The hash-derived placeholder is exact and therefore
			// preserves case-sensitive anonymous identifiers.
			if byAnonymous, err = loadIdentifyRow(ctx, tx, tenantID, "email", anonymousPlaceholderEmail(in.AnonymousID)); err != nil {
				return nil, nil, nil, nil, nil, err
			}
		}
		if byAnonymous == nil {
			if byAnonymous, err = loadIdentifyRowByAlias(ctx, tx, tenantID, "anonymous_id", in.AnonymousID); err != nil {
				return nil, nil, nil, nil, nil, err
			}
		}
	}
	return byProfile, byExternal, byEmail, byPhone, byAnonymous, nil
}

// identifyRow is the minimal columns needed to decide which path to
// take. Full subscriber projection happens after the path is chosen.
type identifyRow struct {
	id           string
	email        string
	externalID   string
	customFields map[string]any
	mergeFields  map[string]any
	tags         []string
	profileID    string
	// profileIDHistorical is true when a supplied profile_id resolved through
	// merge lineage instead of matching the survivor's current stable ID. Such
	// an alias is authoritative for lookup but must never replace the
	// survivor's own profile_id on update.
	profileIDHistorical bool
	version             string
	updatedAt           time.Time
}

// pickPrimary returns the highest-ranking non-nil candidate from a slice
// ordered most-authoritative-first. This encodes the SUB-017 identifier
// precedence hierarchy (profile_id > external_id > email > phone > anonymous): the
// caller passes candidates already sorted by rank and pickPrimary selects
// the surviving primary onto which lower-ranking matches are merged. Returns
// nil when no candidate matched (the net-new-row case).
func pickPrimary(ranked []*identifyRow) *identifyRow {
	for _, c := range ranked {
		if c != nil {
			return c
		}
	}
	return nil
}

// loadIdentifyRow runs a parameterised lookup on one of the supported
// identifier columns — `column` is hard-coded to a fixed predicate per the
// allow-list switch so the value can never widen into SQL-injection
// territory. profile_id and phone join external_id/email as lookup keys
// (SUB-017); phone is stored as a custom_fields trait so its predicate
// reads custom_fields->>'phone'.
// loadIdentifyRowByAlias resolves an identifier through the profile_aliases
// index (tenant_id, alias_type, lower(alias_value)) to a subscriber, then loads
// that subscriber. This makes profile_aliases a real resolution index (G-20): an
// inbound external_id / phone / anonymous_id / device_token that exists only as
// an alias — not on the subscribers row — still resolves to the existing
// subscriber instead of forking a duplicate. Highest-confidence, most-recent
// alias wins.
func loadIdentifyRowByAlias(ctx context.Context, tx pgx.Tx, tenantID, aliasType, value string) (*identifyRow, error) {
	if value == "" {
		return nil, nil
	}
	var subID string
	err := tx.QueryRow(ctx, `
SELECT subscriber_id::text
  FROM profile_aliases
 WHERE tenant_id = $1::uuid AND alias_type = $2 AND alias_value = $3
 ORDER BY confidence DESC, created_at DESC
 LIMIT 1`, tenantID, aliasType, value).Scan(&subID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("identify: alias lookup (%s): %w", aliasType, err)
	}
	return loadIdentifyRow(ctx, tx, tenantID, "id", subID)
}

// loadIdentifyRowByAnonymous resolves the case-sensitive anonymous registry
// before consulting the historical case-folded alias index. The registry's
// (tenant_id, anonymous_id) primary key is the authoritative identity and
// allows identifiers such as "VisitorABC" and "visitorabc" to coexist.
func loadIdentifyRowByAnonymous(ctx context.Context, tx pgx.Tx, tenantID, anonymousID string) (*identifyRow, error) {
	var subscriberID *string
	err := tx.QueryRow(ctx, `
SELECT subscriber_id::text
  FROM subscriber_anonymous_profiles
 WHERE tenant_id = $1::uuid AND anonymous_id = $2`, tenantID, anonymousID).Scan(&subscriberID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		if isUndefinedTable(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("identify: anonymous registry lookup: %w", err)
	}
	if subscriberID == nil {
		return nil, nil
	}
	return loadIdentifyRow(ctx, tx, tenantID, "id", *subscriberID)
}

func loadIdentifyRow(ctx context.Context, tx pgx.Tx, tenantID, column, value string) (*identifyRow, error) {
	var predicate string
	switch column {
	case "external_id":
		predicate = "external_id = $2"
	case "email":
		predicate = "lower(email::text) = lower($2)"
	case "profile_id":
		// Migration 1769 records the duplicate's stable profile identifier
		// before replacing the merged tombstone's PII. Follow both direct and
		// historical identifiers through any later merge chain to the live
		// survivor.
		predicate = `id = (
WITH RECURSIVE resolved(id, depth) AS (
    SELECT COALESCE(
        (SELECT s.id FROM subscribers s
          WHERE s.tenant_id=$1::uuid AND s.profile_id=$2::uuid
          ORDER BY (s.merged_into_subscriber_id IS NULL) DESC, s.updated_at DESC
          LIMIT 1),
        (SELECT l.primary_subscriber_id FROM subscriber_merge_lineage l
          WHERE l.tenant_id=$1::uuid AND l.duplicate_profile_id=$2::uuid
          LIMIT 1)
    ), 0
    UNION ALL
    SELECT s.merged_into_subscriber_id, r.depth + 1
      FROM resolved r
      JOIN subscribers s ON s.tenant_id=$1::uuid AND s.id=r.id
     WHERE s.merged_into_subscriber_id IS NOT NULL AND r.depth < 32
)
SELECT id FROM resolved WHERE id IS NOT NULL ORDER BY depth DESC LIMIT 1
)`
	case "phone":
		predicate = "custom_fields ->> 'phone' = $2"
	case "id":
		predicate = `id = (
WITH RECURSIVE resolved(id, depth) AS (
    SELECT $2::uuid, 0
    UNION ALL
    SELECT s.merged_into_subscriber_id, r.depth + 1
      FROM resolved r
      JOIN subscribers s ON s.tenant_id=$1::uuid AND s.id=r.id
     WHERE s.merged_into_subscriber_id IS NOT NULL AND r.depth < 32
)
SELECT id FROM resolved ORDER BY depth DESC LIMIT 1
)`
	default:
		return nil, fmt.Errorf("identify: invalid lookup column %q", column)
	}
	var (
		out              identifyRow
		cfBytes, mfBytes []byte
	)
	err := tx.QueryRow(ctx, `
SELECT id::text, email::text, COALESCE(external_id, ''),
       COALESCE(custom_fields, '{}'::jsonb),
	   COALESCE(merge_fields, '{}'::jsonb),
	   COALESCE(tags, ARRAY[]::text[]), profile_id::text, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND `+predicate+`
 ORDER BY updated_at DESC
 LIMIT 1`,
		tenantID, value).Scan(&out.id, &out.email, &out.externalID, &cfBytes, &mfBytes, &out.tags, &out.profileID, &out.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out.customFields = map[string]any{}
	if len(cfBytes) > 0 {
		_ = json.Unmarshal(cfBytes, &out.customFields)
	}
	out.mergeFields = map[string]any{}
	if len(mfBytes) > 0 {
		_ = json.Unmarshal(mfBytes, &out.mergeFields)
	}
	out.version = httpcache.ConcurrencyToken("subscriber", out.id, out.updatedAt)
	out.profileIDHistorical = column == "profile_id" && out.profileID != value
	return &out, nil
}

func (r *Repo) doIdentifyInsert(ctx context.Context, tx pgx.Tx, tenantID string, in IdentifyInput) (*Subscriber, error) {
	custom := nonNilMap(in.Traits)
	customRaw, _ := json.Marshal(custom)
	// Identify traits are arbitrary profile traits, not declared audience merge
	// fields. A new identify-created subscriber therefore starts with an empty
	// merge-field object unless a dedicated merge-field write path updates it.
	mergeRaw := []byte("{}")
	groupsRaw := []byte("[]")
	gdprRaw := []byte("[]")
	summaryRaw := []byte("{}")
	row := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, consent_timestamp, consent_source,
    custom_fields, tags, source_platform, mailchimp_status,
    merge_fields, groups, gdpr_permissions, activity_summary, external_id,
    profile_id
)
VALUES (
    -- SUB-016: primary_email defaults to the canonical email on insert (see
    -- migration 0452 backfill) so an identify-created row carries it too.
    $1::uuid, $2, $2, 'unconfirmed', NULL, 'unknown',
    $3::jsonb, ARRAY[]::text[], 'identify', 'non_subscribed',
    $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, NULLIF($8, ''),
    COALESCE(NULLIF($9, '')::uuid, gen_random_uuid())
)
RETURNING `+subscriberColumns,
		tenantID, identifyEmail(in), string(customRaw), string(mergeRaw),
		string(groupsRaw), string(gdprRaw), string(summaryRaw), in.ExternalID,
		in.ProfileID)
	sub, err := scanSubscriber(row)
	if err != nil {
		return nil, err
	}
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID: tenantID, EventType: EventSubscriberCreated, Body: sub,
			IdempotencyKey: "subscriber-created:" + sub.ID,
		}); err != nil {
			return nil, fmt.Errorf("dispatch webhook: %w", err)
		}
	}
	return sub, nil
}

// doIdentifyUpdate writes the new external_id + trait deltas onto an
// existing row WITHOUT touching status / consent / tags — identify is
// a profile-data call, not a consent or lifecycle transition.
func (r *Repo) doIdentifyUpdate(ctx context.Context, tx pgx.Tx, tenantID string, target *identifyRow, in IdentifyInput) (*Subscriber, error) {
	mergedFields := mergeMaps(target.customFields, nonNilMap(in.Traits))
	customRaw, _ := json.Marshal(mergedFields)

	newEmail := target.email
	if in.Email != "" {
		newEmail = in.Email
	}
	// COALESCE-style: keep prior external_id if the incoming one is empty.
	newExternalID := target.externalID
	if in.ExternalID != "" {
		newExternalID = in.ExternalID
	}
	newProfileID := in.ProfileID
	if target.profileIDHistorical {
		newProfileID = ""
	}

	row := tx.QueryRow(ctx, `
UPDATE subscribers
   SET email = $3,
       primary_email = CASE
           WHEN primary_email IS NULL OR lower(primary_email::text) = lower(email::text) THEN $3
           ELSE primary_email
       END,
       external_id = NULLIF($4, ''),
       custom_fields = $5::jsonb,
       profile_id = COALESCE(NULLIF($6, '')::uuid, profile_id),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+subscriberColumns,
		tenantID, target.id, newEmail, newExternalID, string(customRaw), newProfileID)
	sub, err := scanSubscriber(row)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(target.email, newEmail) {
		if err := repointSubscriberEmail(ctx, tx, tenantID, target.email, newEmail); err != nil {
			return nil, err
		}
	}
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID: tenantID, EventType: EventSubscriberUpdated, Body: sub,
		}); err != nil {
			return nil, fmt.Errorf("dispatch webhook: %w", err)
		}
	}
	return sub, nil
}

// doIdentifyMerge runs collision consolidation inside the open transaction by
// delegating to the same canonical primitive as the reviewed public merge.
// This keeps locking, dual revisions, restrictive consent/status precedence,
// immutable lineage, durable engine reconciliation, audit, and webhook
// semantics identical on both entry points.
func (r *Repo) doIdentifyMerge(ctx context.Context, tx pgx.Tx, tenantID string, primary, duplicate *identifyRow, in IdentifyInput) (*Subscriber, error) {
	newEmail := primary.email
	if in.Email != "" {
		newEmail = in.Email
	}
	identifyConfidence := 1.0
	profileID := in.ProfileID
	if primary.profileIDHistorical {
		profileID = ""
	}
	out, err := r.mergeCanonicalInTx(ctx, tx, tenantID, primary.id, duplicate.id, canonicalMergeOptions{
		PrimaryVersion: primary.version, DuplicateVersion: duplicate.version,
		CanonicalEmail: newEmail, ExternalID: in.ExternalID, ProfileID: profileID,
		Traits: in.Traits, AuditMeta: in.AuditMeta, AuditReason: "identify_identity_collision",
		Signals: []MergeSignal{{
			Kind:       "external_id_claim",
			Confidence: &identifyConfidence,
			Metadata: map[string]any{
				"source": "identify",
			},
		}},
	})
	if err != nil {
		return nil, err
	}
	return out.Subscriber, nil
}

// identifyEmail returns the real address or a bounded, hash-derived RFC 6761
// .invalid placeholder. Hashing keeps arbitrary identifiers out of an email
// address, stays below the RFC local-part limit, and preserves exact
// case-sensitive identity without leaking the source identifier.
func identifyEmail(in IdentifyInput) string {
	switch {
	case in.Email != "":
		return in.Email
	case in.ProfileID != "":
		return identifyPlaceholderEmail("profile", in.ProfileID)
	case in.ExternalID != "":
		return identifyPlaceholderEmail("external", in.ExternalID)
	case in.Phone != "":
		return identifyPlaceholderEmail("phone", in.Phone)
	case in.AnonymousID != "":
		return anonymousPlaceholderEmail(in.AnonymousID)
	default:
		return ""
	}
}

// anonymousPlaceholderEmail is the synthetic address under which a still-
// anonymous profile's pre-identification activity is keyed in
// subscriber_events (which requires a non-empty email). On identify the
// stitch path reparents these events onto the real address.
func anonymousPlaceholderEmail(anonymousID string) string {
	return identifyPlaceholderEmail("anonymous", anonymousID)
}

// legacyAnonymousPlaceholderEmail is read-only compatibility for anonymous
// events written before placeholders became bounded hashes. New subscriber and
// event identities must use anonymousPlaceholderEmail.
func legacyAnonymousPlaceholderEmail(anonymousID string) string {
	return "anon+" + strings.ToLower(anonymousID) + "@no-email.invalid"
}

func identifyPlaceholderEmail(kind, identifier string) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + identifier))
	// 24 bytes / 192 bits is collision-resistant while its 48 hex characters
	// leave every namespaced local-part comfortably below RFC 5321's 64-byte
	// ceiling (the longest prefix here is "anonymous-").
	return fmt.Sprintf("%s-%x@no-email.invalid", kind, sum[:24])
}

// attributeAnonymousAfterIdentify copies pre-identification product events onto
// the now-known subscriber.
//
// `AttributeAnonymousEvents` was written for exactly this and called from
// nowhere — its own header said it was "intentionally NOT called from
// stitchAnonymous or Identify yet". So a visitor browsed anonymously, then
// identified, and everything they did before that moment stayed unattributed:
// the timeline opened at the identify, and any segment or flow keyed on those
// events never saw them.
//
// Post-commit, beside scanPII, because it opens its own transaction — running
// it inside the identify tx would nest, and holding that tx open across a bulk
// copy would widen a hot write path for work that can be redone.
//
// Best-effort by the same reasoning scanPII uses: the identify has already
// succeeded and is what the caller is waiting on. A failure here loses
// attribution, not identity, so it is logged rather than returned.
func (r *Repo) attributeAnonymousAfterIdentify(ctx context.Context, tenantID string, in IdentifyInput, sub *Subscriber) {
	if sub == nil || strings.TrimSpace(in.AnonymousID) == "" {
		return
	}
	// Error swallowed, matching scanPII directly above: the Repo carries no
	// logger, and the identify has already committed. Attribution is
	// re-derivable — the anonymous events are still on their alias — so losing
	// a copy is recoverable in a way losing the identity would not be.
	_, _ = r.AttributeAnonymousEvents(ctx, tenantID, in.AnonymousID, sub.ID)
}
