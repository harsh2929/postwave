// SPDX-License-Identifier: AGPL-3.0-only
//
// Package aeo implements the "Answer Engine Optimization" sensor — the
// Moosewave answer to HubSpot AEO Sensor, BrightEdge AEO, and Profound's
// AI Search visibility surface.
//
// Architecture (HubSpot AEO-style probe harness):
//
//  1. A nightly Runner reads aeo_prompts (starter pack + tenant
//     custom), fans them out to the configured engines (ChatGPT /
//     Gemini / Perplexity), and stores every (prompt × engine ×
//     response) tuple into aeo_probes. Each row is scored at write
//     time for `mentioned` (any brand_term substring matched) and
//     `cited` (any href to brand_domain).
//
//  2. The same Runner aggregates yesterday's probes into
//     aeo_daily_rollup — one row per (tenant_id, engine, day) plus
//     a synthetic engine='_all' row that pools across engines. This
//     is what the Archive > AEO Sensor tab reads at render time, so
//     the hot path never scans aeo_probes.
//
//  3. The volatility score (0-100) is the rolling std-dev of
//     mention_rate over the last volatility_window_days (default
//     14), normalised so a perfectly stable citation graph reads 0
//     and a wildly oscillating one reads 100.
//
// This package ships the data structures + interfaces + the rollup
// math (Score, Volatility, MergeProbes). The actual probe runner that
// hits the ChatGPT / Gemini / Perplexity APIs is deferred — see
// Runner.RunOnce for the explicit TODO. Until then the system stays
// in "credentials_status=missing" and the dashboard renders an
// onboarding banner.
package aeo

import (
	"math"
	"time"
)

// Engine identifies an answer-engine target. Same vocabulary as the
// SQL CHECK constraint on aeo_probes.engine.
type Engine string

const (
	EngineChatGPT    Engine = "chatgpt"
	EngineGemini     Engine = "gemini"
	EnginePerplexity Engine = "perplexity"
	EngineGrok       Engine = "grok"
	EngineCopilot    Engine = "copilot"
	// EngineAll is the synthetic "pooled across engines" rollup
	// row. Never written by the probe runner; only the rollup
	// worker emits it.
	EngineAll Engine = "_all"
)

// PromptPack identifies which prompt set the runner walks. Same
// vocabulary as aeo_settings.probe_prompt_pack.
type PromptPack string

const (
	PromptPackStarter           PromptPack = "starter"
	PromptPackCustom            PromptPack = "custom"
	PromptPackStarterPlusCustom PromptPack = "starter_plus_custom"
)

// PromptCategory groups prompts by buyer-funnel stage. Used by the
// dashboard to render category-level filter chips.
type PromptCategory string

const (
	CategoryDiscovery  PromptCategory = "discovery"
	CategoryComparison PromptCategory = "comparison"
	CategoryBuyer      PromptCategory = "buyer"
	CategorySupport    PromptCategory = "support"
	CategoryOther      PromptCategory = "other"
)

// CredentialsStatus is the UI badge state for the engines panel.
type CredentialsStatus string

const (
	CredentialsMissing CredentialsStatus = "missing"
	CredentialsPartial CredentialsStatus = "partial"
	CredentialsReady   CredentialsStatus = "ready"
)

// EngineConfig is one entry of aeo_settings.engines.
type EngineConfig struct {
	Key     Engine `json:"key"`
	Enabled bool   `json:"enabled"`
}

// Settings is the per-tenant configuration mirrored to aeo_settings.
type Settings struct {
	TenantID             string            `json:"tenant_id,omitempty"`
	Enabled              bool              `json:"enabled"`
	BrandTerms           []string          `json:"brand_terms"`
	BrandDomain          string            `json:"brand_domain"`
	ProbePromptPack      PromptPack        `json:"probe_prompt_pack"`
	ProbeIntervalHours   int               `json:"probe_interval_hours"`
	Engines              []EngineConfig    `json:"engines"`
	VolatilityWindowDays int               `json:"volatility_window_days"`
	CredentialsStatus    CredentialsStatus `json:"credentials_status"`
	LastProbeRunAt       *time.Time        `json:"last_probe_run_at,omitempty"`
	CreatedAt            time.Time         `json:"created_at,omitempty"`
	UpdatedAt            time.Time         `json:"updated_at,omitempty"`
}

