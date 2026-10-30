// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP surface for the AEO Sensor. Mounted from main.go via
// aeo.MountRoutes(r, &aeo.Deps{Repo: ...}).
//
// Routes:
//
//	GET    /api/v1/aeo/settings
//	PUT    /api/v1/aeo/settings
//	GET    /api/v1/aeo/summary       — headline tile pack
//	GET    /api/v1/aeo/rollups       — fever chart series (?engine=&days=)
//	GET    /api/v1/aeo/prompts
//	POST   /api/v1/aeo/prompts
//	POST   /api/v1/aeo/prompts/{id}/toggle
//	DELETE /api/v1/aeo/prompts/{id}
//	GET    /api/v1/aeo/probes        — audit pane (?engine=&prompt_id=&limit=)
//	GET    /api/v1/aeo/competitors
//	PUT    /api/v1/aeo/competitors   — upsert one
//	DELETE /api/v1/aeo/competitors/{key}
//	POST   /api/v1/aeo/run-now       — admin-scope kick of Runner.RunOnce

package aeo

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps is the dependency bundle for the AEO HTTP layer.
type Deps struct {
	Repo   *Repo
	Runner *Runner
	Logger *slog.Logger
}

// MountRoutes wires every AEO endpoint onto r.
func MountRoutes(r chi.Router, d *Deps) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)

	r.With(read).Get("/api/v1/aeo/settings", d.GetSettings)
	r.With(admin).Put("/api/v1/aeo/settings", d.PutSettings)

	r.With(read).Get("/api/v1/aeo/summary", d.GetSummary)
	r.With(read).Get("/api/v1/aeo/rollups", d.ListRollups)

	r.With(read).Get("/api/v1/aeo/prompts", d.ListPrompts)
	r.With(admin).Post("/api/v1/aeo/prompts", d.CreatePrompt)
	r.With(admin).Post("/api/v1/aeo/prompts/{id}/toggle", d.TogglePrompt)
	r.With(admin).Delete("/api/v1/aeo/prompts/{id}", d.DeletePrompt)

	r.With(read).Get("/api/v1/aeo/probes", d.ListProbes)

	r.With(read).Get("/api/v1/aeo/competitors", d.ListCompetitors)
	r.With(admin).Put("/api/v1/aeo/competitors", d.UpsertCompetitor)
	r.With(admin).Delete("/api/v1/aeo/competitors/{key}", d.DeleteCompetitor)

	r.With(admin).Post("/api/v1/aeo/run-now", d.RunNow)
}

// --- settings -------------------------------------------------------

