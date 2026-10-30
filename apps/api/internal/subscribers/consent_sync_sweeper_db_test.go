// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A consent push that fails must be retried by something.
//
// `RunRetrySweep` is complete — it claims due rows, re-attempts delivery,
// applies bounded backoff and gives up at the attempt cap. It has no non-test
// caller. So the first delivery attempt is the only one that ever happens: a
// destination that is briefly down, rate-limiting, or mid-deploy keeps the
// consent change forever, in status `retrying`, with a `next_attempt_at` no
// worker ever reads.
//
// For the question this subsystem exists to answer — "you were told to stop;
// who else holds this record and were they told?" — "we tried once, it failed,
// and nobody looked again" is not a materially better answer than never having
// tried.

type flakyDeliverer struct {
	failures int
	calls    int
}

func (d *flakyDeliverer) Deliver(context.Context, ConsentSyncLedgerRow) error {
	d.calls++
	if d.calls <= d.failures {
		return errors.New("destination unavailable")
	}
	return nil
}

func seedDueConsentRow(t *testing.T, pool *db.Pool, ctx context.Context) (tenantID string) {
	t.Helper()
	tenantID = uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, "consent-sweep-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	subscriberID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'import')`,
		subscriberID, tenantID, "sweep-"+subscriberID[:8]+"@example.test"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_sync_ledger
    (tenant_id, subscriber_id, event_type, destination_id, destination_url,
     status, attempt_count, next_attempt_at)
VALUES ($1::uuid, $2::uuid, 'unsubscribe', $3, 'https://dest.example/hook',
        'retrying', 1, now() - interval '1 minute')`,
		tenantID, subscriberID, uuid.NewString()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed ledger row: %v", err)
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
		_, _ = c.Exec(bg, `DELETE FROM consent_sync_ledger WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID
}

func readConsentRow(t *testing.T, pool *db.Pool, ctx context.Context, tenantID string) (status string, attempts int) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT status, attempt_count FROM consent_sync_ledger WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&status, &attempts); err != nil {
		t.Fatalf("read ledger row: %v", err)
	}
	return status, attempts
}

func TestTheSweeperFindsDueRowsAcrossTenantsAndRetriesThem(t *testing.T) {
	pool := newConsentSyncPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := seedDueConsentRow(t, pool, ctx)
	deliverer := &flakyDeliverer{} // succeeds on the first retry
	sweeper := &ConsentSyncSweeper{
		Pool: pool,
		Ledger: &ConsentSyncLedger{
			Pool:         pool,
			Destinations: ConsentSyncWebhookDestinations{},
			Deliverer:    deliverer,
		},
	}

	processed := sweeper.tick(ctx)
	if processed == 0 {
		t.Fatal("the sweeper found no due rows; a failed consent push is never " +
			"retried, so the destination keeps a record it was told to drop")
	}
	if deliverer.calls == 0 {
		t.Fatal("no delivery was attempted")
	}
	if status, attempts := readConsentRow(t, pool, ctx, tenantID); status != "delivered" || attempts != 2 {
		t.Fatalf("status=%q attempts=%d, want delivered on attempt 2", status, attempts)
	}
}

func TestTheSweeperLeavesRowsThatAreNotYetDue(t *testing.T) {
	// Backoff exists so a struggling destination is not hammered. A sweeper
	// that ignored next_attempt_at would burn the 5-attempt budget in seconds
	// and mark the row permanently failed.
	pool := newConsentSyncPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := seedDueConsentRow(t, pool, ctx)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE consent_sync_ledger SET next_attempt_at = now() + interval '1 hour'
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	deliverer := &flakyDeliverer{}
	sweeper := &ConsentSyncSweeper{
		Pool:   pool,
		Ledger: &ConsentSyncLedger{Pool: pool, Deliverer: deliverer},
	}
	sweeper.tick(ctx)
	if deliverer.calls != 0 {
		t.Fatalf("attempted %d deliveries on a row that is not due yet", deliverer.calls)
	}
}

func TestTheSweeperIsInertWithoutADeliverer(t *testing.T) {
	// Same fail-visible posture the ledger itself takes: no deliverer means no
	// claiming work, rather than marking rows attempted against nothing.
	pool := newConsentSyncPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := seedDueConsentRow(t, pool, ctx)

	sweeper := &ConsentSyncSweeper{Pool: pool, Ledger: &ConsentSyncLedger{Pool: pool}}
	sweeper.tick(ctx)

	if status, attempts := readConsentRow(t, pool, ctx, tenantID); status != "retrying" || attempts != 1 {
		t.Fatalf("status=%q attempts=%d — the row was touched with no way to deliver it",
			status, attempts)
	}
}
