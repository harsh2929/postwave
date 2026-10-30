// SPDX-License-Identifier: AGPL-3.0-only
//
// SensorPublisher is the daily cross-tenant aggregator that produces
// the public industry-wide AEO Sensor rollup.
//
// Pipeline:
//
//   1. ListContributingTenantsByIndustry — every opted-in tenant
//      keyed by industry_slug. Runs under app.outbox_worker GUC.
//
//   2. For each (industry, engine, day) bucket, pull the per-tenant
//      DailyRollup row and collect (mention_rate, citation_rate,
//      sample_size). AggregateRows folds these into a single
//      SensorIndustryRollup with contributor_count = N.
//
//   3. Compute volatility over the rolling 14-day window of
//      SensorIndustryRollup.mention_rate (same Volatility() math the
//      per-tenant Runner uses).
//
//   4. UpsertSensorIndustryRollup for the row. AppendSensorChangelog
//      with the per-engine + per-industry summary so the public
//      changelog endpoint can prove the publish ran.
//
// DEFERRED (full ML / integration work — see MIGRATION.md):
//
//   * Real per-tenant daily rollup pull. Today PublishOnce iterates
//     the contributing-tenants list and emits a row with
//     contributor_count derived from that scan; the per-tenant
//     mention/citation pull is left as a clearly-marked TODO so the
//     scaffold compiles cleanly and the public surface returns a
//     deterministic (zero-rate, suppressed-if-low) response.
//
//   * Differential-privacy noise injection on the published series.
//     The k-anonymity floor (MIN_CONTRIBUTORS = 5) is the floor, not
//     the ceiling — privacy review will probably require Laplace
//     noise on top.
//
//   * Multi-day backfill mode. Today PublishOnce computes only
//     "today"; the operator-kick handler (POST /sensor/aeo/run-now)
//     should accept a date range so an outage can be backfilled
//     without holding the daily worker.

package aeo

import (
	"context"
	"fmt"
	"time"
)

// SensorPublisher orchestrates one daily publish cycle.
type SensorPublisher struct {
	Repo *Repo
	// Now is overrideable for tests.
	Now func() time.Time
}

// NewSensorPublisher returns a publisher wired to the given repo.
func NewSensorPublisher(repo *Repo) *SensorPublisher {
	return &SensorPublisher{
		Repo: repo,
		Now:  func() time.Time { return time.Now().UTC() },
	}
}

// PublishStats is the worker's return value for the operator-kick
// handler and for the structured-log line emitted at end-of-cycle.
type PublishStats struct {
	IndustryCount          int            `json:"industry_count"`
	RollupsWritten         int            `json:"rollups_written"`
	Suppressed             int            `json:"suppressed_rows"`
	ContributorsByIndustry map[string]int `json:"contributors_by_industry"`
	GeneratedFor           time.Time      `json:"generated_for"`
}

// PublishOnce runs one cycle of the public-Sensor publish. Idempotent
// per day — the upsert key on aeo_sensor_industry_rollup is
// (industry_slug, engine, day), so re-running for the same day
// overwrites with the latest data.
//
// DEFERRED: the per-tenant rollup pull is a clearly-marked stub
// today. See MIGRATION.md for the full work plan + estimated effort.
func (p *SensorPublisher) PublishOnce(ctx context.Context) (PublishStats, error) {
	if p == nil || p.Repo == nil {
		return PublishStats{}, fmt.Errorf("aeo: sensor publisher not initialised")
	}
	now := p.Now()
	day := now.Truncate(24 * time.Hour)

	contributors, err := p.Repo.ListContributingTenantsByIndustry(ctx)
	if err != nil {
		return PublishStats{}, fmt.Errorf("aeo: list contributors: %w", err)
	}

	byIndustry := map[string][]string{}
	for _, c := range contributors {
		byIndustry[c.IndustrySlug] = append(byIndustry[c.IndustrySlug], c.TenantID)
	}

	stats := PublishStats{
		GeneratedFor:           day,
		ContributorsByIndustry: map[string]int{},
	}

	// The engines we publish per industry. Same vocabulary as the
	// per-tenant probe runner; '_all' is the pooled-across-engines
	// row that the public dashboard renders as the headline tile.
	engines := []Engine{EngineChatGPT, EngineGemini, EnginePerplexity, EngineCopilot, EngineGrok, EngineAll}

	for industry, tenants := range byIndustry {
		stats.IndustryCount++
		stats.ContributorsByIndustry[industry] = len(tenants)

		for _, eng := range engines {
			// DEFERRED: pull each tenant's most recent DailyRollup
			// for (eng, day) here and feed AggregateRows. Today we
			// emit a deterministic zero-rate row so the schema is
			// exercised end-to-end and the public surface returns a
			// well-shaped (suppressed) response when no real data
			// has landed.
			perMention := []float64{}
			perCitation := []float64{}
			perSize := []int{}
			for range tenants {
				perMention = append(perMention, 0)
				perCitation = append(perCitation, 0)
				perSize = append(perSize, 0)
			}

			rollup := AggregateRows(industry, eng, day, perMention, perCitation, perSize)

			// Volatility = rolling stddev of mention_rate over the
			// last 14 published rows for this (industry, engine).
			hist, _ := p.Repo.ListSensorIndustryRollups(ctx, industry, eng, 14)
			rates := make([]float64, 0, len(hist)+1)
			for _, h := range hist {
				rates = append(rates, h.MentionRate)
			}
			rates = append(rates, rollup.MentionRate)
			rollup.VolatilityScore = Volatility(rates)

			if err := p.Repo.UpsertSensorIndustryRollup(ctx, rollup); err != nil {
				continue
			}
			stats.RollupsWritten++
			if rollup.SuppressedByKAnon() {
				stats.Suppressed++
			}
		}
	}

	// Audit row so consumers can see when the last publish happened.
	status := "ok"
	if stats.RollupsWritten == 0 {
		status = "skipped"
	} else if stats.Suppressed > 0 {
		status = "partial"
	}
	_ = p.Repo.AppendSensorChangelog(ctx, SensorChangelogEntry{
		PublishedFor: day,
		Status:       status,
		Summary: map[string]any{
			"industry_count":           stats.IndustryCount,
			"rollups_written":          stats.RollupsWritten,
			"suppressed_rows":          stats.Suppressed,
			"contributors_by_industry": stats.ContributorsByIndustry,
		},
		Notes: "scaffold publish — per-tenant pull deferred; see MIGRATION.md",
	})

	return stats, nil
}

// RunWorker is the long-running daily-tick loop. Started from
// apps/api/main.go alongside the other ticker workers. The cadence is
// 24h to match the per-tenant probe cadence + HubSpot AEO Sensor's
// daily publish.
func (p *SensorPublisher) RunWorker(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_, _ = p.PublishOnce(ctx)
		}
	}
}
