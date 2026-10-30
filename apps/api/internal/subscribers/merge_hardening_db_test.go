package subscribers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func seedImmutableImportMergeEvidence(t *testing.T, ctx context.Context, tx pgx.Tx, tenantID string, duplicate *Subscriber) (string, string) {
	t.Helper()
	var importID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_imports (
    tenant_id, object_key, original_filename, rows_total, on_existing,
    consent_source, consent_source_url, consent_captured_at, consent_legal_basis,
    consent_jurisdiction, consent_reason, consent_policy_version,
    consent_evidence_reference, consent_scope, consent_scope_acknowledged,
    consent_contract_version, source_fingerprint, source_fingerprint_scheme,
    source_fingerprint_key_version, preflight_fingerprint, preflight_at,
    preflight_expires_at, preflight_rows_total, preflight_rows_failed,
    preflight_rows_existing, preflight_state_fingerprint,
    preflight_catalog_fingerprint
) VALUES (
    $1::uuid,$2,'merge-evidence.csv',1,'skip',
    'double_optin','https://evidence.example.test/import',clock_timestamp()-interval '1 minute','consent',
    'US','merge lineage evidence','2026-07','receipt:merge-evidence','email_marketing',true,
    'subscriber-import-consent/v1',$3,'hmac-sha256-v1','test-key-v1',$4,
    clock_timestamp(),clock_timestamp()+interval '15 minutes',1,0,0,$5,$6
)
RETURNING id::text`, tenantID, "imports/merge-evidence-"+uuid.NewString()+".csv",
		strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64)).Scan(&importID); err != nil {
		t.Fatalf("seed import evidence job: %v", err)
	}
	var consentFingerprint string
	if err := tx.QueryRow(ctx, `
SELECT subscriber_import_sha256_parts(
    'subscriber-import-consent-fingerprint/v1', consent_contract_version,
    lower(btrim(consent_source)), consent_source_url,
    (floor(extract(epoch FROM consent_captured_at) * 1000000)::bigint)::text,
    'consent', upper(btrim(consent_jurisdiction)), btrim(consent_reason),
    btrim(consent_policy_version), btrim(consent_evidence_reference), 'email_marketing'
)
FROM subscriber_imports WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, importID).Scan(&consentFingerprint); err != nil {
		t.Fatalf("compute import consent fingerprint: %v", err)
	}
	var approvalID, storedFingerprint string
	if err := tx.QueryRow(ctx, `
SELECT approval_id::text, consent_fingerprint
  FROM create_subscriber_import_consent_approval($1::uuid,$2::uuid,$3,0,$4)`,
		tenantID, importID, strings.Repeat("b", 64), consentFingerprint).Scan(&approvalID, &storedFingerprint); err != nil {
		t.Fatalf("create immutable import approval: %v", err)
	}
	if storedFingerprint != consentFingerprint {
		t.Fatalf("approval fingerprint=%q want=%q", storedFingerprint, consentFingerprint)
	}
	rowFingerprint := strings.Repeat("e", 64)
	var evidenceFingerprint string
	if err := tx.QueryRow(ctx, `SELECT subscriber_import_sha256_parts('subscriber-import-evidence/v1',$1,$2)`, consentFingerprint, rowFingerprint).Scan(&evidenceFingerprint); err != nil {
		t.Fatalf("compute row evidence fingerprint: %v", err)
	}
	var consentRecordID string
	if err := tx.QueryRow(ctx, `
INSERT INTO consent_records (
    tenant_id,subscriber_id,email,channel,consent_status,source,captured_at,evidence
)
SELECT $1::uuid,$2::uuid,$3,'email','granted','double_optin',a.captured_at,
       jsonb_build_object(
           'import_id',$4::text,'approval_id',a.id::text,
           'source_row_fingerprint',$5::text,'evidence_fingerprint',$6::text)
  FROM subscriber_import_consent_approvals a
 WHERE a.tenant_id=$1::uuid AND a.id=$7::uuid
RETURNING id::text`, tenantID, duplicate.ID, duplicate.Email, importID, rowFingerprint, evidenceFingerprint, approvalID).Scan(&consentRecordID); err != nil {
		t.Fatalf("seed immutable consent record: %v", err)
	}
	var receiptID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_import_consent_receipts (
    tenant_id,import_id,approval_id,subscriber_id,consent_record_id,
    source_row_fingerprint,evidence_fingerprint,source_file_fingerprint,
    operation,status_before,status_after,sendable_before,sendable_after,
    eligibility_transition_applied
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,
    'updated','blocklisted','blocklisted',false,false,false
)
RETURNING id::text`, tenantID, importID, approvalID, duplicate.ID, consentRecordID,
		rowFingerprint, evidenceFingerprint, strings.Repeat("a", 64)).Scan(&receiptID); err != nil {
		t.Fatalf("seed immutable import receipt: %v", err)
	}
	var snapshot string
	if err := tx.QueryRow(ctx, `SELECT to_jsonb(r)::text FROM subscriber_import_consent_receipts r WHERE id=$1::uuid`, receiptID).Scan(&snapshot); err != nil {
		t.Fatalf("snapshot immutable receipt: %v", err)
	}
	return receiptID, snapshot
}

func seedMergePair(t *testing.T, repo *Repo, tenantID string) (*Subscriber, *Subscriber) {
	t.Helper()
	ctx := context.Background()
	primary, err := repo.Upsert(ctx, tenantID, writePathCreate("merge-primary-"+uuid.NewString()+"@example.test", map[string]any{"FNAME": "Primary"}))
	if err != nil {
		t.Fatalf("seed primary: %v", err)
	}
	duplicate, err := repo.Upsert(ctx, tenantID, writePathCreate("merge-duplicate-"+uuid.NewString()+"@example.test", map[string]any{"LNAME": "Duplicate"}))
	if err != nil {
		t.Fatalf("seed duplicate: %v", err)
	}
	return primary, duplicate
}

func TestCanonicalMergePreservesAddressesRestrictionsLineageAndDurableEffects(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	primary, duplicate := seedMergePair(t, repo, tenantID)
	duplicateProfileID := duplicate.ProfileID
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed scope: %v", err)
	}
	if _, err := seed.Exec(ctx, `
