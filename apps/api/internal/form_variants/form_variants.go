// Package form_variants implements the form A/B with auto-promote winner
// gap feature (Klaviyo "Forms Display Optimization" parity). The backend
// owns:
//
//   - per-form variants table (display_config + traffic_pct)
//   - counter table for impressions / submissions
//   - audit log of auto-promotions
//   - a Wald-z bandit pass that re-weights traffic toward the variant
//     with the highest submission rate and promotes the leader once we
//     cross 95% confidence (|z| >= 1.96).
//
// The public render path picks one variant per (form_id, sticky-token)
// based on traffic_pct and increments impressions; the submit path
// resolves the variant the visitor saw and increments submissions.
// The bandit pass runs on every Reweight() call (a future scheduler
// can pin it to a cron; this package keeps the math + persistence
// surface so the scheduler is one liner).
//
// Schema: see infra/migrations/0289_form_variants.sql.
package form_variants

import "time"

// Status is the lifecycle of a variant. Mirrors the SQL CHECK.
type Status string

const (
	StatusExploring Status = "exploring"
	StatusPromoted  Status = "promoted"
	StatusPaused    Status = "paused"
)

// ConfidenceZ is the two-tailed alpha=0.05 cutoff. Mirrors the same
// constant used by the campaign A/B winner picker so the platform
// semantics ("95% confident") line up across surfaces.
const ConfidenceZ = 1.96

// MinSampleForPromotion is the minimum impressions per variant before
// the bandit is allowed to auto-promote. Without it, two impressions
// at 0% vs 100% have z = +inf but tell us nothing. 200 impressions
// per arm is the lower bound at which a Wald-z on conversion rate
// becomes meaningfully stable (and matches Klaviyo's documented "we
// need a few hundred views per variant" threshold).
const MinSampleForPromotion = 200

// Variant mirrors form_variants on the wire (admin surface).
type Variant struct {
	ID            string         `json:"id"`
	TenantID      string         `json:"tenantId"`
	FormID        string         `json:"formId"`
	Label         string         `json:"label"`
	DisplayConfig map[string]any `json:"displayConfig"`
	TrafficPct    int            `json:"trafficPct"`
	Status        Status         `json:"status"`
	PromotedAt    *time.Time     `json:"promotedAt,omitempty"`
	LastZScore    float64        `json:"lastZScore"`
	// Computed metrics from form_variant_impressions, joined in by
	// List/Get for the admin UI. Zero when there are no impressions.
	Impressions    int64     `json:"impressions"`
	Submissions    int64     `json:"submissions"`
	ConversionRate float64   `json:"conversionRate"` // 0..1
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// CreateInput is the body of POST /api/v1/forms/{id}/variants.
type CreateInput struct {
	Label         string         `json:"label"`
	DisplayConfig map[string]any `json:"displayConfig"`
	// TrafficPct is optional; when omitted (0) the repo rebalances
	// even-split across the variant set.
	TrafficPct int `json:"trafficPct,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/forms/{id}/variants/{variantId}.
// All fields optional.
type UpdateInput struct {
	Label         *string         `json:"label,omitempty"`
	DisplayConfig *map[string]any `json:"displayConfig,omitempty"`
	TrafficPct    *int            `json:"trafficPct,omitempty"`
	Status        *Status         `json:"status,omitempty"`
}

// Promotion mirrors form_variant_promotions for the admin audit feed.
type Promotion struct {
	ID                  string    `json:"id"`
	FormID              string    `json:"formId"`
	WinnerVariantID     string    `json:"winnerVariantId"`
	WinnerRate          float64   `json:"winnerRate"`
	RunnerUpRate        float64   `json:"runnerUpRate"`
	ZScore              float64   `json:"zScore"`
	WinnerImpressions   int64     `json:"winnerImpressions"`
	RunnerUpImpressions int64     `json:"runnerUpImpressions"`
	DecidedAt           time.Time `json:"decidedAt"`
}

// PickResult is what the public render path resolves before writing
// the variant id into the rendered page (so submit can attribute back).
type PickResult struct {
	VariantID     string         `json:"variantId"`
	Label         string         `json:"label"`
	DisplayConfig map[string]any `json:"displayConfig"`
}

// AllowedStatusTransition mirrors the forms package's status guard.
// We allow exploring <-> paused and exploring -> promoted; once
// promoted (auto or manual) the variant is sticky — to "re-test", the
// operator clones it.
func AllowedStatusTransition(from, to Status) bool {
	if from == to {
		return true
	}
	switch from {
	case StatusExploring:
		return to == StatusPaused || to == StatusPromoted
	case StatusPaused:
		return to == StatusExploring
	case StatusPromoted:
		// Promoted is terminal. Clone the variant to start a new test.
		return false
	}
	return false
}
