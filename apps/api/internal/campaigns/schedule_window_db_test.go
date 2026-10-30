// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The send window must actually stop a send, and the change must leave a record.
//
// `tenant_send_window_policies.enforcement` accepted block|warn|off since it
// shipped and nothing outside its own CRUD package ever read it: an operator
// could set "block", see it saved and rendered back, and every send would ignore
// it. And `campaigns.scheduled_at` held the current intent with no history, so
// "who moved this off Monday, and did anything object" was unanswerable the
// moment the value was overwritten.

func setWindow(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, start, end, tz, enforcement string, weekdays int) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_send_window_policies
    (tenant_id, start_local, end_local, timezone, weekday_bitmap, enforcement)
VALUES ($1::uuid, $2::time, $3::time, $4, $5, $6)
ON CONFLICT (tenant_id) DO UPDATE
   SET start_local = EXCLUDED.start_local, end_local = EXCLUDED.end_local,
       timezone = EXCLUDED.timezone, weekday_bitmap = EXCLUDED.weekday_bitmap,
       enforcement = EXCLUDED.enforcement`,
		tenantID, start, end, tz, weekdays, enforcement); err != nil {
		_ = tx.Rollback(ctx)
		// Fatal, never Skip. The suite already skips wholesale when there is no
		// DATABASE_URL; reaching here means a database IS present and the table
		// this feature owns does not accept what the feature writes. Skipping
		// would report PASS for every send-window test in this file.
		t.Fatalf("seed send window policy: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit window: %v", err)
	}
}

func scheduleVersions(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID string) []struct {
	Outcome string
	Reason  string
	From    *time.Time
	To      *time.Time
} {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT outcome, reason, from_at, to_at FROM campaign_schedule_versions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid ORDER BY id`, tenantID, campaignID)
	if err != nil {
		t.Fatalf("read versions: %v", err)
	}
	defer rows.Close()
	var out []struct {
		Outcome string
		Reason  string
		From    *time.Time
		To      *time.Time
	}
	for rows.Next() {
		var r struct {
			Outcome string
			Reason  string
			From    *time.Time
			To      *time.Time
		}
		if err := rows.Scan(&r.Outcome, &r.Reason, &r.From, &r.To); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, r)
	}
	return out
}

// nextWeekdayAt returns the next occurrence of hour:00 UTC on a weekday, so the
// fixture never lands on a weekend and never in the past.
func nextWeekdayAt(hour int) time.Time {
	at := time.Now().UTC().Add(24 * time.Hour)
	for at.Weekday() == time.Saturday || at.Weekday() == time.Sunday {
		at = at.Add(24 * time.Hour)
	}
	return time.Date(at.Year(), at.Month(), at.Day(), hour, 0, 0, 0, time.UTC)
}

const allWeekdays = 1<<time.Monday | 1<<time.Tuesday | 1<<time.Wednesday |
	1<<time.Thursday | 1<<time.Friday

func TestABlockingWindowRefusesAnOutOfHoursSend(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-window-block")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "out-of-hours")
	setWindow(t, pool, ctx, tenantID, "09:00", "17:00", "UTC", "block", allWeekdays)

	at := nextWeekdayAt(3) // 03:00 UTC, well outside 09:00-17:00
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 — a blocking send window was ignored, "+
			"which is the state it was in since it shipped. body=%s",
			rec.Code, rec.Body.String())
	}
	// The campaign is untouched.
	if got, _ := readScheduleRow(t, pool, ctx, tenantID, id); got != nil {
		t.Fatalf("the campaign was scheduled anyway, to %v", got)
	}
	// And the refusal is recorded — three refused attempts is a person fighting
	// a policy, which a success-only table cannot show.
	versions := scheduleVersions(t, pool, ctx, tenantID, id)
	if len(versions) != 1 || versions[0].Outcome != "refused" {
		t.Fatalf("versions = %+v, want one refused entry", versions)
	}
	if versions[0].Reason == "" {
		t.Error("the refusal recorded no reason; an operator sees it was blocked " +
			"and not why")
	}
}

