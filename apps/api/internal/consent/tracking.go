// SPDX-License-Identifier: AGPL-3.0-only
//
// Recipient-level email tracking consent.
//
// The database projection is intentionally small, but the write boundary is
// compliance-critical: projection, canonical consent event, audit evidence,
// and webhook-fanout intent must commit together. Send-time reads degrade by
// suppressing tracking (not delivery) whenever the decision is uncertain.

package consent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

const (
	trackingJSONMaxBodyBytes  int64 = 2 << 10 // 2 KiB
	trackingEmailMaxBytes           = 320
	trackingSourceMaxBytes          = 64
	trackingPolicyMaxBytes          = 100
	trackingUserAgentMaxBytes       = 1024
	trackingBatchMaxEmails          = 1000

	trackingWebhookFanoutKind = "webhook.fanout"
	trackingWebhookEventType  = "subscriber.consent_changed"
)

var (
	errTrackingSubscriberNotFound = errors.New("consent: tracking subscriber not found")
	errTrackingDecisionUnknown    = errors.New("consent: tracking decision unavailable")
	trackingSourceRE              = regexp.MustCompile(`^[a-z0-9][a-z0-9._:/-]{0,63}$`)
)

// TrackingOutboxAppender is the narrow transactional-outbox dependency used
// by the tracking PATCH. *outbox.Repo satisfies it directly.
type TrackingOutboxAppender interface {
	Append(context.Context, pgx.Tx, outbox.Append) (string, error)
}

