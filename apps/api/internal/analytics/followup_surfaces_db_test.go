// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the 2026 follow-up analytics surfaces:
// cross-channel timeline, fatigue deciles, template leaderboard.
// Skip without DATABASE_URL (the established pg-backed pattern).
// Fixtures live under a throwaway tenant; cleanup is the tenant
// DELETE (campaigns / campaign_report_events / sms_* / subscribers
// all cascade on tenant_id; tenant-owned campaign_templates too).

package analytics

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func followupDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed analytics follow-up tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func followupUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func followupTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
	t.Helper()
	tenantID := followupUUID(t)
	slug := "anlfu-" + tenantID[:8]
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx2, err := db.WithTenant(ctx2, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx2.Rollback(ctx2) }()
		_, _ = tx2.Exec(ctx2, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx2.Commit(ctx2)
	})
	return tenantID
}

// followupExec runs one statement inside a tenant-bound tx + commits.
func followupExec(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, sql string, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %.60s...: %v", sql, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func followupQueryRowID(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, sql string, args ...any) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
		t.Fatalf("query %.60s...: %v", sql, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return id
}

func followupCampaign(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name, subject string) string {
	t.Helper()
	return followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, $2, $3, 'sent')
RETURNING id::text`, tenantID, name, subject)
}

// followupEvent inserts one campaign_report_events row at now()-ageMin
// minutes (kept inside the current partition + every query window).
func followupEvent(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID, email, eventType string, ageMin int) {
	t.Helper()
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_report_events (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, $3, $4, now() - make_interval(mins => $5::int))`,
		tenantID, campaignID, email, eventType, ageMin)
}

