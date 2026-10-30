// SPDX-License-Identifier: AGPL-3.0-only
//
// dlq_handlers.go — list pending DLQ entries + replay one or many.
//
// Endpoints (admin-scoped, mounted by AdminDeps.MountAdminRoutes):
//
//   GET    /api/v1/audit-sinks/dlq                  — list pending entries
//   POST   /api/v1/audit-sinks/dlq/{id}/replay      — replay one
//   POST   /api/v1/audit-sinks/{id}/circuit/reset   — force-close the breaker

package auditsink

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// MountDLQRoutes registers the DLQ + breaker admin endpoints. Keep
// separate from MountAdminRoutes so the deployment can selectively
// enable / disable the replay surface (some operators reserve it for
// internal tooling only).
func (a *AdminDeps) MountDLQRoutes(r chi.Router) {
	if a == nil || a.Pool == nil {
		return
	}
	// RBAC-meta-audit: list of pending DLQ entries is a read; replay
	// triggers an outbound POST so it's an "execute action"; circuit
	// reset is a sink-configuration mutation. ScopeAdmin still grants
	// all three as a wildcard.
	listGate := apikeys.RequireScope(apikeys.ScopeAuditRead)
	replayGate := apikeys.RequireScope(apikeys.ScopeAuditExecuteActions)
	resetGate := apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)
	r.With(listGate).Get("/api/v1/audit-sinks/dlq", a.ListDLQ)
	// p4d-recordsurface-wire-others: DLQ replay + circuit-reset are
	// the operator's fire-drill controls — track them alongside the
	// CRUD ops on the same auditsink dashboard row.
	r.With(replayGate).Post("/api/v1/audit-sinks/dlq/{id}/replay", observability.RecordSurfaceFunc("auditsink", "dlq_replay", a.ReplayDLQ))
	// sse-pinned-tail (Audit UX, P1): bulk replay returns per-entry
	// status so the DLQ table can show "Replayed N events, K failed".
	r.With(replayGate).Post("/api/v1/audit-sinks/dlq/replay-bulk", observability.RecordSurfaceFunc("auditsink", "dlq_replay_bulk", a.ReplayDLQBulk))
	r.With(resetGate).Post("/api/v1/audit-sinks/{id}/circuit/reset", observability.RecordSurfaceFunc("auditsink", "circuit_reset", a.ResetCircuit))
}

// dlqRow is the wire shape.
type dlqRow struct {
	ID            int64   `json:"id"`
	SinkID        string  `json:"sink_id"`
	FromAuditID   int64   `json:"from_audit_id"`
	ToAuditID     int64   `json:"to_audit_id"`
	LastError     string  `json:"last_error"`
	AttemptCount  int     `json:"attempt_count"`
	FirstFailedAt string  `json:"first_failed_at"`
	LastAttemptAt string  `json:"last_attempt_at"`
	ReplayedAt    *string `json:"replayed_at,omitempty"`
	ReplayedBy    *string `json:"replayed_by,omitempty"`
}

