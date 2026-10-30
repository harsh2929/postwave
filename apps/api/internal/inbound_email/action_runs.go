// SPDX-License-Identifier: AGPL-3.0-only
//
// action_runs.go — per-action retry executor + outcome logging for
// inbound routes. Closes the v1 audit's biggest observability gap:
//
//   - "Did my webhook actually fire?" was unanswerable because the v1
//     executor logged failures to slog.Warn (operator-invisible) and
//     moved on. v2 writes one row to inbound_route_action_runs per
//     (match, action) capturing status/http_status/response_snippet/
//     duration/attempts, and the UI surfaces it in the match-detail
//     drilldown.
//
//   - No retry on transient failures (network blip, upstream 5xx).
//     v2 honours the per-route retry budget — Route.ActionRetryMax
//     extra attempts after the first, with exponential backoff based
//     on Route.ActionRetryBackoffSeconds. Only retryable actions
//     (webhook, automation_trigger, forward) get retries; tag and
//     store_only are local writes with no retryable failure mode.
//
// The action execution path remains best-effort overall — a poisoned
// match doesn't stall the ingest goroutine. Failures are captured in
// the log rows so they're queryable + visible, not silenced.

package inbound_email

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// runResult is the captured outcome of one action execution attempt.
// `httpStatus` and `responseSnippet` are populated only for HTTP-emit
// kinds (webhook + automation_trigger) where they have meaning.
type runResult struct {
	httpStatus      int
	responseSnippet string
	err             error
}

// retryable returns true when an action kind's failure mode can be
// resolved by trying again. Local-DB writes (`tag`) are not retried
// because the same error will repeat on the second attempt; explicit
// no-ops (`store_only`) have no failure mode.
func retryable(kind string) bool {
	switch kind {
	case "webhook", "automation_trigger", "forward":
		return true
	}
	return false
}

// executeWithRetry runs one action with the route's configured retry
// budget. Returns the FINAL attempt's outcome (status / snippet /
// error) plus the total attempts taken.
//
// Backoff is exponential on the action's base, capped at 60s:
//
//	attempt N delay = backoff * 2^(N-1)
//
// We bound the total runtime via ctx — the caller already wraps the
// full action pipeline in a 30s deadline, so a route with retry_max=5
// and backoff=2 (theoretical sum ~62s) will exit early via ctx.Done.
func (a *ActionDeps) executeWithRetry(
	ctx context.Context,
	tenantID string,
	route Route,
	act RouteAction,
	email Email,
	inboundEmailID int64,
) (runResult, int) {
	maxRetries := route.ActionRetryMax
	if !retryable(act.Kind) {
		maxRetries = 0
	}
	backoff := route.ActionRetryBackoffSeconds
	if backoff < 1 {
		backoff = 1
	}

	attempts := 0
	var last runResult
	for i := 0; i <= maxRetries; i++ {
		attempts++
		last = a.executeOneRich(ctx, tenantID, route, act, email, inboundEmailID)
		if last.err == nil {
			return last, attempts
		}
		// Stop retrying on context cancellation — the ingest goroutine
		// is done with us, the upstream is unreachable, or we've hit
		// the action-pipeline deadline.
		if errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return last, attempts
		}
		// No backoff after the final attempt.
		if i == maxRetries {
			break
		}
		delay := time.Duration(backoff) * time.Second
		for j := 0; j < i; j++ {
			delay *= 2
		}
		if delay > 60*time.Second {
			delay = 60 * time.Second
		}
		select {
		case <-ctx.Done():
			return last, attempts
		case <-time.After(delay):
			// retry
		}
	}
	return last, attempts
}

// executeOneRich is the executeOne sibling that captures HTTP-level
// detail (status code + response-body snippet) for the rich run-row.
// Kinds without an upstream HTTP call (tag, store_only) report
// httpStatus=0 + snippet="".
//
// Phase-0 (p0-inbound-routes-double-emit): for the webhook kind this
// now calls doWebhook directly and lifts its (status, snippet, err)
// triple into a runResult — there is exactly ONE HTTP POST per
// invocation. Previously the path was
// executeOneRich -> doWebhookRich -> doWebhookWithCapture
// -> doWebhookEmitWithResp -> doWebhook, with the inner helper
// capable of re-entering doWebhook a second time on the same attempt
// — combined with the retry budget that meant a single match could
// emit a webhook up to 2× the intended count.
func (a *ActionDeps) executeOneRich(
	ctx context.Context,
	tenantID string,
	route Route,
	act RouteAction,
	email Email,
	inboundEmailID int64,
) runResult {
	switch act.Kind {
	case "tag":
		return runResult{err: a.doTag(ctx, tenantID, act, inboundEmailID)}
	case "store_only":
		return runResult{}
	case "webhook":
		status, snippet, err := a.doWebhook(ctx, tenantID, route, act, email, inboundEmailID)
		return runResult{httpStatus: status, responseSnippet: snippet, err: err}
	case "automation_trigger":
		return runResult{err: a.doAutomationTrigger(ctx, tenantID, route, act, email)}
	case "forward":
		return runResult{err: a.doForward(ctx, tenantID, route, act, email)}
	}
	return runResult{err: errors.New("unknown action kind: " + act.Kind)}
}

// readSnippet reads up to N bytes from an HTTP response body without
// consuming the rest (we don't need it). Used to capture a small,
// debuggable slice of what the upstream replied for the run-row.
const responseSnippetBytes = 512

