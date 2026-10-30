// SPDX-License-Identifier: AGPL-3.0-only
//
// pnl.go — Segment P&L (feature #4). Per-segment economics aggregated
// into one honest response: observed revenue + revenue-per-member, AOV,
// holdout-validated causal lift, realized-vs-predicted CLV
// reconciliation, and cost-side NET CONTRIBUTION.
//
// Design notes:
//   - Persistence sits behind the PnLStore interface so the handlers
//     and the lift maths are unit-testable WITHOUT a live Postgres. The
//     real pgx implementation lives in pnl_repo.go (same *Repo type);
//     a fake in pnl_test.go exercises the handlers.
//   - The economic formulas (net contribution, CLV ratio, per-member
//     splits, lift partition + delta) are PURE functions, table-tested
//     in pnl_test.go. A wrong formula is invisible in integration tests,
//     so these are tested first (TDD).
//   - Honest-UI is load-bearing: every non-observed figure is flagged.
//     Lift is null-with-reason when no holdout exists or the segment is
//     too large for the in-process scan (>100k members, per approved
//     decision D1). Revenue scope is disclosed as 'member_all_sources'
//     (D4). Sequence-attributed revenue is ALWAYS marked unsupported.
package segments

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/holdout"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	pnlDefaultDays = 90
	pnlMaxDays     = 365
	// compareMaxSegments caps the side-by-side compare endpoint so a
	// single request can't fan out into an unbounded query storm.
	compareMaxSegments = 5
	// liftInProcessMemberCap is the approved D1 threshold: segments with
	// more members than this skip the in-process holdout scan and return
	// lift=null + lift_skipped_reason rather than pulling a huge id list
	// into Go memory.
	liftInProcessMemberCap = 100_000
	// liftMinCohort is the per-cohort floor below which lift is flagged
	// low-confidence (confidence_low=true). Never fabricates an interval.
	liftMinCohort = 30
)

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

// PnLCurrencyTotal is the per-currency disclosure: how much revenue (and
// how many monetary conversions) the window holds in each currency. Same
// JSON shape as conversions.CurrencyTotal — duplicated locally so the
// segments package owns its response contract without importing the
// conversions package just for one struct.
type PnLCurrencyTotal struct {
	Currency     string `json:"currency"`
	Conversions  int64  `json:"conversions"`
	RevenueCents int64  `json:"revenue_cents"`
}

// PnLAttributionProvenance is the honest "how were these conversions
// attributed?" split over the window. Same shape as
// conversions.AttributionProvenance.
type PnLAttributionProvenance struct {
	Explicit           int64 `json:"explicit"`
	LastTouch          int64 `json:"last_touch"`
	None               int64 `json:"none"`
	CodeRedemption     int64 `json:"code_redemption"`
	CampaignVanityPath int64 `json:"campaign_vanity_path"`
	Unclassified       int64 `json:"unclassified"`
}

// SegmentLiftResult is the holdout-validated causal lift pillar. Only
// populated when a segment_holdouts row exists AND the segment is within
// the in-process member cap.
type SegmentLiftResult struct {
	HoldoutPercent  float64 `json:"holdout_percent"`
	ControlSize     int64   `json:"control_size"`
	TreatedSize     int64   `json:"treated_size"`
	ControlConvRate float64 `json:"control_conv_rate"`
	TreatedConvRate float64 `json:"treated_conv_rate"`
	IncrementalLift float64 `json:"incremental_lift"`
	LiftPercent     float64 `json:"lift_percent"`
	WindowDays      int     `json:"window_days"`
	// ConfidenceLow is true when either cohort has < liftMinCohort
	// members — the UI renders a ConfidenceNote(level="low"); the server
	// never ships a fabricated confidence interval.
	ConfidenceLow bool `json:"confidence_low"`
}