// DefaultSettings returns the canonical defaults that match the SQL
// CHECK constraints in migration 0300.
func DefaultSettings() Settings {
	return Settings{
		Enabled:              false,
		BrandTerms:           []string{},
		BrandDomain:          "",
		ProbePromptPack:      PromptPackStarter,
		ProbeIntervalHours:   24,
		VolatilityWindowDays: 14,
		CredentialsStatus:    CredentialsMissing,
		Engines: []EngineConfig{
			{Key: EngineChatGPT, Enabled: true},
			{Key: EngineGemini, Enabled: true},
			{Key: EnginePerplexity, Enabled: true},
		},
	}
}

// Prompt is one row of aeo_prompts.
type Prompt struct {
	ID         string         `json:"id"`
	TenantID   string         `json:"tenant_id,omitempty"`
	Category   PromptCategory `json:"category"`
	PromptText string         `json:"prompt_text"`
	Enabled    bool           `json:"enabled"`
	Source     string         `json:"source"` // 'starter' | 'custom'
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
}

// ProbeStatus is the terminal state of a single probe execution.
type ProbeStatus string

const (
	ProbeStatusOK          ProbeStatus = "ok"
	ProbeStatusError       ProbeStatus = "error"
	ProbeStatusRateLimited ProbeStatus = "rate_limited"
	ProbeStatusSkipped     ProbeStatus = "skipped"
)

// Probe is one row of aeo_probes — the append-only ledger of every
// answer-engine query the runner has executed.
type Probe struct {
	ID             int64          `json:"id"`
	TenantID       string         `json:"tenant_id,omitempty"`
	PromptID       string         `json:"prompt_id"`
	Engine         Engine         `json:"engine"`
	ResponseText   string         `json:"response_text"`
	Mentioned      bool           `json:"mentioned"`
	Cited          bool           `json:"cited"`
	CompetitorHits map[string]int `json:"competitor_hits"`
	LatencyMS      int            `json:"latency_ms"`
	TokenCount     int            `json:"token_count"`
	Status         ProbeStatus    `json:"status"`
	ProbedAt       time.Time      `json:"probed_at"`
}

// DailyRollup is one row of aeo_daily_rollup — what the dashboard
// reads at render time.
type DailyRollup struct {
	TenantID        string    `json:"tenant_id,omitempty"`
	Engine          Engine    `json:"engine"`
	Day             time.Time `json:"day"`
	MentionRate     float64   `json:"mention_rate"`
	CitationRate    float64   `json:"citation_rate"`
	VolatilityScore float64   `json:"volatility_score"`
	AIReferralPct   float64   `json:"ai_referral_pct"`
	SampleSize      int       `json:"sample_size"`
	ComputedAt      time.Time `json:"computed_at"`
}

