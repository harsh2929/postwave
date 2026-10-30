// SPDX-License-Identifier: AGPL-3.0-only
//
// broadcasts_db_test.go — DB-backed tests for SMS broadcasts. Skip
// without DATABASE_URL (same pattern as the other pg-backed suites).
// Fixtures live under a throwaway tenant; cleanup is the tenant DELETE
// (sms_* tables, subscribers, segments and sms_broadcasts all cascade
// on tenant_id).
//
// Covered here:
//   - audience resolution: consent (opted_in only), suppression
//     filtering (active vs expired), list union + phone de-dup, tag and
//     segment audiences linked through sms_subscriptions.subscriber_email;
//   - send idempotency: the draft|scheduled → sending claim enqueues
//     exactly once; a replayed send reports Enqueued=0 with stable totals;
//   - quiet-hours holds counted as "held" in progress (the worker
//     requeues with error_code='quiet_hours'; progress counts those);
//   - env-capped audience size (typed audience_too_large);
//   - future scheduled_at → 'scheduled', the worker due-sweep finds it
//     once due, and the worker send path enqueues it.

package sms

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func broadcastDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed sms broadcast test")
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

// broadcastUUID builds a v4-format UUID from crypto/rand without
// adding a uuid dependency to the module's direct requirements.
func broadcastUUID(t *testing.T) string {
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

// createBroadcastTenant inserts a throwaway tenant. The tenants RLS
// insert/delete policies require app.tenant_id = id, so the id is
// generated client-side and the GUC bound before each statement.
func createBroadcastTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	tenantID := broadcastUUID(t)
	slug := "smsbcast-" + tenantID[:8]
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
		// A tenant delete fans out through the full migrated schema. The
		// Route40 tenant-composite FKs add more cascade work, so five seconds can
		// roll the cleanup back on an otherwise healthy local PostgreSQL and
		// leave globally unique provider receiver fixtures behind for the next
		// test. Keep the deadline bounded but large enough to finish the real
		// cascade.
		ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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

func broadcastExec(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, sql string, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql[:min(len(sql), 60)], err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func broadcastQueryRow(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, sql string, dest []any, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, sql, args...).Scan(dest...); err != nil {
		t.Fatalf("query %q: %v", sql[:min(len(sql), 60)], err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func createSMSSender(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string) string {
	t.Helper()
	id := broadcastUUID(t)
	seed, err := strconv.ParseUint(id[:8], 16, 32)
	if err != nil {
		t.Fatalf("derive unique sender phone: %v", err)
	}
	digits := seed % 100_000_000
	phone := fmt.Sprintf("+12%02d2%02d%04d", digits/1_000_000, (digits/10_000)%100, digits%10_000)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_sender_profiles (id, tenant_id, provider, phone_number, registration_status)
VALUES ($1::uuid, $2::uuid, 'twilio', $3, 'approved')`, id, tenantID, phone)
	return id
}

func createSMSList(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, name string) string {
	t.Helper()
	id := broadcastUUID(t)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_lists (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, $3)`, id, tenantID, name)
	return id
}

// seedSubscription inserts an sms_subscriptions row. email may be ""
// (no linked email subscriber).
func seedSubscription(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, listID, phone, status, email string) {
	t.Helper()
	if status == "opted_in" {
		broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_consent_events (
  tenant_id, list_id, phone_e164, subscriber_email, action, source,
  proof_text, provider, metadata
) VALUES (
  $1::uuid, $2::uuid, $3, NULLIF($4, ''), 'granted', 'api',
  'Affirmative test consent', 'product',
  '{"evidence_type":"operator_attestation","evidence_id":"route40-db-fixture"}'::jsonb
)`, tenantID, listID, phone, email)
	}
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_subscriptions (
  tenant_id, list_id, phone_e164, status, subscriber_email, consent_source,
  consent_text, consent_at, opt_out_at, proof
)
VALUES (
  $1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), 'api',
  CASE WHEN $4 = 'opted_in' THEN 'Affirmative test consent' ELSE '' END,
  CASE WHEN $4 = 'opted_in' THEN clock_timestamp() END,
  CASE WHEN $4 = 'opted_out' THEN clock_timestamp() END,
  CASE WHEN $4 = 'opted_in'
       THEN '{"evidence_type":"operator_attestation","evidence_id":"route40-db-fixture"}'::jsonb
       ELSE '{}'::jsonb END
)`,
		tenantID, listID, phone, status, email)
}

func seedSuppression(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, phone string, expiresAt *time.Time) {
	t.Helper()
	reason := "manual"
	source := "manual"
	if expiresAt != nil {
		// Manual/operator holds are intentionally permanent under the Route42
		// authority contract. Use an API-scoped temporary hold when this fixture
		// needs to prove that an expired suppression no longer closes an audience.
		reason = "expired"
		source = "api"
	}
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_suppressions (tenant_id, phone_e164, reason, source, expires_at)
VALUES ($1::uuid, $2, $3, $4, $5)`, tenantID, phone, reason, source, expiresAt)
}

func seedEmailSubscriber(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, email string, tags []string) string {
	t.Helper()
	id := broadcastUUID(t)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source, tags)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api', COALESCE($4::text[], '{}'::text[]))`, id, tenantID, email, tags)
	return id
}

func recipientPhones(recipients []BroadcastRecipient) map[string]bool {
	out := map[string]bool{}
	for _, r := range recipients {
		out[r.PhoneE164] = true
	}
	return out
}

func TestResolveBroadcastAudience_ConsentSuppressionAndDedup(t *testing.T) {
	pool := broadcastDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createBroadcastTenant(t, ctx, pool)
	store := &Store{Pool: pool, SMSWorkerIdentityAvailable: true}

	listA := createSMSList(t, ctx, pool, tenantID, "bcast-A")
	listB := createSMSList(t, ctx, pool, tenantID, "bcast-B")

	seedSubscription(t, ctx, pool, tenantID, listA, "+15552300001", "opted_in", "")  // in
	seedSubscription(t, ctx, pool, tenantID, listA, "+15552300002", "pending", "")   // out: no consent
	seedSubscription(t, ctx, pool, tenantID, listA, "+15552300003", "opted_out", "") // out: revoked
	seedSubscription(t, ctx, pool, tenantID, listA, "+15552300004", "opted_in", "")  // out: suppressed
	seedSuppression(t, ctx, pool, tenantID, "+15552300004", nil)
	seedSubscription(t, ctx, pool, tenantID, listA, "+15552300005", "opted_in", "") // in: suppression expired
	expired := time.Now().Add(-time.Hour)
	seedSuppression(t, ctx, pool, tenantID, "+15552300005", &expired)
	seedSubscription(t, ctx, pool, tenantID, listA, "+15552300006", "opted_in", "") // in once (both lists)
	seedSubscription(t, ctx, pool, tenantID, listB, "+15552300006", "opted_in", "")
	seedSubscription(t, ctx, pool, tenantID, listB, "+15552300007", "opted_in", "") // in via list B

	got, err := store.ResolveBroadcastAudience(ctx, tenantID,
		Broadcast{ListIDs: []string{listA, listB}}, 0)
	if err != nil {
		t.Fatalf("resolve list audience: %v", err)
	}
	phones := recipientPhones(got)
	want := []string{"+15552300001", "+15552300005", "+15552300006", "+15552300007"}
	if len(got) != len(want) {
		t.Fatalf("resolved %d recipients (%v), want %d", len(got), phones, len(want))
	}
	for _, p := range want {
		if !phones[p] {
			t.Errorf("missing expected recipient %s", p)
		}
	}
}

func TestResolveBroadcastAudience_TagAndSegment(t *testing.T) {
	pool := broadcastDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createBroadcastTenant(t, ctx, pool)
	store := &Store{Pool: pool}

	list := createSMSList(t, ctx, pool, tenantID, "bcast-tagseg")
	// vip + consented SMS → in for tag audience.
	vipID := seedEmailSubscriber(t, ctx, pool, tenantID, "vip@bcast.test", []string{"vip"})
	seedSubscription(t, ctx, pool, tenantID, list, "+15552300011", "opted_in", "vip@bcast.test")
	// vip but NO sms consent → out (tag membership alone is not consent).
	seedEmailSubscriber(t, ctx, pool, tenantID, "noconsent@bcast.test", []string{"vip"})
	// consented SMS but not vip → out for tag audience.
	plainID := seedEmailSubscriber(t, ctx, pool, tenantID, "plain@bcast.test", nil)
	seedSubscription(t, ctx, pool, tenantID, list, "+15552300012", "opted_in", "plain@bcast.test")

	got, err := store.ResolveBroadcastAudience(ctx, tenantID, Broadcast{Tag: "vip"}, 0)
	if err != nil {
		t.Fatalf("resolve tag audience: %v", err)
	}
	if len(got) != 1 || got[0].PhoneE164 != "+15552300011" {
		t.Fatalf("tag audience = %+v, want only +15550000011", got)
	}

	// Segment audience: materialised membership = {vip, plain}; only
	// rows that link to opted-in sms_subscriptions resolve.
	segID := broadcastUUID(t)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO segments (id, tenant_id, name, query_ast)
VALUES ($1::uuid, $2::uuid, 'bcast-seg', '{}'::jsonb)`, segID, tenantID)
	for _, sub := range []string{vipID, plainID} {
		broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO segment_subscribers (tenant_id, segment_id, subscriber_id)
VALUES ($1::uuid, $2::uuid, $3::uuid)`, tenantID, segID, sub)
	}
	got, err = store.ResolveBroadcastAudience(ctx, tenantID, Broadcast{SegmentID: segID}, 0)
	if err != nil {
		t.Fatalf("resolve segment audience: %v", err)
	}
	phones := recipientPhones(got)
	if len(got) != 2 || !phones["+15552300011"] || !phones["+15552300012"] {
		t.Fatalf("segment audience = %+v, want {+15550000011, +15550000012}", got)
	}

	// Empty audience → typed audience_required.
	if _, err := store.ResolveBroadcastAudience(ctx, tenantID, Broadcast{}, 0); err == nil {
		t.Fatal("expected audience_required error for empty audience")
	} else if be := asBroadcastErr(t, err); be.Code != "audience_required" {
		t.Fatalf("got code=%q, want audience_required", be.Code)
	}
}

