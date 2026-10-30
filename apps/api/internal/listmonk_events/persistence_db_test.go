// SPDX-License-Identifier: AGPL-3.0-only

package listmonk_events

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var persistenceHistoricalAt = time.Date(2000, 1, 2, 3, 4, 5, 0, time.UTC)

func requirePartitionedPersistenceSchema(t *testing.T, pool *db.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var subscriberKind, reportKind string
	var ledgerPresent, legacyPresent bool
	if err := pool.QueryRow(ctx, `
SELECT subscriber.relkind::text,
       report.relkind::text,
       to_regclass('public.subscriber_event_dedup_keys') IS NOT NULL,
       to_regclass('public.subscriber_events_legacy') IS NOT NULL
  FROM pg_class subscriber
  JOIN pg_namespace subscriber_ns ON subscriber_ns.oid = subscriber.relnamespace
  JOIN pg_class report ON report.relname = 'campaign_report_events'
  JOIN pg_namespace report_ns ON report_ns.oid = report.relnamespace
 WHERE subscriber.relname = 'subscriber_events'
   AND subscriber_ns.nspname = current_schema()
   AND report_ns.nspname = current_schema()`).Scan(
		&subscriberKind, &reportKind, &ledgerPresent, &legacyPresent,
	); err != nil {
		t.Fatalf("inspect partitioned persistence schema: %v", err)
	}
	if subscriberKind != "p" || reportKind != "p" || !ledgerPresent || !legacyPresent {
		t.Fatalf("requires migrations 0339/1727 and retained legacy partitions (subscriber=%q report=%q ledger=%v legacy=%v)",
			subscriberKind, reportKind, ledgerPresent, legacyPresent)
	}
}

