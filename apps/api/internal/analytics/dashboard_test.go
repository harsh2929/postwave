// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestRangeLabel(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "30d"},
		{"7d", "7d"},
		{"30d", "30d"},
		{"90d", "90d"},
		{"garbage", "30d"},
		{"1d", "30d"},
	}
	for _, c := range cases {
		if got := rangeLabel(c.in); got != c.want {
			t.Errorf("rangeLabel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRangeDays(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"7d", 7},
		{"30d", 30},
		{"90d", 90},
		{"", 30},
		{"garbage", 30},
	}
	for _, c := range cases {
		if got := rangeDays(c.in); got != c.want {
			t.Errorf("rangeDays(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestDetectAnomalySimple(t *testing.T) {
	cases := []struct {
		name      string
		values    []int
		threshold float64
		want      bool
	}{
		{"flat series", []int{5, 5, 5, 5, 5}, 2.5, false},
		{"short series ignored", []int{10, 10, 1000}, 2.5, false},
		{"empty ignored", []int{}, 2.5, false},
		{"single value ignored", []int{42}, 2.5, false},
		{"genuine spike fires", []int{2, 3, 2, 4, 3, 2, 3, 2, 4, 100}, 2.5, true},
		// Mean 10.4 std ~1.02 → tail of 12 gives z≈1.57 (well below 2.5).
		{"below threshold doesn't fire", []int{10, 11, 9, 12, 10, 12}, 2.5, false},
		// Tail < mean shouldn't fire (we only flag positive outliers — bounce
		// rate of zero is good, not anomalous).
		{"drop to zero doesn't fire", []int{10, 11, 9, 12, 10, 0}, 2.5, false},
		// Zero-variance prior cannot detect anomalies (avoid div-by-zero).
		{"zero variance doesn't fire", []int{5, 5, 5, 5, 100}, 2.5, false},
	}
	for _, c := range cases {
		if got := detectAnomalySimple(c.values, c.threshold); got != c.want {
			t.Errorf("%s: detectAnomalySimple(%v, %v) = %v, want %v",
				c.name, c.values, c.threshold, got, c.want)
		}
	}
}

func TestDashboardInboxHealthState(t *testing.T) {
	cases := []struct {
		score int
		want  string
	}{
		{100, "Healthy"},
		{90, "Healthy"},
		{89, "Good"},
		{75, "Good"},
		{74, "Watch"},
		{60, "Watch"},
		{59, "Degraded"},
		{40, "Degraded"},
		{39, "Critical"},
		{0, "Critical"},
	}
	for _, c := range cases {
		if got := dashboardInboxHealthState(c.score); got != c.want {
			t.Errorf("dashboardInboxHealthState(%d) = %q, want %q", c.score, got, c.want)
		}
	}
}

func TestDashboardStatsHandler503WhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/dashboard/stats", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).DashboardStats(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503, body=%s", rec.Code, rec.Body.String())
	}
}

func TestDashboardStatsHandlerAcceptsNewQueryParams(t *testing.T) {
	// With repo missing this still 503s — but proves the handler doesn't
	// reject the new query params before reaching the guard.
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(
		ctx, http.MethodGet,
		"/api/v1/dashboard/stats?range=7d&compare=false&sparklines=false", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).DashboardStats(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (only repo missing should fail); body=%s",
			rec.Code, rec.Body.String())
	}
}

func TestDashboardStatsHandlerRejectsMissingTenant(t *testing.T) {
	// No tenant in context → 401 even with no repo.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/dashboard/stats", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).DashboardStats(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%s", rec.Code, rec.Body.String())
	}
}

func TestDashboardStatsCountsActiveSequencesDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	insertSequence := func(tenantID, name, status string) {
		t.Helper()
		followupExec(t, pool, ctx, tenantID, `
INSERT INTO voice_sequences (tenant_id, name, status, emails)
VALUES ($1::uuid, $2, $3, '[]'::jsonb)`,
			tenantID, name, status)
	}
	insertSequence(tenantID, "active one", "active")
	insertSequence(tenantID, "active two", "active")
	insertSequence(tenantID, "draft sequence", "draft")
	insertSequence(tenantID, "archived sequence", "archived")
	insertSequence(otherTenantID, "other tenant active", "active")

	stats, err := (&Repo{Pool: pool}).DashboardStatsWithOptions(
		ctx, tenantID, DashboardStatsOptions{},
	)
	if err != nil {
		t.Fatalf("DashboardStatsWithOptions: %v", err)
	}
	if got := stats.ActiveSequencesCount; got != 2 {
		t.Fatalf("ActiveSequencesCount = %d, want 2", got)
	}
}

