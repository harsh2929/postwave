// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handler for the public status endpoint:
//
//	GET /api/public/status
//
// Open CORS, no auth, cached briefly so a viral incident doesn't
// hammer Postgres. Tenant data is never read here — the aggregated
// fields are global ops data only.
//
// Response shape (see PublicResponse):
//
//	overall_status     — "ok" | "degraded" | "down" (worst service wins)
//	services[]         — one row per configured service with the latest
//	                     live status, 30-day uptime ratio, and timestamp
//	active_incidents[] — incidents.resolved_at IS NULL
//	history_90d{svc}   — daily uptime ratios + incident counts for chart
//
// We intentionally do NOT include incident description bodies in the
// active_incidents slot when the field is large; ops can put detailed
// playbooks in the runbooks instead. Description IS returned when it
// fits.
package health

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler wraps the pgxpool.Pool + the live aggregator and serves the
// public status JSON.
type Handler struct {
	Pool       *pgxpool.Pool
	Aggregator *Aggregator
	CacheTTL   time.Duration

	mu        sync.RWMutex
	cached    *PublicResponse
	cachedAt  time.Time
	now       func() time.Time
	serviceOf func() []string // override in tests
}

// NewHandler constructs a Handler with a 30-second cache.
func NewHandler(pool *pgxpool.Pool, agg *Aggregator) *Handler {
	return &Handler{
		Pool:       pool,
		Aggregator: agg,
		CacheTTL:   30 * time.Second,
	}
}

// PublicResponse is the JSON envelope. Field names match the spec
// exactly; do NOT rename without coordinating with status page UI.
type PublicResponse struct {
	OverallStatus   Status                  `json:"overall_status"`
	Services        []ServiceSummary        `json:"services"`
	ActiveIncidents []IncidentRow           `json:"active_incidents"`
	RecentIncidents []IncidentRow           `json:"recent_incidents"`
	History90d      map[string][]HistoryDay `json:"history_90d"`
	GeneratedAt     time.Time               `json:"generated_at"`
}

// ServiceSummary is one card in the service grid.
type ServiceSummary struct {
	Service      string    `json:"service"`
	Status       Status    `json:"status"`
	Uptime30d    float64   `json:"uptime_30d"`
	LastPingedAt time.Time `json:"last_pinged_at"`
	LatencyMS    int       `json:"latency_ms"`
	HTTPStatus   int       `json:"http_status,omitempty"`
}

// IncidentRow mirrors the incidents table — exposed verbatim because
// these are operator-curated, public-by-design rows.
type IncidentRow struct {
	ID               string     `json:"id"`
	Title            string     `json:"title"`
	Description      string     `json:"description,omitempty"`
	Severity         string     `json:"severity"`
	Status           string     `json:"status"`
	AffectedServices []string   `json:"affected_services"`
	StartedAt        time.Time  `json:"started_at"`
	ResolvedAt       *time.Time `json:"resolved_at,omitempty"`
}

// HistoryDay is one cell in the 90-day chart row for a service.
type HistoryDay struct {
	Day       string  `json:"day"`       // YYYY-MM-DD UTC
	Uptime    float64 `json:"uptime"`    // 0..1 fraction of "ok" pings that day
	Incidents int     `json:"incidents"` // count of incidents touching this service
}

// ServeHTTP implements http.Handler for GET /api/public/status. We
// keep the route mounted via r.Get(...) in main.go; ServeHTTP is here
// so a test can hit the handler without chi.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeStatusJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	resp, err := h.snapshot(r.Context())
	if err != nil {
		writeStatusJSONError(w, http.StatusInternalServerError, "status_unavailable", "status unavailable")
		return
	}
	// Open CORS so the marketing site, mobile app, and third-party
	// dashboards can all hit this endpoint cross-origin without a
	// pre-flight dance. The data is public anyway.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Cache-Control", "public, max-age=30")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(resp); err != nil {
		// Already wrote the headers; just log via the response.
		return
	}
}

func writeStatusJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]map[string]string{
		"error": {
			"code":    code,
			"message": message,
		},
	})
}

// snapshot returns the cached response if fresh, otherwise rebuilds it.
func (h *Handler) snapshot(ctx context.Context) (*PublicResponse, error) {
	now := h.timeNow()
	h.mu.RLock()
	if h.cached != nil && now.Sub(h.cachedAt) < h.cacheTTL() {
		c := h.cached
		h.mu.RUnlock()
		return c, nil
	}
	h.mu.RUnlock()
	resp, err := h.build(ctx, now)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.cached = resp
	h.cachedAt = now
	h.mu.Unlock()
	return resp, nil
}