func followupDeliveryEvent(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID, email, messageID, eventType string, ageMin int) {
	t.Helper()
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_report_events
       (tenant_id, campaign_id, subscriber_email, message_id, event_type, at)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5,
        now() - make_interval(mins => $6::int))`,
		tenantID, campaignID, email, messageID, eventType, ageMin)
}

func followupSubscriber(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, email string) string {
	t.Helper()
	return followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email)
}

func TestCampaignReportRequiresTenantOwnedCampaignDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	repo := &Repo{Pool: pool}

	missingID := followupUUID(t)
	if _, err := repo.CampaignReport(ctx, tenantID, missingID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing campaign err = %v, want pgx.ErrNoRows", err)
	}
	otherCampaignID := followupCampaign(t, pool, ctx, otherTenantID, "other tenant", "secret")
	if _, err := repo.CampaignReport(ctx, tenantID, otherCampaignID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-tenant campaign err = %v, want nondisclosing pgx.ErrNoRows", err)
	}

	ownedCampaignID := followupCampaign(t, pool, ctx, tenantID, "owned empty", "empty")
	report, err := repo.CampaignReport(ctx, tenantID, ownedCampaignID)
	if err != nil {
		t.Fatalf("owned zero-event campaign: %v", err)
	}
	if report.CampaignID != ownedCampaignID || report.Sent != 0 {
		t.Fatalf("owned zero-event report = %#v", report)
	}
}

// ---------- cross-channel timeline ----------

func TestCrossChannelTimelineDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	svc := NewService(pool)

	email := "xct-" + tenantID[:8] + "@example.com"
	// The canonical SMS projection is currently North-America-only and the
	// database enforces a valid +1 NANP number. Keep this analytics fixture on
	// that same contract instead of relying on the pre-1992 global placeholder.
	phone := "+14155550123"
	subID := followupSubscriber(t, pool, ctx, tenantID, email)
	campID := followupCampaign(t, pool, ctx, tenantID, "xct campaign", "xct subject "+tenantID[:8])

	// Email events: sent (50m ago), opened (40m ago).
	followupEvent(t, pool, ctx, tenantID, campID, email, "sent", 50)
	followupEvent(t, pool, ctx, tenantID, campID, email, "opened", 40)
	// SMS consent (30m ago) links the phone to the email.
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO sms_consent_events (tenant_id, phone_e164, subscriber_email, action, proof_text, created_at)
VALUES ($1::uuid, $2, $3, 'granted', 'web form opt-in', now() - interval '30 minutes')`,
		tenantID, phone, email)
	// Outbound SMS delivered 20m ago (delivered_at wins the COALESCE).
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO sms_messages (tenant_id, phone_e164, direction, status, body, sent_at, delivered_at, created_at)
VALUES ($1::uuid, $2, 'outbound', 'delivered', 'hello from sms',
        now() - interval '21 minutes', now() - interval '20 minutes', now() - interval '22 minutes')`,
		tenantID, phone)

	out, err := svc.CrossChannelTimelineFor(ctx, tenantID, subID, nil, 0)
	if err != nil {
		t.Fatalf("CrossChannelTimelineFor: %v", err)
	}
	if len(out.Items) != 4 || out.HasMore {
		t.Fatalf("items = %d (has_more=%v), want 4 items, no more", len(out.Items), out.HasMore)
	}
	wantSeq := []struct{ channel, typ, label string }{
		{"sms", "delivered", "SMS delivered"},
		{"sms", "consent_granted", "SMS consent granted"},
		{"email", "opened", "Email opened"},
		{"email", "sent", "Email sent"},
	}
	for i, w := range wantSeq {
		it := out.Items[i]
		if it.Channel != w.channel || it.Type != w.typ || it.Label != w.label {
			t.Errorf("item %d = {%s %s %q}, want {%s %s %q}",
				i, it.Channel, it.Type, it.Label, w.channel, w.typ, w.label)
		}
		if i > 0 && it.At.After(out.Items[i-1].At) {
			t.Errorf("item %d: at %v after previous %v (want DESC)", i, it.At, out.Items[i-1].At)
		}
	}
	if out.Items[0].Detail != "hello from sms" {
		t.Errorf("sms detail = %q, want message body", out.Items[0].Detail)
	}
	if out.Items[1].Detail != "web form opt-in" {
		t.Errorf("consent detail = %q, want proof text", out.Items[1].Detail)
	}
	if out.Items[3].CampaignID != campID {
		t.Errorf("email campaign_id = %q, want %q", out.Items[3].CampaignID, campID)
	}

	// Keyset paging: limit 2 → has_more + next_before; the second page
	// (by email this time) returns the remaining 2.
	page1, err := svc.CrossChannelTimelineFor(ctx, tenantID, subID, nil, 2)
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1.Items) != 2 || !page1.HasMore || page1.NextBefore == "" {
		t.Fatalf("page 1 = %d items, has_more=%v, next_before=%q; want 2, true, set",
			len(page1.Items), page1.HasMore, page1.NextBefore)
	}
	cursor, err := time.Parse(time.RFC3339Nano, page1.NextBefore)
	if err != nil {
		t.Fatalf("next_before parse: %v", err)
	}
	page2, err := svc.CrossChannelTimelineFor(ctx, tenantID, email, &cursor, 2)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2.Items) != 2 || page2.HasMore {
		t.Fatalf("page 2 = %d items, has_more=%v; want 2, false", len(page2.Items), page2.HasMore)
	}
	if page2.Items[0].Type != "opened" || page2.Items[1].Type != "sent" {
		t.Errorf("page 2 types = %s, %s; want opened, sent",
			page2.Items[0].Type, page2.Items[1].Type)
	}

	// Unknown subscriber → typed 404 sentinel.
	if _, err := svc.CrossChannelTimelineFor(ctx, tenantID, "ghost@example.com", nil, 0); !errors.Is(err, errTimelineSubscriberNotFound) {
		t.Errorf("unknown subscriber err = %v, want errTimelineSubscriberNotFound", err)
	}
}

// ---------- fatigue ----------

func TestFatigueDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	otherTenantID := followupTenant(t, pool, ctx)
	svc := NewService(pool)

	campA := followupCampaign(t, pool, ctx, tenantID, "fatigue campaign A", "fatigue A "+tenantID[:8])
	campB := followupCampaign(t, pool, ctx, tenantID, "fatigue campaign B", "fatigue B "+tenantID[:8])
	orphanCamp := followupCampaign(t, pool, ctx, tenantID, "fatigue orphan outcome", "orphan "+tenantID[:8])
	heavy := "heavy-" + tenantID[:8] + "@example.com"
	light := "light-" + tenantID[:8] + "@example.com"

	// light has one campaign-recipient exposure. Duplicate provider-style
	// rows for every outcome must still produce exactly one send, one open,
	// and one unsubscribe rather than impossible rates above 100%.
	for i := 0; i < 4; i++ {
		followupEvent(t, pool, ctx, tenantID, campA, light, "sent", 90+i)
	}
	for i := 0; i < 5; i++ {
		followupEvent(t, pool, ctx, tenantID, campA, light, "opened", 80+i)
	}
	for i := 0; i < 3; i++ {
		followupEvent(t, pool, ctx, tenantID, campA, light, "unsubscribed", 70+i)
	}

	// heavy has two sent campaign-recipient exposures. Only campA has an
	// open and unsubscribe, so both rates are 1/2 despite duplicate rows.
	for i := 0; i < 3; i++ {
		followupEvent(t, pool, ctx, tenantID, campA, heavy, "sent", 60+i)
		followupEvent(t, pool, ctx, tenantID, campA, heavy, "opened", 50+i)
		followupEvent(t, pool, ctx, tenantID, campA, heavy, "unsubscribed", 40+i)
	}
	for i := 0; i < 2; i++ {
		followupEvent(t, pool, ctx, tenantID, campB, heavy, "sent", 30+i)
	}
	// Outcomes from a campaign with no send exposure in the selected
	// window do not inflate either numerator.
	for i := 0; i < 3; i++ {
		followupEvent(t, pool, ctx, tenantID, orphanCamp, heavy, "opened", 20+i)
		followupEvent(t, pool, ctx, tenantID, orphanCamp, heavy, "unsubscribed", 10+i)
	}

	// A mailed recipient in another tenant must never appear in this
	// tenant's deciles.
	otherCamp := followupCampaign(t, pool, ctx, otherTenantID, "other fatigue campaign", "other")
	followupEvent(
		t,
		pool,
		ctx,
		otherTenantID,
		otherCamp,
		"foreign-"+otherTenantID[:8]+"@example.com",
		"sent",
		5,
	)

	deciles, err := svc.Fatigue(ctx, tenantID, 30)
	if err != nil {
		t.Fatalf("Fatigue: %v", err)
	}
	// NTILE(10) over 2 mailed subscribers → 2 buckets, ascending sends.
	if len(deciles) != 2 {
		t.Fatalf("deciles = %d (%+v), want 2", len(deciles), deciles)
	}
	if deciles[0].SendsBucket != "1" || deciles[0].Subscribers != 1 {
		t.Errorf("decile 0 = %+v, want bucket \"1\" with 1 subscriber", deciles[0])
	}
	if deciles[0].OpenRate != 1 || deciles[0].UnsubRate != 1 {
		t.Errorf("decile 0 rates = %v/%v, want 1/1", deciles[0].OpenRate, deciles[0].UnsubRate)
	}
	if deciles[1].SendsBucket != "2" || deciles[1].Subscribers != 1 {
		t.Errorf("decile 1 = %+v, want bucket \"2\" with 1 subscriber", deciles[1])
	}
	if deciles[1].OpenRate != 0.5 || deciles[1].UnsubRate != 0.5 {
		t.Errorf("decile 1 rates = %v/%v, want 0.5/0.5", deciles[1].OpenRate, deciles[1].UnsubRate)
	}
	for i, decile := range deciles {
		if decile.OpenRate < 0 || decile.OpenRate > 1 ||
			decile.UnsubRate < 0 || decile.UnsubRate > 1 {
			t.Errorf("decile %d has an impossible rate: %+v", i, decile)
		}
	}
}

// ---------- template leaderboard ----------

func TestTemplateLeaderboardDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	svc := NewService(pool)

	sharedSubject := "Shared-" + tenantID // deliberately ambiguous
	tplA := followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO campaign_templates (tenant_id, slug, name, subject)
VALUES ($1::uuid, $2, 'Template A', $3)
RETURNING id::text`, tenantID, "tpl-a-"+tenantID[:8], sharedSubject)
	tplB := followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO campaign_templates (tenant_id, slug, name, subject)
