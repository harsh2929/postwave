// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func seedConversionIdentitySubject(
	ctx context.Context,
	t *testing.T,
	pool *db.Pool,
	tenantID, canonicalEmail, aliasEmail string,
) (subscriberID, externalID string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open conversion identity subject seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, consent_source, external_id
) VALUES ($1::uuid, $2::citext, $2::citext, 'enabled', 'api', $3)
RETURNING id::text, external_id`, tenantID, canonicalEmail,
		"conversion-subject-"+uuid.NewString()).Scan(&subscriberID, &externalID); err != nil {
		t.Fatalf("seed conversion identity subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails (
    tenant_id, subscriber_id, email, is_primary, consent_status, suppressed
) VALUES
    ($1::uuid, $2::uuid, $3::citext, true, 'never_subscribed', false),
    ($1::uuid, $2::uuid, $4::citext, false, 'never_subscribed', false)
ON CONFLICT DO NOTHING`, tenantID, subscriberID, canonicalEmail, aliasEmail); err != nil {
		t.Fatalf("seed conversion identity aliases: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversion identity subject seed: %v", err)
	}
	return subscriberID, externalID
}

func seedConversionIdentityEvidence(
	ctx context.Context,
	t *testing.T,
	pool *db.Pool,
	tenantID, subscriberID, externalID, canonicalEmail, aliasEmail string,
) (conversionIDs []int64, keyID, hmacDigest, clickID string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open conversion evidence seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	keyID = strings.ReplaceAll(uuid.NewString(), "-", "")
	hmacDigest = strings.Repeat("a", 64)
	clickID = "click-" + uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_ingest_secrets (
    tenant_id, key_id, label, secret, secret_envelope, secret_kms_key_arn
) VALUES (
    $1::uuid, $2, 'privacy-erasure-test', 'envelope:do-not-use',
    decode('020123456789abcdef', 'hex'),
    'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000001'
)`, tenantID, keyID); err != nil {
		t.Fatalf("seed conversion signing key: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_email_hmac_bindings (
    tenant_id, key_id, digest, subscriber_id
) VALUES ($1::uuid, $2, $3, $4::uuid)`, tenantID, keyID, hmacDigest, subscriberID); err != nil {
		t.Fatalf("seed exact HMAC binding: %v", err)
	}

	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject)
VALUES ($1::uuid, 'privacy erasure evidence', 'privacy erasure evidence')
RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_click_identities (
    tenant_id, click_id, subscriber_id, campaign_id, source
) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'signed_ingest_observation')`,
		tenantID, clickID, subscriberID, campaignID); err != nil {
		t.Fatalf("seed click identity binding: %v", err)
	}

	rows, err := tx.Query(ctx, `
INSERT INTO conversions (
    tenant_id, event_name, subscriber_email, email_sha256,
    email_hmac_sha256, email_hmac_key_id, click_id, external_id
)
VALUES
    ($1::uuid, 'plaintext-only', $2::citext, NULL, NULL, NULL, NULL, NULL),
    ($1::uuid, 'sha-only', NULL,
        encode(digest(lower(btrim($3)), 'sha256'), 'hex'),
        NULL, NULL, NULL, NULL),
    ($1::uuid, 'hmac-only', NULL, NULL, $4, $5, NULL, NULL),
    ($1::uuid, 'click-only', NULL, NULL, NULL, NULL, $6, NULL),
    ($1::uuid, 'external-only', NULL, NULL, NULL, NULL, NULL, $7)
