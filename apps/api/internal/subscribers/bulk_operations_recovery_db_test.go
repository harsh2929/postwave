// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_operations_recovery_db_test.go — pg-backed coverage for SUB-099 (undo)
// and SUB-100 (extended bulk verbs). Skips cleanly without DATABASE_URL,
// matching the project-wide pg-backed test convention. Each test seeds a
// disposable tenant + subscribers, drives the real HTTP handler, and asserts
// the DB side effect (recovery row, restored rows, consent_events rows, audit
// metadata).

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func newBulkVerbsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := mustEnvDatabaseURL(t)
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func mustEnvDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed bulk-verbs test")
	}
	return url
}

func seedBulkVerbsTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	// Tenant creation is a tenant-scoped write. Binding the prospective id is
	// also required by the lifecycle-segment trigger fired by this INSERT.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`, tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		slug := "bulk-verbs-" + tenantID
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'bulk-verbs-test', $2, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, slug); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedBulkVerbsSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email, status string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, $3, 'api')
RETURNING id::text`, tenantID, email, status).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

func bulkVerbsRequest(tenantID, path, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID}))
}

func consentProvenanceJSON() string {
	return consentProvenanceJSONAt(time.Date(2026, 7, 1, 10, 30, 0, 0, time.UTC))
}

func consentProvenanceJSONAt(when time.Time) string {
	return fmt.Sprintf(`"source":"double_optin","channel":"email","legal_basis":"consent","occurred_at":%q,"jurisdiction":"GB","evidence":"receipt:consent-123","reason":"Reviewed the consent receipt.","policy_version":"privacy-2026-07"`,
		when.UTC().Format(time.RFC3339Nano))
}

func decodeBulkResult(t *testing.T, w *httptest.ResponseRecorder) BulkResult {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var out BulkResult
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, w.Body.String())
	}
	return out
}

func subscriberStatus(t *testing.T, pool *pgxpool.Pool, tenantID, id string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("status read tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	_ = tx.Commit(ctx)
	return status
}

// TestBulkDelete_IsIrreversible pins the privacy boundary: erasure must not
// retain a full-row replay snapshot and must never return an undo credential.
func TestBulkDelete_IsIrreversible(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("recover-%d@example.test", suffix)
	id := seedBulkVerbsSubscriber(t, pool, tenantID, email, "enabled")

	d := &Deps{Repo: &Repo{Pool: pool}}

	// Delete.
	w := httptest.NewRecorder()
	d.BulkDelete(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/delete",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, id)))
	res := decodeBulkResult(t, w)
	if res.Affected != 1 {
		t.Fatalf("delete affected = %d, want 1", res.Affected)
	}
	if res.RecoveryToken != "" || res.RecoveryUntil != "" {
		t.Fatalf("privacy erasure returned an unsafe recovery credential: %+v", res)
	}

	ctx := context.Background()
	tx, _ := db.WithTenant(ctx, pool, tenantID)
	defer func() { _ = tx.Rollback(ctx) }()
	var cnt, recoveryRows int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND email=$2`, tenantID, email).Scan(&cnt); err != nil {
		t.Fatalf("count erased subscriber: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_bulk_recovery
 WHERE tenant_id=$1::uuid AND operation='delete'`, tenantID).Scan(&recoveryRows); err != nil {
		t.Fatalf("count recovery snapshots: %v", err)
	}
	if cnt != 0 || recoveryRows != 0 {
		t.Fatalf("erasure retained subscriber=%d recovery_snapshots=%d", cnt, recoveryRows)
	}
}

// TestBulkRecover_UnknownToken returns 404.
func TestBulkRecover_UnknownToken(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41302"
	seedBulkVerbsTenant(t, pool, tenantID)
	d := &Deps{Repo: &Repo{Pool: pool}}
	w := httptest.NewRecorder()
	d.BulkRecover(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/recover",
		`{"recovery_token":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}`))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for unknown token (body=%s)", w.Code, w.Body.String())
	}
}

func TestBulkTagRecovery_IsRevisionBoundAuditedAndEngineDurable(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := "00000000-0000-4000-8000-" + fmt.Sprintf("%012d", time.Now().UnixNano()%1_000_000_000_000)
	seedBulkVerbsTenant(t, pool, tenantID)
	id := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("tag-recovery-%d@example.test", time.Now().UnixNano()), StatusUnconfirmed)
	repo := &Repo{
		Pool:             pool,
		EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
	}
	d := &Deps{Repo: repo}

	tagRequest := func() BulkResult {
		w := httptest.NewRecorder()
		d.BulkTag(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/tag",
			fmt.Sprintf(`{"subscriber_ids":[%q],"tag":"vip"}`, id)))
		return decodeBulkResult(t, w)
	}
	recover := func(token string) BulkResult {
		w := httptest.NewRecorder()
		d.BulkRecover(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/recover",
			fmt.Sprintf(`{"recovery_token":%q}`, token)))
		return decodeBulkResult(t, w)
	}

	first := tagRequest()
	if first.Affected != 1 || first.RecoveryToken == "" {
		t.Fatalf("tag result = %+v, want one version-bound recovery receipt", first)
	}
	undone := recover(first.RecoveryToken)
	if undone.Affected != 1 || undone.Skipped != 0 {
		t.Fatalf("exact tag recovery = %+v, want one restored row", undone)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tag recovery verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var hasTag bool
	var syncIntents, tagAudits, recoveryAudits int
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(tags, ARRAY[]::text[]) @> ARRAY['vip']::text[]
  FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id).Scan(&hasTag); err != nil {
		t.Fatalf("read recovered tags: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE tenant_id=$1::uuid AND kind=$2 AND payload ->> 'subscriber_id'=$3`,
		tenantID, OutboxKindListmonkSync, id).Scan(&syncIntents); err != nil {
		t.Fatalf("count tag engine intents: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id=$1::uuid AND action='subscriber.bulk_tagged'`, tenantID).Scan(&tagAudits); err != nil {
		t.Fatalf("count tag audits: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id=$1::uuid AND action='subscriber.bulk_recovered'`, tenantID).Scan(&recoveryAudits); err != nil {
		t.Fatalf("count recovery audits: %v", err)
	}
	if hasTag || syncIntents != 2 || tagAudits != 1 || recoveryAudits != 1 {
		t.Fatalf("exact recovery state tag=%v sync=%d tag_audit=%d recovery_audit=%d",
			hasTag, syncIntents, tagAudits, recoveryAudits)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tag recovery verification: %v", err)
	}

	// A later profile mutation advances the revision. Recovery must preserve
	// both that work and the tag rather than replaying a stale receipt.
	second := tagRequest()
	if second.RecoveryToken == "" {
		t.Fatalf("second tag result lacks recovery token: %+v", second)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("concurrent tag mutation tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET display_name='newer profile work', updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("advance subscriber revision: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit newer profile work: %v", err)
	}
	stale := recover(second.RecoveryToken)
	if stale.Affected != 0 || stale.Skipped != 1 ||
		stale.Exclusions["changed_since_operation_or_legacy_receipt"] != 1 {
		t.Fatalf("stale tag recovery = %+v, want fail-closed skip", stale)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("stale recovery verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var displayName string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(tags, ARRAY[]::text[]) @> ARRAY['vip']::text[], display_name
  FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id).Scan(&hasTag, &displayName); err != nil {
		t.Fatalf("read stale recovery state: %v", err)
	}
	if !hasTag || displayName != "newer profile work" {
		t.Fatalf("stale recovery overwrote newer work: tag=%v display_name=%q", hasTag, displayName)
	}
}

// TestBulkUnsubscribe_RecordsRevocationAndRequiresReviewedResubscribe pins the
// production safety boundary: an administrative unsubscribe is a durable
// consent withdrawal across every store and never returns an automatic undo
// token. Restoring permission must go through the separately reviewed
// BulkResubscribe evidence flow.
func TestBulkUnsubscribe_RecordsRevocationAndRequiresReviewedResubscribe(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41303"
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("unsub-%d@example.test", suffix)
	repo := &Repo{Pool: pool, EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}}
	grant := completeCreateConsentInput()
	grant.Email = email
	created, err := repo.Upsert(context.Background(), tenantID, grant)
	if err != nil {
		t.Fatalf("seed reviewed subscriber: %v", err)
	}
	id := created.ID
	d := &Deps{Repo: repo}

	w := httptest.NewRecorder()
	d.BulkUnsubscribe(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/unsubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, id)))
	res := decodeBulkResult(t, w)
	if res.Affected != 1 || res.RecoveryToken != "" || res.RecoveryUntil != "" {
		t.Fatalf("unsubscribe res = %+v, want affected 1 with no unsafe undo", res)
	}
	if got := subscriberStatus(t, pool, tenantID, id); got != "blocklisted" {
		t.Fatalf("status after unsubscribe = %q, want blocklisted", got)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify unsubscribe tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var addressStatus string
	var addressSuppressed bool
	var purposeGranted bool
	var events, proofs, suppressions, audits, syncIntents int
	if err := tx.QueryRow(ctx, `
SELECT address.consent_status,
       address.suppressed,
       subscriber.consent_email_marketing_at IS NOT NULL
  FROM subscribers AS subscriber
  JOIN subscriber_emails AS address
    ON address.tenant_id = subscriber.tenant_id
   AND address.subscriber_id = subscriber.id
   AND lower(address.email::text) = lower(subscriber.email::text)
 WHERE subscriber.tenant_id = $1::uuid AND subscriber.id = $2::uuid`, tenantID, id).Scan(
		&addressStatus, &addressSuppressed, &purposeGranted,
	); err != nil {
		t.Fatalf("read withdrawn subscriber state: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_events
 WHERE tenant_id = $1::uuid AND subject_email = $2
   AND category = 'email_marketing' AND action = 'revoked'
   AND source = 'direct_request'
   AND policy_version = 'operator-bulk-unsubscribe-v1'
   AND preferences ->> 'operation' = 'bulk_unsubscribe'
   AND btrim(COALESCE(proof_text, '')) <> ''`, tenantID, email).Scan(&events); err != nil {
		t.Fatalf("read bulk revoke event: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_records
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND email = $3
   AND channel = 'email' AND consent_status = 'withdrawn'
   AND source = 'admin'
   AND evidence ->> 'operation' = 'bulk_unsubscribe'`, tenantID, id, email).Scan(&proofs); err != nil {
		t.Fatalf("read bulk withdrawal proof: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid AND email = $2
   AND reason = 'manual_unsubscribe' AND source = 'api'
   AND metadata ->> 'operation' = 'bulk_unsubscribe'`, tenantID, email).Scan(&suppressions); err != nil {
		t.Fatalf("read bulk suppression: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND action = 'subscriber.bulk_unsubscribed'
   AND metadata ->> 'automatic_undo' = 'false'`, tenantID).Scan(&audits); err != nil {
		t.Fatalf("read bulk unsubscribe audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2
   AND payload ->> 'subscriber_id' = $3`, tenantID, OutboxKindListmonkSync, id).Scan(&syncIntents); err != nil {
		t.Fatalf("read bulk unsubscribe engine intent: %v", err)
	}
	if addressStatus != "unsubscribed" || !addressSuppressed || purposeGranted ||
		events != 1 || proofs != 1 || suppressions != 1 || audits < 1 || syncIntents != 2 {
		t.Fatalf("withdrawal state address=%q suppressed=%v purpose=%v events=%d proofs=%d suppressions=%d audits=%d sync=%d",
			addressStatus, addressSuppressed, purposeGranted, events, proofs, suppressions, audits, syncIntents)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit unsubscribe verification: %v", err)
	}

	// A retry without an idempotency key sees the fully withdrawn terminal
	// state and does not duplicate immutable evidence.
	w = httptest.NewRecorder()
	d.BulkUnsubscribe(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/unsubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, id)))
	retry := decodeBulkResult(t, w)
	if retry.Affected != 0 || retry.Skipped != 1 || retry.Exclusions["already_withdrawn_or_missing"] != 1 {
		t.Fatalf("withdrawal retry result = %+v", retry)
	}
}

func TestSubscriberBulkRecovery_RejectsTerminalOperationSnapshots(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41313"
	seedBulkVerbsTenant(t, pool, tenantID)
	ctx := context.Background()
	for _, operation := range []string{"delete", "unsubscribe"} {
		t.Run(operation, func(t *testing.T) {
			tx, err := db.WithTenant(ctx, pool, tenantID)
			if err != nil {
				t.Fatalf("terminal recovery tx: %v", err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, _, err := recordRecovery(ctx, tx, tenantID, operation, 1, recoveryWindowReversible, map[string]any{
				"rows": []map[string]any{{"email": "must-not-be-retained@example.test"}},
			}); err == nil {
				t.Fatalf("terminal operation %q minted a recovery snapshot", operation)
			}
		})
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("terminal recovery verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var terminalSnapshots int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_bulk_recovery
 WHERE tenant_id=$1::uuid AND operation IN ('delete', 'unsubscribe')`, tenantID).Scan(&terminalSnapshots); err != nil {
		t.Fatalf("count terminal recovery snapshots: %v", err)
	}
	if terminalSnapshots != 0 {
		t.Fatalf("terminal recovery snapshots retained = %d, want zero", terminalSnapshots)
	}
}

func TestBulkUnsubscribeThenReviewedResubscribeRestoresExactEligibility(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41314"
	seedBulkVerbsTenant(t, pool, tenantID)
	email := fmt.Sprintf("reviewed-resubscribe-%d@example.test", time.Now().UnixNano())
	repo := &Repo{Pool: pool, EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}}
	grant := completeCreateConsentInput()
	grant.Email = email
	subscriber, err := repo.Upsert(context.Background(), tenantID, grant)
	if err != nil {
		t.Fatalf("seed reviewed grant: %v", err)
	}
	d := &Deps{Repo: repo}

	w := httptest.NewRecorder()
	d.BulkUnsubscribe(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/unsubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, subscriber.ID)))
	if out := decodeBulkResult(t, w); out.Affected != 1 {
		t.Fatalf("unsubscribe result = %+v", out)
	}

	when := time.Now().UTC()
	w = httptest.NewRecorder()
	d.BulkResubscribe(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/resubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q],%s}`, subscriber.ID, consentProvenanceJSONAt(when))))
	out := decodeBulkResult(t, w)
	if out.Affected != 1 || out.Skipped != 0 {
		t.Fatalf("reviewed resubscribe result = %+v", out)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("reviewed resubscribe verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status, mailchimpStatus, addressStatus, consentSource string
	var addressSuppressed, purposeGranted bool
	var consentTimestamp time.Time
	var ownedSuppressions, grantEvents, grantProofs, syncIntents int
	if err := tx.QueryRow(ctx, `
SELECT subscriber.status,
       subscriber.mailchimp_status,
       subscriber.consent_source,
       subscriber.consent_timestamp,
       subscriber.consent_email_marketing_at IS NOT NULL,
       address.consent_status,
       address.suppressed
  FROM subscribers AS subscriber
  JOIN subscriber_emails AS address
    ON address.tenant_id = subscriber.tenant_id
   AND address.subscriber_id = subscriber.id
   AND lower(address.email::text) = lower(subscriber.email::text)
 WHERE subscriber.tenant_id = $1::uuid AND subscriber.id = $2::uuid`, tenantID, subscriber.ID).Scan(
		&status, &mailchimpStatus, &consentSource, &consentTimestamp,
		&purposeGranted, &addressStatus, &addressSuppressed,
	); err != nil {
		t.Fatalf("read reviewed resubscribe state: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid AND email = $2
   AND metadata ->> 'operation' = 'bulk_unsubscribe'`, tenantID, email).Scan(&ownedSuppressions); err != nil {
		t.Fatalf("count cleared owned suppressions: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_events
 WHERE tenant_id = $1::uuid AND subject_email = $2
   AND action = 'granted' AND category = 'email_marketing'
   AND preferences ->> 'operation' = 'bulk_resubscribe'`, tenantID, email).Scan(&grantEvents); err != nil {
		t.Fatalf("count reviewed grant events: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_records
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND consent_status = 'granted'
   AND evidence ->> 'operation' = 'bulk_resubscribe'
   AND evidence ->> 'address_id' <> ''
   AND evidence ->> 'event_id' <> ''`, tenantID, subscriber.ID).Scan(&grantProofs); err != nil {
		t.Fatalf("count reviewed grant proofs: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2
   AND payload ->> 'subscriber_id' = $3`, tenantID, OutboxKindListmonkSync, subscriber.ID).Scan(&syncIntents); err != nil {
		t.Fatalf("count reviewed engine intents: %v", err)
	}
	if status != StatusEnabled || mailchimpStatus != "subscribed" || consentSource != ConsentDoubleOptIn ||
		consentTimestamp.Before(when.Add(-time.Second)) || !purposeGranted ||
		addressStatus != "subscribed" || addressSuppressed || ownedSuppressions != 0 ||
		grantEvents != 1 || grantProofs != 1 || syncIntents != 3 {
		t.Fatalf("reviewed state status=%q mailchimp=%q source=%q at=%s purpose=%v address=%q suppressed=%v owned=%d events=%d proofs=%d sync=%d",
			status, mailchimpStatus, consentSource, consentTimestamp, purposeGranted,
			addressStatus, addressSuppressed, ownedSuppressions, grantEvents, grantProofs, syncIntents)
	}
}

func TestBulkResubscribe_SerializesSuppressionInsertedAfterCapture(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41315"
	seedBulkVerbsTenant(t, pool, tenantID)
	email := fmt.Sprintf("resubscribe-race-%d@example.test", time.Now().UnixNano())
	repo := &Repo{Pool: pool}
	grant := completeCreateConsentInput()
	grant.Email = email
	subscriber, err := repo.Upsert(context.Background(), tenantID, grant)
	if err != nil {
		t.Fatalf("seed race grant: %v", err)
	}
	d := &Deps{Repo: repo}
	w := httptest.NewRecorder()
	d.BulkUnsubscribe(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/unsubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, subscriber.ID)))
	if out := decodeBulkResult(t, w); out.Affected != 1 {
		t.Fatalf("seed race unsubscribe = %+v", out)
	}

	when := time.Now().UTC()
	in := BulkResubscribeInput{
		BulkTarget: BulkTarget{SubscriberIDs: []string{subscriber.ID}},
		ConsentProvenanceInput: ConsentProvenanceInput{
			Source: ConsentDoubleOptIn, Channel: "email", LegalBasis: "consent",
			OccurredAt: &when, Jurisdiction: "GB", Evidence: "receipt:race-reviewed",
			Reason: "Reviewed exact-address resubscription.", PolicyVersion: "privacy-2026-07",
		},
	}
	if err := normalizeConsentProvenance(&in.ConsentProvenanceInput, true); err != nil {
		t.Fatalf("normalize race provenance: %v", err)
	}
	ctx := context.Background()
	txA, err := db.WithTenantOptions(ctx, pool, tenantID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		t.Fatalf("open reviewed transaction: %v", err)
	}
	captured := make(chan struct{})
	resume := make(chan struct{})
	type applyResult struct {
		targets []bulkResubscribeTarget
		err     error
	}
	resultCh := make(chan applyResult, 1)
	go func() {
		targets, _, applyErr := d.applyBulkResubscribeWithHooks(
			ctx, txA, tenantID, []string{subscriber.ID}, in, db.AuditMeta{TenantID: tenantID},
			bulkResubscribeHooks{afterSuppressionCapture: func() {
				close(captured)
				<-resume
			}},
		)
		resultCh <- applyResult{targets: targets, err: applyErr}
	}()
	<-captured

	// This is the hostile crossing: a newer complaint lands in another
	// suppression store after the reviewed operation captured its exact rows.
	txB, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		close(resume)
		_ = txA.Rollback(ctx)
		t.Fatalf("open concurrent suppression tx: %v", err)
	}
	_, crossingErr := txB.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'complaint', 'race-test', '{"newer":true}'::jsonb)`, tenantID, email)
	crossingRejected := crossingErr != nil
	if crossingRejected {
		_ = txB.Rollback(ctx)
		if !errors.Is(mapEmailConsentSerializationError(crossingErr), ErrConcurrentConsentDecision) {
			close(resume)
			_ = txA.Rollback(ctx)
			t.Fatalf("insert newer complaint error = %v, want bounded concurrent-decision outcome", crossingErr)
		}
	} else if err := txB.Commit(ctx); err != nil {
		close(resume)
		_ = txA.Rollback(ctx)
		t.Fatalf("commit newer complaint: %v", err)
	}
	close(resume)
	result := <-resultCh
	// Judged as the handler judges it (writeBulkConsentMutationErr): a
	// serializable transaction may abort at any statement, not only at
	// commit, and every such abort is the same bounded conflict (409).
	if result.err != nil && !errors.Is(mapEmailConsentSerializationError(result.err), ErrConcurrentConsentDecision) {
		_ = txA.Rollback(ctx)
		t.Fatalf("reviewed apply error: %v", result.err)
	}
	if crossingRejected {
		// The exact-address mutex rejected the crossing writer with a bounded
		// lock outcome. Roll back the reviewed transaction too so the original
		// hold remains and no unsafe positive state is exposed by this test.
		_ = txA.Rollback(ctx)
	} else if result.err != nil {
		_ = txA.Rollback(ctx)
	} else if err := txA.Commit(ctx); err != nil {
		// A serializable abort is the preferred fail-closed outcome; either way
		// the newer row must survive and continue blocking delivery.
		_ = txA.Rollback(ctx)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("race verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var complaintRows, activeHolds int
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM email_suppressions
 WHERE tenant_id = $1::uuid AND email = $2
   AND reason = 'complaint' AND metadata ->> 'newer' = 'true'`, tenantID, email).Scan(&complaintRows); err != nil {
		t.Fatalf("read newer complaint: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM v_suppressions_unified
 WHERE tenant_id = $1::uuid AND lower(email) = lower($2)
   AND (expires_at IS NULL OR expires_at > now())`, tenantID, email).Scan(&activeHolds); err != nil {
		t.Fatalf("read unified holds: %v", err)
	}
	wantComplaintRows := 1
	if crossingRejected {
		wantComplaintRows = 0
	}
	if complaintRows != wantComplaintRows || activeHolds < 1 {
		t.Fatalf("suppression serialization unsafe: rejected=%v complaint=%d want=%d active=%d",
			crossingRejected, complaintRows, wantComplaintRows, activeHolds)
	}
}

// TestBulkResubscribe flips a blocklisted row back to enabled.
func TestBulkResubscribe(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41304"
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	id := seedBulkVerbsSubscriber(t, pool, tenantID, fmt.Sprintf("resub-%d@example.test", suffix), "blocklisted")
	d := &Deps{Repo: &Repo{Pool: pool}}

	w := httptest.NewRecorder()
	d.BulkResubscribe(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/resubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q],%s}`, id, consentProvenanceJSON())))
	res := decodeBulkResult(t, w)
	if res.Affected != 1 {
		t.Fatalf("resubscribe affected = %d, want 1", res.Affected)
	}
	if got := subscriberStatus(t, pool, tenantID, id); got != "enabled" {
		t.Fatalf("status = %q, want enabled", got)
	}
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("resubscribe verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var addressStatus string
	var proofs int
	if err := tx.QueryRow(ctx, `
SELECT consent_status FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, id).Scan(&addressStatus); err != nil {
		t.Fatalf("read resubscribed address: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_records
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid
   AND consent_status='granted'`, tenantID, id).Scan(&proofs); err != nil {
		t.Fatalf("read resubscribe proof: %v", err)
	}
	if addressStatus != "subscribed" || proofs != 1 {
		t.Fatalf("resubscribe address status=%q proofs=%d, want subscribed/1", addressStatus, proofs)
	}
}

func TestBulkResubscribe_ProtectedComplaintFailsClosed(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c4130b"
	seedBulkVerbsTenant(t, pool, tenantID)
	email := fmt.Sprintf("protected-resub-%d@example.test", time.Now().UnixNano())
	id := seedBulkVerbsSubscriber(t, pool, tenantID, email, "blocklisted")
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("suppression seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source)
VALUES ($1::uuid, $2, 'complaint', 'test')`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed protected complaint: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit protected complaint: %v", err)
	}

	d := &Deps{Repo: &Repo{Pool: pool}}
	w := httptest.NewRecorder()
	d.BulkResubscribe(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/resubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q],%s}`, id, consentProvenanceJSON())))
	res := decodeBulkResult(t, w)
	if res.Affected != 0 || res.Exclusions["protected_suppression"] != 1 {
		t.Fatalf("protected resubscribe result = %+v", res)
	}
	if got := subscriberStatus(t, pool, tenantID, id); got != "blocklisted" {
		t.Fatalf("protected subscriber status = %q, want blocklisted", got)
	}
}

// TestBulkSetCustomField sets then removes a custom_fields key.
func TestBulkSetCustomField(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41305"
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	id := seedBulkVerbsSubscriber(t, pool, tenantID, fmt.Sprintf("cf-%d@example.test", suffix), "enabled")
	d := &Deps{Repo: &Repo{Pool: pool}}

	readKey := func(col string) any {
		ctx := context.Background()
		tx, _ := db.WithTenant(ctx, pool, tenantID)
		defer func() { _ = tx.Rollback(ctx) }()
		var raw []byte
		_ = tx.QueryRow(ctx, fmt.Sprintf(`SELECT %s->'tier' FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, col), tenantID, id).Scan(&raw)
		_ = tx.Commit(ctx)
		if len(raw) == 0 {
			return nil
		}
		var v any
		_ = json.Unmarshal(raw, &v)
		return v
	}

	w := httptest.NewRecorder()
	d.BulkSetCustomField(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/set-custom-field",
		fmt.Sprintf(`{"subscriber_ids":[%q],"key":"tier","value":"gold"}`, id)))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("set affected = %d, want 1", res.Affected)
	}
	if got := readKey("custom_fields"); got != "gold" {
		t.Fatalf("custom_fields.tier = %v, want gold", got)
	}

	// Remove.
	w = httptest.NewRecorder()
	d.BulkSetCustomField(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/set-custom-field",
		fmt.Sprintf(`{"subscriber_ids":[%q],"key":"tier","remove":true}`, id)))
	_ = decodeBulkResult(t, w)
	if got := readKey("custom_fields"); got != nil {
		t.Fatalf("custom_fields.tier after remove = %v, want nil", got)
	}
}