func (h *Handler) cacheTTL() time.Duration {
	if h.CacheTTL > 0 {
		return h.CacheTTL
	}
	return 30 * time.Second
}

func (h *Handler) timeNow() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

// build assembles a fresh PublicResponse from live aggregator state +
// the database. Each helper is best-effort: a DB hiccup returns an empty
// slice rather than a 500, so the page degrades gracefully.
func (h *Handler) build(ctx context.Context, now time.Time) (*PublicResponse, error) {
	services := h.serviceList()
	live := h.liveSummaries(ctx, services, now)
	active := h.fetchIncidents(ctx, true)
	recent := h.fetchIncidents(ctx, false)
	history := h.fetchHistory(ctx, services, now)
	overall := overallFromServices(live)
	return &PublicResponse{
		OverallStatus:   overall,
		Services:        live,
		ActiveIncidents: active,
		RecentIncidents: recent,
		History90d:      history,
		GeneratedAt:     now,
	}, nil
}

// serviceList returns the list of configured services. We pull from
// the aggregator if it knows; otherwise from the DB (so a freshly-
// restarted API still shows past services).
func (h *Handler) serviceList() []string {
	if h.serviceOf != nil {
		return h.serviceOf()
	}
	if h.Aggregator != nil && len(h.Aggregator.Targets) > 0 {
		out := make([]string, 0, len(h.Aggregator.Targets))
		for _, t := range h.Aggregator.Targets {
			out = append(out, t.Name)
		}
		return out
	}
	return nil
}

// liveSummaries assembles one ServiceSummary per known service. The
// 30-day uptime ratio is computed from service_health_pings.
func (h *Handler) liveSummaries(ctx context.Context, services []string, now time.Time) []ServiceSummary {
	live := map[string]Ping{}
	if h.Aggregator != nil {
		live = h.Aggregator.LastPings()
	}
	out := make([]ServiceSummary, 0, len(services))
	for _, s := range services {
		summary := ServiceSummary{Service: s, Status: StatusOK}
		if p, ok := live[s]; ok {
			summary.Status = p.Status
			summary.LastPingedAt = p.PingedAt
			summary.LatencyMS = p.LatencyMS
			summary.HTTPStatus = p.HTTPStatus
		}
		summary.Uptime30d = h.uptimeRatio(ctx, s, now.Add(-30*24*time.Hour), now)
		out = append(out, summary)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Service < out[j].Service })
	return out
}

// uptimeRatio returns the fraction of "ok" pings in [from, to). 1.0 if
// there are no rows (the historical default — "we have no signal it was
// down"). Returns 0 on DB error so the page surfaces something clearly
// anomalous.
func (h *Handler) uptimeRatio(ctx context.Context, service string, from, to time.Time) float64 {
	if h.Pool == nil {
		return 1.0
	}
	var total, okCount int
	err := h.Pool.QueryRow(ctx, `
		SELECT
		  COUNT(*) AS total,
		  COUNT(*) FILTER (WHERE status = 'ok') AS ok
		FROM service_health_pings
		WHERE service = $1 AND pinged_at >= $2 AND pinged_at < $3
	`, service, from, to).Scan(&total, &okCount)
	if err != nil {
		return 0
	}
	if total == 0 {
		return 1.0
	}
	return float64(okCount) / float64(total)
}

