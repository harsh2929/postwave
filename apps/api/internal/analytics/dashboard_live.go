// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

// DashboardLive GET /api/v1/dashboard/live  (text/event-stream)
//
// Streams the same DashboardStats payload that GET /api/v1/dashboard/stats
// returns, on a 2-second cadence, for as long as the client keeps the
// EventSource connection open. The `desktop` shell uses this to drive the
// header LiveDot indicator and refresh the dashboard tiles without the
// 5s polling fallback.
//
// Wire format:
//
//	event: stats
//	data: {"subscribers_total":1234,...}
//
//	:keepalive
//
//	event: stats
//	data: {"subscribers_total":1235,...}
//
// Both authentication styles are accepted (cookie session OR API key, the
// latter via either Authorization header or `?api_key=` query param — the
// query-param fallback is what makes the EventSource case work, since
// browser EventSource has no header support).
//
// Implementation notes:
//   - We call DashboardStatsWithOptions with the same rich 30-day defaults as
//     the snapshot endpoint so a live event can safely replace that snapshot.
//   - Connection caps at 5 minutes to keep idle goroutine count bounded;
//     the desktop shell auto-reconnects via its existing exponential-
//     backoff loop in lib/sse.ts so the cap is invisible to operators.
//   - Heartbeats every 30s are SSE comment lines (`:keepalive\n\n`), which
//     EventSource silently ignores but keep flaky proxies from killing
//     the underlying TCP connection.
type LiveDeps struct {
	Repo *Repo
	// Fetch overrides the stats source. Production callers leave this nil
	// and we fall back to Repo.DashboardStats; tests inject a stub so we
	// don't need a live Postgres pool to exercise the SSE wire format.
	Fetch func(ctx context.Context, tenantID string) (*DashboardStats, error)
	// PollInterval is how often we re-query DashboardStats. Defaults to
	// dashboardLivePollInterval; see that constant for why it is not the
	// per-campaign stream's 2s.
	PollInterval time.Duration
	// HeartbeatInterval is how often we emit `:keepalive\n\n` to keep
	// proxies (Cloudflare, nginx, ALB) from idling-out the connection
	// when the metrics aren't changing.
	HeartbeatInterval time.Duration
	// MaxDuration caps the wall-clock lifetime of a single connection.
	// Open-ended SSE eats one goroutine per client; capping at 5min and
	// letting the client reconnect via lib/sse.ts's backoff keeps the
	// resource footprint predictable. Tests inject a shorter value.
	MaxDuration time.Duration
}

// dashboardLiveCacheSingleton fronts every SSE connection's per-tick
// stats fetch with a 2s TTL singleflight cache. One process-wide
// instance so the singleflight actually collapses concurrent callers
// across every open EventSource for the same tenant (a per-handler
// cache would defeat the purpose — each connection would get its own
// LRU and they'd never share a hit).
var dashboardLiveCacheSingleton = newDashboardLiveCache()

// DashboardLive is the http.HandlerFunc factory mounted by main.go. It
// closes over the Repo and the polling/heartbeat tunables so callers
// don't have to construct a LiveDeps just to wire one route.
func DashboardLive(pool *db.Pool) http.HandlerFunc {
	deps := &LiveDeps{Repo: &Repo{Pool: pool}}
	return deps.Handle
}

