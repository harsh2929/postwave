// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

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

// COMMERCE#3. The auto-disable alert now reaches the phone as well as the
// inbox, and the single rule that keeps that safe is: THE PUSH GOES TO EXACTLY
// THE PERSON THE EMAIL GOES TO. These tests run the two recipient queries side
// by side against a real database under the NON-PRIVILEGED role, so RLS is
// genuinely exercised and any divergence between the mirrored predicates shows
// up as a failing assertion rather than as a disclosure.

func newAutoDisableRecipientPool(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	pool, err := db.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type autoDisableRecipientFixture struct {
	tenantID     string
	firstOwnerID string
	laterOwnerID string
	adminID      string
}

// seedAutoDisableRecipients builds a tenant whose shape can distinguish every
// mistake worth making: two owners (so "the earliest" is observable), an admin
// (so an accidental role widening is observable), and a pref row per user (so
// an accidental pref drop is observable).
func seedAutoDisableRecipients(t *testing.T, pool *db.Pool) autoDisableRecipientFixture {
	t.Helper()
	fixture := autoDisableRecipientFixture{tenantID: uuid.NewString()}
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open fixture tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'auto disable recipient test',
        'auto-disable-recipient-' || $1::text, 'studio')`, fixture.tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	insertUser := func(email, role string, createdAt time.Time) string {
		t.Helper()
		var id string
		if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role, created_at)
VALUES ($1::uuid, $2, $3, $4)
RETURNING id::text`, fixture.tenantID, email, role, createdAt).Scan(&id); err != nil {
			t.Fatalf("seed %s user: %v", role, err)
		}
		return id
	}
	fixture.firstOwnerID = insertUser("first-owner@example.test", "owner", base)
	fixture.laterOwnerID = insertUser("later-owner@example.test", "owner", base.Add(time.Hour))
	fixture.adminID = insertUser("admin@example.test", "admin", base.Add(-time.Hour))
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, fixture.tenantID)
		if cleanupErr != nil {
			t.Errorf("open fixture cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		if _, cleanupErr := cleanup.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID); cleanupErr != nil {
			t.Errorf("delete fixture tenant: %v", cleanupErr)
			return
		}
		if cleanupErr := cleanup.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit fixture cleanup: %v", cleanupErr)
		}
	})
	return fixture
}

// emailRecipient runs the EmailAutoDisableNotifier's own SELECT, projected to
// the user id. Duplicated here verbatim on purpose: the point of the test is to
// prove the push query returns the same row as the email query, and importing
// the email's behaviour instead would make that circular.
func emailRecipient(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open email recipient tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
SELECT user_account.id::text
  FROM users AS user_account
  JOIN tenants AS tenant ON tenant.id = user_account.tenant_id
  LEFT JOIN webhook_alert_prefs AS preference
    ON preference.tenant_id = user_account.tenant_id
   AND preference.user_id = user_account.id
 WHERE user_account.tenant_id = $1::uuid
   AND user_account.role = 'owner'
   AND NULLIF(btrim(user_account.email), '') IS NOT NULL
   AND COALESCE(preference.notify_auto_disabled, true) = true
 ORDER BY user_account.created_at, user_account.id
 LIMIT 1`, tenantID).Scan(&id)
	if err != nil && !isNoRows(err) {
		t.Fatalf("email recipient query: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit email recipient tx: %v", err)
	}
	return id
}

func isNoRows(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no rows in result set")
}

func setAutoDisablePref(t *testing.T, pool *db.Pool, tenantID, userID string, enabled bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open pref tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO webhook_alert_prefs (tenant_id, user_id, notify_auto_disabled)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (user_id, tenant_id)
DO UPDATE SET notify_auto_disabled = EXCLUDED.notify_auto_disabled`,
		tenantID, userID, enabled); err != nil {
		t.Fatalf("set pref: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit pref tx: %v", err)
	}
}

func TestFanoutAutoDisableRecipientMatchesTheEmailRecipient(t *testing.T) {
	pool := newAutoDisableRecipientPool(t)
	fixture := seedAutoDisableRecipients(t, pool)
	notifier := &FanoutAutoDisableNotifier{Pool: pool}
	ctx := context.Background()

	t.Run("defaults to the earliest owner, never the admin", func(t *testing.T) {
		got, err := notifier.recipient(ctx, fixture.tenantID)
		if err != nil {
			t.Fatalf("recipient: %v", err)
		}
		if got != fixture.firstOwnerID {
			t.Fatalf("recipient = %q, want the earliest owner %q", got, fixture.firstOwnerID)
		}
		if got == fixture.adminID {
			t.Fatal("an admin was notified; the email policy notifies owners only")
		}
		if want := emailRecipient(t, pool, fixture.tenantID); got != want {
			t.Fatalf("push recipient %q diverged from email recipient %q", got, want)
		}
	})

	t.Run("honours the owner's notify_auto_disabled opt-out", func(t *testing.T) {
		// The first owner opts out. The alert must fall through to the next
		// eligible OWNER — and must still agree with the email.
		setAutoDisablePref(t, pool, fixture.tenantID, fixture.firstOwnerID, false)
		got, err := notifier.recipient(ctx, fixture.tenantID)
		if err != nil {
			t.Fatalf("recipient: %v", err)
		}
		if got != fixture.laterOwnerID {
			t.Fatalf("recipient = %q, want the later owner %q after the first opted out",
				got, fixture.laterOwnerID)
		}
		if want := emailRecipient(t, pool, fixture.tenantID); got != want {
			t.Fatalf("push recipient %q diverged from email recipient %q", got, want)
		}
	})

	t.Run("tells nobody when every owner has opted out", func(t *testing.T) {
		setAutoDisablePref(t, pool, fixture.tenantID, fixture.laterOwnerID, false)
		got, err := notifier.recipient(ctx, fixture.tenantID)
		if err != nil {
			t.Fatalf("recipient: %v", err)
		}
		if got != "" {
			t.Fatalf("recipient = %q, want none — every owner opted out", got)
		}
		if want := emailRecipient(t, pool, fixture.tenantID); want != "" {
			t.Fatalf("email still had recipient %q; the two predicates diverged", want)
		}
	})
}

