// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func migration1766Path(t *testing.T) string {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration 1766 test source")
	}
	return filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../infra/migrations/1766_subscriber_email_consent_terminal_hardening.sql",
	))
}

func TestMigration1766ConsentTerminalStaticContract(t *testing.T) {
	path := migration1766Path(t)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1766: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1766_subscriber_email_consent_terminal_hardening",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration safety blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	plans := migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, nil)
	if len(plans) != 1 || !plans[0].Explicit || plans[0].Strategy != migrationrunner.RollbackStrategyNoOp {
		t.Fatalf("migration rollback contract = %+v", plans)
	}

	required := []string{
		"migration-execution: phased",
		"SET LOCAL lock_timeout = '5s'",
		"SET LOCAL statement_timeout = '5min'",
		"CREATE TABLE public.subscriber_email_consent_release_gate",
		"CREATE TABLE public.subscriber_email_consent_reconciliation_runs",
		"consent_reconciliation_state text",
		"'pending', 'proven', 'failed_closed'",
		"CREATE OR REPLACE PROCEDURE public.complete_subscriber_email_consent_reconciliation",
		"p_batch_limit < 1 OR p_batch_limit > 500",
		"LIMIT p_batch_limit",
		"FOR UPDATE SKIP LOCKED",
		"CALL public.complete_subscriber_email_consent_reconciliation(250)",
		"subscriber-email-consent-postcheck/v2",
		"postcheck_checksum",
		"ADD COLUMN IF NOT EXISTS recorded_at timestamptz",
		"NEW.recorded_at := pg_catalog.clock_timestamp()",
		"terminal chronology and evidence are immutable",
		"subscriber_email_consent_record_proof_valid",
		"record.evidence ->> 'event_id'",
		"record.evidence ->> 'address_id' = address.id::text",
		"event.subject_id = address.id::text",
		"record.evidence ->> 'policy_version'",
		"record.expires_at IS NULL OR record.expires_at > p_as_of",
		"WHEN 'double_optin'",
		"WHEN 'single_optin'",
		"WHEN 'signed_form'",
		"WHEN 'preference_center'",
		"WHEN 'direct_request'",
		"subscriber_import_consent_receipts",
		"subscriber_import_consent_approvals",
		"subscriber_email_consent_jurisdiction_proof_valid",
		"receipt.id::text = event.preferences ->> 'consent_receipt_id'",
		"receipt.privacy_policy_version = event.policy_version",
		"jurisdiction consent receipt evidence is immutable",
		"aa_1766_consent_receipts_exact_address_lock",
		"zz_1766_consent_receipts_generation",
		"blocker.occurred_at >= candidate.occurred_at OR",
		"blocker.recorded_at >= candidate.recorded_at",
		"ORDER BY eligible_candidates.occurred_at DESC",
		"CASE WHEN eligible_candidates.decision = 'granted' THEN 1 ELSE 0 END",
		"subscribed email address requires latest exact non-expired structured grant evidence",
		"subscriber_email_consent_lock_pair",
		"pg_try_advisory_xact_lock",
		"FOR attempt IN 1..50 LOOP",
		"ERRCODE = '55P03'",
		"subscriber_email_consent_address_state",
		"subscriber_emails_nonexpired_positive_visibility",
		"subscriber_email_consent_release_open",
		"REVOKE ALL ON\n    public.subscriber_email_consent_release_gate",
		"subscriber_email_consent_lock_for_repair",
		"subscriber_email_consent_lock_for_repair_by_id",
		"address_id uuid,",
		"stored_email text,",
		"is_primary boolean,",
		"consent_status text,",
		"suppressed boolean,",
		"last_engaged_at timestamptz,",
		"created_at timestamptz,",
		"updated_at timestamptz,",
		"reconciliation_state text",
		"address.subscriber_id = p_subscriber_id",
		"address.id = p_address_id",
		"REVOKE ALL ON FUNCTION public.subscriber_email_consent_lock_for_repair_by_id",
		"GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_lock_for_repair_by_id",
		"subscriber_email_consent_set_suppressed_for_repair_by_id",
		"p_expected_updated_at timestamptz",
		"SET lock_timeout = '1s'",
		"'not_found'::text",
		"'stale'::text",
		"'updated'::text",
		"consent suppression repair must match active exact-address evidence",
		"subscriber_email_suppressed_requires_exact_evidence",
		"SET suppressed = p_suppressed",
		"address.updated_at = p_expected_updated_at",
		"FROM public.suppressions AS evidence",
		"FROM public.subscriber_suppressions AS evidence",
		"FROM public.email_suppressions AS evidence",
		"REVOKE ALL ON FUNCTION public.subscriber_email_consent_set_suppressed_for_repair_by_id",
		"GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_set_suppressed_for_repair_by_id",
		"CREATE OR REPLACE FUNCTION public.subscriber_email_consent_reconcile_identity()",
		"subscriber email identity reconciliation trigger context is invalid",
		"subscriber email identity reconciliation tenant scope is mismatched",
		"TG_RELID <> 'public.subscribers'::pg_catalog.regclass",
		"TG_OP NOT IN ('INSERT', 'UPDATE')",
		"FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_reconcile_identity()",
		"REVOKE ALL ON FUNCTION public.subscriber_email_consent_reconcile_identity()",
		"FROM PUBLIC, postwave_app",
		"gate-hidden canonical identity reconciliation boundary is incomplete",
		"consent repair tenant scope is missing or mismatched",
		"Omitting FOR UPDATE",
		"gate.status = 'open'",
		"consent_reconciliation_state = 'proven'",
		"consent_decision_checksum IS NOT NULL",
		"consent_proof_expires_at > pg_catalog.clock_timestamp()",
		"generation = state.generation + 1",
		"zz_1766_sync_ledger_generation",
		"zz_1766_suppressions_generation",
		"zz_1766_email_suppressions_generation",
		"zz_1766_subscriber_suppressions_generation",
		"SELECT subscriber.id, address.email::text",
		"zy_1766_consent_receipts_refresh_projection",
		"consent_events_project_vector",
		"event.category IN ('email_marketing', 'marketing')",
		"subscribers_require_email_purpose_proof",
		"subscriber_channel_consents_require_email_proof",
		"terminal guards must bypass app visibility RLS safely",
		"operational security definers require a BYPASSRLS owner",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_events_exact_email_terminal_v2_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_records_exact_email_terminal_v2_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_records_event_binding_v2_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_emails_consent_pending_v2_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_emails_consent_expiry_v2_idx",
		"subscriber_emails_canonical_normalized_email_v2_uidx",
		"normalized identity collisions require review",
		"public.subscriber_email_consent_normalize_email(subject_email::text)",
		"public.subscriber_email_consent_normalize_email(email::text)",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1766 missing contract fragment %q", fragment)
		}
	}
	eventFoldStart := strings.Index(sql, "event_candidates AS (")
	eventFoldEnd := -1
	if eventFoldStart >= 0 {
		if relativeEnd := strings.Index(sql[eventFoldStart:], "\n    ),\n    candidates AS ("); relativeEnd >= 0 {
			eventFoldEnd = eventFoldStart + relativeEnd
		}
	}
	if eventFoldStart < 0 || eventFoldEnd < 0 ||
		!strings.Contains(sql[eventFoldStart:eventFoldEnd],
			"event.category IN ('email_marketing', 'marketing')") {
		t.Fatal("terminal event fold must include legacy marketing non-grants")
	}
	for _, forbidden := range []string{
		"record.evidence <> '{}'::jsonb",
		"OLD.consent_status = 'subscribed'",
		"RETURN NEW;\n    END IF;\n\n    latest_action",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration 1766 retains weak trust shortcut %q", forbidden)
		}
	}
	for _, declaration := range []string{
		"CREATE OR REPLACE FUNCTION public.subscriber_email_consent_lock_for_repair(\n",
		"CREATE OR REPLACE FUNCTION public.subscriber_email_consent_lock_for_repair_by_id(\n",
	} {
		repairStart := strings.Index(sql, declaration)
		repairEnd := -1
		if repairStart >= 0 {
			if relativeEnd := strings.Index(sql[repairStart:], "\n$function$;"); relativeEnd >= 0 {
				repairEnd = repairStart + relativeEnd
			}
		}
		if repairStart < 0 || repairEnd < 0 {
			t.Fatalf("repair resolver declaration %q is incomplete", declaration)
		}
		repairBody := strings.ToUpper(sql[repairStart:repairEnd])
		if strings.Contains(repairBody, "FOR UPDATE") ||
			strings.Contains(repairBody, "EXECUTE") {
			t.Fatalf("repair resolver %q must use static SQL and only the exact advisory mutex before evidence writers", declaration)
		}
	}
	setterDeclaration := "CREATE OR REPLACE FUNCTION public.subscriber_email_consent_set_suppressed_for_repair_by_id(\n"
	setterStart := strings.Index(sql, setterDeclaration)
	setterEnd := -1
	if setterStart >= 0 {
		if relativeEnd := strings.Index(sql[setterStart:], "\n$function$;"); relativeEnd >= 0 {
			setterEnd = setterStart + relativeEnd
		}
	}
	if setterStart < 0 || setterEnd < 0 {
		t.Fatalf("suppression repair setter declaration %q is incomplete", setterDeclaration)
	}
	setterBody := strings.ToUpper(sql[setterStart:setterEnd])
	if strings.Contains(setterBody, "FOR UPDATE") ||
		strings.Contains(setterBody, "EXECUTE") ||
		strings.Contains(setterBody, "SET CONSENT_STATUS") ||
		strings.Contains(setterBody, "SET IS_PRIMARY") {
		t.Fatal("suppression repair setter must use static SQL and mutate only the exact revision's suppressed projection")
	}
	identityDeclaration := "CREATE OR REPLACE FUNCTION public.subscriber_email_consent_reconcile_identity()\n"
	identityStart := strings.Index(sql, identityDeclaration)
	identityEnd := -1
	if identityStart >= 0 {
		if relativeEnd := strings.Index(sql[identityStart:], "\n$function$;"); relativeEnd >= 0 {
			identityEnd = identityStart + relativeEnd
		}
	}
	if identityStart < 0 || identityEnd < 0 {
		t.Fatalf("canonical identity trigger declaration %q is incomplete", identityDeclaration)
	}
	identityBody := strings.ToUpper(sql[identityStart:identityEnd])
	if strings.Contains(identityBody, "EXECUTE") ||
		!strings.Contains(identityBody, "SECURITY DEFINER") ||
		!strings.Contains(identityBody, "SET SEARCH_PATH = PG_CATALOG, PUBLIC") {
		t.Fatal("canonical identity trigger must be a fixed-search-path static security definer")
	}
	gotIndexes := strings.Count(strings.ToUpper(sql), "CREATE INDEX CONCURRENTLY IF NOT EXISTS") +
		strings.Count(strings.ToUpper(sql), "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS")
	if gotIndexes != 9 {
		t.Fatalf("concurrent exact-predicate indexes = %d, want 9", gotIndexes)
	}
	callAt := strings.Index(sql, "CALL public.complete_subscriber_email_consent_reconciliation(250)")
	firstCommit := strings.Index(sql, "COMMIT;")
	lastBegin := strings.LastIndex(sql, "BEGIN;")
	if callAt < firstCommit || callAt > lastBegin {
		t.Fatal("resumable reconciliation CALL must be top-level between committed DDL/index and final postcheck phases")
	}
}