// sendFixture creates sender + list + n opted-in phones + a draft
// broadcast targeting the list, returning (broadcastID, deps).
func sendFixture(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string, n int) (string, *Deps) {
	t.Helper()
	store := &Store{Pool: pool, SMSWorkerIdentityAvailable: true}
	senderID := createSMSSender(t, ctx, pool, tenantID)
	listID := createSMSList(t, ctx, pool, tenantID, "bcast-send-"+broadcastUUID(t)[:8])
	for i := 0; i < n; i++ {
		seedSubscription(t, ctx, pool, tenantID, listID, fmt.Sprintf("+1555230%04d", i), "opted_in", "")
	}
	lists := []string{listID}
	name, body := "launch", "hello from the broadcast"
	b, err := store.CreateBroadcast(ctx, tenantID, BroadcastUpsert{
		Name: &name, Body: &body, SenderProfileID: &senderID, ListIDs: &lists,
	})
	if err != nil {
		t.Fatalf("CreateBroadcast: %v", err)
	}
	if b.Status != BroadcastStatusDraft {
		t.Fatalf("new broadcast status = %q, want draft", b.Status)
	}
	return b.ID, &Deps{
		Store:           store,
		BroadcastBudget: testBroadcastBudget{},
		Provider: &ProviderRouter{Default: ProviderTwilio, Providers: map[string]Provider{
			ProviderTwilio: &TwilioProvider{AccountSID: "AC_test", AuthToken: "secret", DefaultFromNumber: "+15551234567"},
		}},
	}
}