RETURNING id`, tenantID, canonicalEmail, aliasEmail, hmacDigest, keyID, clickID, externalID)
	if err != nil {
		t.Fatalf("seed conversion identity facts: %v", err)
	}
	for rows.Next() {
		var conversionID int64
		if err := rows.Scan(&conversionID); err != nil {
			rows.Close()
			t.Fatalf("scan seeded conversion: %v", err)
		}
		conversionIDs = append(conversionIDs, conversionID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate seeded conversions: %v", err)
	}
	rows.Close()
	if len(conversionIDs) != 5 {
		t.Fatalf("seeded conversion count = %d, want 5", len(conversionIDs))
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_attribution_touches (
    tenant_id, conversion_id, touch_kind, identity_kind, identity_value,
    identity_key_id, resolution_rank, subscriber_id, campaign_id, touched_at,
    is_winner
)
VALUES
    ($1::uuid, $2, 'identity', 'email_sha256', repeat('b', 64), NULL, 1, $7::uuid, NULL, NULL, true),
    ($1::uuid, $3, 'identity', 'email_hmac_sha256', $8, $9, 1, $7::uuid, NULL, NULL, true),
    ($1::uuid, $4, 'identity', 'click_id', $10, NULL, 2, $7::uuid, NULL, NULL, true),
    ($1::uuid, $5, 'identity', 'external_id', $11, NULL, 3, $7::uuid, NULL, NULL, true),
    ($1::uuid, $6, 'campaign_click', NULL, NULL, NULL, NULL, $7::uuid, $12::uuid, now(), true)
`, tenantID, conversionIDs[1], conversionIDs[2], conversionIDs[3], conversionIDs[4],
		conversionIDs[0], subscriberID, hmacDigest, keyID, clickID, externalID, campaignID); err != nil {
		t.Fatalf("seed conversion attribution touches: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversion evidence seed: %v", err)
	}
	return conversionIDs, keyID, hmacDigest, clickID
}

