// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

// CampaignEventsStream GET /api/v1/campaigns/{id}/events  (text/event-stream)
//
// Streams live deltas for one campaign's metrics. The client opens an
// EventSource, leaves it open for as long as they want updates, and
// closes when done. Each `data:` line is a JSON CampaignReport — same
// shape the snapshot endpoint returns, so consumers can use one type.
//
// Implementation: poll campaign_report_events every PollInterval and
// emit a delta event when any count changed. We don't try to be clever
// about computing per-event deltas — re-emitting the full report on
// each tick is dirt-cheap (one COUNT-by-event_type query) and lets
// the client just paint over the latest values.
//
// Why not Postgres LISTEN/NOTIFY: V1 doesn't yet emit NOTIFY from the
// listmonk_events insert path. Adding it later replaces the polling
// loop here without changing the wire format — the protocol is
// already SSE so swapping the producer is a one-file change.
type StreamDeps struct {
	Repo *Repo
	// PollInterval is how often we re-query campaign_report_events.
	// 2s is the sweet spot: fast enough that a watching operator
	// sees the open-spike within a heartbeat, slow enough that the
	// per-tenant query rate doesn't matter at any realistic scale.
	PollInterval time.Duration
	// HeartbeatInterval keeps the connection alive across LB / proxy
	// idle timeouts. EventSource clients automatically reconnect on
	// drop, but a 30-60s gap between meaningful events makes proxies
	// like Cloudflare drop the connection. We send a `: heartbeat`
	// comment line every HeartbeatInterval. SSE comment lines are
	// silently ignored by EventSource — no client-side handling needed.
	HeartbeatInterval time.Duration
}

// CampaignEvents serves the live-metrics SSE stream.
func (d *StreamDeps) CampaignEvents(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "campaign id required"))
		return
	}

	// A writer chain that cannot flush would hold the connection without
	// ever delivering an event; refuse before committing a 200.
	stream, ok := sse.Open(w)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, errEnv("streaming_unsupported", "this response cannot be streamed"))
		return
	}

	// SSE headers. Connection: keep-alive matters when running behind
	// a HTTP/1.1 server; HTTP/2 / HTTP/3 multiplexing makes it a
	// no-op but it's cheap insurance.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// X-Accel-Buffering: no tells nginx not to buffer. Required when
	// Moosewave runs behind nginx — the default is to buffer until the
	// response completes, which would defeat the point of SSE.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	pollInterval := d.PollInterval
	if pollInterval <= 0 {
		pollInterval = 2 * time.Second
	}
	heartbeat := d.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = 30 * time.Second
	}

	pollT := time.NewTicker(pollInterval)
	defer pollT.Stop()
	heartT := time.NewTicker(heartbeat)
	defer heartT.Stop()

	// Send an initial snapshot immediately so the client doesn't have
	// to wait for the first tick to populate the dashboard.
	if rep, err := d.Repo.CampaignReport(r.Context(), t.ID, id); err == nil {
		writeSSEEvent(stream, "snapshot", rep)
		if stream.Flush() != nil {
			return
		}
	} else {
		slog.WarnContext(
			r.Context(),
			"campaign analytics stream initial snapshot",
			"err",
			err,
		)
		writeAnalyticsStreamFailure(stream)
		_ = stream.Flush()
		return
	}

	// Track the most recent snapshot we sent so we can suppress
	// duplicate emissions when nothing changed. Compare on the tuple
	// of count fields — float rates derive from those, no need to
	// compare them separately.
	var last *CampaignReport
	// G18 follow-up: anomaly fingerprint so we only push an `anomaly`
	// event when the detected set changes (re-checked on each delta, since
	// anomalies can only shift when the counts shift).
	var lastAnomalyKey string

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartT.C:
			// SSE comment lines are valid heartbeats. Ignored by EventSource.
			// A failed write means the client is gone.
			if stream.Sendf(": heartbeat %d\n\n", time.Now().Unix()) != nil {
				return
			}
		case <-pollT.C:
			rep, err := d.Repo.CampaignReport(r.Context(), t.ID, id)
			if err != nil {
				slog.WarnContext(
					r.Context(),
					"campaign analytics stream refresh",
					"err",
					err,
				)
				writeAnalyticsStreamFailure(stream)
				_ = stream.Flush()
				return
			}
			if last != nil && reportsEqual(last, rep) {
				continue
			}
			writeSSEEvent(stream, "delta", rep)
			if stream.Flush() != nil {
				return
			}
			last = rep
			// Re-detect anomalies on the fresh counts; emit + persist only
			// when the set changed. Best-effort — failures don't break the
			// delta stream.
			ts, terr := d.Repo.CampaignTimeseries(r.Context(), t.ID, id)
			if terr != nil {
				slog.WarnContext(r.Context(), "campaign anomaly stream timeseries", "err", terr)
				continue
			}
			anomalies := detectCampaignAnomalies(ts.Buckets)
			if key := anomalyFingerprint(anomalies); key != lastAnomalyKey {
				lastAnomalyKey = key
				if len(anomalies) > 0 {
					if err := d.Repo.RecordCampaignAnomalies(r.Context(), t.ID, id, anomalies); err != nil {
						slog.WarnContext(r.Context(), "persist campaign stream anomalies", "err", err)
					}
					writeSSEEvent(stream, "anomaly", CampaignAnomaliesResult{
						CampaignID:  id,
						Anomalies:   anomalies,
						From:        ts.From,
						To:          ts.To,
						AsOf:        ts.AsOf,
						TimeZone:    ts.TimeZone,
						Granularity: ts.Granularity,
						Truncated:   ts.Truncated,
					})
					if stream.Flush() != nil {
						return
					}
				}
			}
		}
	}
}