type testBroadcastBudget struct{}
type testBroadcastReservation struct{}

func (testBroadcastBudget) ReserveBroadcast(context.Context, string, string, int) (BroadcastBudgetReservation, error) {
	return testBroadcastReservation{}, nil
}
func (testBroadcastReservation) Commit(context.Context) error  { return nil }
func (testBroadcastReservation) Release(context.Context) error { return nil }

func assertBroadcastDispatchReleaseHeld(t *testing.T, ctx context.Context, deps *Deps, tenantID, id string) {
	t.Helper()
	_, err := deps.sendBroadcast(ctx, tenantID, id, time.Now())
	if err == nil {
		t.Fatal("release-held broadcast dispatch unexpectedly succeeded")
	}
	be := asBroadcastErr(t, err)
	if be.Code != "sms_broadcast_dispatch_release_held" || be.Status != http.StatusServiceUnavailable {
		t.Fatalf("hold error code=%q status=%d", be.Code, be.Status)
	}
	b, getErr := deps.store().GetBroadcast(ctx, tenantID, id)
	if getErr != nil {
		t.Fatalf("GetBroadcast after hold: %v", getErr)
	}
	if b.CampaignID != "" || b.Status == BroadcastStatusSending || b.Status == BroadcastStatusSent {
		t.Fatalf("release hold mutated broadcast: status=%q campaign=%q", b.Status, b.CampaignID)
	}
}

