// SPDX-License-Identifier: AGPL-3.0-only
//
// plan_summary.go — the read-side composition behind
// GET /api/v1/billing/plan-summary. It answers, in one shot, "what
// plan am I on, what are the limits, how much have I used, and am I
// about to blow the monthly-send cap" so the dashboard can render a
// no-surprises billing card.
//
// Everything here REUSES currentAndLimit() (the same per-resource
// quota SQL that powers GET /api/v1/limits/usage) — there is no
// copy-pasted quota SQL. The billing handler calls PlanSummary; the
// projection math is a pure function (ComputeSendsProjection) so it
// is unit-testable without a database.

package limits

import (
	"context"
	"math"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SendsProjection is the "no surprise" piece: an honest linear
// extrapolation of monthly_sends to the end of the current usage
// period. Every number is derived from real usage — never invented.
// The UI labels ProjectedEndOfPeriod / ProjectedExceedDate as an
// "estimate".
type SendsProjection struct {
	Current     int    `json:"current"`
	Limit       int    `json:"limit"`
	AsOf        string `json:"as_of"`
	PeriodStart string `json:"period_start"`
	PeriodEnd   string `json:"period_end"`

	// AvgPerDay is the real average over the ELAPSED days of the
	// period: current / days_elapsed (rounded). 0 when no usage or no
	// days have elapsed — we never fabricate a trend.
	AvgPerDay    int `json:"avg_per_day"`
	DaysElapsed  int `json:"days_elapsed"`
	DaysInPeriod int `json:"days_in_period"`

	// ProjectedEndOfPeriod = avg_per_day * days_in_period. An honest
	// linear extrapolation; the UI presents it as an estimate.
	ProjectedEndOfPeriod int `json:"projected_end_of_period"`

	// ProjectedExceedDate is the calendar date the running total is
	// projected to cross Limit, or null when not projected to exceed
	// (or when there is insufficient data to project).
	ProjectedExceedDate *string `json:"projected_exceed_date"`

	OnTrackToExceed bool `json:"on_track_to_exceed"`
}

// PlanSummary is the full response shape for plan-summary. CurrentPeriodEnd
// is sourced from billing_state by the caller (the billing handler) and
// omitted when unknown.
type PlanSummary struct {
	Tier             string           `json:"tier"`
	CurrentPeriodEnd *string          `json:"current_period_end,omitempty"`
	Resources        []UsageRow       `json:"resources"`
	SendsProjection  *SendsProjection `json:"sends_projection,omitempty"`
}

// PlanSummaryResources returns the per-resource current/limit/percent/exceeded
// rows AND the resolved tier for a tenant, reusing currentAndLimit() so the
// quota SQL lives in exactly one place. This is the exported equivalent of
// what the GET /api/v1/limits/usage handler does internally.
func PlanSummaryResources(ctx context.Context, pool *db.Pool, tenantID string) ([]UsageRow, string, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tier := "studio"
	_ = tx.QueryRow(ctx, `
SELECT COALESCE(bs.tier, t.tier, 'studio')
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID).Scan(&tier)
	tier = canonicalTier(tier)
	lim, configured := configuredLimits(tier)
	if !configured {
		lim = tierLimits["studio"]
		tier = "studio"
	}

	resources := []Resource{
		ResourceContacts,
		ResourceCampaigns,
		ResourceAutomations,
		ResourceLandingPages,
		ResourcePopupForms,
		ResourceEcommerceIntegrations,
		ResourceMonthlySends,
		ResourceSeats,
		ResourceAICredits,
		ResourceAutomationExecutions,
		ResourceTrackedEvents,
		ResourceAPIOperations,
		ResourceAssetStorage,
		// Published so a tenant learns they are near the assurance allowance
		// from the usage panel rather than from a 402 in the middle of a
		// pre-send review.
		ResourceAssuranceRuns,
	}
	rows := make([]UsageRow, 0, len(resources))
	for _, res := range resources {
		current, limit, err := currentAndLimit(ctx, tx, tenantID, res, lim)
		if err != nil {
			// Mirror the usage handler: skip a broken row rather than
			// 500'ing the whole panel.
			continue
		}
		row := UsageRow{Resource: string(res), Current: current, Limit: limit}
		if limit > 0 {
			row.Percent = float64(current) / float64(limit) * 100.0
			if row.Percent > 100 {
				row.Exceeded = true
			}
		}
		rows = append(rows, row)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return rows, tier, nil
}

// BuildSendsProjection computes the monthly_sends projection for a tenant.
// The CURRENT value and LIMIT come straight from the monthly_sends row that
// PlanSummaryResources already computed (so the projection cannot disagree
// with the usage bar). The period window is the CALENDAR MONTH because that
// is exactly the window the monthly_sends cap is measured over in
// currentAndLimit() (date_trunc('month', now())). avg_per_day is derived from
// that same month-to-date total divided by elapsed days — the honest
// source-of-truth, no separate query that could drift.
func BuildSendsProjection(monthlySends *UsageRow, now time.Time) *SendsProjection {
	if monthlySends == nil {
		return nil
	}
	periodStart := monthStart(now)
	periodEnd := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	return ComputeSendsProjection(monthlySends.Current, monthlySends.Limit, periodStart, periodEnd, now)
}

// ComputeSendsProjection is the pure projection math, factored out so it can
// be unit-tested without a database.
//
// Formula (honest linear extrapolation, labeled an estimate by the UI):
//
//	days_elapsed         = whole days from period_start to now, floored, min 1
//	                       once any time has passed (a partial first day counts
//	                       as 1 so we never divide by zero while sends exist)
//	days_in_period       = whole days in the calendar month
//	avg_per_day          = round(current / days_elapsed)
//	projected_end        = avg_per_day * days_in_period
//	projected_exceed_date= period_start + ceil(limit / avg_per_day) days,
//	                       only when avg_per_day > 0 AND projected_end > limit
//	                       AND that date falls within the period; else null
//
// Insufficient-data guard: if there are no sends, or no days have elapsed,
// we return a zeroed projection with on_track_to_exceed=false and a null
// exceed date — we never invent a trend.
func ComputeSendsProjection(current, limit int, periodStart, periodEnd, now time.Time) *SendsProjection {
	p := &SendsProjection{
		Current:     current,
		Limit:       limit,
		AsOf:        now.UTC().Format(time.RFC3339),
		PeriodStart: periodStart.UTC().Format(time.RFC3339),
		PeriodEnd:   periodEnd.UTC().Format(time.RFC3339),
	}

	daysInPeriod := int(math.Round(periodEnd.Sub(periodStart).Hours() / 24))
	if daysInPeriod < 1 {
		daysInPeriod = 1
	}
	p.DaysInPeriod = daysInPeriod

	// Elapsed days: floor of (now - start) in days. A partial first day
	// counts as 1 once sends exist so a brand-new period with traffic still
	// projects (and we never divide by zero).
	elapsedHours := now.Sub(periodStart).Hours()
	daysElapsed := int(math.Floor(elapsedHours / 24))
	if daysElapsed < 1 && elapsedHours > 0 {
		daysElapsed = 1
	}
	// Don't let elapsed exceed the period length (clock skew / end of month).
	if daysElapsed > daysInPeriod {
		daysElapsed = daysInPeriod
	}
	p.DaysElapsed = daysElapsed

	// Insufficient data → honest zero, no fabricated trend.
	if current <= 0 || daysElapsed <= 0 {
		p.AvgPerDay = 0
		p.ProjectedEndOfPeriod = 0
		p.ProjectedExceedDate = nil
		p.OnTrackToExceed = false
		return p
	}

	avgPerDay := int(math.Round(float64(current) / float64(daysElapsed)))
	p.AvgPerDay = avgPerDay
	projectedEnd := avgPerDay * daysInPeriod
	p.ProjectedEndOfPeriod = projectedEnd

	if limit > 0 && avgPerDay > 0 && projectedEnd > limit {
		// Day on which the running total (avg_per_day * day) first
		// crosses the limit. ceil(limit/avg_per_day) days of accrual.
		daysToExceed := int(math.Ceil(float64(limit) / float64(avgPerDay)))
		exceedDate := periodStart.AddDate(0, 0, daysToExceed)
		// Only report a date inside the period — a projection that lands
		// after period end means "won't exceed before reset".
		if !exceedDate.After(periodEnd) {
			s := exceedDate.UTC().Format("2006-01-02")
			p.ProjectedExceedDate = &s
			p.OnTrackToExceed = true
		}
	}
	return p
}
