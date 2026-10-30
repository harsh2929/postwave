package status

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler serves the public status endpoint. It maintains a 60-second cached
// view assembled from (a) live health probes (the most recent ring entry
// from the poller) and (b) historic rows from service_health + incidents.
type Handler struct {
	Pool    *pgxpool.Pool
	Targets ServiceTargets

	mu       sync.RWMutex
	cached   *PublicResponse
	cachedAt time.Time
	cacheTTL time.Duration

	// live is the most recent ServiceStatus snapshot per service, written
	// by the poller after each tick.
	live map[string]ServiceStatus
}

// NewHandler constructs a Handler with a 60-second cache TTL.
func NewHandler(pool *pgxpool.Pool, targets ServiceTargets) *Handler {
	return &Handler{
		Pool:     pool,
		Targets:  targets,
		cacheTTL: 60 * time.Second,
		live:     map[string]ServiceStatus{},
	}
}

// SetLive is called by the poller after each tick.
func (h *Handler) SetLive(s ServiceStatus) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.live[s.Name] = s
	h.cached = nil // invalidate
}

// Public is the chi handler for GET /api/v1/status/public.
func (h *Handler) Public(w http.ResponseWriter, r *http.Request) {
	resp := h.snapshot(r.Context())
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = json.NewEncoder(w).Encode(resp)
}

func (h *Handler) snapshot(ctx context.Context) *PublicResponse {
	h.mu.RLock()
	if h.cached != nil && time.Since(h.cachedAt) < h.cacheTTL {
		c := *h.cached
		h.mu.RUnlock()
		return &c
	}
	h.mu.RUnlock()

	h.mu.Lock()
	defer h.mu.Unlock()
	resp := &PublicResponse{
		Services:    make([]ServiceStatus, 0, len(h.Targets.names())),
		Uptime:      map[string][]UptimeDay{},
		GeneratedAt: time.Now().UTC(),
	}
	worst := StatusOperational
	hadStoreErr := false
	for _, n := range h.Targets.names() {
		st, ok := h.live[n]
		if !ok {
			st = ServiceStatus{Name: n, Status: StatusOperational, LastChecked: time.Time{}}
		}
		resp.Services = append(resp.Services, st)
		if rank(st.Status) > rank(worst) {
			worst = st.Status
		}
		days, err := h.loadUptime(ctx, n, 90)
		if err != nil {
			hadStoreErr = true
			slog.Warn("status uptime load failed", "service", n, "err", err.Error())
		}
		if days == nil {
			days = make([]UptimeDay, 0)
		}
		resp.Uptime[n] = days
	}
	resp.Overall = worst
	incidents, err := h.loadIncidents(ctx, 20)
	if err != nil {
		hadStoreErr = true
		slog.Warn("status incidents load failed", "err", err.Error())
	}
	resp.Incidents = incidents
	if resp.Incidents == nil {
		resp.Incidents = make([]Incident, 0)
	}

	if !hadStoreErr {
		h.cached = resp
		h.cachedAt = time.Now()
	}
	c := *resp
	return &c
}

func rank(s OverallStatus) int {
	switch s {
	case StatusOperational:
		return 0
	case StatusDegraded:
		return 1
	case StatusOutage:
		return 2
	}
	return 0
}

func (h *Handler) loadUptime(ctx context.Context, service string, days int) ([]UptimeDay, error) {
	if h.Pool == nil {
		return nil, nil
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days)
	rows, err := h.Pool.Query(ctx, `
		SELECT to_char(day, 'YYYY-MM-DD'), uptime_pct, degraded_minutes, outage_minutes
		  FROM service_health
		 WHERE service = $1 AND day >= $2::date
		 ORDER BY day ASC
	`, service, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]UptimeDay, 0)
	for rows.Next() {
		var d UptimeDay
		if err := rows.Scan(&d.Day, &d.UptimePct, &d.DegradedMinutes, &d.OutageMinutes); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

func (h *Handler) loadIncidents(ctx context.Context, limit int) ([]Incident, error) {
	if h.Pool == nil {
		return nil, nil
	}
	rows, err := h.Pool.Query(ctx, `
		SELECT id::text, title, status, severity, started_at, resolved_at,
		       description, affected_services
		  FROM incidents
		 WHERE published = true
		 ORDER BY started_at DESC
		 LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Incident, 0)
	for rows.Next() {
		var inc Incident
		var desc *string
		if err := rows.Scan(&inc.ID, &inc.Title, &inc.Status, &inc.Severity,
			&inc.StartedAt, &inc.ResolvedAt, &desc, &inc.AffectedServices); err != nil {
			return nil, err
		}
		if desc != nil {
			inc.Description = *desc
		}
		out = append(out, inc)
	}
	return out, nil
}
