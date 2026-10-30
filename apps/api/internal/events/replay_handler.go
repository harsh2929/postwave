// SPDX-License-Identifier: AGPL-3.0-only
//
// replay_handler.go — paginated cursor replay over the persistent
// event_log table. Used by SDK consumers that disconnected mid-stream
// and want to pick up where they left off.
//
//   GET /api/v1/events/replay?since=<cursor>&topics=campaign.*&limit=200
//   GET /api/v1/events/replay?since_at=<RFC3339>&topics=...   (stream resume)
//
// Two cursor modes over one page shape:
//
//   since     — sequence cursor, for a consumer paginating a backlog.
//   since_at  — TIME cursor, for a client resuming a dropped SSE connection.
//               The live payload carries `at` but no sequence_id, because
//               LogWriter.OnPublish is a best-effort hook whose failures are
//               deliberately swallowed so the log cannot take the stream down
//               with it. A streaming client therefore has no sequence to
//               resume from, only a timestamp.
//
// Time replay is INCLUSIVE and therefore at-least-once. Every consumer of this
// stream is cache invalidation, which is idempotent: a duplicate costs one
// redundant refetch, a miss costs permanently stale data.
//
// NOTE: an earlier version of this comment claimed the SSE handler honours
// ?since and drains the log before tailing. It does not — `handler.go` has no
// `since` handling at all. Gap recovery is this endpoint's job.

package events

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// replayMaxClockSkew bounds how far ahead of the server a client's `since_at`
// may be before it is refused. A skewed clock that asks for the future would
// otherwise get an empty page every time and never notice it had gone blind.
const replayMaxClockSkew = 5 * time.Minute

// ReplayHandler is the chi handler factory.
type ReplayHandler struct {
	Replay *LogReplay
}

// NewReplayHandler constructs a ReplayHandler.
func NewReplayHandler(r *LogReplay) *ReplayHandler {
	return &ReplayHandler{Replay: r}
}

// ServeHTTP implements http.Handler. Mounted under
// /api/v1/events/replay in main.go.
func (h *ReplayHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeReplayErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	q := r.URL.Query()
	since, err := parseReplaySince(q.Get("since"))
	if err != nil {
		writeReplayErr(w, http.StatusBadRequest, "invalid_since",
			"since must be a non-negative integer cursor")
		return
	}
	var sinceAt time.Time
	if raw := strings.TrimSpace(q.Get("since_at")); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeReplayErr(w, http.StatusBadRequest, "invalid_since_at",
				"since_at must be an RFC 3339 timestamp")
			return
		}
		// A future timestamp would silently return nothing forever. Reject it
		// rather than let a client with a skewed clock go permanently blind.
		if parsed.After(time.Now().Add(replayMaxClockSkew)) {
			writeReplayErr(w, http.StatusBadRequest, "since_at_in_future",
				"since_at is further ahead than the allowed clock skew")
			return
		}
		sinceAt = parsed
	}
	limit := 200
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	// Replay MUST use the same filter grammar and bounds as the live stream.
	// This path previously split the CSV with no validation and no cap, so a
	// filter the live stream rejects was accepted here (and vice versa) — the
	// same request replayed and streamed could return different event sets, and
	// an unbounded list reached the store. parseTopics applies the shared
	// grammar, the per-entry and CSV byte caps, the count cap, and substitutes
	// the no-match sentinel for input that is entirely invalid.
	var topics []string
	if raw := strings.TrimSpace(q.Get("topics")); raw != "" {
		topics = parseTopics(raw)
	}
	page, err := h.Replay.ReadPageSince(r.Context(), tenant.ID, since, sinceAt, topics, limit)
	if err != nil {
		writeReplayErr(w, http.StatusInternalServerError, "replay_failed", "an internal error occurred")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(
		replayResponseBody(page, since, sinceAt, replayWireEvents(tenant.ID, page.Events)),
	)
}

// parseReplaySince reads the sequence cursor.
//
// The error used to be discarded, so `?since=abc` meant 0 — and 0 in sequence
// mode is `sequence_id > 0`, the entire retained log. A typo silently became
// the most expensive query this endpoint can serve. A NEGATIVE value still
// clamps to 0 rather than erroring: it is a well-formed cursor that simply
// predates the log, which is what "from the beginning" means.
func parseReplaySince(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	if n < 0 {
		return 0, nil
	}
	return n, nil
}

// replayResponseBody shapes one page. Split out from ServeHTTP because the
// cursor rules below are the whole contract and the handler needs a live
// database to reach.
func replayResponseBody(page ReplayPage, since int64, sinceAt time.Time, events []map[string]any) map[string]any {
	if events == nil {
		events = []map[string]any{}
	}
	// The cursor NEVER moves backwards, even on a page whose rows were all
	// filtered out: `replayPage` advances past every row examined. Returning
	// the caller's own cursor when a page scanned nothing keeps a client that
	// polls an idle tenant from resetting itself to the start of the log.
	nextCursor := page.NextCursor
	if nextCursor < since {
		nextCursor = since
	}
	nextSinceAt := page.NextSinceAt
	if nextSinceAt.IsZero() {
		nextSinceAt = sinceAt
	}
	body := map[string]any{
		"events": events,
		// The cursor a STREAMING client resumes from. Empty when the caller
		// paginates by sequence and the page scanned nothing.
		"next_since_at": replayTimeString(nextSinceAt),
		"has_more":      page.HasMore,
	}
	// EXPLICIT null, never 0. In time mode `since` is 0, so the clamp above
	// answered `next_cursor: 0` for every page that scanned nothing — and a
	// client that folds that in resumes from `sequence_id > 0`, the oldest page
	// of the whole log, on every reconnect from then on. There is no sequence
	// cursor to hand back here, and saying so is different from saying zero.
	if nextCursor > 0 {
		body["next_cursor"] = nextCursor
	} else {
		body["next_cursor"] = nil
	}
	return body
}

func writeReplayErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// replayWireEvents renders replay rows in the SAME shape the live SSE stream
// emits (`eventWirePayload`), plus `sequence_id`.
//
// Without this a client needed two parsers: replay returned
// `{sequence_id, topic, payload, at}` while the stream emits
// `{topic, event_type, tenant_id, at, ts, payload, …hoisted ids}`. Anything
// that read `event_type` or a hoisted `campaign_id` — which is most of the
// invalidation layer — silently saw undefined on every replayed event, so a
// recovered gap would have been delivered in a shape the recovery path could
// not act on.
func replayWireEvents(tenantID string, events []ReplayEvent) []map[string]any {
	out := make([]map[string]any, 0, len(events))
	for _, ev := range events {
		wire := eventWirePayload(Event{
			Topic:    ev.Topic,
			TenantID: tenantID,
			At:       ev.At,
			Payload:  ev.Payload,
		})
		wire["sequence_id"] = ev.SequenceID
		out = append(out, wire)
	}
	return out
}

func replayTimeString(at time.Time) string {
	if at.IsZero() {
		return ""
	}
	return at.UTC().Format(time.RFC3339Nano)
}