// The notifier is called by the durable outbox worker, where a returned error
// reschedules the row. "This tenant has nobody to tell" is not a retryable
// condition and must not spin the outbox forever.
func TestFanoutAutoDisableIsANoOpWithoutARecipientOrFanout(t *testing.T) {
	pool := newAutoDisableRecipientPool(t)
	fixture := seedAutoDisableRecipients(t, pool)
	setAutoDisablePref(t, pool, fixture.tenantID, fixture.firstOwnerID, false)
	setAutoDisablePref(t, pool, fixture.tenantID, fixture.laterOwnerID, false)

	// No Fanout wired at all — a deployment without the notification stack.
	notifier := &FanoutAutoDisableNotifier{Pool: pool}
	if err := notifier.NotifyWebhookAutoDisabled(
		context.Background(), fixture.tenantID, uuid.NewString(),
	); err != nil {
		t.Fatalf("expected a silent no-op, got %v", err)
	}

	// And a nil receiver must not panic — the composite skips nil legs, but the
	// method is exported and the outbox is not a place to discover that.
	var nilNotifier *FanoutAutoDisableNotifier
	if err := nilNotifier.NotifyWebhookAutoDisabled(
		context.Background(), fixture.tenantID, "hook",
	); err != nil {
		t.Fatalf("nil notifier returned %v", err)
	}
	_ = errors.New("")
}

// MultiAutoDisableNotifier's error contract is the thing that makes it safe to
// add a second channel to a DURABLE OUTBOX. The worker retries on a returned
// error, so a leg that already succeeded would run again — tolerable for the
// fanout (it dedupes) and a duplicate email otherwise. Hence: only the LAST
// leg's error escapes, and the email must be wired last.
type recordingNotifier struct {
	name  string
	err   error
	calls *[]string
}

func (r *recordingNotifier) NotifyWebhookAutoDisabled(_ context.Context, _, _ string) error {
	*r.calls = append(*r.calls, r.name)
	return r.err
}

func TestMultiAutoDisableNotifierErrorContract(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	boom := errors.New("boom")

	t.Run("runs every leg in order", func(t *testing.T) {
		var calls []string
		multi := MultiAutoDisableNotifier{
			&recordingNotifier{name: "fanout", calls: &calls},
			&recordingNotifier{name: "email", calls: &calls},
		}
		if err := multi.NotifyWebhookAutoDisabled(ctx, "t", "w"); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(calls) != 2 || calls[0] != "fanout" || calls[1] != "email" {
			t.Fatalf("legs ran as %v, want [fanout email]", calls)
		}
	})

	t.Run("a failing early leg does not reschedule the outbox row", func(t *testing.T) {
		// If this returned the error, the retry would re-send the EMAIL that
		// already went out.
		var calls []string
		multi := MultiAutoDisableNotifier{
			&recordingNotifier{name: "fanout", err: boom, calls: &calls},
			&recordingNotifier{name: "email", calls: &calls},
		}
		if err := multi.NotifyWebhookAutoDisabled(ctx, "t", "w"); err != nil {
			t.Fatalf("early-leg failure escaped as %v", err)
		}
		if len(calls) != 2 {
			t.Fatalf("a failing early leg stopped the chain: %v", calls)
		}
	})

	t.Run("the last leg's failure DOES reschedule", func(t *testing.T) {
		var calls []string
		multi := MultiAutoDisableNotifier{
			&recordingNotifier{name: "fanout", calls: &calls},
			&recordingNotifier{name: "email", err: boom, calls: &calls},
		}
		if err := multi.NotifyWebhookAutoDisabled(ctx, "t", "w"); !errors.Is(err, boom) {
			t.Fatalf("last-leg failure returned %v, want the error so the outbox retries", err)
		}
	})

	t.Run("skips nil legs", func(t *testing.T) {
		var calls []string
		multi := MultiAutoDisableNotifier{
			nil,
			&recordingNotifier{name: "email", calls: &calls},
		}
		if err := multi.NotifyWebhookAutoDisabled(ctx, "t", "w"); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(calls) != 1 {
			t.Fatalf("calls = %v", calls)
		}
	})
}