// `warn` allows the send AND tells the person. A warning nobody sees is the
// same as no policy.
func TestAWarningWindowAllowsTheSendAndSaysSo(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-window-warn")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "late-but-allowed")
	setWindow(t, pool, ctx, tenantID, "09:00", "17:00", "UTC", "warn", allWeekdays)

	at := nextWeekdayAt(3)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a warn policy must not block. body=%s",
			rec.Code, rec.Body.String())
	}
	if got, _ := readScheduleRow(t, pool, ctx, tenantID, id); got == nil {
		t.Fatal("a warn policy prevented the schedule")
	}
	if body := rec.Body.String(); !contains(body, "send_window_warning") {
		t.Fatalf("the response carries no warning, so the person never learns "+
			"their send is out of hours: %s", body)
	}
	versions := scheduleVersions(t, pool, ctx, tenantID, id)
	if len(versions) != 1 || versions[0].Outcome != "warned" {
		t.Fatalf("versions = %+v, want one warned entry", versions)
	}
}

// A send inside the window proceeds cleanly and is recorded as a plain schedule.
func TestAnInHoursSendIsAcceptedAndRecorded(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-window-ok")
	// A real audience. This test is about the send WINDOW accepting an in-hours
	// time and recording it as `scheduled`; without recipients the schedule now
	// also carries an audience warning and the outcome is `warned`, which is
	// correct behaviour and would make this assert the wrong thing.
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "inhours-a@example.com", status: "enabled"},
	})
	segmentID := seedSegment(t, pool, tenantID,
		`{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"}]}`)
	id := seedSegmentCampaign(t, pool, ctx, tenantID, "in-hours", segmentID, "draft", nil)
	setWindow(t, pool, ctx, tenantID, "09:00", "17:00", "UTC", "block", allWeekdays)

	at := nextWeekdayAt(12)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("an in-hours send was refused: %d %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); contains(body, "send_window_warning") {
		t.Errorf("an in-hours send carried a warning: %s", body)
	}
	versions := scheduleVersions(t, pool, ctx, tenantID, id)
	if len(versions) != 1 || versions[0].Outcome != "scheduled" {
		t.Fatalf("versions = %+v, want one scheduled entry", versions)
	}
	if versions[0].Reason != "" {
		t.Errorf("a clean accept recorded a reason: %q", versions[0].Reason)
	}
}

// A tenant with no policy is unaffected. Inventing business hours would refuse
// a 3am send somebody deliberately scheduled.
func TestATenantWithNoWindowIsUnaffected(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-no-window")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "any-time")

	at := nextWeekdayAt(3)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("a tenant with no send window was refused: %d %s", rec.Code, rec.Body.String())
	}
}

// The history must say what the send moved FROM, not only where it landed.
func TestTheHistoryRecordsWhatTheSendMovedFrom(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-history")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "moved-twice")

	first := nextWeekdayAt(10)
	second := first.Add(24 * time.Hour)
	for _, at := range []time.Time{first, second} {
		rec := postSchedule(t, router, ctx, tenantID, id,
			fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
		if rec.Code != http.StatusOK {
			t.Fatalf("schedule: %d %s", rec.Code, rec.Body.String())
		}
	}
	// And unschedule.
	if rec := postSchedule(t, router, ctx, tenantID, id, `{"scheduled_at":null}`); rec.Code != http.StatusOK {
		t.Fatalf("unschedule: %d %s", rec.Code, rec.Body.String())
	}

	versions := scheduleVersions(t, pool, ctx, tenantID, id)
	if len(versions) != 3 {
		t.Fatalf("versions = %d, want 3 (two schedules and an unschedule): %+v",
			len(versions), versions)
	}
	if versions[2].Outcome != "unscheduled" || versions[2].To != nil {
		t.Errorf("the unschedule was recorded as %+v", versions[2])
	}

	// The second row must know it moved off the first time.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var fromAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT from_at FROM campaign_schedule_versions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid ORDER BY id OFFSET 1 LIMIT 1`,
		tenantID, id).Scan(&fromAt); err != nil {
		t.Fatalf("read from_at: %v", err)
	}
	if fromAt == nil {
		t.Fatal("the second schedule recorded no from_at; the history cannot " +
			"answer \"who moved it off Monday\"")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	}()
}

// fingerprintGate is an ApprovalGate whose verification answer is controlled by
// the test. Only VerifyApprovedFingerprint is exercised; the other methods are
// present to satisfy the interface and fail loudly if the schedule path ever
// starts calling them, which it has no business doing.
type fingerprintGate struct {
	matches bool
	calls   int
}

