package zerocopy_triggers

// Dead-letter queue for zero-copy warehouse triggers. Backs
// migration 0345's `external_warehouse_trigger_dlq` table.
//
// This file provides:
//   - DLQRepo persists / lists DLQ entries (Enqueue / List / Resolve /
//     IncrementRetry).
//   - HTTP handlers (ListDLQ / RetryDLQ) are wired into MountRoutes so
//     an operator can inspect and manually replay rows.
//   - Automatic replay (PollOnce → unresolved → DLQ enqueue →
//     reconciliation tick → re-resolve subscriber → enqueue flow_run)
//     through `ReconcileDLQ` from the worker tick.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
)

// DLQReason mirrors external_warehouse_trigger_dlq.reason.
type DLQReason string

const (
	DLQReasonUnresolvedSubscriber DLQReason = "unresolved_subscriber"
	DLQReasonEnqueueFailed        DLQReason = "enqueue_failed"
	DLQReasonDriverPartialRow     DLQReason = "driver_partial_row"
)

// DLQStatus mirrors external_warehouse_trigger_dlq.status.
type DLQStatus string

const (
	DLQStatusPending   DLQStatus = "pending"
	DLQStatusResolved  DLQStatus = "resolved"
	DLQStatusAbandoned DLQStatus = "abandoned"
)

// DLQEntry is the API/JSON shape of one DLQ row.
type DLQEntry struct {
	ID            int64          `json:"id"`
	TenantID      string         `json:"tenant_id,omitempty"`
	TriggerID     string         `json:"trigger_id"`
	CursorValue   string         `json:"cursor_value,omitempty"`
	ProfileKey    string         `json:"profile_key,omitempty"`
	Payload       map[string]any `json:"payload,omitempty"`
	Reason        DLQReason      `json:"reason"`
	RetryCount    int            `json:"retry_count"`
	LastError     string         `json:"last_error,omitempty"`
	LastRetriedAt *time.Time     `json:"last_retried_at,omitempty"`
	Status        DLQStatus      `json:"status"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
}

// DLQEntryView preserves retry/triage state without exposing warehouse row
// payloads, profile keys, cursors, tenant ids, or free-form provider errors.
type DLQEntryView struct {
	ID                int64      `json:"id"`
	TriggerID         string     `json:"trigger_id"`
	Reason            DLQReason  `json:"reason"`
	RetryCount        int        `json:"retry_count"`
	LastRetriedAt     *time.Time `json:"last_retried_at,omitempty"`
	Status            DLQStatus  `json:"status"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	HasCursor         bool       `json:"has_cursor"`
	HasProfileKey     bool       `json:"has_profile_key"`
	HasPayload        bool       `json:"has_payload"`
	LastErrorCategory string     `json:"last_error_category,omitempty"`
}

// DLQRepo isolates the dead-letter table.
type DLQRepo struct {
	Pool *db.Pool
}

const dlqColumns = `id, tenant_id::text, trigger_id::text,
       cursor_value, profile_key, payload, reason, retry_count,
       last_error, last_retried_at, status, created_at, updated_at`

// Enqueue inserts a new DLQ row. The worker calls this when a fire
// would otherwise be dropped (today: matched_no_subscriber / enqueue
// error). The current PollOnce does NOT yet call into here — see the
// "wiring tasks" section in MIGRATION.md.
func (r *DLQRepo) Enqueue(ctx context.Context, tenantID string, in DLQEntry) (int64, error) {
	if !zeroCopyRuntimeQualified() {
		return 0, ErrZeroCopyRuntimeUnavailable
	}
	if strings.TrimSpace(in.TriggerID) == "" {
		return 0, errors.New("zerocopy_triggers/dlq: trigger_id required")
	}
	if in.Reason == "" {
		in.Reason = DLQReasonUnresolvedSubscriber
	}
	if in.Status == "" {
		in.Status = DLQStatusPending
	}
	payload, _ := json.Marshal(in.Payload)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	if err := tx.QueryRow(ctx, `
INSERT INTO external_warehouse_trigger_dlq
    (tenant_id, trigger_id, cursor_value, profile_key, payload, reason, status)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7)
RETURNING id`,
		tenantID, in.TriggerID, in.CursorValue, in.ProfileKey, string(payload),
		string(in.Reason), string(in.Status)).Scan(&id); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return id, nil
}

