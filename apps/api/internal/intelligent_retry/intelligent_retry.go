// SPDX-License-Identifier: AGPL-3.0-only
//
// Package intelligent_retry records email recipients deferred by send gates
// (today: tenant frequency caps) so operators and workers can retry them after
// the cooling window instead of losing them as opaque queue skips. Its event
// identity and promotion transaction are intentionally email-specific.
package intelligent_retry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
)

type Queue struct {
	Pool                 *db.Pool
	Frequency            func(ctx context.Context, tenantID, channel string, candidates []string) (kept []string, err error)
	SubscriberPreference func(ctx context.Context, tenantID string, candidates []string) (kept []string, err error)
	beginTenant          func(context.Context, string) (pgx.Tx, error)
	beginWorker          func(context.Context) (pgx.Tx, error)
	auditMutation        func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error
	now                  func() time.Time
}

type Deps struct {
	Queue *Queue
	// Logger is used by httperror.WriteInternal to record server-side
	// detail for 5xx responses without leaking err.Error() back to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

type Worker struct {
	Queue     *Queue
	Interval  time.Duration
	BatchSize int
	Logger    *slog.Logger
}

type Breakdown struct {
	RuleID    string `json:"rule_id,omitempty"`
	RuleLabel string `json:"rule_label,omitempty"`
	Skipped   int    `json:"skipped,omitempty"`
}

type Event struct {
	ID              string      `json:"id"`
	TenantID        string      `json:"tenant_id"`
	CampaignID      string      `json:"campaign_id"`
	SubscriberEmail string      `json:"subscriber_email"`
	Reason          string      `json:"reason"`
	Status          string      `json:"status"`
	RetryAfter      time.Time   `json:"retry_after"`
	Attempts        int         `json:"attempts"`
	Breakdown       []Breakdown `json:"breakdown,omitempty"`
	CreatedAt       time.Time   `json:"created_at"`
	UpdatedAt       time.Time   `json:"updated_at"`
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Queue == nil || (d.Queue.Pool == nil && d.Queue.beginTenant == nil) {
		return
	}
	admin := apikeys.RequireExactTenantAdmin
	r.With(ProtectResponses, admin).Get("/api/v1/intelligent-retry/events", d.list)
	r.With(ProtectResponses, admin).Post("/api/v1/intelligent-retry/events/{id}/mark-ready", d.markReady)
	r.With(ProtectResponses, admin).Post("/api/v1/intelligent-retry/events/{id}/dismiss", d.dismiss)
}

// ProtectResponses keeps retry evidence and mutations out of browser/shared
// caches, including authorization failures and unmatched child paths.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const base = "/api/v1/intelligent-retry/events"
		if r.URL.Path == base || strings.HasPrefix(r.URL.Path, base+"/") {
			protected := &retryProtectedResponseWriter{ResponseWriter: w}
			protected.apply()
			next.ServeHTTP(protected, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type retryProtectedResponseWriter struct{ http.ResponseWriter }

func (w *retryProtectedResponseWriter) apply() {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (w *retryProtectedResponseWriter) WriteHeader(status int) {
	w.apply()
	w.ResponseWriter.WriteHeader(status)
}

func (w *retryProtectedResponseWriter) Write(body []byte) (int, error) {
	w.apply()
	return w.ResponseWriter.Write(body)
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the private boundary is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this claims no streaming capability it lacks.
func (w *retryProtectedResponseWriter) FlushError() error {
	w.apply()
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *retryProtectedResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func NewWorker(q *Queue) *Worker {
	return &Worker{
		Queue:     q,
		Interval:  5 * time.Minute,
		BatchSize: 100,
	}
}

func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.Queue == nil || w.Queue.Pool == nil {
		return
	}
	w.runOnce(ctx)
	interval := w.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.runOnce(ctx)
		}
	}
}

func (w *Worker) runOnce(ctx context.Context) {
	limit := w.BatchSize
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	n, err := w.Queue.PromoteDue(ctx, limit)
	if err != nil && w.Logger != nil {
		w.Logger.Warn("intelligent retry worker failed", "err", err.Error())
		return
	}
	if n > 0 && w.Logger != nil {
		w.Logger.Info("intelligent retry promoted recipients", "count", n)
	}
}

func (d *Deps) list(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	limit := 100
	if values, present := r.URL.Query()["limit"]; present {
		if len(values) != 1 {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be one integer from 1 through 500"))
			return
		}
		raw := strings.TrimSpace(values[0])
		n, err := strconv.Atoi(raw)
		if err != nil || raw == "" || raw != values[0] || n <= 0 || n > 500 {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be one integer from 1 through 500"))
			return
		}
		limit = n
	}
	status := ""
	if values, present := r.URL.Query()["status"]; present {
		if len(values) != 1 {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_status", "status must be one supported retry state"))
			return
		}
		status = values[0]
		if status != strings.TrimSpace(status) || status != strings.ToLower(status) || !validRetryListStatus(status) {
			writeJSON(w, http.StatusBadRequest, errEnv(
				"invalid_status",
				"status must be pending, ready, retrying, retried, failed, or dismissed",
			))
			return
		}
	}
	events, err := d.Queue.List(r.Context(), t.ID, status, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// A nil slice marshals to JSON null, so an empty result set answered
	// {"items": null}. Clients type `items` as an array; the first .map() on
	// null throws, and a list endpoint with nothing in it is the ordinary case,
	// not an edge case. An empty list is [].
	if events == nil {
		events = []Event{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": events})
}

func validRetryListStatus(status string) bool {
	switch status {
	case "pending", "ready", "retrying", "retried", "failed", "dismissed":
		return true
	default:
		return false
	}
}

func (d *Deps) markReady(w http.ResponseWriter, r *http.Request) {
	d.setStatus(w, r, "ready")
}

func (d *Deps) dismiss(w http.ResponseWriter, r *http.Request) {
	d.setStatus(w, r, "dismissed")
}

const retryMutationJSONMaxBodyBytes int64 = 1 << 10

var (
	errRetryExpectedUpdatedAtRequired = errors.New("expected_updated_at is required")
	errRetryExpectedUpdatedAtInvalid  = errors.New("expected_updated_at must be the exact non-zero RFC3339 updated_at value returned for the retry event")
)

type retryStatusInput struct {
	ExpectedUpdatedAt json.RawMessage `json:"expected_updated_at"`
}

// parseRetryExpectedUpdatedAt keeps omission distinct from an explicit null
// or malformed value so callers get a missing-precondition 428 rather than a
// generic validation response.
func parseRetryExpectedUpdatedAt(raw json.RawMessage) (time.Time, error) {
	if len(raw) == 0 {
		return time.Time{}, errRetryExpectedUpdatedAtRequired
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" || len(value) > 64 || strings.TrimSpace(value) != value {
		return time.Time{}, errRetryExpectedUpdatedAtInvalid
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.IsZero() {
		return time.Time{}, errRetryExpectedUpdatedAtInvalid
	}
	return parsed, nil
}

func (d *Deps) setStatus(w http.ResponseWriter, r *http.Request, status string) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in retryStatusInput
	if err := httpbody.DecodeJSONWith(
		w, r, retryMutationJSONMaxBodyBytes, &in,
		httpbody.Options{AllowEmptyBody: true},
	); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	expectedUpdatedAt, err := parseRetryExpectedUpdatedAt(in.ExpectedUpdatedAt)
	if err != nil {
		if errors.Is(err, errRetryExpectedUpdatedAtRequired) {
			writeJSON(w, http.StatusPreconditionRequired, errEnv(
				"precondition_required",
				"expected_updated_at is required and must match the exact retry event revision",
			))
			return
		}
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_expected_updated_at", errRetryExpectedUpdatedAtInvalid.Error()))
		return
	}
	out, err := d.Queue.SetStatus(
		r.Context(), t.ID, chi.URLParam(r, "id"), status, expectedUpdatedAt,
		middleware.AuditMetaFromRequest(r),
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "retry event not found"))
			return
		}
		if errors.Is(err, ErrInvalidRetryTransition) {
			writeJSON(w, http.StatusConflict, errEnv(
				"retry_transition_conflict",
				"retry event state changed or does not allow this transition",
			))
			return
		}
		if errors.Is(err, ErrRetryRevisionConflict) {
			writeJSON(w, http.StatusConflict, errEnv(
				"retry_revision_conflict",
				"the retry event changed after it was loaded; reload before changing it",
			))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (q *Queue) EnqueueFrequencySkipped(
	ctx context.Context,
	tenantID string,
	campaignID string,
	emails []string,
	breakdown []Breakdown,
	retryAfter time.Time,
) error {
	if len(emails) == 0 {
		return nil
	}
	if q == nil || q.Pool == nil {
		return errors.New("intelligent retry: tenant store is not configured")
	}
	tx, err := db.WithTenant(ctx, q.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := q.EnqueueFrequencySkippedTx(ctx, tx, tenantID, campaignID, emails, breakdown, retryAfter); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EnqueueFrequencySkippedTx inserts retry evidence into the caller's tenant
// transaction. Campaign admission uses this form so recipient insertion,
// frequency ledger writes, campaign status, and retry receipts commit or roll
// back as one decision.
func (q *Queue) EnqueueFrequencySkippedTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	campaignID string,
	emails []string,
	breakdown []Breakdown,
	retryAfter time.Time,
) error {
	if len(emails) == 0 {
		return nil
	}
	if tx == nil || tenantID == "" || campaignID == "" {
		return errors.New("intelligent retry: transaction and owner ids are required")
	}
	// Serialize with every canonical-email rotation, then resolve aliases while
	// that lock is held. If enqueue wins, rotation sees and repoints this row; if
	// rotation wins, an old address resolves through subscriber_emails to the
	// subscriber's current canonical email. No old-address row can commit in the
	// scan/commit gap of a rotation.
	if err := subscriberidentitylock.Shared(ctx, tx, tenantID); err != nil {
		return err
	}
	canonicalEmails, err := resolveCanonicalRetryEmails(ctx, tx, tenantID, emails)
	if err != nil {
		return err
	}
	if len(canonicalEmails) == 0 {
		return nil
	}
	if retryAfter.IsZero() {
		retryAfter = time.Now().UTC().Add(time.Hour)
	}
	raw, err := json.Marshal(breakdown)
	if err != nil {
		return fmt.Errorf("intelligent retry: encode breakdown: %w", err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO intelligent_retry_events (
    tenant_id, campaign_id, subscriber_email, reason, status,
    retry_after, breakdown, updated_at
)
SELECT $1::uuid, $2::uuid, lower(e)::citext, 'frequency_cap', 'pending',
       $3, $4::jsonb, now()
  FROM unnest($5::text[]) AS e
ON CONFLICT (tenant_id, campaign_id, subscriber_email, reason) DO UPDATE
   SET status      = CASE
                       WHEN intelligent_retry_events.status = 'dismissed'
                         THEN intelligent_retry_events.status
                       ELSE 'pending'
                     END,
       retry_after = LEAST(intelligent_retry_events.retry_after, EXCLUDED.retry_after),
		breakdown   = EXCLUDED.breakdown,
		updated_at  = now()`,
		tenantID, campaignID, retryAfter, string(raw), canonicalEmails)
	return err
}

// resolveCanonicalRetryEmails maps historical/secondary addresses through the
// normalized subscriber_emails owner to its current subscribers.email value.
// Caller must hold subscriberidentitylock.Shared for this tenant, which makes
// this read stable until its retry insert commits. Unowned legacy/imported
// addresses remain valid unless an irreversible erasure tombstone matches the
// requested or resolved canonical address.
func resolveCanonicalRetryEmails(ctx context.Context, tx pgx.Tx, tenantID string, emails []string) ([]string, error) {
	normalized := make([]string, 0, len(emails))
	seenInput := make(map[string]struct{}, len(emails))
	for _, rawEmail := range emails {
		email := strings.ToLower(strings.TrimSpace(rawEmail))
		if email == "" {
			return nil, errors.New("intelligent retry: subscriber email is empty")
		}
		if _, seen := seenInput[email]; seen {
			continue
		}
		seenInput[email] = struct{}{}
		normalized = append(normalized, email)
	}
	if len(normalized) == 0 {
		return []string{}, nil
	}

	rows, err := tx.Query(ctx, `
WITH requested AS (
    SELECT lower(btrim(input.email))::citext AS email, input.ordinality
      FROM unnest($2::text[]) WITH ORDINALITY AS input(email, ordinality)
), resolved AS (
    SELECT requested.email AS requested_email,
           lower(COALESCE(owner.email, direct_owner.email, requested.email)::text)::citext AS canonical_email,
           requested.ordinality
      FROM requested
      LEFT JOIN subscriber_emails AS address
        ON address.tenant_id=$1::uuid
       AND address.email=requested.email
      LEFT JOIN subscribers AS owner
        ON owner.tenant_id=address.tenant_id
       AND owner.id=address.subscriber_id
      LEFT JOIN subscribers AS direct_owner
        ON direct_owner.tenant_id=$1::uuid
       AND direct_owner.email=requested.email
)
SELECT resolved.canonical_email::text
  FROM resolved
 WHERE NOT EXISTS (
       SELECT 1
         FROM subscriber_suppressions AS suppression
        WHERE suppression.tenant_id=$1::uuid
          AND (
                lower(COALESCE(suppression.reason, '')) IN ('dsar_deletion', 'gdpr_erasure')
                OR lower(COALESCE(suppression.metadata->>'gdpr_erasure', 'false')) = 'true'
              )
          AND (
                lower(suppression.email::text) IN (
                    resolved.requested_email::text,
                    resolved.canonical_email::text
                )
                OR suppression.email_sha256 IN (
                    encode(digest(resolved.requested_email::text, 'sha256'), 'hex'),
                    encode(digest(resolved.canonical_email::text, 'sha256'), 'hex')
                )
              )
 )
 ORDER BY resolved.ordinality`, tenantID, normalized)
	if err != nil {
		return nil, fmt.Errorf("intelligent retry: resolve canonical subscriber emails: %w", err)
	}
	defer rows.Close()
	canonical := make([]string, 0, len(normalized))
	seenCanonical := make(map[string]struct{}, len(normalized))
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, fmt.Errorf("intelligent retry: scan canonical subscriber email: %w", err)
		}
		email = strings.ToLower(strings.TrimSpace(email))
		if email == "" {
			return nil, errors.New("intelligent retry: canonical subscriber email is empty")
		}
		if _, seen := seenCanonical[email]; seen {
			continue
		}
		seenCanonical[email] = struct{}{}
		canonical = append(canonical, email)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("intelligent retry: iterate canonical subscriber emails: %w", err)
	}
	return canonical, nil
}

func (q *Queue) List(ctx context.Context, tenantID, status string, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, q.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, campaign_id::text, subscriber_email::text,
       reason, status, retry_after, attempts, breakdown, created_at, updated_at
  FROM intelligent_retry_events
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR status = $2)
 ORDER BY retry_after ASC, created_at ASC
 LIMIT $3`, tenantID, strings.TrimSpace(status), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

var (
	ErrInvalidRetryTransition = errors.New("intelligent retry: invalid status transition")
	ErrRetryRevisionConflict  = errors.New("intelligent retry: revision conflict")
)

func (q *Queue) tenantTx(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if q != nil && q.beginTenant != nil {
		return q.beginTenant(ctx, tenantID)
	}
	if q == nil || q.Pool == nil {
		return nil, errors.New("intelligent retry: tenant store is not configured")
	}
	return db.WithTenant(ctx, q.Pool, tenantID)
}

func (q *Queue) auditStatusMutation(
	ctx context.Context,
	tx pgx.Tx,
	meta db.AuditMeta,
	action, resourceID string,
	details map[string]any,
) error {
	if q != nil && q.auditMutation != nil {
		return q.auditMutation(ctx, tx, meta, action, "intelligent_retry_event", resourceID, details)
	}
	return db.Audit(ctx, tx, meta, action, "intelligent_retry_event", resourceID, details)
}

func (q *Queue) SetStatus(
	ctx context.Context,
	tenantID, id, status string,
	expectedUpdatedAt time.Time,
	auditMeta db.AuditMeta,
) (*Event, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	if status != "ready" && status != "dismissed" {
		return nil, fmt.Errorf("%w: target %q", ErrInvalidRetryTransition, status)
	}
	tx, err := q.tenantTx(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := scanEvent(tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, campaign_id::text, subscriber_email::text,
       reason, status, retry_after, attempts, breakdown, created_at, updated_at
  FROM intelligent_retry_events
 WHERE tenant_id = $1::uuid AND id::text = $2
 FOR UPDATE`, tenantID, strings.TrimSpace(id)))
	if err != nil {
		return nil, err
	}
	if !current.UpdatedAt.Equal(expectedUpdatedAt) {
		return nil, fmt.Errorf(
			"%w: expected %s, found %s",
			ErrRetryRevisionConflict,
			expectedUpdatedAt.UTC().Format(time.RFC3339Nano),
			current.UpdatedAt.UTC().Format(time.RFC3339Nano),
		)
	}
	if !retryTransitionAllowed(current.Status, status) {
		return nil, fmt.Errorf("%w: %s to %s", ErrInvalidRetryTransition, current.Status, status)
	}
	out, err := scanEvent(tx.QueryRow(ctx, `
UPDATE intelligent_retry_events
   SET status = $3,
       retry_after = CASE WHEN $3 = 'ready' THEN LEAST(retry_after, now()) ELSE retry_after END,
       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, tenant_id::text, campaign_id::text, subscriber_email::text,
          reason, status, retry_after, attempts, breakdown, created_at, updated_at`,
		tenantID, strings.TrimSpace(id), status))
	if err != nil {
		return nil, err
	}
	auditMeta.TenantID = tenantID
	action := "intelligent_retry.dismissed"
	if status == "ready" {
		action = "intelligent_retry.marked_ready"
	}
	if err := q.auditStatusMutation(ctx, tx, auditMeta, action, current.ID, map[string]any{
		"campaign_id":       current.CampaignID,
		"before_status":     current.Status,
		"after_status":      out.Status,
		"before_updated_at": current.UpdatedAt.UTC().Format(time.RFC3339Nano),
		"after_updated_at":  out.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func retryTransitionAllowed(current, target string) bool {
	switch target {
	case "ready":
		return current == "pending" || current == "failed" || current == "ready"
	case "dismissed":
		return current == "pending" || current == "failed" || current == "ready" || current == "dismissed"
	default:
		return false
	}
}

// RetryClaimLeaseDuration is the worker ownership window. A retrying row is
// not claimable by another worker before this interval elapses. Every worker
// completion also compares the claim's updated_at revision, so an expired
// worker cannot mutate the row after a successful reclaim.
const RetryClaimLeaseDuration = 30 * time.Minute

func (q *Queue) workerTx(ctx context.Context) (pgx.Tx, error) {
	if q != nil && q.beginWorker != nil {
		return q.beginWorker(ctx)
	}
	if q == nil || q.Pool == nil {
		return nil, errors.New("intelligent retry: worker store is not configured")
	}
	return db.WithWorkerScope(ctx, q.Pool)
}

func (q *Queue) claimTime(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	if q != nil && q.now != nil {
		if now := q.now().UTC(); !now.IsZero() {
			return now, nil
		}
	}
	if tx == nil {
		return time.Time{}, errors.New("intelligent retry: worker transaction is not configured")
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return time.Time{}, fmt.Errorf("intelligent retry: read database lease clock: %w", err)
	}
	return now.UTC(), nil
}

func (q *Queue) PromoteDue(ctx context.Context, limit int) (int, error) {
	events, err := q.claimDue(ctx, limit)
	if err != nil {
		return 0, err
	}
	promoted := 0
	for _, ev := range events {
		ok, err := q.promoteEvent(ctx, ev)
		if err != nil {
			_ = q.markFailed(ctx, ev, err.Error())
			continue
		}
		if ok {
			promoted++
		}
	}
	return promoted, nil
}

func (q *Queue) claimDue(ctx context.Context, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := q.workerTx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.intelligent_retry_worker', 'true', true)`); err != nil {
		return nil, err
	}
	claimNow, err := q.claimTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	leaseCutoff := claimNow.Add(-RetryClaimLeaseDuration)
	rows, err := tx.Query(ctx, `
UPDATE intelligent_retry_events
   SET status = 'retrying',
       attempts = attempts + 1,
       updated_at = $2
 WHERE id IN (
     SELECT id
       FROM intelligent_retry_events
      WHERE (status IN ('pending', 'ready') AND retry_after <= $2)
         OR (status = 'retrying' AND updated_at <= $3)
      ORDER BY (status = 'retrying') DESC,
               (status = 'ready') DESC,
               CASE WHEN status = 'retrying' THEN updated_at ELSE retry_after END ASC,
               created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
 )
RETURNING id::text, tenant_id::text, campaign_id::text, subscriber_email::text,
          reason, status, retry_after, attempts, breakdown, created_at, updated_at`,
		limit, claimNow, leaseCutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		ev, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (q *Queue) promoteEvent(ctx context.Context, ev Event) (bool, error) {
	admitted, err := q.frequencyAdmits(ctx, ev)
	if err != nil {
		return false, err
	}
	if !admitted {
		return false, q.deferCapped(ctx, ev)
	}
	preferenceAdmitted, err := q.subscriberPreferenceAdmits(ctx, ev)
	if err != nil {
		return false, err
	}
	if !preferenceAdmitted {
		return false, q.deferCapped(ctx, ev)
	}
	tx, err := db.WithTenant(ctx, q.Pool, ev.TenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	frequencyAdmission, err := frequency.AdmitAndReserveTx(
		ctx, tx, ev.TenantID, ev.CampaignID, "email", []string{ev.SubscriberEmail},
	)
	if err != nil {
		return false, fmt.Errorf("intelligent retry: transactional frequency admission: %w", err)
	}
	if frequencyAdmission.Skipped != 0 || len(frequencyAdmission.Kept) == 0 {
		tag, updateErr := tx.Exec(ctx, `
UPDATE intelligent_retry_events
   SET status = 'pending', retry_after = now() + interval '1 hour', updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status = 'retrying'
   AND updated_at = $3`, ev.TenantID, ev.ID, ev.UpdatedAt)
		if updateErr != nil {
			return false, updateErr
		}
		if tag.RowsAffected() != 1 {
			return false, errors.New("intelligent retry: frequency-deferred lease ownership changed")
		}
		if err := tx.Commit(ctx); err != nil {
			return false, err
		}
		return false, nil
	}
	var eligible bool
	var insertedCount int64
	err = tx.QueryRow(ctx, `
WITH lease AS MATERIALIZED (
    -- updated_at is the worker's lease revision. Lock and prove ownership
    -- before deriving any insert input so a worker whose lease was reclaimed
    -- cannot promote or overwrite the newer worker's result.
    SELECT tenant_id, campaign_id, id
      FROM intelligent_retry_events
     WHERE tenant_id = $1::uuid
       AND id::text = $4
       AND status = 'retrying'
       AND updated_at = $5
       FOR UPDATE
), subscriber_state AS MATERIALIZED (
    -- Lock the subscriber authority in the same transaction as promotion.
    -- A concurrent pause update therefore linearizes before this check (and
    -- blocks promotion) or after recipient admission; it cannot commit in the
    -- unchecked gap between a read and this INSERT.
    SELECT NOT (
               frequency_preference = 'paused'
           AND (paused_until IS NULL OR paused_until > now())
           ) AS preference_allows
      FROM subscribers
     WHERE tenant_id = $1::uuid
       AND email = $3::citext
       FOR NO KEY UPDATE
), campaign_eligible AS (
    SELECT tenant_id, id
      FROM campaigns
     WHERE tenant_id = $1::uuid
       AND id = $2::uuid
       AND status IN ('sending', 'paused')
), eligible AS (
    SELECT campaign.tenant_id, campaign.id
      FROM campaign_eligible AS campaign
      JOIN lease
        ON lease.tenant_id = campaign.tenant_id
       AND lease.campaign_id = campaign.id
      JOIN subscriber_state AS preference
        ON preference.preference_allows
), binding AS (
    -- Frequency retry is a continuation of the canonical queue operation,
    -- never a new authorization. Copy the exact immutable receipt from that
    -- campaign's existing work set. In shadow/warn it is uniformly NULL; in
    -- block mode it is uniformly bound. The send-loop's block-mode interlock
    -- independently refuses an unbound row if legacy/corrupt state exists.
    SELECT cr.content_revision_id, cr.send_plan_id, cr.assurance_run_id,
           cr.assurance_attempt_count, cr.assurance_artifact_set_hash,
           cr.assurance_source_hash, cr.assurance_plan_hash,
           cr.assurance_gate_decision, cr.assurance_override_ids,
           cr.assurance_bound_at
      FROM campaign_recipients AS cr
      JOIN eligible AS campaign
        ON campaign.tenant_id = cr.tenant_id
       AND campaign.id = cr.campaign_id
     ORDER BY (cr.assurance_run_id IS NULL), cr.id
     LIMIT 1
), inserted AS (
    INSERT INTO campaign_recipients (
        campaign_id, tenant_id, subscriber_email, status,
        content_revision_id, send_plan_id, assurance_run_id,
        assurance_attempt_count, assurance_artifact_set_hash,
        assurance_source_hash, assurance_plan_hash,
        assurance_gate_decision, assurance_override_ids,
        assurance_bound_at
    )
    SELECT campaign.id, campaign.tenant_id, $3, 'pending',
           binding.content_revision_id, binding.send_plan_id,
           binding.assurance_run_id, binding.assurance_attempt_count,
           binding.assurance_artifact_set_hash, binding.assurance_source_hash,
           binding.assurance_plan_hash, binding.assurance_gate_decision,
           COALESCE(binding.assurance_override_ids, '{}'::uuid[]),
           binding.assurance_bound_at
      FROM eligible AS campaign
      LEFT JOIN binding ON true
    ON CONFLICT (campaign_id, (lower(subscriber_email))) DO NOTHING
    RETURNING tenant_id, subscriber_email
), updated AS (
    UPDATE intelligent_retry_events
       SET status = CASE
                      WHEN EXISTS (
                           SELECT 1 FROM subscriber_state
                            WHERE NOT preference_allows
                           ) THEN 'pending'
                      WHEN EXISTS (SELECT 1 FROM eligible) THEN 'retried'
                      ELSE 'failed'
                    END,
           retry_after = CASE
                           WHEN EXISTS (
                                SELECT 1 FROM subscriber_state
                                 WHERE NOT preference_allows
                                ) THEN now() + interval '1 hour'
                           ELSE retry_after
                         END,
           updated_at = now()
     WHERE tenant_id = $1::uuid
       AND id::text = $4
       AND status = 'retrying'
       AND updated_at = $5
       AND EXISTS (SELECT 1 FROM lease)
     RETURNING status
)
SELECT EXISTS (SELECT 1 FROM eligible), (SELECT count(*) FROM inserted)`,
		ev.TenantID, ev.CampaignID, ev.SubscriberEmail, ev.ID, ev.UpdatedAt).Scan(&eligible, &insertedCount)
	if err != nil {
		return false, err
	}
	if !eligible {
		if err := frequency.ReleaseReservationsTx(
			ctx, tx, ev.TenantID, frequencyAdmission.ReservationIDs,
		); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return eligible, nil
}

func (q *Queue) subscriberPreferenceAdmits(ctx context.Context, ev Event) (bool, error) {
	if q == nil || q.SubscriberPreference == nil {
		return false, errors.New("intelligent retry: subscriber-preference enforcement is not configured")
	}
	kept, err := q.SubscriberPreference(ctx, ev.TenantID, []string{ev.SubscriberEmail})
	if err != nil {
		return false, fmt.Errorf("intelligent retry: enforce subscriber preference: %w", err)
	}
	if len(kept) == 0 {
		return false, nil
	}
	if len(kept) != 1 || !strings.EqualFold(strings.TrimSpace(kept[0]), strings.TrimSpace(ev.SubscriberEmail)) {
		return false, errors.New("intelligent retry: subscriber-preference enforcement returned an invalid recipient set")
	}
	return true, nil
}

func (q *Queue) frequencyAdmits(ctx context.Context, ev Event) (bool, error) {
	if q == nil || q.Frequency == nil {
		return false, errors.New("intelligent retry: frequency enforcement is not configured")
	}
	kept, err := q.Frequency(ctx, ev.TenantID, "email", []string{ev.SubscriberEmail})
	if err != nil {
		return false, fmt.Errorf("intelligent retry: enforce frequency cap: %w", err)
	}
	if len(kept) == 0 {
		return false, nil
	}
	if len(kept) != 1 || !strings.EqualFold(strings.TrimSpace(kept[0]), strings.TrimSpace(ev.SubscriberEmail)) {
		return false, errors.New("intelligent retry: frequency enforcement returned an invalid recipient set")
	}
	return true, nil
}

func (q *Queue) deferCapped(ctx context.Context, ev Event) error {
	tx, err := db.WithTenant(ctx, q.Pool, ev.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `
UPDATE intelligent_retry_events
   SET status = 'pending', retry_after = now() + interval '1 hour', updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status = 'retrying'
   AND updated_at = $3`, ev.TenantID, ev.ID, ev.UpdatedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (q *Queue) markFailed(ctx context.Context, ev Event, reason string) error {
	tx, err := db.WithTenant(ctx, q.Pool, ev.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	breakdown := append([]Breakdown(nil), ev.Breakdown...)
	breakdown = append(breakdown, Breakdown{RuleID: "worker_error", RuleLabel: reason, Skipped: 0})
	raw, _ := json.Marshal(breakdown)
	_, err = tx.Exec(ctx, `
UPDATE intelligent_retry_events
   SET status = 'failed',
       breakdown = $3::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status = 'retrying'
   AND updated_at = $4`,
		ev.TenantID, ev.ID, string(raw), ev.UpdatedAt)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type eventScanner interface {
	Scan(dest ...any) error
}

func scanEvent(row eventScanner) (Event, error) {
	var ev Event
	var raw []byte
	err := row.Scan(&ev.ID, &ev.TenantID, &ev.CampaignID, &ev.SubscriberEmail,
		&ev.Reason, &ev.Status, &ev.RetryAfter, &ev.Attempts,
		&raw, &ev.CreatedAt, &ev.UpdatedAt)
	if err != nil {
		return ev, err
	}
	_ = json.Unmarshal(raw, &ev.Breakdown)
	if ev.Breakdown == nil {
		ev.Breakdown = []Breakdown{}
	}
	return ev, nil
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