func TestConversionSubjectIdentityErasureTenantAliasAndReimport_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)
	tenantID, otherTenantID := uuid.NewString(), uuid.NewString()
	seedErasureTenant(t, pool, tenantID)
	seedErasureTenant(t, pool, otherTenantID)
	t.Cleanup(func() {
		cleanupErasureTenant(t, pool, tenantID)
		cleanupErasureTenant(t, pool, otherTenantID)
	})

	const canonicalEmail = "privacy-conversion@example.test"
	const aliasEmail = "privacy-conversion+alias@example.test"
	subscriberID, externalID := seedConversionIdentitySubject(
		ctx, t, pool, tenantID, canonicalEmail, aliasEmail,
	)
	conversionIDs, _, _, _ := seedConversionIdentityEvidence(
		ctx, t, pool, tenantID, subscriberID, externalID, canonicalEmail, aliasEmail,
	)

	otherTX, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("open cross-tenant canary seed: %v", err)
	}
	var otherConversionID int64
	if err := otherTX.QueryRow(ctx, `
INSERT INTO conversions (tenant_id, event_name, subscriber_email, external_id)
VALUES ($1::uuid, 'cross-tenant-canary', $2::citext, $3)
RETURNING id`, otherTenantID, aliasEmail, externalID).Scan(&otherConversionID); err != nil {
		_ = otherTX.Rollback(ctx)
		t.Fatalf("seed cross-tenant conversion canary: %v", err)
	}
	if err := otherTX.Commit(ctx); err != nil {
		t.Fatalf("commit cross-tenant canary: %v", err)
	}

	eraseTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open alias erasure: %v", err)
	}
	first, err := eraseSubscriberDataWithEntropy(
		ctx, eraseTX, tenantID, "  PRIVACY-CONVERSION+ALIAS@EXAMPLE.TEST  ",
		bytes.NewReader(bytes.Repeat([]byte{0x81}, erasureNonceBytes)),
	)
	if err != nil {
		_ = eraseTX.Rollback(ctx)
		t.Fatalf("erase by alias: %v", err)
	}
	if first.ConversionsIdentityRedacted != 5 || first.ConversionIdentityTouches != 4 ||
		first.ConversionCampaignLinks != 1 || first.ConversionClickBindings != 1 ||
		first.ConversionIdentityReceiptID == "" {
		_ = eraseTX.Rollback(ctx)
		t.Fatalf("first conversion identity erasure stats = %+v", first)
	}
	if err := eraseTX.Commit(ctx); err != nil {
		t.Fatalf("commit alias erasure: %v", err)
	}

	inspect, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open erased evidence inspection: %v", err)
	}
	defer func() { _ = inspect.Rollback(ctx) }()
	var redacted int
	if err := inspect.QueryRow(ctx, `
SELECT count(*)
  FROM conversions
 WHERE tenant_id = $1::uuid AND id = ANY($2::bigint[])
   AND subscriber_email IS NULL AND email_sha256 IS NULL
   AND email_hmac_sha256 IS NULL AND email_hmac_key_id IS NULL
   AND click_id IS NULL AND external_id IS NULL`, tenantID, conversionIDs).Scan(&redacted); err != nil {
		t.Fatalf("inspect conversion facts: %v", err)
	}
	if redacted != len(conversionIDs) {
		t.Fatalf("fully redacted conversion facts = %d, want %d", redacted, len(conversionIDs))
	}
	var shredded, severed, clickBindings int
	if err := inspect.QueryRow(ctx, `
SELECT count(*) FILTER (
           WHERE touch_kind = 'identity'
             AND identity_kind = 'identity_subject_erased'
             AND identity_value = 'subject:cryptoshredded'
             AND identity_key_id IS NULL AND subscriber_id IS NULL
             AND NOT is_winner
       ),
       count(*) FILTER (
           WHERE touch_kind = 'campaign_click' AND subscriber_id IS NULL
             AND campaign_id IS NOT NULL AND touched_at IS NOT NULL
       )
  FROM conversion_attribution_touches
 WHERE tenant_id = $1::uuid AND conversion_id = ANY($2::bigint[])`,
		tenantID, conversionIDs).Scan(&shredded, &severed); err != nil {
		t.Fatalf("inspect conversion touch erasure: %v", err)
	}
	if err := inspect.QueryRow(ctx, `
SELECT count(*) FROM conversion_click_identities
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID).
		Scan(&clickBindings); err != nil {
		t.Fatalf("inspect click binding erasure: %v", err)
	}
	if shredded != 4 || severed != 1 || clickBindings != 0 {
		t.Fatalf("touch/click erasure = shredded:%d severed:%d bindings:%d", shredded, severed, clickBindings)
	}
	if err := inspect.Commit(ctx); err != nil {
		t.Fatalf("commit evidence inspection: %v", err)
	}

	otherInspect, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("open cross-tenant canary inspection: %v", err)
	}
	var otherEmail, otherExternal string
	if err := otherInspect.QueryRow(ctx, `
SELECT subscriber_email::text, external_id
  FROM conversions WHERE tenant_id = $1::uuid AND id = $2`,
		otherTenantID, otherConversionID).Scan(&otherEmail, &otherExternal); err != nil {
		_ = otherInspect.Rollback(ctx)
		t.Fatalf("inspect cross-tenant canary: %v", err)
	}
	if otherEmail != aliasEmail || otherExternal != externalID {
		_ = otherInspect.Rollback(ctx)
		t.Fatalf("cross-tenant identity was changed: email=%q external=%q", otherEmail, otherExternal)
	}
	if err := otherInspect.Commit(ctx); err != nil {
		t.Fatalf("commit cross-tenant canary inspection: %v", err)
	}

	// Re-import the same canonical address as a new generation, then erase it
	// again. The second receipt must chain to the first without re-identifying
	// either generation.
	secondSubscriberID, _ := seedConversionIdentitySubject(
		ctx, t, pool, tenantID, canonicalEmail, "privacy-conversion+second@example.test",
	)
	secondTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open reimport conversion seed: %v", err)
	}
	var secondConversionID int64
	if err := secondTX.QueryRow(ctx, `
INSERT INTO conversions (tenant_id, event_name, subscriber_email)
VALUES ($1::uuid, 'reimport-generation', $2::citext)
RETURNING id`, tenantID, canonicalEmail).Scan(&secondConversionID); err != nil {
		_ = secondTX.Rollback(ctx)
		t.Fatalf("seed reimport conversion: %v", err)
	}
	if _, err := secondTX.Exec(ctx, `
INSERT INTO conversion_attribution_touches (
    tenant_id, conversion_id, touch_kind, identity_kind, identity_value,
    resolution_rank, subscriber_id, is_winner
) VALUES ($1::uuid, $2, 'identity', 'external_id', $3, 3, $4::uuid, true)`,
		tenantID, secondConversionID, "reimport-"+uuid.NewString(), secondSubscriberID); err != nil {
		_ = secondTX.Rollback(ctx)
		t.Fatalf("seed reimport identity touch: %v", err)
	}
	if err := secondTX.Commit(ctx); err != nil {
		t.Fatalf("commit reimport evidence: %v", err)
	}

	reeraseTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open reimport erasure: %v", err)
	}
	second, err := eraseSubscriberDataWithEntropy(
		ctx, reeraseTX, tenantID, canonicalEmail,
		bytes.NewReader(bytes.Repeat([]byte{0x82}, erasureNonceBytes)),
	)
	if err != nil {
		_ = reeraseTX.Rollback(ctx)
		t.Fatalf("erase reimport generation: %v", err)
	}
	if second.ConversionsIdentityRedacted != 1 || second.ConversionIdentityTouches != 1 ||
		second.ConversionIdentityReceiptID == first.ConversionIdentityReceiptID {
		_ = reeraseTX.Rollback(ctx)
		t.Fatalf("second conversion identity erasure stats = %+v", second)
	}
	if err := reeraseTX.Commit(ctx); err != nil {
		t.Fatalf("commit reimport erasure: %v", err)
	}

	receiptTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open receipt inspection: %v", err)
	}
	var firstFingerprint, previousFingerprint string
	if err := receiptTX.QueryRow(ctx, `
SELECT first.receipt_fingerprint, second.previous_receipt_fingerprint
  FROM conversion_subject_identity_erasure_receipts AS first
  JOIN conversion_subject_identity_erasure_receipts AS second
    ON second.tenant_id = first.tenant_id
 WHERE first.tenant_id = $1::uuid
   AND first.id = $2::uuid AND second.id = $3::uuid`, tenantID,
		first.ConversionIdentityReceiptID, second.ConversionIdentityReceiptID).Scan(
		&firstFingerprint, &previousFingerprint,
	); err != nil {
		_ = receiptTX.Rollback(ctx)
		t.Fatalf("inspect chained receipts: %v", err)
	}
	if firstFingerprint == "" || previousFingerprint != firstFingerprint {
		_ = receiptTX.Rollback(ctx)
		t.Fatalf("receipt chain mismatch first=%q previous=%q", firstFingerprint, previousFingerprint)
	}
	if err := receiptTX.Commit(ctx); err != nil {
		t.Fatalf("commit receipt inspection: %v", err)
	}

	for name, statement := range map[string]string{
		"update": `UPDATE conversion_subject_identity_erasure_receipts SET conversions_redacted = 0 WHERE tenant_id = $1::uuid`,
		"delete": `DELETE FROM conversion_subject_identity_erasure_receipts WHERE tenant_id = $1::uuid`,
	} {
		mutation, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open receipt %s attempt: %v", name, err)
		}
		if _, err := mutation.Exec(ctx, statement, tenantID); err == nil {
			_ = mutation.Rollback(ctx)
			t.Fatalf("application receipt %s was accepted", name)
		}
		_ = mutation.Rollback(ctx)
	}

	crossTenantCall, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open cross-tenant function attempt: %v", err)
	}
	if err := crossTenantCall.QueryRow(ctx, `
SELECT receipt_id FROM conversion_subject_identity_privacy_erase(
    $1::uuid, $2::citext, 'erased+blocked@erased.invalid'::citext, $3::uuid
)`, otherTenantID, aliasEmail, uuid.NewString()).Scan(new(string)); err == nil {
		_ = crossTenantCall.Rollback(ctx)
		t.Fatal("tenant A invoked conversion identity erasure for tenant B")
	}
	_ = crossTenantCall.Rollback(ctx)
}

func TestConversionSubjectIdentityErasureWaitsForPreCutoverIngest_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)
	tenantID := uuid.NewString()
	seedErasureTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupErasureTenant(t, pool, tenantID) })

	const subjectEmail = "privacy-fence@example.test"
	seedConversionIdentitySubject(
		ctx, t, pool, tenantID, subjectEmail, "privacy-fence+alias@example.test",
	)

	// This is the exact shared lock RecordSignedConversions takes before its
	// idempotency claim. Keep it open while the erasure call starts, then insert
	// the conversion: the exclusive erasure must wait and its fresh snapshot
	// must include the pre-cutover fact after this transaction commits.
	ingestTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open pre-cutover ingest: %v", err)
	}
	defer func() { _ = ingestTX.Rollback(ctx) }()
	if _, err := ingestTX.Exec(ctx, `
SELECT pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended($1, 2029)
)`, tenantID); err != nil {
		t.Fatalf("take pre-cutover shared fence: %v", err)
	}

	started := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		eraseTX, beginErr := db.WithTenant(ctx, pool, tenantID)
		if beginErr != nil {
			result <- beginErr
			return
		}
		defer func() { _ = eraseTX.Rollback(ctx) }()
		close(started)
		var receiptID string
		callErr := eraseTX.QueryRow(ctx, `
