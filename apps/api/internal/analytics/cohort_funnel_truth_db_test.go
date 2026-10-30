// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestCohortsUseSubscriberRelativeWeeksPositiveEngagementAndMatureWindowsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)

	now := time.Now().UTC()
	historicalStart := time.Date(
		now.Year(),
		now.Month()-3,
		1,
		0,
		0,
		0,
		0,
		time.UTC,
	)
	earlySignup := historicalStart.Add(2 * 24 * time.Hour)
	latePositiveSignup := historicalStart.Add(19 * 24 * time.Hour)
	lateNegativeSignup := historicalStart.Add(20 * 24 * time.Hour)
	immatureSignup := now.Add(-3 * 24 * time.Hour)

	followupExec(t, pool, ctx, tenantID, `
INSERT INTO subscribers
       (tenant_id, email, status, consent_source, created_at, updated_at)
VALUES ($1::uuid, 'early@example.test', 'enabled', 'api', $2, $2),
       ($1::uuid, 'late-positive@example.test', 'enabled', 'api', $3, $3),
       ($1::uuid, 'late-negative@example.test', 'enabled', 'api', $4, $4),
       ($1::uuid, 'immature@example.test', 'enabled', 'api', $5, $5)`,
		tenantID,
		earlySignup,
		latePositiveSignup,
		lateNegativeSignup,
		immatureSignup,
	)
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO subscriber_events
       (tenant_id, subscriber_email, event_type, at)
VALUES ($1::uuid, 'early@example.test', 'opened', $2),
       ($1::uuid, 'late-positive@example.test', 'clicked', $3),
       ($1::uuid, 'late-negative@example.test', 'bounced', $4)`,
		tenantID,
		earlySignup.Add(2*24*time.Hour),
		latePositiveSignup.Add(2*24*time.Hour),
		lateNegativeSignup.Add(2*24*time.Hour),
	)

	service := NewService(pool)
	retention, err := service.Cohorts(ctx, tenantID, "month", "retention", 8)
	if err != nil {
		t.Fatalf("Cohorts retention: %v", err)
	}
	historical := cohortByLabel(t, retention, historicalStart.Format("2006-01"))
	if len(historical.Weeks) != 8 {
		t.Fatalf("historical mature weeks=%d, want requested horizon 8", len(historical.Weeks))
	}
	if math.Abs(historical.Weeks[0]-(2.0/3.0)) > 1e-9 {
		t.Fatalf(
			"historical W1 retention=%v, want 2/3 from opened+clicked only",
			historical.Weeks[0],
		)
	}
	for index, value := range historical.Weeks[1:] {
		if value != 0 {
			t.Fatalf("historical W%d=%v, want 0 after subscriber-relative bucketing", index+2, value)
		}
	}

	immature := cohortByLabel(t, retention, immatureSignup.Format("2006-01"))
	if len(immature.Weeks) != 0 {
		t.Fatalf("immature cohort weeks=%v, want no observed values before a full week", immature.Weeks)
	}

	openRate, err := service.Cohorts(ctx, tenantID, "month", "open_rate", 8)
	if err != nil {
		t.Fatalf("Cohorts open_rate: %v", err)
	}
	historical = cohortByLabel(t, openRate, historicalStart.Format("2006-01"))
	if math.Abs(historical.Weeks[0]-(1.0/3.0)) > 1e-9 {
		t.Fatalf("historical W1 open rate=%v, want 1/3", historical.Weeks[0])
	}
}

func TestCohortsDistinguishObservedZeroFromImmatureTrailingWeeksDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	signup := time.Now().UTC().Add(-10 * 24 * time.Hour)

	followupExec(t, pool, ctx, tenantID, `
INSERT INTO subscribers
       (tenant_id, email, status, consent_source, created_at, updated_at)