// TrackingPrefs is the unambiguous API representation. The timestamp fields
// retain the explicit preference evidence; Effective* also accounts for GPC,
// which suppresses both tracking dimensions even when those timestamps are nil.
type TrackingPrefs struct {
	// Version is a write precondition, carried in the body because sensitive
	// consent responses intentionally strip cache validators at commit time.
	Version              string     `json:"version,omitempty"`
	SubscriberID         string     `json:"subscriber_id"`
	SubscriberEmail      string     `json:"subscriber_email"`
	OpenOptOutAt         *time.Time `json:"open_opt_out_at,omitempty"`
	ClickOptOutAt        *time.Time `json:"click_opt_out_at,omitempty"`
	EffectiveOpenOptOut  bool       `json:"effective_open_opt_out"`
	EffectiveClickOptOut bool       `json:"effective_click_opt_out"`
	Source               string     `json:"source"`
	GPC                  bool       `json:"gpc"`
	PolicyVersion        string     `json:"policy_version"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

// TrackingPatchInput is a partial update. Source and PolicyVersion are
// pointers so an omitted value can inherit existing evidence while an explicit
// empty value is rejected instead of silently rewritten to a default.
type TrackingPatchInput struct {
	OpenOptOut    *bool   `json:"open_opt_out,omitempty"`
	ClickOptOut   *bool   `json:"click_opt_out,omitempty"`
	Source        *string `json:"source,omitempty"`
	PolicyVersion *string `json:"policy_version,omitempty"`
	GPC           *bool   `json:"gpc,omitempty"`
}

// TrackingPrefsBatchEntry is an alias to an anonymous structural type. The
// sending package declares the same alias, allowing its optional batch
// interface to be satisfied without either package importing the other.
type TrackingPrefsBatchEntry = struct {
	SkipOpen  bool
	SkipClick bool
}

// SendTrackingFilter resolves send-time tracking eligibility. Errors mean the
// decision is unknown, and therefore return both skip flags true as a defensive
// contract even before the caller examines err.
type SendTrackingFilter struct {
	Pool *db.Pool
}

func (f *SendTrackingFilter) Lookup(ctx context.Context, tenantID, email string) (bool, bool, error) {
	if f == nil || f.Pool == nil {
		return true, true, fmt.Errorf("%w: filter is not configured", errTrackingDecisionUnknown)
	}
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return true, true, fmt.Errorf("%w: invalid tenant", errTrackingDecisionUnknown)
	}
	normalizedEmail, err := normalizeTrackingEmail(email)
	if err != nil {
		return true, true, fmt.Errorf("%w: %v", errTrackingDecisionUnknown, err)
	}
	tx, err := db.WithTenant(ctx, f.Pool, tenantID)
	if err != nil {
		return true, true, fmt.Errorf("%w: begin tenant read: %v", errTrackingDecisionUnknown, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	prefs, err := LoadTrackingPrefs(ctx, tx, normalizedEmail)
	if err != nil {
		return true, true, fmt.Errorf("%w: read preference: %v", errTrackingDecisionUnknown, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return true, true, fmt.Errorf("%w: commit read: %v", errTrackingDecisionUnknown, err)
	}
	return IsOpenTrackingOptedOut(prefs), IsClickTrackingOptedOut(prefs), nil
}

// LookupBatch resolves a send batch in one tenant transaction. A successful
// query initializes every requested address, so a missing map key is never
// ambiguous. Any validation/DB/commit failure returns fail-closed entries and
// an error; the send loop preserves delivery but suppresses both tracking modes.
func (f *SendTrackingFilter) LookupBatch(ctx context.Context, tenantID string, emails []string) (map[string]TrackingPrefsBatchEntry, error) {
	if len(emails) > trackingBatchMaxEmails {
		return map[string]TrackingPrefsBatchEntry{}, fmt.Errorf("%w: batch exceeds %d recipients", errTrackingDecisionUnknown, trackingBatchMaxEmails)
	}
	failClosed := failClosedRawTrackingBatch(emails)
	normalized, normalizeErr := normalizeTrackingBatch(emails)
	if f == nil || f.Pool == nil {
		return failClosed, fmt.Errorf("%w: filter is not configured", errTrackingDecisionUnknown)
	}
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return failClosed, fmt.Errorf("%w: invalid tenant", errTrackingDecisionUnknown)
	}
	if normalizeErr != nil {
		return failClosed, fmt.Errorf("%w: %v", errTrackingDecisionUnknown, normalizeErr)
	}
	if len(normalized) == 0 {
		return map[string]TrackingPrefsBatchEntry{}, nil
	}

	result := make(map[string]TrackingPrefsBatchEntry, len(normalized))
	for _, email := range normalized {
		result[email] = TrackingPrefsBatchEntry{}
	}
	tx, err := db.WithTenant(ctx, f.Pool, tenantID)
	if err != nil {
		return failClosed, fmt.Errorf("%w: begin tenant batch read: %v", errTrackingDecisionUnknown, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subscriber_email::text, open_opt_out_at, click_opt_out_at, gpc
  FROM subscriber_tracking_prefs
 WHERE subscriber_email = ANY($1::citext[])`, normalized)
	if err != nil {
		return failClosed, fmt.Errorf("%w: query batch: %v", errTrackingDecisionUnknown, err)
	}
	defer rows.Close()
	for rows.Next() {
		var email string
		var openAt, clickAt *time.Time
		var gpc bool
		if err := rows.Scan(&email, &openAt, &clickAt, &gpc); err != nil {
			return failClosed, fmt.Errorf("%w: scan batch: %v", errTrackingDecisionUnknown, err)
		}
		key := strings.ToLower(strings.TrimSpace(email))
		result[key] = TrackingPrefsBatchEntry{
			SkipOpen:  openAt != nil || gpc,
			SkipClick: clickAt != nil || gpc,
		}
	}
	if err := rows.Err(); err != nil {
		return failClosed, fmt.Errorf("%w: iterate batch: %v", errTrackingDecisionUnknown, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return failClosed, fmt.Errorf("%w: commit batch read: %v", errTrackingDecisionUnknown, err)
	}
	return result, nil
}

