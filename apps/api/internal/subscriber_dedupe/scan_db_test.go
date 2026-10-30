// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_dedupe

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newDedupeDBPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed duplicate scan test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedDedupeTenant creates a tenant that belongs to the calling test alone and
// deletes it when the test ends.
//
// Both statements run as the application role in a transaction bound to the
// new tenant (db.WithTenant). tenants is FORCE ROW LEVEL SECURITY: its INSERT
// policy admits a row only when id equals app.tenant_id, and its DELETE policy
// sees only that row. This helper used to insert on the bare pool unless
// POSTWAVE_ADMIN_DATABASE_URL named a privileged role. CI sets no such
// variable (its admin URL is POSTWAVE_TEST_ADMIN_DATABASE_URL), so the policy
// refused the insert (SQLSTATE 42501), the helper called t.Skipf, and the test
// never ran in CI. Its teardown, also unbound, could never have matched the
// row. A seed or teardown that fails now fails the test.
func seedDedupeTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'dedupe-scan-test', $2, 'studio')`,
		tenantID, "dedupe-scan-"+tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	// ON DELETE CASCADE removes the subscribers, scans and candidate pairs.
	t.Cleanup(func() { deleteDedupeTestTenant(t, pool, tenantID) })
	return tenantID
}

func TestCompleteScanIsExhaustivePagedRLSBoundAndPrivacyMinimised_DB(t *testing.T) {
	pool := newDedupeDBPool(t)
	tenantID := seedDedupeTenant(t, pool)
	otherTenantID := seedDedupeTenant(t, pool)
	// A hang guard, not a latency assertion. The 45 seconds this used to allow
	// were never exercised in CI, where the tenant seed skipped the test (see
	// seedDedupeTenant). Once it ran, seeding and scanning 2,115 subscribers
	// through the projection triggers took 44.9 s in a full parallel run of
	// the suite against one shared database, a hair under that budget.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	seed := func(tenant string, statement string, args ...any) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenant)
		if err != nil {
			t.Fatalf("tenant seed tx: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, statement, args...); err != nil {
			t.Fatalf("seed subscribers: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit subscribers: %v", err)
		}
	}

	// More than the historical 2,000-row fuzzy cap, with the duplicate pair at
	// the end. One set-based insert keeps the test fast while every row still
	// exercises the production projection trigger.
	seed(tenantID, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
SELECT $1::uuid, 'scale-' || n::text || '@example.test', 'enabled', 'api'
  FROM generate_series(1, 2105) n`, tenantID)
	seed(tenantID, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, phone_e164)
VALUES
  ($1::uuid, 'late@example.test', 'enabled', 'api', '+15550000001'),
  ($1::uuid, 'late+campaign@example.test', 'enabled', 'api', '+15550000001'),
  ($1::uuid, 'jane.smith@gmail.com', 'enabled', 'api', NULL),
  ($1::uuid, 'janesmith@gmail.com', 'enabled', 'api', NULL),
  ($1::uuid, 'domain@googlemail.com', 'enabled', 'api', NULL),
  ($1::uuid, 'domain@gmail.com', 'enabled', 'api', NULL),
  ($1::uuid, 'unrelated@hotmail.com', 'enabled', 'api', NULL),
  ($1::uuid, 'unrelated@outlook.com', 'enabled', 'api', NULL),
  ($1::uuid, 'john@example.test', 'enabled', 'api', NULL),
  ($1::uuid, 'j0hn@example.test', 'enabled', 'api', NULL)`, tenantID)
	seed(otherTenantID, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES
  ($1::uuid, 'private@example.test', 'enabled', 'api'),
  ($1::uuid, 'private+alias@example.test', 'enabled', 'api'),
  ($1::uuid, 'late@example.test', 'enabled', 'api')`, otherTenantID)

	deps := &Deps{Pool: pool}
	scan, err := deps.createCompleteScan(ctx, tenantID)
	if err != nil {
		t.Fatalf("create complete scan: %v", err)
	}
	if !scan.Complete || scan.Status != "complete" {
		t.Fatalf("scan = %+v, want immutable complete manifest", scan)
	}
	if scan.CompletedAt == nil || scan.ExpiresAt.Sub(*scan.CompletedAt) != 24*time.Hour {
		t.Fatalf("scan retention = %+v, want exactly 24 hours after completion", scan)
	}
	if scan.SubscriberCount != 2115 {
		t.Fatalf("subscriber_count = %d, want 2115", scan.SubscriberCount)
	}
	if scan.CandidateCount < 4 {
		t.Fatalf("candidate_count = %d, want all deterministic groups", scan.CandidateCount)
	}

	// Tenant ownership is a structural database invariant, not just an RLS
	// query filter. Even an app-role transaction that knows another tenant's
	// UUIDs cannot attach that subscriber to this projection or attach this
	// tenant's pair to the other tenant's scan.
	otherScan, err := deps.createCompleteScan(ctx, otherTenantID)
	if err != nil {
		t.Fatalf("create other-tenant complete scan: %v", err)
	}
	otherReadTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("other-tenant identity tx: %v", err)
	}
	var otherSubscriberID string
	if err := otherReadTx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND email = 'private@example.test'`,
		otherTenantID).Scan(&otherSubscriberID); err != nil {
		_ = otherReadTx.Rollback(ctx)
		t.Fatalf("read other-tenant subscriber id: %v", err)
	}
	_ = otherReadTx.Rollback(ctx)
	assertForeignKeyViolation := func(label string, err error) {
		t.Helper()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
			t.Fatalf("%s err = %v, want foreign-key violation", label, err)
		}
	}
	keyOwnershipTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("key ownership tx: %v", err)
	}
	_, keyOwnershipErr := keyOwnershipTx.Exec(ctx, `