func (g *fingerprintGate) EnsureCampaignSendApproved(context.Context, string, string, string, ApprovalActor) (*ApprovalState, error) {
	panic("the schedule path must not create or consume approvals")
}

func (g *fingerprintGate) MarkApprovalConsumed(context.Context, string, string) error {
	panic("the schedule path must not create or consume approvals")
}

func (g *fingerprintGate) VerifyApprovedFingerprint(context.Context, string, string, string) (bool, error) {
	g.calls++
	return g.matches, nil
}

// Rescheduling an approved campaign must say so AT THE TIME.
//
// The send path already refuses a campaign whose approved fingerprint has moved,
// and ScheduledAt is part of that fingerprint — so this was already broken by a
// reschedule. What was missing is being told: somebody drags a campaign,
// everything looks fine, and the send is refused hours later by a rule they
// never saw.
func TestReschedulingAnApprovedCampaignWarnsImmediately(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	gate := &fingerprintGate{matches: false} // the approval no longer matches
	d := &Deps{Repo: &Repo{Pool: pool}, Approvals: gate}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-approval")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "approved-then-moved")

	at := nextWeekdayAt(11)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — rescheduling an approved campaign is "+
			"legitimate; the approval simply has to be sought again. body=%s",
			rec.Code, rec.Body.String())
	}
	if gate.calls == 0 {
		t.Fatal("the approval was never checked at schedule time; the person " +
			"learns their send is blocked only when it fails hours later")
	}
	if body := rec.Body.String(); !contains(body, "approval_warning") {
		t.Fatalf("no approval warning in the response: %s", body)
	}
	// And it is on the record, so "why was this send refused" is answerable.
	versions := scheduleVersions(t, pool, ctx, tenantID, id)
	if len(versions) != 1 || versions[0].Outcome != "warned" {
		t.Fatalf("versions = %+v, want one warned entry", versions)
	}
	if versions[0].Reason == "" {
		t.Error("the warning was not recorded on the schedule version")
	}
}

// A campaign whose approval still matches must NOT be warned about. A warning on
// every reschedule is a warning nobody reads.
func TestReschedulingAStillApprovedCampaignIsSilent(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	gate := &fingerprintGate{matches: true}
	d := &Deps{Repo: &Repo{Pool: pool}, Approvals: gate}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-approval-ok")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "still-approved")

	at := nextWeekdayAt(11)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); contains(body, "approval_warning") {
		t.Fatalf("a still-valid approval produced a warning: %s", body)
	}
}

// With no approvals service the schedule path is unchanged — a deployment
// without approvals must not start warning about them.
func TestWithNoApprovalGateThereIsNoApprovalWarning(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}} // Approvals nil
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-no-approvals")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "no-gate")

	at := nextWeekdayAt(11)
	rec := postSchedule(t, router, ctx, tenantID, id,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); contains(body, "approval_warning") {
		t.Fatalf("a deployment with no approvals warned about one: %s", body)
	}
}