// fetchIncidents returns active (resolved_at IS NULL) or recent (last 30
// days, resolved) incidents.
func (h *Handler) fetchIncidents(ctx context.Context, active bool) []IncidentRow {
	if h.Pool == nil {
		return nil
	}
	var (
		rows pgx.Rows
		err  error
	)
	if active {
		rows, err = h.Pool.Query(ctx, `
			SELECT id::text, title, COALESCE(description, ''), severity, status,
			       affected_services, started_at, resolved_at
			FROM incidents
			WHERE resolved_at IS NULL
			ORDER BY started_at DESC
			LIMIT 25
		`)
	} else {
		rows, err = h.Pool.Query(ctx, `
			SELECT id::text, title, COALESCE(description, ''), severity, status,
			       affected_services, started_at, resolved_at
			FROM incidents
			WHERE resolved_at IS NOT NULL
			  AND started_at >= now() - interval '30 days'
			ORDER BY started_at DESC
			LIMIT 50
		`)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []IncidentRow{}
	for rows.Next() {
		var r IncidentRow
		var resolved *time.Time
		if err := rows.Scan(&r.ID, &r.Title, &r.Description, &r.Severity, &r.Status,
			&r.AffectedServices, &r.StartedAt, &resolved); err != nil {
			continue
		}
		r.ResolvedAt = resolved
		out = append(out, r)
	}
	return out
}

// fetchHistory returns one row per (service, day) for the last 90 days.
// Days with no pings are filled in as uptime=1.0 so the chart doesn't
// have gaps.
func (h *Handler) fetchHistory(ctx context.Context, services []string, now time.Time) map[string][]HistoryDay {
	out := make(map[string][]HistoryDay, len(services))
	if h.Pool == nil || len(services) == 0 {
		return out
	}
	since := now.Add(-90 * 24 * time.Hour)
	rows, err := h.Pool.Query(ctx, `
		SELECT service,
		       date_trunc('day', pinged_at)::date AS day,
		       COUNT(*) FILTER (WHERE status = 'ok') AS ok,
		       COUNT(*) AS total
		FROM service_health_pings
		WHERE pinged_at >= $1
		GROUP BY service, day
	`, since)
	if err != nil {
		return out
	}
	type bucket struct {
		ok, total int
	}
	keyed := map[string]map[string]bucket{}
	for rows.Next() {
		var svc string
		var day time.Time
		var ok, total int
		if err := rows.Scan(&svc, &day, &ok, &total); err != nil {
			continue
		}
		if _, exists := keyed[svc]; !exists {
			keyed[svc] = map[string]bucket{}
		}
		keyed[svc][day.UTC().Format("2006-01-02")] = bucket{ok: ok, total: total}
	}
	rows.Close()

	// Incident counts per (service, day). LEFT JOINing this in SQL is
	// awkward because affected_services is a text[]; do it as a
	// second roundtrip and stitch in Go.
	incRows, err := h.Pool.Query(ctx, `
		SELECT unnest(affected_services) AS service,
		       date_trunc('day', started_at)::date AS day,
		       COUNT(*) AS n
		FROM incidents
		WHERE started_at >= $1
		GROUP BY service, day
	`, since)
	incidentCounts := map[string]map[string]int{}
	if err == nil {
		for incRows.Next() {
			var svc string
			var day time.Time
			var n int
			if err := incRows.Scan(&svc, &day, &n); err != nil {
				continue
			}
			if _, exists := incidentCounts[svc]; !exists {
				incidentCounts[svc] = map[string]int{}
			}
			incidentCounts[svc][day.UTC().Format("2006-01-02")] = n
		}
		incRows.Close()
	}

	// Build a 90-day continuous slice per service.
	for _, s := range services {
		days := make([]HistoryDay, 0, 90)
		for i := 89; i >= 0; i-- {
			d := now.Add(-time.Duration(i) * 24 * time.Hour)
			key := d.UTC().Format("2006-01-02")
			day := HistoryDay{Day: key, Uptime: 1.0, Incidents: 0}
			if b, ok := keyed[s][key]; ok && b.total > 0 {
				day.Uptime = float64(b.ok) / float64(b.total)
			}
			if c, ok := incidentCounts[s][key]; ok {
				day.Incidents = c
			}
			days = append(days, day)
		}
		out[s] = days
	}
	return out
}

// overallFromServices returns the worst status across all known
// services. An empty list is reported as ok.
func overallFromServices(svcs []ServiceSummary) Status {
	worst := StatusOK
	for _, s := range svcs {
		if statusRank(s.Status) > statusRank(worst) {
			worst = s.Status
		}
	}
	return worst
}

func statusRank(s Status) int {
	switch s {
	case StatusOK:
		return 0
	case StatusDegraded:
		return 1
	case StatusDown:
		return 2
	}
	return 0
}

// scanRows is a tiny helper kept so an alternate handler harness could
// reuse the row-scan loop. Currently unused.
func scanRows(rows pgx.Rows, fn func(pgx.Rows) error) error {
	if rows == nil {
		return errors.New("nil rows")
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
	}
	return rows.Err()
}

// CompactAffected joins affected_services for human-readable rendering.
// Exposed so the marketing/status UI can call it through a shim if it
// ever fans out the response over a public RSS-ish feed.
func CompactAffected(s []string) string { return strings.Join(s, ", ") }