// TestBulkUpdateMergeField patches the merge_fields jsonb column.
func TestBulkUpdateMergeField(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41306"
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	id := seedBulkVerbsSubscriber(t, pool, tenantID, fmt.Sprintf("mf-%d@example.test", suffix), "enabled")
	d := &Deps{Repo: &Repo{Pool: pool}}

	w := httptest.NewRecorder()
	d.BulkUpdateMergeField(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/update-merge-field",
		fmt.Sprintf(`{"subscriber_ids":[%q],"key":"FNAME","value":"Ada"}`, id)))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("update merge affected = %d, want 1", res.Affected)
	}
	ctx := context.Background()
	tx, _ := db.WithTenant(ctx, pool, tenantID)
	defer func() { _ = tx.Rollback(ctx) }()
	var val string
	if err := tx.QueryRow(ctx, `SELECT merge_fields->>'FNAME' FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id).Scan(&val); err != nil {
		t.Fatalf("read merge_fields: %v", err)
	}
	if val != "Ada" {
		t.Fatalf("merge_fields.FNAME = %q, want Ada", val)
	}
}

// TestBulkGrantConsent + revoke append consent_events rows.
func TestBulkGrantConsent(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41307"
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	id := seedBulkVerbsSubscriber(t, pool, tenantID, fmt.Sprintf("consent-%d@example.test", suffix), "enabled")
	d := &Deps{Repo: &Repo{Pool: pool}}

	w := httptest.NewRecorder()
	d.BulkGrantConsent(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/grant-consent",
		fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`, id, consentProvenanceJSON())))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("grant affected = %d, want 1", res.Affected)
	}

	w = httptest.NewRecorder()
	d.BulkRevokeConsent(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/revoke-consent",
		fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`, id, consentProvenanceJSON())))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("revoke affected = %d, want 1", res.Affected)
	}

	ctx := context.Background()
	tx, _ := db.WithTenant(ctx, pool, tenantID)
	defer func() { _ = tx.Rollback(ctx) }()
	var granted, revoked, proofs int
	var provenanceComplete bool
	var addressStatus string
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE action='granted'),
  count(*) FILTER (WHERE action='revoked'),
  bool_and(source='double_optin' AND channel='email'
           AND policy_version='privacy-2026-07'
           AND proof_text='receipt:consent-123'
           AND preferences->>'legal_basis'='consent'
           AND preferences->>'jurisdiction'='GB')
FROM consent_events
WHERE tenant_id=$1::uuid
  AND subject_id=(
      SELECT address.id::text
        FROM subscriber_emails AS address
       WHERE address.tenant_id=$1::uuid
         AND address.subscriber_id=$2::uuid
         AND address.is_primary
  )
  AND category='email_marketing'`, tenantID, id).Scan(&granted, &revoked, &provenanceComplete); err != nil {
		t.Fatalf("read consent_events: %v", err)
	}
	if granted != 1 || revoked != 1 || !provenanceComplete {
		t.Fatalf("consent rows granted=%d revoked=%d complete=%v, want 1/1/true", granted, revoked, provenanceComplete)
	}
	if err := tx.QueryRow(ctx, `
SELECT consent_status FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, id).Scan(&addressStatus); err != nil {
		t.Fatalf("read exact-address consent: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_records
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid
   AND consent_status IN ('granted','withdrawn')`, tenantID, id).Scan(&proofs); err != nil {
		t.Fatalf("read structured bulk consent proofs: %v", err)
	}
	if addressStatus != "unsubscribed" || proofs != 2 {
		t.Fatalf("bulk consent terminal address=%q proofs=%d, want unsubscribed/2", addressStatus, proofs)
	}
}

