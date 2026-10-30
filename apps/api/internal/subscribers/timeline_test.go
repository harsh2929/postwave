package subscribers

// Pure-function tests for the timeline aggregator. The DB-backed
// GetTimeline / loadTimelineEvents / loadTimelineStats helpers run real
// SQL with RLS enabled — they're covered by integration tests under
// services/automation. Here we exercise:
//
//   * computeEngagement formula behaviour (clamp, missing signals,
//     sample calc against the comment in timeline.go)
//   * coalesceSubject SELECT-shape branch
//   * mapCurrentStatus normalisation
//   * Timeline HTTP handler error branches that don't need a DB
//     (bad cursor, missing tenant)

import (
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestComputeEngagement_NoSignal — a brand-new subscriber with zero
// sends and no LastActiveAt should score 0 (not NaN, not negative).
func TestComputeEngagement_NoSignal(t *testing.T) {
	got := computeEngagement(TimelineStats{}, time.Now())
	if got != 0 {
		t.Errorf("computeEngagement({}) = %v, want 0", got)
	}
}

// TestComputeEngagement_Sample — matches the worked example in the
// timeline.go doc comment. SentCount=10, OpenedCount=4, ClickedCount=2,
// RepliedCount=1, LastActiveAt=now-3d.
func TestComputeEngagement_Sample(t *testing.T) {
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	last := now.Add(-72 * time.Hour)
	stats := TimelineStats{
		SentCount:    10,
		OpenedCount:  4,
		ClickedCount: 2,
		RepliedCount: 1,
		LastActiveAt: &last,
	}
	got := computeEngagement(stats, now)
	want := 0.6524 // see timeline.go sample calc
	if math.Abs(got-want) > 0.001 {
		t.Errorf("computeEngagement(sample) = %v, want ~%v", got, want)
	}
}

// TestComputeEngagement_ClampedHigh — extreme values clamp to 1.0.
func TestComputeEngagement_ClampedHigh(t *testing.T) {
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	last := now
	stats := TimelineStats{
		SentCount:    1,
		OpenedCount:  100,
		ClickedCount: 100,
		RepliedCount: 100,
		LastActiveAt: &last,
	}
	got := computeEngagement(stats, now)
	if got != 1.0 {
		t.Errorf("clamped high = %v, want 1.0", got)
	}
}

// TestComputeEngagement_OldRecency — last active a year ago drops
// recency to ~0 and frequency/reply alone control the result.
func TestComputeEngagement_OldRecency(t *testing.T) {
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	last := now.AddDate(-1, 0, 0)
	stats := TimelineStats{
		SentCount:    10,
		OpenedCount:  10, // perfect open rate
		LastActiveAt: &last,
	}
	got := computeEngagement(stats, now)
	// recency ≈ exp(-365/30) ≈ 5e-6 → 0.5*5e-6 ≈ 0
	// frequency = 10/10 = 1 → 0.3*1 = 0.3
	// reply = 0
	// total ≈ 0.30
	if got < 0.299 || got > 0.302 {
		t.Errorf("old-recency score = %v, want ~0.30", got)
	}
}

// TestComputeEngagement_NoSentCount — no sent_count means
// frequency+reply collapse to 0 even with rich activity.
func TestComputeEngagement_NoSentCount(t *testing.T) {
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	last := now
	stats := TimelineStats{
		OpenedCount:  100,
		ClickedCount: 100,
		LastActiveAt: &last,
	}
	got := computeEngagement(stats, now)
	// recency = 1.0 → 0.5; frequency=0, reply=0 → 0.5
	if got != 0.5 {
		t.Errorf("no-sent score = %v, want 0.5", got)
	}
}

// TestComputeEngagement_FutureLastActive — clock skew shouldn't
// over-reward (recency stays at 1.0, never above).
func TestComputeEngagement_FutureLastActive(t *testing.T) {
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	future := now.Add(48 * time.Hour)
	stats := TimelineStats{
		SentCount:    1,
		OpenedCount:  1,
		LastActiveAt: &future,
	}
	got := computeEngagement(stats, now)
	// recency clamps at 1, frequency=1, reply=0 → 0.5+0.3 = 0.8
	if got < 0.799 || got > 0.801 {
		t.Errorf("future last-active score = %v, want ~0.8", got)
	}
}

// TestCoalesceSubject — the SELECT expression flips between the joined
// column and an empty-string literal so the outer column count stays
// stable.
func TestCoalesceSubject(t *testing.T) {
	if got := coalesceSubject(true); got != "COALESCE(c.subject, '')" {
		t.Errorf("with campaigns: %q", got)
	}
	if got := coalesceSubject(false); got != "''::text" {
		t.Errorf("without campaigns: %q", got)
	}
}

// TestMapCurrentStatus_Normalisation — every listmonk status maps to
// the corresponding drill-down state, including pending consent.
func TestMapCurrentStatus_Normalisation(t *testing.T) {
	cases := map[string]string{
		StatusEnabled:     "active",
		StatusUnconfirmed: "unconfirmed",
		" UNCONFIRMED ":   "unconfirmed",
		StatusDisabled:    "unsubscribed",
		"unsubscribed":    "unsubscribed",
		StatusBlocklisted: "suppressed",
		"bounced":         "bounced",
		"weird":           "active", // safe default
		"":                "active",
		" ENABLED ":       "active", // whitespace+case forgiving
	}
	for in, want := range cases {
		if got := mapCurrentStatus(in); got != want {
			t.Errorf("mapCurrentStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestTimeline_RequiresTenant — without a tenant the handler must
// 401 before any pool access (so we can pass a nil Repo here).
func TestTimeline_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest("GET", "/api/v1/subscribers/abc/timeline", nil)
	w := httptest.NewRecorder()
	d.Timeline(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestTimelineCursorRoundTrip(t *testing.T) {
	event := TimelineEvent{
		OccurredAt: time.Date(2026, 5, 9, 12, 0, 0, 123, time.UTC),
		Source:     "subscriber_events",
		Type:       "clicked",
		SubjectID:  "campaign-42",
	}
	cursor, err := decodeTimelineCursor(encodeTimelineCursor(event))
	if err != nil {
		t.Fatal(err)
	}
	if !cursor.At.Equal(event.OccurredAt) || cursor.Source != event.Source ||
		cursor.Type != event.Type || cursor.SubjectID != event.SubjectID {
		t.Fatalf("cursor = %+v, want event position %+v", cursor, event)
	}
	if _, err := decodeTimelineCursor("not-a-cursor"); err == nil {
		t.Fatal("expected malformed opaque cursor to fail")
	}
}

func TestTimelineCategoryIsClosedAndServerMapped(t *testing.T) {
	for _, raw := range []string{"", "all", " ENGAGEMENT ", "delivery", "consent", "profile"} {
		category, err := ParseTimelineCategory(raw)
		if err != nil {
			t.Fatalf("ParseTimelineCategory(%q): %v", raw, err)
		}
		if category != TimelineCategoryAll && len(timelineCategoryTypes(category)) == 0 {
			t.Fatalf("category %q has no server-side event mapping", category)
		}
	}
	if _, err := ParseTimelineCategory("everything"); err == nil {
		t.Fatal("unknown category was accepted")
	}
}

func TestTimelineRejectsUnknownCategoryBeforeDatabase(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := subscriberTenantRequest(http.MethodGet,
		"/api/v1/subscribers/abc/timeline?category=everything", "")
	rec := httptest.NewRecorder()
	d.Timeline(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_category") {
		t.Fatalf("status/body = %d %s, want invalid_category", rec.Code, rec.Body.String())
	}
}

// TestTimeline_PaginationDefaults — limit clamping logic is exercised
// inside GetTimeline; here we sanity-check the constants.
func TestTimeline_PaginationDefaults(t *testing.T) {
	if defaultTimelineLimit <= 0 {
		t.Errorf("defaultTimelineLimit must be > 0")
	}
	if maxTimelineLimit < defaultTimelineLimit {
		t.Errorf("maxTimelineLimit (%d) < default (%d)", maxTimelineLimit, defaultTimelineLimit)
	}
}

// TestTimeline_EmptySubscriber — the response shape for a tenant with
// no events must still include the 'added' branch (which the SQL always
// emits) plus zero-valued stats. We exercise the mapper by calling
// computeEngagement on a fresh-zero stats and verifying the score
// stays at 0 (no signal yet).
func TestTimeline_EmptySubscriber(t *testing.T) {
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	stats := TimelineStats{
		SubscribedAt:  now.Add(-24 * time.Hour),
		CurrentStatus: "active",
	}
	if got := computeEngagement(stats, now); got != 0 {
		t.Errorf("empty subscriber score = %v, want 0", got)
	}
}

func TestBuildEngagementDaily30d(t *testing.T) {
	now := time.Date(2026, 7, 10, 18, 30, 0, 0, time.UTC)
	rows := []engagementDay{
		{Day: time.Date(2026, 6, 11, 0, 0, 0, 0, time.UTC), Count: 2},
		{Day: time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC), Count: 3},
		{Day: time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC), Count: 1},
		{Day: time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC), Count: 99},
	}

	got := buildEngagementDaily30d(now, rows)
	if len(got) != 30 {
		t.Fatalf("len = %d, want 30", len(got))
	}
	if got[0] != 2 || got[28] != 3 || got[29] != 1 {
		t.Fatalf("series boundary values = (%d, %d, %d), want (2, 3, 1)", got[0], got[28], got[29])
	}
}