SELECT receipt_id::text
  FROM conversion_subject_identity_privacy_erase(
       $1::uuid, $2::citext,
       'erased+fence00000000000@erased.invalid'::citext,
       $3::uuid
  )`, tenantID, subjectEmail, uuid.NewString()).Scan(&receiptID)
		if callErr == nil {
			callErr = eraseTX.Commit(ctx)
		}
		result <- callErr
	}()
	<-started
	select {
	case err := <-result:
		t.Fatalf("exclusive erasure crossed an open signed-ingest fence: %v", err)
	case <-time.After(150 * time.Millisecond):
	}

	var conversionID int64
	if err := ingestTX.QueryRow(ctx, `
INSERT INTO conversions (tenant_id, event_name, subscriber_email, external_id)
VALUES ($1::uuid, 'pre-cutover-fenced', $2::citext, 'pre-cutover-identity')
RETURNING id`, tenantID, subjectEmail).Scan(&conversionID); err != nil {
		t.Fatalf("insert pre-cutover conversion: %v", err)
	}
	if err := ingestTX.Commit(ctx); err != nil {
		t.Fatalf("commit pre-cutover conversion: %v", err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("erasure after shared-fence release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("erasure did not converge after the signed-ingest fence released")
	}

	inspection, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open fence result inspection: %v", err)
	}
	defer func() { _ = inspection.Rollback(ctx) }()
	var identityGone bool
	if err := inspection.QueryRow(ctx, `