// anomalyFingerprint is a cheap change key for the anomaly set so the SSE
// loop suppresses duplicate emissions.
func anomalyFingerprint(anomalies []CampaignAnomaly) string {
	var b strings.Builder
	for _, a := range anomalies {
		b.WriteString(a.Metric)
		b.WriteByte('@')
		b.WriteString(a.Hour)
		b.WriteByte('=')
		b.WriteString(a.Direction)
		b.WriteByte(';')
	}
	return b.String()
}

// writeSSEEvent emits one SSE event with a type + JSON-encoded data.
// Format:
//
//	event: snapshot|delta|error
//	data: {...json...}
//	<blank line>
//
// We don't include `id:` (event id) in V1 because we don't support
// reconnection-with-resume yet. EventSource will auto-reconnect on
// drop and re-receive the snapshot from the initial send loop.
func writeSSEEvent(w io.Writer, event string, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		// Fail silently — we can't surface a marshal error to the
		// stream without recursion. Drop the event.
		return
	}
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, body)
}

func writeAnalyticsStreamFailure(w io.Writer) {
	writeSSEEvent(w, "error", map[string]string{
		"code":    "analytics_stream_unavailable",
		"message": "Live analytics could not be refreshed. Reconnect to retry.",
	})
}

// reportsEqual returns true when the integer counts on two reports
// match. Rates are derived from counts so comparing them adds no
// information, and float comparison adds NaN headaches.
func reportsEqual(a, b *CampaignReport) bool {
	if a == nil || b == nil {
		return false
	}
	return a.Sent == b.Sent &&
		a.Delivered == b.Delivered &&
		a.Opens == b.Opens &&
		a.UniqueOpens == b.UniqueOpens &&
		a.Clicks == b.Clicks &&
		a.UniqueClicks == b.UniqueClicks &&
		a.Bounces == b.Bounces &&
		a.Complaints == b.Complaints &&
		a.Unsubscribes == b.Unsubscribes &&
		// G2: gate delta emission on human-count changes too. Without
		// this, the SSE stream would stay quiet when only an MPP-
		// stripped bucket moves and the Raw/Human toggle would show
		// stale numbers until a raw count caught up.
		a.HumanOpens == b.HumanOpens &&
		a.HumanUniqueOpens == b.HumanUniqueOpens &&
		a.HumanClicks == b.HumanClicks &&
		a.HumanUniqueClicks == b.HumanUniqueClicks
}
