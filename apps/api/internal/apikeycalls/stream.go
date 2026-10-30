// SPDX-License-Identifier: AGPL-3.0-only
//
// stream.go — Server-Sent Events live tail for api_key_calls.
//
// Replaces the dashboard's 15s polling with a real-time stream so
// operators can watch agent calls land as the agent describes the
// task. The implementation is a server-side polling adapter — the
// HTTP connection stays open; the server queries for rows with
// `id > lastSeenID` every PollInterval and pushes deltas as SSE
// events. Cheaper than a true LISTEN/NOTIFY for the dashboard
// cadence (1 query per replica per 2s, even when no one's watching)
// and works across replicas without coordination.

package apikeycalls

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

// StreamPollInterval is the cadence at which the SSE handler queries
// for new rows. Tighter = lower latency; looser = less DB load.
// 2s strikes a good balance for human-perceptible "live".
const StreamPollInterval = 2 * time.Second

// StreamMaxDuration caps any single connection. Browsers will
// reconnect automatically via EventSource, so capping the server-
// side lifetime prevents stale goroutines accumulating after a
// laptop sleep / WiFi flap.
// Every client, including header/cookie-authenticated clients, must re-enter
// authentication and exact-admin authorization at least every two minutes.
// This bounds post-revocation/demotion access even when no pws_ expiry is on
// the request context.
const StreamMaxDuration = 2 * time.Minute

func executionStreamDeadline(ctx context.Context, now time.Time) (time.Time, string) {
	deadline := now.Add(StreamMaxDuration)
	reason := "max_duration"
	if credentialExpiry, ok := apikeys.StreamTokenExpiryFromContext(ctx); ok && credentialExpiry.Before(deadline) {
		deadline = credentialExpiry
		reason = "credential_expired"
	}
	return deadline, reason
}

// StreamExecutions handles GET /api/v1/mcp/executions/stream.
//
// Wire format:
//
//	event: execution
//	data: {"id":123,"toolName":"subscribers_list",...}
//
//	event: heartbeat
//	data: {"at":"2026-05-26T..."}
//
// The heartbeat fires every 15s even when no new rows land so
// reverse proxies (Cloudflare, ALB) don't time out the idle TCP
// connection.
func (d *Deps) StreamExecutions(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "missing_tenant", "no tenant on context")
		return
	}
	stream, ok := sse.Open(w)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "no_flusher",
			"server-sent events require a flushable writer")
		return
	}

	include := r.URL.Query().Get("include")
	if err := validateQueryKeys(r.URL.Query(), "include", "tool", "stream_token", "sse_token"); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	if include != "" && include != "all" {
		writeErr(w, http.StatusBadRequest, "invalid_query", "include must be omitted or all")
		return
	}
	mcpOnly := include != "all"
	tool := r.URL.Query().Get("tool")
	if tool != "" && safeToolLabel(tool) != tool {
		writeErr(w, http.StatusBadRequest, "invalid_query", "tool must be a bounded canonical tool token")
		return
	}

	// Anchor — the highest id we've already streamed. EventSource includes
	// Last-Event-ID on reconnect. Reject malformed values instead of silently
	// resetting to a fresh stream and concealing a client cursor defect.
	var lastID int64
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		value, err := strconv.ParseInt(h, 10, 64)
		if err != nil || value <= 0 {
			writeErr(w, http.StatusBadRequest, "invalid_last_event_id", "Last-Event-ID must be a positive integer")
			return
		}
		lastID = value
	}
	if lastID == 0 {
		max, err := d.Repo.maxID(r.Context(), tenant.ID)
		if err != nil {
			writeErr(w, http.StatusServiceUnavailable, "stream_anchor_unavailable", "could not establish a consistent stream anchor")
			return
		}
		lastID = max
	}

	// SSE headers per the spec. text/event-stream is the
	// canonical Content-Type; no-cache + no-transform prevents
	// reverse proxies from buffering the stream.
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx-specific
	w.WriteHeader(http.StatusOK)
	if stream.Flush() != nil {
		return
	}

	// Comment-style hello so EventSource fires onopen immediately
	// (some browsers wait for the first event before firing it).
	if stream.Sendf(": stream open\n\n") != nil {
		return
	}

	deadline, closeReason := executionStreamDeadline(r.Context(), time.Now().UTC())
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	pollTicker := time.NewTicker(StreamPollInterval)
	defer pollTicker.Stop()
	heartbeatTicker := time.NewTicker(15 * time.Second)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			_, _ = writeStreamClosed(stream, closeReason)
			_ = stream.Flush()
			return
		case <-heartbeatTicker.C:
			// A failed write means the client is gone.
			if stream.Sendf("event: heartbeat\ndata: {\"at\":%q}\n\n",
				time.Now().UTC().Format(time.RFC3339)) != nil {
				return
			}
		case <-pollTicker.C:
			rows, err := d.Repo.listAfterID(ctx, tenant.ID, lastID, mcpOnly, tool, 100)
			if err != nil {
				// Never keep a visually "live" stream open while storage is
				// unreadable. EventSource will reconnect; the typed terminal event
				// lets clients mark the current tail unavailable immediately.
				_, _ = writeStreamUnavailable(stream)
				_ = stream.Flush()
				return
			}
			for _, c := range rows {
				if c.ID > lastID {
					lastID = c.ID
				}
				minimizeCallForResponse(&c)
				payload, err := json.Marshal(c)
				if err != nil {
					continue
				}
				// `id:` becomes Last-Event-ID on reconnect so we
				// can pick up exactly where we left off across a
				// browser-initiated reconnect.
				_, _ = fmt.Fprintf(stream, "id: %d\nevent: execution\ndata: %s\n\n",
					c.ID, payload)
			}
			if len(rows) > 0 && stream.Flush() != nil {
				return
			}
		}
	}
}