// insertCampaignOnList creates a campaign addressed to a specific list, so two
// of them can genuinely share an audience.
func insertCampaignOnList(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name, listID, status string, at *time.Time) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, audience_list_id, scheduled_at)
VALUES ($1::uuid, $2, 'subject', $3, '<p>hi {{ unsubscribe_url }}</p>', $4::bigint, $5)
RETURNING id::text`, tenantID, name, status, listID, at).Scan(&id); err != nil {
		_ = tx.Rollback(ctx)
		// Fatal, never Skip. A skipped fixture reports PASS, and five mutations
		// against this file all "passed" for exactly that reason before the
		// -v output showed every test had been skipped on a missing table.
		t.Fatalf("seed campaign on list: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

// newListID returns a distinct audience id.
//
// audience_list_id is a BIGINT — the accessor returns it as a string, and the
// collision query compares `audience_list_id::text`. Seeding a uuid here made
// every one of these tests fail on the INSERT, which the fixture then reported
// as a skip.
var listSeq atomic.Int64

func newListID() string {
	return strconv.FormatInt(900_000_000+listSeq.Add(1), 10)
}

// Two campaigns landing on one audience in one inbox session.
//
// Nothing checked for this: a person scheduling from the calendar sees their own
// campaign and not the one a colleague placed an hour earlier on the same list.
func TestSchedulingOntoAnAudienceThatAlreadyHasASendWarns(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-collide")
	listID := newListID()
	neighbourAt := nextWeekdayAt(10)
	insertCampaignOnList(t, pool, ctx, tenantID, "Colleague's send", listID, "scheduled", &neighbourAt)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "My send", listID, "draft", nil)

	// One hour later — inside the two-hour window.
	at := neighbourAt.Add(time.Hour)
	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a clash is a warning, not a refusal: "+
			"two sends to one list in an hour is sometimes exactly right. body=%s",
			rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !contains(body, "collision_warning") {
		t.Fatalf("no collision warning; the audience gets two emails in one inbox "+
			"session and nobody was told: %s", body)
	}
	if !contains(body, "Colleague's send") {
		t.Errorf("the warning does not NAME the other campaign, so the person "+
			"cannot go and look at it: %s", body)
	}
}

// Far enough apart is not a clash. A warning on every ordinary schedule is one
// people learn to dismiss, which costs the warnings that matter.
func TestASendWellClearOfAnotherDoesNotWarn(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-no-collide")
	listID := newListID()
	neighbourAt := nextWeekdayAt(10)
	insertCampaignOnList(t, pool, ctx, tenantID, "Morning send", listID, "scheduled", &neighbourAt)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Evening send", listID, "draft", nil)

	at := neighbourAt.Add(6 * time.Hour)
	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "collision_warning") {
		t.Fatalf("sends six hours apart warned; a warning that fires on every "+
			"ordinary schedule is one people learn to dismiss: %s", rec.Body.String())
	}
}

// A different audience at the same instant is not a clash.
func TestADifferentAudienceAtTheSameTimeDoesNotWarn(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-other-aud")
	spring := newListID()
	winter := newListID()
	at := nextWeekdayAt(10)
	insertCampaignOnList(t, pool, ctx, tenantID, "Spring send", spring, "scheduled", &at)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Winter send", winter, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "collision_warning") {
		t.Fatalf("two different lists at one instant warned: %s", rec.Body.String())
	}
}

// Rescheduling a campaign must not warn about ITSELF.
func TestReschedulingDoesNotCollideWithItself(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-self")
	listID := newListID()
	at := nextWeekdayAt(10)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Only send", listID, "scheduled", &at)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Add(30*time.Minute).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "collision_warning") {
		t.Fatalf("a campaign warned about clashing with itself, so every "+
			"reschedule would warn: %s", rec.Body.String())
	}
}

// A DRAFT with a date is an intention, not a send. Warning about one would make
// the calendar noisy with sends nobody has committed to.
func TestADraftNeighbourDoesNotWarn(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-draft-neighbour")
	listID := newListID()
	neighbourAt := nextWeekdayAt(10)
	insertCampaignOnList(t, pool, ctx, tenantID, "Someone's idea", listID, "draft", &neighbourAt)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Real send", listID, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, neighbourAt.Add(time.Hour).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if contains(rec.Body.String(), "collision_warning") {
		t.Fatalf("a DRAFT neighbour produced a clash warning: %s", rec.Body.String())
	}
}

// seedSegmentCampaign addresses a campaign to a SEGMENT rather than a list.
//
// `segment_id` is the column the repo writes and reads; `audience_segment_id`
// exists on the same table and is never populated. Seeding the one the product
// actually uses is what makes this test able to catch the bug it was written
// for.
func seedSegmentCampaign(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name, segmentID, status string, at *time.Time) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, segment_id, scheduled_at)
VALUES ($1::uuid, $2, 'subject', $3, '<p>hi {{ unsubscribe_url }}</p>', $4::uuid, $5)
RETURNING id::text`, tenantID, name, status, segmentID, at).Scan(&id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign on segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

// The segment half of the advisory, which was dead on arrival.
//
// The collision query read `audience_segment_id` — a column on `campaigns` that
// nothing writes — so every segment-addressed campaign was compared against
// NULL and never collided. It looked precisely like a healthy "no clash found",
// which is the failure mode that survives review. Found by an adversarial
// reviewer, not by five mutations: the mutation that replaced the entire
// audience predicate was caught by the LIST tests, and no segment test existed.
func TestTwoCampaignsOnOneSegmentCollide(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-seg-collide")
	segmentID := seedSegment(t, pool, tenantID, `{"op":"and","children":[]}`)
	neighbourAt := nextWeekdayAt(10)
	seedSegmentCampaign(t, pool, ctx, tenantID, "Colleague's segment send", segmentID, "scheduled", &neighbourAt)
	mine := seedSegmentCampaign(t, pool, ctx, tenantID, "My segment send", segmentID, "draft", nil)

	at := neighbourAt.Add(time.Hour)
	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, at.Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !contains(body, "collision_warning") {
		t.Fatalf("two campaigns on ONE segment an hour apart produced no warning. "+
			"The advisory is inert for every segment-addressed campaign: %s", body)
	}
	if !contains(body, "Colleague's segment send") {
		t.Errorf("the warning does not name the other campaign: %s", body)
	}
}

// And a different segment at the same instant must stay quiet, so the test
// above cannot pass by the segment predicate matching everything.
func TestADifferentSegmentAtTheSameTimeDoesNotWarn(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-seg-distinct")
	theirs := seedSegment(t, pool, tenantID, `{"op":"and","children":[]}`)
	ours := seedSegment(t, pool, tenantID, `{"op":"and","children":[]}`)
	neighbourAt := nextWeekdayAt(10)
	seedSegmentCampaign(t, pool, ctx, tenantID, "Their segment", theirs, "scheduled", &neighbourAt)
	mine := seedSegmentCampaign(t, pool, ctx, tenantID, "Our segment", ours, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, neighbourAt.Add(time.Minute).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); contains(body, "collision_warning") {
		t.Fatalf("two DIFFERENT segments warned about each other; the predicate "+
			"matches any segment and the advisory is noise: %s", body)
	}
}

// ---------------------------------------------------------------------------
// Written after an adversarial review found four real defects here, three of
// them in code that five mutations had already "passed". Each test below names
// the defect it exists for.
// ---------------------------------------------------------------------------

// The response must be ONE shape whether or not something objected.
//
// It used to return the bare campaign on a clean accept and
// {"campaign": {...}, "collision_warning": ...} when warned. The shipped desktop
// client types this `ApiResult<Campaign>` and assigns `result.data` straight
// into the detail pane, so a successful-but-warned schedule would have replaced
// the campaign with an object having no id, status or scheduled_at — and the
// warning that caused it was never rendered anyway.
func TestAWarnedScheduleReturnsTheSameShapeAsACleanOne(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-shape")
	listID := newListID()
	neighbourAt := nextWeekdayAt(10)
	insertCampaignOnList(t, pool, ctx, tenantID, "Neighbour", listID, "scheduled", &neighbourAt)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", listID, "draft", nil)

	warned := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, neighbourAt.Add(time.Hour).Format(time.RFC3339)))
	if warned.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", warned.Code, warned.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(warned.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, wrapped := body["campaign"]; wrapped {
		t.Fatal("the warned response nests the campaign under a \"campaign\" key. " +
			"A client typed against the clean shape assigns this object to its " +
			"detail state and loses every field.")
	}
	for _, field := range []string{"id", "status", "scheduled_at"} {
		if _, ok := body[field]; !ok {
			t.Errorf("the warned response has no %q at the top level; it is not a campaign", field)
		}
	}
	if body["collision_warning"] == "" || body["collision_warning"] == nil {
		t.Error("no collision_warning on a response that should carry one")
	}
	// And a clean accept must not carry empty warning keys, so adding this
	// feature did not change the bytes an existing client already parses.
	clean := postSchedule(t, router, ctx, tenantID,
		insertCampaignOnList(t, pool, ctx, tenantID, "Alone", newListID(), "draft", nil),
		fmt.Sprintf(`{"scheduled_at":%q}`, nextWeekdayAt(15).Format(time.RFC3339)))
	var cleanBody map[string]any
	if err := json.Unmarshal(clean.Body.Bytes(), &cleanBody); err != nil {
		t.Fatalf("decode clean: %v", err)
	}
	for _, k := range []string{"collision_warning", "send_window_warning", "approval_warning"} {
		if _, present := cleanBody[k]; present {
			t.Errorf("a clean accept carries an empty %q key", k)
		}
	}
}