// Handle is the actual handler. Exported so tests can hit it via a
// custom LiveDeps with a tighter MaxDuration / PollInterval.
func (d *LiveDeps) Handle(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}

	// A writer chain that cannot flush would hold the connection without
	// ever delivering an event; refuse before committing a 200.
	stream, ok := sse.Open(w)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, errEnv("streaming_unsupported", "this response cannot be streamed"))
		return
	}

	// SSE headers — same set the per-campaign stream uses. Connection:
	// keep-alive is a no-op under HTTP/2+ but cheap to send, and
	// X-Accel-Buffering: no disables nginx's response buffering (which
	// would otherwise hold the body until the response completed).
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	pollInterval := d.PollInterval
	if pollInterval <= 0 {
		pollInterval = dashboardLivePollInterval
	}
	heartbeat := d.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = 30 * time.Second
	}
	maxDur := d.MaxDuration
	if maxDur <= 0 {
		maxDur = 5 * time.Minute
	}
	fetch := d.Fetch
	if fetch == nil {
		// Production path: route through the per-tenant TTL singleflight
		// cache so N concurrent EventSource connections for the same tenant
		// collapse onto a single DashboardStatsWithOptions invocation per
		// window. See dashboard_live_cache.go for the math and trade-offs.
		fetch = func(ctx context.Context, tenantID string) (*DashboardStats, error) {
			return dashboardLiveCacheSingleton.fetch(ctx, tenantID,
				func(ctx context.Context, tid string) (*DashboardStats, error) {
					return d.Repo.DashboardStatsWithOptions(
						ctx,
						tid,
						dashboardLiveStatsOptions(),
					)
				})
		}
	}

	// Send an initial snapshot immediately so the client doesn't have
	// to wait a full PollInterval to populate the dashboard.
	if stats, err := fetch(r.Context(), t.ID); err == nil {
		writeStatsEvent(stream, stats)
		if stream.Flush() != nil {
			return
		}
	} else {
		slog.WarnContext(
			r.Context(),
			"dashboard analytics stream initial snapshot",
			"err",
			err,
		)
		writeAnalyticsStreamFailure(stream)
		_ = stream.Flush()
		return
	}

	pollT := time.NewTicker(pollInterval)
	defer pollT.Stop()
	heartT := time.NewTicker(heartbeat)
	defer heartT.Stop()
	deadline := time.NewTimer(maxDur)
	defer deadline.Stop()

	for {
		select {
		case <-r.Context().Done():
			// Client disconnect or server shutdown — exit cleanly.
			return
		case <-deadline.C:
			// Wall-clock cap reached. Emit a final comment so the client
			// knows we hit the cap (informational only — EventSource will
			// auto-reconnect via the desktop's exponential backoff).
			_ = stream.Sendf(":bye max-duration\n\n")
			return
		case <-heartT.C:
			// A failed write means the client is gone.
			if stream.Sendf(":keepalive\n\n") != nil {
				return
			}
		case <-pollT.C:
			stats, err := fetch(r.Context(), t.ID)
			if err != nil {
				slog.WarnContext(
					r.Context(),
					"dashboard analytics stream refresh",
					"err",
					err,
				)
				writeAnalyticsStreamFailure(stream)
				_ = stream.Flush()
				return
			}
			writeStatsEvent(stream, stats)
			if stream.Flush() != nil {
				return
			}
		}
	}
}

// dashboardLiveStatsOptions is deliberately identical to the rich defaults
// used by GET /api/v1/dashboard/stats. Keeping this explicit prevents the SSE
// stream from replacing a complete snapshot with a legacy payload that omits
// comparison, sparkline, or anomaly evidence.
func dashboardLiveStatsOptions() DashboardStatsOptions {
	return DashboardStatsOptions{
		Range:      "30d",
		Compare:    true,
		Sparklines: true,
	}
}

// writeStatsEvent emits one `event: stats` block with a JSON-encoded
// DashboardStats payload. Format matches what the desktop EventSource
// listener parses (`onSnapshot` handler in lib/sse.ts is wired to
// `eventNames: ["snapshot", "delta", "message"]`; we use `stats` here
// per the task spec — frontend will need to add `stats` to its event
// list when it's ready to consume the live stream).
func writeStatsEvent(w io.Writer, stats *DashboardStats) {
	body, err := json.Marshal(stats)
	if err != nil {
		// Marshal of a known-flat struct should never fail. If it does,
		// drop the event — surfacing a marshal error mid-stream isn't
		// useful, and the caller has no way to recover.
		return
	}
	_, _ = fmt.Fprintf(w, "event: stats\ndata: %s\n\n", body)
}