func TestDashboardStatsCountsUniqueRecipientsAcrossCurrentAndPreviousWindowsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "rate campaign", "rate subject")
	otherCampaignID := followupCampaign(t, pool, ctx, otherTenantID, "other rate", "other subject")

	for _, eventType := range []string{"delivered", "opened", "opened"} {
		followupEvent(t, pool, ctx, tenantID, campaignID, "alice@example.com", eventType, 5)
	}
	for _, eventType := range []string{"clicked", "clicked", "bounced", "bounced", "sent", "sent"} {
		followupEvent(t, pool, ctx, tenantID, campaignID, "alice@example.com", eventType, 5)
	}
	for _, eventType := range []string{"delivered", "opened"} {
		followupEvent(t, pool, ctx, tenantID, campaignID, "bob@example.com", eventType, 4)
	}
	for _, eventType := range []string{"clicked", "sent"} {
		followupEvent(t, pool, ctx, tenantID, campaignID, "bob@example.com", eventType, 4)
	}
	// An open without a matching delivered event is counted as a unique open;
	// clients can safely fall back to the unique-sent denominator.
	for _, eventType := range []string{"opened", "clicked", "sent"} {
		followupEvent(t, pool, ctx, tenantID, campaignID, "proxy@example.com", eventType, 3)
	}
	for _, eventType := range []string{"sent", "delivered", "opened", "clicked", "bounced"} {
		followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_report_events (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, NULL, $3, now() - interval '2 minutes')`,
			tenantID, campaignID, eventType)
	}

	// The immediately preceding seven-day window has duplicate provider
	// events too. Every unique count must deduplicate the same
	// (campaign_id, subscriber_email) pair independently per event type.
	previousAgeMinutes := 8 * 24 * 60
	for _, eventType := range []string{
		"sent", "sent", "delivered", "delivered", "opened", "opened",
		"clicked", "clicked", "bounced", "bounced",
	} {
		followupEvent(t, pool, ctx, tenantID, campaignID, "old-alice@example.com", eventType, previousAgeMinutes)
	}
	for _, eventType := range []string{"sent", "delivered", "opened"} {
		followupEvent(t, pool, ctx, tenantID, campaignID, "old-bob@example.com", eventType, previousAgeMinutes)
	}
	for _, eventType := range []string{"sent", "delivered", "opened", "clicked", "bounced"} {
		followupEvent(t, pool, ctx, otherTenantID, otherCampaignID, "other@example.com", eventType, 1)
	}

	stats, err := (&Repo{Pool: pool}).DashboardStatsWithOptions(ctx, tenantID, DashboardStatsOptions{
		Range:   "7d",
		Compare: true,
	})
	if err != nil {
		t.Fatalf("DashboardStatsWithOptions: %v", err)
	}
	if got := stats.UniqueOpens30d; got != 3 {
		t.Fatalf("UniqueOpens30d = %d, want 3", got)
	}
	if got := stats.UniqueDelivered30d; got != 2 {
		t.Fatalf("UniqueDelivered30d = %d, want 2", got)
	}
	if got := stats.UniqueClicks30d; got != 3 {
		t.Fatalf("UniqueClicks30d = %d, want 3", got)
	}
	if got := stats.UniqueBounces30d; got != 1 {
		t.Fatalf("UniqueBounces30d = %d, want 1", got)
	}
	if got := stats.UniqueSent30d; got != 3 {
		t.Fatalf("UniqueSent30d = %d, want 3", got)
	}
	if stats.Previous == nil {
		t.Fatal("Previous = nil, want comparison window")
	}
	if got := stats.Previous.UniqueOpens; got != 2 {
		t.Fatalf("Previous.UniqueOpens = %d, want 2", got)
	}
	if got := stats.Previous.UniqueClicks; got != 1 {
		t.Fatalf("Previous.UniqueClicks = %d, want 1", got)
	}
	if got := stats.Previous.UniqueBounces; got != 1 {
		t.Fatalf("Previous.UniqueBounces = %d, want 1", got)
	}
	if got := stats.Previous.UniqueDelivered; got != 2 {
		t.Fatalf("Previous.UniqueDelivered = %d, want 2", got)
	}
	if got := stats.Previous.UniqueSent; got != 2 {
		t.Fatalf("Previous.UniqueSent = %d, want 2", got)
	}
}

func TestDashboardStatsUsesOneUnsubscribeDefinitionAcrossWindowsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	currentSubscriberID := followupSubscriber(
		t,
		pool,
		ctx,
		tenantID,
		"current-unsub-"+tenantID[:8]+"@example.test",
	)
	previousSubscriberID := followupSubscriber(
		t,
		pool,
		ctx,
		tenantID,
		"previous-unsub-"+tenantID[:8]+"@example.test",
	)
	legacyBlocklistedID := followupSubscriber(
		t,
		pool,
		ctx,
		tenantID,
		"legacy-blocklisted-"+tenantID[:8]+"@example.test",
	)
	otherSubscriberID := followupSubscriber(
		t,
		pool,
		ctx,
		otherTenantID,
		"other-unsub-"+otherTenantID[:8]+"@example.test",
	)

	insertRemoval := func(scope, subscriberID, age string) {
		t.Helper()
		followupExec(t, pool, ctx, scope, `
INSERT INTO list_subscribers
    (tenant_id, list_id, subscriber_id, email, source, removed_at)
SELECT $1::uuid, gen_random_uuid(), id, email, 'admin', now() - $3::interval
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			scope,
			subscriberID,
			age,
		)
	}
	// Multiple list removals for the same subject still represent one
	// dashboard unsubscribe in each window.
	insertRemoval(tenantID, currentSubscriberID, "1 day")
	insertRemoval(tenantID, currentSubscriberID, "2 days")
	insertRemoval(tenantID, previousSubscriberID, "9 days")
	insertRemoval(tenantID, previousSubscriberID, "10 days")
	insertRemoval(otherTenantID, otherSubscriberID, "1 day")

	// The historical comparison used a different proxy: blocklisted
	// subscriber.updated_at. Keep one such row in the prior window to prove it
	// no longer enters the list-removal metric.
	followupExec(t, pool, ctx, tenantID, `
UPDATE subscribers
   SET status = 'blocklisted',
       updated_at = now() - interval '9 days'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID,
		legacyBlocklistedID,
	)

	stats, err := (&Repo{Pool: pool}).DashboardStatsWithOptions(
		ctx,
		tenantID,
		DashboardStatsOptions{Range: "7d", Compare: true},
	)
	if err != nil {
		t.Fatalf("DashboardStatsWithOptions: %v", err)
	}
	if got := stats.SubscribersUnsubbed30d; got != 1 {
		t.Fatalf("current unsubscribes = %d, want 1 distinct list removal", got)
	}
	if stats.Previous == nil {
		t.Fatal("Previous = nil, want comparison")
	}
	if got := stats.Previous.SubscribersUnsubbed; got != 1 {
		t.Fatalf("previous unsubscribes = %d, want 1 distinct list removal", got)
	}
}

func TestDashboardStatsReadsInboxHealthSnapshotDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	staleTenantID := followupTenant(t, pool, ctx)
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO deliverability_hub_snapshots (tenant_id, score, sampled_at)
VALUES
  ($1::uuid, 45, now() - interval '2 hours'),
  ($1::uuid, 82, now() - interval '1 minute')`, tenantID)
	followupExec(t, pool, ctx, otherTenantID, `
INSERT INTO deliverability_hub_snapshots (tenant_id, score, sampled_at)
VALUES ($1::uuid, 12, now())`, otherTenantID)
	followupExec(t, pool, ctx, staleTenantID, `
INSERT INTO deliverability_hub_snapshots (tenant_id, score, sampled_at)
VALUES ($1::uuid, 97, now() - interval '25 hours')`, staleTenantID)

	stats, err := (&Repo{Pool: pool}).DashboardStatsWithOptions(
		ctx, tenantID, DashboardStatsOptions{},
	)
	if err != nil {
		t.Fatalf("DashboardStatsWithOptions: %v", err)
	}
	if stats.InboxHealth == nil {
		t.Fatal("InboxHealth is nil, want latest snapshot")
	}
	if got := stats.InboxHealth.Score; got != 82 {
		t.Fatalf("InboxHealth.Score = %d, want 82", got)
	}
	if got := stats.InboxHealth.State; got != "Good" {
		t.Fatalf("InboxHealth.State = %q, want Good", got)
	}

	staleStats, err := (&Repo{Pool: pool}).DashboardStatsWithOptions(
		ctx, staleTenantID, DashboardStatsOptions{},
	)
	if err != nil {
		t.Fatalf("DashboardStatsWithOptions stale tenant: %v", err)
	}
	if staleStats.InboxHealth != nil {
		t.Fatalf("stale tenant InboxHealth = %+v, want nil", staleStats.InboxHealth)
	}
}