func requireMigration1766(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var installed bool
	if err := pool.QueryRow(context.Background(), `
SELECT to_regclass('public.subscriber_email_consent_release_gate') IS NOT NULL
`).Scan(&installed); err != nil {
		t.Fatalf("inspect migration 1766: %v", err)
	}
	if !installed {
		t.Fatalf("migration 1766 is not installed in DATABASE_URL")
	}
}

type migration1766Address struct {
	ID           string
	SubscriberID string
	Email        string
}

type migration1766RepairRow struct {
	AddressID           string
	StoredEmail         string
	IsPrimary           bool
	ConsentStatus       string
	Suppressed          bool
	LastEngagedAt       *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
	ReconciliationState string
}

func scanMigration1766RepairRow(row pgx.Row) (migration1766RepairRow, error) {
	var resolved migration1766RepairRow
	err := row.Scan(
		&resolved.AddressID,
		&resolved.StoredEmail,
		&resolved.IsPrimary,
		&resolved.ConsentStatus,
		&resolved.Suppressed,
		&resolved.LastEngagedAt,
		&resolved.CreatedAt,
		&resolved.UpdatedAt,
		&resolved.ReconciliationState,
	)
	return resolved, err
}

func scanMigration1766SuppressionRepairRow(
	row pgx.Row,
) (string, migration1766RepairRow, error) {
	var outcome string
	var resolved migration1766RepairRow
	err := row.Scan(
		&outcome,
		&resolved.AddressID,
		&resolved.StoredEmail,
		&resolved.IsPrimary,
		&resolved.ConsentStatus,
		&resolved.Suppressed,
		&resolved.LastEngagedAt,
		&resolved.CreatedAt,
		&resolved.UpdatedAt,
		&resolved.ReconciliationState,
	)
	return outcome, resolved, err
}

func createMigration1766Subscriber(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, email string,
) migration1766Address {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'unknown')
RETURNING id::text`, tenantID, email).Scan(&subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("address read tx: %v", err)
	}
	var address migration1766Address
	if err := tx.QueryRow(ctx, `
SELECT id::text, subscriber_id::text, email::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		tenantID, subscriberID).Scan(&address.ID, &address.SubscriberID, &address.Email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read canonical address: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit address read: %v", err)
	}
	return address
}

func createMigration1766SecondaryAddress(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, subscriberID, email string,
) migration1766Address {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("secondary address tenant tx: %v", err)
	}
	address := migration1766Address{SubscriberID: subscriberID, Email: email}
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_emails (
    tenant_id, subscriber_id, email, is_primary, consent_status, suppressed
) VALUES ($1::uuid, $2::uuid, $3, false, 'never_subscribed', false)
RETURNING id::text, email::text`, tenantID, subscriberID, email).Scan(
		&address.ID, &address.Email,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert secondary address: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit secondary address: %v", err)
	}
	return address
}

func appendMigration1766ExactGrant(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	address migration1766Address,
	occurredAt time.Time,
	expiresAt time.Time,
	policy, evidence string,
) {
	t.Helper()
	appendMigration1766SourceGrant(
		t, pool, tenantID, address, occurredAt, expiresAt, policy, evidence,
		"direct_request", "api", "admin",
	)
}

func appendMigration1766SourceGrant(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	address migration1766Address,
	occurredAt time.Time,
	expiresAt time.Time,
	policy, evidence, eventSource, eventChannel, recordSource string,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("grant tenant tx: %v", err)
	}
	prefs, _ := json.Marshal(map[string]any{
		"subscriber_id":  address.SubscriberID,
		"address_id":     address.ID,
		"consent_status": "subscribed",
		"legal_basis":    "consent",
		"jurisdiction":   "IN",
		"reason":         "verified " + eventSource,
	})
	var eventID string
	if err := tx.QueryRow(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, $4, 'email_marketing',
    'granted', $5, $6, $7::jsonb, $8, $9
)
RETURNING id::text`, tenantID, address.ID, address.Email, eventChannel,
		eventSource, policy, string(prefs), evidence, occurredAt).Scan(&eventID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append exact grant event: %v", err)
	}
	proof, _ := json.Marshal(map[string]any{
		"event_id":       eventID,
		"address_id":     address.ID,
		"legal_basis":    "consent",
		"jurisdiction":   "IN",
		"reason":         "verified " + eventSource,
		"policy_version": policy,
		"evidence":       evidence,
	})
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, expires_at, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'granted', $4, $5, $6, $7::jsonb
)`, tenantID, address.SubscriberID, address.Email, recordSource, occurredAt,
		expiresAt, string(proof)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append exact grant record: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit exact grant: %v", err)
	}
}

func appendMigration1766ImportGrant(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	address migration1766Address,
	capturedAt time.Time,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("import proof tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const (
		sourceFingerprint  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		rowFingerprint     = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		preflight          = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
		stateFingerprint   = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
		catalogFingerprint = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	)
	var importID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_imports (
    tenant_id, object_key, original_filename, mapping, rows_total, on_existing,
    consent_source, consent_source_url, consent_captured_at, consent_legal_basis,
    consent_jurisdiction, consent_reason, consent_policy_version,
    consent_evidence_reference, consent_scope, consent_scope_acknowledged,
    consent_contract_version, source_fingerprint, source_fingerprint_scheme,
    source_fingerprint_key_version, preflight_fingerprint, preflight_at,
    preflight_expires_at, preflight_rows_total, preflight_rows_failed,
    preflight_rows_existing, preflight_state_fingerprint,
    preflight_catalog_fingerprint
) VALUES (
    $1::uuid, 'imports/1766-live.csv', '1766-live.csv', '{}'::jsonb, 1, 'skip',
    'signed_form', 'https://example.test/consent/1766', $2, 'consent',
    'GB', 'Reviewed signed form for email marketing.', 'privacy-v2',
    'receipt:IMPORT-1766', 'email_marketing', true,
    'subscriber-import-consent/v1', $3, 'hmac-sha256-v1',
    'v1', $4, clock_timestamp(), clock_timestamp() + interval '15 minutes',
    1, 0, 0, $5, $6
)
RETURNING id::text`, tenantID, capturedAt, sourceFingerprint, preflight,
		stateFingerprint, catalogFingerprint).Scan(&importID); err != nil {
		t.Fatalf("insert import proof job: %v", err)
	}
	var approvalID, consentFingerprint string
	if err := tx.QueryRow(ctx, `
SELECT subscriber_import_sha256_parts(
    'subscriber-import-consent-fingerprint/v1', consent_contract_version,
    lower(btrim(consent_source)), consent_source_url,
    (floor(extract(epoch FROM consent_captured_at) * 1000000)::bigint)::text,
    'consent', upper(btrim(consent_jurisdiction)), btrim(consent_reason),
    btrim(consent_policy_version), btrim(consent_evidence_reference),
    'email_marketing'
)
  FROM subscriber_imports
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, importID).Scan(
		&consentFingerprint,
	); err != nil {
		t.Fatalf("compute normalized import consent fingerprint: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT approval_id::text, consent_fingerprint
  FROM create_subscriber_import_consent_approval(
      $1::uuid, $2::uuid, $3, 0, $4
  )`, tenantID, importID, preflight, consentFingerprint).Scan(
		&approvalID, &consentFingerprint,
	); err != nil {
		t.Fatalf("create normalized import approval: %v", err)
	}
	var evidenceFingerprint string
	if err := tx.QueryRow(ctx, `
SELECT subscriber_import_sha256_parts(
    'subscriber-import-evidence/v1', $1, $2
)`, consentFingerprint, rowFingerprint).Scan(&evidenceFingerprint); err != nil {
		t.Fatalf("compute import row evidence fingerprint: %v", err)
	}
	var consentRecordID string
	if err := tx.QueryRow(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'granted', 'form', $4,
    jsonb_build_object(
        'import_id', $5::text,
        'approval_id', $6::text,
        'source_row_fingerprint', $7::text,
        'evidence_fingerprint', $8::text
    )
)
RETURNING id::text`, tenantID, address.SubscriberID, address.Email,
		capturedAt, importID, approvalID, rowFingerprint,
		evidenceFingerprint).Scan(&consentRecordID); err != nil {
		t.Fatalf("insert import consent record: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_import_consent_receipts (
    tenant_id, import_id, approval_id, subscriber_id, consent_record_id,
    source_row_fingerprint, evidence_fingerprint, source_file_fingerprint,
    operation, status_before, status_after, sendable_before, sendable_after,
    eligibility_transition_applied
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
    $6, $7, $8, 'created', NULL, 'enabled', false, false, true
)`, tenantID, importID, approvalID, address.SubscriberID, consentRecordID,
		rowFingerprint, evidenceFingerprint, sourceFingerprint); err != nil {
		t.Fatalf("insert exact import row receipt: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit exact import proof chain: %v", err)
	}
}

func readMigration1766AddressState(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	address migration1766Address,
) (status, classification, checksum string, occurred, recorded *time.Time) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("state tenant tx: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT consent_status,
       consent_reconciliation_state,
       COALESCE(consent_decision_checksum, ''),
       consent_terminal_occurred_at,
       consent_terminal_recorded_at
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, address.ID).Scan(
		&status, &classification, &checksum, &occurred, &recorded,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read address terminal state: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit terminal state read: %v", err)
	}
	return status, classification, checksum, occurred, recorded
}

func scanMigration1766TenantRow(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, query string,
	args []any,
	dest ...any,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant read tx: %v", err)
	}
	if err := tx.QueryRow(ctx, query, args...).Scan(dest...); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("tenant read: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant read: %v", err)
	}
}

func migration1766AppVisiblePositiveCount(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	addressIDs []string,
) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("app visibility tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("set app visibility role: %v", err)
	}
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])
   AND consent_status = 'subscribed'`, tenantID, addressIDs).Scan(&count); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read app positive visibility: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit app positive visibility: %v", err)
	}
	return count
}

func assertMigration1766AppCannotReadFleetMetadata(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, relation := range []string{
		"subscriber_email_consent_release_gate",
		"subscriber_email_consent_reconciliation_runs",
	} {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("fleet metadata tenant tx for %s: %v", relation, err)
		}
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("set app role for %s: %v", relation, err)
		}
		_, queryErr := tx.Exec(ctx, "SELECT 1 FROM "+relation+" LIMIT 1")
		_ = tx.Rollback(ctx)
		var pgErr *pgconn.PgError
		if !errors.As(queryErr, &pgErr) || pgErr.Code != "42501" {
			t.Fatalf("postwave_app %s read error = %v, want SQLSTATE 42501", relation, queryErr)
		}
	}
}

func TestMigration1766ConsentTerminalLive(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	const tenantID = "00000000-0000-4000-8000-0099a2c41766"
	seedPrimaryEmailTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	assertMigration1766AppCannotReadFleetMetadata(t, pool, tenantID)
	var appEmailRepair, appIDRepair, appSuppressionRepair, appIdentityTrigger bool
	var publicEmailRepair, publicIDRepair, publicSuppressionRepair bool
	var publicIdentityTrigger bool
	if err := pool.QueryRow(context.Background(), `
