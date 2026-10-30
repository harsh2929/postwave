// Package abtests implements per-campaign A/B testing: variant copy, weighted
// deterministic recipient assignment, aggregate metric tracking, and a
// two-proportion z-test winner picker. Persistence is in 0015_ab_tests.sql.
package abtests

import "time"

// WinnerMetric is the metric a campaign's A/B test optimizes for.
type WinnerMetric string

const (
	WinnerMetricOpenRate  WinnerMetric = "open_rate"
	WinnerMetricClickRate WinnerMetric = "click_rate"
	WinnerMetricReplyRate WinnerMetric = "reply_rate"
)

// Valid reports whether m is a known WinnerMetric.
func (m WinnerMetric) Valid() bool {
	switch m {
	case WinnerMetricOpenRate, WinnerMetricClickRate, WinnerMetricReplyRate:
		return true
	}
	return false
}

// Variant is one A/B variant of a campaign.
//
// Multivariate dimensions: a variant can override Subject, FromName,
// FromEmail (sender), BodyMJML/BodyHTML, and SendTimeOffsetMinutes
// (delay relative to the parent campaign's scheduled_at). Any subset
// of these can vary across variants; unset fields fall back to the
// parent campaign's defaults at send time.
type Variant struct {
	ID           string `json:"id"`
	CampaignID   string `json:"campaign_id"`
	TenantID     string `json:"tenant_id"`
	VariantLabel string `json:"variant_label"`
	Subject      string `json:"subject,omitempty"`
	FromName     string `json:"from_name,omitempty"`
	// FromEmail overrides the parent campaign's sender address for
	// this variant. Empty means inherit from the campaign. Lets a
	// test compare "founder@acme.com" vs "team@acme.com".
	FromEmail string `json:"from_email,omitempty"`
	BodyMJML  string `json:"body_mjml,omitempty"`
	BodyHTML  string `json:"body_html,omitempty"`
	// SendTimeOffsetMinutes shifts this variant's dispatch time
	// relative to the campaign's scheduled_at. Lets a test compare
	// "send at 10am" vs "send at 2pm" without cloning the campaign.
	// 0 means send at the parent's scheduled time (default).
	SendTimeOffsetMinutes int       `json:"send_time_offset_minutes,omitempty"`
	Weight                float64   `json:"weight"`
	CreatedAt             time.Time `json:"created_at"`
}

// VariantResult is the per-variant aggregate metric snapshot.
type VariantResult struct {
	VariantID       string     `json:"variant_id"`
	TenantID        string     `json:"tenant_id"`
	RecipientsCount int        `json:"recipients_count"`
	Delivered       int        `json:"delivered"`
	Opens           int        `json:"opens"`
	Clicks          int        `json:"clicks"`
	Unsubscribes    int        `json:"unsubscribes"`
	Complaints      int        `json:"complaints"`
	Winner          bool       `json:"winner"`
	LastEvaluatedAt *time.Time `json:"last_evaluated_at,omitempty"`
}

// ABSettings is the per-campaign A/B configuration.
//
// Mid-flight early stopping (Mailchimp Premium model):
//
//	SamplePct = 100 (default)  → every recipient gets a variant; winner
//	                              is announced after the evaluation
//	                              window. Equivalent to "regular" A/B.
//	SamplePct = 20             → 20% of the audience runs through
//	                              variants; the remaining 80% gets the
//	                              winning variant once SampleEvaluatedAt
//	                              is stamped by the scheduler.
//	SamplePct in (1, 99)        → any custom split.
type ABSettings struct {
	CampaignID            string       `json:"campaign_id"`
	TenantID              string       `json:"tenant_id"`
	WinnerMetric          WinnerMetric `json:"winner_metric"`
	EvaluationWindowHours int          `json:"evaluation_window_hours"`
	WinnerRecipientsPct   float64      `json:"winner_recipients_pct"`
	WinnerDecidedAt       *time.Time   `json:"winner_decided_at,omitempty"`
	WinningVariantID      *string      `json:"winning_variant_id,omitempty"`
	// SamplePct controls the fraction of the audience that runs
	// through variants. The remaining (100 - SamplePct)% receives
	// the winning variant once the sample phase concludes. Default
	// 100 (no early stopping; every recipient is in the variant
	// phase).
	SamplePct float64 `json:"sample_pct"`
	// SampleEvaluatedAt is stamped by the scheduler when the sample
	// phase concludes and the winner is promoted. Nil while the
	// sample phase is still running.
	SampleEvaluatedAt *time.Time `json:"sample_evaluated_at,omitempty"`
	// WinnerRolloutCampaignID is the child "rollout" campaign the
	// scheduler creates to send the winning variant to the held-back
	// remainder (only when SamplePct < 100). Nil until the rollout is
	// created; surfaced so the UI can link to the second-phase send
	// (CAMP-043).
	WinnerRolloutCampaignID *string `json:"winner_rollout_campaign_id,omitempty"`

	// G4 (campaigns 2026): bandit allocation. BanditStrategy is
	// "fixed" | "thompson" | "epsilon_greedy". When non-fixed the
	// scheduler periodically recomputes campaign_variants.weight from
	// each arm's open/click posterior, blended with ExploreFloor so no
	// arm is starved. LastRecomputedAt gates the cadence.
	BanditStrategy           string     `json:"bandit_strategy"`
	ExploreFloor             float64    `json:"explore_floor"`
	RecomputeIntervalMinutes int        `json:"recompute_interval_minutes"`
	LastRecomputedAt         *time.Time `json:"last_recomputed_at,omitempty"`

	// WinnerLooksTaken is how much of the alpha budget this campaign has
	// already spent. Surfaced rather than hidden because "why has my test not
	// picked a winner" is answered by this number and nothing else — and an
	// operator who cannot see the budget will read a spent one as a stuck job.
	WinnerLooksTaken int `json:"winner_looks_taken"`
}

// LookBudget is the horizon these settings ask for, and what is left of it.
func (s ABSettings) LookBudget() LookBudget {
	return LookBudget{
		Planned: PlannedLooks(s.EvaluationWindowHours, s.RecomputeIntervalMinutes),
		Taken:   s.WinnerLooksTaken,
	}
}