// TestBulkRevokeConsent is covered alongside grant above; kept as a named entry
// for the orchestration register by exercising revoke standalone.
func TestBulkRevokeConsent(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41308"
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	id := seedBulkVerbsSubscriber(t, pool, tenantID, fmt.Sprintf("revoke-%d@example.test", suffix), "enabled")
	d := &Deps{Repo: &Repo{Pool: pool}}
	w := httptest.NewRecorder()
	d.BulkRevokeConsent(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/revoke-consent",
		fmt.Sprintf(`{"subscriber_ids":[%q],"category":"ai_processing",%s}`, id, consentProvenanceJSON())))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("revoke affected = %d, want 1", res.Affected)
	}
}

// TestBulkExportBySegment streams a CSV of the explicit id audience.
func TestBulkExportBySegment(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41309"
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("export-%d@example.test", suffix)
	id := seedBulkVerbsSubscriber(t, pool, tenantID, email, "enabled")
	d := &Deps{Repo: &Repo{Pool: pool}}

	w := httptest.NewRecorder()
	d.BulkExportBySegment(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/export-by-segment",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, id)))
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, strings.Join(csvExportHeader, ",")) {
		t.Fatalf("csv missing header: %s", body)
	}
	if !strings.Contains(body, email) {
		t.Fatalf("csv missing exported email %q: %s", email, body)
	}
}