func (d *Deps) GetSettings(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	s, err := d.repo().GetSettings(r.Context(), tenantID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (d *Deps) PutSettings(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var s Settings
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &s); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.repo().UpsertSettings(r.Context(), tenantID, s)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// --- summary --------------------------------------------------------

func (d *Deps) GetSummary(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	settings, _ := d.repo().GetSettings(r.Context(), tenantID)
	rollups, _ := d.repo().ListRollups(r.Context(), tenantID, "", 30)
	competitors, _ := d.repo().ListCompetitors(r.Context(), tenantID)

	summary := SensorSummary{Settings: settings, CompetitorBoard: []CompetitorScore{}, LatestRollups: []DailyRollup{}}
	if len(rollups) == 0 {
		if !settings.Enabled {
			summary.WarningBanner = "AEO Sensor is disabled. Enable it in Settings to start tracking ChatGPT / Gemini / Perplexity citations."
		} else if settings.CredentialsStatus != CredentialsReady {
			summary.WarningBanner = "Add ChatGPT / Gemini / Perplexity credentials to begin probing. The dashboard will populate within 24 hours of the first probe pass."
		} else {
			summary.WarningBanner = "Probes are scheduled but no rollups have landed yet. Check back after the next probe pass."
		}
		writeJSON(w, http.StatusOK, summary)
		return
	}

	// LatestRollups = the most recent row per engine.
	latestByEngine := map[Engine]DailyRollup{}
	for _, rl := range rollups {
		if _, exists := latestByEngine[rl.Engine]; !exists {
			latestByEngine[rl.Engine] = rl
		}
	}
	for _, rl := range latestByEngine {
		summary.LatestRollups = append(summary.LatestRollups, rl)
	}

	// Headline figures come from the pooled '_all' row when present;
	// otherwise from a simple average over the per-engine latest rows.
	if all, ok := latestByEngine[EngineAll]; ok {
		summary.OverallMentionRate = all.MentionRate
		summary.OverallCitationRate = all.CitationRate
		summary.VolatilityScore = all.VolatilityScore
		summary.AIReferralPct = all.AIReferralPct
	} else if len(latestByEngine) > 0 {
		var (
			mSum, cSum, vSum, aSum float64
			n                      float64
		)
		for eng, rl := range latestByEngine {
			if eng == EngineAll {
				continue
			}
			mSum += rl.MentionRate
			cSum += rl.CitationRate
			vSum += rl.VolatilityScore
			aSum += rl.AIReferralPct
			n++
		}
		if n > 0 {
			summary.OverallMentionRate = mSum / n
			summary.OverallCitationRate = cSum / n
			summary.VolatilityScore = vSum / n
			summary.AIReferralPct = aSum / n
		}
	}

	// Competitor board: read the per-engine latest probe sample to
	// score per-competitor mention rates. Lightweight aggregation —
	// the dashboard caps at MaxCompetitors so the loop is bounded.
	probes, _ := d.repo().ListProbes(r.Context(), tenantID, "", "", 200)
	for _, c := range competitors {
		hits := 0
		total := 0
		for _, p := range probes {
			if p.Status != ProbeStatusOK {
				continue
			}
			total++
			if p.CompetitorHits[c.CompetitorKey] > 0 {
				hits++
			}
		}
		rate := 0.0
		if total > 0 {
			rate = float64(hits) / float64(total)
		}
		summary.CompetitorBoard = append(summary.CompetitorBoard, CompetitorScore{
			Key:         c.CompetitorKey,
			DisplayName: c.DisplayName,
			MentionRate: rate,
			Domain:      c.Domain,
		})
	}

	// Low-confidence banner.
	if all, ok := latestByEngine[EngineAll]; ok && all.SampleSize > 0 && all.SampleSize < MinSampleForSignificance {
		summary.WarningBanner = fmt.Sprintf("Low-confidence rollup: only %d probes contributed to today's score. Add more prompts or wait for the next cycle.", all.SampleSize)
	}

	writeJSON(w, http.StatusOK, summary)
}

// --- rollups (fever chart) -----------------------------------------

func (d *Deps) ListRollups(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	engine := Engine(strings.TrimSpace(r.URL.Query().Get("engine")))
	days := intParam(r, "days", 30)
	rollups, err := d.repo().ListRollups(r.Context(), tenantID, engine, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rollups})
}

// --- prompts --------------------------------------------------------

func (d *Deps) ListPrompts(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	enabledOnly := r.URL.Query().Get("enabled_only") == "true"
	prompts, err := d.repo().ListPrompts(r.Context(), tenantID, enabledOnly)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": prompts})
}

func (d *Deps) CreatePrompt(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var p Prompt
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.repo().CreatePrompt(r.Context(), tenantID, p)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) TogglePrompt(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := d.repo().TogglePrompt(r.Context(), tenantID, id, body.Enabled); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) DeletePrompt(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.repo().DeletePrompt(r.Context(), tenantID, id); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- probes ---------------------------------------------------------

func (d *Deps) ListProbes(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	engine := Engine(strings.TrimSpace(r.URL.Query().Get("engine")))
	promptID := strings.TrimSpace(r.URL.Query().Get("prompt_id"))
	limit := intParam(r, "limit", 50)
	probes, err := d.repo().ListProbes(r.Context(), tenantID, engine, promptID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": probes})
}

// --- competitors ----------------------------------------------------

func (d *Deps) ListCompetitors(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	items, err := d.repo().ListCompetitors(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "max": MaxCompetitors})
}

func (d *Deps) UpsertCompetitor(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var c Competitor
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &c); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.repo().UpsertCompetitor(r.Context(), tenantID, c)
	if errors.Is(err, ErrCompetitorCap) {
		httperror.WriteValidation(w, "validation_failed", fmt.Sprintf("max %d competitors per tenant", MaxCompetitors))
		return
	}
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteCompetitor(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	key := chi.URLParam(r, "key")
	if err := d.repo().DeleteCompetitor(r.Context(), tenantID, key); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- run-now (operator kick) ---------------------------------------

func (d *Deps) RunNow(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.Runner == nil {
		// Runner not wired in this binary — return a clear hint
		// instead of a 500 so the UI can render onboarding state.
		httperror.Write(w, http.StatusServiceUnavailable, "runner_unavailable", "AEO runner not yet wired in this deployment; engine credentials missing")
		return
	}
	probes, rollups, err := d.Runner.RunOnce(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"probes":  probes,
		"rollups": rollupsOrEmpty(rollups),
	})
}

// --- helpers --------------------------------------------------------

func (d *Deps) repo() *Repo {
	if d == nil {
		return nil
	}
	return d.Repo
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func intParam(r *http.Request, key string, fallback int) int {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return fallback
	}
	var n int
	if _, err := fmt.Sscanf(value, "%d", &n); err != nil || n <= 0 {
		return fallback
	}
	if n > 500 {
		return 500
	}
	return n
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// errEnv is retained for use by sibling handlers in this package that have
// not yet been migrated to httperror. New code should prefer
// httperror.Write / WriteInternal / WriteValidation directly.
func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

// rollupsOrEmpty keeps run-now's `rollups` a JSON array. RunOnce returns a
// nil slice when AEO is disabled or has no enabled prompt — the state of every
// workspace that has not set it up — and nil marshals to null, which the
// dashboard rejects as a broken run receipt.
func rollupsOrEmpty(rollups []DailyRollup) []DailyRollup {
	if rollups == nil {
		return []DailyRollup{}
	}
	return rollups
}