SELECT subscriber_email IS NULL AND external_id IS NULL
  FROM conversions WHERE tenant_id = $1::uuid AND id = $2`, tenantID, conversionID).
		Scan(&identityGone); err != nil {
		t.Fatalf("inspect pre-cutover conversion: %v", err)
	}
	if !identityGone {
		t.Fatal("a pre-cutover signed conversion committed behind the erasure receipt")
	}
}

func waitForErasureReceiptGate(
	ctx context.Context,
	t *testing.T,
	pool *db.Pool,
	erasurePID, gatePID int32,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		if err := pool.QueryRow(ctx, `
SELECT $2 = ANY(pg_catalog.pg_blocking_pids($1))`, erasurePID, gatePID).Scan(&blocked); err != nil {
			t.Fatalf("inspect erasure receipt gate: %v", err)
		}
		if blocked {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("erasure never reached the post-redaction receipt gate")
}

func waitForRevocationBehindErasureLifecycleFence(
	ctx context.Context,
	t *testing.T,
	pool *db.Pool,
	erasurePID, revocationPID int32,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_locks AS held
      JOIN pg_catalog.pg_locks AS waiter
        ON waiter.locktype = held.locktype
       AND waiter.database IS NOT DISTINCT FROM held.database
       AND waiter.classid IS NOT DISTINCT FROM held.classid
       AND waiter.objid IS NOT DISTINCT FROM held.objid
       AND waiter.objsubid IS NOT DISTINCT FROM held.objsubid
     WHERE held.pid = $1
       AND held.locktype = 'advisory'
       AND held.mode = 'ShareLock'
       AND held.granted
       AND waiter.pid = $2
       AND waiter.mode = 'ExclusiveLock'
       AND NOT waiter.granted
)`, erasurePID, revocationPID).Scan(&blocked)
		if err != nil {
			t.Fatalf("inspect erasure/revocation lifecycle fence: %v", err)
		}
		if blocked {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("revocation did not wait behind erasure's shared 2017 lifecycle fence")
}