// SegmentPnLResponse is the GET /api/v1/segments/{id}/pnl body.
type SegmentPnLResponse struct {
	SegmentID   string             `json:"segment_id"`
	MemberCount int64              `json:"member_count"`
	WindowDays  int                `json:"window_days"`
	Currency    string             `json:"currency,omitempty"`
	Currencies  []PnLCurrencyTotal `json:"currencies"`

	// Revenue pillar (observed, conversions table). D4: scope is all
	// conversions by segment members in the window, not scoped to
	// campaigns that used this segment.
	RevenueCents          int64                    `json:"revenue_cents"`
	RevenueConversions    int64                    `json:"revenue_conversions"`
	RevenuePerMemberCents *float64                 `json:"revenue_per_member_cents,omitempty"`
	RevenueScope          string                   `json:"revenue_scope"`
	RevenueProvenance     PnLAttributionProvenance `json:"revenue_provenance"`

	// AOV pillar (commerce_orders, dominant currency). nil when no
	// commerce_orders integration / no matching orders.
	AOVCents      *int64 `json:"aov_cents,omitempty"`
	AOVOrderCount int64  `json:"aov_order_count"`
	AOVCurrency   string `json:"aov_currency,omitempty"`

	// CLV reconciliation pillar.
	CLVMembersScored       int64    `json:"clv_members_scored"`
	CLVHistoricSumCents    int64    `json:"clv_historic_sum_cents"`
	CLVPredictedSumCents   int64    `json:"clv_predicted_sum_cents"`
	CLVRealisedVsPredicted *float64 `json:"clv_realised_vs_predicted,omitempty"`

	// Cost pillar.
	UnsubCount        int64  `json:"unsub_count"`
	ComplaintCount    int64  `json:"complaint_count"`
	TotalCostCents    int64  `json:"total_cost_cents"`
	CostCurrency      string `json:"cost_currency"`
	CostConfigPresent bool   `json:"cost_config_present"`

	// Net contribution (revenue - cost). nil when the revenue currency
	// differs from the cost currency (no honest cross-currency subtract).
	NetContributionCents          *int64   `json:"net_contribution_cents,omitempty"`
	NetContributionPerMemberCents *float64 `json:"net_contribution_per_member_cents,omitempty"`

	// Lift pillar (only when include_lift AND a holdout row exists).
	Lift *SegmentLiftResult `json:"lift,omitempty"`
	// LiftSkippedReason explains why Lift is nil when it was requested:
	// "no_holdout_configured" | "segment_too_large_for_in_process_lift".
	// Empty when lift was not requested or was computed.
	LiftSkippedReason string `json:"lift_skipped_reason,omitempty"`

	// Honest gaps.
	SequenceAttributionUnsupported bool `json:"sequence_attribution_unsupported"`
	CrossCurrencyRevenueExcluded   bool `json:"cross_currency_revenue_excluded"`

	GeneratedAt time.Time `json:"generated_at"`
}

// SegmentCompareResponse is the GET /api/v1/segments/pnl/compare body.
type SegmentCompareResponse struct {
	Items      []SegmentPnLResponse `json:"items"`
	WindowDays int                  `json:"window_days"`
	Days       int                  `json:"days"`
}

