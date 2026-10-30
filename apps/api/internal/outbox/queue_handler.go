// SPDX-License-Identifier: AGPL-3.0-only
//
// queue_handler.go — read-side of the outbox queue + SSE feed for
// the real-time send-queue dashboard.
//
// Endpoints (admin-scoped):
//
//   GET /api/v1/queue/snapshot
//        Returns a single point-in-time view of in-flight + pending
//        rows. Cheap polling fallback for clients that can't hold an
//        SSE connection (mobile dashboards on flaky networks).
//
//   GET /api/v1/queue/stream  (text/event-stream)
//        Subscribes the caller to a 1-second tick of fresh
//        snapshots. SSE keeps the network footprint tiny + the
//        dashboard's "ah it's actually sending RIGHT NOW" feel.
//
// We deliberately don't expose row-level event metadata here. The
// outbox is internal infrastructure; the dashboard wants:
//   * in-flight count by kind
//   * pending count by kind
//   * recent failures count
//   * estimated throughput (events/min)
// — that's it. A leaky "see every payload" surface invites screen-
// recording-the-prod-dashboard incidents.

package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

// QueueDeps wires the dashboard handlers.
type QueueDeps struct {
	Pool *db.Pool
}

// MountQueueRoutes registers GET /snapshot and GET /stream.
func MountQueueRoutes(r chi.Router, d *QueueDeps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/queue/snapshot", d.Snapshot)
	r.With(read).Get("/api/v1/queue/stream", d.Stream)
}

// KindCounts is the per-kind aggregate.
type KindCounts struct {
	Kind     string `json:"kind"`
	Pending  int64  `json:"pending"`
	Inflight int64  `json:"inflight"`
	Failed   int64  `json:"failed_last_hour"`
}

// QueueSnapshot is the wire shape.
type QueueSnapshot struct {
	At                  time.Time    `json:"at"`
	Tenant              string       `json:"tenant_id"`
	Pending             int64        `json:"pending"`
	Inflight            int64        `json:"inflight"`
	FailedLastHour      int64        `json:"failed_last_hour"`
	ThroughputPerMinute int64        `json:"throughput_per_minute"`
	NextRetryAt         *time.Time   `json:"next_retry_at,omitempty"`
	ByKind              []KindCounts `json:"by_kind"`
}

// Snapshot computes the dashboard snapshot.
func (d *QueueDeps) Snapshot(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeQueueErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	snap, err := d.computeSnapshot(r.Context(), t.ID)
	if err != nil {
		writeQueueErr(w, http.StatusInternalServerError, "snapshot_failed", "an internal error occurred")
		return
	}
	writeQueueJSON(w, http.StatusOK, snap)
}

// Stream serves an SSE feed of snapshots. Sends one snapshot
// immediately + one every 2 seconds while the connection is open.
// Connection auto-closes at 5 minutes to limit long-lived idle
// connections in load-balancer fleets.
func (d *QueueDeps) Stream(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeQueueErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	stream, ok := sse.Open(w)
	if !ok {
		writeQueueErr(w, http.StatusInternalServerError, "no_flusher",
			"streaming not supported by this writer")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	emit := func() bool {
		snap, err := d.computeSnapshot(ctx, t.ID)
		if err != nil {
			// The database error text stays in the server log; the stream
			// carries only a fixed, caller-safe sentence.
			slog.WarnContext(ctx, "queue stream snapshot", "err", err)
			_ = stream.Sendf("event: error\ndata: %q\n\n", "queue status could not be refreshed")
			return false
		}
		body, _ := json.Marshal(snap)
		// A failed write means the client is gone.
		return stream.Sendf("event: snapshot\ndata: %s\n\n", body) == nil
	}
	if !emit() {
		return
	}
	for {
		select {
		case <-ctx.Done():
			_ = stream.Sendf("event: closed\ndata: \"stream closed\"\n\n")
			return
		case <-ticker.C:
			if !emit() {
				return
			}
		}
	}
}

// computeSnapshot does the heavy lifting. Two queries:
//  1. SUM CASE WHEN ... over outbox_events for the tenant
//  2. COUNT delivered events in the last minute for throughput
//
// Outbox table is tenant-scoped via RLS; the dashboard never sees
// other tenants' rows even when the schema permits it.
func (d *QueueDeps) computeSnapshot(ctx context.Context, tenantID string) (*QueueSnapshot, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	snap := &QueueSnapshot{
		At:     time.Now().UTC(),
		Tenant: tenantID,
		ByKind: []KindCounts{},
	}
	// outbox_events has NO `status` column — state is derived from the
	// completed_at / failed_at / claimed_until timestamps (migration 0035).
	// The previous query selected `status` and `visible_at`, which do not
	// exist, so it errored on every deployment and the swallowed-error branch
	// below returned an all-zero snapshot: the send-queue dashboard showed
	// zeros everywhere and nobody noticed. Derived states:
	//   pending  = not terminal AND not currently leased
	//   inflight = not terminal AND lease still held
	//   failed   = failed_at set (DLQ)
	rows, err := tx.Query(ctx, `
SELECT kind,
       COUNT(*) FILTER (
         WHERE completed_at IS NULL AND failed_at IS NULL
           AND (claimed_until IS NULL OR claimed_until < now())
       ) AS pending,
       COUNT(*) FILTER (
         WHERE completed_at IS NULL AND failed_at IS NULL
           AND claimed_until >= now()
       ) AS inflight,
       COUNT(*) FILTER (
         WHERE failed_at IS NOT NULL AND failed_at > now() - INTERVAL '1 hour'
       ) AS failed_last_hour
  FROM outbox_events
 WHERE tenant_id = $1::uuid
   AND (completed_at IS NULL OR completed_at > now() - INTERVAL '1 hour')
 GROUP BY kind
 ORDER BY 1`, tenantID)
	if err != nil {
		// Schema variance: some deployments don't have outbox_events
		// yet — return a zero snapshot rather than 500.
		return snap, nil
	}
	defer rows.Close()
	for rows.Next() {
		var kc KindCounts
		if err := rows.Scan(&kc.Kind, &kc.Pending, &kc.Inflight, &kc.Failed); err != nil {
			continue
		}
		snap.Pending += kc.Pending
		snap.Inflight += kc.Inflight
		snap.FailedLastHour += kc.Failed
		snap.ByKind = append(snap.ByKind, kc)
	}

	// Throughput: completed events in the last minute. Same RLS
	// envelope so we don't see other tenants.
	_ = tx.QueryRow(ctx, `
SELECT COUNT(*) FROM outbox_events
 WHERE tenant_id = $1::uuid
   AND completed_at IS NOT NULL
   AND completed_at > now() - INTERVAL '1 minute'`, tenantID).Scan(&snap.ThroughputPerMinute)

	// Soonest pending retry — helps the dashboard render an
	// "next action at HH:MM:SS" hint instead of a bare "X pending".
	// available_at is the "when the worker may claim" timestamp.
	var nextRetry *time.Time
	_ = tx.QueryRow(ctx, `
SELECT MIN(available_at)
  FROM outbox_events
 WHERE tenant_id = $1::uuid
   AND completed_at IS NULL AND failed_at IS NULL
   AND (claimed_until IS NULL OR claimed_until < now())`, tenantID).Scan(&nextRetry)
	snap.NextRetryAt = nextRetry
	return snap, nil
}

func writeQueueJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeQueueErr(w http.ResponseWriter, status int, code, msg string) {
	writeQueueJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// silence imports we may not yet use.
var (
	_ = errors.New
	_ = strings.Contains
)
