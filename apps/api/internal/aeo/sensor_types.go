// SPDX-License-Identifier: AGPL-3.0-only
//
// Public industry-wide AEO Sensor — data types for the cross-tenant
// anonymized rollup. This is the HubSpot AEO Sensor moat: a free,
// public AI-search volatility index that no other marketing-cloud
// ships.
//
// The per-tenant probe ledger lives in types.go (Settings, Probe,
// DailyRollup, ...). This file adds the public-aggregate shapes that
// the Sensor publish worker writes and the public HTTP surface reads.
//
// Architecture (see MIGRATION.md):
//
//   per-tenant DailyRollup rows
//        |
//        v   (SensorPublisher.PublishOnce, gated on
//             aeo_tenant_industry.contribute_to_public = true
//             AND k-anonymity floor MIN_CONTRIBUTORS)
//        v
//   aeo_sensor_industry_rollup (anonymized — no tenant_id column)
//        |
//        v
//   GET /api/v1/sensor/aeo/*  (public, no tenant header required)
//
// All structs here are JSON shapes for the public API. They are
// intentionally distinct from the per-tenant DailyRollup so the
// public surface can evolve (add differential-privacy noise, drop
// fields under embargo, etc.) without leaking through to brand-side
// dashboards.

package aeo

import (
	"os"
	"strings"
	"time"
)

// MinContributors is the k-anonymity floor for the public Sensor. A
// row with fewer than this many contributing tenants is computed but
// suppressed from the public response (HTTP layer returns nothing
// rather than a sparse / identifiable row). 5 matches the HubSpot AEO
// Sensor floor and the per-tenant MinSampleForSignificance.
const MinContributors = 5

// SensorRuntimeStatus enumerates the lifecycle of the public Sensor
// publisher. While the per-tenant rollup pull is a stub
// (see MIGRATION.md DEFERRED #1) the status MUST be "stub" so the
// publisher does NOT upsert deterministic zero-rate rows into the
// PUBLIC industry rollup the moment a tenant opts in — those rows are
// indistinguishable from a real publish at the wire level and would
// poison the public surface.
//
// The status is also the gate for the public HTTP read surface; while
// "stub", the public endpoints return 503 with a clear reason rather
// than serving an empty / suppressed envelope that the marketing site
// would render as "the Sensor is live, the industry just has no data".
//
// Values:
//
//	"stub"  — per-tenant pull not wired; publisher MUST NOT upsert,
//	          public endpoints return 503.
//	"ready" — per-tenant pull is real; publisher upserts, public
//	          endpoints serve normally.
//
// The runtime status is read from POSTWAVE_AEO_SENSOR_RUNTIME (env
// override) and defaults to "stub". The follow-up PR that ships the
// per-tenant pull (MIGRATION.md DEFERRED #1) flips the default to
// "ready" in code rather than relying on the env flag.
const (
	SensorRuntimeStub  = "stub"
	SensorRuntimeReady = "ready"
)

// sensorRuntimeDefault is the compile-time default. Stays "stub" until
// MIGRATION.md DEFERRED #1 (real per-tenant rollup pull) ships.
const sensorRuntimeDefault = SensorRuntimeStub

// SensorRuntime reports the publisher / public-surface runtime status.
// Reads POSTWAVE_AEO_SENSOR_RUNTIME for operator override (e.g. to
// flip "ready" on a staging environment that has a real probe runner
// wired) and falls back to the compile-time default.
func SensorRuntime() string {
	v := strings.TrimSpace(os.Getenv("POSTWAVE_AEO_SENSOR_RUNTIME"))
	switch v {
	case SensorRuntimeStub, SensorRuntimeReady:
		return v
	default:
		return sensorRuntimeDefault
	}
}

// SensorRuntimeIsReady is a convenience predicate used by the
// publisher (gate the upsert) and the public HTTP handlers (gate the
// snapshot/series/industries/changelog reads).
func SensorRuntimeIsReady() bool {
	return SensorRuntime() == SensorRuntimeReady
}