// Pause the erasure at its final unique receipt insert, after it has already
// locked/redacted conversion rows. Revocation must still be waiting on the
// shared 2017 lifecycle fence, not holding that fence while waiting on those
// rows. Releasing the receipt gate then lets erasure run its subscriber trigger
// re-entrantly and commit before revocation proceeds, proving the former
// row/advisory inversion has one deadlock-free order.
func TestConversionSubjectErasureAndKeyRevocationHaveDeadlockFreeOrder_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL is required for deterministic receipt gating")
	}
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect erasure race authority: %v", err)
	}
	defer func() { _ = admin.Close(context.Background()) }()

	tenantID := uuid.NewString()
	seedErasureTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupErasureTenant(t, pool, tenantID) })
	const subjectEmail = "privacy-revoke-race@example.test"
	const erasedEmail = "erased+race000000000000@erased.invalid"
	subscriberID, externalID := seedConversionIdentitySubject(
		ctx, t, pool, tenantID, subjectEmail, "privacy-revoke-race+alias@example.test",
	)
	conversionIDs, keyID, _, _ := seedConversionIdentityEvidence(
		ctx, t, pool, tenantID, subscriberID, externalID, subjectEmail,
		"privacy-revoke-race+alias@example.test",
	)
	requestID := uuid.NewString()

	gate, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin erasure receipt gate: %v", err)
	}
	defer func() { _ = gate.Rollback(context.Background()) }()
	if _, err := gate.Exec(ctx, `SET LOCAL row_security = off`); err != nil {
		t.Fatalf("enable erasure receipt gate authority: %v", err)
	}
	var gatePID int32
	if err := gate.QueryRow(ctx, `SELECT pg_catalog.pg_backend_pid()`).Scan(&gatePID); err != nil {
		t.Fatalf("read erasure receipt gate pid: %v", err)
	}
	if _, err := gate.Exec(ctx, `
INSERT INTO conversion_subject_identity_erasure_receipts (
    tenant_id, request_id, conversions_redacted,
    identity_touches_shredded, campaign_links_severed,
    click_bindings_deleted, recorded_at, receipt_fingerprint
) VALUES ($1::uuid, $2::uuid, 0, 0, 0, 0, statement_timestamp(), repeat('f',64))`,
		tenantID, requestID); err != nil {
		t.Fatalf("hold erasure receipt uniqueness gate: %v", err)
	}

	type transactionResult struct {
		pid int32
		err error
	}
	erasurePID := make(chan int32, 1)
	erasureDone := make(chan transactionResult, 1)
	go func() {
		erasureTX, beginErr := db.WithTenant(ctx, pool, tenantID)
		if beginErr != nil {
			erasureDone <- transactionResult{err: beginErr}
			return
		}
		defer func() { _ = erasureTX.Rollback(context.Background()) }()
		var pid int32
		if pidErr := erasureTX.QueryRow(ctx, `SELECT pg_catalog.pg_backend_pid()`).Scan(&pid); pidErr != nil {
			erasureDone <- transactionResult{err: pidErr}
			return
		}
		erasurePID <- pid
		var receiptID string
		var conversionsRedacted, identityTouches, campaignLinks, clickBindings int64
		callErr := erasureTX.QueryRow(ctx, `
SELECT receipt_id::text, conversions_redacted,
       identity_touches_shredded, campaign_links_severed,
       click_bindings_deleted
  FROM public.conversion_subject_identity_privacy_erase(
       $1::uuid, $2::citext, $3::citext, $4::uuid
  )`, tenantID, subjectEmail, erasedEmail, requestID).Scan(
			&receiptID, &conversionsRedacted, &identityTouches,
			&campaignLinks, &clickBindings,
		)
		if callErr == nil {
			_, callErr = erasureTX.Exec(ctx, `
UPDATE subscribers
   SET email=$3::citext, primary_email=$3::citext
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID, erasedEmail)
		}
		if callErr == nil {
			callErr = erasureTX.Commit(ctx)
		}
		erasureDone <- transactionResult{pid: pid, err: callErr}
	}()

	var erasePID int32
	select {
	case erasePID = <-erasurePID:
	case result := <-erasureDone:
		t.Fatalf("erasure failed before publishing its backend pid: %v", result.err)
	case <-ctx.Done():
		t.Fatalf("erasure did not start: %v", ctx.Err())
	}
	waitForErasureReceiptGate(ctx, t, pool, erasePID, gatePID)

	revocationPID := make(chan int32, 1)
	revocationDone := make(chan transactionResult, 1)
	go func() {
		revokeTX, beginErr := db.WithTenant(ctx, pool, tenantID)
		if beginErr != nil {
			revocationDone <- transactionResult{err: beginErr}
			return
		}
		defer func() { _ = revokeTX.Rollback(context.Background()) }()
		var pid int32
		if pidErr := revokeTX.QueryRow(ctx, `SELECT pg_catalog.pg_backend_pid()`).Scan(&pid); pidErr != nil {
			revocationDone <- transactionResult{err: pidErr}
			return
		}
		revocationPID <- pid
		_, revokeErr := revokeTX.Exec(ctx, `
UPDATE conversion_ingest_secrets
   SET revoked_at=statement_timestamp()
 WHERE tenant_id=$1::uuid AND key_id=$2 AND revoked_at IS NULL`, tenantID, keyID)
		if revokeErr == nil {
			revokeErr = revokeTX.Commit(ctx)
		}
		revocationDone <- transactionResult{pid: pid, err: revokeErr}
	}()

	var revokePID int32
	select {
	case revokePID = <-revocationPID:
	case result := <-revocationDone:
		t.Fatalf("revocation failed before publishing its backend pid: %v", result.err)
	case <-ctx.Done():
		t.Fatalf("revocation did not start: %v", ctx.Err())
	}
	waitForRevocationBehindErasureLifecycleFence(
		ctx, t, pool, erasePID, revokePID,
	)
	select {
	case result := <-revocationDone:
		t.Fatalf("revocation crossed the active erasure lifecycle fence: %+v", result)
	case <-time.After(100 * time.Millisecond):
	}

	if err := gate.Rollback(ctx); err != nil {
		t.Fatalf("release erasure receipt gate: %v", err)
	}
	select {
	case result := <-erasureDone:
		if result.err != nil {
			t.Fatalf("erasure did not commit after receipt gate release: %v", result.err)
		}
	case <-ctx.Done():
		t.Fatalf("erasure did not converge: %v", ctx.Err())
	}
	select {
	case result := <-revocationDone:
		if result.err != nil {
			t.Fatalf("revocation did not commit after erasure: %v", result.err)
		}
	case <-ctx.Done():
		t.Fatalf("revocation did not converge: %v", ctx.Err())
	}

	inspect, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open erasure/revocation result inspection: %v", err)
	}
	defer func() { _ = inspect.Rollback(context.Background()) }()
	var revoked, shredded bool
	if err := inspect.QueryRow(ctx, `
SELECT revoked_at IS NOT NULL AND secret_envelope IS NULL
       AND secret_kms_key_arn IS NULL AND secret_destroyed_at IS NOT NULL
  FROM conversion_ingest_secrets
 WHERE tenant_id=$1::uuid AND key_id=$2`, tenantID, keyID).Scan(&revoked); err != nil {
		t.Fatalf("inspect revoked key: %v", err)
	}
	if err := inspect.QueryRow(ctx, `
SELECT count(*) = $2
  FROM conversions
 WHERE tenant_id=$1::uuid AND id=ANY($3::bigint[])
   AND subscriber_email IS NULL AND email_sha256 IS NULL
   AND email_hmac_sha256 IS NULL AND email_hmac_key_id IS NULL
   AND click_id IS NULL AND external_id IS NULL`, tenantID, len(conversionIDs), conversionIDs).
		Scan(&shredded); err != nil {
		t.Fatalf("inspect redacted conversion rows: %v", err)
	}
	var receipts int
	if err := inspect.QueryRow(ctx, `
SELECT count(*) FROM conversion_subject_identity_erasure_receipts
 WHERE tenant_id=$1::uuid AND request_id=$2::uuid`, tenantID, requestID).Scan(&receipts); err != nil {
		t.Fatalf("inspect erasure receipt: %v", err)
	}
	if !revoked || !shredded || receipts != 1 {
		t.Fatalf("erasure/revocation result revoked=%t shredded=%t receipts=%d, want true/true/1",
			revoked, shredded, receipts)
	}
	if err := inspect.Commit(ctx); err != nil {
		t.Fatalf("commit erasure/revocation result inspection: %v", err)
	}
}