func normalizeTrackingBatch(emails []string) ([]string, error) {
	if len(emails) > trackingBatchMaxEmails {
		return nil, fmt.Errorf("batch exceeds %d recipients", trackingBatchMaxEmails)
	}
	seen := make(map[string]struct{}, len(emails))
	out := make([]string, 0, len(emails))
	for _, raw := range emails {
		email, err := normalizeTrackingEmail(raw)
		if err != nil {
			return out, err
		}
		if _, ok := seen[email]; ok {
			continue
		}
		seen[email] = struct{}{}
		out = append(out, email)
	}
	return out, nil
}

func failClosedTrackingBatch(emails []string) map[string]TrackingPrefsBatchEntry {
	out := make(map[string]TrackingPrefsBatchEntry, len(emails))
	for _, email := range emails {
		out[email] = TrackingPrefsBatchEntry{SkipOpen: true, SkipClick: true}
	}
	return out
}

func failClosedRawTrackingBatch(emails []string) map[string]TrackingPrefsBatchEntry {
	out := make(map[string]TrackingPrefsBatchEntry, len(emails))
	for _, raw := range emails {
		key := strings.ToLower(strings.TrimSpace(raw))
		if key != "" {
			out[key] = TrackingPrefsBatchEntry{SkipOpen: true, SkipClick: true}
		}
	}
	return out
}

// LoadTrackingPrefs reads a projection inside the caller's tenant-scoped tx.
// A missing row is a known default (nil, nil), not an error.
func LoadTrackingPrefs(ctx context.Context, tx pgx.Tx, email string) (*TrackingPrefs, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return nil, nil
	}
	return loadTrackingPrefs(ctx, tx, email, false)
}

func loadTrackingPrefs(ctx context.Context, tx pgx.Tx, email string, forUpdate bool) (*TrackingPrefs, error) {
	query := `
SELECT subscriber_email::text, open_opt_out_at, click_opt_out_at,
       source, gpc, policy_version, updated_at
  FROM subscriber_tracking_prefs
 WHERE subscriber_email = $1::citext`
	if forUpdate {
		query += " FOR UPDATE"
	}
	var prefs TrackingPrefs
	err := tx.QueryRow(ctx, query, email).Scan(
		&prefs.SubscriberEmail,
		&prefs.OpenOptOutAt,
		&prefs.ClickOptOutAt,
		&prefs.Source,
		&prefs.GPC,
		&prefs.PolicyVersion,
		&prefs.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	finalizeTrackingPrefs(&prefs)
	return &prefs, nil
}

func finalizeTrackingPrefs(prefs *TrackingPrefs) {
	if prefs == nil {
		return
	}
	prefs.EffectiveOpenOptOut = prefs.OpenOptOutAt != nil || prefs.GPC
	prefs.EffectiveClickOptOut = prefs.ClickOptOutAt != nil || prefs.GPC
}

func IsOpenTrackingOptedOut(prefs *TrackingPrefs) bool {
	return prefs != nil && (prefs.OpenOptOutAt != nil || prefs.GPC)
}

func IsClickTrackingOptedOut(prefs *TrackingPrefs) bool {
	return prefs != nil && (prefs.ClickOptOutAt != nil || prefs.GPC)
}

type trackingSubscriber struct {
	ID        string
	Email     string
	UpdatedAt time.Time
}

type trackingIdentityKind uint8

const (
	trackingIdentityStableID trackingIdentityKind = iota + 1
	trackingIdentityLegacyEmail
)

func resolveTrackingSubscriber(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	kind trackingIdentityKind,
	identity string,
	forUpdate bool,
) (trackingSubscriber, error) {
	var query string
	switch kind {
	case trackingIdentityStableID:
		query = `
SELECT id::text, email::text, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`
	case trackingIdentityLegacyEmail:
		query = `
SELECT id::text, email::text, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2::citext`
	default:
		return trackingSubscriber{}, errors.New("consent: unsupported tracking identity")
	}
	if forUpdate {
		// Locking the stable subscriber row serializes first-write inserts (when
		// no preference row exists yet) and email rotation against this PATCH.
		query += " FOR UPDATE"
	}
	var sub trackingSubscriber
	if err := tx.QueryRow(ctx, query, tenantID, identity).Scan(&sub.ID, &sub.Email, &sub.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return trackingSubscriber{}, errTrackingSubscriberNotFound
		}
		return trackingSubscriber{}, err
	}
	sub.Email = strings.ToLower(strings.TrimSpace(sub.Email))
	return sub, nil
}