func readSnippet(body io.ReadCloser) string {
	if body == nil {
		return ""
	}
	defer func() { _ = body.Close() }()
	buf := make([]byte, responseSnippetBytes)
	n, _ := io.ReadFull(io.LimitReader(body, responseSnippetBytes), buf)
	if n <= 0 {
		return ""
	}
	return string(buf[:n])
}

// recordActionRun writes one row to inbound_route_action_runs. Best-
// effort: failures are logged + swallowed so the action pipeline
// doesn't fail because the audit table had a transient hiccup.
//
// Status mapping:
//   - nil err              → "succeeded"
//   - errors.Is(ctx.Err()) → "skipped"  (we never tried, or cancelled mid-flight)
//   - else                 → "failed"
func (a *ActionDeps) recordActionRun(
	ctx context.Context,
	tenantID string,
	route Route,
	actionIndex int,
	matchID int64,
	kind string,
	attempts int,
	res runResult,
	duration time.Duration,
) {
	if a.Pool == nil {
		return
	}
	status := "succeeded"
	var errMsg string
	if res.err != nil {
		status = "failed"
		errMsg = res.err.Error()
		if errors.Is(res.err, context.Canceled) ||
			errors.Is(res.err, context.DeadlineExceeded) {
			status = "skipped"
		}
	}
	// Use background context so audit writes survive caller cancellation.
	bg, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tx, err := db.WithTenant(bg, a.Pool, tenantID)
	if err != nil {
		a.log("record_action_run: tx", "err", err.Error())
		return
	}
	defer func() { _ = tx.Rollback(bg) }()
	// match_id may legitimately be 0 (caller didn't have a match id
	// to thread through — e.g. legacy callers); NULL it out so the
	// FK-soft column reads NULL instead of pretending to point at
	// match-with-id-zero.
	var matchIDArg any
	if matchID > 0 {
		matchIDArg = matchID
	}
	var httpStatusArg any
	if res.httpStatus > 0 {
		httpStatusArg = res.httpStatus
	}
	var snippetArg any
	if res.responseSnippet != "" {
		snippetArg = res.responseSnippet
	}
	var errMsgArg any
	if errMsg != "" {
		errMsgArg = errMsg
	}
	_, err = tx.Exec(bg, `
INSERT INTO inbound_route_action_runs
    (tenant_id, route_id, match_id, action_index, action_kind,
     status, attempts, http_status, response_snippet, error_message, duration_ms)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5,
     $6, $7, $8, $9, $10, $11)`,
		tenantID, route.ID, matchIDArg, actionIndex, kind,
		status, attempts, httpStatusArg, snippetArg, errMsgArg,
		duration.Milliseconds())
	if err != nil {
		a.log("record_action_run: insert", "err", err.Error())
		return
	}
	_ = tx.Commit(bg)
	// Prometheus counter — declared in observability/tier1_metrics.go
	// but never actually incremented in v1 (the audit caught this).
	// Now fires once per action attempt with (route_id, kind) labels.
	observability.InboundRouteMatchesTotal.WithLabelValues(route.ID, kind).Inc()
}

// log is the shared best-effort logger. Re-declared here so callers
// in this file don't have to import slog.
var _ = slog.LevelInfo

// ActionRun is one row from inbound_route_action_runs, surfaced to
// the UI via GET /api/v1/inbound-routes/matches/{match_id}/runs.
// Drives the per-match "what each action did" drilldown that closes
// the v1 audit's #1 PM complaint.
type ActionRun struct {
	ID              int64     `json:"id"`
	RouteID         string    `json:"route_id"`
	MatchID         *int64    `json:"match_id,omitempty"`
	ActionIndex     int       `json:"action_index"`
	ActionKind      string    `json:"action_kind"`
	Status          string    `json:"status"`
	Attempts        int       `json:"attempts"`
	HTTPStatus      *int      `json:"http_status,omitempty"`
	ResponseSnippet string    `json:"response_snippet,omitempty"`
	ErrorMessage    string    `json:"error_message,omitempty"`
	DurationMs      int       `json:"duration_ms"`
	ExecutedAt      time.Time `json:"executed_at"`
}

// ListActionRuns handles GET /api/v1/inbound-routes/matches/{match_id}/runs.
// Returns every action run row keyed to a single match in
// action_index order — the UI renders one card per action with
// status / http_status / error_message / response_snippet visible.
func (d *Deps) ListActionRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	matchIDStr := chi.URLParam(r, "match_id")
	matchID, err := strconv.ParseInt(matchIDStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_match_id", "match_id must be an integer"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id, route_id::text, match_id, action_index, action_kind,
       status, attempts, http_status,
       COALESCE(response_snippet, ''),
       COALESCE(error_message, ''),
       duration_ms, executed_at
  FROM inbound_route_action_runs
 WHERE tenant_id = $1::uuid AND match_id = $2
 ORDER BY action_index ASC, id ASC`, t.ID, matchID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []ActionRun{}
	for rows.Next() {
		var ar ActionRun
		if err := rows.Scan(&ar.ID, &ar.RouteID, &ar.MatchID, &ar.ActionIndex,
			&ar.ActionKind, &ar.Status, &ar.Attempts, &ar.HTTPStatus,
			&ar.ResponseSnippet, &ar.ErrorMessage, &ar.DurationMs, &ar.ExecutedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, ar)
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": out, "count": len(out)})
}