// SegmentHoldoutConfig is the segment_holdouts row returned by the
// POST/DELETE holdout config routes.
type SegmentHoldoutConfig struct {
	SegmentID  string     `json:"segment_id"`
	Percent    float64    `json:"percent"`
	Seed       string     `json:"seed"`
	WindowDays int        `json:"window_days"`
	DecidedAt  *time.Time `json:"decided_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// ---------------------------------------------------------------------------
// Store interface (persistence behind an interface so handlers + lift
// maths unit-test without Postgres). *Repo implements this in pnl_repo.go.
// ---------------------------------------------------------------------------

// PnLRawData is the bundle of raw aggregates a single segment's P&L is
// computed from. Returned by the Store; the pure assembler turns it into
// a SegmentPnLResponse. Keeping the raw read separate from the compute
// lets the formulas be table-tested with hand-built fixtures.
type PnLRawData struct {
	SegmentID   string
	MemberCount int64

	// Revenue (conversions table, member-scoped, dominant currency).
	Currencies         []PnLCurrencyTotal
	DominantCurrency   string
	RevenueCents       int64
	RevenueConversions int64
	Provenance         PnLAttributionProvenance

	// AOV (commerce_orders, dominant currency). HasOrders=false → AOV nil.
	HasOrders     bool
	AOVCents      int64
	AOVOrderCount int64
	AOVCurrency   string

	// CLV reconciliation (profile_predictions).
	CLVMembersScored     int64
	CLVHistoricSumCents  int64
	CLVPredictedSumCents int64

	// Cost (subscriber_events + segment_pnl_cost_config).
	UnsubCount         int64
	ComplaintCount     int64
	UnsubCostCents     int64
	ComplaintCostCents int64
	CostCurrency       string
	CostConfigPresent  bool

	// Holdout (segment_holdouts). HasHoldout=false → no holdout configured.
	HasHoldout     bool
	HoldoutSeed    string
	HoldoutPercent float64
	HoldoutWindow  int
}

// PnLStore is the persistence surface the P&L handlers depend on. The
// real implementation (*Repo) opens tenant-scoped txs so RLS fires; the
// test fake returns hand-built fixtures.
type PnLStore interface {
	// SegmentPnLRaw loads every raw aggregate for one segment's P&L.
	// Returns ErrNotFound when the segment doesn't exist for the tenant.
	SegmentPnLRaw(ctx context.Context, tenantID, segmentID string, windowDays int) (*PnLRawData, error)
	// SegmentLiftCohorts returns (memberIDs, conversions) for the lift
	// computation: the segment's member subscriber ids, and the set of
	// member ids that converted (any monetary conversion) within the
	// window. The pure liftFromCohorts function partitions and computes
	// the delta. Only called when a holdout exists and member_count is
	// within the in-process cap.
	SegmentLiftCohorts(ctx context.Context, tenantID, segmentID string, windowDays int) (memberIDs []string, convertedIDs map[string]bool, err error)
	// UpsertSegmentHoldout creates or updates the segment_holdouts row.
	UpsertSegmentHoldout(ctx context.Context, tenantID, segmentID string, percent float64, windowDays int) (*SegmentHoldoutConfig, error)
	// DeleteSegmentHoldout removes the segment_holdouts row. Returns
	// ErrNotFound when no row existed.
	DeleteSegmentHoldout(ctx context.Context, tenantID, segmentID string) error
}

// ---------------------------------------------------------------------------
// Pure compute functions (unit-tested without a database)
// ---------------------------------------------------------------------------

// parsePnLDays parses the ?days= query param. Empty → default 90.
// Non-integer or outside [1, 365] → (0, false) so the handler can 400.
func parsePnLDays(raw string) (int, bool) {
	if raw == "" {
		return pnlDefaultDays, true
	}
	n := 0
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
		if n > pnlMaxDays {
			return 0, false
		}
	}
	if n < 1 || n > pnlMaxDays {
		return 0, false
	}
	return n, true
}

// computeNetContributionCents = revenue − (unsubs × unsubCost) −
// (complaints × complaintCost). Pure; the load-bearing economic formula.
func computeNetContributionCents(revenueCents, unsubCount, unsubCostCents, complaintCount, complaintCostCents int64) int64 {
	return revenueCents - (unsubCount * unsubCostCents) - (complaintCount * complaintCostCents)
}

// computeCLVRatio returns historic/predicted, or nil when predicted <= 0
// (no honest denominator — never a divide-by-zero or +Inf). Returns nil
// for a negative predicted sum rather than a misleading negative ratio.
func computeCLVRatio(historicSum, predictedSum int64) *float64 {
	if predictedSum <= 0 {
		return nil
	}
	v := float64(historicSum) / float64(predictedSum)
	return &v
}

// computePerMemberCents returns totalCents/memberCount, or nil when
// memberCount <= 0 (an honest "no denominator" rather than a fake 0).
func computePerMemberCents(totalCents int64, memberCount int64) *float64 {
	if memberCount <= 0 {
		return nil
	}
	v := float64(totalCents) / float64(memberCount)
	return &v
}

// pnlSafeRate returns num/den, or 0 when den == 0.
func pnlSafeRate(num, den int64) float64 {
	if den == 0 {
		return 0
	}
	return float64(num) / float64(den)
}

// pnlDominantCurrency picks the currency every *_cents figure is
// denominated in: most revenue first, then most monetary conversions,
// then alphabetical for determinism. Empty slice → "".
func pnlDominantCurrency(totals []PnLCurrencyTotal) string {
	best := ""
	var bestRev, bestConv int64
	for _, t := range totals {
		switch {
		case best == "",
			t.RevenueCents > bestRev,
			t.RevenueCents == bestRev && t.Conversions > bestConv,
			t.RevenueCents == bestRev && t.Conversions == bestConv && t.Currency < best:
			best, bestRev, bestConv = t.Currency, t.RevenueCents, t.Conversions
		}
	}
	return best
}

// liftFromCohorts partitions the segment members into control (held out)
// and treated cohorts using the deterministic holdout.AssignBucket hash —
// the SAME bucket assignment the per-campaign lift surface uses — then
// compares conversion rates. convertedIDs is the set of member ids with a
// conversion in the window. Pure: no DB, deterministic for a given seed.
//
// Returns nil when there are no members (nothing to measure).
func liftFromCohorts(seed string, percent float64, windowDays int, memberIDs []string, convertedIDs map[string]bool) *SegmentLiftResult {
	if len(memberIDs) == 0 {
		return nil
	}
	var controlSize, treatedSize, controlConv, treatedConv int64
	for _, id := range memberIDs {
		converted := convertedIDs[id]
		if holdout.IsHeldOut(seed, id, percent) {
			controlSize++
			if converted {
				controlConv++
			}
		} else {
			treatedSize++
			if converted {
				treatedConv++
			}
		}
	}
	controlRate := pnlSafeRate(controlConv, controlSize)
	treatedRate := pnlSafeRate(treatedConv, treatedSize)
	incremental := treatedRate - controlRate
	var liftPct float64
	if controlRate != 0 {
		liftPct = (incremental / controlRate) * 100
	}
	return &SegmentLiftResult{
		HoldoutPercent:  percent,
		ControlSize:     controlSize,
		TreatedSize:     treatedSize,
		ControlConvRate: controlRate,
		TreatedConvRate: treatedRate,
		IncrementalLift: incremental,
		LiftPercent:     liftPct,
		WindowDays:      windowDays,
		ConfidenceLow:   controlSize < liftMinCohort || treatedSize < liftMinCohort,
	}
}

// assemblePnL turns raw aggregates into the response, applying every
// pure economic formula and honest-gap flag. Pure: no DB, no clock
// except the caller-supplied `now` (so tests are deterministic). Lift is
// assembled separately (it needs the cohort scan) and attached by the
// caller; lift/liftReason here come from that step.
func assemblePnL(raw *PnLRawData, windowDays int, lift *SegmentLiftResult, liftReason string, now time.Time) *SegmentPnLResponse {
	out := &SegmentPnLResponse{
		SegmentID:   raw.SegmentID,
		MemberCount: raw.MemberCount,
		WindowDays:  windowDays,
		Currency:    raw.DominantCurrency,
		Currencies:  raw.Currencies,

		RevenueCents:          raw.RevenueCents,
		RevenueConversions:    raw.RevenueConversions,
		RevenuePerMemberCents: computePerMemberCents(raw.RevenueCents, raw.MemberCount),
		RevenueScope:          "member_all_sources",
		RevenueProvenance:     raw.Provenance,

		AOVOrderCount: raw.AOVOrderCount,

		CLVMembersScored:       raw.CLVMembersScored,
		CLVHistoricSumCents:    raw.CLVHistoricSumCents,
		CLVPredictedSumCents:   raw.CLVPredictedSumCents,
		CLVRealisedVsPredicted: computeCLVRatio(raw.CLVHistoricSumCents, raw.CLVPredictedSumCents),

		UnsubCount:        raw.UnsubCount,
		ComplaintCount:    raw.ComplaintCount,
		CostCurrency:      raw.CostCurrency,
		CostConfigPresent: raw.CostConfigPresent,

		Lift:              lift,
		LiftSkippedReason: liftReason,

		SequenceAttributionUnsupported: true, // always — conversions carry campaign attribution only
		CrossCurrencyRevenueExcluded:   len(raw.Currencies) > 1,

		GeneratedAt: now,
	}

	if raw.HasOrders {
		aov := raw.AOVCents
		out.AOVCents = &aov
		out.AOVCurrency = raw.AOVCurrency
	}

	// Cost total in the cost currency.
	out.TotalCostCents = computeNetContributionCents(0, raw.UnsubCount, raw.UnsubCostCents, raw.ComplaintCount, raw.ComplaintCostCents) * -1

	// Net contribution: only when revenue + cost share a currency (no
	// honest cross-currency subtraction). A zero-revenue segment in the
	// cost currency still yields a (negative-or-zero) net figure.
	if pnlCurrenciesComparable(raw.DominantCurrency, raw.CostCurrency, raw.RevenueCents) {
		net := computeNetContributionCents(raw.RevenueCents, raw.UnsubCount, raw.UnsubCostCents, raw.ComplaintCount, raw.ComplaintCostCents)
		out.NetContributionCents = &net
		out.NetContributionPerMemberCents = computePerMemberCents(net, raw.MemberCount)
	}

	return out
}

// pnlCurrenciesComparable reports whether revenue and cost can be
// subtracted honestly: same currency, OR no monetary revenue at all (in
// which case the cost currency governs and net = −cost).
func pnlCurrenciesComparable(revenueCurrency, costCurrency string, revenueCents int64) bool {
	if revenueCents == 0 {
		return true
	}
	if revenueCurrency == "" {
		return true
	}
	return revenueCurrency == costCurrency
}