UPDATE subscribers
   SET status='blocklisted', mailchimp_status='unsubscribed',
       signup_ip='203.0.113.19', phone_e164='+15551234567',
       locale='en-US', language='en', country='US', region='CA',
       activity_summary='{"opens":9}'::jsonb, unsubscribe_reason='private note',
       source_id='source-person-42', source_platform='merge-test',
       gpp_sections='{"usnat":"private-consent-string"}'::jsonb,
       updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, duplicate.ID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed restriction: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id,email,reason,source,metadata)
VALUES ($1::uuid,$2,'manual_unsubscribe','api','{"merge_test":true}'::jsonb)`, tenantID, duplicate.Email); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed suppression: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO profile_aliases (tenant_id,subscriber_id,alias_type,alias_value,source)
VALUES ($1::uuid,$2::uuid,'external_id',$3,'api')`, tenantID, duplicate.ID, "duplicate-alias-"+uuid.NewString()); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed alias: %v", err)
	}
	var normalizedTagID string
	if err := seed.QueryRow(ctx, `INSERT INTO tags (tenant_id,name) VALUES ($1::uuid,$2) RETURNING id::text`, tenantID, "merge-tag-"+uuid.NewString()).Scan(&normalizedTagID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed normalized tag: %v", err)
	}
	if _, err := seed.Exec(ctx, `INSERT INTO subscriber_tags (tenant_id,subscriber_id,tag_id,source) VALUES ($1::uuid,$2::uuid,$3::uuid,'merge-test')`, tenantID, duplicate.ID, normalizedTagID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed duplicate normalized tag: %v", err)
	}
	receiptID, receiptBefore := seedImmutableImportMergeEvidence(t, ctx, seed, tenantID, duplicate)
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	primary, err = repo.Get(ctx, tenantID, primary.ID)
	if err != nil {
		t.Fatalf("refresh primary: %v", err)
	}
	duplicate, err = repo.Get(ctx, tenantID, duplicate.ID)
	if err != nil {
		t.Fatalf("refresh duplicate: %v", err)
	}

	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	body, _ := json.Marshal(MergeInput{
		PrimaryID: primary.ID, DuplicateID: duplicate.ID,
		PrimaryVersion: primary.Version, DuplicateVersion: duplicate.Version,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/merge", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	var operatorLog bytes.Buffer
	(&Deps{
		Repo:   repo,
		Logger: slog.New(slog.NewTextHandler(&operatorLog, nil)),
	}).MergeHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("merge status=%d body=%s operator_log=%s", rec.Code, rec.Body.String(), operatorLog.String())
	}
	var result MergeResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.PrimaryVersion == "" || rec.Header().Get("ETag") != result.PrimaryVersion || result.PrimaryVersion == primary.Version {
		t.Fatalf("fresh revision body/header=%q/%q before=%q", result.PrimaryVersion, rec.Header().Get("ETag"), primary.Version)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify scope: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var status, mergedInto, duplicateStoredEmail string
	var archived, piiMinimized bool
	if err := verify.QueryRow(ctx, `SELECT status FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, primary.ID).Scan(&status); err != nil {
		t.Fatalf("read survivor: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT merged_into_subscriber_id::text,email::text,archived_at IS NOT NULL,
       custom_fields='{}'::jsonb AND merge_fields='{}'::jsonb AND
       first_name='' AND last_name='' AND full_name='' AND display_name='' AND
       signup_ip IS NULL AND phone_e164 IS NULL AND locale IS NULL AND
       language IS NULL AND country IS NULL AND region IS NULL AND
       activity_summary='{}'::jsonb AND unsubscribe_reason IS NULL AND
       source_id IS NULL AND source_platform IS NULL AND gpp_sections='{}'::jsonb AND
       consent_email_marketing_at IS NULL AND consent_sms_marketing_at IS NULL AND
       consent_profiling_at IS NULL AND consent_targeted_ads_at IS NULL AND
       consent_ai_processing_at IS NULL AND frequency_preference='paused' AND
       profile_id<>$3::uuid
  FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, duplicate.ID, duplicateProfileID).Scan(&mergedInto, &duplicateStoredEmail, &archived, &piiMinimized); err != nil {
		t.Fatalf("read tombstone: %v", err)
	}
	if status != StatusBlocklisted || mergedInto != primary.ID || !archived || !piiMinimized || !strings.HasSuffix(duplicateStoredEmail, "@no-email.invalid") {
		t.Fatalf("merged state status=%q into=%q archived=%v pii_minimized=%v email=%q", status, mergedInto, archived, piiMinimized, duplicateStoredEmail)
	}
	var addresses, suppression, aliases, lineage, audits, intents, normalizedTags int
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_emails WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND lower(email::text) IN (lower($3),lower($4))`, tenantID, primary.ID, primary.Email, duplicate.Email).Scan(&addresses); err != nil {
		t.Fatalf("read addresses: %v", err)
	}
	var movedConsentStatus, movedReconciliation, movedChecksum string
	if err := verify.QueryRow(ctx, `
SELECT consent_status,consent_reconciliation_state,COALESCE(consent_decision_checksum,'')
  FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND lower(email::text)=lower($3)`,
		tenantID, primary.ID, duplicate.Email).Scan(
		&movedConsentStatus, &movedReconciliation, &movedChecksum,
	); err != nil {
		t.Fatalf("read moved address consent classification: %v", err)
	}
	if movedConsentStatus != "never_subscribed" || movedReconciliation != "failed_closed" || movedChecksum == "" {
		t.Fatalf("moved address retained inexact consent = %q/%q checksum=%t",
			movedConsentStatus, movedReconciliation, movedChecksum != "")
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)`, tenantID, duplicate.Email).Scan(&suppression); err != nil {
		t.Fatalf("read suppression: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM profile_aliases WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, primary.ID).Scan(&aliases); err != nil {
		t.Fatalf("read aliases: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_merge_lineage WHERE tenant_id=$1::uuid AND duplicate_subscriber_id=$2::uuid AND primary_subscriber_id=$3::uuid AND duplicate_profile_id=$4::uuid`, tenantID, duplicate.ID, primary.ID, duplicateProfileID).Scan(&lineage); err != nil {
		t.Fatalf("read lineage: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid AND action='subscriber.merged' AND resource_id=$2`, tenantID, primary.ID).Scan(&audits); err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE tenant_id=$1::uuid AND kind=$2 AND payload->>'subscriber_id'=$3 AND payload->>'merged_duplicate_email'=$4`, tenantID, OutboxKindListmonkSync, primary.ID, duplicate.Email).Scan(&intents); err != nil {
		t.Fatalf("read engine intent: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_tags WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND tag_id=$3::uuid`, tenantID, primary.ID, normalizedTagID).Scan(&normalizedTags); err != nil {
		t.Fatalf("read normalized subscriber tag: %v", err)
	}
	if addresses != 2 || suppression != 1 || aliases < 1 || lineage != 1 || audits != 1 || intents != 1 || normalizedTags != 1 {
		t.Fatalf("preservation addresses=%d suppression=%d aliases=%d lineage=%d audits=%d intents=%d normalized_tags=%d", addresses, suppression, aliases, lineage, audits, intents, normalizedTags)
	}
	var receiptAfter, receiptSubject string
	if err := verify.QueryRow(ctx, `SELECT to_jsonb(r)::text,subscriber_id::text FROM subscriber_import_consent_receipts r WHERE id=$1::uuid`, receiptID).Scan(&receiptAfter, &receiptSubject); err != nil {
		t.Fatalf("read immutable import receipt after merge: %v", err)
	}
	if receiptAfter != receiptBefore || receiptSubject != duplicate.ID {
		t.Fatalf("immutable receipt changed or moved subject=%q/%q before=%s after=%s", receiptSubject, duplicate.ID, receiptBefore, receiptAfter)
	}
}

func TestMergeConcurrencyHasOneWinnerAndStaleAttemptWritesNothing(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	primary, duplicate := seedMergePair(t, repo, tenantID)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	in := MergeInput{PrimaryID: primary.ID, DuplicateID: duplicate.ID, PrimaryVersion: primary.Version, DuplicateVersion: duplicate.Version}
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := repo.Merge(context.Background(), tenantID, in)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	winners, stale := 0, 0
	for err := range errs {
		if err == nil {
			winners++
		} else if errors.Is(err, ErrPreconditionFailed) {
			stale++
		} else {
			t.Fatalf("unexpected race error: %v", err)
		}
	}
	if winners != 1 || stale != 1 {
		t.Fatalf("race winners=%d stale=%d", winners, stale)
	}
	ctx := context.Background()
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify race scope: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var audits, lineage, intents int
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid AND action='subscriber.merged' AND resource_id=$2`, tenantID, primary.ID).Scan(&audits); err != nil {
		t.Fatalf("race audit count: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_merge_lineage WHERE tenant_id=$1::uuid AND duplicate_subscriber_id=$2::uuid`, tenantID, duplicate.ID).Scan(&lineage); err != nil {
		t.Fatalf("race lineage count: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE tenant_id=$1::uuid AND kind=$2 AND payload->>'subscriber_id'=$3`, tenantID, OutboxKindListmonkSync, primary.ID).Scan(&intents); err != nil {
		t.Fatalf("race engine intent count: %v", err)
	}
	if audits != 1 || lineage != 1 || intents != 1 {
		t.Fatalf("race durable effects audits=%d lineage=%d intents=%d", audits, lineage, intents)
	}
}

func TestMergeOutboxFailureRollsBackProjectionLineageAuditAndWebhook(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	primary, duplicate := seedMergePair(t, repo, tenantID)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{err: errors.New("forced merge outbox failure")}
	webhooks := &recordingSubscriberWebhook{}
	repo.Webhooks = webhooks
	_, err := repo.Merge(context.Background(), tenantID, MergeInput{
		PrimaryID: primary.ID, DuplicateID: duplicate.ID,
		PrimaryVersion: primary.Version, DuplicateVersion: duplicate.Version,
	})
	if err == nil || !strings.Contains(err.Error(), "merge engine reconciliation") {
		t.Fatalf("merge failure=%v", err)
	}
	afterPrimary, getErr := repo.Get(context.Background(), tenantID, primary.ID)
	if getErr != nil {
		t.Fatalf("read primary rollback: %v", getErr)
	}
	afterDuplicate, getErr := repo.Get(context.Background(), tenantID, duplicate.ID)
	if getErr != nil {
		t.Fatalf("read duplicate rollback: %v", getErr)
	}
	if afterPrimary.Version != primary.Version || afterDuplicate.Version != duplicate.Version || len(webhooks.events) != 0 {
		t.Fatalf("rollback escaped primary=%q/%q duplicate=%q/%q webhooks=%v", afterPrimary.Version, primary.Version, afterDuplicate.Version, duplicate.Version, webhooks.events)
	}
	verify, txErr := db.WithTenant(context.Background(), pool, tenantID)
	if txErr != nil {
		t.Fatalf("verify scope: %v", txErr)
	}
	defer func() { _ = verify.Rollback(context.Background()) }()
	var lineage, audits int
	_ = verify.QueryRow(context.Background(), `SELECT count(*) FROM subscriber_merge_lineage WHERE tenant_id=$1::uuid AND duplicate_subscriber_id=$2::uuid`, tenantID, duplicate.ID).Scan(&lineage)
	_ = verify.QueryRow(context.Background(), `SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid AND action='subscriber.merged' AND resource_id=$2`, tenantID, primary.ID).Scan(&audits)
	if lineage != 0 || audits != 0 {
		t.Fatalf("rollback lineage=%d audits=%d", lineage, audits)
	}
}

func TestMergeWebhookFailureRollsBackOutboxLineageAuditAndProjection(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	primary, duplicate := seedMergePair(t, repo, tenantID)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	repo.Webhooks = failingAddressConsentWebhook{err: errors.New("forced merge webhook failure")}
	_, err := repo.Merge(ctx, tenantID, MergeInput{
		PrimaryID: primary.ID, DuplicateID: duplicate.ID,
		PrimaryVersion: primary.Version, DuplicateVersion: duplicate.Version,
	})
	if err == nil || !strings.Contains(err.Error(), "dispatch merged webhook") {
		t.Fatalf("merge webhook failure=%v", err)
	}
	afterPrimary, getErr := repo.Get(ctx, tenantID, primary.ID)
	if getErr != nil {
		t.Fatalf("read primary after webhook rollback: %v", getErr)
	}
	afterDuplicate, getErr := repo.Get(ctx, tenantID, duplicate.ID)
	if getErr != nil {
		t.Fatalf("read duplicate after webhook rollback: %v", getErr)
	}
	if afterPrimary.Version != primary.Version || afterDuplicate.Version != duplicate.Version {
		t.Fatalf("webhook rollback escaped primary=%q/%q duplicate=%q/%q", afterPrimary.Version, primary.Version, afterDuplicate.Version, duplicate.Version)
	}
	verify, txErr := db.WithTenant(ctx, pool, tenantID)
	if txErr != nil {
		t.Fatalf("verify webhook rollback scope: %v", txErr)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var lineage, audits, intents int
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_merge_lineage WHERE tenant_id=$1::uuid AND duplicate_subscriber_id=$2::uuid`, tenantID, duplicate.ID).Scan(&lineage); err != nil {
		t.Fatalf("webhook rollback lineage: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid AND action='subscriber.merged' AND resource_id=$2`, tenantID, primary.ID).Scan(&audits); err != nil {
		t.Fatalf("webhook rollback audits: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE tenant_id=$1::uuid AND kind=$2 AND payload->>'subscriber_id'=$3`, tenantID, OutboxKindListmonkSync, primary.ID).Scan(&intents); err != nil {
		t.Fatalf("webhook rollback engine intents: %v", err)
	}
	if lineage != 0 || audits != 0 || intents != 0 {
		t.Fatalf("webhook rollback lineage=%d audits=%d intents=%d", lineage, audits, intents)
	}
}

func TestMergeEvidenceFunctionRejectsCrossTenantAndDirectWrites(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("scope: %v", err)
	}
	_, err = tx.Exec(ctx, `SELECT public.subscriber_merge_reparent_evidence($1::uuid,$2::uuid,$3::uuid)`, uuid.NewString(), uuid.NewString(), uuid.NewString())
	if err == nil || !strings.Contains(err.Error(), "tenant scope mismatch") {
		_ = tx.Rollback(ctx)
		t.Fatalf("cross-tenant function error=%v", err)
	}
	_ = tx.Rollback(ctx)

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("direct-write scope: %v", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO subscriber_merge_lineage (tenant_id,duplicate_subscriber_id,primary_subscriber_id) VALUES ($1::uuid,$2::uuid,$3::uuid)`, tenantID, uuid.NewString(), uuid.NewString())
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		_ = tx.Rollback(ctx)
		t.Fatalf("direct lineage write error=%v", err)
	}
	_ = tx.Rollback(ctx)

	primary, duplicate := seedMergePair(t, repo, tenantID)
	alternate, err := repo.Upsert(ctx, tenantID, writePathCreate("merge-alternate-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed alternate lineage target: %v", err)
	}
	childTenantID := uuid.NewString()
	childScope, err := db.WithTenant(ctx, pool, childTenantID)
	if err != nil {
		t.Fatalf("child federation scope: %v", err)
	}
	if _, err := childScope.Exec(ctx, `INSERT INTO tenants (id,name,slug,tier) VALUES ($1::uuid,'merge-child',$2,'studio')`, childTenantID, "merge-child-"+strings.ReplaceAll(childTenantID, "-", "")); err != nil {
		_ = childScope.Rollback(ctx)
		t.Fatalf("seed child tenant: %v", err)
	}
	var childSubscriberID string
	if err := childScope.QueryRow(ctx, `INSERT INTO subscribers (tenant_id,email,status,consent_source) VALUES ($1::uuid,$2,'unconfirmed','unknown') RETURNING id::text`, childTenantID, "merge-child-"+uuid.NewString()+"@example.test").Scan(&childSubscriberID); err != nil {
		_ = childScope.Rollback(ctx)
		t.Fatalf("seed child subscriber: %v", err)
	}
	if _, err := childScope.Exec(ctx, `INSERT INTO federated_subscriber_map (tenant_id,child_subscriber_id,parent_tenant_id,master_subscriber_id,match_type) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'manual')`, childTenantID, childSubscriberID, tenantID, duplicate.ID); err != nil {
		_ = childScope.Rollback(ctx)
		t.Fatalf("seed cross-tenant federation link: %v", err)
	}
	if err := childScope.Commit(ctx); err != nil {
		t.Fatalf("commit child federation seed: %v", err)
	}
	t.Cleanup(func() {
		cleanup, cleanupErr := db.WithTenant(context.Background(), pool, childTenantID)
		if cleanupErr == nil {
			_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, childTenantID)
			_ = cleanup.Commit(context.Background())
		}
	})
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("valid lineage scope: %v", err)
	}
	for range 2 {
		if _, err := tx.Exec(ctx, `SELECT public.subscriber_merge_reparent_evidence($1::uuid,$2::uuid,$3::uuid)`, tenantID, primary.ID, duplicate.ID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("idempotent lineage call: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit valid lineage: %v", err)
	}
	childVerify, err := db.WithTenant(ctx, pool, childTenantID)
	if err != nil {
		t.Fatalf("verify child federation scope: %v", err)
	}
	var federationTarget string
	if err := childVerify.QueryRow(ctx, `SELECT master_subscriber_id::text FROM federated_subscriber_map WHERE tenant_id=$1::uuid AND child_subscriber_id=$2::uuid`, childTenantID, childSubscriberID).Scan(&federationTarget); err != nil {
		_ = childVerify.Rollback(ctx)
		t.Fatalf("verify child federation target: %v", err)
	}
	_ = childVerify.Rollback(ctx)
	if federationTarget != primary.ID {
		t.Fatalf("cross-tenant federation target=%q want=%q", federationTarget, primary.ID)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("conflicting lineage scope: %v", err)
	}
	_, err = tx.Exec(ctx, `SELECT public.subscriber_merge_reparent_evidence($1::uuid,$2::uuid,$3::uuid)`, tenantID, alternate.ID, duplicate.ID)
	if err == nil || !strings.Contains(err.Error(), "already belongs to another lineage") {
		_ = tx.Rollback(ctx)
		t.Fatalf("conflicting lineage error=%v", err)
	}
	_ = tx.Rollback(ctx)
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("missing lineage identity scope: %v", err)
	}
	_, err = tx.Exec(ctx, `SELECT public.subscriber_merge_reparent_evidence($1::uuid,$2::uuid,$3::uuid)`, tenantID, primary.ID, uuid.NewString())
	if err == nil || !strings.Contains(err.Error(), "not tenant-visible") {
		_ = tx.Rollback(ctx)
		t.Fatalf("missing lineage identity error=%v", err)
	}
	_ = tx.Rollback(ctx)

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("lineage privilege scope: %v", err)
	}
	var canInsert, canExecute, securityDefiner, fixedPath bool
	if err := tx.QueryRow(ctx, `
SELECT has_table_privilege(current_user,'public.subscriber_merge_lineage','INSERT'),
       has_function_privilege(current_user,'public.subscriber_merge_reparent_evidence(uuid,uuid,uuid)','EXECUTE'),
       p.prosecdef,
       -- pg_temp must be named, and named LAST. Leaving it out does not exclude
       -- the caller's temp schema; PostgreSQL searches it anyway and searches it
       -- FIRST for relation and type names, so an unqualified type in this body
       -- is shadowable and the shadow's code runs as the definer. Exploited
       -- against this schema; swept by migration 1915.
       COALESCE('search_path=pg_catalog, public, pg_temp'=ANY(p.proconfig),false)
  FROM pg_proc p
 WHERE p.oid='public.subscriber_merge_reparent_evidence(uuid,uuid,uuid)'::regprocedure`).Scan(&canInsert, &canExecute, &securityDefiner, &fixedPath); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("inspect lineage privileges: %v", err)
	}
	if canInsert || !canExecute || !securityDefiner || !fixedPath {
		_ = tx.Rollback(ctx)
		t.Fatalf("lineage privilege insert=%v execute=%v definer=%v fixed_path=%v", canInsert, canExecute, securityDefiner, fixedPath)
	}
	_ = tx.Rollback(ctx)
}

func TestIdentifyCollisionRequiresEveryRevisionAndHistoricalIdentifiersResolveSurvivor(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	primary, duplicate := seedMergePair(t, repo, tenantID)
	primaryProfileID := primary.ProfileID
	duplicateProfileID := duplicate.ProfileID
	externalID := "crm-merge-" + uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed identify collision: %v", err)
	}
	if _, err := seed.Exec(ctx, `UPDATE subscribers SET external_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, primary.ID, externalID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed identify external id: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit identify seed: %v", err)
	}
	primary, err = repo.Get(ctx, tenantID, primary.ID)
	if err != nil {
		t.Fatalf("refresh identify primary: %v", err)
	}
	duplicate, err = repo.Get(ctx, tenantID, duplicate.ID)
	if err != nil {
		t.Fatalf("refresh identify duplicate: %v", err)
	}

	base := IdentifyInput{ExternalID: externalID, Email: duplicate.Email}
	if _, err := repo.Identify(ctx, tenantID, base); !errors.Is(err, ErrMergePreconditionRequired) {
		t.Fatalf("identify missing revisions error=%v", err)
	}
	unchangedPrimary, err := repo.Get(ctx, tenantID, primary.ID)
	if err != nil {
		t.Fatalf("read primary after rejected identify: %v", err)
	}
	unchangedDuplicate, err := repo.Get(ctx, tenantID, duplicate.ID)
	if err != nil {
		t.Fatalf("read duplicate after rejected identify: %v", err)
	}
	if unchangedPrimary.Version != primary.Version || unchangedDuplicate.Version != duplicate.Version {
		t.Fatalf("missing-precondition identify mutated rows primary=%q/%q duplicate=%q/%q", unchangedPrimary.Version, primary.Version, unchangedDuplicate.Version, duplicate.Version)
	}

	stale := base
	stale.SubscriberVersions = map[string]string{
		primary.ID: primary.Version, duplicate.ID: `"subscriber:stale"`,
	}
	staleBody, _ := json.Marshal(stale)
	staleReq := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/identify", strings.NewReader(string(staleBody)))
	staleReq.Header.Set("Content-Type", "application/json")
	staleReq = staleReq.WithContext(middleware.WithTenant(staleReq.Context(), &middleware.Tenant{ID: tenantID}))
	staleRec := httptest.NewRecorder()
	(&Deps{Repo: repo}).Identify(staleRec, staleReq)
	if staleRec.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale identify status=%d body=%s", staleRec.Code, staleRec.Body.String())
	}

	exact := base
	exact.SubscriberVersions = map[string]string{
		primary.ID: primary.Version, duplicate.ID: duplicate.Version,
	}
	exactBody, _ := json.Marshal(exact)
	exactReq := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/identify", strings.NewReader(string(exactBody)))
	exactReq.Header.Set("Content-Type", "application/json")
	exactReq = exactReq.WithContext(middleware.WithTenant(exactReq.Context(), &middleware.Tenant{ID: tenantID}))
	exactRec := httptest.NewRecorder()
	(&Deps{Repo: repo}).Identify(exactRec, exactReq)
	if exactRec.Code != http.StatusOK {
		t.Fatalf("exact identify status=%d body=%s", exactRec.Code, exactRec.Body.String())
	}
	var merged IdentifyResult
	if err := json.Unmarshal(exactRec.Body.Bytes(), &merged); err != nil {
		t.Fatalf("decode exact identify: %v", err)
	}
	if merged.Action != "merged" || merged.Subscriber == nil || merged.Subscriber.ID != primary.ID ||
		merged.Subscriber.Version == primary.Version || exactRec.Header().Get("ETag") != merged.Subscriber.Version {
		t.Fatalf("identify merge result=%+v etag=%q", merged, exactRec.Header().Get("ETag"))
	}

	byHistoricalProfile, err := repo.Identify(ctx, tenantID, IdentifyInput{ProfileID: duplicateProfileID})
	if err != nil {
		t.Fatalf("identify historical duplicate profile id: %v", err)
	}
	if byHistoricalProfile.Subscriber.ID != primary.ID || byHistoricalProfile.Subscriber.ProfileID != primaryProfileID {
		t.Fatalf("historical profile resolved id/profile=%q/%q want=%q/%q", byHistoricalProfile.Subscriber.ID, byHistoricalProfile.Subscriber.ProfileID, primary.ID, primaryProfileID)
	}
	byHistoricalEmail, err := repo.Identify(ctx, tenantID, IdentifyInput{Email: duplicate.Email})
	if err != nil {
		t.Fatalf("identify former duplicate email: %v", err)
	}
	if byHistoricalEmail.Subscriber.ID != primary.ID {
		t.Fatalf("former email forked/resolved id=%q want=%q", byHistoricalEmail.Subscriber.ID, primary.ID)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify identify merge: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var active, audits, lineage int
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND archived_at IS NULL`, tenantID).Scan(&active); err != nil {
		t.Fatalf("count active identify profiles: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid AND action='subscriber.merged' AND resource_id=$2`, tenantID, primary.ID).Scan(&audits); err != nil {
		t.Fatalf("count identify audits: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_merge_lineage WHERE tenant_id=$1::uuid AND duplicate_profile_id=$2::uuid AND primary_subscriber_id=$3::uuid`, tenantID, duplicateProfileID, primary.ID).Scan(&lineage); err != nil {
		t.Fatalf("count identify lineage: %v", err)
	}
	if active != 1 || audits != 1 || lineage != 1 {
		t.Fatalf("identify final active=%d audits=%d lineage=%d", active, audits, lineage)
	}
}

func TestMergeRejectsErasureMarkerOnSecondaryAddressWithoutSideEffects(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	primary, duplicate := seedMergePair(t, repo, tenantID)
	secondary := "erased-secondary-" + uuid.NewString() + "@example.test"
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed erasure scope: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO subscriber_emails (tenant_id,subscriber_id,email,is_primary,consent_status)
VALUES ($1::uuid,$2::uuid,$3,false,'never_subscribed')`, tenantID, duplicate.ID, secondary); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed secondary address: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id,email,reason,source,metadata,scope)
VALUES ($1::uuid,$2,'dsar_deletion','system','{"gdpr_erasure":true}'::jsonb,'all')`, tenantID, secondary); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed secondary erasure marker: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit secondary erasure marker: %v", err)
	}

	_, err = repo.Merge(ctx, tenantID, MergeInput{
		PrimaryID: primary.ID, DuplicateID: duplicate.ID,
		PrimaryVersion: primary.Version, DuplicateVersion: duplicate.Version,
	})
	if !errors.Is(err, ErrErasureBlocked) {
		t.Fatalf("secondary erasure merge error=%v", err)
	}
	definerCheck, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open definer erasure check: %v", err)
	}
	_, definerErr := definerCheck.Exec(ctx, `SELECT public.subscriber_merge_reparent_evidence($1::uuid,$2::uuid,$3::uuid)`, tenantID, primary.ID, duplicate.ID)
	if !sqlStateIs(definerErr, "PWE01") {
		_ = definerCheck.Rollback(ctx)
		t.Fatalf("definer erasure check error=%v", definerErr)
	}
	_ = definerCheck.Rollback(ctx)
	afterPrimary, err := repo.Get(ctx, tenantID, primary.ID)
	if err != nil {
		t.Fatalf("read primary after blocked erasure merge: %v", err)
	}
	afterDuplicate, err := repo.Get(ctx, tenantID, duplicate.ID)
	if err != nil {
		t.Fatalf("read duplicate after blocked erasure merge: %v", err)
	}
	if afterPrimary.Version != primary.Version || afterDuplicate.Version != duplicate.Version {
		t.Fatalf("erasure rejection mutated rows primary=%q/%q duplicate=%q/%q", afterPrimary.Version, primary.Version, afterDuplicate.Version, duplicate.Version)
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify erasure rejection: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var address, lineage, audits int
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_emails WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND email=$3`, tenantID, duplicate.ID, secondary).Scan(&address); err != nil {
		t.Fatalf("verify secondary address: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_merge_lineage WHERE tenant_id=$1::uuid AND duplicate_subscriber_id=$2::uuid`, tenantID, duplicate.ID).Scan(&lineage); err != nil {
		t.Fatalf("verify no erasure lineage: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid AND action='subscriber.merged' AND resource_id=$2`, tenantID, primary.ID).Scan(&audits); err != nil {
		t.Fatalf("verify no erasure audit: %v", err)
	}
	if address != 1 || lineage != 0 || audits != 0 {
		t.Fatalf("erasure rejection address=%d lineage=%d audits=%d", address, lineage, audits)
	}
}