// TestBulkAddToList aliases move-to-list — adds the audience to a list.
func TestBulkAddToList(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	// The list is owned by the upstream lists service; Moosewave knows it
	// through the list_id_map row the create handler writes, and the request
	// names it by the engine id every client holds.
	tenantID, listID, engineListID := uniqueBulkListIDs(t, pool)
	suffix := time.Now().UnixNano()
	id := seedBulkVerbsSubscriber(t, pool, tenantID, fmt.Sprintf("addlist-%d@example.test", suffix), "enabled")

	webhooks := &bulkWebhookRecorder{}
	d := &Deps{Repo: &Repo{Pool: pool, Webhooks: webhooks}}
	w := httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q],"list_id":%q}`, id, engineListID)))
	res := decodeBulkResult(t, w)
	if res.Affected != 1 {
		t.Fatalf("add-to-list affected = %d, want 1 (body=%s)", res.Affected, w.Body.String())
	}
	if len(webhooks.inputs) != 1 {
		t.Fatalf("transactional webhook intents = %d, want 1", len(webhooks.inputs))
	}
	var addedAt time.Time
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open membership verification tx: %v", err)
	}
	if err := tx.QueryRow(context.Background(), `
SELECT added_at
  FROM list_subscribers
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = $3::uuid`,
		tenantID, listID, id).Scan(&addedAt); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("read persisted membership revision: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit membership verification tx: %v", err)
	}
	wantKey := bulkListSubscriberAddedIdempotencyKey(tenantID,
		bulkInsertedListSubscriber{ID: id, ListID: listID, AddedAt: addedAt})
	if got := webhooks.inputs[0].IdempotencyKey; got != wantKey {
		t.Fatalf("idempotency key = %q, want persisted-revision key %q", got, wantKey)
	}

	// Re-adding an already-active membership (named by its uuid this time)
	// must not create a second customer event.
	w = httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q],"list_id":%q}`, id, listID)))
	res = decodeBulkResult(t, w)
	if res.Affected != 0 || len(webhooks.inputs) != 1 {
		t.Fatalf("duplicate add affected=%d webhook_intents=%d, want 0 and 1",
			res.Affected, len(webhooks.inputs))
	}
}