type trackingSnapshot struct {
	OpenOptOut    bool   `json:"open_opt_out"`
	ClickOptOut   bool   `json:"click_opt_out"`
	GPC           bool   `json:"gpc"`
	Source        string `json:"source"`
	PolicyVersion string `json:"policy_version"`
}

func snapshotTrackingPrefs(prefs *TrackingPrefs) trackingSnapshot {
	if prefs == nil {
		return trackingSnapshot{Source: "default", PolicyVersion: "v1"}
	}
	return trackingSnapshot{
		OpenOptOut:    prefs.OpenOptOutAt != nil,
		ClickOptOut:   prefs.ClickOptOutAt != nil,
		GPC:           prefs.GPC,
		Source:        prefs.Source,
		PolicyVersion: prefs.PolicyVersion,
	}
}

func targetTrackingPrefs(before trackingSnapshot, existing *TrackingPrefs, in TrackingPatchInput) trackingSnapshot {
	after := before
	if existing == nil {
		after.Source = "admin"
		after.PolicyVersion = "v1"
	}
	if in.OpenOptOut != nil {
		after.OpenOptOut = *in.OpenOptOut
	}
	if in.ClickOptOut != nil {
		after.ClickOptOut = *in.ClickOptOut
	}
	if in.GPC != nil {
		after.GPC = *in.GPC
	}
	if in.Source != nil {
		after.Source = *in.Source
	}
	if in.PolicyVersion != nil {
		after.PolicyVersion = *in.PolicyVersion
	}
	return after
}

func trackingSnapshotsEqual(left, right trackingSnapshot) bool {
	return left.OpenOptOut == right.OpenOptOut &&
		left.ClickOptOut == right.ClickOptOut &&
		left.GPC == right.GPC &&
		left.Source == right.Source &&
		left.PolicyVersion == right.PolicyVersion
}

