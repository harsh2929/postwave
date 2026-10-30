// SPDX-License-Identifier: AGPL-3.0-only
package freq_caps

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// WHY THIS FILE EXISTS.
//
// Every other test in this package is a pure unit test of ValidateCap. Nothing
// ever executed the SQL, and so nothing noticed that this package queries TWO
// TABLES THAT NO MIGRATION CREATES: `frequency_caps` and
// `frequency_cap_events`. The only table that exists is `frequency_cap_rules`,
// created by migration 0260 and owned by internal/frequency.
//
// The consequence is not a broken screen. `WouldDefer` is called from the SEND
// PATH — internal/campaigns/automation_email.go:150 — and that caller does:
//
//	decision, err := freq_caps.WouldDefer(...)
//	if err != nil { return err }
//
// so a missing relation turns every automation email send into an error. The
// comment at that call site reads "internal/freq_caps had ZERO send-time
// callsites — it was a configurable surface wired to nothing. This is one." It
// was wired to a schema that had never shipped.
//
// This test executes the query against a real database. It is the check that
// would have caught it, and it is the check that keeps it caught.
func newFreqCapsTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping freq-caps DB tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// No tenant is seeded, deliberately. What these tests establish is that the SQL
// EXECUTES against the real schema; an arbitrary tenant id returns zero rows
// under RLS, which is the same code path with none of the seeding. Inserting a
// tenant as postwave_app is correctly refused by RLS anyway.
const freqCapsProbeTenant = "00000000-0000-4000-8000-0000000000f1"

// A tenant of this test's own. frequency_caps carries a foreign key to
// tenants, so enforcement cannot be exercised against a fabricated id. The
// test used to borrow whichever tenant it found first, and in a shared
// database another package's test could delete that tenant mid-run (a
// foreign-key failure on the cap insert). postwave_app may create a tenant
// inside a transaction bound to the prospective id, as the application does.
func ownTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'freq-caps-test', $2, 'studio')`, tenantID, "freq-caps-"+tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	return tenantID
}

// The send path calls this before every automation email. It must not error.
func TestWouldDeferDoesNotErrorOnTheSendPath(t *testing.T) {
	pool := newFreqCapsTestPool(t)
	tenantID := freqCapsProbeTenant

	decision, err := WouldDefer(context.Background(), pool, tenantID, SendContext{
		SubscriberEmail: "someone@example.test",
		Channel:         "email",
		MessageType:     "automation",
	})
	if err != nil {
		t.Fatalf("WouldDefer errored on the send path, which fails the send: %v", err)
	}
	// With no caps configured, nothing may be deferred. A cap-less workspace
	// silently withholding mail is the opposite failure and just as bad.
	if decision.Defer {
		t.Fatalf("no caps are configured, so nothing may be deferred: %+v", decision)
	}
}

// The list read behind GET /api/v1/frequency-caps.
func TestRepoListDoesNotErrorOnAnEmptyWorkspace(t *testing.T) {
	pool := newFreqCapsTestPool(t)
	tenantID := freqCapsProbeTenant

	repo := &Repo{Pool: pool}
	caps, err := repo.List(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("Repo.List errored, so GET /api/v1/frequency-caps 500s: %v", err)
	}
	if len(caps) != 0 {
		t.Fatalf("a fresh workspace has no caps, got %d", len(caps))
	}
}

// The enforcement itself, against the real schema. This is the behaviour the
// missing tables took away: not "the screen 500s" but "a cap that is configured
// does not hold anything back", which is invisible from every surface.
func TestWouldDeferHoldsBackOnceTheCapIsReached(t *testing.T) {
	pool := newFreqCapsTestPool(t)
	ctx := context.Background()
	tenantID := ownTenant(t, pool)
	email := "defer-probe@example.test"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	// A cap of one per day, then one recorded send. RLS scopes both writes to
	// the probe tenant, and t.Cleanup removes them.
	var capID string
	if err := tx.QueryRow(ctx, `
INSERT INTO frequency_caps
  (tenant_id, label, channel, message_type, max_count, window_seconds, applies_to)
VALUES ($1::uuid, 'probe one a day', 'email', 'marketing', 1, 86400, 'all')
RETURNING id::text`, tenantID).Scan(&capID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert cap: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO frequency_cap_events
  (tenant_id, subscriber_email, channel, message_type, sent_at)
VALUES ($1::uuid, $2, 'email', 'marketing', now())`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		_, _ = cleanup.Exec(context.Background(),
			`DELETE FROM frequency_cap_events WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = cleanup.Exec(context.Background(),
			`DELETE FROM frequency_caps WHERE tenant_id = $1::uuid`, tenantID)
		_ = cleanup.Commit(context.Background())
	})

	decision, err := WouldDefer(ctx, pool, tenantID, SendContext{
		SubscriberEmail: email,
		Channel:         "email",
		MessageType:     "marketing",
	})
	if err != nil {
		t.Fatalf("WouldDefer: %v", err)
	}
	if !decision.Defer {
		t.Fatalf("a 1-per-day cap with one send recorded must defer, got %+v", decision)
	}
	if decision.HitCapID != capID {
		t.Fatalf("deferred on the wrong cap: got %q want %q", decision.HitCapID, capID)
	}
	if decision.CurrentCount != 1 {
		t.Fatalf("count should be the one recorded send, got %d", decision.CurrentCount)
	}

	// A DIFFERENT subscriber under the same cap must still be sendable: a cap is
	// per-recipient, and a global hold would silently stop a whole campaign.
	other, err := WouldDefer(ctx, pool, tenantID, SendContext{
		SubscriberEmail: "someone-else@example.test",
		Channel:         "email",
		MessageType:     "marketing",
	})
	if err != nil {
		t.Fatalf("WouldDefer (other subscriber): %v", err)
	}
	if other.Defer {
		t.Fatalf("the cap is per-subscriber; another recipient must not be held: %+v", other)
	}
}