SELECT has_function_privilege(
           'postwave_app',
           'subscriber_email_consent_lock_for_repair(uuid,uuid,text)',
           'EXECUTE'
       ),
       has_function_privilege(
           'postwave_app',
           'subscriber_email_consent_lock_for_repair_by_id(uuid,uuid,uuid)',
           'EXECUTE'
       ),
	       has_function_privilege(
	           'postwave_app',
	           'subscriber_email_consent_set_suppressed_for_repair_by_id(uuid,uuid,uuid,timestamp with time zone,boolean)',
	           'EXECUTE'
	       ),
	       has_function_privilege(
	           'postwave_app',
	           'subscriber_email_consent_reconcile_identity()',
	           'EXECUTE'
	       ),
       has_function_privilege(
           'public',
           'subscriber_email_consent_lock_for_repair(uuid,uuid,text)',
           'EXECUTE'
       ),
       has_function_privilege(
           'public',
           'subscriber_email_consent_lock_for_repair_by_id(uuid,uuid,uuid)',
           'EXECUTE'
       ),
	       has_function_privilege(
	           'public',
	           'subscriber_email_consent_set_suppressed_for_repair_by_id(uuid,uuid,uuid,timestamp with time zone,boolean)',
	           'EXECUTE'
	       ),
	       has_function_privilege(
	           'public',
	           'subscriber_email_consent_reconcile_identity()',
	           'EXECUTE'
	       )`).Scan(
		&appEmailRepair,
		&appIDRepair,
		&appSuppressionRepair,
		&appIdentityTrigger,
		&publicEmailRepair,
		&publicIDRepair,
		&publicSuppressionRepair,
		&publicIdentityTrigger,
	); err != nil {
		t.Fatalf("inspect repair function privileges: %v", err)
	}
	if !appEmailRepair || !appIDRepair || !appSuppressionRepair ||
		appIdentityTrigger || publicEmailRepair || publicIDRepair ||
		publicSuppressionRepair || publicIdentityTrigger {
		t.Fatalf(
			"repair/identity privileges app=%t/%t/%t/%t public=%t/%t/%t/%t",
			appEmailRepair, appIDRepair, appSuppressionRepair, appIdentityTrigger,
			publicEmailRepair, publicIDRepair, publicSuppressionRepair,
			publicIdentityTrigger,
		)
	}

	address := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("consent-terminal-%d@example.test", suffix))
	status, classification, checksum, _, _ := readMigration1766AddressState(
		t, pool, tenantID, address,
	)
	if status != "never_subscribed" || classification != "failed_closed" || checksum == "" {
		t.Fatalf("new address state = %q/%q checksum=%t, want fail-closed classified", status, classification, checksum != "")
	}
	directTriggerTx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("direct canonical identity trigger tx: %v", err)
	}
	if _, err := directTriggerTx.Exec(context.Background(), `SET LOCAL ROLE postwave_app`); err != nil {
		_ = directTriggerTx.Rollback(context.Background())
		t.Fatalf("set direct canonical identity trigger role: %v", err)
	}
	_, directTriggerErr := directTriggerTx.Exec(context.Background(), `
SELECT subscriber_email_consent_reconcile_identity()`)
	_ = directTriggerTx.Rollback(context.Background())
	var directTriggerPgErr *pgconn.PgError
	if !errors.As(directTriggerErr, &directTriggerPgErr) ||
		directTriggerPgErr.Code != "42501" {
		t.Fatalf("direct canonical identity trigger error = %v, want SQLSTATE 42501",
			directTriggerErr)
	}

	// A tenant-scoped application transaction cannot even stage a canonical
	// identity mutation for another tenant: RLS hides the row before the
	// deferred reconciliation trigger is relevant.
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	const crossTenantID = "00000000-0000-4000-8000-0099a2c41767"
	seedPrimaryEmailTenant(t, pool, crossTenantID)
	crossTenantAddress := createMigration1766Subscriber(t, pool, crossTenantID,
		fmt.Sprintf("identity-cross-tenant-%d@example.test", suffix))
	mismatchedIdentityTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("mismatched canonical identity tx: %v", err)
	}
	attackEmail := fmt.Sprintf("identity-cross-tenant-attack-%d@example.test", suffix)
	mismatchedIdentityTag, mismatchedIdentityErr := mismatchedIdentityTx.Exec(ctx, `
UPDATE subscribers
   SET email = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, crossTenantID,
		crossTenantAddress.SubscriberID, attackEmail)
	if mismatchedIdentityErr != nil {
		_ = mismatchedIdentityTx.Rollback(ctx)
		t.Fatalf("cross-tenant identity update: %v", mismatchedIdentityErr)
	}
	if mismatchedIdentityTag.RowsAffected() != 0 {
		_ = mismatchedIdentityTx.Rollback(ctx)
		t.Fatalf("cross-tenant identity update affected %d rows, want RLS-invisible zero",
			mismatchedIdentityTag.RowsAffected())
	}
	if err := mismatchedIdentityTx.Commit(ctx); err != nil {
		t.Fatalf("commit RLS-invisible cross-tenant update: %v", err)
	}
	verifyCrossTenantTx, err := db.WithTenant(ctx, pool, crossTenantID)
	if err != nil {
		t.Fatalf("cross-tenant identity verification tx: %v", err)
	}
	var storedCrossTenantEmail string
	if err := verifyCrossTenantTx.QueryRow(ctx, `
SELECT email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, crossTenantID,
		crossTenantAddress.SubscriberID).Scan(&storedCrossTenantEmail); err != nil {
		_ = verifyCrossTenantTx.Rollback(ctx)
		t.Fatalf("read cross-tenant identity after rejected update: %v", err)
	}
	if err := verifyCrossTenantTx.Commit(ctx); err != nil {
		t.Fatalf("commit cross-tenant identity verification: %v", err)
	}
	if storedCrossTenantEmail != crossTenantAddress.Email {
		t.Fatalf("cross-tenant identity changed to %q, want %q",
			storedCrossTenantEmail, crossTenantAddress.Email)
	}
	appBypassAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("app-guard-bypass-%d@example.test", suffix))
	appTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("app guard bypass tx: %v", err)
	}
	if _, err := appTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = appTx.Rollback(ctx)
		t.Fatalf("set app guard bypass role: %v", err)
	}
	_, appStageErr := appTx.Exec(ctx, `
UPDATE subscriber_emails SET consent_status = 'subscribed'
	 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, appBypassAddress.ID)
	if appStageErr != nil {
		_ = appTx.Rollback(ctx)
		var appStagePgErr *pgconn.PgError
		if !errors.As(appStageErr, &appStagePgErr) || appStagePgErr.Code != "42501" {
			t.Fatalf("app-role unproven positive stage error = %v, want RLS rejection", appStageErr)
		}
	} else if err := appTx.Commit(ctx); err == nil ||
		!strings.Contains(err.Error(), "latest exact non-expired structured grant") {
		t.Fatalf("app-role unproven positive commit error = %v, want invariant rejection", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("arbitrary proof tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source, evidence
) VALUES ($1::uuid, $2::uuid, $3, 'email', 'granted', 'admin', '{"x":1}')`,
		tenantID, address.SubscriberID, address.Email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append invalid proof attempt: %v", err)
	}
	_, unsafeStageErr := tx.Exec(ctx, `
UPDATE subscriber_emails SET consent_status = 'subscribed'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, address.ID)
	if unsafeStageErr != nil {
		_ = tx.Rollback(ctx)
		var unsafeStagePgErr *pgconn.PgError
		if !errors.As(unsafeStageErr, &unsafeStagePgErr) || unsafeStagePgErr.Code != "42501" {
			t.Fatalf("arbitrary-proof positive stage error = %v, want RLS rejection", unsafeStageErr)
		}
	} else if err := tx.Commit(ctx); err == nil ||
		!strings.Contains(err.Error(), "latest exact non-expired structured grant") {
		t.Fatalf("arbitrary-proof positive commit error = %v, want exact-proof rejection", err)
	}

	now := time.Now().UTC()
	appendMigration1766ExactGrant(t, pool, tenantID, address,
		now.Add(-time.Minute), now.Add(24*time.Hour), "privacy-v2", "case:verified-1766")
	status, classification, checksum, occurred, recorded := readMigration1766AddressState(
		t, pool, tenantID, address,
	)
	if status != "subscribed" || classification != "proven" || len(checksum) != 64 {
		t.Fatalf("exact grant state = %q/%q checksum=%q", status, classification, checksum)
	}
	if occurred == nil || recorded == nil || !recorded.After(*occurred) {
		t.Fatalf("occurred/recorded chronology = %v/%v, want separate later recording time", occurred, recorded)
	}
	immutabilityTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("normal proof immutability tx: %v", err)
	}
	_, normalProofMutationErr := immutabilityTx.Exec(ctx, `
UPDATE consent_events SET channel = 'web'
 WHERE tenant_id = $1::uuid AND subject_id = $2
   AND category = 'email_marketing' AND action = 'granted'`, tenantID, address.ID)
	_ = immutabilityTx.Rollback(ctx)
	var normalProofMutationPgErr *pgconn.PgError
	if normalProofMutationErr == nil || (!strings.Contains(
		normalProofMutationErr.Error(), "chronology and evidence are immutable",
	) && (!errors.As(normalProofMutationErr, &normalProofMutationPgErr) ||
		normalProofMutationPgErr.Code != "42501")) {
		t.Fatalf("normal proof mutation error = %v, want immutable rejection", normalProofMutationErr)
	}

	// Execute every ordinary source/channel mapping in the proof matrix. A
	// source label is accepted only with its matching record source and exact
	// address-bound event/record pair.
	for _, proofCase := range []struct {
		name, eventSource, eventChannel, recordSource string
	}{
		{"double-optin", "double_optin", "email", "double_optin"},
		{"single-optin", "single_optin", "web", "single_optin"},
		{"signed-form", "signed_form", "web", "form"},
		{"preference-center", "preference_center", "web", "preference_center"},
	} {
		proofAddress := createMigration1766Subscriber(t, pool, tenantID,
			fmt.Sprintf("%s-%d@example.test", proofCase.name, suffix))
		appendMigration1766SourceGrant(
			t, pool, tenantID, proofAddress,
			now.Add(-45*time.Minute), now.Add(24*time.Hour),
			"privacy-v2", "case:"+proofCase.name+"-1766",
			proofCase.eventSource, proofCase.eventChannel, proofCase.recordSource,
		)
		proofStatus, proofClassification, proofChecksum, _, _ :=
			readMigration1766AddressState(t, pool, tenantID, proofAddress)
		if proofStatus != "subscribed" || proofClassification != "proven" ||
			len(proofChecksum) != 64 {
			t.Errorf("%s proof state = %q/%q checksum=%q",
				proofCase.name, proofStatus, proofClassification, proofChecksum)
		}
	}

	// Execute the separate 1761 import approval -> consent record -> immutable
	// per-row receipt chain. The record is not sufficient until its relational
	// receipt arrives; the receipt-side 1766 trigger then refreshes the address.
	importAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("import-proof-%d@example.test", suffix))
	appendMigration1766ImportGrant(
		t, pool, tenantID, importAddress,
		now.Add(-30*time.Minute).Truncate(time.Microsecond),
	)
	importStatus, importClassification, importChecksum, _, _ :=
		readMigration1766AddressState(t, pool, tenantID, importAddress)
	if importStatus != "subscribed" || importClassification != "proven" ||
		len(importChecksum) != 64 {
		t.Fatalf("import proof state = %q/%q checksum=%q",
			importStatus, importClassification, importChecksum)
	}

	// Event projection must target the exact matched address, not silently
	// substitute the subscriber's primary email.  A secondary-address revoke is
	// therefore terminal for that secondary address in the same transaction.
	secondaryOwner := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("secondary-owner-%d@example.test", suffix))
	secondaryAddress := createMigration1766SecondaryAddress(
		t, pool, tenantID, secondaryOwner.SubscriberID,
		fmt.Sprintf("secondary-target-%d@example.test", suffix),
	)
	appendMigration1766ExactGrant(t, pool, tenantID, secondaryAddress,
		now.Add(-2*time.Hour), now.Add(24*time.Hour), "privacy-v2", "case:secondary-1766")
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, secondaryAddress,
	)
	if status != "subscribed" || classification != "proven" {
		t.Fatalf("secondary pre-revoke state = %q/%q", status, classification)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("secondary revoke tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'email_marketing',
    'revoked', 'direct_request', 'privacy-v2',
    '{"reason":"secondary terminal revoke"}', 'case:secondary-revoke-1766', $4
)`, tenantID, secondaryAddress.ID, secondaryAddress.Email, now); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append secondary revoke: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit secondary revoke: %v", err)
	}
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, secondaryAddress,
	)
	if status != "unsubscribed" || classification != "failed_closed" {
		t.Fatalf("secondary post-revoke state = %q/%q, want failed-closed revoke", status, classification)
	}
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, secondaryOwner,
	)
	if status == "subscribed" || classification != "failed_closed" {
		t.Fatalf("primary state after secondary revoke = %q/%q", status, classification)
	}

	// Both reviewed-repair lookup forms return the complete row contract.
	// The UUID form is exact to tenant + subscriber + address and must never
	// fall back to the subscriber's primary address or disclose another tuple.
	resolverTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("repair resolver tx: %v", err)
	}
	if _, err := resolverTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = resolverTx.Rollback(ctx)
		t.Fatalf("set repair resolver role: %v", err)
	}
	emailResolved, err := scanMigration1766RepairRow(resolverTx.QueryRow(ctx, `
SELECT address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM subscriber_email_consent_lock_for_repair($1::uuid, $2::uuid, $3)`,
		tenantID, address.SubscriberID, address.Email))
	if err != nil {
		_ = resolverTx.Rollback(ctx)
		t.Fatalf("resolve complete email repair row: %v", err)
	}
	idResolved, err := scanMigration1766RepairRow(resolverTx.QueryRow(ctx, `
SELECT address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM subscriber_email_consent_lock_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid
  )`, tenantID, secondaryAddress.SubscriberID, secondaryAddress.ID))
	if err != nil {
		_ = resolverTx.Rollback(ctx)
		t.Fatalf("resolve complete by-id repair row: %v", err)
	}
	var wrongSubscriberRows, wrongAddressRows int
	if err := resolverTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_email_consent_lock_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid
  )`, tenantID, address.SubscriberID, secondaryAddress.ID).Scan(
		&wrongSubscriberRows,
	); err != nil {
		_ = resolverTx.Rollback(ctx)
		t.Fatalf("resolve by-id with wrong subscriber: %v", err)
	}
	if err := resolverTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_email_consent_lock_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid
  )`, tenantID, secondaryAddress.SubscriberID,
		"00000000-0000-4000-8000-000000001766").Scan(&wrongAddressRows); err != nil {
		_ = resolverTx.Rollback(ctx)
		t.Fatalf("resolve by-id with wrong address: %v", err)
	}
	if err := resolverTx.Commit(ctx); err != nil {
		t.Fatalf("commit repair resolver contract: %v", err)
	}
	if emailResolved.AddressID != address.ID ||
		emailResolved.StoredEmail != address.Email ||
		!emailResolved.IsPrimary ||
		emailResolved.ConsentStatus != "subscribed" ||
		emailResolved.Suppressed ||
		emailResolved.CreatedAt.IsZero() || emailResolved.UpdatedAt.IsZero() ||
		emailResolved.ReconciliationState != "proven" {
		t.Fatalf("complete email repair row = %+v", emailResolved)
	}
	if idResolved.AddressID != secondaryAddress.ID ||
		idResolved.StoredEmail != secondaryAddress.Email ||
		idResolved.IsPrimary ||
		idResolved.ConsentStatus != "unsubscribed" ||
		idResolved.Suppressed ||
		idResolved.CreatedAt.IsZero() || idResolved.UpdatedAt.IsZero() ||
		idResolved.ReconciliationState != "failed_closed" {
		t.Fatalf("complete by-id repair row = %+v", idResolved)
	}
	if wrongSubscriberRows != 0 || wrongAddressRows != 0 {
		t.Fatalf("by-id wrong-identity rows subscriber=%d address=%d",
			wrongSubscriberRows, wrongAddressRows)
	}

	for _, deniedCase := range []struct {
		name  string
		query string
		args  []any
	}{
		{
			name: "by-id resolver",
			query: `SELECT count(*) FROM subscriber_email_consent_lock_for_repair_by_id(
    $1::uuid, $2::uuid, $3::uuid
)`,
			args: []any{
				"00000000-0000-4000-8000-000000009999",
				secondaryAddress.SubscriberID,
				secondaryAddress.ID,
			},
		},
		{
			name: "suppression setter",
			query: `SELECT outcome FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
    $1::uuid, $2::uuid, $3::uuid, $4, true
)`,
			args: []any{
				"00000000-0000-4000-8000-000000009999",
				secondaryAddress.SubscriberID,
				secondaryAddress.ID,
				idResolved.UpdatedAt,
			},
		},
	} {
		deniedTx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("%s cross-tenant tx: %v", deniedCase.name, err)
		}
		if _, err := deniedTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
			_ = deniedTx.Rollback(ctx)
			t.Fatalf("set %s cross-tenant role: %v", deniedCase.name, err)
		}
		_, deniedErr := deniedTx.Exec(ctx, deniedCase.query, deniedCase.args...)
		_ = deniedTx.Rollback(ctx)
		var deniedPgErr *pgconn.PgError
		if !errors.As(deniedErr, &deniedPgErr) || deniedPgErr.Code != "42501" {
			t.Fatalf("%s cross-tenant error = %v, want SQLSTATE 42501",
				deniedCase.name, deniedErr)
		}
	}

	adminPool := migration1766AdminPool(t)
	publicTx, err := db.WithTenant(ctx, adminPool, tenantID)
	if err != nil {
		t.Fatalf("public repair privilege tx: %v", err)
	}
	if _, err := publicTx.Exec(ctx, `SET LOCAL ROLE postwave_public`); err != nil {
		_ = publicTx.Rollback(ctx)
		t.Fatalf("set public repair role: %v", err)
	}
	_, publicRepairErr := publicTx.Exec(ctx, `