func TestBulkAddToListRollsBackMembershipWhenDeliveryIntentFails(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID, listID, engineListID := uniqueBulkListIDs(t, pool)
	id := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("addlist-rollback-%d@example.test", time.Now().UnixNano()), "enabled")

	webhooks := &bulkWebhookRecorder{err: errors.New("injected delivery-intent failure")}
	d := &Deps{Repo: &Repo{Pool: pool, Webhooks: webhooks}}
	w := httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q],"list_id":%q}`, id, engineListID)))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body=%s)", w.Code, w.Body.String())
	}

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open rollback verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var count int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)
  FROM list_subscribers
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = $3::uuid`,
		tenantID, listID, id).Scan(&count); err != nil {
		t.Fatalf("count rolled-back membership: %v", err)
	}
	if count != 0 {
		t.Fatalf("membership rows after delivery-intent failure = %d, want 0", count)
	}
}

// uniqueBulkListIDs keeps every add-to-list recovery test on its own tenant and
// list. Shared hardcoded UUIDs quietly mean a test only proves anything the
// first time it runs against a given database — the second run finds the
// membership already there and the assertions describe leftover state instead
// of this run's work.
//
// The list is mapped the way the list-create handler maps it, and the tests
// add to it by its ENGINE id, because that is the only list id any client
// holds. These tests used to invent an unmapped uuid, which is why the path
// every real click takes (engine id -> 22P02 -> 500) never executed here.
func uniqueBulkListIDs(t *testing.T, pool *pgxpool.Pool) (tenantID, listUUID, engineListID string) {
	t.Helper()
	tenantID = uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	listUUID = seedBulkListIdentity(t, pool, tenantID, 10)
	return tenantID, listUUID, "10"
}

