// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP surface for the public industry-wide AEO Sensor.
//
// Two halves:
//
//   1. PUBLIC routes (no tenant header required, no API key):
//        GET /api/v1/sensor/aeo/industries
//        GET /api/v1/sensor/aeo/snapshot
//        GET /api/v1/sensor/aeo/series
//        GET /api/v1/sensor/aeo/changelog
//
//   2. TENANT-SCOPED routes (settings, contribute opt-in):
//        GET    /api/v1/sensor/aeo/tenant-industry
//        PUT    /api/v1/sensor/aeo/tenant-industry
//        POST   /api/v1/sensor/aeo/run-now    (admin scope)
//
// The public routes intentionally skip the API-key middleware so the
// Sensor surface stays free + linkable (HubSpot AEO Sensor's gating
// is just an email, ours is none — the data is anonymized by the
// publisher). MountSensorRoutes registers both.

package aeo

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// SensorDeps is the dependency bundle for the public Sensor HTTP layer.
type SensorDeps struct {
	Repo      *Repo
	Publisher *SensorPublisher
	Logger    *slog.Logger
}

// MountSensorRoutes wires the public + tenant-scoped Sensor endpoints
// onto r. Idempotent; safe to call once at boot.
func MountSensorRoutes(r chi.Router, d *SensorDeps) {
	if d == nil || d.Repo == nil {
		return
	}

	// --- public (no auth) ---
	r.Get("/api/v1/sensor/aeo/industries", d.ListIndustries)
	r.Get("/api/v1/sensor/aeo/snapshot", d.GetPublicSnapshot)
	r.Get("/api/v1/sensor/aeo/series", d.GetPublicSeries)
	r.Get("/api/v1/sensor/aeo/changelog", d.GetChangelog)

	// --- tenant-scoped (settings + opt-in) ---
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)

	r.With(read).Get("/api/v1/sensor/aeo/tenant-industry", d.GetTenantIndustry)
	r.With(admin).Put("/api/v1/sensor/aeo/tenant-industry", d.PutTenantIndustry)
	r.With(admin).Post("/api/v1/sensor/aeo/run-now", d.RunNow)
}

// --- public handlers ---------------------------------------------------

// writeRuntimeStubResponse returns a 503 with a structured envelope
// that the marketing site / public consumers can render as "the
// Sensor is not yet live in this environment". Used by every public
// endpoint while SensorRuntime() != "ready" so we never serve a
// suppressed / zero-rate envelope that consumers would
// mis-interpret as "the industry exists, the data is just empty".
func writeRuntimeStubResponse(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error":          "sensor_not_ready",
		"runtime_status": SensorRuntime(),
		"message":        "Public AEO Sensor is not yet live in this deployment — per-tenant rollup pull is in stub mode. See internal/aeo/MIGRATION.md DEFERRED #1.",
	})
}

func (d *SensorDeps) ListIndustries(w http.ResponseWriter, r *http.Request) {
	if !SensorRuntimeIsReady() {
		writeRuntimeStubResponse(w)
		return
	}
	industries, err := d.Repo.ListIndustries(r.Context())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": industries})
}