INSERT INTO subscriber_dedupe_keys (
    tenant_id, subscriber_id, subscriber_created_at, subscriber_updated_at,
    email_key, plus_key, dot_key, domain_key, homoglyph_key,
    phone_key, external_id_key, plus_changed, dot_changed,
    domain_changed, homoglyph_changed
)
SELECT $1::uuid, $2::uuid, subscriber_created_at, subscriber_updated_at,
       email_key, plus_key, dot_key, domain_key, homoglyph_key,
       phone_key, external_id_key, plus_changed, dot_changed,
       domain_changed, homoglyph_changed
  FROM subscriber_dedupe_keys
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID, otherSubscriberID)
	assertForeignKeyViolation("cross-tenant projection", keyOwnershipErr)
	_ = keyOwnershipTx.Rollback(ctx)

	pairOwnershipTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("pair ownership tx: %v", err)
	}
	_, pairOwnershipErr := pairOwnershipTx.Exec(ctx, `
INSERT INTO subscriber_duplicate_scan_pairs (
    tenant_id, scan_id, ordinal, primary_id, duplicate_id,
    primary_updated_at, duplicate_updated_at, confidence, evidence
)
SELECT $1::uuid, $2::uuid, 9223372036854770000,
       primary_id, duplicate_id, primary_updated_at, duplicate_updated_at,
       confidence, evidence
  FROM subscriber_duplicate_scan_pairs
 WHERE tenant_id = $1::uuid AND scan_id = $3::uuid
 LIMIT 1`, tenantID, otherScan.ID, scan.ID)
	assertForeignKeyViolation("cross-tenant scan pair", pairOwnershipErr)
	_ = pairOwnershipTx.Rollback(ctx)

	// Cursor pages add up to the authoritative candidate count without pair
	// duplication. The late plus-alias proves rows after 2,000 are included.
	seen := map[string]bool{}
	cursor := int64(0)
	lateFound := false
	safeDomainFound := false
	for {
		page, err := deps.loadScanPage(ctx, tenantID, scan.ID, cursor, 2)
		if err != nil {
			t.Fatalf("load scan page: %v", err)
		}
		for _, pair := range page.Pairs {
			identity := pair.PrimaryID + ":" + pair.DuplicateID
			if seen[identity] {
				t.Fatalf("pair repeated across cursor pages: %s", identity)
			}
			seen[identity] = true
			if strings.Contains(pair.PrimaryEmail, "private") || strings.Contains(pair.DuplicateEmail, "private") {
				t.Fatal("cross-tenant candidate leaked into scan")
			}
			if strings.HasPrefix(pair.PrimaryEmail, "unrelated@") && strings.HasPrefix(pair.DuplicateEmail, "unrelated@") {
				t.Fatal("distinct Microsoft-domain mailboxes were treated as equivalent")
			}
			isSafeDomainPair := strings.HasPrefix(pair.PrimaryEmail, "domain@") && strings.HasPrefix(pair.DuplicateEmail, "domain@")
			for _, evidence := range pair.Evidence {
				if evidence.Kind == "plus_alias" &&
					(strings.HasPrefix(pair.PrimaryEmail, "late") || strings.HasPrefix(pair.DuplicateEmail, "late")) {
					lateFound = true
				}
				if isSafeDomainPair && evidence.Kind == "domain_substitution" {
					safeDomainFound = true
				}
				if isSafeDomainPair && evidence.Kind == "dot_alias" {
					t.Fatal("domain-only Gmail equivalence was mislabeled as dot normalization")
				}
			}
		}
		if page.NextCursor == "" {
			break
		}
		var parseErr error
		cursor, parseErr = parseCursor(page.NextCursor)
		if parseErr != nil {
			t.Fatalf("server emitted invalid cursor: %v", parseErr)
		}
	}
	if int64(len(seen)) != scan.CandidateCount {
		t.Fatalf("paged pairs = %d, candidate_count = %d", len(seen), scan.CandidateCount)
	}
	if !lateFound {
		t.Fatal("pair after historical 2,000-row cap was not discovered")
	}
	if !safeDomainFound {
		t.Fatal("gmail.com/googlemail.com equivalence was not discovered")
	}

	// Projection and manifest persistence contain only digests and generic
	// evidence, never raw email/phone/upstream identifiers.
	privacyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("privacy tx: %v", err)
	}
	var rawProjectionLeaks, rawManifestLeaks int
	if err := privacyTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_dedupe_keys
 WHERE tenant_id = $1::uuid
   AND (encode(plus_key, 'escape') LIKE '%late@example.test%'
     OR encode(phone_key, 'escape') LIKE '%15550000001%')`, tenantID).Scan(&rawProjectionLeaks); err != nil {
		t.Fatalf("inspect privacy projection: %v", err)
	}
	if err := privacyTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_duplicate_scan_pairs
 WHERE tenant_id = $1::uuid
   AND evidence::text ~* '(late@example|15550000001|private@example)'`, tenantID).Scan(&rawManifestLeaks); err != nil {
		t.Fatalf("inspect scan manifest privacy: %v", err)
	}
	_ = privacyTx.Rollback(ctx)
	if rawProjectionLeaks != 0 || rawManifestLeaks != 0 {
		t.Fatalf("raw identifier persisted: projection=%d manifest=%d", rawProjectionLeaks, rawManifestLeaks)
	}
	digestForTenant := func(tenant string) []byte {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenant)
		if err != nil {
			t.Fatalf("digest tenant tx: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var digest []byte
		if err := tx.QueryRow(ctx, `
SELECT keys.email_key
  FROM subscriber_dedupe_keys keys
  JOIN subscribers subscriber
    ON subscriber.tenant_id = keys.tenant_id
   AND subscriber.id = keys.subscriber_id
 WHERE keys.tenant_id = $1::uuid AND subscriber.email = 'late@example.test'`,
			tenant).Scan(&digest); err != nil {
			t.Fatalf("read tenant-scoped digest: %v", err)
		}
		return digest
	}
	if bytes.Equal(digestForTenant(tenantID), digestForTenant(otherTenantID)) {
		t.Fatal("equal identifiers across tenants produced a correlatable digest")
	}

	// A post-scan row change cannot reuse the old review.
	firstPage, err := deps.loadScanPage(ctx, tenantID, scan.ID, 0, 1)
	if err != nil || len(firstPage.Pairs) != 1 {
		t.Fatalf("load stale-test pair: page=%+v err=%v", firstPage, err)
	}
	changedID := firstPage.Pairs[0].PrimaryID
	changeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("change tx: %v", err)
	}
	if _, err := changeTx.Exec(ctx, `
UPDATE subscribers SET custom_fields = custom_fields || '{"review_changed":true}'::jsonb
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, changedID); err != nil {
		_ = changeTx.Rollback(ctx)
		t.Fatalf("change scanned row: %v", err)
	}
	if err := changeTx.Commit(ctx); err != nil {
		t.Fatalf("commit scanned row change: %v", err)
	}
	versionTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("projection version tx: %v", err)
	}
	var projectionCurrent bool
	if err := versionTx.QueryRow(ctx, `
SELECT subscriber.updated_at = keys.subscriber_updated_at
  FROM subscribers subscriber
  JOIN subscriber_dedupe_keys keys
    ON keys.tenant_id = subscriber.tenant_id
   AND keys.subscriber_id = subscriber.id
 WHERE subscriber.tenant_id = $1::uuid AND subscriber.id = $2::uuid`,
		tenantID, changedID).Scan(&projectionCurrent); err != nil {
		_ = versionTx.Rollback(ctx)
		t.Fatalf("read projection version: %v", err)
	}
	_ = versionTx.Rollback(ctx)
	if !projectionCurrent {
		t.Fatal("non-identity subscriber update did not refresh the dedupe projection version")
	}
	stalePage, err := deps.loadScanPage(ctx, tenantID, scan.ID, 0, 1)
	if err != nil || len(stalePage.Pairs) != 1 || !stalePage.Pairs[0].Stale {
		t.Fatalf("changed scan pair was not stale: page=%+v err=%v", stalePage, err)
	}

	// Resource-heavy complete scans are serialized per tenant. Holding the
	// production advisory key proves a second request fails fast instead of
	// running a redundant full-workspace materialization concurrently.
	lockTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("scan lock tx: %v", err)
	}
	defer func() { _ = lockTx.Rollback(ctx) }()
	if _, err := lockTx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
    hashtextextended($1 || ':subscriber-duplicate-scan', 0)
)`, tenantID); err != nil {
		t.Fatalf("hold scan lock: %v", err)
	}
	if _, err := deps.createCompleteScan(ctx, tenantID); !errors.Is(err, errScanRunning) {
		t.Fatalf("concurrent scan err = %v, want errScanRunning", err)
	}
}

// deleteDedupeTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteDedupeTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteDedupeTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteDedupeTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
