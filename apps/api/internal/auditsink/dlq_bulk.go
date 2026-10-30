// SPDX-License-Identifier: AGPL-3.0-only
//
// dlq_bulk.go — sse-pinned-tail feature (Audit UX, P1).
//
// Bulk DLQ replay. The Audit-sinks page used to require operators to
// click "Replay" once per pending row, and the single-row endpoint
// gave no aggregate feedback. This handler replays up to 500 ids in
// one call and returns a per-entry status array so the UI can render
// a "Replayed N events, K failed" toast plus per-row badges.
//
// Synchronous on purpose — 500 is a small enough batch that the
// caller can afford to wait, and the per-row status array would need
// a polling endpoint otherwise.

package auditsink

import (
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ReplayEntryStatus is the per-DLQ-id outcome of a bulk replay. The
// frontend renders the row badge from `status` and surfaces ErrorMsg
// in a tooltip when status != "ok".
type ReplayEntryStatus struct {
	ID       int64  `json:"id"`
	Status   string `json:"status"` // "ok" | "failed" | "skipped" | "not_found"
	Rows     int    `json:"rows"`
	ErrorMsg string `json:"errorMsg,omitempty"`
}

// ReplayResponse aggregates per-entry outcomes plus headline counters
// so the UI can show "Replayed 18 events, 0 failed" without scanning
// the array on the client.
type ReplayResponse struct {
	Replayed int                 `json:"replayed"`
	Failed   int                 `json:"failed"`
	Skipped  int                 `json:"skipped"`
	Entries  []ReplayEntryStatus `json:"entries"`
}

// replayBulkReq is the wire shape for POST /audit-sinks/dlq/replay-bulk.
type replayBulkReq struct {
	IDs []int64 `json:"ids"`
}

// maxBulkReplayIDs caps a single request so a runaway operator can't
// queue a 100k-row replay synchronously. Mirrors the comment in the
// feature spec (risks block).
const maxBulkReplayIDs = 500

// ReplayDLQBulk POST /api/v1/audit-sinks/dlq/replay-bulk — bulk replay.
// Body: {"ids":[1,2,3,...]}. Per-entry status returned.
func (a *AdminDeps) ReplayDLQBulk(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in replayBulkReq
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if len(in.IDs) == 0 {
		writeAdminErr(w, http.StatusBadRequest, "empty_ids", "ids required")
		return
	}
	if len(in.IDs) > maxBulkReplayIDs {
		writeAdminErr(w, http.StatusBadRequest, "too_many_ids",
			"max 500 ids per bulk replay; submit multiple batches")
		return
	}

	// The worker is shared across iterations so we only build the
	// outbound HTTP client + cipher binding once.
	worker := &Deps{
		Pool:               a.Pool,
		Cipher:             a.Cipher,
		HTTP:               newAuditSinkHTTPClient(30 * time.Second),
		httpClientHardened: true,
	}

	resp := ReplayResponse{Entries: make([]ReplayEntryStatus, 0, len(in.IDs))}
	for _, dlqID := range in.IDs {
		st := a.replayOne(r, worker, t.ID, dlqID)
		resp.Entries = append(resp.Entries, st)
		switch st.Status {
		case "ok":
			resp.Replayed++
		case "failed", "not_found":
			resp.Failed++
		case "skipped":
			resp.Skipped++
		}
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.dlq_replay_bulk", "audit_sink_dlq", "", nil,
		map[string]any{
			"requested": len(in.IDs),
			"replayed":  resp.Replayed,
			"failed":    resp.Failed,
			"skipped":   resp.Skipped,
		}, nil)
	writeAdminJSON(w, http.StatusOK, resp)
}

// replayOne handles a single DLQ id and returns its outcome.
// Intentionally swallows DB errors as status="failed" — the bulk
// handler must keep going so one bad row doesn't poison the batch.
func (a *AdminDeps) replayOne(r *http.Request, worker *Deps, tenantID string, dlqID int64) ReplayEntryStatus {
	out := ReplayEntryStatus{ID: dlqID, Status: "failed"}

	tx, txErr := db.WithTenant(r.Context(), a.Pool, tenantID)
	if txErr != nil {
		out.ErrorMsg = "tx: " + txErr.Error()
		return out
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		sinkID                 string
		fromAuditID, toAuditID int64
		alreadyReplayed        *string
	)
	if err := tx.QueryRow(r.Context(), `
SELECT sink_id::text, from_audit_id, to_audit_id, replayed_at::text
  FROM audit_sink_dlq
 WHERE tenant_id = $1::uuid AND id = $2`,
		tenantID, dlqID).Scan(&sinkID, &fromAuditID, &toAuditID, &alreadyReplayed); err != nil {
		out.Status = "not_found"
		out.ErrorMsg = err.Error()
		return out
	}
	if alreadyReplayed != nil && *alreadyReplayed != "" {
		out.Status = "skipped"
		out.ErrorMsg = "already replayed at " + *alreadyReplayed
		return out
	}

	var sink Sink
	if err := tx.QueryRow(r.Context(), `
SELECT id::text, tenant_id::text, kind, name, enabled,
       COALESCE(config,'{}'::jsonb),
       COALESCE(credentials_envelope, ''::bytea),
       COALESCE(consecutive_failures,0),
       COALESCE(output_format,'postwave_native')
  FROM audit_sinks
 WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		sinkID, tenantID).Scan(&sink.ID, &sink.TenantID, &sink.Kind, &sink.Name,
		&sink.Enabled, &sink.Config, &sink.CredentialsEnvelope,
		&sink.ConsecutiveFailures, &sink.OutputFormat); err != nil {
		out.Status = "not_found"
		out.ErrorMsg = "sink lookup: " + err.Error()
		return out
	}
	if err := tx.Commit(r.Context()); err != nil {
		out.ErrorMsg = "commit: " + err.Error()
		return out
	}

	rows, txErr := worker.loadBatchByRange(r.Context(), sink.TenantID, fromAuditID, toAuditID)
	if txErr != nil {
		a.bumpDLQAttempt(r.Context(), tenantID, dlqID, "fetch failed: "+txErr.Error())
		out.ErrorMsg = "fetch: " + txErr.Error()
		return out
	}
	if len(rows) == 0 {
		a.markDLQReplayed(r.Context(), tenantID, dlqID,
			"no rows in range — marking replayed")
		out.Status = "ok"
		out.Rows = 0
		out.ErrorMsg = "no audit_log rows in range (retention may have pruned them)"
		return out
	}
	if err := worker.deliver(r.Context(), sink, rows); err != nil {
		a.bumpDLQAttempt(r.Context(), tenantID, dlqID, err.Error())
		out.ErrorMsg = err.Error()
		return out
	}
	a.markDLQReplayed(r.Context(), tenantID, dlqID, "")
	out.Status = "ok"
	out.Rows = len(rows)
	return out
}
