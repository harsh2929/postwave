// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// setTenantSendCeiling gives the tenant an hourly sending limit.
func setTenantSendCeiling(t *testing.T, pool *db.Pool, ctx context.Context, tenantID string, perHour int) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open sending-settings tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_sending_settings (tenant_id, max_sends_per_hour)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id) DO UPDATE SET max_sends_per_hour = EXCLUDED.max_sends_per_hour`,
		tenantID, perHour); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("set send ceiling: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit send ceiling: %v", err)
	}
}

// A slot that claims a time the send cannot keep.
//
// The audience check answers "will this reach anybody". Nothing answered "will
// it reach them WHEN the calendar says": a tenant limited to N/hour with an
// audience several times that has booked a send lasting hours, and the schedule
// screen said nothing. The person finds out by watching a progress bar crawl.
func TestSchedulingMoreRecipientsThanTheHourlyCeilingWarns(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-capacity-over")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "cap-a@example.com", status: "enabled"},
		{email: "cap-b@example.com", status: "enabled"},
		{email: "cap-c@example.com", status: "enabled"},
	})
	// THREE recipients against a ceiling of TWO, chosen so ceiling-division and
	// truncation give DIFFERENT answers: 2 hours vs 1. A 3-against-1 fixture
	// reports three hours under either rule and cannot tell them apart — the
	// mutation that swapped the arithmetic passed against it, which is how a
	// test ends up asserting a number rather than a behaviour.
	setTenantSendCeiling(t, pool, ctx, tenantID, 2)
	segmentID := seedSegment(t, pool, tenantID,
		`{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"}]}`)
	mine := seedSegmentCampaign(t, pool, ctx, tenantID, "Oversized", segmentID, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, nextWeekdayAt(10).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a long send is not a broken one and must "+
			"not be refused: %s", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), "capacity_warning") {
		t.Fatalf("a campaign that cannot finish inside its slot scheduled silently: %s",
			rec.Body.String())
	}
	// Ceiling division, not truncation: 3 recipients at 2/hour is TWO hours, and
	// truncation would say one. Rounding down under-reports the overrun in
	// exactly the just-over case somebody is most likely to wave through.
	if !contains(rec.Body.String(), "about 2 hours") {
		t.Fatalf("the warning does not say how long the send will take: %s", rec.Body.String())
	}
}

// A campaign that FITS must not be warned about, or the warning becomes noise
// people learn to dismiss — and then the real one is dismissed too.
func TestSchedulingWithinTheHourlyCeilingDoesNotWarn(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-capacity-fits")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "fit-a@example.com", status: "enabled"},
		{email: "fit-b@example.com", status: "enabled"},
	})
	setTenantSendCeiling(t, pool, ctx, tenantID, 5000)
	segmentID := seedSegment(t, pool, tenantID,
		`{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"}]}`)
	mine := seedSegmentCampaign(t, pool, ctx, tenantID, "Fits", segmentID, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, nextWeekdayAt(10).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "capacity_warning") {
		t.Fatalf("a campaign well inside the ceiling was warned about: %s", rec.Body.String())
	}
}

// NO ceiling configured is silence, and it is a different silence from "we
// checked and it fits". There is nothing to check against, and inventing a
// default would warn about a limit this tenant does not have.
func TestSchedulingWithNoCeilingConfiguredDoesNotWarn(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-capacity-none")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "none-a@example.com", status: "enabled"},
		{email: "none-b@example.com", status: "enabled"},
	})
	// Deliberately no tenant_sending_settings row.
	segmentID := seedSegment(t, pool, tenantID,
		`{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"}]}`)
	mine := seedSegmentCampaign(t, pool, ctx, tenantID, "Uncapped", segmentID, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, nextWeekdayAt(10).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "capacity_warning") {
		t.Fatalf("a tenant with no configured ceiling was warned against an "+
			"invented one: %s", rec.Body.String())
	}
}