SELECT count(*) FROM subscriber_email_consent_lock_for_repair_by_id(
    $1::uuid, $2::uuid, $3::uuid
)`, tenantID, secondaryAddress.SubscriberID, secondaryAddress.ID)
	_ = publicTx.Rollback(ctx)
	var publicRepairPgErr *pgconn.PgError
	if !errors.As(publicRepairErr, &publicRepairPgErr) ||
		publicRepairPgErr.Code != "42501" {
		t.Fatalf("public repair execute error = %v, want SQLSTATE 42501", publicRepairErr)
	}

	// A denormalized channel-consent email is not an identity authority.  The
	// lock and external generation must follow the referenced subscriber's
	// canonical email, and an arbitrary stale value must not get its own ETag.
	channelOwner := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("channel-owner-%d@example.test", suffix))
	rogueChannelEmail := fmt.Sprintf("channel-stale-%d@example.test", suffix)
	var canonicalGenerationBefore int64
	scanMigration1766TenantRow(t, ctx, pool, tenantID, `
SELECT generation FROM subscriber_email_consent_address_state
 WHERE tenant_id = $1::uuid
   AND normalized_email = lower(btrim($2))`, []any{tenantID, channelOwner.Email},
		&canonicalGenerationBefore)
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("stale channel identity tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_channel_consents (
    tenant_id, subscriber_id, channel, status, consent_source, email
) VALUES ($1::uuid, $2::uuid, 'email', 'unknown', 'test', $3)
ON CONFLICT (tenant_id, subscriber_id, channel) DO UPDATE
   SET status = 'unknown', email = EXCLUDED.email,
       consent_source = 'test', updated_at = clock_timestamp()`,
		tenantID, channelOwner.SubscriberID, rogueChannelEmail); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("write stale denormalized channel identity: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit stale denormalized channel identity: %v", err)
	}
	var canonicalGenerationAfter int64
	var rogueGenerationRows int
	scanMigration1766TenantRow(t, ctx, pool, tenantID, `
SELECT generation FROM subscriber_email_consent_address_state
 WHERE tenant_id = $1::uuid
   AND normalized_email = lower(btrim($2))`, []any{tenantID, channelOwner.Email},
		&canonicalGenerationAfter)
	scanMigration1766TenantRow(t, ctx, pool, tenantID, `
SELECT count(*) FROM subscriber_email_consent_address_state
 WHERE tenant_id = $1::uuid
   AND normalized_email = lower(btrim($2))`, []any{tenantID, rogueChannelEmail},
		&rogueGenerationRows)
	if canonicalGenerationAfter <= canonicalGenerationBefore || rogueGenerationRows != 0 {
		t.Fatalf("stale channel identity generation canonical=%d->%d rogue_rows=%d",
			canonicalGenerationBefore, canonicalGenerationAfter, rogueGenerationRows)
	}

	aliasTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("whitespace alias tx: %v", err)
	}
	_, aliasErr := aliasTx.Exec(ctx, `
INSERT INTO subscriber_emails (
    tenant_id, subscriber_id, email, is_primary, consent_status, suppressed
) VALUES ($1::uuid, $2::uuid, $3, false, 'never_subscribed', false)`,
		tenantID, channelOwner.SubscriberID, "  "+channelOwner.Email+"  ")
	_ = aliasTx.Rollback(ctx)
	var aliasPgErr *pgconn.PgError
	if !errors.As(aliasErr, &aliasPgErr) || aliasPgErr.Code != "23505" ||
		aliasPgErr.ConstraintName != "subscriber_emails_canonical_normalized_email_v2_uidx" {
		t.Fatalf("normalized whitespace alias error = %v, want canonical unique rejection", aliasErr)
	}

	invalidTerminalAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("invalid-terminal-%d@example.test", suffix))
	appendMigration1766ExactGrant(t, pool, tenantID, invalidTerminalAddress,
		now.Add(-2*time.Hour), now.Add(24*time.Hour), "privacy-v2", "case:valid-before-invalid-1766")
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("invalid terminal grant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, evidence
) VALUES ($1::uuid, $2::uuid, $3, 'email', 'granted', 'admin', $4, '{"x":1}')`,
		tenantID, invalidTerminalAddress.SubscriberID, invalidTerminalAddress.Email,
		time.Now().UTC()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append later invalid terminal grant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit later invalid terminal grant: %v", err)
	}
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, invalidTerminalAddress,
	)
	if status == "subscribed" || classification != "failed_closed" {
		t.Fatalf("valid positive after later invalid grant = %q/%q, want demoted", status, classification)
	}

	// An otherwise exact but already-expired proof is terminally invalid.
	expiredAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("expired-proof-%d@example.test", suffix))
	appendMigration1766ExactGrant(t, pool, tenantID, expiredAddress,
		now.Add(-2*time.Hour), now.Add(-time.Hour), "privacy-v2", "case:expired-1766")
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, expiredAddress,
	)
	if status == "subscribed" || classification != "failed_closed" {
		t.Fatalf("expired grant state = %q/%q, want failed closed", status, classification)
	}

	// Close the passage-of-time gap: a proof that expires after projection may
	// remain materialized as subscribed until reconciliation, but postwave_app
	// must stop seeing that positive exact-address row at statement time. The
	// campaign/segment send gate uses this same RLS-scoped EXISTS.
	agingAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("aging-proof-%d@example.test", suffix))
	agingExpires := time.Now().UTC().Add(750 * time.Millisecond)
	appendMigration1766ExactGrant(t, pool, tenantID, agingAddress,
		now.Add(-time.Hour), agingExpires, "privacy-v2", "case:aging-1766")
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, agingAddress,
	)
	if status != "subscribed" || classification != "proven" {
		t.Fatalf("pre-expiry aging state = %q/%q, want subscribed/proven", status, classification)
	}
	if wait := time.Until(agingExpires.Add(200 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	rlsTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("expiry RLS tx: %v", err)
	}
	if _, err := rlsTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = rlsTx.Rollback(ctx)
		t.Fatalf("evaluate expiry as postwave_app: %v", err)
	}
	var expiredPositiveVisible int
	if err := rlsTx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND consent_status = 'subscribed'`, tenantID, agingAddress.ID).Scan(
		&expiredPositiveVisible,
	); err != nil {
		_ = rlsTx.Rollback(ctx)
		t.Fatalf("read expired positive visibility: %v", err)
	}
	if err := rlsTx.Commit(ctx); err != nil {
		t.Fatalf("commit expiry RLS proof: %v", err)
	}
	if expiredPositiveVisible != 0 {
		t.Fatalf("expired positive exact-address rows visible to postwave_app = %d", expiredPositiveVisible)
	}

	// A hidden positive must still support a reviewed suppression-only repair.
	// The privileged setter is revision-checked and evidence-derived: unrelated
	// evidence cannot suppress it, an active hold cannot be cleared through the
	// projection, and the same revision has exactly one successful writer.
	hiddenResolveTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("hidden suppression resolver tx: %v", err)
	}
	if _, err := hiddenResolveTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = hiddenResolveTx.Rollback(ctx)
		t.Fatalf("set hidden suppression resolver role: %v", err)
	}
	hiddenResolved, err := scanMigration1766RepairRow(hiddenResolveTx.QueryRow(ctx, `
SELECT address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM subscriber_email_consent_lock_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid
  )`, tenantID, agingAddress.SubscriberID, agingAddress.ID))
	if err != nil {
		_ = hiddenResolveTx.Rollback(ctx)
		t.Fatalf("resolve hidden suppression row: %v", err)
	}
	if err := hiddenResolveTx.Commit(ctx); err != nil {
		t.Fatalf("commit hidden suppression resolver: %v", err)
	}
	if hiddenResolved.AddressID != agingAddress.ID ||
		hiddenResolved.StoredEmail != agingAddress.Email ||
		!hiddenResolved.IsPrimary ||
		hiddenResolved.ConsentStatus != "subscribed" ||
		hiddenResolved.Suppressed ||
		hiddenResolved.ReconciliationState != "proven" {
		t.Fatalf("hidden suppression resolver row = %+v", hiddenResolved)
	}

	notFoundTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("suppression setter not-found tx: %v", err)
	}
	if _, err := notFoundTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = notFoundTx.Rollback(ctx)
		t.Fatalf("set suppression setter not-found role: %v", err)
	}
	var wrongSubscriberOutcome, wrongAddressOutcome string
	if err := notFoundTx.QueryRow(ctx, `
SELECT outcome
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, true
  )`, tenantID, address.SubscriberID, agingAddress.ID,
		hiddenResolved.UpdatedAt).Scan(&wrongSubscriberOutcome); err != nil {
		_ = notFoundTx.Rollback(ctx)
		t.Fatalf("suppression setter wrong-subscriber outcome: %v", err)
	}
	if err := notFoundTx.QueryRow(ctx, `
SELECT outcome
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, true
  )`, tenantID, agingAddress.SubscriberID,
		"00000000-0000-4000-8000-000000001766",
		hiddenResolved.UpdatedAt).Scan(&wrongAddressOutcome); err != nil {
		_ = notFoundTx.Rollback(ctx)
		t.Fatalf("suppression setter wrong-address outcome: %v", err)
	}
	if err := notFoundTx.Commit(ctx); err != nil {
		t.Fatalf("commit suppression setter not-found contract: %v", err)
	}
	if wrongSubscriberOutcome != "not_found" || wrongAddressOutcome != "not_found" {
		t.Fatalf("suppression setter wrong identity outcomes = %q/%q",
			wrongSubscriberOutcome, wrongAddressOutcome)
	}

	noEvidenceTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("suppression setter no-evidence tx: %v", err)
	}
	if _, err := noEvidenceTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = noEvidenceTx.Rollback(ctx)
		t.Fatalf("set suppression setter no-evidence role: %v", err)
	}
	if _, err := noEvidenceTx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source)