// Industry is one row of aeo_sensor_industries — the public taxonomy
// rendered in the Sensor page's industry filter.
type Industry struct {
	Slug        string    `json:"slug"`
	DisplayName string    `json:"display_name"`
	SortOrder   int       `json:"sort_order"`
	ParentSlug  string    `json:"parent_slug,omitempty"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// TenantIndustry is one row of aeo_tenant_industry. The settings UI
// reads and writes this; the rollup worker reads it across tenants
// under the worker GUC scope.
type TenantIndustry struct {
	TenantID           string     `json:"tenant_id,omitempty"`
	IndustrySlug       string     `json:"industry_slug"`
	ContributeToPublic bool       `json:"contribute_to_public"`
	OptedInAt          *time.Time `json:"opted_in_at,omitempty"`
	CreatedAt          time.Time  `json:"created_at,omitempty"`
	UpdatedAt          time.Time  `json:"updated_at,omitempty"`
}

// SensorIndustryRollup is one row of aeo_sensor_industry_rollup — the
// anonymized cross-tenant rollup that powers the public Sensor page.
// NEVER carries a tenant_id; the publisher strips identity at write
// time.
type SensorIndustryRollup struct {
	IndustrySlug     string    `json:"industry_slug"`
	Engine           Engine    `json:"engine"`
	Day              time.Time `json:"day"`
	MentionRate      float64   `json:"mention_rate"`
	CitationRate     float64   `json:"citation_rate"`
	VolatilityScore  float64   `json:"volatility_score"`
	ContributorCount int       `json:"contributor_count"`
	SampleSize       int       `json:"sample_size"`
	ComputedAt       time.Time `json:"computed_at"`
}

// SuppressedByKAnon reports whether this rollup row should be hidden
// from the public response because fewer than MinContributors tenants
// contributed. The publisher still writes the row (for auditability +
// internal review); the HTTP layer is responsible for the suppression.
func (r SensorIndustryRollup) SuppressedByKAnon() bool {
	return r.ContributorCount < MinContributors
}

// SensorChangelogEntry is one row of aeo_sensor_changelog — used by
// the public /sensor/aeo/changelog endpoint to publish cadence
// proof so consumers can audit publication freshness.
type SensorChangelogEntry struct {
	ID           int64          `json:"id"`
	PublishedFor time.Time      `json:"published_for"`
	Summary      map[string]any `json:"summary"`
	Status       string         `json:"status"`
	Notes        string         `json:"notes,omitempty"`
	PublishedAt  time.Time      `json:"published_at"`
}

// SensorPublicSnapshot is the top-level response shape for
// GET /api/v1/sensor/aeo/snapshot — the public landing page's
// headline tile pack. One row per engine, plus the headline
// pooled-across-engines volatility number.
type SensorPublicSnapshot struct {
	IndustrySlug        string                 `json:"industry_slug,omitempty"`
	GeneratedAt         time.Time              `json:"generated_at"`
	OverallVolatility   float64                `json:"overall_volatility"`
	OverallMentionRate  float64                `json:"overall_mention_rate"`
	OverallCitationRate float64                `json:"overall_citation_rate"`
	PerEngine           []SensorIndustryRollup `json:"per_engine"`
	Suppressed          bool                   `json:"suppressed,omitempty"`
	SuppressionReason   string                 `json:"suppression_reason,omitempty"`
}

// AggregateRows folds a slice of per-tenant rates into a single
// SensorIndustryRollup row for a given (industry, engine, day) bucket.
// Pure function — used by the publisher and easy to unit-test against
// synthetic inputs.
//
// perTenant is the slice of (mention_rate, citation_rate) tuples one
// per contributing tenant. sampleSizes is the per-tenant probe count
// summed into SampleSize.
func AggregateRows(industry string, engine Engine, day time.Time, perTenantMention, perTenantCitation []float64, sampleSizes []int) SensorIndustryRollup {
	out := SensorIndustryRollup{
		IndustrySlug:     industry,
		Engine:           engine,
		Day:              day,
		ContributorCount: len(perTenantMention),
		ComputedAt:       time.Now().UTC(),
	}
	if len(perTenantMention) == 0 {
		return out
	}
	var mSum, cSum float64
	for _, v := range perTenantMention {
		mSum += v
	}
	for _, v := range perTenantCitation {
		cSum += v
	}
	out.MentionRate = round4(mSum / float64(len(perTenantMention)))
	if len(perTenantCitation) > 0 {
		out.CitationRate = round4(cSum / float64(len(perTenantCitation)))
	}
	for _, s := range sampleSizes {
		out.SampleSize += s
	}
	return out
}
