// SPDX-License-Identifier: AGPL-3.0-only

package notifywebhook

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The last notifyfanout channel to get a delivery record.
//
// The feed row is the identity; web push got migration 1883 and the chat
// integrations 1884. This one did:
//
//	if err := f.Webhook.Post(...); err != nil { log.Warn(...) }
//
// Somebody who configured a Slack destination so they would hear about
// approvals heard nothing when it broke, and no query could tell them it had
// even been attempted.

func recorderPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping webhook recorder test")
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

func seedRecorderTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'nwh', 'studio')`,
		tenantID, "nwh-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM notification_webhook_deliveries WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID
}

type recordedDelivery struct {
	Status    string
	Error     string
	Attempts  int
	Delivered bool
}

func readRecord(t *testing.T, pool *db.Pool, tenantID, notificationID, userID string) (recordedDelivery, bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var r recordedDelivery
	err = tx.QueryRow(ctx, `
SELECT status, error, attempts, delivered_at IS NOT NULL
  FROM notification_webhook_deliveries
 WHERE tenant_id = $1::uuid AND notification_id = $2::uuid AND user_id = $3::uuid`,
		tenantID, notificationID, userID).Scan(&r.Status, &r.Error, &r.Attempts, &r.Delivered)
	if err != nil {
		return recordedDelivery{}, false
	}
	return r, true
}

func TestAFailedWebhookPostIsRecorded(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	userID, notificationID := uuid.NewString(), uuid.NewString()

	rec := NewRecorder(pool)
	if err := rec.Record(ctx, tenantID, userID, notificationID, "approval.requested", "slack",
		errors.New("slack returned 500")); err != nil {
		t.Fatalf("Record: %v", err)
	}
	got, ok := readRecord(t, pool, tenantID, notificationID, userID)
	if !ok {
		t.Fatal("nothing was recorded; a broken Slack destination is still " +
			"undiscoverable by any query")
	}
	if got.Status != "failed" {
		t.Errorf("status = %q, want failed", got.Status)
	}
	if got.Error == "" {
		t.Error("no error text stored, so an operator learns it failed and not why")
	}
	if got.Delivered {
		t.Error("delivered_at set on a failed post")
	}
}

func TestASuccessfulWebhookPostIsRecorded(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	userID, notificationID := uuid.NewString(), uuid.NewString()

	if err := NewRecorder(pool).Record(ctx, tenantID, userID, notificationID,
		"approval.requested", "generic", nil); err != nil {
		t.Fatalf("Record: %v", err)
	}
	got, ok := readRecord(t, pool, tenantID, notificationID, userID)
	if !ok {
		t.Fatal("a successful post was not recorded")
	}
	if got.Status != "sent" || !got.Delivered {
		t.Fatalf("got %+v, want a sent row with delivered_at", got)
	}
}

// One feed notification for one person is one record, however many attempts it
// took — and a later failure must not erase the evidence that it once arrived.
func TestARetryUpdatesTheRecordAndKeepsTheFirstDelivery(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	userID, notificationID := uuid.NewString(), uuid.NewString()
	rec := NewRecorder(pool)

	if err := rec.Record(ctx, tenantID, userID, notificationID, "approval.requested", "slack", nil); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := rec.Record(ctx, tenantID, userID, notificationID, "approval.requested", "slack",
		errors.New("later failure")); err != nil {
		t.Fatalf("second: %v", err)
	}

	got, ok := readRecord(t, pool, tenantID, notificationID, userID)
	if !ok {
		t.Fatal("record vanished")
	}
	if got.Attempts != 2 {
		t.Errorf("attempts = %d, want 2 — the count is what tells an operator "+
			"this destination is flapping", got.Attempts)
	}
	if !got.Delivered {
		t.Error("delivered_at was cleared by a later failure. It once arrived, " +
			"and erasing that turns a flapping destination into one that looks " +
			"like it never worked.")
	}
	if got.Status != "failed" {
		t.Errorf("status = %q, want the CURRENT state (failed)", got.Status)
	}
}

// Two people receiving the same notification are two records; one person
// receiving two notifications is two records. The identity is the pair.
func TestTheRecordIsPerNotificationPerPerson(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	rec := NewRecorder(pool)
	ada, bob := uuid.NewString(), uuid.NewString()
	n1, n2 := uuid.NewString(), uuid.NewString()

	for _, c := range []struct{ user, notification string }{
		{ada, n1}, {bob, n1}, {ada, n2},
	} {
		if err := rec.Record(ctx, tenantID, c.user, c.notification, "approval.requested", "slack", nil); err != nil {
			t.Fatalf("record: %v", err)
		}
	}
	for _, c := range []struct{ user, notification string }{
		{ada, n1}, {bob, n1}, {ada, n2},
	} {
		if _, ok := readRecord(t, pool, tenantID, c.notification, c.user); !ok {
			t.Errorf("missing record for user=%s notification=%s; deliveries are "+
				"collapsing across people or across notifications", c.user[:8], c.notification[:8])
		}
	}
}

// Incomplete identity must not write a row. A record that cannot say who it was
// for answers nothing, and the unique index would collapse them all together.
func TestAnIncompleteIdentityRecordsNothing(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	rec := NewRecorder(pool)

	for _, c := range []struct{ user, notification string }{
		{"", uuid.NewString()},
		{uuid.NewString(), ""},
	} {
		if err := rec.Record(ctx, tenantID, c.user, c.notification, "approval.requested", "slack", nil); err != nil {
			t.Fatalf("Record should no-op, not error: %v", err)
		}
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM notification_webhook_deliveries WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d row(s) written for an incomplete identity", n)
	}
}

// fakePoster records what a retry would send.
type fakePoster struct {
	posts []struct{ url, kind, text, eventType string }
	err   error
}

func (f *fakePoster) Post(_ context.Context, url, kind, text, eventType string) error {
	f.posts = append(f.posts, struct{ url, kind, text, eventType string }{url, kind, text, eventType})
	return f.err
}

// seedWebhookPref gives the user a destination for the retry to resolve.
func seedWebhookPref(t *testing.T, pool *db.Pool, tenantID, userID, url string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO notification_preferences (tenant_id, user_id, notification_webhook_url, notification_webhook_kind)
VALUES ($1::uuid, $2::uuid, $3, 'slack')
ON CONFLICT (tenant_id, user_id) DO UPDATE SET notification_webhook_url = EXCLUDED.notification_webhook_url`,
		tenantID, userID, url); err != nil {
		t.Fatalf("notification_preferences shape differs here: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit pref: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM notification_preferences WHERE tenant_id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
}

func seedFeedNotification(t *testing.T, pool *db.Pool, tenantID, userID, title string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO notification_feed (tenant_id, user_id, kind, title, body, deep_link, event_type)
VALUES ($1::uuid, $2::uuid, 'approval', $3, 'needs your review', '/app/approvals', 'approval.requested')
RETURNING id::text`, tenantID, userID, title).Scan(&id); err != nil {
		t.Fatalf("seed feed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit feed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM notification_feed WHERE tenant_id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return id
}

// The claim this channel could not make until now: a failed post is re-sent.
func TestAFailedWebhookPostIsRetried(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	userID := uuid.NewString()
	seedWebhookPref(t, pool, tenantID, userID, "https://hooks.example.test/x")
	notificationID := seedFeedNotification(t, pool, tenantID, userID, "Approval needed")

	rec := NewRecorder(pool)
	if err := rec.Record(ctx, tenantID, userID, notificationID, "approval.requested", "slack",
		errors.New("slack 503")); err != nil {
		t.Fatalf("Record: %v", err)
	}

	p := &fakePoster{}
	// Nothing due yet — the backoff is a minute out.
	if retried, _, err := rec.RetryDue(ctx, p, time.Now().UTC(), 10); err != nil || retried != 0 {
		t.Fatalf("RetryDue before the backoff: retried=%d err=%v", retried, err)
	}
	retried, failedCount, err := rec.RetryDue(ctx, p, time.Now().UTC().Add(2*time.Minute), 10)
	if err != nil {
		t.Fatalf("RetryDue: %v", err)
	}
	if retried != 1 || failedCount != 0 {
		t.Fatalf("retried=%d failed=%d, want 1/0 — the notification is still not "+
			"being re-sent, which is the whole point of the ledger", retried, failedCount)
	}
	if len(p.posts) != 1 {
		t.Fatalf("posts = %d, want 1", len(p.posts))
	}
	if p.posts[0].url != "https://hooks.example.test/x" {
		t.Errorf("posted to %q, want the destination from preferences", p.posts[0].url)
	}
	// The message is rebuilt from the feed row and rendered by the SHARED
	// formatter, so a resent message reads like the original.
	if !strings.Contains(p.posts[0].text, "Approval needed") ||
		!strings.Contains(p.posts[0].text, "/app/approvals") {
		t.Errorf("retry text = %q; want the feed row's title and deep link", p.posts[0].text)
	}

	got, ok := readRecord(t, pool, tenantID, notificationID, userID)
	if !ok || got.Status != "sent" || got.Attempts != 2 {
		t.Fatalf("record after a successful retry = %+v, want sent with 2 attempts", got)
	}
}

// A destination the person has since removed must not be retried at.
func TestARetryWithNoDestinationSendsNothing(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	userID := uuid.NewString()
	seedWebhookPref(t, pool, tenantID, userID, "")
	notificationID := seedFeedNotification(t, pool, tenantID, userID, "Approval needed")

	rec := NewRecorder(pool)
	if err := rec.Record(ctx, tenantID, userID, notificationID, "approval.requested", "slack",
		errors.New("slack 503")); err != nil {
		t.Fatalf("Record: %v", err)
	}
	p := &fakePoster{}
	retried, _, err := rec.RetryDue(ctx, p, time.Now().UTC().Add(2*time.Minute), 10)
	if err != nil {
		t.Fatalf("RetryDue: %v", err)
	}
	if retried != 0 || len(p.posts) != 0 {
		t.Fatalf("posted to a destination that no longer exists (retried=%d posts=%d)",
			retried, len(p.posts))
	}
}

// The attempt budget must actually stop the sweep.
func TestAWebhookRetryStopsAtTheAttemptBudget(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	userID := uuid.NewString()
	seedWebhookPref(t, pool, tenantID, userID, "https://hooks.example.test/x")
	notificationID := seedFeedNotification(t, pool, tenantID, userID, "Approval needed")

	rec := NewRecorder(pool)
	if err := rec.Record(ctx, tenantID, userID, notificationID, "approval.requested", "slack",
		errors.New("slack 503")); err != nil {
		t.Fatalf("Record: %v", err)
	}
	p := &fakePoster{err: errors.New("still down")}
	at := time.Now().UTC()
	for i := 0; i < MaxPostAttempts+3; i++ {
		at = at.Add(2 * time.Hour)
		if _, _, err := rec.RetryDue(ctx, p, at, 10); err != nil {
			t.Fatalf("sweep %d: %v", i, err)
		}
	}
	got, ok := readRecord(t, pool, tenantID, notificationID, userID)
	if !ok {
		t.Fatal("record vanished")
	}
	if got.Attempts > MaxPostAttempts+1 {
		t.Fatalf("attempts = %d, past the %d budget — a permanently broken Slack "+
			"URL is being retried forever instead of surfaced", got.Attempts, MaxPostAttempts)
	}
	if len(p.posts) > MaxPostAttempts {
		t.Errorf("posted %d times against a %d budget", len(p.posts), MaxPostAttempts)
	}
}

// No feed row means no message.
//
// Written because a mutation removing this guard did NOT fail anything: the
// equivalent test existed for web push and was never written here, so the
// webhook sweep could have posted a fabricated message and no test would have
// noticed. The content may be text the person is no longer entitled to see.
func TestAWebhookRetryWithNoFeedRowSendsNothing(t *testing.T) {
	pool := recorderPool(t)
	ctx := context.Background()
	tenantID := seedRecorderTenant(t, pool)
	userID := uuid.NewString()
	seedWebhookPref(t, pool, tenantID, userID, "https://hooks.example.test/x")
	// A notification id that points at no feed row.
	notificationID := uuid.NewString()

	rec := NewRecorder(pool)
	if err := rec.Record(ctx, tenantID, userID, notificationID, "approval.requested", "slack",
		errors.New("slack 503")); err != nil {
		t.Fatalf("Record: %v", err)
	}
	p := &fakePoster{}
	retried, _, err := rec.RetryDue(ctx, p, time.Now().UTC().Add(2*time.Minute), 10)
	if err != nil {
		t.Fatalf("RetryDue: %v", err)
	}
	if retried != 0 || len(p.posts) != 0 {
		t.Fatalf("posted a message with no feed row behind it (retried=%d posts=%d); "+
			"the sweep fabricated content it no longer has", retried, len(p.posts))
	}
}
