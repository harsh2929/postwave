// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"time"
)

// A campaign placed on the calendar with no audience must say so.
//
// The schedule endpoint accepted any schedulable campaign and said nothing
// about who it would go to, so a campaign with no list and no segment sat there
// looking ready until the scheduler ticked — possibly at 3am, possibly to
// nobody.
func TestSchedulingACampaignWithNoAudienceWarns(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-no-aud")
	// No list, no segment.
	mine := seedUnaddressedCampaign(t, pool, ctx, tenantID, "Unaddressed", "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, nextWeekdayAt(10).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — booking a slot before the audience is "+
			"finalised is ordinary practice: %s", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.String(), "audience_warning") {
		t.Fatalf("a campaign with no audience scheduled silently. Nobody learns "+
			"until the scheduler fires: %s", rec.Body.String())
	}
}

// And a campaign WITH a real audience must not be warned about, or the warning
// becomes noise people dismiss.
func TestSchedulingACampaignWithRecipientsDoesNotWarn(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-with-aud")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "aud-a@example.com", status: "enabled"},
		{email: "aud-b@example.com", status: "enabled"},
	})
	segmentID := seedSegment(t, pool, tenantID,
		`{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"}]}`)
	mine := seedSegmentCampaign(t, pool, ctx, tenantID, "Addressed", segmentID, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, nextWeekdayAt(11).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "audience_warning") {
		t.Fatalf("a campaign with eligible recipients was warned about its "+
			"audience; the warning is noise and people will learn to ignore it: %s",
			rec.Body.String())
	}
}

// Unscheduling must not warn: pulling a campaign OFF the calendar does not need
// to be told its audience is empty.
func TestUnschedulingNeverWarnsAboutTheAudience(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-unsched-aud")
	at := nextWeekdayAt(12)
	mine := seedUnaddressedCampaign(t, pool, ctx, tenantID, "Unaddressed", "scheduled", &at)

	rec := postSchedule(t, router, ctx, tenantID, mine, `{"scheduled_at":null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "audience_warning") {
		t.Fatalf("unscheduling warned about the audience: %s", rec.Body.String())
	}
}

// seedUnaddressedCampaign creates a campaign with neither a list nor a segment.
//
// `audience_list_id` is a bigint, so "no list" is NULL — an empty string is a
// cast error, not an absent audience.
func seedUnaddressedCampaign(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name, status string, at *time.Time) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, scheduled_at)
VALUES ($1::uuid, $2, 'subject', $3, '<p>hi {{ unsubscribe_url }}</p>', $4)
RETURNING id::text`, tenantID, name, status, at).Scan(&id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed unaddressed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit unaddressed campaign: %v", err)
	}
	return id
}