func TestSendBroadcast_IdempotentEnqueue(t *testing.T) {
	pool := broadcastDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createBroadcastTenant(t, ctx, pool)
	id, deps := sendFixture(t, ctx, pool, tenantID, 3)
	if !smsDispatchSagaReleaseReady {
		assertBroadcastDispatchReleaseHeld(t, ctx, deps, tenantID, id)
		return
	}

	first, err := deps.sendBroadcast(ctx, tenantID, id, time.Now())
	if err != nil {
		t.Fatalf("first send: %v", err)
	}
	if first.Enqueued != 3 {
		t.Fatalf("first send enqueued %d, want 3", first.Enqueued)
	}
	if first.Broadcast.Status != BroadcastStatusSending {
		t.Fatalf("status after send = %q, want sending", first.Broadcast.Status)
	}
	if first.Progress.Total != 3 {
		t.Fatalf("progress total = %d, want 3", first.Progress.Total)
	}
	if first.Broadcast.CampaignID == "" {
		t.Fatal("send must link the shadow campaign")
	}

	// Replayed POST send: no new recipients, totals stable.
	second, err := deps.sendBroadcast(ctx, tenantID, id, time.Now())
	if err != nil {
		t.Fatalf("replayed send: %v", err)
	}
	if second.Enqueued != 0 {
		t.Fatalf("replayed send enqueued %d, want 0", second.Enqueued)
	}
	if second.Progress.Total != 3 {
		t.Fatalf("replayed progress total = %d, want 3", second.Progress.Total)
	}

	var queued int
	broadcastQueryRow(t, ctx, pool, tenantID, `
SELECT COUNT(*) FROM sms_campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		[]any{&queued}, tenantID, first.Broadcast.CampaignID)
	if queued != 3 {
		t.Fatalf("recipient rows = %d, want 3 (no double-enqueue)", queued)
	}

	// Editing a sending broadcast must 409.
	newName := "rename"
	if _, err := deps.store().UpdateBroadcast(ctx, tenantID, id, BroadcastUpsert{Name: &newName}); err == nil {
		t.Fatal("expected broadcast_not_editable while sending")
	} else if be := asBroadcastErr(t, err); be.Code != "broadcast_not_editable" || be.Status != http.StatusConflict {
		t.Fatalf("got code=%q status=%d, want broadcast_not_editable/409", be.Code, be.Status)
	}
}

func TestBroadcastProgress_QuietHoursHeldAndFinalize(t *testing.T) {
	pool := broadcastDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createBroadcastTenant(t, ctx, pool)
	id, deps := sendFixture(t, ctx, pool, tenantID, 2)
	if !smsDispatchSagaReleaseReady {
		assertBroadcastDispatchReleaseHeld(t, ctx, deps, tenantID, id)
		return
	}
	store := deps.store()

	first, err := deps.sendBroadcast(ctx, tenantID, id, time.Now())
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	campaignID := first.Broadcast.CampaignID

	// Simulate the worker gate deferring one recipient for quiet hours
	// (the exact call the worker makes: requeue with
	// error_code='quiet_hours' until the window end).
	var recipientID string
	broadcastQueryRow(t, ctx, pool, tenantID, `
SELECT id::text FROM sms_campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY phone_e164 LIMIT 1`, []any{&recipientID}, tenantID, campaignID)
	hold := time.Now().Add(2 * time.Hour)
	if err := store.RetryQueuedRecipientAt(ctx,
		QueuedRecipient{ID: recipientID, TenantID: tenantID},
		"quiet_hours", "deferred until the quiet-hours window ends", hold); err != nil {
		t.Fatalf("RetryQueuedRecipientAt: %v", err)
	}

	_, progress, err := store.SyncBroadcastProgress(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("SyncBroadcastProgress: %v", err)
	}
	if progress.Held != 1 {
		t.Fatalf("held = %d, want 1 (quiet-hours hold)", progress.Held)
	}
	if progress.Status != BroadcastStatusSending || progress.Total != 2 || progress.Sent != 0 {
		t.Fatalf("progress = %+v, want sending/total 2/sent 0", progress)
	}

	// Drain the queue (one sent, one failed) → the worker sweep
	// (syncSendingBroadcasts → SyncBroadcastProgress) finalizes to
	// 'sent' with held back to 0.
	broadcastExec(t, ctx, pool, tenantID, `
UPDATE sms_campaign_recipients
   SET status = CASE WHEN id = $3::uuid THEN 'failed' ELSE 'sent' END,
       error_code = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID, recipientID)

	worker := &Worker{Store: store}
	if err := worker.syncSendingBroadcasts(ctx); err != nil {
		t.Fatalf("syncSendingBroadcasts: %v", err)
	}
	final, err := store.GetBroadcast(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("GetBroadcast: %v", err)
	}
	if final.Status != BroadcastStatusSent {
		t.Fatalf("final status = %q, want sent", final.Status)
	}
	if final.SentCount != 1 || final.FailedCount != 1 || final.HeldCount != 0 {
		t.Fatalf("final counters sent=%d failed=%d held=%d, want 1/1/0",
			final.SentCount, final.FailedCount, final.HeldCount)
	}
}