VALUES ($1::uuid, $2, 'hard_bounce', 'test')`, tenantID,
		fmt.Sprintf("unrelated-suppression-%d@example.test", suffix)); err != nil {
		_ = noEvidenceTx.Rollback(ctx)
		t.Fatalf("insert unrelated suppression evidence: %v", err)
	}
	_, noEvidenceErr := noEvidenceTx.Exec(ctx, `
SELECT outcome
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, true
  )`, tenantID, agingAddress.SubscriberID, agingAddress.ID,
		hiddenResolved.UpdatedAt)
	_ = noEvidenceTx.Rollback(ctx)
	var noEvidencePgErr *pgconn.PgError
	if !errors.As(noEvidenceErr, &noEvidencePgErr) ||
		noEvidencePgErr.Code != "23514" ||
		noEvidencePgErr.ConstraintName != "subscriber_email_suppressed_requires_exact_evidence" {
		t.Fatalf("suppression setter without exact evidence error = %v", noEvidenceErr)
	}

	suppressTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("hidden suppression setter tx: %v", err)
	}
	if _, err := suppressTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = suppressTx.Rollback(ctx)
		t.Fatalf("set hidden suppression setter role: %v", err)
	}
	if _, err := suppressTx.Exec(ctx, `
INSERT INTO subscriber_suppressions (
    tenant_id, email, reason, source, metadata
) VALUES (
    $1::uuid, $2, 'list_manual', 'api',
    jsonb_build_object(
        'operation', 'multi_email_address_suppression',
        'subscriber_id', $3::text,
        'subscriber_email_id', $4::text,
        'reason', 'reviewed hidden suppression'
    )
)`, tenantID, agingAddress.Email, agingAddress.SubscriberID,
		agingAddress.ID); err != nil {
		_ = suppressTx.Rollback(ctx)
		t.Fatalf("append exact hidden suppression evidence: %v", err)
	}
	suppressedOutcome, suppressedRow, err :=
		scanMigration1766SuppressionRepairRow(suppressTx.QueryRow(ctx, `
SELECT outcome, address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, true
  )`, tenantID, agingAddress.SubscriberID, agingAddress.ID,
			hiddenResolved.UpdatedAt))
	if err != nil {
		_ = suppressTx.Rollback(ctx)
		t.Fatalf("set hidden exact suppression projection: %v", err)
	}
	if err := suppressTx.Commit(ctx); err != nil {
		t.Fatalf("commit hidden exact suppression projection: %v", err)
	}
	if suppressedOutcome != "updated" ||
		suppressedRow.AddressID != agingAddress.ID ||
		!suppressedRow.Suppressed ||
		!suppressedRow.UpdatedAt.After(hiddenResolved.UpdatedAt) {
		t.Fatalf("hidden exact suppression update = %q %+v",
			suppressedOutcome, suppressedRow)
	}

	staleTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("stale suppression setter tx: %v", err)
	}
	if _, err := staleTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = staleTx.Rollback(ctx)
		t.Fatalf("set stale suppression setter role: %v", err)
	}
	staleOutcome, staleRow, err :=
		scanMigration1766SuppressionRepairRow(staleTx.QueryRow(ctx, `
SELECT outcome, address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, true
  )`, tenantID, agingAddress.SubscriberID, agingAddress.ID,
			hiddenResolved.UpdatedAt))
	if err != nil {
		_ = staleTx.Rollback(ctx)
		t.Fatalf("read stale suppression setter outcome: %v", err)
	}
	if err := staleTx.Commit(ctx); err != nil {
		t.Fatalf("commit stale suppression setter outcome: %v", err)
	}
	if staleOutcome != "stale" || staleRow.AddressID != agingAddress.ID ||
		!staleRow.Suppressed ||
		!staleRow.UpdatedAt.Equal(suppressedRow.UpdatedAt) {
		t.Fatalf("stale suppression update = %q %+v", staleOutcome, staleRow)
	}

	protectedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("protected unsuppress tx: %v", err)
	}
	if _, err := protectedTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = protectedTx.Rollback(ctx)
		t.Fatalf("set protected unsuppress role: %v", err)
	}
	if _, err := protectedTx.Exec(ctx, `