// A colleague's campaign must not become invisible the moment it starts sending
// — and one that ALREADY WENT OUT is the case that matters most, because that
// mail cannot be recalled.
func TestASendingOrAlreadySentNeighbourStillWarns(t *testing.T) {
	for _, status := range []string{"sending", "sent"} {
		t.Run(status, func(t *testing.T) {
			pool := dbForIntegration(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			d := &Deps{Repo: &Repo{Pool: pool}}
			router := scheduleRouter(d)

			tenantID := setupTenantQ(t, pool, ctx, "sched-inflight-"+status)
			listID := newListID()
			neighbourAt := nextWeekdayAt(10)
			insertCampaignOnList(t, pool, ctx, tenantID, "Colleague "+status, listID, status, &neighbourAt)
			mine := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", listID, "draft", nil)

			rec := postSchedule(t, router, ctx, tenantID, mine,
				fmt.Sprintf(`{"scheduled_at":%q}`, neighbourAt.Add(time.Hour).Format(time.RFC3339)))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
			}
			if !contains(rec.Body.String(), "collision_warning") {
				t.Fatalf("a %s neighbour produced no warning. The audience has "+
					"already received or is receiving that mail, which is the exact "+
					"harm this advisory names: %s", status, rec.Body.String())
			}
		})
	}
}

