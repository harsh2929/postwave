// SPDX-License-Identifier: AGPL-3.0-only
//
// log.go — persistent append-only event log behind the SSE stream.
// Backs cursor-based replay: a consumer that disconnects mid-stream
// can reconnect with ?since=<last_cursor> and the handler will first
// drain everything published since that point before switching to
// live tailing.
//
// Design choices:
//
//   • Postgres bigserial as the cursor. Strictly monotonic per write;
//     handed to the client in the wire format as `sequence_id`.
//   • Append-only + GIN-on-tenant-topic. Reads are always
//     "tenant_id = X AND sequence_id > Y ORDER BY sequence_id ASC".
//   • 7-day retention via a janitor. The log is for replay, not
//     analytics — the warehouse owns long-term storage.
//
// Concurrency: every method opens its own conn-acquire so writers
// don't lock readers.

package events

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// eventLogInsertErrors counts persistent-event-log write failures by stage.
// OnPublish swallows these (live SSE delivery is the primary channel), so this
// counter is the only operator-visible signal that the replay log is unhealthy.
var eventLogInsertErrors = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "pw_event_log_insert_errors_total",
	Help: "Persistent event-log write failures, by stage (acquire|set_config|insert).",
}, []string{"stage"})

// LogWriter wraps the bus to also persist events to event_log. Wire
// at boot via Bus.AddHook(NewLogWriter(pool)) so every Publish() lands
// in Postgres.
type LogWriter struct {
	Pool *pgxpool.Pool
}

// NewLogWriter returns a SubscriberHook that persists Publish events.
func NewLogWriter(pool *pgxpool.Pool) *LogWriter {
	return &LogWriter{Pool: pool}
}