// TestBulkAddToListRecovery_RemovesOnlyWhatTheOperationCreated is the undo that
// did not exist: add-to-list was the one bulk verb with no way back, and it is
// the easiest to fire by accident — one wrong segment and the next campaign
// goes to an audience nobody chose.
func TestBulkAddToListRecovery_RemovesOnlyWhatTheOperationCreated(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID, listID, engineListID := uniqueBulkListIDs(t, pool)
	suffix := time.Now().UnixNano()
	bystander := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("addlist-undo-bystander-%d@example.test", suffix), "enabled")
	moved := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("addlist-undo-moved-%d@example.test", suffix), "enabled")

	d := &Deps{Repo: &Repo{Pool: pool, Webhooks: &bulkWebhookRecorder{}}}
	ctx := context.Background()

	// The bystander joined the list before the mistake. Undo must not touch a
	// membership this operation did not create.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open bystander seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO list_subscribers (tenant_id, list_id, subscriber_id)
VALUES ($1::uuid, $2::uuid, $3::uuid)`, tenantID, listID, bystander); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed pre-existing membership: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bystander seed: %v", err)
	}

	w := httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q,%q],"list_id":%q}`, moved, bystander, engineListID)))
	added := decodeBulkResult(t, w)
	if added.Affected != 1 {
		t.Fatalf("add-to-list affected = %d, want 1 (bystander already a member) body=%s",
			added.Affected, w.Body.String())
	}
	if added.RecoveryToken == "" {
		t.Fatalf("add-to-list returned no recovery token: %+v", added)
	}

	w = httptest.NewRecorder()
	d.BulkRecover(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/recover",
		fmt.Sprintf(`{"recovery_token":%q}`, added.RecoveryToken)))
	undone := decodeBulkResult(t, w)
	if undone.Affected != 1 || undone.Skipped != 0 {
		t.Fatalf("undo = %+v, want exactly one membership removed (body=%s)", undone, w.Body.String())
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open undo verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var survivors []string
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text FROM list_subscribers
 WHERE tenant_id=$1::uuid AND list_id=$2::uuid ORDER BY subscriber_id`, tenantID, listID)
	if err != nil {
		t.Fatalf("read memberships after undo: %v", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan membership: %v", err)
		}
		survivors = append(survivors, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate memberships: %v", err)
	}
	if len(survivors) != 1 || survivors[0] != bystander {
		t.Fatalf("memberships after undo = %v, want only the pre-existing %s", survivors, bystander)
	}
}

// TestBulkAddToListRecovery_SkipsMembershipRecreatedAfterTheOperation is the
// reason the receipt stores added_at rather than just the subscriber id. Undo
// runs up to ten minutes later. If someone left and deliberately rejoined in
// that window, the undo must not revoke the membership they asked for — and it
// must SAY it skipped, because an undo that silently does less than it claims
// is worse than one that refuses.
func TestBulkAddToListRecovery_SkipsMembershipRecreatedAfterTheOperation(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID, listID, engineListID := uniqueBulkListIDs(t, pool)
	id := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("addlist-rejoin-%d@example.test", time.Now().UnixNano()), "enabled")

	d := &Deps{Repo: &Repo{Pool: pool, Webhooks: &bulkWebhookRecorder{}}}
	ctx := context.Background()

	w := httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q],"list_id":%q}`, id, engineListID)))
	added := decodeBulkResult(t, w)
	if added.Affected != 1 || added.RecoveryToken == "" {
		t.Fatalf("add-to-list = %+v, want one row and a recovery token", added)
	}

	// Leave, then deliberately rejoin — a new membership with a new added_at.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open rejoin tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM list_subscribers
 WHERE tenant_id=$1::uuid AND list_id=$2::uuid AND subscriber_id=$3::uuid`,
		tenantID, listID, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("leave list: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO list_subscribers (tenant_id, list_id, subscriber_id, added_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, clock_timestamp() + interval '1 second')`,
		tenantID, listID, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("rejoin list: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit rejoin: %v", err)
	}

	w = httptest.NewRecorder()
	d.BulkRecover(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/recover",
		fmt.Sprintf(`{"recovery_token":%q}`, added.RecoveryToken)))
	undone := decodeBulkResult(t, w)
	if undone.Affected != 0 || undone.Skipped != 1 ||
		undone.Exclusions["changed_since_operation_or_legacy_receipt"] != 1 {
		t.Fatalf("undo after rejoin = %+v, want 0 removed and 1 reported skip (body=%s)",
			undone, w.Body.String())
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open rejoin verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM list_subscribers
 WHERE tenant_id=$1::uuid AND list_id=$2::uuid AND subscriber_id=$3::uuid`,
		tenantID, listID, id).Scan(&count); err != nil {
		t.Fatalf("count membership after undo: %v", err)
	}
	if count != 1 {
		t.Fatalf("deliberate rejoin was revoked by undo: rows = %d, want 1", count)
	}
}

// TestBulkAddToListRecovery_CancelsTheAutomationsTheMistakeStarted covers the
// half of the undo that removing a row does not accomplish.
//
// `list_subscribers` carries an AFTER INSERT trigger that enrols each new
// member in every active journey with a `list_joined` trigger. So the mistake
// this whole feature exists to reverse — one wrong segment in the picker — does
// not just put the wrong people on a list, it queues a welcome series to each of
// them. Deleting the membership afterwards does not retract the run: it is
// already in `flow_runs` and the worker will send it.
func TestBulkAddToListRecovery_CancelsTheAutomationsTheMistakeStarted(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID, listID, engineListID := uniqueBulkListIDs(t, pool)
	suffix := time.Now().UnixNano()
	mistaken := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("addlist-enrol-%d@example.test", suffix), "enabled")

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open journey seed tx: %v", err)
	}
	var journeyID string
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_journeys (tenant_id, name, status, triggers)
VALUES ($1::uuid, 'welcome series', 'active',
        jsonb_build_array(jsonb_build_object('type', 'list_joined', 'list_id', $2::text)))
RETURNING id::text`, tenantID, listID).Scan(&journeyID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed active journey: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit journey seed: %v", err)
	}

	d := &Deps{Repo: &Repo{Pool: pool, Webhooks: &bulkWebhookRecorder{}}}
	w := httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q],"list_id":%q}`, mistaken, engineListID)))
	added := decodeBulkResult(t, w)
	if added.Affected != 1 || added.RecoveryToken == "" {
		t.Fatalf("add-to-list = %+v, want one row and a recovery token", added)
	}

	// The trigger must have fired, or the rest of this test proves nothing: a
	// cancellation assertion over zero rows passes for the wrong reason.
	queued := countFlowRuns(t, pool, tenantID, mistaken, "queued")
	if queued != 1 {
		t.Fatalf("queued flow_runs after the mistaken add = %d, want 1 "+
			"(the enrolment trigger did not fire, so this test cannot observe the undo)", queued)
	}

	w = httptest.NewRecorder()
	d.BulkRecover(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/recover",
		fmt.Sprintf(`{"recovery_token":%q}`, added.RecoveryToken)))
	undone := decodeBulkResult(t, w)
	if undone.Affected != 1 {
		t.Fatalf("undo = %+v, want one membership revoked (body=%s)", undone, w.Body.String())
	}

	if left := countFlowRuns(t, pool, tenantID, mistaken, "queued"); left != 0 {
		t.Fatalf("queued enrolments after undo = %d, want 0 — the welcome series "+
			"the mistake started is still going to send", left)
	}
	// Cancelled rather than deleted: someone asking "why did this person nearly
	// get the welcome email" needs the evidence to still be there.
	if cancelled := countFlowRuns(t, pool, tenantID, mistaken, "cancelled"); cancelled != 1 {
		t.Fatalf("cancelled enrolments after undo = %d, want 1 (the record must survive)", cancelled)
	}
}

// TestBulkAddToListRecovery_LeavesAMembershipSomebodyElseAlreadyRemoved pins the
// other half of the same predicate.
//
// Every other membership-removal path in this codebase soft deletes, so a row
// this operation added and somebody has since removed is still present, with its
// original added_at. Hard-deleting it would destroy the removal tombstone — the
// record of who left and when — in order to revoke a membership that was already
// revoked, and would then count it as work the undo did.
func TestBulkAddToListRecovery_LeavesAMembershipSomebodyElseAlreadyRemoved(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID, listID, engineListID := uniqueBulkListIDs(t, pool)
	id := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("addlist-softremoved-%d@example.test", time.Now().UnixNano()), "enabled")

	d := &Deps{Repo: &Repo{Pool: pool, Webhooks: &bulkWebhookRecorder{}}}
	ctx := context.Background()

	w := httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q],"list_id":%q}`, id, engineListID)))
	added := decodeBulkResult(t, w)
	if added.Affected != 1 || added.RecoveryToken == "" {
		t.Fatalf("add-to-list = %+v, want one row and a recovery token", added)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open soft-remove tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE list_subscribers SET removed_at = now()
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND subscriber_id = $3::uuid`,
		tenantID, listID, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("soft remove membership: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit soft remove: %v", err)
	}

	w = httptest.NewRecorder()
	d.BulkRecover(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/recover",
		fmt.Sprintf(`{"recovery_token":%q}`, added.RecoveryToken)))
	undone := decodeBulkResult(t, w)
	if undone.Affected != 0 || undone.Skipped != 1 {
		t.Fatalf("undo of an already-removed membership = %+v, want 0 revoked and 1 skipped "+
			"(body=%s)", undone, w.Body.String())
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tombstone verification tx: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var tombstones int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FROM list_subscribers
 WHERE tenant_id=$1::uuid AND list_id=$2::uuid AND subscriber_id=$3::uuid
   AND removed_at IS NOT NULL`, tenantID, listID, id).Scan(&tombstones); err != nil {
		t.Fatalf("count removal tombstone: %v", err)
	}
	if tombstones != 1 {
		t.Fatalf("removal tombstones after undo = %d, want 1 — the undo destroyed the "+
			"record of who left this list", tombstones)
	}
}