// List returns recent DLQ entries for a tenant, newest-first. Optional
// trigger filter narrows to one trigger; status filter narrows to one
// state. Bounded by `limit` (default 100, max 500).
func (r *DLQRepo) List(ctx context.Context, tenantID, triggerID, status string, limit int) ([]DLQEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+dlqColumns+`
FROM external_warehouse_trigger_dlq
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR trigger_id = NULLIF($2,'')::uuid)
  AND ($3 = '' OR status = $3)
ORDER BY created_at DESC
LIMIT $4`, tenantID, strings.TrimSpace(triggerID), strings.TrimSpace(status), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DLQEntry{}
	for rows.Next() {
		e, err := scanDLQ(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListReconcilable claims pending DLQ entries across ALL tenants that are due
// for a retry (last_retried_at NULL or older than minRetryGap), oldest first.
// Like Repo.ListDue it bypasses tenant binding via the app.outbox_worker GUC
// (the DLQ table's RLS allows the read only then, migration 0345); the caller
// re-enters tenant scope per entry to resolve + enqueue.
func (r *DLQRepo) ListReconcilable(ctx context.Context, now time.Time, minRetryGap time.Duration, limit int) ([]DLQEntry, error) {
	if !zeroCopyRuntimeQualified() {
		return nil, ErrZeroCopyRuntimeUnavailable
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SET app.outbox_worker = 'true'"); err != nil {
		_ = err // best-effort; RLS still filters if unrecognized
	}
	defer func() { _, _ = conn.Exec(context.Background(), "RESET app.outbox_worker") }()
	rows, err := conn.Query(ctx, `
SELECT `+dlqColumns+`
FROM external_warehouse_trigger_dlq
WHERE status = 'pending'
  AND (last_retried_at IS NULL OR last_retried_at < $1)
ORDER BY COALESCE(last_retried_at, created_at) ASC
LIMIT $2`, now.Add(-minRetryGap), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DLQEntry
	for rows.Next() {
		e, serr := scanDLQ(rows)
		if serr != nil {
			return nil, serr
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// Resolve marks a DLQ entry as successfully replayed.
func (r *DLQRepo) Resolve(ctx context.Context, tenantID string, id int64) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	return r.setStatus(ctx, tenantID, id, DLQStatusResolved, "")
}

// Abandon marks a DLQ entry as no-longer-retryable. The retry routine
// calls this once retry_count hits its ceiling.
func (r *DLQRepo) Abandon(ctx context.Context, tenantID string, id int64, reason string) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	return r.setStatus(ctx, tenantID, id, DLQStatusAbandoned, reason)
}

func (r *DLQRepo) setStatus(ctx context.Context, tenantID string, id int64, status DLQStatus, lastErr string) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE external_warehouse_trigger_dlq
   SET status     = $3,
       last_error = CASE WHEN $4 = '' THEN last_error ELSE $4 END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2`,
		tenantID, id, string(status), lastErr)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// IncrementRetry bumps retry_count + last_retried_at and stores the
// most recent error string. The reconciliation worker calls this after
// every replay attempt.
func (r *DLQRepo) IncrementRetry(ctx context.Context, tenantID string, id int64, lastErr string, now time.Time) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE external_warehouse_trigger_dlq
   SET retry_count     = retry_count + 1,
       last_retried_at = $3,
       last_error      = $4,
       updated_at      = now()
 WHERE tenant_id = $1::uuid AND id = $2 AND status = 'pending'`,
		tenantID, id, now, lastErr)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func scanDLQ(row pgx.Row) (*DLQEntry, error) {
	var out DLQEntry
	var reason, status string
	var payloadRaw []byte
	if err := row.Scan(
		&out.ID, &out.TenantID, &out.TriggerID,
		&out.CursorValue, &out.ProfileKey, &payloadRaw,
		&reason, &out.RetryCount, &out.LastError,
		&out.LastRetriedAt, &status, &out.CreatedAt, &out.UpdatedAt,
	); err != nil {
		return nil, err
	}
	out.Reason = DLQReason(reason)
	out.Status = DLQStatus(status)
	out.Payload = decodeMap(payloadRaw)
	return &out, nil
}

// ReconcileDLQ drains the dead-letter queue across tenants:
//
//  1. Pull at most `limit` pending entries whose last_retried_at is older than
//     `minRetryGap` (or NULL).
//  2. For each: re-resolve the profile_key against subscribers. If resolved and
//     the trigger still has a journey, enqueue a flow_run and mark Resolve.
//     Otherwise IncrementRetry — or Abandon once a further retry would reach
//     `maxRetries` (no point retrying a permanently-unresolvable row forever).
//  3. Returns the number of entries it touched.
//
// `triggers` supplies ResolveSubscriberID + the trigger lookup (journey + name);
// `enq` is the flow-run seam. Best-effort per entry: one bad row never aborts
// the batch.
func ReconcileDLQ(ctx context.Context, dlq *DLQRepo, triggers *Repo, enq FlowRunEnqueuer, minRetryGap time.Duration, limit, maxRetries int) (int, error) {
	if !zeroCopyRuntimeQualified() {
		return 0, ErrZeroCopyRuntimeUnavailable
	}
	if dlq == nil || triggers == nil {
		return 0, nil
	}
	if maxRetries <= 0 {
		maxRetries = 5
	}
	now := time.Now().UTC()
	entries, err := dlq.ListReconcilable(ctx, now, minRetryGap, limit)
	if err != nil {
		return 0, err
	}
	touched := 0
	for i := range entries {
		e := entries[i]
		touched++

		trig, terr := triggers.Get(ctx, e.TenantID, e.TriggerID)
		if terr != nil || trig == nil {
			reconcileBump(ctx, dlq, e, maxRetries, "trigger lookup failed", now)
			continue
		}
		if strings.TrimSpace(trig.JourneyID) == "" {
			// A trigger with no journey can never enqueue — abandon outright.
			_ = dlq.Abandon(ctx, e.TenantID, e.ID, "trigger has no journey to enqueue into")
			continue
		}
		subscriberID, rerr := triggers.ResolveSubscriberID(ctx, e.TenantID, e.ProfileKey)
		if rerr != nil {
			reconcileBump(ctx, dlq, e, maxRetries, "resolve subscriber failed: "+truncateError(rerr), now)
			continue
		}
		if subscriberID == "" {
			reconcileBump(ctx, dlq, e, maxRetries, "subscriber still unresolved", now)
			continue
		}
		if enq == nil {
			reconcileBump(ctx, dlq, e, maxRetries, "no enqueuer configured", now)
			continue
		}
		if _, eerr := enq.EnqueueRun(ctx, e.TenantID, EnqueueRequest{
			FlowID:           trig.JourneyID,
			SubscriberID:     subscriberID,
			TriggerEventName: "zerocopy:" + trig.Name + ":reconciled",
			ScheduledAt:      now,
		}); eerr != nil {
			reconcileBump(ctx, dlq, e, maxRetries, "enqueue failed: "+truncateError(eerr), now)
			continue
		}
		_ = dlq.Resolve(ctx, e.TenantID, e.ID)
	}
	return touched, nil
}

// reconcileBump records a failed retry: IncrementRetry, or Abandon once one
// more attempt would reach the ceiling (so retry_count never exceeds it).
func reconcileBump(ctx context.Context, dlq *DLQRepo, e DLQEntry, maxRetries int, lastErr string, now time.Time) {
	if shouldAbandon(e.RetryCount, maxRetries) {
		_ = dlq.Abandon(ctx, e.TenantID, e.ID, lastErr)
		return
	}
	_ = dlq.IncrementRetry(ctx, e.TenantID, e.ID, lastErr, now)
}

// shouldAbandon reports whether a row at retryCount has exhausted its budget:
// the NEXT attempt would reach maxRetries, so we abandon instead of bumping.
func shouldAbandon(retryCount, maxRetries int) bool {
	return retryCount+1 >= maxRetries
}

// ----------------------------------------------------------------------
// HTTP handlers.
//
// GET  /api/v1/zero-copy-triggers/{id}/dlq
// POST /api/v1/zero-copy-triggers/{id}/dlq/{entry_id}/retry
// ----------------------------------------------------------------------

// ListDLQ returns the DLQ entries for a single trigger.
func (d *Deps) ListDLQ(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.DLQRepo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("dlq_disabled",
			"dlq repo not wired"))
		return
	}
	out, err := d.DLQRepo.List(r.Context(), tenantID,
		chi.URLParam(r, "id"), r.URL.Query().Get("status"), 0)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	items := make([]DLQEntryView, 0, len(out))
	for _, entry := range out {
		items = append(items, dlqEntryView(entry))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func dlqEntryView(in DLQEntry) DLQEntryView {
	category := ""
	if strings.TrimSpace(in.LastError) != "" {
		category = "execution_error"
	}
	return DLQEntryView{
		ID:                in.ID,
		TriggerID:         in.TriggerID,
		Reason:            in.Reason,
		RetryCount:        in.RetryCount,
		LastRetriedAt:     in.LastRetriedAt,
		Status:            in.Status,
		CreatedAt:         in.CreatedAt,
		UpdatedAt:         in.UpdatedAt,
		HasCursor:         strings.TrimSpace(in.CursorValue) != "",
		HasProfileKey:     strings.TrimSpace(in.ProfileKey) != "",
		HasPayload:        len(in.Payload) > 0,
		LastErrorCategory: category,
	}
}

// RetryDLQ is retained as an authenticated compatibility boundary. Returning
// 202 while no production drainer owns the queue would be a false success, so
// the contained runtime rejects the request without mutating the entry.
func (d *Deps) RetryDLQ(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	runtimecapability.WriteUnavailable(w, zeroCopyControlPlaneDescriptor())
}