// A collision must be visible in the audit trail, not only in the response.
//
// No collision test read campaign_schedule_versions at all, so dropping the
// collision from the outcome expression would have filed a clash as a clean
// `scheduled` carrying a non-empty reason, and nothing would have failed.
func TestACollisionIsRecordedAsWarnedWithItsReason(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-audit")
	listID := newListID()
	neighbourAt := nextWeekdayAt(10)
	insertCampaignOnList(t, pool, ctx, tenantID, "Neighbour", listID, "scheduled", &neighbourAt)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", listID, "draft", nil)

	if rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, neighbourAt.Add(time.Hour).Format(time.RFC3339))); rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	versions := scheduleVersions(t, pool, ctx, tenantID, mine)
	if len(versions) != 1 {
		t.Fatalf("%d audit rows, want 1", len(versions))
	}
	if versions[0].Outcome != "warned" {
		t.Errorf("outcome = %q, want \"warned\"; a clash filed as a clean schedule "+
			"is invisible to anybody reviewing the history", versions[0].Outcome)
	}
	if !contains(versions[0].Reason, "Neighbour") {
		t.Errorf("reason = %q; it does not name what objected", versions[0].Reason)
	}
}

// A name of multi-byte characters must not destroy the audit row.
//
// The truncation was `reason[:1000]`, a BYTE slice, against a column bounded in
// CHARACTERS. Length was never the problem — the mid-rune cut was: Postgres
// rejected the invalid UTF-8, and because the recorder is best-effort the
// request still returned 200 with no record written.
func TestAMultiByteCampaignNameStillRecordsTheAuditRow(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-utf8")
	listID := newListID()
	neighbourAt := nextWeekdayAt(10)
	insertCampaignOnList(t, pool, ctx, tenantID, strings.Repeat("🙂", 300), listID, "scheduled", &neighbourAt)
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", listID, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, neighbourAt.Add(time.Hour).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if got := scheduleVersions(t, pool, ctx, tenantID, mine); len(got) != 1 {
		t.Fatalf("%d audit rows, want 1. A neighbour named in emoji silently "+
			"destroyed the record this feature exists to produce, and the request "+
			"still reported success.", len(got))
	}
}

// truncateReason is bounded in characters and cuts on a rune boundary.
func TestTruncateReasonNeverSplitsARune(t *testing.T) {
	long := strings.Repeat("🙂", 1500)
	got := truncateReason(long)
	if !utf8.ValidString(got) {
		t.Fatal("truncation produced invalid UTF-8; Postgres refuses the INSERT " +
			"and the audit row is lost while the request reports success")
	}
	if n := utf8.RuneCountInString(got); n != 1000 {
		t.Errorf("kept %d characters, want 1000", n)
	}
	// Exactly at the bound is untouched — an off-by-one here silently shortens
	// every reason.
	exact := strings.Repeat("a", 1000)
	if truncateReason(exact) != exact {
		t.Error("a reason exactly at the limit was truncated")
	}
}