func seedPersistenceSubject(t *testing.T, pool *db.Pool) (tenantID, campaignID, email string) {
	t.Helper()
	tenantID = uuid.NewString()
	campaignID = uuid.NewString()
	email = "listmonk-persist-" + uuid.NewString() + "@example.test"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open persistence seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'listmonk persistence test', 'lm-persist-' || left($1::text, 8), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed persistence tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, mailchimp_status,
    consent_source, custom_fields, tags, merge_fields, groups, gdpr_permissions
)
VALUES (
    $1::uuid, $2, $2, 'unconfirmed', 'non_subscribed',
    'unknown', '{}'::jsonb, ARRAY[]::text[], '{}'::jsonb, '[]'::jsonb, '[]'::jsonb
)`, tenantID, email); err != nil {
		t.Fatalf("seed persistence subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, status)
VALUES ($2::uuid, $1::uuid, 'Listmonk persistence test', 'Test', 'draft')`,
		tenantID, campaignID); err != nil {
		t.Fatalf("seed persistence campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit persistence fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		subscriberCleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open subscriber cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = subscriberCleanup.Rollback(cleanupCtx) }()
		// Subscriber deletion advances the exact-address generation ledger, so
		// let that trigger commit while its tenant FK still exists.
		if _, cleanupErr := subscriberCleanup.Exec(cleanupCtx,
			`DELETE FROM subscribers WHERE tenant_id=$1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup subscribers: %v", cleanupErr)
			return
		}
		if cleanupErr := subscriberCleanup.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit subscriber cleanup: %v", cleanupErr)
			return
		}

		tenantCleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open tenant cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = tenantCleanup.Rollback(cleanupCtx) }()
		if _, cleanupErr := tenantCleanup.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id=$1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup tenant: %v", cleanupErr)
			return
		}
		if cleanupErr := tenantCleanup.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit tenant cleanup: %v", cleanupErr)
			return
		}

		verify, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open cleanup verification: %v", cleanupErr)
			return
		}
		defer func() { _ = verify.Rollback(cleanupCtx) }()
		var remaining int
		if cleanupErr := verify.QueryRow(cleanupCtx, `
SELECT (SELECT count(*) FROM subscriber_events WHERE tenant_id=$1::uuid)
     + (SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid)
     + (SELECT count(*) FROM subscriber_event_dedup_keys WHERE tenant_id=$1::uuid)
     + (SELECT count(*) FROM contact_activity WHERE tenant_id=$1::uuid)
     + (SELECT count(*) FROM email_suppressions WHERE tenant_id=$1::uuid)`,
			tenantID).Scan(&remaining); cleanupErr != nil {
			t.Errorf("verify persistence cleanup: %v", cleanupErr)
			return
		}
		if remaining != 0 {
			t.Errorf("persistence cleanup left %d tenant rows", remaining)
		}
	})
	return tenantID, campaignID, email
}

func tenantCount(
	t *testing.T,
	pool *db.Pool,
	tenantID, query string,
	args ...any,
) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open count tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		t.Fatalf("count query: %v", err)
	}
	return count
}

func TestPersistDeduplicatesConcurrentPartitionedWritesDB(t *testing.T) {
	pool := newMembershipTransactionTestPool(t)
	requirePartitionedPersistenceSchema(t, pool)
	tenantID, campaignID, email := seedPersistenceSubject(t, pool)
	providerID := "listmonk-concurrent-" + uuid.NewString()
	ev := CanonicalEvent{
		TenantID:        tenantID,
		SubscriberEmail: email,
		EventType:       EventOpened,
		CampaignID:      campaignID,
		Source:          "listmonk",
		ProviderEventID: providerID,
		At:              persistenceHistoricalAt,
	}
	d := &Deps{Pool: pool}
	type result struct {
		inserted bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for range 2 {
		go func() {
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			inserted, err := d.persist(ctx, ev)
			results <- result{inserted: inserted, err: err}
		}()
	}
	close(start)
	insertedCount := 0
	for range 2 {
		got := <-results
		if got.err != nil {
			t.Fatalf("concurrent persist: %v", got.err)
		}
		if got.inserted {
			insertedCount++
		}
	}
	if insertedCount != 1 {
		t.Fatalf("inserted=true results = %d, want 1", insertedCount)
	}

	checks := []struct {
		name  string
		query string
	}{
		{"subscriber event", `SELECT count(*) FROM subscriber_events WHERE tenant_id=$1::uuid AND source='listmonk' AND provider_event_id=$2`},
		{"campaign report", `SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid AND source='listmonk' AND provider_event_id=$2`},
		{"contact activity", `SELECT count(*) FROM contact_activity WHERE tenant_id=$1::uuid AND metadata->>'provider_event_id'=$2`},
		{"dedup key", `SELECT count(*) FROM subscriber_event_dedup_keys WHERE tenant_id=$1::uuid AND source='listmonk' AND source_event_id=$2 AND event_id IS NOT NULL AND event_at IS NOT NULL`},
		{"bound pointer", `
SELECT count(*)
  FROM subscriber_event_dedup_keys key
  JOIN subscriber_events event
    ON event.tenant_id=key.tenant_id AND event.id=key.event_id AND event.at=key.event_at
 WHERE key.tenant_id=$1::uuid AND key.source='listmonk' AND key.source_event_id=$2`},
	}
	for _, check := range checks {
		if got := tenantCount(t, pool, tenantID, check.query, tenantID, providerID); got != 1 {
			t.Errorf("%s count = %d, want 1", check.name, got)
		}
	}
}

func TestPersistRollsBackEveryProjectionThenRetriesDB(t *testing.T) {
	pool := newMembershipTransactionTestPool(t)
	requirePartitionedPersistenceSchema(t, pool)
	tenantID, campaignID, email := seedPersistenceSubject(t, pool)
	providerID := "listmonk-rollback-" + uuid.NewString()
	ev := CanonicalEvent{
		TenantID:        tenantID,
		SubscriberEmail: email,
		EventType:       EventBounced,
		CampaignID:      campaignID,
		Source:          "listmonk",
		ProviderEventID: providerID,
		BounceType:      "hard",
		Reason:          "550 mailbox unavailable",
		At:              persistenceHistoricalAt,
	}
	sentinel := errors.New("injected transactional fanout failure")
	failing := &Deps{
		Pool: pool,
		CanonicalWebhooks: func(context.Context, pgx.Tx, TransactionalWebhookEvent) (int, error) {
			return 0, sentinel
		},
	}
	if inserted, err := failing.persist(context.Background(), ev); inserted || !errors.Is(err, sentinel) {
		t.Fatalf("failed persist = (%v, %v), want false and wrapped sentinel", inserted, err)
	}

	zeroChecks := []string{
		`SELECT count(*) FROM subscriber_events WHERE tenant_id=$1::uuid AND provider_event_id=$2`,
		`SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid AND provider_event_id=$2`,
		`SELECT count(*) FROM contact_activity WHERE tenant_id=$1::uuid AND metadata->>'provider_event_id'=$2`,
		`SELECT count(*) FROM email_suppressions WHERE tenant_id=$1::uuid AND provider_event_id=$2`,
		`SELECT count(*) FROM subscriber_event_dedup_keys WHERE tenant_id=$1::uuid AND source_event_id=$2`,
	}
	for _, query := range zeroChecks {
		if got := tenantCount(t, pool, tenantID, query, tenantID, providerID); got != 0 {
			t.Errorf("projection committed after rollback: count=%d query=%s", got, query)
		}
	}
	if got := tenantCount(t, pool, tenantID,
		`SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND email=$2 AND status='unconfirmed'`,
		tenantID, email); got != 1 {
		t.Fatalf("subscriber suppression state changed after rollback")
	}

	succeeding := &Deps{Pool: pool}
	if inserted, err := succeeding.persist(context.Background(), ev); err != nil || !inserted {
		t.Fatalf("retry persist = (%v, %v), want true, nil", inserted, err)
	}
	if inserted, err := succeeding.persist(context.Background(), ev); err != nil || inserted {
		t.Fatalf("deduped replay = (%v, %v), want false, nil", inserted, err)
	}
	for _, query := range zeroChecks {
		if got := tenantCount(t, pool, tenantID, query, tenantID, providerID); got != 1 {
			t.Errorf("projection count after retry = %d, want 1; query=%s", got, query)
		}
	}
	if got := tenantCount(t, pool, tenantID,
		`SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND email=$2 AND status='blocklisted'`,
		tenantID, email); got != 1 {
		t.Fatalf("hard-bounce subscriber state was not committed on retry")
	}
}

func TestPersistAdoptsLegacyProviderEventInsteadOfRetryLoopDB(t *testing.T) {
	pool := newMembershipTransactionTestPool(t)
	requirePartitionedPersistenceSchema(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var legacyPresent bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.subscriber_events_legacy') IS NOT NULL`).Scan(&legacyPresent); err != nil {
		t.Fatalf("inspect legacy partition: %v", err)
	}
	if !legacyPresent {
		t.Fatalf("subscriber_events_legacy has been retired by retention")
	}
	tenantID, _, email := seedPersistenceSubject(t, pool)
	providerID := "listmonk-legacy-" + uuid.NewString()
	legacyAt := persistenceHistoricalAt
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open legacy seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var legacyID int64
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events_legacy (
    tenant_id, subscriber_email, event_type, at, source,
    provider_event_id, source_event_id, metadata
)
VALUES ($1::uuid, $2, 'opened', $3, 'listmonk', $4, NULL, '{}'::jsonb)
RETURNING id`, tenantID, email, legacyAt, providerID).Scan(&legacyID); err != nil {
		t.Fatalf("seed legacy provider event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy event: %v", err)
	}

	inserted, err := (&Deps{Pool: pool}).persist(context.Background(), CanonicalEvent{
		TenantID:        tenantID,
		SubscriberEmail: email,
		EventType:       EventOpened,
		Source:          "listmonk",
		ProviderEventID: providerID,
		At:              legacyAt,
	})
	if err != nil || inserted {
		t.Fatalf("legacy replay = (%v, %v), want false, nil", inserted, err)
	}
	if got := tenantCount(t, pool, tenantID,
		`SELECT count(*) FROM subscriber_events WHERE tenant_id=$1::uuid AND source='listmonk' AND provider_event_id=$2`,
		tenantID, providerID); got != 1 {
		t.Fatalf("legacy replay event count = %d, want 1", got)
	}
	if got := tenantCount(t, pool, tenantID, `
SELECT count(*)
  FROM subscriber_event_dedup_keys
 WHERE tenant_id=$1::uuid AND source='listmonk' AND source_event_id=$2
   AND event_id=$3 AND event_at=$4`,
		tenantID, providerID, legacyID, legacyAt); got != 1 {
		t.Fatalf("legacy canonical pointer was not adopted")
	}
}

func TestPersistenceSQLHasNoPartitionInvalidConflictArbiter(t *testing.T) {
	const forbidden = "ON CONFLICT (tenant_id, source, provider_event_id)"
	source, err := os.ReadFile("handler.go")
	if err != nil {
		t.Fatalf("read handler source: %v", err)
	}
	for _, required := range []string{
		"subscriberevents.ClaimDedupKey(",
		"subscriberevents.BindDedupKey(",
		"provider_event_id, source_event_id",
		"findExistingProviderEvent(",
	} {
		if !strings.Contains(string(source), required) {
			t.Errorf("handler persistence lost required dedup contract %q", required)
		}
	}
	if strings.Contains(strings.ToUpper(string(source)), strings.ToUpper(forbidden)) {
		t.Fatalf("handler persistence retained partition-invalid conflict arbiter %q", forbidden)
	}
}