DELETE FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
   AND source = 'api'
   AND metadata ->> 'operation' = 'multi_email_address_suppression'`,
		tenantID, agingAddress.Email); err != nil {
		_ = protectedTx.Rollback(ctx)
		t.Fatalf("remove reviewed suppression before protected hold: %v", err)
	}
	if _, err := protectedTx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source)
VALUES ($1::uuid, $2, 'hard_bounce', 'provider')`, tenantID,
		agingAddress.Email); err != nil {
		_ = protectedTx.Rollback(ctx)
		t.Fatalf("append protected exact suppression: %v", err)
	}
	_, protectedErr := protectedTx.Exec(ctx, `
SELECT outcome
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, false
  )`, tenantID, agingAddress.SubscriberID, agingAddress.ID,
		suppressedRow.UpdatedAt)
	_ = protectedTx.Rollback(ctx)
	var protectedPgErr *pgconn.PgError
	if !errors.As(protectedErr, &protectedPgErr) ||
		protectedPgErr.Code != "23514" ||
		protectedPgErr.ConstraintName != "subscriber_email_suppressed_requires_exact_evidence" {
		t.Fatalf("protected exact unsuppress error = %v", protectedErr)
	}

	unsuppressTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("reviewed unsuppress tx: %v", err)
	}
	if _, err := unsuppressTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = unsuppressTx.Rollback(ctx)
		t.Fatalf("set reviewed unsuppress role: %v", err)
	}
	if _, err := unsuppressTx.Exec(ctx, `
DELETE FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
   AND source = 'api'
   AND metadata ->> 'operation' = 'multi_email_address_suppression'`,
		tenantID, agingAddress.Email); err != nil {
		_ = unsuppressTx.Rollback(ctx)
		t.Fatalf("remove reviewed exact suppression evidence: %v", err)
	}
	unsuppressedOutcome, unsuppressedRow, err :=
		scanMigration1766SuppressionRepairRow(unsuppressTx.QueryRow(ctx, `
SELECT outcome, address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, false
  )`, tenantID, agingAddress.SubscriberID, agingAddress.ID,
			suppressedRow.UpdatedAt))
	if err != nil {
		_ = unsuppressTx.Rollback(ctx)
		t.Fatalf("clear hidden exact suppression projection: %v", err)
	}
	if err := unsuppressTx.Commit(ctx); err != nil {
		t.Fatalf("commit hidden exact unsuppression: %v", err)
	}
	if unsuppressedOutcome != "updated" ||
		unsuppressedRow.AddressID != agingAddress.ID ||
		unsuppressedRow.Suppressed ||
		!unsuppressedRow.UpdatedAt.After(suppressedRow.UpdatedAt) {
		t.Fatalf("hidden exact unsuppression = %q %+v",
			unsuppressedOutcome, unsuppressedRow)
	}

	repairTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("expired positive repair tx: %v", err)
	}
	if _, err := repairTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = repairTx.Rollback(ctx)
		t.Fatalf("set expired positive repair role: %v", err)
	}
	var repairRows int
	if err := repairTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_email_consent_lock_for_repair($1::uuid, $2::uuid, $3)`,
		tenantID, agingAddress.SubscriberID, agingAddress.Email).Scan(&repairRows); err != nil {
		_ = repairTx.Rollback(ctx)
		t.Fatalf("lock hidden expired positive for repair: %v", err)
	}
	if repairRows != 1 {
		t.Fatalf("hidden expired positive repair rows = %d, want 1", repairRows)
	}
	var expiryRevokeEventID string
	if err := repairTx.QueryRow(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'email_marketing',
    'revoked', 'direct_request', 'privacy-v2',
    '{"reason":"expired proof terminal revoke"}'::jsonb,
    'case:expired-hidden-revoke-1766', clock_timestamp()
)
RETURNING id::text`, tenantID, agingAddress.ID, agingAddress.Email).Scan(
		&expiryRevokeEventID,
	); err != nil {
		_ = repairTx.Rollback(ctx)
		t.Fatalf("append hidden expired revoke event: %v", err)
	}
	if _, err := repairTx.Exec(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'withdrawn', 'admin',
    clock_timestamp(), jsonb_build_object(
        'event_id', $4::text,
        'reason', 'expired proof terminal revoke',
        'policy_version', 'privacy-v2'
    )
)`, tenantID, agingAddress.SubscriberID, agingAddress.Email,
		expiryRevokeEventID); err != nil {
		_ = repairTx.Rollback(ctx)
		t.Fatalf("append hidden expired revoke record: %v", err)
	}
	if err := repairTx.Commit(ctx); err != nil {
		t.Fatalf("commit hidden expired positive revocation: %v", err)
	}
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, agingAddress,
	)
	if status != "unsubscribed" || classification != "failed_closed" {
		t.Fatalf("hidden expired revoke state = %q/%q", status, classification)
	}

	// The same resolver supports reviewed renewal without trusting the retained
	// materialized positive. The new exact pair must be later in both immutable
	// chronologies before the address becomes visible again.
	renewalAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("hidden-renewal-%d@example.test", suffix))
	renewalExpiry := time.Now().UTC().Add(450 * time.Millisecond)
	appendMigration1766ExactGrant(t, pool, tenantID, renewalAddress,
		now.Add(-time.Hour), renewalExpiry, "privacy-v2", "case:before-renewal-1766")
	if wait := time.Until(renewalExpiry.Add(150 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	renewalTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("hidden renewal tx: %v", err)
	}
	if _, err := renewalTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = renewalTx.Rollback(ctx)
		t.Fatalf("set hidden renewal role: %v", err)
	}
	if err := renewalTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_email_consent_lock_for_repair($1::uuid, $2::uuid, $3)`,
		tenantID, renewalAddress.SubscriberID, renewalAddress.Email).Scan(&repairRows); err != nil {
		_ = renewalTx.Rollback(ctx)
		t.Fatalf("resolve hidden renewal address: %v", err)
	}
	if repairRows != 1 {
		_ = renewalTx.Rollback(ctx)
		t.Fatalf("hidden renewal rows = %d, want 1", repairRows)
	}
	renewedAt := time.Now().UTC()
	renewPrefs, _ := json.Marshal(map[string]any{
		"subscriber_id":  renewalAddress.SubscriberID,
		"address_id":     renewalAddress.ID,
		"consent_status": "subscribed",
		"legal_basis":    "consent",
		"jurisdiction":   "IN",
		"reason":         "reviewed hidden renewal",
	})
	var renewalEventID string
	if err := renewalTx.QueryRow(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'email_marketing',
    'granted', 'direct_request', 'privacy-v2', $4::jsonb,
    'case:hidden-renewal-1766', $5
)
RETURNING id::text`, tenantID, renewalAddress.ID, renewalAddress.Email,
		string(renewPrefs), renewedAt).Scan(&renewalEventID); err != nil {
		_ = renewalTx.Rollback(ctx)
		t.Fatalf("append hidden renewal event: %v", err)
	}
	renewProof, _ := json.Marshal(map[string]any{
		"event_id":       renewalEventID,
		"address_id":     renewalAddress.ID,
		"legal_basis":    "consent",
		"jurisdiction":   "IN",
		"reason":         "reviewed hidden renewal",
		"policy_version": "privacy-v2",
		"evidence":       "case:hidden-renewal-1766",
	})
	if _, err := renewalTx.Exec(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, expires_at, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'granted', 'admin',
    $4::timestamptz, $4::timestamptz + interval '24 hours', $5::jsonb
)`, tenantID, renewalAddress.SubscriberID, renewalAddress.Email,
		renewedAt, string(renewProof)); err != nil {
		_ = renewalTx.Rollback(ctx)
		t.Fatalf("append hidden renewal record: %v", err)
	}
	if err := renewalTx.Commit(ctx); err != nil {
		t.Fatalf("commit hidden renewal: %v", err)
	}
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, renewalAddress,
	)
	if status != "subscribed" || classification != "proven" {
		t.Fatalf("hidden renewal state = %q/%q", status, classification)
	}

	// The source-specific jurisdiction path is accepted only when its event is
	// paired to the exact immutable legal receipt. It intentionally uses the
	// subscriber id event shape written by the existing reconfirmation flow,
	// proving that relational address binding does not depend on decorative
	// duplicate JSON identifiers.
	jurisdictionAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("jurisdiction-proof-%d@example.test", suffix))
	jurisdictionAt := now.Add(-30 * time.Minute)
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("jurisdiction proof tx: %v", err)
	}
	var jurisdictionReceiptID int64
	if err := tx.QueryRow(ctx, `
SELECT nextval(pg_get_serial_sequence('consent_receipts', 'id'))
`).Scan(&jurisdictionReceiptID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("reserve jurisdiction receipt id: %v", err)
	}
	jurisdictionPrefs, _ := json.Marshal(map[string]any{
		"regime":                  "gdpr",
		"decision":                "accepted",
		"detected_jurisdiction":   "DE",
		"jurisdiction_changed_at": jurisdictionAt.Add(-time.Hour).Format(time.RFC3339Nano),
		"operation":               "jurisdiction_reconfirmation",
		"consent_receipt_id":      jurisdictionReceiptID,
	})
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'email_marketing',
    'granted', 'jurisdiction_reconfirm', 'privacy-jurisdiction-v2',
    $4::jsonb, 'I agree to exact-address email marketing.', $5
)`, tenantID, jurisdictionAddress.SubscriberID, jurisdictionAddress.Email,
		string(jurisdictionPrefs), jurisdictionAt); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append jurisdiction event: %v", err)
	}
	// Deliberately append the receipt second.  The receipt-side refresh must
	// make an event-first atomic writer converge to the same final exact grant.
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_receipts (
    id, tenant_id, subscriber_id, subscriber_email, prev_state, new_state,
    source, source_detail, privacy_policy_version, captured_text, at
) VALUES (
    $1, $2::uuid, $3::uuid, $4, 'unsubscribed', 'subscribed',
    'jurisdiction_reconfirm',
    '{"regime":"gdpr","decision":"accepted"}',
    'privacy-jurisdiction-v2', 'I agree to exact-address email marketing.', $5
)`, jurisdictionReceiptID, tenantID, jurisdictionAddress.SubscriberID,
		jurisdictionAddress.Email, jurisdictionAt); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append jurisdiction receipt after event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit jurisdiction proof chain: %v", err)
	}
	status, classification, checksum, _, _ = readMigration1766AddressState(
		t, pool, tenantID, jurisdictionAddress,
	)
	if status != "subscribed" || classification != "proven" || len(checksum) != 64 {
		t.Fatalf("jurisdiction proof state = %q/%q checksum=%q", status, classification, checksum)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("jurisdiction immutability tx: %v", err)
	}
	_, immutableErr := tx.Exec(ctx, `
UPDATE consent_receipts SET captured_text = 'tampered'
 WHERE tenant_id = $1::uuid AND id = $2`, tenantID, jurisdictionReceiptID)
	_ = tx.Rollback(ctx)
	var immutablePgErr *pgconn.PgError
	if immutableErr == nil || (!strings.Contains(
		immutableErr.Error(), "receipt evidence is immutable",
	) && (!errors.As(immutableErr, &immutablePgErr) || immutablePgErr.Code != "42501")) {
		t.Fatalf("jurisdiction receipt mutation error = %v, want immutable rejection", immutableErr)
	}

	// A newer revoke remains terminal even when a valid grant is recorded later
	// with a backdated occurrence time.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("revoke tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'email_marketing',
    'revoked', 'direct_request', 'privacy-v2',
    '{"reason":"terminal revoke"}', 'case:revoke-1766', $4
)`, tenantID, address.ID, address.Email, now); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append revoke: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit revoke: %v", err)
	}
	appendMigration1766ExactGrant(t, pool, tenantID, address,
		now.Add(-24*time.Hour), now.Add(24*time.Hour), "privacy-v3", "case:backdated-1766")
	status, classification, _, terminalOccurred, _ := readMigration1766AddressState(
		t, pool, tenantID, address,
	)
	if status != "unsubscribed" || classification != "failed_closed" ||
		terminalOccurred == nil || terminalOccurred.Before(now.Add(-time.Second)) {
		t.Fatalf("post-backdated terminal = %q/%q at %v, want newer revoke", status, classification, terminalOccurred)
	}

	// A late-arriving opt-out is fail-closed even when its asserted occurrence
	// is backdated.  A later grant restores eligibility only when it is later in
	// both immutable recording chronology and asserted occurrence chronology.
	backdatedRevokeAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("backdated-revoke-%d@example.test", suffix))
	appendMigration1766ExactGrant(t, pool, tenantID, backdatedRevokeAddress,
		now.Add(-time.Hour), now.Add(24*time.Hour), "privacy-v2", "case:before-backdated-revoke-1766")
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("backdated revoke tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'email_marketing',
    'revoked', 'direct_request', 'privacy-v2',
    '{"reason":"late received opt-out"}', 'case:backdated-revoke-1766', $4
)`, tenantID, backdatedRevokeAddress.ID, backdatedRevokeAddress.Email,
		now.Add(-24*time.Hour)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append backdated revoke: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit backdated revoke: %v", err)
	}
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, backdatedRevokeAddress,
	)
	if status != "unsubscribed" || classification != "failed_closed" {
		t.Fatalf("backdated revoke terminal = %q/%q, want fail-closed", status, classification)
	}
	regrantAt := time.Now().UTC()
	appendMigration1766ExactGrant(t, pool, tenantID, backdatedRevokeAddress,
		regrantAt, regrantAt.Add(24*time.Hour), "privacy-v3", "case:after-backdated-revoke-1766")
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, backdatedRevokeAddress,
	)
	if status != "subscribed" || classification != "proven" {
		t.Fatalf("genuinely later regrant terminal = %q/%q", status, classification)
	}

	// Legacy `marketing` events are still emitted by retained writers.  Grants
	// in that category remain invalid, but terminal non-grants must be folded so
	// a legacy revoke cannot leave an older exact grant sendable.
	legacyCategoryAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("legacy-category-%d@example.test", suffix))
	appendMigration1766ExactGrant(t, pool, tenantID, legacyCategoryAddress,
		now.Add(-time.Hour), now.Add(24*time.Hour), "privacy-v2", "case:legacy-category-1766")
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("legacy marketing revoke tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'marketing',
    'revoked', 'direct_request', 'privacy-v2',
    '{"reason":"legacy category opt-out"}', 'case:legacy-marketing-revoke-1766', $4
)`, tenantID, legacyCategoryAddress.ID, legacyCategoryAddress.Email,
		time.Now().UTC()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append legacy marketing revoke: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy marketing revoke: %v", err)
	}
	status, classification, _, _, _ = readMigration1766AddressState(
		t, pool, tenantID, legacyCategoryAddress,
	)
	if status != "unsubscribed" || classification != "failed_closed" {
		t.Fatalf("legacy marketing revoke terminal = %q/%q, want fail-closed", status, classification)
	}

	var generationBefore int64
	var etagBefore string
	scanMigration1766TenantRow(t, ctx, pool, tenantID, `
