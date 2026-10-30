// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

type bulkDeleteFixture struct {
	TenantID       string
	SubscriberID   string
	CanonicalEmail string
	SecondaryEmail string
}

func seedBulkDeleteFixture(t *testing.T, pool *db.Pool) bulkDeleteFixture {
	t.Helper()
	fixture := bulkDeleteFixture{
		TenantID:       uuid.NewString(),
		CanonicalEmail: "bulk-delete-canonical-" + uuid.NewString() + "@example.test",
		SecondaryEmail: "bulk-delete-secondary-" + uuid.NewString() + "@example.test",
	}
	seedBulkVerbsTenant(t, pool, fixture.TenantID)
	fixture.SubscriberID = seedBulkVerbsSubscriber(t, pool, fixture.TenantID, fixture.CanonicalEmail, StatusEnabled)

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatalf("bulk delete fixture tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET custom_fields = jsonb_set(custom_fields, '{_listmonk_id}', '"7421"'::jsonb, true)
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, fixture.TenantID, fixture.SubscriberID); err != nil {
		t.Fatalf("seed external marker: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3, false, 'unknown', false)
ON CONFLICT DO NOTHING`,
		fixture.TenantID, fixture.SubscriberID, fixture.SecondaryEmail); err != nil {
		t.Fatalf("seed secondary address: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bulk delete fixture: %v", err)
	}
	return fixture
}

func assertBulkDeleteRolledBack(t *testing.T, pool *db.Pool, fixture bulkDeleteFixture) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatalf("rollback verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var subscribers, addresses, legacySuppressions, canonicalSuppressions int
	var receipts, activityAudits, genericAudits, deleteIntents int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscribers
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, fixture.TenantID, fixture.SubscriberID).Scan(&subscribers); err != nil {
		t.Fatalf("verify rollback subscriber: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, fixture.TenantID, fixture.SubscriberID).Scan(&addresses); err != nil {
		t.Fatalf("verify rollback addresses: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM email_suppressions
 WHERE tenant_id=$1::uuid AND metadata ->> 'deleted_subscriber_id'=$2`, fixture.TenantID, fixture.SubscriberID).Scan(&legacySuppressions); err != nil {
		t.Fatalf("verify rollback legacy suppressions: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_suppressions
 WHERE tenant_id=$1::uuid AND metadata ->> 'deleted_subscriber_id'=$2`, fixture.TenantID, fixture.SubscriberID).Scan(&canonicalSuppressions); err != nil {
		t.Fatalf("verify rollback canonical suppressions: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM erasure_receipts
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, fixture.TenantID, fixture.SubscriberID).Scan(&receipts); err != nil {
		t.Fatalf("verify rollback receipts: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_bulk_operations_audit
 WHERE tenant_id=$1::uuid AND verb='delete'`, fixture.TenantID).Scan(&activityAudits); err != nil {
		t.Fatalf("verify rollback activity audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id=$1::uuid AND action='subscriber.bulk_deleted'`, fixture.TenantID).Scan(&genericAudits); err != nil {
		t.Fatalf("verify rollback generic audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE tenant_id=$1::uuid AND kind=$2
   AND payload ->> 'subscriber_id'=$3`, fixture.TenantID, OutboxKindListmonkDelete, fixture.SubscriberID).Scan(&deleteIntents); err != nil {
		t.Fatalf("verify rollback delete intent: %v", err)
	}
	if subscribers != 1 || addresses < 2 || legacySuppressions != 0 || canonicalSuppressions != 0 ||
		receipts != 0 || activityAudits != 0 || genericAudits != 0 || deleteIntents != 0 {
		t.Fatalf("bulk delete partially committed after failure: subscribers=%d addresses=%d legacy=%d canonical=%d receipts=%d activity=%d audit=%d outbox=%d",
			subscribers, addresses, legacySuppressions, canonicalSuppressions,
			receipts, activityAudits, genericAudits, deleteIntents)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit rollback verification: %v", err)
	}
}

func TestBulkDelete_ErasesEveryAddressAndWritesPrivacySafeProofs(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	fixture := seedBulkDeleteFixture(t, pool)
	foreign := seedBulkDeleteFixture(t, pool)
	repo := &Repo{
		Pool:             pool,
		EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
	}
	d := &Deps{Repo: repo}
	w := httptest.NewRecorder()
	d.BulkDelete(w, bulkVerbsRequest(fixture.TenantID, "/api/v1/subscribers/bulk/delete",
		fmt.Sprintf(`{"subscriber_ids":[%q,%q]}`, fixture.SubscriberID, foreign.SubscriberID)))
	result := decodeBulkResult(t, w)
	if result.Affected != 1 || result.Skipped != 1 || result.RecoveryToken != "" || result.RecoveryUntil != "" ||
		result.Exclusions["missing_or_outside_tenant"] != 1 {
		t.Fatalf("bulk delete result = %+v", result)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatalf("bulk delete verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var subscriberRows, addressRows, recoveryRows int
	var legacyCount, canonicalCount, canonicalMarkers, receipts int
	var activityAudits, genericAudits, deleteIntents int
	var allLegacyPermanent, allCanonicalPermanent bool
	var payloadRaw, genericMetadata, activityParams []byte
	var activityActor, receiptRedacted, receiptHash string
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscribers
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, fixture.TenantID, fixture.SubscriberID).Scan(&subscriberRows); err != nil {
		t.Fatalf("count erased subscriber: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, fixture.TenantID, fixture.SubscriberID).Scan(&addressRows); err != nil {
		t.Fatalf("count erased addresses: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_bulk_recovery
 WHERE tenant_id=$1::uuid AND operation='delete'`, fixture.TenantID).Scan(&recoveryRows); err != nil {
		t.Fatalf("count unsafe recovery rows: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*),
       bool_and(reason='manual' AND source='gdpr_bulk_delete' AND expires_at IS NULL
                AND metadata ->> 'gdpr_erasure'='true'
                AND metadata ->> 'deleted_subscriber_id'=$2
                AND metadata ->> 'listmonk_id'='7421')
  FROM email_suppressions
 WHERE tenant_id=$1::uuid
   AND email = ANY($3::text[])`, fixture.TenantID, fixture.SubscriberID,
		[]string{fixture.CanonicalEmail, fixture.SecondaryEmail}).Scan(&legacyCount, &allLegacyPermanent); err != nil {
		t.Fatalf("verify legacy erasure suppressions: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*),
       bool_and(reason='dsar_deletion' AND source='api' AND expires_at IS NULL
                AND metadata ->> 'gdpr_erasure'='true'
                AND metadata ->> 'deleted_subscriber_id'=$2
                AND metadata ->> 'listmonk_id'='7421'),
       count(*) FILTER (WHERE metadata ->> 'is_canonical'='true')
  FROM subscriber_suppressions
 WHERE tenant_id=$1::uuid
   AND email = ANY($3::text[])`, fixture.TenantID, fixture.SubscriberID,
		[]string{fixture.CanonicalEmail, fixture.SecondaryEmail}).Scan(&canonicalCount, &allCanonicalPermanent, &canonicalMarkers); err != nil {
		t.Fatalf("verify canonical erasure suppressions: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(max(email_redacted), ''), COALESCE(max(email_hash), '')
  FROM erasure_receipts
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, fixture.TenantID, fixture.SubscriberID).Scan(
		&receipts, &receiptRedacted, &receiptHash,
	); err != nil {
		t.Fatalf("verify erasure receipt: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(max(params::text), '{}'::text), COALESCE(max(actor), '')
  FROM subscriber_bulk_operations_audit
 WHERE tenant_id=$1::uuid AND verb='delete'`, fixture.TenantID).Scan(
		&activityAudits, &activityParams, &activityActor,
	); err != nil {
		t.Fatalf("verify bulk activity audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(max(metadata::text), '{}'::text)
  FROM audit_log
 WHERE tenant_id=$1::uuid AND action='subscriber.bulk_deleted'`, fixture.TenantID).Scan(
		&genericAudits, &genericMetadata,
	); err != nil {
		t.Fatalf("verify generic audit: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(max(payload::text), '{}'::text)
  FROM outbox_events
 WHERE tenant_id=$1::uuid AND kind=$2
   AND payload ->> 'subscriber_id'=$3`, fixture.TenantID, OutboxKindListmonkDelete, fixture.SubscriberID).Scan(
		&deleteIntents, &payloadRaw,
	); err != nil {
		t.Fatalf("verify deletion tombstone: %v", err)
	}

	if subscriberRows != 0 || addressRows != 0 || recoveryRows != 0 ||
		legacyCount != 2 || !allLegacyPermanent || canonicalCount != 2 || !allCanonicalPermanent ||
		canonicalMarkers != 1 || receipts != 1 || activityAudits != 1 || genericAudits != 1 || deleteIntents != 1 {
		t.Fatalf("bulk erasure evidence subscriber=%d addresses=%d recovery=%d legacy=%d/%v canonical=%d/%v markers=%d receipts=%d activity=%d audit=%d outbox=%d",
			subscriberRows, addressRows, recoveryRows, legacyCount, allLegacyPermanent,
			canonicalCount, allCanonicalPermanent, canonicalMarkers, receipts,
			activityAudits, genericAudits, deleteIntents)
	}
	if receiptRedacted == "" || receiptHash != hashEmailForReceipt(fixture.CanonicalEmail) ||
		strings.Contains(receiptRedacted, fixture.CanonicalEmail) {
		t.Fatalf("unsafe/invalid erasure receipt redacted=%q hash=%q", receiptRedacted, receiptHash)
	}
	for label, raw := range map[string][]byte{
		"outbox":         payloadRaw,
		"generic audit":  genericMetadata,
		"activity audit": activityParams,
	} {
		text := strings.ToLower(string(raw))
		if strings.Contains(text, strings.ToLower(fixture.CanonicalEmail)) ||
			strings.Contains(text, strings.ToLower(fixture.SecondaryEmail)) {
			t.Fatalf("%s retained cleartext PII: %s", label, raw)
		}
	}
	if activityActor != "admin:human" {
		t.Fatalf("bulk activity actor=%q, want privacy-safe role", activityActor)
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		t.Fatalf("decode outbox payload: %v", err)
	}
	if len(payload) != 1 || payload["subscriber_id"] != fixture.SubscriberID {
		t.Fatalf("outbox payload retained more than opaque identity: %#v", payload)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bulk delete verification: %v", err)
	}

	// Supplying another tenant's opaque id cannot erase that row or its
	// attached addresses; it is reported only as skipped to avoid disclosure.
	foreignTx, err := db.WithTenant(ctx, pool, foreign.TenantID)
	if err != nil {
		t.Fatalf("foreign tenant verify tx: %v", err)
	}
	defer func() { _ = foreignTx.Rollback(ctx) }()
	var foreignSubscriberRows, foreignAddressRows int
	if err := foreignTx.QueryRow(ctx, `
SELECT count(*) FROM subscribers
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, foreign.TenantID, foreign.SubscriberID).Scan(&foreignSubscriberRows); err != nil {
		t.Fatalf("verify foreign subscriber: %v", err)
	}
	if err := foreignTx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, foreign.TenantID, foreign.SubscriberID).Scan(&foreignAddressRows); err != nil {
		t.Fatalf("verify foreign addresses: %v", err)
	}
	if foreignSubscriberRows != 1 || foreignAddressRows < 2 {
		t.Fatalf("cross-tenant deletion occurred: subscriber=%d addresses=%d", foreignSubscriberRows, foreignAddressRows)
	}
}

func TestBulkDelete_AppendsExactlyOneTombstonePerDeletedSubscriber(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	firstID := seedBulkVerbsSubscriber(t, pool, tenantID,
		"bulk-delete-one-"+uuid.NewString()+"@example.test", StatusUnconfirmed)
	secondID := seedBulkVerbsSubscriber(t, pool, tenantID,
		"bulk-delete-two-"+uuid.NewString()+"@example.test", StatusUnconfirmed)
	d := &Deps{Repo: &Repo{
		Pool:             pool,
		EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
	}}
	w := httptest.NewRecorder()
	d.BulkDelete(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/delete",
		fmt.Sprintf(`{"subscriber_ids":[%q,%q]}`, firstID, secondID)))
	result := decodeBulkResult(t, w)
	if result.Affected != 2 || result.Skipped != 0 {
		t.Fatalf("multi-delete result=%+v", result)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("multi-delete verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count, distinctSubscribers, privacySafe int
	if err := tx.QueryRow(ctx, `
SELECT count(*),
       count(DISTINCT payload ->> 'subscriber_id'),
       count(*) FILTER (WHERE payload = jsonb_build_object(
	                              'subscriber_id', payload ->> 'subscriber_id'
	                          ))
  FROM outbox_events
 WHERE tenant_id=$1::uuid AND kind=$2`, tenantID, OutboxKindListmonkDelete).Scan(
		&count, &distinctSubscribers, &privacySafe,
	); err != nil {
		t.Fatalf("count multi-delete tombstones: %v", err)
	}
	if count != 2 || distinctSubscribers != 2 || privacySafe != 2 {
		t.Fatalf("delete tombstones count=%d distinct=%d privacy_safe=%d", count, distinctSubscribers, privacySafe)
	}
}

func TestBulkDelete_EngineTombstoneFailureRollsBackEverything(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	fixture := seedBulkDeleteFixture(t, pool)
	d := &Deps{Repo: &Repo{
		Pool:             pool,
		EngineSyncOutbox: subscriberOutboxTestAdapter{err: errors.New("injected delete tombstone failure")},
	}}
	w := httptest.NewRecorder()
	d.BulkDelete(w, bulkVerbsRequest(fixture.TenantID, "/api/v1/subscribers/bulk/delete",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, fixture.SubscriberID)))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("append failure status=%d body=%s", w.Code, w.Body.String())
	}
	assertBulkDeleteRolledBack(t, pool, fixture)
}

func TestBulkDelete_AuditFailureRollsBackEverything(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	fixture := seedBulkDeleteFixture(t, pool)
	d := &Deps{Repo: &Repo{
		Pool:             pool,
		EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
	}}
	request := bulkVerbsRequest(fixture.TenantID, "/api/v1/subscribers/bulk/delete",
		fmt.Sprintf(`{"subscriber_ids":[%q]}`, fixture.SubscriberID))
	request = request.WithContext(middleware.WithActor(request.Context(), "invalid-audit-actor", "pii@example.test"))
	w := httptest.NewRecorder()
	d.BulkDelete(w, request)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure status=%d body=%s", w.Code, w.Body.String())
	}
	assertBulkDeleteRolledBack(t, pool, fixture)
}