// ListDLQ GET /api/v1/audit-sinks/dlq — pending DLQ entries only.
func (a *AdminDeps) ListDLQ(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id, sink_id::text, from_audit_id, to_audit_id,
       last_error, attempt_count,
       first_failed_at::text, last_attempt_at::text,
       replayed_at::text, replayed_by
  FROM audit_sink_dlq
 WHERE tenant_id = $1::uuid
   AND replayed_at IS NULL
 ORDER BY first_failed_at ASC
 LIMIT 1000`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []dlqRow{}
	for rows.Next() {
		var d dlqRow
		if err := rows.Scan(&d.ID, &d.SinkID, &d.FromAuditID, &d.ToAuditID,
			&d.LastError, &d.AttemptCount, &d.FirstFailedAt, &d.LastAttemptAt,
			&d.ReplayedAt, &d.ReplayedBy); err != nil {
			httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		out = append(out, d)
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"entries": out, "count": len(out)})
}

// ReplayDLQ POST /api/v1/audit-sinks/dlq/{id}/replay — re-fetch the
// audit_log range + re-issue the delivery. On success the DLQ row is
// marked replayed_at=now(); on failure the attempt_count is bumped.
//
// Note: this handler does the delivery synchronously to give the
// operator immediate feedback. For replaying a large backlog,
// invoke this endpoint per-id from a CLI.
func (a *AdminDeps) ReplayDLQ(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	idStr := strings.TrimSpace(chi.URLParam(r, "id"))
	if idStr == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}

	// Look up the DLQ row + the parent sink. Sink kind + credentials
	// are needed to know how to ship.
	var (
		dlqID                  int64
		sinkID                 string
		fromAuditID, toAuditID int64
		alreadyReplayed        *string
	)
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := tx.QueryRow(r.Context(), `
SELECT id, sink_id::text, from_audit_id, to_audit_id, replayed_at::text
  FROM audit_sink_dlq
 WHERE tenant_id = $1::uuid AND id = $2`,
		t.ID, idStr).Scan(&dlqID, &sinkID, &fromAuditID, &toAuditID, &alreadyReplayed); err != nil {
		writeAdminErr(w, http.StatusNotFound, "not_found", "DLQ entry not found")
		return
	}
	if alreadyReplayed != nil && *alreadyReplayed != "" {
		writeAdminErr(w, http.StatusConflict, "already_replayed",
			"this DLQ entry was already replayed at "+*alreadyReplayed)
		return
	}

	// Fetch the sink config + credentials.
	var sink Sink
	if err := tx.QueryRow(r.Context(), `
SELECT id::text, tenant_id::text, kind, name, enabled,
       COALESCE(config,'{}'::jsonb),
       COALESCE(credentials_envelope, ''::bytea),
       COALESCE(consecutive_failures,0),
       COALESCE(output_format,'postwave_native')
  FROM audit_sinks
 WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		sinkID, t.ID).Scan(&sink.ID, &sink.TenantID, &sink.Kind, &sink.Name,
		&sink.Enabled, &sink.Config, &sink.CredentialsEnvelope, &sink.ConsecutiveFailures,
		&sink.OutputFormat); err != nil {
		writeAdminErr(w, http.StatusNotFound, "sink_not_found", "sink not found")
		return
	}
	_ = tx.Commit(r.Context())

	// Re-fetch the audit_log range and replay through the worker's
	// existing deliver() path. We don't reuse the cursor here — the
	// DLQ entry carries explicit row ids.
	//
	// IMPORTANT: pass a.Cipher in so deliver→decryptCreds can unwrap
	// the envelope. Replay used to be wired without a cipher, which
	// silently broke every credentialed sink ("auditsink: cipher
	// unconfigured").
	worker := &Deps{
		Pool:               a.Pool,
		Cipher:             a.Cipher,
		HTTP:               newAuditSinkHTTPClient(30 * time.Second),
		httpClientHardened: true,
		Logger:             nil,
	}
	rows, err := worker.loadBatchByRange(r.Context(), sink.TenantID, fromAuditID, toAuditID)
	if err != nil {
		a.bumpDLQAttempt(r.Context(), t.ID, dlqID, "fetch failed: "+err.Error())
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if len(rows) == 0 {
		a.markDLQReplayed(r.Context(), t.ID, dlqID, "no rows in range — marking replayed")
		writeAdminJSON(w, http.StatusOK, map[string]any{
			"replayed": true,
			"rows":     0,
			"note":     "no audit_log rows in range (retention may have pruned them)",
		})
		return
	}
	if err := worker.deliver(r.Context(), sink, rows); err != nil {
		a.bumpDLQAttempt(r.Context(), t.ID, dlqID, err.Error())
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	a.markDLQReplayed(r.Context(), t.ID, dlqID, "")
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.dlq_replay", "audit_sink_dlq", idStr, nil,
		map[string]any{
			"sink_id": sinkID,
			"rows":    len(rows),
			"from_id": fromAuditID,
			"to_id":   toAuditID,
		}, nil)
	writeAdminJSON(w, http.StatusOK, map[string]any{
		"replayed": true,
		"rows":     len(rows),
	})
}

// loadBatchByRange is a sibling of loadBatch that walks an EXPLICIT
// id range rather than the (cursor, +N) sliding window the worker
// normally uses. The range is what audit_sink_dlq stores.
func (d *Deps) loadBatchByRange(ctx context.Context, tenantID string, fromID, toID int64) ([]AuditRow, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, COALESCE(user_id::text,''), action,
       COALESCE(resource_type,''), COALESCE(resource_id,''),
       COALESCE(metadata, '{}'::jsonb),
       COALESCE(host(ip), ''), COALESCE(user_agent, ''),
       COALESCE(actor_type, 'human'), COALESCE(actor_label, ''),
       at
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id BETWEEN $2 AND $3
 ORDER BY id ASC`, tenantID, fromID, toID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var r AuditRow
		r.TenantID = tenantID
		var meta []byte
		if err := rows.Scan(&r.ID, &r.UserID, &r.Action,
			&r.ResourceType, &r.ResourceID, &meta, &r.IP, &r.UserAgent,
			&r.ActorType, &r.ActorLabel, &r.At); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(meta, &r.Metadata)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (a *AdminDeps) bumpDLQAttempt(ctx context.Context, tenantID string, dlqID int64, errMsg string) {
	tx, err := db.WithTenant(ctx, a.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `
UPDATE audit_sink_dlq
   SET attempt_count = attempt_count + 1,
       last_attempt_at = now(),
       last_error = $2
 WHERE id = $1`, dlqID, errMsg)
	_ = tx.Commit(ctx)
}

func (a *AdminDeps) markDLQReplayed(ctx context.Context, tenantID string, dlqID int64, note string) {
	tx, err := db.WithTenant(ctx, a.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `
UPDATE audit_sink_dlq
   SET replayed_at = now(),
       last_attempt_at = now(),
       last_error = COALESCE(NULLIF($2,''), last_error)
 WHERE id = $1`, dlqID, note)
	_ = tx.Commit(ctx)
}

// ResetCircuit POST /api/v1/audit-sinks/{id}/circuit/reset — force-
// closes the breaker without waiting for the cooldown. Useful when
// the operator just fixed the upstream and wants delivery to resume
// immediately.
func (a *AdminDeps) ResetCircuit(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	sinkID := strings.TrimSpace(chi.URLParam(r, "id"))
	if sinkID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "sink id required")
		return
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
UPDATE audit_sinks
   SET circuit_state = 'closed',
       cooldown_until = NULL,
       consecutive_failures = 0
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, t.ID, sinkID)
	if err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		writeAdminErr(w, http.StatusNotFound, "not_found", "sink not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, a.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.circuit_reset", "audit_sink", sinkID, nil,
		map[string]any{"sink_id": sinkID}, nil)
	writeAdminJSON(w, http.StatusOK, map[string]any{"reset": true})
}

// keep errors imported for future typed-error sentinels.
var _ = errors.New