func countFlowRuns(t *testing.T, pool *pgxpool.Pool, tenantID, subscriberID, status string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open flow_runs count tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM flow_runs
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND status = $3`,
		tenantID, subscriberID, status).Scan(&n); err != nil {
		t.Fatalf("count flow_runs (%s): %v", status, err)
	}
	return n
}

// TestBulkAddToListRecovery_SkipsAMembershipReactivatedTheWayTheProductDoesIt is
// the sibling of the hard-delete rejoin test above, and exists because that one
// simulates something the product never does.
//
// Leaving a list is a SOFT delete everywhere in this codebase, and rejoining is
// an upsert that revives the row (`lists/membership_write.go`: ON CONFLICT DO
// UPDATE SET removed_at = NULL, added_at = now() WHERE removed_at IS NOT NULL).
// The undo's safety therefore rests on that upsert bumping `added_at` — if it
// ever stopped, a revived row would keep the timestamp the mistaken add wrote
// and the undo would revoke a membership the person deliberately re-took. The
// hard-delete test cannot notice that; this one fails.
func TestBulkAddToListRecovery_SkipsAMembershipReactivatedTheWayTheProductDoesIt(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID, listID, engineListID := uniqueBulkListIDs(t, pool)
	id := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("addlist-reactivated-%d@example.test", time.Now().UnixNano()), "enabled")

	d := &Deps{Repo: &Repo{Pool: pool, Webhooks: &bulkWebhookRecorder{}}}
	ctx := context.Background()

	w := httptest.NewRecorder()
	d.BulkMoveToList(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/add-to-list",
		fmt.Sprintf(`{"subscriber_ids":[%q],"list_id":%q}`, id, engineListID)))
	added := decodeBulkResult(t, w)
	if added.Affected != 1 || added.RecoveryToken == "" {
		t.Fatalf("add-to-list = %+v, want one row and a recovery token", added)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open leave/rejoin tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE list_subscribers SET removed_at = now()
 WHERE tenant_id=$1::uuid AND list_id=$2::uuid AND subscriber_id=$3::uuid`,
		tenantID, listID, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("soft-remove membership: %v", err)
	}
	// The product's own revival clause, copied from lists.AddMembers so this
	// fixture tracks the real semantics rather than a paraphrase of them.
	if _, err := tx.Exec(ctx, `
INSERT INTO list_subscribers (tenant_id, list_id, subscriber_id, source, added_at, removed_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'api', now(), NULL)
ON CONFLICT (tenant_id, list_id, subscriber_id) DO UPDATE
   SET removed_at = NULL,
       added_at   = now(),
       source     = EXCLUDED.source
 WHERE list_subscribers.removed_at IS NOT NULL`,
		tenantID, listID, id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("reactivate membership: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit leave/rejoin: %v", err)
	}

	w = httptest.NewRecorder()
	d.BulkRecover(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/recover",
		fmt.Sprintf(`{"recovery_token":%q}`, added.RecoveryToken)))
	undone := decodeBulkResult(t, w)
	if undone.Affected != 0 || undone.Skipped != 1 {
		t.Fatalf("undo after a real reactivation = %+v, want 0 revoked and 1 skipped (body=%s)",
			undone, w.Body.String())
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open reactivation verification tx: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var live int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FROM list_subscribers
 WHERE tenant_id=$1::uuid AND list_id=$2::uuid AND subscriber_id=$3::uuid
   AND removed_at IS NULL`, tenantID, listID, id).Scan(&live); err != nil {
		t.Fatalf("count live membership: %v", err)
	}
	if live != 1 {
		t.Fatalf("live memberships after undo = %d, want 1 — the undo revoked a "+
			"membership the person deliberately re-took", live)
	}
}