func TestDashboardStatsDoesNotExposeRecentAuditDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, actor_type, actor_label, at)
VALUES
  ($1::uuid, 'subscriber.created', 'subscriber', 'sub-1', 'human', 'Mira', now() - interval '2 minutes'),
  ($1::uuid, 'audit.read.list', 'audit_log', '', 'system', NULL, now() - interval '1 minute'),
  ($1::uuid, 'campaign.sent', 'campaign', 'camp-1', 'system', NULL, now())`,
		tenantID)
	followupExec(t, pool, ctx, otherTenantID, `
INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, actor_type, actor_label, at)
VALUES ($1::uuid, 'other.tenant', 'workspace', '', 'system', NULL, now())`,
		otherTenantID)

	stats, err := (&Repo{Pool: pool}).DashboardStatsWithOptions(
		ctx, tenantID, DashboardStatsOptions{},
	)
	if err != nil {
		t.Fatalf("DashboardStatsWithOptions: %v", err)
	}
	if got := len(stats.RecentAudit); got != 0 {
		t.Fatalf(
			"len(RecentAudit) = %d, want 0 behind read:reports: %+v",
			got,
			stats.RecentAudit,
		)
	}
}

// TestDashboardStatsResponseShapeStable guards against accidental
// breakages of the wire contract — the omitempty fields must not be
// emitted when zero so existing snapshot tests + mobile clients stay
// happy.
func TestDashboardStatsResponseShapeStable(t *testing.T) {
	stats := &DashboardStats{
		SubscribersTotal: 10,
	}
	body, err := json.Marshal(stats)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(body)
	for _, mustNotContain := range []string{"\"range\"", "\"previous\"", "\"sparklines\"", "\"anomalies\"", "\"inbox_health\"", "\"recent_audit\""} {
		if containsField(s, mustNotContain) {
			t.Errorf("zero-value DashboardStats emitted unwanted field %s in: %s", mustNotContain, s)
		}
	}
	// AUDIT-DESKTOP-2026-06-10 §1.1: the true per-recipient send count
	// is always emitted (no omitempty) — the desktop rate denominators
	// depend on it, even when zero.
	if !containsField(s, "\"emails_sent_30d\"") {
		t.Errorf("zero-value DashboardStats missing emails_sent_30d in: %s", s)
	}
	if !containsField(s, "\"active_sequences_count\"") {
		t.Errorf("zero-value DashboardStats missing active_sequences_count in: %s", s)
	}
	for _, uniqueField := range []string{
		"\"unique_opens_30d\"",
		"\"unique_clicks_30d\"",
		"\"unique_bounces_30d\"",
		"\"unique_delivered_30d\"",
		"\"unique_sent_30d\"",
	} {
		if !containsField(s, uniqueField) {
			t.Errorf("zero-value DashboardStats missing %s in: %s", uniqueField, s)
		}
	}
	// Now with the fields populated they should appear.
	stats.Range = "30d"
	stats.Previous = &PreviousWindow{}
	stats.Sparklines = map[string][]int{"opens": {1, 2}}
	stats.Anomalies = map[string]bool{"bounces": true}
	stats.InboxHealth = &InboxHealth{Score: 92, State: "Healthy"}
	stats.RecentAudit = []DashboardAuditEvent{{
		ID:          "1",
		Action:      "campaign.sent",
		Actor:       "system",
		At:          time.Unix(0, 0).UTC(),
		Description: "campaign.sent",
	}}
	body, err = json.Marshal(stats)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s = string(body)
	for _, mustContain := range []string{"\"range\"", "\"previous\"", "\"sparklines\"", "\"anomalies\"", "\"inbox_health\"", "\"recent_audit\""} {
		if !containsField(s, mustContain) {
			t.Errorf("populated DashboardStats missing field %s in: %s", mustContain, s)
		}
	}
	// The previous window carries its own per-recipient send count.
	if !containsField(s, "\"emails_sent\"") {
		t.Errorf("populated DashboardStats missing previous-window emails_sent in: %s", s)
	}
	for _, uniqueField := range []string{
		"\"unique_opens\"",
		"\"unique_clicks\"",
		"\"unique_bounces\"",
		"\"unique_delivered\"",
		"\"unique_sent\"",
	} {
		if !containsField(s, uniqueField) {
			t.Errorf("populated DashboardStats missing previous-window %s in: %s", uniqueField, s)
		}
	}
}

func containsField(s, needle string) bool {
	return len(s) > 0 && len(needle) > 0 && (indexOf(s, needle) >= 0)
}

func indexOf(s, needle string) int {
	for i := 0; i+len(needle) <= len(s); i++ {
		if s[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