func TestSendBroadcast_AudienceTooLarge(t *testing.T) {
	pool := broadcastDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createBroadcastTenant(t, ctx, pool)
	id, deps := sendFixture(t, ctx, pool, tenantID, 2)
	if !smsDispatchSagaReleaseReady {
		assertBroadcastDispatchReleaseHeld(t, ctx, deps, tenantID, id)
		return
	}

	t.Setenv(EnvBroadcastMaxRecipients, "1")
	_, err := deps.sendBroadcast(ctx, tenantID, id, time.Now())
	if err == nil {
		t.Fatal("expected audience_too_large")
	}
	be := asBroadcastErr(t, err)
	if be.Code != "audience_too_large" || be.Status != http.StatusUnprocessableEntity {
		t.Fatalf("got code=%q status=%d, want audience_too_large/422", be.Code, be.Status)
	}
	// The broadcast must remain sendable (still draft, nothing enqueued).
	b, err := deps.store().GetBroadcast(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("GetBroadcast: %v", err)
	}
	if b.Status != BroadcastStatusDraft || b.CampaignID != "" {
		t.Fatalf("after cap failure: status=%q campaign=%q, want draft/unlinked", b.Status, b.CampaignID)
	}
}

func TestSendBroadcast_ScheduleAndWorkerDueSweep(t *testing.T) {
	pool := broadcastDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createBroadcastTenant(t, ctx, pool)
	id, deps := sendFixture(t, ctx, pool, tenantID, 1)
	store := deps.store()

	// Future scheduled_at → POST send schedules instead of sending.
	future := time.Now().Add(time.Hour).UTC()
	if _, err := store.UpdateBroadcast(ctx, tenantID, id, BroadcastUpsert{ScheduledAt: &future}); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	if !smsDispatchSagaReleaseReady {
		assertBroadcastDispatchReleaseHeld(t, ctx, deps, tenantID, id)
		return
	}
	resp, err := deps.sendBroadcast(ctx, tenantID, id, time.Now())
	if err != nil {
		t.Fatalf("send (future): %v", err)
	}
	if resp.Broadcast.Status != BroadcastStatusScheduled || resp.Enqueued != 0 {
		t.Fatalf("future send → status=%q enqueued=%d, want scheduled/0", resp.Broadcast.Status, resp.Enqueued)
	}

	// Not yet due: the worker due-sweep must not return it.
	refs, err := store.FindDueScheduledBroadcasts(ctx, 100)
	if err != nil {
		t.Fatalf("FindDueScheduledBroadcasts: %v", err)
	}
	for _, ref := range refs {
		if ref.ID == id {
			t.Fatal("future-scheduled broadcast must not be due")
		}
	}

	// Make it due, then drive the worker send path for OUR ref only
	// (enqueueDueScheduledBroadcasts sweeps these refs the same way).
	broadcastExec(t, ctx, pool, tenantID, `
UPDATE sms_broadcasts SET scheduled_at = now() - interval '1 minute'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	refs, err = store.FindDueScheduledBroadcasts(ctx, 100)
	if err != nil {
		t.Fatalf("FindDueScheduledBroadcasts (due): %v", err)
	}
	var ours *broadcastRef
	for i := range refs {
		if refs[i].ID == id {
			ours = &refs[i]
			break
		}
	}
	if ours == nil {
		t.Fatalf("due sweep did not return broadcast %s (got %d refs)", id, len(refs))
	}
	if ours.TenantID != tenantID {
		t.Fatalf("due ref tenant = %s, want %s", ours.TenantID, tenantID)
	}

	worker := &Worker{Store: store}
	sent, err := worker.safeSendScheduledBroadcast(ctx, deps, *ours)
	if err != nil {
		t.Fatalf("worker send: %v", err)
	}
	if sent.Broadcast.Status != BroadcastStatusSending || sent.Enqueued != 1 {
		t.Fatalf("worker send → status=%q enqueued=%d, want sending/1", sent.Broadcast.Status, sent.Enqueued)
	}

	// Cancel mid-send: still-queued recipients flip to cancelled so the
	// queue worker never picks them up.
	cancelled, err := store.CancelBroadcast(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("CancelBroadcast: %v", err)
	}
	if cancelled.Status != BroadcastStatusCancelled {
		t.Fatalf("cancel status = %q, want cancelled", cancelled.Status)
	}
	var stillQueued int
	broadcastQueryRow(t, ctx, pool, tenantID, `
SELECT COUNT(*) FROM sms_campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND status = 'queued'`,
		[]any{&stillQueued}, tenantID, sent.Broadcast.CampaignID)
	if stillQueued != 0 {
		t.Fatalf("%d recipients still queued after cancel, want 0", stillQueued)
	}
}