SELECT generation, etag
  FROM subscriber_email_consent_address_state
 WHERE tenant_id = $1::uuid AND normalized_email = lower($2)`,
		[]any{tenantID, address.Email}, &generationBefore, &etagBefore)
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("suppression tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, reason)
VALUES ($1::uuid, $2, 'manual_unsubscribe')`, tenantID, address.Email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert suppression: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit suppression: %v", err)
	}
	var generationAfter int64
	var etagAfter string
	scanMigration1766TenantRow(t, ctx, pool, tenantID, `
SELECT generation, etag
  FROM subscriber_email_consent_address_state
 WHERE tenant_id = $1::uuid AND normalized_email = lower($2)`,
		[]any{tenantID, address.Email}, &generationAfter, &etagAfter)
	if generationAfter <= generationBefore || etagAfter == etagBefore {
		t.Fatalf("suppression generation/etag = %d/%q after %d/%q", generationAfter, etagAfter, generationBefore, etagBefore)
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("sync ledger tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_sync_ledger (
    tenant_id, subscriber_id, event_type, destination_id
) VALUES ($1::uuid, $2::uuid, 'consent_revoked', $3)`,
		tenantID, address.SubscriberID, fmt.Sprintf("crm-%d", suffix)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert external sync decision: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit external sync decision: %v", err)
	}
	var generationLedger int64
	scanMigration1766TenantRow(t, ctx, pool, tenantID, `
SELECT generation
  FROM subscriber_email_consent_address_state
 WHERE tenant_id = $1::uuid AND normalized_email = lower($2)`,
		[]any{tenantID, address.Email}, &generationLedger)
	if generationLedger <= generationAfter {
		t.Fatalf("external ledger generation = %d, want > %d", generationLedger, generationAfter)
	}

	// Hold the exact-address mutex in one transaction. A competing suppression
	// writer must fail with bounded lock_not_available, never hang or deadlock.
	lockAddress := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("lock-race-%d@example.test", suffix))
	tx1, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("lock holder tx: %v", err)
	}
	if _, err := tx1.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = tx1.Rollback(ctx)
		t.Fatalf("set exact-address lock holder role: %v", err)
	}
	lockResolved, err := scanMigration1766RepairRow(tx1.QueryRow(ctx, `
SELECT address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM subscriber_email_consent_lock_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid
  )`, tenantID, lockAddress.SubscriberID, lockAddress.ID))
	if err != nil {
		_ = tx1.Rollback(ctx)
		t.Fatalf("hold exact-address mutex: %v", err)
	}
	if lockResolved.AddressID != lockAddress.ID {
		_ = tx1.Rollback(ctx)
		t.Fatalf("exact-address lock holder row = %+v", lockResolved)
	}
	tx2, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		_ = tx1.Rollback(ctx)
		t.Fatalf("contending suppression setter tx: %v", err)
	}
	if _, err := tx2.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = tx2.Rollback(ctx)
		_ = tx1.Rollback(ctx)
		t.Fatalf("set contending suppression setter role: %v", err)
	}
	started := time.Now()
	_, setterLockErr := tx2.Exec(ctx, `
SELECT outcome
  FROM subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4, true
  )`, tenantID, lockAddress.SubscriberID, lockAddress.ID,
		lockResolved.UpdatedAt)
	setterElapsed := time.Since(started)
	_ = tx2.Rollback(ctx)
	var setterLockPgErr *pgconn.PgError
	if !errors.As(setterLockErr, &setterLockPgErr) ||
		setterLockPgErr.Code != "55P03" {
		_ = tx1.Rollback(ctx)
		t.Fatalf("contending suppression setter error = %v, want SQLSTATE 55P03",
			setterLockErr)
	}
	if setterElapsed > 2*time.Second {
		_ = tx1.Rollback(ctx)
		t.Fatalf("bounded suppression setter lock took %v", setterElapsed)
	}

	tx2, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		_ = tx1.Rollback(ctx)
		t.Fatalf("contending suppression evidence tx: %v", err)
	}
	started = time.Now()
	_, lockErr := tx2.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason)
VALUES ($1::uuid, $2, 'manual')`, tenantID, lockAddress.Email)
	elapsed := time.Since(started)
	_ = tx2.Rollback(ctx)
	_ = tx1.Rollback(ctx)
	var pgErr *pgconn.PgError
	if !errors.As(lockErr, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("contending writer error = %v, want SQLSTATE 55P03", lockErr)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("bounded exact-address lock took %v", elapsed)
	}
}

func migration1766AdminPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("admin database URL is required for reconciliation fixture")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	t.Cleanup(pool.Close)
	var superuser bool
	if err := pool.QueryRow(context.Background(), `
SELECT rolsuper FROM pg_roles WHERE rolname = current_user
`).Scan(&superuser); err != nil {
		t.Fatalf("inspect admin role: %v", err)
	}
	if !superuser {
		t.Skip("superuser database URL is required for grandfathered-row fixture")
	}
	return pool
}

func TestMigration1766GrandfatheredReconciliationLive(t *testing.T) {
	// A reconciliation run over pending rows blocks the deployment-wide
	// gate until its last batch, and it reclassifies expired positives in
	// every tenant. It therefore runs only in the isolated database.
	pool := isolatedReleaseGateDatabase(t).superuserPool(t)
	requireMigration1766(t, pool)
	const tenantID = "00000000-0000-4000-8000-0099a2c42766"
	seedPrimaryEmailTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	first := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("grandfather-a-%d@example.test", suffix))
	second := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("grandfather-b-%d@example.test", suffix))
	proven := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("gate-proven-%d@example.test", suffix))
	blockedRevocable := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("gate-blocked-revoke-%d@example.test", suffix))
	now := time.Now().UTC()
	appendMigration1766ExactGrant(t, pool, tenantID, proven,
		now.Add(-time.Hour), now.Add(24*time.Hour), "privacy-v2", "case:gate-1766")
	appendMigration1766ExactGrant(t, pool, tenantID, blockedRevocable,
		now.Add(-time.Hour), now.Add(24*time.Hour), "privacy-v2", "case:blocked-revoke-1766")
	if visible := migration1766AppVisiblePositiveCount(
		t, pool, tenantID, []string{proven.ID},
	); visible != 1 {
		t.Fatalf("proven positive visibility under open gate = %d, want 1", visible)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	fixtureTx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin grandfather fixture: %v", err)
	}
	if _, err := fixtureTx.Exec(ctx, `SET LOCAL session_replication_role = 'replica'`); err != nil {
		_ = fixtureTx.Rollback(ctx)
		t.Fatalf("disable triggers for legacy fixture: %v", err)
	}
	if _, err := fixtureTx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = 'subscribed',
       consent_reconciliation_state = 'pending',
       consent_decision_checksum = NULL,
       consent_classified_at = NULL
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
		tenantID, []string{first.ID, second.ID}); err != nil {
		_ = fixtureTx.Rollback(ctx)
		t.Fatalf("seed grandfathered addresses: %v", err)
	}
	if _, err := fixtureTx.Exec(ctx, `
UPDATE subscribers SET consent_email_marketing_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
		tenantID, []string{first.SubscriberID, second.SubscriberID}); err != nil {
		_ = fixtureTx.Rollback(ctx)
		t.Fatalf("seed raw purpose projections: %v", err)
	}
	if err := fixtureTx.Commit(ctx); err != nil {
		t.Fatalf("commit grandfather fixture: %v", err)
	}

	var gateStatus string
	if err := pool.QueryRow(ctx, `
SELECT status FROM subscriber_email_consent_release_gate WHERE singleton
`).Scan(&gateStatus); err != nil {
		t.Fatalf("read pre-rerun gate: %v", err)
	}
	if gateStatus != "open" {
		t.Fatalf("pre-rerun gate = %q, want open", gateStatus)
	}
	if visible := migration1766AppVisiblePositiveCount(
		t, pool, tenantID, []string{first.ID, second.ID},
	); visible != 0 {
		t.Fatalf("pending grandfathered positives visible under open gate = %d", visible)
	}
	var runID string
	if err := pool.QueryRow(ctx, `
SELECT start_subscriber_email_consent_reconciliation(1)::text
	`).Scan(&runID); err != nil {
		t.Fatalf("start reconciliation: %v", err)
	}
	if visible := migration1766AppVisiblePositiveCount(
		t, pool, tenantID, []string{proven.ID},
	); visible != 0 {
		t.Fatalf("proven positive visibility under blocked gate = %d, want 0", visible)
	}

	// The deferred canonical identity trigger must see the already-existing
	// positive through its exact definer boundary. The old invoker trigger saw
	// no app-visible row here and attempted a duplicate address at COMMIT.
	hiddenIdentityTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("gate-hidden canonical identity tx: %v", err)
	}
	if _, err := hiddenIdentityTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = hiddenIdentityTx.Rollback(ctx)
		t.Fatalf("set gate-hidden canonical identity role: %v", err)
	}
	if _, err := hiddenIdentityTx.Exec(ctx, `
UPDATE subscribers
   SET email = email
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID,
		blockedRevocable.SubscriberID); err != nil {
		_ = hiddenIdentityTx.Rollback(ctx)
		t.Fatalf("stage gate-hidden canonical identity reconciliation: %v", err)
	}
	if err := hiddenIdentityTx.Commit(ctx); err != nil {
		t.Fatalf("commit gate-hidden canonical identity reconciliation: %v", err)
	}
	var exactAddressRows, primaryAddressRows int
	if err := pool.QueryRow(ctx, `
SELECT count(*), count(*) FILTER (WHERE is_primary)
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND subscriber_email_consent_normalize_email(email::text) =
       subscriber_email_consent_normalize_email($3)`, tenantID,
		blockedRevocable.SubscriberID, blockedRevocable.Email).Scan(
		&exactAddressRows, &primaryAddressRows,
	); err != nil {
		t.Fatalf("inspect gate-hidden canonical identity rows: %v", err)
	}
	if exactAddressRows != 1 || primaryAddressRows != 1 {
		t.Fatalf("gate-hidden canonical identity rows total=%d primary=%d, want 1/1",
			exactAddressRows, primaryAddressRows)
	}

	// Revocation remains available while the global initial-classification gate
	// is blocked. The app role resolves the otherwise hidden address through the
	// narrow exact-address helper, retains that transaction-scoped mutex, and
	// appends its immutable terminal evidence.
	blockedRevokeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("blocked-gate revoke tx: %v", err)
	}
	if _, err := blockedRevokeTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		_ = blockedRevokeTx.Rollback(ctx)
		t.Fatalf("set blocked-gate revoke role: %v", err)
	}
	var blockedRepairRows int
	if err := blockedRevokeTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_email_consent_lock_for_repair($1::uuid, $2::uuid, $3)`,
		tenantID, blockedRevocable.SubscriberID, blockedRevocable.Email).Scan(
		&blockedRepairRows,
	); err != nil {
		_ = blockedRevokeTx.Rollback(ctx)
		t.Fatalf("resolve blocked-gate revoke address: %v", err)
	}
	if blockedRepairRows != 1 {
		_ = blockedRevokeTx.Rollback(ctx)
		t.Fatalf("blocked-gate revoke rows = %d, want 1", blockedRepairRows)
	}
	var blockedRevokeEventID string
	if err := blockedRevokeTx.QueryRow(ctx, `