VALUES ($1::uuid, $2, 'Template B', $3)
RETURNING id::text`, tenantID, "tpl-b-"+tenantID[:8], sharedSubject)
	subjC := "Legacy-C-" + tenantID
	tplC := followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO campaign_templates (tenant_id, slug, name, subject)
VALUES ($1::uuid, $2, 'Template C', $3)
RETURNING id::text`, tenantID, "tpl-c-"+tenantID[:8], subjC)
	tplRejected := followupQueryRowID(t, pool, ctx, tenantID, `
INSERT INTO campaign_templates (tenant_id, slug, name, subject, review_status)
VALUES ($1::uuid, $2, 'Rejected Template', $3, 'rejected')
RETURNING id::text`, tenantID, "tpl-rejected-"+tenantID[:8], "Rejected-"+tenantID)

	// Exact lineage is authoritative even when both legacy hints disagree.
	// A and B intentionally share a subject, c1 points delivery_settings at B,
	// and c2 points delivery_settings at A. source_template_id must still win.
	c1 := followupCampaign(t, pool, ctx, tenantID, "exact A", sharedSubject)
	followupExec(t, pool, ctx, tenantID, `
UPDATE campaigns
	 SET source_template_id = $2::uuid,
	     delivery_settings = COALESCE(delivery_settings, '{}'::jsonb)
	                         || jsonb_build_object('template_id', $3::text)
 WHERE tenant_id = $1::uuid AND id = $4::uuid`, tenantID, tplA, tplB, c1)

	c2 := followupCampaign(t, pool, ctx, tenantID, "exact B", "edited subject "+tenantID[:8])
	followupExec(t, pool, ctx, tenantID, `
UPDATE campaigns
	 SET source_template_id = $2::uuid,
	     delivery_settings = COALESCE(delivery_settings, '{}'::jsonb)
	                         || jsonb_build_object('template_id', $3::text)
 WHERE tenant_id = $1::uuid AND id = $4::uuid`, tenantID, tplB, tplA, c2)

	// Older campaigns with no exact lineage retain both bounded fallbacks.
	c3 := followupCampaign(t, pool, ctx, tenantID, "legacy delivery B", "edited legacy "+tenantID[:8])
	followupExec(t, pool, ctx, tenantID, `
UPDATE campaigns
	 SET delivery_settings = COALESCE(delivery_settings, '{}'::jsonb)
	                         || jsonb_build_object('template_id', $2::text)
 WHERE tenant_id = $1::uuid AND id = $3::uuid`, tenantID, tplB, c3)
	c4 := followupCampaign(t, pool, ctx, tenantID, "legacy subject C", subjC)
	// A campaign with neither exact nor legacy lineage remains absent.
	c5 := followupCampaign(t, pool, ctx, tenantID, "no template", "orphan "+tenantID[:8])
	// This campaign has a sent delivery outside the requested one-day window
	// and an open inside it. It must not inflate A's campaigns or open rate.
	c6 := followupCampaign(t, pool, ctx, tenantID, "historical send A", "edited historical "+tenantID[:8])
	followupExec(t, pool, ctx, tenantID, `
UPDATE campaigns
	 SET source_template_id = $2::uuid
 WHERE tenant_id = $1::uuid AND id = $3::uuid`, tenantID, tplA, c6)
	// Rejected templates remain queryable for audit but never appear in the
	// user-facing leaderboard, even with exact campaign lineage and sends.
	c7 := followupCampaign(t, pool, ctx, tenantID, "rejected exact", "rejected edited "+tenantID[:8])
	followupExec(t, pool, ctx, tenantID, `
UPDATE campaigns
	 SET source_template_id = $2::uuid
 WHERE tenant_id = $1::uuid AND id = $3::uuid`, tenantID, tplRejected, c7)

	rcpt := "lb-" + tenantID[:8] + "@example.com"
	for i := 0; i < 3; i++ {
		followupDeliveryEvent(t, pool, ctx, tenantID, c1, rcpt, fmt.Sprintf("a-%d", i), "sent", 30+i)
	}
	// Two retries for one delivery count as one unique open. A different
	// message_id on the same email has no in-window send and is ignored.
	followupDeliveryEvent(t, pool, ctx, tenantID, c1, rcpt, "a-0", "opened", 25)
	followupDeliveryEvent(t, pool, ctx, tenantID, c1, rcpt, "a-0", "opened", 24)
	followupDeliveryEvent(t, pool, ctx, tenantID, c1, rcpt, "a-1", "clicked", 23)
	followupDeliveryEvent(t, pool, ctx, tenantID, c1, rcpt, "a-no-send", "opened", 22)
	for i := 0; i < 5; i++ {
		followupDeliveryEvent(t, pool, ctx, tenantID, c2, rcpt, fmt.Sprintf("b-%d", i), "sent", 20+i)
	}
	followupDeliveryEvent(t, pool, ctx, tenantID, c2, rcpt, "b-0", "opened", 15)
	for i := 0; i < 2; i++ {
		email := fmt.Sprintf("legacy-%d-%s", i, rcpt)
		followupDeliveryEvent(t, pool, ctx, tenantID, c3, email, "", "sent", 10+i)
	}
	followupDeliveryEvent(t, pool, ctx, tenantID, c3, "legacy-0-"+rcpt, "", "opened", 9)
	followupDeliveryEvent(t, pool, ctx, tenantID, c4, "subject-"+rcpt, "", "sent", 8)
	followupDeliveryEvent(t, pool, ctx, tenantID, c5, "orphan-"+rcpt, "", "sent", 7)
	followupDeliveryEvent(t, pool, ctx, tenantID, c6, rcpt, "old-a", "sent", 2*24*60)
	followupDeliveryEvent(t, pool, ctx, tenantID, c6, rcpt, "old-a", "opened", 6)
	followupDeliveryEvent(t, pool, ctx, tenantID, c7, rcpt, "rejected-1", "sent", 5)

	items, err := svc.TemplateLeaderboard(ctx, tenantID, 1)
	if err != nil {
		t.Fatalf("TemplateLeaderboard: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("items = %d (%+v), want 3 (orphan campaign absent)", len(items), items)
	}
	// Ordered by sends DESC: B (5 exact + 2 legacy), A (3), C (1).
	b, a, c := items[0], items[1], items[2]
	if b.TemplateID != tplB || b.TemplateName != "Template B" {
		t.Errorf("items[0] = %+v, want Template B (%s)", b, tplB)
	}
	if b.CampaignsUsed != 2 || b.Sent != 7 || b.Opens != 2 || b.Clicks != 0 {
		t.Errorf("B counts = %+v, want used=2 sent=7 opens=2 clicks=0", b)
	}
	if b.OpenRate != 0.2857 || b.ClickRate != 0 {
		t.Errorf("B rates = %v/%v, want 0.2857/0", b.OpenRate, b.ClickRate)
	}
	if a.TemplateID != tplA || a.TemplateName != "Template A" {
		t.Errorf("items[1] = %+v, want Template A (%s)", a, tplA)
	}
	if a.CampaignsUsed != 1 || a.Sent != 3 || a.Opens != 1 || a.Clicks != 1 {
		t.Errorf("A counts = %+v, want used=1 sent=3 opens=1 clicks=1", a)
	}
	if a.OpenRate != 0.3333 || a.ClickRate != 0.3333 {
		t.Errorf("A rates = %v/%v, want 0.3333/0.3333", a.OpenRate, a.ClickRate)
	}
	if c.TemplateID != tplC || c.TemplateName != "Template C" || c.CampaignsUsed != 1 || c.Sent != 1 {
		t.Errorf("items[2] = %+v, want subject-fallback Template C (%s) with one send", c, tplC)
	}
}
