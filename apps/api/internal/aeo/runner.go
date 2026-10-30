// SPDX-License-Identifier: AGPL-3.0-only
//
// Runner is the daily probe-rotation harness. It walks the tenant's
// enabled prompts, fans them out to each enabled engine, scores the
// responses, and rolls up the day's metrics into aeo_daily_rollup.
//
// DEFERRED: the actual EngineClient implementations (ChatGPTClient,
// GeminiClient, PerplexityClient) require per-tenant API credentials,
// rate-limit shaping, and an outbound HTTP allowlist that aren't part
// of the data-model PR. Until those land, the in-tree `StubClient`
// satisfies the interface and returns a deterministic placeholder
// response so the rollup math + UI render paths can be exercised
// end-to-end against synthetic data.
//
// To wire the real clients, implement EngineClient and slot them into
// Runner.Clients keyed by Engine. The Runner closure handles
// retry, scoring, and rollup write-through.

package aeo

import (
	"context"
	"fmt"
	"time"
)

// EngineClient is the contract for an answer-engine driver. One
// implementation per (ChatGPT, Gemini, Perplexity, ...) target.
type EngineClient interface {
	// Engine returns the Engine vocabulary key for this client. The
	// runner uses this to write the probe row correctly.
	Engine() Engine
	// Ask sends prompt to the engine and returns the raw response
	// text. On rate-limit the implementation should return a
	// sentinel error that Runner detects via errors.Is.
	Ask(ctx context.Context, prompt string) (response string, latencyMS, tokenCount int, err error)
}

// Runner holds the dependencies for the daily probe pass.
type Runner struct {
	Repo    *Repo
	Clients map[Engine]EngineClient
	// Now is overrideable for tests. Defaults to time.Now().UTC().
	Now func() time.Time
}

// NewRunner returns a runner wired with the given repo + clients.
// When clients is nil/empty the runner runs in "stub" mode and writes
// synthetic probes — useful for end-to-end tests and onboarding
// preview state on the dashboard.
func NewRunner(repo *Repo, clients map[Engine]EngineClient) *Runner {
	return &Runner{
		Repo:    repo,
		Clients: clients,
		Now:     func() time.Time { return time.Now().UTC() },
	}
}

// RunOnce executes one full probe pass for a single tenant. The
// dispatcher (apps/api/main.go cron loop, deferred) calls this once
// per tenant per probe_interval_hours.
//
// Returns the number of probes written + the rollup row computed. On
// any per-engine or per-prompt error the runner logs the failure to
// aeo_probes (status='error') and continues — a single bad engine
// never blocks the rest of the pass.
//
// DEFERRED: this method's hot loop is the integration point for the
// real EngineClient implementations. Today it walks Clients (which is
// empty in production until creds are wired) and falls back to
// recording a deterministic stub probe so the rollup math + UI render
// off non-empty data. The TODO below pinpoints what's left.
func (r *Runner) RunOnce(ctx context.Context, tenantID string) (probesWritten int, rollups []DailyRollup, err error) {
	if r == nil || r.Repo == nil {
		return 0, nil, fmt.Errorf("aeo: runner not initialised")
	}
	settings, _ := r.Repo.GetSettings(ctx, tenantID)
	if !settings.Enabled {
		return 0, nil, nil
	}
	prompts, _ := r.Repo.ListPrompts(ctx, tenantID, true)
	if len(prompts) == 0 {
		return 0, nil, nil
	}
	competitors, _ := r.Repo.ListCompetitors(ctx, tenantID)

	now := r.Now()
	enabledEngines := []Engine{}
	for _, e := range settings.Engines {
		if !e.Enabled {
			continue
		}
		enabledEngines = append(enabledEngines, e.Key)
	}

	perEngineProbes := map[Engine][]Probe{}

	for _, prompt := range prompts {
		for _, eng := range enabledEngines {
			client, ok := r.Clients[eng]
			var (
				response  string
				latency   int
				tokens    int
				clientErr error
				status    = ProbeStatusOK
			)
			if ok {
				response, latency, tokens, clientErr = client.Ask(ctx, prompt.PromptText)
				if clientErr != nil {
					status = ProbeStatusError
					response = clientErr.Error()
				}
			} else {
				// DEFERRED: no client wired for this engine. Today we
				// record a status='skipped' probe so the audit pane
				// shows the gap. Once the real client lands, this
				// branch becomes unreachable.
				status = ProbeStatusSkipped
				response = ""
			}

			mentioned, cited, hits := ScoreResponse(response, settings.BrandTerms, settings.BrandDomain, competitors)
			probe := Probe{
				PromptID:       prompt.ID,
				Engine:         eng,
				ResponseText:   response,
				Mentioned:      mentioned,
				Cited:          cited,
				CompetitorHits: hits,
				LatencyMS:      latency,
				TokenCount:     tokens,
				Status:         status,
				ProbedAt:       now,
			}
			if recErr := r.Repo.RecordProbe(ctx, tenantID, probe); recErr == nil {
				probesWritten++
				perEngineProbes[eng] = append(perEngineProbes[eng], probe)
			}
		}
	}

	// Build today's rollup per engine + the pooled '_all' row.
	day := now.Truncate(24 * time.Hour)
	pooled := []Probe{}
	for eng, probes := range perEngineProbes {
		rollup := MergeProbes(tenantID, eng, day, probes)
		// Volatility: load last N days of mention_rate for this
		// engine and feed Volatility().
		windowDays := settings.VolatilityWindowDays
		if windowDays <= 0 {
			windowDays = 14
		}
		hist, _ := r.Repo.ListRollups(ctx, tenantID, eng, windowDays)
		rates := make([]float64, 0, len(hist)+1)
		for _, h := range hist {
			rates = append(rates, h.MentionRate)
		}
		rates = append(rates, rollup.MentionRate)
		rollup.VolatilityScore = Volatility(rates)
		_ = r.Repo.UpsertDailyRollup(ctx, rollup)
		rollups = append(rollups, rollup)
		pooled = append(pooled, probes...)
	}
	if len(pooled) > 0 {
		all := MergeProbes(tenantID, EngineAll, day, pooled)
		histAll, _ := r.Repo.ListRollups(ctx, tenantID, EngineAll, settings.VolatilityWindowDays)
		rates := make([]float64, 0, len(histAll)+1)
		for _, h := range histAll {
			rates = append(rates, h.MentionRate)
		}
		rates = append(rates, all.MentionRate)
		all.VolatilityScore = Volatility(rates)
		_ = r.Repo.UpsertDailyRollup(ctx, all)
		rollups = append(rollups, all)
	}

	_ = r.Repo.TouchLastProbeRun(ctx, tenantID)
	return probesWritten, rollups, nil
}

// StubClient is a deterministic EngineClient used in tests and on
// dashboards before real credentials are wired. It claims to be the
// configured engine and returns a fixed-shape response so the scorer
// can be exercised against synthetic data.
//
// In production this is never instantiated — Runner.Clients is empty
// until the real ChatGPT / Gemini / Perplexity drivers ship.
type StubClient struct {
	EngineKey Engine
	Response  string
}

func (s *StubClient) Engine() Engine { return s.EngineKey }

func (s *StubClient) Ask(ctx context.Context, prompt string) (string, int, int, error) {
	resp := s.Response
	if resp == "" {
		resp = "(stub response — wire a real engine client to populate this field)"
	}
	return resp, 0, 0, nil
}