INSERT INTO consent_events (
    tenant_id, subject_type, subject_id, subject_email, channel, category,
    action, source, policy_version, preferences, proof_text, created_at
) VALUES (
    $1::uuid, 'subscriber', $2, $3, 'api', 'email_marketing',
    'revoked', 'direct_request', 'privacy-v2',
    '{"reason":"revoke while reconciliation is blocked"}'::jsonb,
    'case:gate-blocked-revoke-1766', clock_timestamp()
)
RETURNING id::text`, tenantID, blockedRevocable.ID,
		blockedRevocable.Email).Scan(&blockedRevokeEventID); err != nil {
		_ = blockedRevokeTx.Rollback(ctx)
		t.Fatalf("append blocked-gate revoke event: %v", err)
	}
	if _, err := blockedRevokeTx.Exec(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'withdrawn', 'admin',
    clock_timestamp(), jsonb_build_object(
        'event_id', $4::text,
        'reason', 'revoke while reconciliation is blocked',
        'policy_version', 'privacy-v2'
    )
)`, tenantID, blockedRevocable.SubscriberID, blockedRevocable.Email,
		blockedRevokeEventID); err != nil {
		_ = blockedRevokeTx.Rollback(ctx)
		t.Fatalf("append blocked-gate revoke record: %v", err)
	}
	if err := blockedRevokeTx.Commit(ctx); err != nil {
		t.Fatalf("commit blocked-gate revoke: %v", err)
	}
	blockedStatus, blockedClassification, _, _, _ :=
		readMigration1766AddressState(t, pool, tenantID, blockedRevocable)
	if blockedStatus != "unsubscribed" || blockedClassification != "failed_closed" {
		t.Fatalf("blocked-gate revoke state = %q/%q",
			blockedStatus, blockedClassification)
	}
	var firstProgressRaw []byte
	if err := pool.QueryRow(ctx, `
SELECT reconcile_subscriber_email_consent_batch($1::uuid, 1)`, runID).Scan(&firstProgressRaw); err != nil {
		t.Fatalf("first bounded batch: %v", err)
	}
	var firstProgress map[string]any
	if err := json.Unmarshal(firstProgressRaw, &firstProgress); err != nil {
		t.Fatalf("decode first progress: %v", err)
	}
	if complete, _ := firstProgress["complete"].(bool); complete {
		t.Fatalf("one-row batch completed two-row fixture: %s", firstProgressRaw)
	}
	if err := pool.QueryRow(ctx, `
SELECT status FROM subscriber_email_consent_release_gate WHERE singleton
`).Scan(&gateStatus); err != nil {
		t.Fatalf("read blocked gate: %v", err)
	}
	if gateStatus != "blocked" {
		t.Fatalf("gate after partial batch = %q, want blocked", gateStatus)
	}

	// Other cases in the same live database may have allowed a previously valid
	// proof to age out. Expired positives are deliberately reconciliation work,
	// so resume one committed row at a time until the global gate is exact.
	complete := false
	var resumedProgressRaw []byte
	for attempt := 0; attempt < 64 && !complete; attempt++ {
		if err := pool.QueryRow(ctx, `
SELECT reconcile_subscriber_email_consent_batch($1::uuid, 1)`, runID).Scan(&resumedProgressRaw); err != nil {
			t.Fatalf("resumable batch %d: %v", attempt+2, err)
		}
		var resumedProgress map[string]any
		if err := json.Unmarshal(resumedProgressRaw, &resumedProgress); err != nil {
			t.Fatalf("decode resumed progress: %v", err)
		}
		complete, _ = resumedProgress["complete"].(bool)
	}
	if !complete {
		t.Fatalf("resumable batches did not complete fixture: %s", resumedProgressRaw)
	}

	var pending, unsafe, unclearedPurpose int
	var checksum string
	if err := pool.QueryRow(ctx, `
SELECT gate.status,
       gate.postcheck_checksum,
       (SELECT count(*) FROM subscriber_emails WHERE consent_reconciliation_state = 'pending'),
       (SELECT count(*) FROM subscriber_emails
         WHERE consent_status = 'subscribed'
           AND consent_reconciliation_state <> 'proven'),
       (SELECT count(*) FROM subscribers
         WHERE tenant_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND consent_email_marketing_at IS NOT NULL)
  FROM subscriber_email_consent_release_gate AS gate
 WHERE gate.singleton`, tenantID, []string{first.SubscriberID, second.SubscriberID}).Scan(
		&gateStatus, &checksum, &pending, &unsafe, &unclearedPurpose,
	); err != nil {
		t.Fatalf("read reconciliation postcheck: %v", err)
	}
	if gateStatus != "open" || len(checksum) != 64 || pending != 0 || unsafe != 0 || unclearedPurpose != 0 {
		t.Fatalf("reconciliation gate=%q checksum=%q pending=%d unsafe=%d purpose=%d",
			gateStatus, checksum, pending, unsafe, unclearedPurpose)
	}
	if visible := migration1766AppVisiblePositiveCount(
		t, pool, tenantID, []string{proven.ID},
	); visible != 1 {
		t.Fatalf("proven positive visibility after gate reopen = %d, want 1", visible)
	}
	for _, address := range []migration1766Address{first, second} {
		status, classification, decisionChecksum, _, _ := readMigration1766AddressState(
			t, pool, tenantID, address,
		)
		if status != "never_subscribed" || classification != "failed_closed" || len(decisionChecksum) != 64 {
			t.Errorf("reconciled %s = %q/%q checksum=%q", address.Email, status, classification, decisionChecksum)
		}
	}

	// A periodic expiry-only pass must leave the already checksummed gate open.
	// The restrictive policy withholds only the expired exact address while
	// unrelated proven addresses remain visible throughout maintenance.
	periodic := createMigration1766Subscriber(t, pool, tenantID,
		fmt.Sprintf("periodic-expiry-%d@example.test", suffix))
	periodicExpiry := time.Now().UTC().Add(600 * time.Millisecond)
	appendMigration1766ExactGrant(t, pool, tenantID, periodic,
		time.Now().UTC().Add(-time.Hour), periodicExpiry,
		"privacy-v2", "case:periodic-expiry-1766")
	if wait := time.Until(periodicExpiry.Add(150 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	var periodicRunID string
	if err := pool.QueryRow(ctx, `
SELECT start_subscriber_email_consent_reconciliation(1)::text
	`).Scan(&periodicRunID); err != nil {
		t.Fatalf("start expiry-only reconciliation: %v", err)
	}
	if err := pool.QueryRow(ctx, `
SELECT status FROM subscriber_email_consent_release_gate WHERE singleton
`).Scan(&gateStatus); err != nil {
		t.Fatalf("read expiry-only gate: %v", err)
	}
	if gateStatus != "open" {
		t.Fatalf("expiry-only reconciliation gate = %q, want open", gateStatus)
	}
	if visible := migration1766AppVisiblePositiveCount(
		t, pool, tenantID, []string{proven.ID},
	); visible != 1 {
		t.Fatalf("unrelated proven visibility during expiry maintenance = %d, want 1", visible)
	}
	periodicComplete := false
	for attempt := 0; attempt < 16 && !periodicComplete; attempt++ {
		var progressRaw []byte
		if err := pool.QueryRow(ctx, `
SELECT reconcile_subscriber_email_consent_batch($1::uuid, 1)`, periodicRunID).Scan(&progressRaw); err != nil {
			t.Fatalf("expiry-only batch %d: %v", attempt+1, err)
		}
		var progress map[string]any
		if err := json.Unmarshal(progressRaw, &progress); err != nil {
			t.Fatalf("decode expiry-only progress: %v", err)
		}
		periodicComplete, _ = progress["complete"].(bool)
	}
	if !periodicComplete {
		t.Fatal("expiry-only reconciliation did not complete")
	}
	status, classification, _, _, _ := readMigration1766AddressState(
		t, pool, tenantID, periodic,
	)
	if status == "subscribed" || classification != "failed_closed" {
		t.Fatalf("periodic expired state = %q/%q, want failed closed", status, classification)
	}

	// A zero-work heartbeat also preserves the open gate and completes in one
	// bounded call, rather than causing a fleet-wide visibility transition.
	var noWorkRunID string
	if err := pool.QueryRow(ctx, `
SELECT start_subscriber_email_consent_reconciliation(1)::text
	`).Scan(&noWorkRunID); err != nil {
		t.Fatalf("start zero-work reconciliation: %v", err)
	}
	if err := pool.QueryRow(ctx, `
SELECT status FROM subscriber_email_consent_release_gate WHERE singleton
`).Scan(&gateStatus); err != nil {
		t.Fatalf("read zero-work gate: %v", err)
	}
	if gateStatus != "open" {
		t.Fatalf("zero-work reconciliation gate = %q, want open", gateStatus)
	}
	var noWorkRaw []byte
	if err := pool.QueryRow(ctx, `
SELECT reconcile_subscriber_email_consent_batch($1::uuid, 1)`, noWorkRunID).Scan(&noWorkRaw); err != nil {
		t.Fatalf("zero-work batch: %v", err)
	}
	var noWork map[string]any
	if err := json.Unmarshal(noWorkRaw, &noWork); err != nil {
		t.Fatalf("decode zero-work progress: %v", err)
	}
	if complete, _ := noWork["complete"].(bool); !complete {
		t.Fatalf("zero-work reconciliation incomplete: %s", noWorkRaw)
	}
}