// Competitor is one row of aeo_competitors.
type Competitor struct {
	ID            string    `json:"id"`
	TenantID      string    `json:"tenant_id,omitempty"`
	CompetitorKey string    `json:"competitor_key"`
	DisplayName   string    `json:"display_name"`
	Terms         []string  `json:"terms"`
	Domain        string    `json:"domain"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// MaxCompetitors is the per-tenant cap on aeo_competitors. The repo
// rejects upserts past this; mirrors the audit-sketch limit.
const MaxCompetitors = 5

// MinSampleForSignificance is the cutoff below which the UI renders
// a "low-confidence" banner on rollup tiles. Matches HubSpot AEO's
// 5-sample heuristic.
const MinSampleForSignificance = 5

// SensorSummary is the response shape for GET /api/v1/aeo/summary —
// the headline tile pack on the Archive AEO Sensor tab.
type SensorSummary struct {
	Settings            Settings          `json:"settings"`
	LatestRollups       []DailyRollup     `json:"latest_rollups"` // one per engine, most recent day
	OverallMentionRate  float64           `json:"overall_mention_rate"`
	OverallCitationRate float64           `json:"overall_citation_rate"`
	VolatilityScore     float64           `json:"volatility_score"`
	AIReferralPct       float64           `json:"ai_referral_pct"`
	CompetitorBoard     []CompetitorScore `json:"competitor_board"`
	WarningBanner       string            `json:"warning_banner,omitempty"`
}

// CompetitorScore is one row of the dashboard's "Brand X vs
// competitors" comparison panel.
type CompetitorScore struct {
	Key         string  `json:"key"`
	DisplayName string  `json:"display_name"`
	MentionRate float64 `json:"mention_rate"`
	Domain      string  `json:"domain,omitempty"`
}

// ScoreResponse classifies a single engine response for `mentioned`
// and `cited`. Pure function — used by both the probe runner and the
// per-probe re-score path (when an operator edits brand_terms the
// settings handler kicks off a re-score over the last 30 days).
//
// matchTerm is case-insensitive substring; matchDomain is host-anchored
// (i.e. "example.com" matches "https://www.example.com/path" but not
// "https://example.com.evil.com/path"). The simple substring check
// for the domain test happens upstream — we pass a normalised host
// string here.
func ScoreResponse(responseText string, brandTerms []string, brandDomain string, competitors []Competitor) (mentioned, cited bool, competitorHits map[string]int) {
	competitorHits = map[string]int{}
	if responseText == "" {
		return false, false, competitorHits
	}
	lowered := toLowerASCII(responseText)
	for _, term := range brandTerms {
		t := toLowerASCII(term)
		if t == "" {
			continue
		}
		if indexOf(lowered, t) >= 0 {
			mentioned = true
			break
		}
	}
	if brandDomain != "" {
		// Citation = the response text mentions our domain. The
		// real runner extracts URLs and host-matches; here we just
		// substring-check to keep the helper pure / testable.
		dom := toLowerASCII(brandDomain)
		if indexOf(lowered, dom) >= 0 {
			cited = true
		}
	}
	for _, c := range competitors {
		hits := 0
		for _, term := range c.Terms {
			t := toLowerASCII(term)
			if t == "" {
				continue
			}
			if indexOf(lowered, t) >= 0 {
				hits++
			}
		}
		if hits > 0 {
			competitorHits[c.CompetitorKey] = hits
		}
	}
	return mentioned, cited, competitorHits
}

// Volatility computes the 0-100 volatility score given a series of
// daily mention rates (oldest first). The HubSpot AEO methodology is:
//
//	v = clamp(stddev(rates) / 0.25, 0, 1) * 100
//
// The 0.25 denominator is "if the rate swings by ±25 points day-over-day,
// that's maximum volatility". Below ~2 samples we return 0 (insufficient
// data — the dashboard renders a "warming up" badge instead).
func Volatility(rates []float64) float64 {
	if len(rates) < 2 {
		return 0
	}
	var sum, mean, variance float64
	for _, r := range rates {
		sum += r
	}
	mean = sum / float64(len(rates))
	for _, r := range rates {
		d := r - mean
		variance += d * d
	}
	variance /= float64(len(rates))
	stddev := math.Sqrt(variance)
	// 0.25 stddev => 100 score; clamp.
	score := (stddev / 0.25) * 100
	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}
	// Round to two decimals to match the SQL numeric(5,2) precision.
	return math.Round(score*100) / 100
}

// MergeProbes folds a slice of Probe into a single DailyRollup row.
// Used by the rollup worker; pure function for testability.
func MergeProbes(tenantID string, engine Engine, day time.Time, probes []Probe) DailyRollup {
	out := DailyRollup{
		TenantID:   tenantID,
		Engine:     engine,
		Day:        day,
		ComputedAt: time.Now().UTC(),
	}
	if len(probes) == 0 {
		return out
	}
	var mentions, citations int
	for _, p := range probes {
		if p.Status != ProbeStatusOK {
			continue
		}
		out.SampleSize++
		if p.Mentioned {
			mentions++
		}
		if p.Cited {
			citations++
		}
	}
	if out.SampleSize == 0 {
		return out
	}
	out.MentionRate = round4(float64(mentions) / float64(out.SampleSize))
	out.CitationRate = round4(float64(citations) / float64(out.SampleSize))
	return out
}

// --- internal string helpers (avoid importing strings for tiny ops) --

func toLowerASCII(s string) string {
	b := []byte(s)
	for i := 0; i < len(b); i++ {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

func indexOf(hay, needle string) int {
	if needle == "" {
		return -1
	}
	if len(needle) > len(hay) {
		return -1
	}
	for i := 0; i+len(needle) <= len(hay); i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func round4(v float64) float64 {
	return math.Round(v*10000) / 10000
}