func upsertTrackingPrefs(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	sub trackingSubscriber,
	existing *TrackingPrefs,
	in TrackingPatchInput,
	after trackingSnapshot,
) (*TrackingPrefs, error) {
	openAt, clickAt := (*time.Time)(nil), (*time.Time)(nil)
	if existing != nil {
		openAt, clickAt = existing.OpenOptOutAt, existing.ClickOptOutAt
	}
	mutationAt := time.Now().UTC().Truncate(time.Microsecond)
	versionFloor := sub.UpdatedAt
	if existing != nil && existing.UpdatedAt.After(versionFloor) {
		versionFloor = existing.UpdatedAt
	}
	if !mutationAt.After(versionFloor) {
		mutationAt = versionFloor.Add(time.Microsecond)
	}
	if in.OpenOptOut != nil && (existing == nil || (*in.OpenOptOut != (existing.OpenOptOutAt != nil))) {
		if *in.OpenOptOut {
			openAt = &mutationAt
		} else {
			openAt = nil
		}
	}
	if in.ClickOptOut != nil && (existing == nil || (*in.ClickOptOut != (existing.ClickOptOutAt != nil))) {
		if *in.ClickOptOut {
			clickAt = &mutationAt
		} else {
			clickAt = nil
		}
	}

	var prefs TrackingPrefs
	err := tx.QueryRow(ctx, `
INSERT INTO subscriber_tracking_prefs
  (tenant_id, subscriber_email, open_opt_out_at, click_opt_out_at,
   source, gpc, policy_version, updated_at)
VALUES ($1::uuid, $2::citext, $3, $4, $5, $6, $7, $8)
ON CONFLICT (tenant_id, subscriber_email) DO UPDATE
   SET open_opt_out_at  = EXCLUDED.open_opt_out_at,
       click_opt_out_at = EXCLUDED.click_opt_out_at,
       source           = EXCLUDED.source,
       gpc              = EXCLUDED.gpc,
       policy_version   = EXCLUDED.policy_version,
       updated_at       = EXCLUDED.updated_at
RETURNING subscriber_email::text, open_opt_out_at, click_opt_out_at,
          source, gpc, policy_version, updated_at`,
		tenantID, sub.Email, openAt, clickAt, after.Source, after.GPC,
		after.PolicyVersion, mutationAt,
	).Scan(
		&prefs.SubscriberEmail,
		&prefs.OpenOptOutAt,
		&prefs.ClickOptOutAt,
		&prefs.Source,
		&prefs.GPC,
		&prefs.PolicyVersion,
		&prefs.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	prefs.SubscriberID = sub.ID
	prefs.SubscriberEmail = sub.Email
	finalizeTrackingPrefs(&prefs)
	return &prefs, nil
}

func defaultTrackingPrefs(sub trackingSubscriber) *TrackingPrefs {
	prefs := &TrackingPrefs{
		SubscriberID:    sub.ID,
		SubscriberEmail: sub.Email,
		Source:          "default",
		PolicyVersion:   "v1",
		UpdatedAt:       sub.UpdatedAt,
	}
	finalizeTrackingPrefs(prefs)
	return prefs
}

func bindTrackingPrefs(prefs *TrackingPrefs, sub trackingSubscriber) *TrackingPrefs {
	if prefs == nil {
		return defaultTrackingPrefs(sub)
	}
	prefs.SubscriberID = sub.ID
	prefs.SubscriberEmail = sub.Email
	finalizeTrackingPrefs(prefs)
	return prefs
}

func trackingETag(sub trackingSubscriber, prefs *TrackingPrefs) string {
	version := sub.UpdatedAt
	if prefs != nil && prefs.UpdatedAt.After(version) {
		version = prefs.UpdatedAt
	}
	return httpcache.ConcurrencyToken("subscriber-tracking-consent", sub.ID, version)
}

// GetTrackingByID is the stable identity endpoint.
// GET /api/v1/subscribers/{id}/tracking-consent
func (d *Deps) GetTrackingByID(w http.ResponseWriter, r *http.Request) {
	d.getTracking(w, r, trackingIdentityStableID)
}

// GetTracking is the deprecated email-keyed compatibility endpoint.
// GET /api/v1/consent/subscribers/{email}/tracking
func (d *Deps) GetTracking(w http.ResponseWriter, r *http.Request) {
	d.getTracking(w, r, trackingIdentityLegacyEmail)
}

func (d *Deps) getTracking(w http.ResponseWriter, r *http.Request, kind trackingIdentityKind) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	identity, err := trackingIdentity(r, kind)
	if err != nil {
		httperror.WriteValidation(w, trackingIdentityErrorCode(kind), err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	sub, err := resolveTrackingSubscriber(r.Context(), tx, tenant.ID, kind, identity, false)
	if err != nil {
		writeTrackingReadError(w, r, d, err)
		return
	}
	prefs, err := LoadTrackingPrefs(r.Context(), tx, sub.Email)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeTrackingResponse(w, sub, bindTrackingPrefs(prefs, sub), kind)
}

// PatchTrackingByID is the stable identity mutation endpoint.
// PATCH /api/v1/subscribers/{id}/tracking-consent
func (d *Deps) PatchTrackingByID(w http.ResponseWriter, r *http.Request) {
	d.patchTracking(w, r, trackingIdentityStableID)
}

// PatchTracking is the deprecated email-keyed compatibility endpoint. It
// requires If-Match so an address renamed/reused between read and write cannot
// redirect an old mutation onto a different subscriber.
func (d *Deps) PatchTracking(w http.ResponseWriter, r *http.Request) {
	d.patchTracking(w, r, trackingIdentityLegacyEmail)
}

func hasExactTrackingIfMatch(r *http.Request) bool {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if raw == "" || raw == "*" || strings.HasPrefix(raw, "W/") || strings.Contains(raw, ",") {
		return false
	}
	// Tracking versions are emitted as strong quoted entity tags. Rejecting
	// unquoted/weak/list forms keeps this compliance write bound to exactly one
	// representation instead of silently accepting a merely-present header.
	return len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"'
}

func (d *Deps) patchTracking(w http.ResponseWriter, r *http.Request, kind trackingIdentityKind) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	identity, err := trackingIdentity(r, kind)
	if err != nil {
		httperror.WriteValidation(w, trackingIdentityErrorCode(kind), err.Error())
		return
	}
	var in TrackingPatchInput
	if err := httpbody.DecodeJSON(w, r, trackingJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := normalizeTrackingPatch(r, &in); err != nil {
		httperror.WriteValidation(w, "invalid_input", err.Error())
		return
	}
	if !hasExactTrackingIfMatch(r) {
		httpcache.WritePreconditionRequired(w)
		return
	}
	if d.Outbox == nil {
		httperror.WriteInternal(w, d.Logger, errors.New("consent: tracking outbox is not configured"), r.Context())
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	sub, err := resolveTrackingSubscriber(r.Context(), tx, tenant.ID, kind, identity, true)
	if err != nil {
		writeTrackingReadError(w, r, d, err)
		return
	}
	existing, err := loadTrackingPrefs(r.Context(), tx, sub.Email, true)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	before := snapshotTrackingPrefs(existing)
	after := targetTrackingPrefs(before, existing, in)
	currentETag := trackingETag(sub, existing)

	// Exact semantic retries are success even with the original (now stale)
	// ETag. They do not append duplicate events, audit rows, or outbox intents.
	if trackingSnapshotsEqual(before, after) {
		if err := tx.Commit(r.Context()); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		writeTrackingResponse(w, sub, bindTrackingPrefs(existing, sub), kind)
		return
	}
	if httpcache.IfMatchFailed(r, currentETag) {
		httpcache.WritePreconditionFailed(w)
		return
	}

	prefs, err := upsertTrackingPrefs(r.Context(), tx, tenant.ID, sub, existing, in, after)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	eventIDs, err := appendTrackingEvents(r, tx, tenant.ID, sub, in, before, after)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, fmt.Errorf("persist tracking consent event: %w", err), r.Context())
		return
	}
	outboxID, err := d.Outbox.Append(r.Context(), tx, outbox.Append{
		TenantID: tenant.ID,
		Kind:     trackingWebhookFanoutKind,
		Payload: map[string]any{
			"event_type":      trackingWebhookEventType,
			"idempotency_key": fmt.Sprintf("tracking-consent:%s:%d", sub.ID, prefs.UpdatedAt.UnixMicro()),
			"body": map[string]any{
				"id":                          sub.ID,
				"email":                       sub.Email,
				"category":                    "email_tracking",
				"open_opt_out":                prefs.OpenOptOutAt != nil,
				"click_opt_out":               prefs.ClickOptOutAt != nil,
				"gpc":                         prefs.GPC,
				"effective_open_opt_out":      prefs.EffectiveOpenOptOut,
				"effective_click_opt_out":     prefs.EffectiveClickOptOut,
				"source":                      prefs.Source,
				"policy_version":              prefs.PolicyVersion,
				"canonical_consent_event_ids": eventIDs,
				"updated_at":                  prefs.UpdatedAt.Format(time.RFC3339Nano),
			},
		},
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, fmt.Errorf("persist tracking outbox intent: %w", err), r.Context())
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = tenant.ID
	if err := db.Audit(r.Context(), tx, auditMeta,
		"subscriber.tracking_consent.updated", "subscriber", sub.ID,
		map[string]any{
			"before":                      before,
			"after":                       after,
			"canonical_consent_event_ids": eventIDs,
			"outbox_event_id":             outboxID,
			"route_identity":              trackingIdentityLabel(kind),
		}); err != nil {
		httperror.WriteInternal(w, d.Logger, fmt.Errorf("persist tracking consent audit: %w", err), r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeTrackingResponse(w, sub, prefs, kind)
}

func appendTrackingEvents(
	r *http.Request,
	tx pgx.Tx,
	tenantID string,
	sub trackingSubscriber,
	in TrackingPatchInput,
	before, after trackingSnapshot,
) ([]string, error) {
	metadataChanged := before.Source != after.Source || before.PolicyVersion != after.PolicyVersion
	dimensions := make([]string, 0, 3)
	if in.OpenOptOut != nil && (before.OpenOptOut != after.OpenOptOut || before.GPC != after.GPC || metadataChanged) {
		dimensions = append(dimensions, "open")
	}
	if in.ClickOptOut != nil && (before.ClickOptOut != after.ClickOptOut || before.GPC != after.GPC || metadataChanged) {
		dimensions = append(dimensions, "click")
	}
	if in.GPC != nil && (before.GPC != after.GPC || metadataChanged) {
		dimensions = append(dimensions, "gpc")
	}
	if len(dimensions) == 0 {
		return nil, errors.New("changed tracking projection has no evidence dimension")
	}

	eventIDs := make([]string, 0, len(dimensions))
	for _, dimension := range dimensions {
		effectiveOptOut := after.GPC
		requestedOptOut := after.GPC
		switch dimension {
		case "open":
			requestedOptOut = after.OpenOptOut
			effectiveOptOut = after.OpenOptOut || after.GPC
		case "click":
			requestedOptOut = after.ClickOptOut
			effectiveOptOut = after.ClickOptOut || after.GPC
		}
		action := "granted"
		if effectiveOptOut {
			action = "opted_out"
		}
		id, err := RecordEventInTx(r.Context(), tx, EventInput{
			TenantID:      tenantID,
			SubjectType:   "subscriber",
			SubjectID:     sub.ID,
			SubjectEmail:  sub.Email,
			Channel:       "api",
			Category:      "email_tracking",
			Action:        action,
			Source:        after.Source,
			PolicyVersion: after.PolicyVersion,
			GPC:           after.GPC,
			IP:            ClientIP(r),
			UserAgent:     boundedTrackingEvidence(r.UserAgent(), trackingUserAgentMaxBytes),
			Preferences: map[string]any{
				"dimension":               dimension,
				"requested_opt_out":       requestedOptOut,
				"effective_opt_out":       effectiveOptOut,
				"open_opt_out":            after.OpenOptOut,
				"click_opt_out":           after.ClickOptOut,
				"effective_open_opt_out":  after.OpenOptOut || after.GPC,
				"effective_click_opt_out": after.ClickOptOut || after.GPC,
			},
		})
		if err != nil {
			return nil, err
		}
		eventIDs = append(eventIDs, id)
	}
	return eventIDs, nil
}

func trackingIdentity(r *http.Request, kind trackingIdentityKind) (string, error) {
	switch kind {
	case trackingIdentityStableID:
		raw := strings.TrimSpace(chi.URLParam(r, "id"))
		parsed, err := uuid.Parse(raw)
		if err != nil {
			return "", errors.New("subscriber id must be a UUID")
		}
		return parsed.String(), nil
	case trackingIdentityLegacyEmail:
		return normalizeTrackingEmail(chi.URLParam(r, "email"))
	default:
		return "", errors.New("unsupported tracking identity")
	}
}

func normalizeTrackingEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if email == "" {
		return "", errors.New("subscriber email is required")
	}
	if len(email) > trackingEmailMaxBytes || utf8.RuneCountInString(email) > trackingEmailMaxBytes {
		return "", fmt.Errorf("subscriber email exceeds %d characters", trackingEmailMaxBytes)
	}
	if !utf8.ValidString(email) || containsUnsafeTrackingText(email) {
		return "", errors.New("subscriber email contains invalid characters")
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Name != "" || !strings.EqualFold(parsed.Address, email) {
		return "", errors.New("subscriber email is invalid")
	}
	return email, nil
}

func normalizeTrackingPatch(r *http.Request, in *TrackingPatchInput) error {
	if in == nil {
		return errors.New("request body is required")
	}
	if ReadGPC(r) {
		value := true
		in.GPC = &value
		source := "gpc"
		in.Source = &source
	}
	if in.OpenOptOut == nil && in.ClickOptOut == nil && in.GPC == nil {
		return errors.New("at least one of open_opt_out, click_opt_out, or gpc is required")
	}
	if in.Source != nil {
		source := strings.ToLower(strings.TrimSpace(*in.Source))
		if err := validateTrackingText("source", source, trackingSourceMaxBytes); err != nil {
			return err
		}
		if !trackingSourceRE.MatchString(source) {
			return errors.New("source must use lowercase letters, numbers, dot, colon, slash, underscore, or hyphen")
		}
		in.Source = &source
	}
	if in.PolicyVersion != nil {
		policy := strings.TrimSpace(*in.PolicyVersion)
		if err := validateTrackingText("policy_version", policy, trackingPolicyMaxBytes); err != nil {
			return err
		}
		in.PolicyVersion = &policy
	}
	return nil
}

func validateTrackingText(field, value string, maxBytes int) error {
	if value == "" {
		return fmt.Errorf("%s cannot be empty", field)
	}
	if !utf8.ValidString(value) {
		return fmt.Errorf("%s must be valid UTF-8", field)
	}
	if len(value) > maxBytes || utf8.RuneCountInString(value) > maxBytes {
		return fmt.Errorf("%s exceeds %d characters", field, maxBytes)
	}
	if containsUnsafeTrackingText(value) {
		return fmt.Errorf("%s contains control or formatting characters", field)
	}
	return nil
}

func containsUnsafeTrackingText(value string) bool {
	for _, char := range value {
		if unicode.IsControl(char) || unicode.Is(unicode.Cf, char) ||
			unicode.Is(unicode.Zl, char) || unicode.Is(unicode.Zp, char) {
			return true
		}
	}
	return false
}

func boundedTrackingEvidence(value string, maxBytes int) string {
	value = strings.Map(func(char rune) rune {
		if unicode.IsControl(char) || unicode.Is(unicode.Cf, char) ||
			unicode.Is(unicode.Zl, char) || unicode.Is(unicode.Zp, char) {
			return -1
		}
		return char
	}, value)
	if len(value) <= maxBytes {
		return value
	}
	cut := maxBytes
	for cut > 0 && !utf8.ValidString(value[:cut]) {
		cut--
	}
	return value[:cut]
}

func writeTrackingResponse(w http.ResponseWriter, sub trackingSubscriber, prefs *TrackingPrefs, kind trackingIdentityKind) {
	prefs.Version = trackingETag(sub, prefs)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("ETag", prefs.Version)
	if kind == trackingIdentityLegacyEmail {
		w.Header().Set("Deprecation", "true")
		w.Header().Set("Link", fmt.Sprintf("</api/v1/subscribers/%s/tracking-consent>; rel=\"successor-version\"", sub.ID))
	}
	writeJSON(w, http.StatusOK, prefs)
}

func writeTrackingReadError(w http.ResponseWriter, r *http.Request, d *Deps, err error) {
	if errors.Is(err, errTrackingSubscriberNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

func trackingIdentityErrorCode(kind trackingIdentityKind) string {
	if kind == trackingIdentityStableID {
		return "invalid_subscriber_id"
	}
	return "invalid_subscriber_email"
}

func trackingIdentityLabel(kind trackingIdentityKind) string {
	if kind == trackingIdentityStableID {
		return "subscriber_id"
	}
	return "email_compatibility"
}