func writeStreamUnavailable(w io.Writer) (int, error) {
	return fmt.Fprint(w, "event: unavailable\ndata: {\"code\":\"stream_read_unavailable\",\"retryable\":true}\n\n")
}

func writeStreamClosed(w io.Writer, reason string) (int, error) {
	return fmt.Fprintf(w, "event: closed\ndata: {\"reason\":%q}\n\n", reason)
}

// maxID returns the highest id in api_key_calls for a tenant. Cheap
// (uses the (tenant_id, called_at DESC) index — but here we read max
// of id which the unique constraint index covers). Returns 0 when
// the table is empty for the tenant.
func (r *Repo) maxID(ctx context.Context, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var max *int64
	if err := tx.QueryRow(ctx,
		`SELECT MAX(id) FROM api_key_calls WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&max); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	if max == nil {
		return 0, nil
	}
	return *max, nil
}

// listAfterID returns rows with id > since. Capped + MCP-filterable.
// Used by the SSE poll loop.
func (r *Repo) listAfterID(ctx context.Context, tenantID string, since int64, mcpOnly bool, tool string, limit int) ([]Call, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `
SELECT c.id, c.tenant_id::text, c.api_key_id::text,
       COALESCE(NULLIF(c.api_key_prefix,''), k.prefix, '') AS api_key_prefix,
       c.method, c.path,
       COALESCE(c.query_string,'') AS query_string,
       c.tool_name, c.status_code, c.latency_ms,
       c.user_agent, c.remote_ip, c.error_code,
       c.request_body, COALESCE(c.dry_run, false),
       COALESCE(c.cost_micros, 0), c.called_at
  FROM api_key_calls c
  LEFT JOIN api_keys k ON k.id = c.api_key_id
 WHERE c.tenant_id = $1::uuid
   AND c.id > $2`
	args := []any{tenantID, since}
	nextArg := 3
	if mcpOnly {
		q += " AND c.user_agent ~* $" + strconv.Itoa(nextArg)
		args = append(args, mcpUserAgentSQLPattern)
		nextArg++
	}
	if tool != "" {
		q += " AND c.tool_name = $" + strconv.Itoa(nextArg)
		args = append(args, tool)
		nextArg++
	}
	q += " ORDER BY c.id ASC LIMIT $" + strconv.Itoa(nextArg)
	args = append(args, limit)
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Call{}
	for rows.Next() {
		var c Call
		var apiKeyID *string
		var bodyRaw []byte
		if err := rows.Scan(&c.ID, &c.TenantID, &apiKeyID, &c.APIKeyPrefix,
			&c.Method, &c.Path, &c.QueryString, &c.ToolName, &c.StatusCode, &c.LatencyMs,
			&c.UserAgent, &c.RemoteIP, &c.ErrorCode,
			&bodyRaw, &c.DryRun, &c.CostMicros, &c.CalledAt); err != nil {
			return nil, err
		}
		if apiKeyID != nil && *apiKeyID != "" {
			c.APIKeyID = apiKeyID
		}
		if len(bodyRaw) > 0 {
			c.RequestBody = json.RawMessage(bodyRaw)
		}
		c.DryRunAsserted = c.DryRun
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