// OnPublish is called for every Publish; persists the event.
//
// We swallow errors here on purpose: the SSE delivery is the primary
// channel (consumers care about real-time more than replay). A
// persistent-log failure that propagated would kill the live stream
// for every subscriber. Operators see persistent-log health via the
// pw_event_log_insert_errors_total counter, incremented per failing stage.
func (w *LogWriter) OnPublish(ctx context.Context, evt Event) {
	if w == nil || w.Pool == nil {
		return
	}
	body, err := json.Marshal(evt.Payload)
	if err != nil {
		return
	}
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		eventLogInsertErrors.WithLabelValues("acquire").Inc()
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO event_log (tenant_id, topic, payload, at)
VALUES ($1::uuid, $2, $3::jsonb, $4)`,
		evt.TenantID, evt.Topic, string(body), evt.At); err != nil {
		eventLogInsertErrors.WithLabelValues("insert").Inc()
		return
	}
	if err := tx.Commit(ctx); err != nil {
		eventLogInsertErrors.WithLabelValues("insert").Inc()
	}
}

// LogReplay surfaces ReadPageSince for the SSE handler's cursor-replay
// path. Used by sse.go when the client opens with ?since=<cursor>.
type LogReplay struct {
	Pool *pgxpool.Pool
}

// NewLogReplay constructs a LogReplay backed by the same pool as the
// LogWriter.
func NewLogReplay(pool *pgxpool.Pool) *LogReplay {
	return &LogReplay{Pool: pool}
}

// replayPage assembles one replay page from the rows a query actually scanned.
//
// The cursor advances past EVERY scanned row, not just the ones that matched
// the caller's topic patterns, and has_more is derived from the scanned count.
// Both matter: filtering happens after the LIMIT, so a page of 200 events with
// no matching topic used to return an empty list, leave the cursor where it
// was, and report has_more=false. A client that trusted that stopped replaying
// and permanently lost every matching event past that page — silent, unbounded
// loss on exactly the busy tenants gap recovery exists for.
func replayPage(scanned []ReplayEvent, patterns []string, limit int) ([]ReplayEvent, int64, bool) {
	out := []ReplayEvent{}
	var cursor int64
	for _, ev := range scanned {
		if ev.SequenceID > cursor {
			cursor = ev.SequenceID
		}
		if !patternMatches(patterns, ev.Topic) {
			continue
		}
		out = append(out, ev)
	}
	return out, cursor, limit > 0 && len(scanned) >= limit
}

// latestScannedAt is the newest `at` over every scanned row.
//
// The live SSE payload carries `at` but NOT sequence_id: LogWriter.OnPublish is
// a best-effort hook whose errors are deliberately swallowed so a log failure
// cannot kill the stream, which means a live event has no sequence id to carry.
// A client that was streaming therefore resumes by TIME, and needs to know how
// far the page reached even when nothing on it matched its topics.
func latestScannedAt(scanned []ReplayEvent) time.Time {
	var latest time.Time
	for _, ev := range scanned {
		if ev.At.After(latest) {
			latest = ev.At
		}
	}
	return latest
}

// ReplayPage is one page of gap recovery.
type ReplayPage struct {
	Events []ReplayEvent
	// NextCursor is the highest sequence_id EXAMINED (not merely returned).
	NextCursor int64
	// NextSinceAt is the newest `at` examined — the cursor a client that was
	// streaming resumes from, because the live payload has no sequence id.
	NextSinceAt time.Time
	HasMore     bool
}

// ReadPageSince reads by sequence cursor. `sinceAt` (zero = unused) reads by
// time instead, which is what a client resuming a dropped SSE connection uses.
//
// Time replay is INCLUSIVE (`at >= sinceAt`) and therefore at-least-once. That
// is deliberate: every consumer of this stream is cache invalidation, which is
// idempotent, so a duplicate costs one redundant refetch while a miss costs
// permanently stale data. Given a choice between the two at a timestamp
// boundary, replay must duplicate.
func (r *LogReplay) ReadPageSince(ctx context.Context, tenantID string, since int64, sinceAt time.Time, topicPatterns []string, limit int) (ReplayPage, error) {
	return r.readPage(ctx, tenantID, since, sinceAt, topicPatterns, limit)
}

func (r *LogReplay) readPage(ctx context.Context, tenantID string, since int64, sinceAt time.Time, topicPatterns []string, limit int) (ReplayPage, error) {
	if r == nil || r.Pool == nil {
		return ReplayPage{}, errors.New("log replay: nil pool")
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return ReplayPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Use parameter binding rather than fmt.Sprintf so we (a) match
	// every other call site in the repo, (b) keep prepared-statement
	// reuse, and (c) eliminate the foot-gun where a future edit to
	// sanitizeUUID reintroduces an injection vector.
	// Two cursor modes over the same page shape. A caller that was STREAMING
	// resumes by time (the live payload has no sequence id); a caller
	// paginating through a backlog continues by sequence.
	var rows pgx.Rows
	if !sinceAt.IsZero() {
		rows, err = tx.Query(ctx, `
SELECT sequence_id, topic, payload, at
  FROM event_log
 WHERE tenant_id = $1::uuid
   AND at >= $2
 ORDER BY at ASC, sequence_id ASC
 LIMIT $3`, tenantID, sinceAt, limit)
	} else {
		rows, err = tx.Query(ctx, `
SELECT sequence_id, topic, payload, at
  FROM event_log
 WHERE tenant_id = $1::uuid
   AND sequence_id > $2
 ORDER BY sequence_id ASC
 LIMIT $3`, tenantID, since, limit)
	}
	if err != nil {
		return ReplayPage{}, err
	}
	defer rows.Close()
	scanned := []ReplayEvent{}
	for rows.Next() {
		var ev ReplayEvent
		var raw []byte
		if err := rows.Scan(&ev.SequenceID, &ev.Topic, &raw, &ev.At); err != nil {
			return ReplayPage{}, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &ev.Payload)
		}
		scanned = append(scanned, ev)
	}
	if err := rows.Err(); err != nil {
		return ReplayPage{}, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return ReplayPage{}, err
	}
	events, cursor, hasMore := replayPage(scanned, topicPatterns, limit)
	return ReplayPage{
		Events:      events,
		NextCursor:  cursor,
		NextSinceAt: latestScannedAt(scanned),
		HasMore:     hasMore,
	}, nil
}

// ReplayEvent is the wire-shape returned by ReadPageSince. Adds
// sequence_id to the standard Event shape so the consumer can pin
// their cursor for next reconnect.
type ReplayEvent struct {
	SequenceID int64          `json:"sequence_id"`
	Topic      string         `json:"topic"`
	Payload    map[string]any `json:"payload,omitempty"`
	At         time.Time      `json:"at"`
}

// PruneOlderThan deletes log rows older than maxAge. Returns the
// number of rows removed.
func (r *LogReplay) PruneOlderThan(ctx context.Context, maxAge time.Duration) (int64, error) {
	if r == nil || r.Pool == nil {
		return 0, errors.New("log replay: nil pool")
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := time.Now().UTC().Add(-maxAge)
	tag, err := tx.Exec(ctx, `DELETE FROM event_log WHERE at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// patternMatches reports whether topic matches any of patterns. Empty
// patterns means "match everything" (the SSE subscriber's default).
//
// Glob support: exact match, prefix-then-wildcard ("campaign.*"), or
// pure "*". Same dialect the live bus uses; duplicated here so the
// log package doesn't import bus.go's unexported helpers.
func patternMatches(patterns []string, topic string) bool {
	if len(patterns) == 0 {
		return true
	}
	for _, p := range patterns {
		if p == "*" || p == topic {
			return true
		}
		if len(p) > 2 && p[len(p)-2:] == ".*" {
			prefix := p[:len(p)-1] // keep the trailing dot
			if len(topic) >= len(prefix) && topic[:len(prefix)] == prefix {
				return true
			}
		}
	}
	return false
}
