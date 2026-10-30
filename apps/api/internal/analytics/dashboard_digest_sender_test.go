// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The composition root hands the sender the configured platform sender, or ""
// when none is configured. Run must send as the configured one verbatim and
// fall back to its own default only for "", so an unconfigured deployment keeps
// sending exactly what it always sent.
func TestDigestSenderRunDefaultsTheSenderOnlyWhenUnset(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Run returns after its first tick, which a nil Pool makes a no-op.
	for _, tc := range []struct{ from, want string }{
		{"", "Moosewave Digest <digest@moosewave.com>"},
		{"Staging <noreply@staging.example.test>", "Staging <noreply@staging.example.test>"},
	} {
		sender := &DigestSender{From: tc.from}
		sender.Run(ctx)
		if sender.From != tc.want {
			t.Errorf("DigestSender{From: %q}.Run sends as %q, want %q", tc.from, sender.From, tc.want)
		}
	}
}

func TestRenderDigestPlainTextHasAllMetrics(t *testing.T) {
	r := DigestRecipient{
		Frequency:  "daily",
		TenantName: "Acme Co",
	}
	stats := &DashboardStats{
		SubscribersTotal:    1234,
		SubscribersAdded30d: 42,
		OpensTotal30d:       500,
		ClicksTotal30d:      80,
		BouncesTotal30d:     3,
		Previous: &PreviousWindow{
			SubscribersAdded: 30,
			OpensTotal:       400,
			ClicksTotal:      60,
			BouncesTotal:     5,
		},
	}
	subj, plain, html := renderDigest(r, stats)
	if !strings.Contains(subj, "daily") {
		t.Errorf("subject missing frequency: %s", subj)
	}
	for _, want := range []string{
		"Acme Co",
		"Subscribers (total)",
		"1,234",
		"New subscribers",
		"+12", // delta 42-30
		"Opens",
		"500",
		"Clicks",
		"80",
		"Bounces",
		"-2", // delta 3-5 (negative)
	} {
		if !strings.Contains(plain, want) {
			t.Errorf("plain digest missing %q\n---\n%s", want, plain)
		}
	}
	for _, want := range []string{
		"<html",
		"Acme Co",
		"1,234",
		"+12",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("html digest missing %q", want)
		}
	}
}

func TestRenderDigestWeeklyChangesPeriodLabel(t *testing.T) {
	r := DigestRecipient{Frequency: "weekly", TenantName: "x"}
	_, plain, _ := renderDigest(r, &DashboardStats{})
	if !strings.Contains(plain, "last 30 days") {
		t.Errorf("weekly digest should say 'last 30 days': %s", plain)
	}
}

func TestRenderDigestFallsBackToDefaultTenantName(t *testing.T) {
	r := DigestRecipient{Frequency: "daily", TenantName: "  "}
	_, plain, _ := renderDigest(r, &DashboardStats{})
	if !strings.Contains(plain, "Your workspace") {
		t.Errorf("plain digest should fall back to default tenant name: %s", plain)
	}
}

func TestFormatInt(t *testing.T) {
	cases := []struct {
		in  int
		out string
	}{
		{0, "0"},
		{1, "1"},
		{999, "999"},
		{1000, "1,000"},
		{1234567, "1,234,567"},
		{-1234, "-1,234"},
	}
	for _, c := range cases {
		if got := formatInt(c.in); got != c.out {
			t.Errorf("formatInt(%d) = %q, want %q", c.in, got, c.out)
		}
	}
}

func TestHtmlEscape(t *testing.T) {
	if got := htmlEscape("<a href=\"x\">&y'</a>"); got != "&lt;a href=&quot;x&quot;&gt;&amp;y&#39;&lt;/a&gt;" {
		t.Errorf("htmlEscape unexpected output: %s", got)
	}
}