// GetPublicSnapshot returns the headline tile pack for a single
// industry (or pooled across industries when ?industry= is omitted).
// Applies the MinContributors k-anonymity floor before returning.
func (d *SensorDeps) GetPublicSnapshot(w http.ResponseWriter, r *http.Request) {
	if !SensorRuntimeIsReady() {
		writeRuntimeStubResponse(w)
		return
	}
	industry := strings.TrimSpace(r.URL.Query().Get("industry"))

	// 1 day of data is enough for the snapshot; the series endpoint
	// is the one that returns the full 30-day history.
	rollups, err := d.Repo.ListSensorIndustryRollups(r.Context(), industry, "", 1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	snap := SensorPublicSnapshot{
		IndustrySlug: industry,
		PerEngine:    []SensorIndustryRollup{},
	}

	// Filter out k-anon suppressed rows.
	visible := []SensorIndustryRollup{}
	suppressedCount := 0
	for _, rl := range rollups {
		if rl.SuppressedByKAnon() {
			suppressedCount++
			continue
		}
		visible = append(visible, rl)
	}

	if len(visible) == 0 {
		snap.Suppressed = true
		if suppressedCount > 0 {
			snap.SuppressionReason = "Insufficient contributors for this industry — public Sensor requires at least 5 contributing brands per industry per engine."
		} else {
			snap.SuppressionReason = "No published rollups yet for this industry. The daily publisher runs every 24h."
		}
		writeJSON(w, http.StatusOK, snap)
		return
	}

	// Headline figures from the pooled '_all' row when present.
	for _, rl := range visible {
		if rl.Engine == EngineAll {
			snap.OverallMentionRate = rl.MentionRate
			snap.OverallCitationRate = rl.CitationRate
			snap.OverallVolatility = rl.VolatilityScore
			snap.GeneratedAt = rl.ComputedAt
			continue
		}
		snap.PerEngine = append(snap.PerEngine, rl)
	}

	writeJSON(w, http.StatusOK, snap)
}

// GetPublicSeries returns the fever-chart series for the public
// Sensor — the (industry, engine, day) rollups over the last N days.
// k-anon suppression applies per-row.
func (d *SensorDeps) GetPublicSeries(w http.ResponseWriter, r *http.Request) {
	if !SensorRuntimeIsReady() {
		writeRuntimeStubResponse(w)
		return
	}
	industry := strings.TrimSpace(r.URL.Query().Get("industry"))
	engine := Engine(strings.TrimSpace(r.URL.Query().Get("engine")))
	days := queryInt(r, "days", 30)

	rollups, err := d.Repo.ListSensorIndustryRollups(r.Context(), industry, engine, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	visible := make([]SensorIndustryRollup, 0, len(rollups))
	suppressed := 0
	for _, rl := range rollups {
		if rl.SuppressedByKAnon() {
			suppressed++
			continue
		}
		visible = append(visible, rl)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items":            visible,
		"suppressed_count": suppressed,
		"min_contributors": MinContributors,
	})
}

func (d *SensorDeps) GetChangelog(w http.ResponseWriter, r *http.Request) {
	if !SensorRuntimeIsReady() {
		writeRuntimeStubResponse(w)
		return
	}
	limit := queryInt(r, "limit", 50)
	items, err := d.Repo.ListSensorChangelog(r.Context(), limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// --- tenant-scoped handlers --------------------------------------------

func (d *SensorDeps) GetTenantIndustry(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	ti, err := d.Repo.GetTenantIndustry(r.Context(), tenantID)
	if err != nil {
		// Default-on-miss: render an unset row so the settings UI
		// has something to bind to.
		writeJSON(w, http.StatusOK, TenantIndustry{TenantID: tenantID})
		return
	}
	writeJSON(w, http.StatusOK, ti)
}

func (d *SensorDeps) PutTenantIndustry(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var ti TenantIndustry
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &ti); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.UpsertTenantIndustry(r.Context(), tenantID, ti)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RunNow is the operator kick of the daily publish cycle. Admin-only.
func (d *SensorDeps) RunNow(w http.ResponseWriter, r *http.Request) {
	if d.Publisher == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "publisher_unavailable", "sensor publisher not wired in this deployment")
		return
	}
	stats, err := d.Publisher.PublishOnce(r.Context())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// --- helpers -----------------------------------------------------------

func queryInt(r *http.Request, key string, fallback int) int {
	// Reuses the same parsing as the per-tenant intParam helper but
	// kept local so the two HTTP files don't have to share state.
	v := strings.TrimSpace(r.URL.Query().Get(key))
	if v == "" {
		return fallback
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int(c-'0')
		if n > 1000000 {
			return fallback
		}
	}
	if n <= 0 {
		return fallback
	}
	if n > 365 {
		n = 365
	}
	return n
}
