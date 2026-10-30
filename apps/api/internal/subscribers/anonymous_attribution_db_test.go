// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// What someone did before they told you who they were still counts.
//
// `AttributeAnonymousEvents` was written for exactly this and called from
// nowhere — its own header said it was "intentionally NOT called from
// stitchAnonymous or Identify yet". A visitor browsed anonymously, identified,
// and everything before that moment stayed unattributed: the timeline opened at
// the identify, and any segment or flow keyed on those events never saw them.
//
// It is wired now. This is the Proof the ledger asked for, which nothing
// asserted: anonymous events → identify → they appear on the subscriber.

func seedAnonymousEvent(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, anonymousID string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_anonymous_events
    (tenant_id, anonymous_id, event_name, event_type, properties, occurred_at)
VALUES ($1::uuid, $2, 'viewed_pricing', 'custom', '{"plan":"studio"}'::jsonb, now() - interval '5 minutes')`,
		tenantID, anonymousID); err != nil {
		t.Fatalf("seed anonymous event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func TestPreIdentificationEventsLandOnTheSubscriber(t *testing.T) {
	pool := newConsentSyncPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	anonymousID := "anon-" + uuid.NewString()[:12]
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, "anon-attr-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	subscriberID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'import')`,
		subscriberID, tenantID, "known-"+subscriberID[:8]+"@example.test"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		for _, q := range []string{
			`DELETE FROM subscriber_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscriber_anonymous_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			_, _ = c.Exec(bg, q, tenantID)
		}
		_ = c.Commit(bg)
	})

	seedAnonymousEvent(t, pool, ctx, tenantID, anonymousID)

	classifier := &spyEngagementClassifier{}
	repo := &Repo{Pool: pool, EngagementClassifier: classifier}
	copied, err := repo.AttributeAnonymousEvents(ctx, tenantID, anonymousID, subscriberID)
	if err != nil {
		t.Fatalf("AttributeAnonymousEvents: %v", err)
	}
	if copied != 1 {
		t.Fatalf("copied=%d, want 1 — the visit before the identify was lost", copied)
	}
	if classifier.calls != 1 || classifier.lastRef.ID == 0 {
		t.Fatalf("attributed event classifier calls=%d ref=%+v; anonymous engagement is missing from the reclassification corpus",
			classifier.calls, classifier.lastRef)
	}
	if classifier.scopeErr != nil || classifier.workerScope != "true" {
		t.Fatalf("attribution classifier worker scope=%q err=%v; a real runtime would reject this call",
			classifier.workerScope, classifier.scopeErr)
	}

	// The anonymous row is marked so a second pass cannot double-count.
	rtx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rtx.Rollback(ctx) }()
	var attributed int
	if err := rtx.QueryRow(ctx, `
SELECT count(*)::int FROM subscriber_anonymous_events
 WHERE tenant_id = $1::uuid AND anonymous_id = $2 AND attributed_at IS NOT NULL`,
		tenantID, anonymousID).Scan(&attributed); err != nil {
		t.Fatalf("read anonymous rows: %v", err)
	}
	if attributed != 1 {
		t.Fatalf("attributed_at set on %d rows, want 1", attributed)
	}
}

func TestAttributingTwiceDoesNotDoubleCount(t *testing.T) {
	// The identify path is best-effort and can run more than once for the same
	// visitor — a retried request, a second identify with the same anonymous
	// id. A second pass must copy nothing.
	pool := newConsentSyncPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	anonymousID := "anon-" + uuid.NewString()[:12]
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, "anon-dedup-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	subscriberID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'import')`,
		subscriberID, tenantID, "dedup-"+subscriberID[:8]+"@example.test"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		for _, q := range []string{
			`DELETE FROM subscriber_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscriber_anonymous_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			_, _ = c.Exec(bg, q, tenantID)
		}
		_ = c.Commit(bg)
	})

	seedAnonymousEvent(t, pool, ctx, tenantID, anonymousID)
	repo := &Repo{Pool: pool}
	if _, err := repo.AttributeAnonymousEvents(ctx, tenantID, anonymousID, subscriberID); err != nil {
		t.Fatalf("first pass: %v", err)
	}
	second, err := repo.AttributeAnonymousEvents(ctx, tenantID, anonymousID, subscriberID)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if second != 0 {
		t.Fatalf("second pass copied %d rows — the visitor's history is now duplicated", second)
	}
}

// The WIRING, not just the function.
//
// The first version of this file called AttributeAnonymousEvents directly, so
// it stayed green when `attributeAnonymousAfterIdentify` was stubbed out — it
// proved the copier worked and nothing about whether Identify called it, which
// is the entire defect the row described ("intentionally NOT called from
// stitchAnonymous or Identify yet").
func TestIdentifyItselfAttributesPriorActivity(t *testing.T) {
	pool := newConsentSyncPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	anonymousID := "anon-" + uuid.NewString()[:12]
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, "anon-wire-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		for _, q := range []string{
			`DELETE FROM subscriber_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscriber_anonymous_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			_, _ = c.Exec(bg, q, tenantID)
		}
		_ = c.Commit(bg)
	})

	// Browse anonymously...
	seedAnonymousEvent(t, pool, ctx, tenantID, anonymousID)

	// ...then say who you are.
	repo := &Repo{Pool: pool}
	if _, err := repo.Identify(ctx, tenantID, IdentifyInput{
		Email:       "wired-" + anonymousID[5:13] + "@example.test",
		AnonymousID: anonymousID,
	}); err != nil {
		t.Fatalf("Identify: %v", err)
	}

	rtx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rtx.Rollback(ctx) }()
	var attributed int
	if err := rtx.QueryRow(ctx, `
SELECT count(*)::int FROM subscriber_anonymous_events
 WHERE tenant_id = $1::uuid AND anonymous_id = $2 AND attributed_at IS NOT NULL`,
		tenantID, anonymousID).Scan(&attributed); err != nil {
		t.Fatalf("read anonymous rows: %v", err)
	}
	if attributed == 0 {
		t.Fatal("Identify did not attribute the prior activity — the timeline " +
			"still opens at the identify and any segment or flow keyed on those " +
			"events never sees them")
	}
}