func TestScheduleDigestRecipientsIsFairAndGloballyCapped(t *testing.T) {
	updated := time.Date(2026, time.July, 26, 0, 0, 0, 0, time.UTC)
	queue := func(tenantID string, users ...string) tenantDigestQueue {
		recipients := make([]dueDigestRecipient, 0, len(users))
		for i, userID := range users {
			recipients = append(recipients, dueDigestRecipient{
				DigestRecipient: DigestRecipient{
					UserID:   userID,
					TenantID: tenantID,
				},
				preferenceUpdatedAt: updated.Add(time.Duration(i) * time.Minute),
			})
		}
		return tenantDigestQueue{tenantID: tenantID, recipients: recipients}
	}

	got := scheduleDigestRecipients([]tenantDigestQueue{
		queue("tenant-c", "c1", "c2"),
		queue("tenant-a", "a1", "a2", "a3"),
		queue("tenant-b", "b1", "b2"),
	}, 5)
	gotUsers := make([]string, 0, len(got))
	for _, recipient := range got {
		gotUsers = append(gotUsers, recipient.UserID)
	}
	if want := []string{"a1", "b1", "c1", "a2", "b2"}; strings.Join(gotUsers, ",") != strings.Join(want, ",") {
		t.Fatalf("fair schedule = %v, want %v", gotUsers, want)
	}

	manyUsers := make([]string, 0, dashboardDigestBatchLimit+100)
	for i := 0; i < dashboardDigestBatchLimit+100; i++ {
		manyUsers = append(manyUsers, formatInt(i+1))
	}
	if got := scheduleDigestRecipients(
		[]tenantDigestQueue{queue("tenant-a", manyUsers...)},
		dashboardDigestBatchLimit+100,
	); len(got) != dashboardDigestBatchLimit {
		t.Fatalf("global batch size = %d, want hard cap %d", len(got), dashboardDigestBatchLimit)
	}

	if got := scheduleDigestRecipients([]tenantDigestQueue{{tenantID: "empty"}}, 10); len(got) != 0 {
		t.Fatalf("empty queue schedule = %v, want empty", got)
	}
}

func TestDigestDueRecipientsEnumeratesTenantsThenReentersRLSDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	dailyTenantID := followupTenant(t, pool, ctx)
	weeklyTenantID := followupTenant(t, pool, ctx)
	dailyUserID := digestTestUser(t, pool, ctx, dailyTenantID, "daily")
	weeklyUserID := digestTestUser(t, pool, ctx, weeklyTenantID, "weekly")
	freshUserID := digestTestUser(t, pool, ctx, dailyTenantID, "fresh")
	offUserID := digestTestUser(t, pool, ctx, weeklyTenantID, "off")

	followupExec(t, pool, ctx, dailyTenantID, `
INSERT INTO dashboard_digest_prefs
       (user_id, tenant_id, frequency, last_sent_at, updated_at)
VALUES ($1::uuid, $2::uuid, 'daily', NULL, now() - interval '2 days'),
       ($3::uuid, $2::uuid, 'daily', now(), now())`,
		dailyUserID, dailyTenantID, freshUserID)
	followupExec(t, pool, ctx, weeklyTenantID, `
INSERT INTO dashboard_digest_prefs
       (user_id, tenant_id, frequency, last_sent_at, updated_at)
VALUES ($1::uuid, $2::uuid, 'weekly', now() - interval '7 days', now() - interval '7 days'),
       ($3::uuid, $2::uuid, 'off', NULL, now() - interval '8 days')`,
		weeklyUserID, weeklyTenantID, offUserID)

	var rawVisible int
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM dashboard_digest_prefs
 WHERE tenant_id IN ($1::uuid, $2::uuid)`,
		dailyTenantID, weeklyTenantID,
	).Scan(&rawVisible); err != nil {
		t.Fatalf("raw RLS count: %v", err)
	}
	if rawVisible != 0 {
		t.Fatalf("raw unscoped preference read exposed %d rows, want 0", rawVisible)
	}

	sender := &DigestSender{Pool: pool}
	got, err := sender.dueRecipients(ctx)
	if err != nil {
		t.Fatalf("dueRecipients: %v", err)
	}
	byUser := make(map[string]DigestRecipient)
	for _, recipient := range got {
		if recipient.UserID == dailyUserID || recipient.UserID == weeklyUserID ||
			recipient.UserID == freshUserID || recipient.UserID == offUserID {
			byUser[recipient.UserID] = recipient
		}
	}
	if len(byUser) != 2 {
		t.Fatalf("fixture due recipients = %+v, want only daily and weekly users", byUser)
	}
	if got := byUser[dailyUserID]; got.TenantID != dailyTenantID ||
		got.Frequency != "daily" || got.Email == "" || got.TenantName == "" {
		t.Fatalf("daily recipient = %+v", got)
	}
	if got := byUser[weeklyUserID]; got.TenantID != weeklyTenantID ||
		got.Frequency != "weekly" || got.Email == "" || got.TenantName == "" {
		t.Fatalf("weekly recipient = %+v", got)
	}
}

func digestTestUser(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	label string,
) string {
	t.Helper()
	identity := label + "-" + tenantID[:8]
	return followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO users (tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2, $3, 'viewer')
RETURNING id::text`,
		tenantID,
		"digest-"+identity,
		identity+"@example.test",
	)
}