// The window bound is on the SEPARATION between two sends and is inclusive.
func TestTheCollisionWindowBoundIsExactlyTwoHoursInclusive(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	for _, tc := range []struct {
		name string
		gap  time.Duration
		warn bool
	}{
		{"one minute inside", 2*time.Hour - time.Minute, true},
		{"exactly on the bound", 2 * time.Hour, true},
		{"one minute outside", 2*time.Hour + time.Minute, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tenantID := setupTenantQ(t, pool, ctx, "sched-bound")
			listID := newListID()
			neighbourAt := nextWeekdayAt(10)
			insertCampaignOnList(t, pool, ctx, tenantID, "Neighbour", listID, "scheduled", &neighbourAt)
			mine := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", listID, "draft", nil)

			rec := postSchedule(t, router, ctx, tenantID, mine,
				fmt.Sprintf(`{"scheduled_at":%q}`, neighbourAt.Add(tc.gap).Format(time.RFC3339)))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
			}
			if got := contains(rec.Body.String(), "collision_warning"); got != tc.warn {
				t.Fatalf("warned = %v at a %v separation, want %v", got, tc.gap, tc.warn)
			}
		})
	}
}

// With more clashes than the name cap, the COUNT must still be the real one.
func TestTheClashCountIsNotCappedByTheNameLimit(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-count")
	listID := newListID()
	base := nextWeekdayAt(10)
	for i := 0; i < 15; i++ {
		at := base.Add(time.Duration(i) * time.Minute)
		insertCampaignOnList(t, pool, ctx, tenantID, fmt.Sprintf("Neighbour %02d", i), listID, "scheduled", &at)
	}
	mine := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", listID, "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, mine,
		fmt.Sprintf(`{"scheduled_at":%q}`, base.Add(30*time.Minute).Format(time.RFC3339)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !contains(body, "15 other campaigns") {
		t.Fatalf("the warning does not report all 15 clashes — a count taken after "+
			"the name cap understates the pile-up in the one direction that "+
			"matters: %s", body)
	}
}

// A refusal must record what it tried to move the send AWAY from.
//
// Every refusal passed nil for `from_at` because the prior value was read after
// the window check — so the audit rows most likely to be asked about ("they
// tried to move it to 3am") were missing the other half of the sentence.
func TestARefusedScheduleRecordsWhatItMovedFrom(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-refuse-from")
	setWindow(t, pool, ctx, tenantID, "09:00", "17:00", "UTC", "block", allWeekdays)

	at := nextWeekdayAt(10)
	campaignID := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", newListID(), "scheduled", &at)

	// 3am UTC is outside the 09:00–17:00 window, so this is refused.
	outside := at.UTC().Truncate(24*time.Hour).AddDate(0, 0, 1).Add(3 * time.Hour)
	rec := postSchedule(t, router, ctx, tenantID, campaignID,
		fmt.Sprintf(`{"scheduled_at":%q}`, outside.Format(time.RFC3339)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	versions := scheduleVersions(t, pool, ctx, tenantID, campaignID)
	if len(versions) != 1 {
		t.Fatalf("%d audit rows, want 1", len(versions))
	}
	if versions[0].Outcome != "refused" {
		t.Fatalf("outcome = %q, want refused", versions[0].Outcome)
	}
	if versions[0].From == nil {
		t.Fatal("the refused row records no from_at. \"They tried to move it to " +
			"3am\" without \"from Tuesday 10am\" is half the sentence, and this " +
			"is the row somebody actually goes looking for.")
	}
}

// A time refused for being in the past is recorded too.
func TestAPastScheduleIsRecordedAsRefused(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := &Deps{Repo: &Repo{Pool: pool}}
	router := scheduleRouter(d)

	tenantID := setupTenantQ(t, pool, ctx, "sched-refuse-past")
	campaignID := insertCampaignOnList(t, pool, ctx, tenantID, "Mine", newListID(), "draft", nil)

	rec := postSchedule(t, router, ctx, tenantID, campaignID,
		fmt.Sprintf(`{"scheduled_at":%q}`, time.Now().Add(-48*time.Hour).Format(time.RFC3339)))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	versions := scheduleVersions(t, pool, ctx, tenantID, campaignID)
	if len(versions) != 1 || versions[0].Outcome != "refused" {
		t.Fatalf("audit rows = %+v; a repeated attempt to drop a card on last "+
			"Tuesday is exactly the confusion this history should surface", versions)
	}
}