VALUES ($1::uuid, 'quiet@example.test', 'enabled', 'api', $2, $2)`,
		tenantID,
		signup,
	)

	rows, err := NewService(pool).Cohorts(
		ctx,
		tenantID,
		"month",
		"open_rate",
		8,
	)
	if err != nil {
		t.Fatalf("Cohorts open_rate: %v", err)
	}
	cohort := cohortByLabel(t, rows, signup.Format("2006-01"))
	if len(cohort.Weeks) != 1 {
		t.Fatalf("mature prefix=%v, want one completed week and no immature trailing values", cohort.Weeks)
	}
	if cohort.Weeks[0] != 0 {
		t.Fatalf("completed no-open week=%v, want observed zero", cohort.Weeks[0])
	}
}

func TestSubscriberFunnelCountsOnlyPaidPostSignupOrdersThroughSnapshotDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)

	now := time.Now().UTC()
	cohortStart := time.Date(
		now.Year(),
		now.Month()-1,
		1,
		0,
		0,
		0,
		0,
		time.UTC,
	)
	buyerSignup := cohortStart.Add(24 * time.Hour)
	nonBuyerSignup := cohortStart.Add(2 * 24 * time.Hour)
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO subscribers
       (tenant_id, email, status, consent_source, created_at, updated_at)
VALUES ($1::uuid, 'buyer@example.test', 'enabled', 'api', $2, $2),
       ($1::uuid, 'nonbuyer@example.test', 'enabled', 'api', $3, $3)`,
		tenantID,
		buyerSignup,
		nonBuyerSignup,
	)
	integrationID := followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO commerce_integrations (tenant_id, provider, shop_domain)
VALUES ($1::uuid, 'shopify', $2)
RETURNING id::text`, tenantID, "truth-"+tenantID[:8]+".example.test")

	followupExec(t, pool, ctx, tenantID, `
INSERT INTO commerce_orders
       (tenant_id, integration_id, source_id, customer_email, status, ordered_at)
VALUES ($1::uuid, $2::uuid, 'pre-signup-paid', 'BUYER@example.test', 'paid', $3),
       ($1::uuid, $2::uuid, 'post-signup-refunded', 'buyer@example.test', 'refunded', $4),
       ($1::uuid, $2::uuid, 'post-signup-pending', 'buyer@example.test', 'pending', $5),
       ($1::uuid, $2::uuid, 'post-signup-cancelled', 'buyer@example.test', 'cancelled', $6),
       ($1::uuid, $2::uuid, 'post-signup-paid-1', 'buyer@example.test', 'paid', $7),
       ($1::uuid, $2::uuid, 'post-signup-paid-2', 'buyer@example.test', 'paid', $8),
       ($1::uuid, $2::uuid, 'future-paid', 'buyer@example.test', 'paid', $9),
       ($1::uuid, $2::uuid, 'nonbuyer-refunded', 'nonbuyer@example.test', 'refunded', $10)`,
		tenantID,
		integrationID,
		buyerSignup.Add(-time.Hour),
		buyerSignup.Add(time.Hour),
		buyerSignup.Add(2*time.Hour),
		buyerSignup.Add(3*time.Hour),
		buyerSignup.Add(4*time.Hour),
		buyerSignup.Add(5*time.Hour),
		now.Add(24*time.Hour),
		nonBuyerSignup.Add(time.Hour),
	)

	funnel, err := NewService(pool).SubscriberFunnel(
		ctx,
		tenantID,
		"month",
		"created_at_month",
		"",
		12,
	)
	if err != nil {
		t.Fatalf("SubscriberFunnel: %v", err)
	}
	cohort := funnelCohortByLabel(t, funnel, cohortStart.Format("2006-01"))
	if cohort.SignupCount != 2 ||
		cohort.FirstPurchaseCount != 1 ||
		cohort.RepeatPurchaseCount != 1 ||
		cohort.FirstPurchaseRate != 50 ||
		cohort.RepeatPurchaseRate != 100 {
		t.Fatalf("paid post-signup funnel row is not truthful: %+v", cohort)
	}
	if len(funnel.Steps) != 3 ||
		funnel.Steps[0].Count != 2 ||
		funnel.Steps[1].Count != 1 ||
		funnel.Steps[2].Count != 1 {
		t.Fatalf("aggregate paid post-signup funnel is not truthful: %+v", funnel.Steps)
	}
}

func cohortByLabel(t *testing.T, rows []CohortRow, label string) CohortRow {
	t.Helper()
	for _, row := range rows {
		if row.CohortLabel == label {
			return row
		}
	}
	t.Fatalf("cohort %q not found in %+v", label, rows)
	return CohortRow{}
}

func funnelCohortByLabel(
	t *testing.T,
	funnel *SubscriberFunnel,
	label string,
) CohortFunnelRow {
	t.Helper()
	for _, row := range funnel.Cohorts {
		if row.CohortLabel == label {
			return row
		}
	}
	t.Fatalf("funnel cohort %q not found in %+v", label, funnel.Cohorts)
	return CohortFunnelRow{}
}
