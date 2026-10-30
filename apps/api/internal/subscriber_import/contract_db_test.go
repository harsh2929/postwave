// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"

	migratecsv "github.com/postwave/migrate/csv"
)

func subscriberImportDBPools(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("DATABASE_URL and POSTWAVE_TEST_ADMIN_DATABASE_URL are required for subscriber-import DB contracts")
	}
	ctx := context.Background()
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		app.Close()
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	t.Cleanup(admin.Close)
	return app, admin
}

func seedImportTenant(t *testing.T, admin *pgxpool.Pool) string {
	t.Helper()
	id := uuid.NewString()
	slug := "import-test-" + strings.ReplaceAll(id, "-", "")
	if _, err := admin.Exec(context.Background(), `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $2, 'studio')`, id, slug); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, id)
	})
	return id
}

func importMapping() migratecsv.Mapping {
	return migratecsv.Mapping{
		Headers: []string{"email", "name"},
		Columns: []migratecsv.ColumnMapping{
			{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
			{Index: 1, Name: "name", Kind: migratecsv.KindName},
		},
		Rows: 2,
	}
}

func insertBasicPreview(t *testing.T, admin *pgxpool.Pool, tenantID string, revision int64) string {
	t.Helper()
	id := uuid.NewString()
	raw, _ := json.Marshal(importMapping())
	if _, err := admin.Exec(context.Background(), `
INSERT INTO subscriber_imports (
	id, tenant_id, object_key, original_filename, mapping, rows_total,
	configuration_revision
) VALUES ($1::uuid, $2::uuid, $3, 'contacts.csv', $4::jsonb, 2, $5)`,
		id, tenantID, "imports/"+id+".csv", raw, revision); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPatchRevisionETagAndMergedScheduleDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID := insertBasicPreview(t, admin, tenantID, 1)
	d := &Deps{Pool: app}
	router := chi.NewRouter()
	router.Patch("/api/v1/subscriber-imports/{id}", d.Patch)

	request := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/subscriber-imports/"+importID, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if rec := request(`{"tags":["reviewed"]}`); rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing revision status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request(`{"configuration_revision":0,"tags":["reviewed"]}`); rec.Code != http.StatusConflict {
		t.Fatalf("stale revision status=%d body=%s", rec.Code, rec.Body.String())
	}
	future := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	if rec := request(`{"configuration_revision":1,"scheduled_at":` + strconvQuote(future) + `}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unmerged scheduled_at status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec := request(`{"configuration_revision":1,"tags":["reviewed"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid CAS status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("ETag"); got != `W/"subscriber-import-revision-2"` {
		t.Fatalf("ETag=%q", got)
	}
	var response map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["configuration_revision"] != float64(2) {
		t.Fatalf("response=%v", response)
	}
	rec = request(`{"configuration_revision":2,"tags":["reviewed"]}`)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `W/"subscriber-import-revision-2"` {
		t.Fatalf("semantic no-op status=%d etag=%q body=%s", rec.Code, rec.Header().Get("ETag"), rec.Body.String())
	}
	response = map[string]any{}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["updated"] != false || response["configuration_revision"] != float64(2) {
		t.Fatalf("semantic no-op response=%v", response)
	}
	if _, exists := response["preflight_required"]; exists {
		t.Fatalf("semantic no-op falsely invalidated preflight: %v", response)
	}
	if rec := request(`{"configuration_revision":1,"tags":["stale"]}`); rec.Code != http.StatusConflict {
		t.Fatalf("second stale writer status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestQueuedCancelIsAtomicDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID := insertBasicPreview(t, admin, tenantID, 0)
	if _, err := admin.Exec(context.Background(), `UPDATE subscriber_imports
		SET status='queued',source_delete_after=NULL,completed_at=NULL,cancel_requested=false
		WHERE id=$1::uuid`, importID); err != nil {
		t.Fatal(err)
	}
	d := &Deps{Pool: app}
	router := chi.NewRouter()
	router.Post("/api/v1/subscriber-imports/{id}/cancel", d.Cancel)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscriber-imports/"+importID+"/cancel", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("cancel status=%d body=%s", rec.Code, rec.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response) != 3 || response["id"] != importID || response["status"] != "cancelled" || response["cancel_requested"] != true {
		t.Fatalf("cancel response=%v", response)
	}
	var status string
	var cancelRequested bool
	var completedAt, sourceDeleteAfter *time.Time
	if err := admin.QueryRow(context.Background(), `SELECT status,cancel_requested,completed_at,source_delete_after
		FROM subscriber_imports WHERE id=$1::uuid`, importID).
		Scan(&status, &cancelRequested, &completedAt, &sourceDeleteAfter); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" || !cancelRequested || completedAt == nil || sourceDeleteAfter == nil {
		t.Fatalf("atomic cancel state status=%q requested=%v completed=%v purge=%v", status, cancelRequested, completedAt, sourceDeleteAfter)
	}
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req.Clone(req.Context()))
	if rec.Code != http.StatusConflict {
		t.Fatalf("terminal recancel status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestVerificationTransitionGuardFencesOldAndStaleAPIsDB(t *testing.T) {
	_, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID := insertBasicPreview(t, admin, tenantID, 0)
	if _, err := admin.Exec(context.Background(), `INSERT INTO verification_policy (tenant_id,import_mode)
		VALUES ($1::uuid,'full') ON CONFLICT (tenant_id) DO UPDATE SET import_mode='full'`, tenantID); err != nil {
		t.Fatal(err)
	}
	assertSerializationFailure := func(query string, args ...any) {
		t.Helper()
		_, err := admin.Exec(context.Background(), query, args...)
		var pgErr *pgconn.PgError
		if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "40001" {
			t.Fatalf("transition error=%v, want SQLSTATE 40001", err)
		}
	}
	// A pre-1956 API writes queued and leaves verification_mode at its default
	// off. The trigger must reject the transition while policy is configured.
	assertSerializationFailure(`UPDATE subscriber_imports SET status='queued' WHERE id=$1::uuid`, importID)
	// A current-but-stale replica that froze local while policy is full is also
	// rejected inside the same DB transition, closing the policy TOCTOU window.
	assertSerializationFailure(`UPDATE subscriber_imports
		SET status='verification_queued',verification_mode='local',verification_state='pending'
		WHERE id=$1::uuid`, importID)
	if _, err := admin.Exec(context.Background(), `UPDATE subscriber_imports
		SET status='verification_queued',verification_mode='full',verification_state='pending'
		WHERE id=$1::uuid`, importID); err != nil {
		t.Fatalf("matching guarded transition: %v", err)
	}
}

func TestMissingExecutionAdapterCannotEraseConfiguredPolicyDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	if _, err := admin.Exec(context.Background(), `INSERT INTO verification_policy (tenant_id,import_mode)
		VALUES ($1::uuid,'local')`, tenantID); err != nil {
		t.Fatal(err)
	}
	mode, err := (&Deps{Pool: app}).currentImportVerificationMode(context.Background(), tenantID)
	if err != nil || mode != ImportVerificationModeLocal {
		t.Fatalf("missing-adapter policy mode=%q err=%v", mode, err)
	}
}

func TestQueuedCancelRollsBackUntilLinkedVerificationCancelsDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID := insertBasicPreview(t, admin, tenantID, 0)
	verificationJobID := uuid.NewString()
	if _, err := admin.Exec(context.Background(), `INSERT INTO verification_policy (tenant_id,import_mode)
		VALUES ($1::uuid,'full') ON CONFLICT (tenant_id) DO UPDATE SET import_mode='full'`, tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `
INSERT INTO verification_jobs
 (id,tenant_id,status,source,source_ref,total,execution_mode,idempotency_key,request_fingerprint)
VALUES ($1::uuid,$2::uuid,'pending','upload',$3,1,'full',$4,$5)`,
		verificationJobID, tenantID, importID, "subscriber-import:"+importID+":verification:v1",
		strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `UPDATE subscriber_imports
		SET status='verification_queued',source_delete_after=NULL,completed_at=NULL,cancel_requested=false,
		    verification_mode='full',verification_state='pending',verification_job_id=$2::uuid
		WHERE id=$1::uuid`, importID, verificationJobID); err != nil {
		t.Fatal(err)
	}
	stub := &importVerificationStateStub{cancelErr: errors.New("temporary cancellation outage")}
	d := &Deps{Pool: app, ExecutionVerification: stub}
	router := chi.NewRouter()
	router.Post("/api/v1/subscriber-imports/{id}/cancel", d.Cancel)
	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/subscriber-imports/"+importID+"/cancel", nil)
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if rec := request(); rec.Code != http.StatusInternalServerError {
		t.Fatalf("failed linked cancel status=%d body=%s", rec.Code, rec.Body.String())
	}
	var status string
	var cancelRequested bool
	if err := admin.QueryRow(context.Background(), `SELECT status,cancel_requested
		FROM subscriber_imports WHERE id=$1::uuid`, importID).Scan(&status, &cancelRequested); err != nil {
		t.Fatal(err)
	}
	if status != importStatusVerificationQueued || cancelRequested || len(stub.cancelled) != 1 || stub.cancelled[0] != verificationJobID {
		t.Fatalf("failed cancellation leaked terminal state status=%q requested=%v calls=%v",
			status, cancelRequested, stub.cancelled)
	}

	stub.cancelErr = nil
	if rec := request(); rec.Code != http.StatusAccepted {
		t.Fatalf("successful linked cancel status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := admin.QueryRow(context.Background(), `SELECT status,cancel_requested
		FROM subscriber_imports WHERE id=$1::uuid`, importID).Scan(&status, &cancelRequested); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" || !cancelRequested || len(stub.cancelled) != 2 {
		t.Fatalf("successful cancellation state status=%q requested=%v calls=%v",
			status, cancelRequested, stub.cancelled)
	}
}

func TestWorkerDefersTerminalImportUntilLinkedVerificationCancellationDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID := insertBasicPreview(t, admin, tenantID, 0)
	verificationJobID := uuid.NewString()
	if _, err := admin.Exec(context.Background(), `
INSERT INTO verification_jobs
 (id,tenant_id,status,source,source_ref,total,execution_mode,idempotency_key,request_fingerprint)
VALUES ($1::uuid,$2::uuid,'failed','upload',$3,1,'full',$4,$5)`,
		verificationJobID, tenantID, importID, "subscriber-import:"+importID+":verification:v1",
		strings.Repeat("c", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `UPDATE subscriber_imports
		SET status='verification_running',claim_generation=1,source_delete_after=NULL,completed_at=NULL,
		    verification_mode='full',verification_state='failed',verification_job_id=$2::uuid,
		    verification_completed_at=now()
		WHERE id=$1::uuid`, importID, verificationJobID); err != nil {
		t.Fatal(err)
	}
	stub := &importVerificationStateStub{cancelErr: errors.New("temporary cancellation outage")}
	worker := &Worker{Pool: app, Verification: stub}
	job := &claimedJob{
		ID: importID, TenantID: tenantID, ClaimGeneration: 1,
		VerificationMode: ImportVerificationModeFull, VerificationState: ImportVerificationStateFailed,
		VerificationJobID: verificationJobID,
	}
	if err := worker.markCancelled(context.Background(), job); err == nil {
		t.Fatal("markCancelled succeeded while linked verification cancellation failed")
	}
	var status, state string
	var completedAt *time.Time
	if err := admin.QueryRow(context.Background(), `SELECT status,verification_state,verification_completed_at
		FROM subscriber_imports WHERE id=$1::uuid`, importID).Scan(&status, &state, &completedAt); err != nil {
		t.Fatal(err)
	}
	if status != importStatusVerificationQueued || state != ImportVerificationStatePending || completedAt != nil ||
		len(stub.cancelled) != 1 || stub.cancelled[0] != verificationJobID {
		t.Fatalf("cancellation retry state status=%q state=%q completed=%v calls=%v",
			status, state, completedAt, stub.cancelled)
	}
}

func strconvQuote(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func consentImportOptions(captured time.Time) importOptions {
	return importOptions{
		ConsentSource: "signed_form", ConsentSourceURL: "https://example.test/consent",
		ConsentCapturedAt: &captured, ConsentLegalBasis: "consent", ConsentJurisdiction: "GB",
		ConsentReason: "Signed form covered marketing email.", ConsentPolicyVersion: "privacy-v1",
		ConsentEvidenceReference: "receipt:CONSENT-123", ConsentScope: ImportConsentScope,
		ConsentScopeAcknowledged: true, ConsentContractVersion: ImportConsentContractVersion,
		SourceFingerprint: strings.Repeat("a", 64), SourceFingerprintScheme: sourceFingerprintScheme,
		SourceFingerprintKeyVersion: "v1", ScheduleType: scheduleImmediate,
	}
}

func seedConsentPreview(t *testing.T, app, admin *pgxpool.Pool, tenantID string, emails []string) (string, importOptions, migratecsv.Mapping, string, string) {
	t.Helper()
	ctx := context.Background()
	importID := uuid.NewString()
	mapping := importMapping()
	captured := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	opts := consentImportOptions(captured)
	deps := &Deps{Pool: app}
	_, _, stateFingerprint, err := deps.dryRunExistingEmails(ctx, tenantID, emails)
	if err != nil {
		t.Fatal(err)
	}
	catalogFingerprint, err := customFieldCatalogFingerprint(ctx, app, tenantID, mapping, customFieldImportPolicyFor(customfields.ModeAuto, false))
	if err != nil {
		t.Fatal(err)
	}
	preflight := computePreflightFingerprint(opts.SourceFingerprint, mapping, "skip", opts, stateFingerprint, catalogFingerprint)
	raw, _ := json.Marshal(mapping)
	if _, err := admin.Exec(ctx, `
INSERT INTO subscriber_imports (
	id, tenant_id, object_key, original_filename, mapping, rows_total, on_existing,
	consent_source, consent_source_url, consent_captured_at, consent_legal_basis,
	consent_jurisdiction, consent_reason, consent_policy_version, consent_evidence_reference,
	consent_scope, consent_scope_acknowledged, consent_contract_version,
	source_fingerprint, source_fingerprint_scheme, source_fingerprint_key_version,
	preflight_fingerprint, preflight_at, preflight_expires_at, preflight_rows_total,
	preflight_rows_failed, preflight_rows_existing, preflight_state_fingerprint,
	preflight_catalog_fingerprint
) VALUES (
	$1::uuid,$2::uuid,$3,'contacts.csv',$4::jsonb,$5,'skip',
	$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16,$17,$18,
	$19,now(),now()+interval '15 minutes',$5,0,0,$20,$21
)`, importID, tenantID, "imports/"+importID+".csv", raw, len(emails),
		opts.ConsentSource, opts.ConsentSourceURL, opts.ConsentCapturedAt, opts.ConsentLegalBasis,
		opts.ConsentJurisdiction, opts.ConsentReason, opts.ConsentPolicyVersion,
		opts.ConsentEvidenceReference, opts.ConsentScope, opts.ConsentContractVersion,
		opts.SourceFingerprint, opts.SourceFingerprintScheme, opts.SourceFingerprintKeyVersion,
		preflight, stateFingerprint, catalogFingerprint); err != nil {
		t.Fatal(err)
	}
	return importID, opts, mapping, stateFingerprint, preflight
}

func createConsentApproval(t *testing.T, app *pgxpool.Pool, tenantID, importID, preflight string, opts importOptions) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var approvalID, fingerprint string
	if err := tx.QueryRow(ctx, `
SELECT approval_id::text, consent_fingerprint
FROM create_subscriber_import_consent_approval($1::uuid,$2::uuid,$3,0,$4)`,
		tenantID, importID, preflight, opts.consentFingerprint()).Scan(&approvalID, &fingerprint); err != nil {
		t.Fatal(err)
	}
	if fingerprint != opts.consentFingerprint() {
		t.Fatalf("DB/Go consent fingerprints diverged: %s != %s", fingerprint, opts.consentFingerprint())
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_imports
SET status='running', claim_generation=1, started_at=now(), last_chunk_at=now(),
	confirmed_consent_fingerprint=$3, source_delete_after=NULL
WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, importID, fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return approvalID
}

func TestCommittedChunkStaleReclaimUsesWatermarkAndWritesReceiptsOnceDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	emails := []string{"one@example.test", "two@example.test"}
	importID, opts, mapping, stateFingerprint, preflight := seedConsentPreview(t, app, admin, tenantID, emails)
	approvalID := createConsentApproval(t, app, tenantID, importID, preflight, opts)
	worker := &Worker{Pool: app}
	job := &claimedJob{
		ID: importID, TenantID: tenantID, Mapping: mapping, OnExisting: "skip", ChunkSize: 1,
		Options: opts, ClaimGeneration: 1, PreflightStateFingerprint: stateFingerprint,
		ConsentApprovalID: approvalID, SourceEmails: emails,
		SourcePositions: map[string]int{emails[0]: 0, emails[1]: 1},
		ExpectedStates:  map[string]existingSubscriberState{},
	}
	seen := map[string]struct{}{}
	if _, _, err := worker.applyChunk(context.Background(), job,
		[]numberedRow{{Number: 1, Values: []string{emails[0], "One"}}}, seen, 1, nil); err != nil {
		t.Fatalf("first committed chunk: %v", err)
	}
	var processed int64
	var watermark string
	if err := admin.QueryRow(context.Background(), `SELECT processed_rows, execution_state_fingerprint FROM subscriber_imports WHERE id=$1::uuid`, importID).
		Scan(&processed, &watermark); err != nil || processed != 1 || watermark == "" {
		t.Fatalf("durable watermark processed=%d fp=%q err=%v", processed, watermark, err)
	}
	var subscriberID, consentRecordID string
	if err := admin.QueryRow(context.Background(), `
SELECT s.id::text, c.id::text
FROM subscribers s JOIN consent_records c ON c.tenant_id=s.tenant_id AND c.subscriber_id=s.id
WHERE s.tenant_id=$1::uuid AND s.email=$2`, tenantID, emails[0]).Scan(&subscriberID, &consentRecordID); err != nil {
		t.Fatal(err)
	}
	forgeryTx, err := db.WithTenant(context.Background(), app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = forgeryTx.Exec(context.Background(), `
INSERT INTO subscriber_import_consent_receipts (
	tenant_id,import_id,approval_id,subscriber_id,consent_record_id,
	source_row_fingerprint,evidence_fingerprint,source_file_fingerprint,
	operation,status_before,status_after,sendable_before,sendable_after,
	eligibility_transition_applied
) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,
	'updated','enabled','enabled',true,true,false)`,
		tenantID, importID, approvalID, subscriberID, consentRecordID,
		strings.Repeat("f", 64), strings.Repeat("e", 64), opts.SourceFingerprint)
	var receiptErr *pgconn.PgError
	if err == nil || !errors.As(err, &receiptErr) || receiptErr.Code != "23514" {
		t.Fatalf("forged receipt was not rejected by linkage guard: %v", err)
	}
	_ = forgeryTx.Rollback(context.Background())

	// A state mutation outside the import after the committed chunk must block
	// stale recovery before the next subscriber/receipt can be written.
	if _, err := admin.Exec(context.Background(), `UPDATE subscribers SET tags=ARRAY['external'] WHERE tenant_id=$1::uuid AND email=$2`, tenantID, emails[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `UPDATE subscriber_imports SET claim_generation=2, last_chunk_at=now() WHERE id=$1::uuid`, importID); err != nil {
		t.Fatal(err)
	}
	deps := &Deps{Pool: app}
	_, _, externallyMutatedFingerprint, err := deps.dryRunExistingEmails(context.Background(), tenantID, emails)
	if err != nil {
		t.Fatal(err)
	}
	if externallyMutatedFingerprint == watermark {
		t.Fatal("external state mutation did not invalidate recovery watermark")
	}
	var subscribersBeforeResume, receiptsBeforeResume int
	if err := admin.QueryRow(context.Background(), `
SELECT
 (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid),
 (SELECT count(*) FROM subscriber_import_consent_receipts WHERE tenant_id=$1::uuid AND import_id=$2::uuid)`, tenantID, importID).
		Scan(&subscribersBeforeResume, &receiptsBeforeResume); err != nil {
		t.Fatal(err)
	}
	if subscribersBeforeResume != 1 || receiptsBeforeResume != 1 {
		t.Fatalf("recovery boundary wrote after rejected mutation: subscribers=%d receipts=%d", subscribersBeforeResume, receiptsBeforeResume)
	}
	if _, err := admin.Exec(context.Background(), `UPDATE subscribers SET tags='{}'::text[] WHERE tenant_id=$1::uuid AND email=$2`, tenantID, emails[0]); err != nil {
		t.Fatal(err)
	}
	_, recoveredStates, recoveredFingerprint, err := deps.dryRunExistingEmails(context.Background(), tenantID, emails)
	if err != nil {
		t.Fatal(err)
	}
	if recoveredFingerprint != watermark {
		t.Fatalf("reverted state=%s durable watermark=%s", recoveredFingerprint, watermark)
	}
	reclaimed := *job
	reclaimed.ProcessedRows = 1
	reclaimed.ClaimGeneration = 2
	reclaimed.ExecutionStateFingerprint = watermark
	reclaimed.ExpectedStates = recoveredStates
	if _, _, err := worker.applyChunk(context.Background(), &reclaimed,
		[]numberedRow{{Number: 2, Values: []string{emails[1], "Two"}}},
		map[string]struct{}{emails[0]: {}}, 1, nil); err != nil {
		t.Fatalf("stale reclaim did not resume from durable watermark: %v", err)
	}
	var subscribers, receipts, consentRows int
	if err := admin.QueryRow(context.Background(), `
SELECT
 (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid),
 (SELECT count(*) FROM subscriber_import_consent_receipts WHERE tenant_id=$1::uuid AND import_id=$2::uuid),
 (SELECT count(*) FROM consent_records WHERE tenant_id=$1::uuid)`, tenantID, importID).
		Scan(&subscribers, &receipts, &consentRows); err != nil {
		t.Fatal(err)
	}
	if subscribers != 2 || receipts != 2 || consentRows != 2 {
		t.Fatalf("resume duplication/loss: subscribers=%d receipts=%d consent=%d", subscribers, receipts, consentRows)
	}
}

func TestVerificationRejectionCannotCreateSubscriberOrConsentReceiptDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	emails := []string{"safe@example.test", "unsafe@example.test"}
	importID, opts, mapping, stateFingerprint, preflight := seedConsentPreview(t, app, admin, tenantID, emails)
	approvalID := createConsentApproval(t, app, tenantID, importID, preflight, opts)
	job := &claimedJob{
		ID: importID, TenantID: tenantID, Mapping: mapping, OnExisting: "skip", ChunkSize: 10,
		Options: opts, ClaimGeneration: 1, PreflightStateFingerprint: stateFingerprint,
		ConsentApprovalID: approvalID, SourceEmails: emails,
		SourcePositions: map[string]int{emails[0]: 0, emails[1]: 1},
		ExpectedStates:  map[string]existingSubscriberState{},
		VerificationDecisions: map[string]ImportVerificationDecision{
			emails[0]: {Status: "valid"},
			emails[1]: {Status: "spamtrap"},
		},
	}
	worker := &Worker{Pool: app}
	res, _, err := worker.applyChunk(context.Background(), job, []numberedRow{
		{Number: 1, Values: []string{emails[0], "Safe"}},
		{Number: 2, Values: []string{emails[1], "Unsafe"}},
	}, map[string]struct{}{}, 2, nil)
	if err != nil {
		t.Fatalf("apply verified chunk: %v", err)
	}
	if res.Imported != 1 || res.Failed != 1 || res.VerificationRejected != 1 {
		t.Fatalf("verified chunk counters=%+v", res)
	}
	var subscribers, unsafeSubscribers, receipts, verificationErrors int
	if err := admin.QueryRow(context.Background(), `
SELECT
 (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid),
 (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND email=$2),
 (SELECT count(*) FROM subscriber_import_consent_receipts WHERE tenant_id=$1::uuid AND import_id=$3::uuid),
 (SELECT count(*) FROM subscriber_import_errors WHERE tenant_id=$1::uuid AND import_id=$3::uuid
   AND error_code='email_verification_rejected')`, tenantID, emails[1], importID).
		Scan(&subscribers, &unsafeSubscribers, &receipts, &verificationErrors); err != nil {
		t.Fatal(err)
	}
	if subscribers != 1 || unsafeSubscribers != 0 || receipts != 1 || verificationErrors != 1 {
		t.Fatalf("verification admission boundary subscribers=%d unsafe=%d receipts=%d errors=%d",
			subscribers, unsafeSubscribers, receipts, verificationErrors)
	}
}

type importVerificationStateStub struct {
	ensure    ImportVerificationRun
	get       ImportVerificationRun
	err       error
	cancelErr error
	cancelled []string
	activated []string
}

func (s *importVerificationStateStub) CurrentImportVerificationMode(context.Context, string) (string, error) {
	return ImportVerificationModeFull, nil
}
func (s *importVerificationStateStub) EnsureImportVerification(context.Context, string, string, string, []string) (ImportVerificationRun, error) {
	return s.ensure, s.err
}
func (s *importVerificationStateStub) GetImportVerification(context.Context, string, string, string, string) (ImportVerificationRun, error) {
	return s.get, s.err
}
func (s *importVerificationStateStub) ActivateImportVerification(_ context.Context, _, _, jobID, _ string) error {
	s.activated = append(s.activated, jobID)
	return s.err
}
func (s *importVerificationStateStub) CancelImportVerification(_ context.Context, _, jobID string) error {
	s.cancelled = append(s.cancelled, jobID)
	return s.cancelErr
}

func TestImportYieldsUntilDurableVerificationCompletesDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID := insertBasicPreview(t, admin, tenantID, 0)
	verificationJobID := uuid.NewString()
	if _, err := admin.Exec(context.Background(), `
INSERT INTO verification_jobs
 (id,tenant_id,status,source,source_ref,total,execution_mode,execution_class,idempotency_key,request_fingerprint)
VALUES ($1::uuid,$2::uuid,'import_pending','upload',$3,1,'full','subscriber_import',$4,$5)`,
		verificationJobID, tenantID, importID, "subscriber-import:"+importID+":verification:v1",
		strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `
UPDATE subscriber_imports
   SET status='verification_running',claim_generation=1,started_at=now(),last_chunk_at=now(),
       verification_mode='full',verification_state='pending',source_delete_after=NULL
 WHERE id=$1::uuid`, importID); err != nil {
		t.Fatal(err)
	}
	stub := &importVerificationStateStub{
		ensure: ImportVerificationRun{JobID: verificationJobID, State: ImportVerificationStatePending},
		get: ImportVerificationRun{JobID: verificationJobID, State: ImportVerificationStateCompleted,
			Decisions: map[string]ImportVerificationDecision{"one@example.test": {Status: "valid"}}},
	}
	worker := &Worker{Pool: app, Verification: stub}
	job := &claimedJob{ID: importID, TenantID: tenantID, ClaimGeneration: 1,
		VerificationMode: ImportVerificationModeFull}
	ready, err := worker.ensureVerificationReady(context.Background(), job, []string{"one@example.test"})
	if err != nil || ready {
		t.Fatalf("pending verification ready=%v err=%v", ready, err)
	}
	var status, state, linked string
	if err := admin.QueryRow(context.Background(), `SELECT status,verification_state,verification_job_id::text
		FROM subscriber_imports WHERE id=$1::uuid`, importID).Scan(&status, &state, &linked); err != nil {
		t.Fatal(err)
	}
	if status != importStatusVerificationQueued || state != ImportVerificationStatePending || linked != verificationJobID ||
		len(stub.activated) != 1 || stub.activated[0] != verificationJobID {
		t.Fatalf("yielded import status=%q state=%q job=%q", status, state, linked)
	}
	if _, err := admin.Exec(context.Background(), `UPDATE subscriber_imports
		SET status='verification_running',claim_generation=2,last_chunk_at=now() WHERE id=$1::uuid`, importID); err != nil {
		t.Fatal(err)
	}
	job.ClaimGeneration = 2
	job.VerificationJobID = verificationJobID
	ready, err = worker.ensureVerificationReady(context.Background(), job, []string{"one@example.test"})
	if err != nil || !ready {
		t.Fatalf("completed verification ready=%v err=%v", ready, err)
	}
	var completedAt *time.Time
	if err := admin.QueryRow(context.Background(), `SELECT verification_state,verification_completed_at
		FROM subscriber_imports WHERE id=$1::uuid`, importID).Scan(&state, &completedAt); err != nil {
		t.Fatal(err)
	}
	if state != ImportVerificationStateCompleted || completedAt == nil ||
		job.VerificationDecisions["one@example.test"].Status != "valid" {
		t.Fatalf("completed import state=%q at=%v decisions=%v", state, completedAt, job.VerificationDecisions)
	}
}

type staticImportStorage struct {
	key  string
	body []byte
}

func (s *staticImportStorage) Put(context.Context, string, string, []byte) (string, error) {
	return "", errors.New("not implemented")
}
func (s *staticImportStorage) Open(_ context.Context, key string) (io.ReadCloser, string, error) {
	if key != s.key {
		return nil, "", errors.New("object not found")
	}
	return io.NopCloser(bytes.NewReader(s.body)), "text/csv", nil
}
func (s *staticImportStorage) Delete(context.Context, string) error { return nil }

func TestHeaderOnlyImportCompletesWithoutChunkWatermarkDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY_VERSION", "v1")
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY", strings.Repeat("k", 32))
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEYS", "")
	body := []byte("email\n")
	fingerprint, err := sourceFileFingerprint(tenantID, body)
	if err != nil {
		t.Fatal(err)
	}
	mapping := migratecsv.Mapping{
		Headers: []string{"email"},
		Columns: []migratecsv.ColumnMapping{{Index: 0, Name: "email", Kind: migratecsv.KindEmail}},
	}
	opts := importOptions{
		SourceFingerprint: fingerprint, SourceFingerprintScheme: sourceFingerprintScheme,
		SourceFingerprintKeyVersion: "v1", ScheduleType: scheduleImmediate,
	}
	stateFingerprint := emptySubscriberStateFingerprint()
	catalogFingerprint := sourceSHA256([]byte("[]"))
	preflight := computePreflightFingerprint(fingerprint, mapping, "skip", opts, stateFingerprint, catalogFingerprint)
	importID := uuid.NewString()
	objectKey := "imports/" + importID + ".csv"
	mappingJSON, _ := json.Marshal(mapping)
	if _, err := admin.Exec(context.Background(), `INSERT INTO subscriber_imports (
		id,tenant_id,object_key,original_filename,mapping,rows_total,status,on_existing,
		source_fingerprint,source_fingerprint_scheme,source_fingerprint_key_version,
		preflight_fingerprint,preflight_at,preflight_expires_at,preflight_rows_total,
		preflight_state_fingerprint,preflight_catalog_fingerprint,claim_generation,
		source_delete_after,preflight_verification_mode,verification_mode,verification_state
	) VALUES ($1::uuid,$2::uuid,$3,'empty.csv',$4::jsonb,0,'verification_running','skip',
		$5,$6,$7,$8,now(),now()+interval '15 minutes',0,$9,$10,1,NULL,'local','local','pending')`,
		importID, tenantID, objectKey, mappingJSON, fingerprint, sourceFingerprintScheme, "v1",
		preflight, stateFingerprint, catalogFingerprint); err != nil {
		t.Fatal(err)
	}
	job := &claimedJob{
		ID: importID, TenantID: tenantID, ObjectKey: objectKey, Mapping: mapping,
		OnExisting: "skip", ChunkSize: 500, Options: opts, ClaimGeneration: 1,
		PreflightStateFingerprint: stateFingerprint, PreflightCatalogFingerprint: catalogFingerprint,
		VerificationMode: ImportVerificationModeLocal, VerificationState: ImportVerificationStatePending,
	}
	emptyVerificationJobID := uuid.NewString()
	if _, err := admin.Exec(context.Background(), `INSERT INTO verification_jobs
		(id,tenant_id,status,source,source_ref,total,execution_mode,execution_class,activated_at,idempotency_key,request_fingerprint)
		VALUES ($1::uuid,$2::uuid,'completed','upload',$3,0,'local','subscriber_import',now(),$4,$5)`,
		emptyVerificationJobID, tenantID, importID, "subscriber-import:"+importID+":verification:v1", strings.Repeat("d", 64)); err != nil {
		t.Fatal(err)
	}
	stub := &importVerificationStateStub{
		ensure: ImportVerificationRun{JobID: emptyVerificationJobID, State: ImportVerificationStateCompleted,
			Decisions: map[string]ImportVerificationDecision{}},
	}
	worker := &Worker{Pool: app, Storage: &staticImportStorage{key: objectKey, body: body}, Verification: stub}
	if err := worker.processJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	var status, verificationState, linkedVerificationJobID string
	var processed int64
	if err := admin.QueryRow(context.Background(), `SELECT status,processed_rows,verification_state,
		COALESCE(verification_job_id::text,'') FROM subscriber_imports WHERE id=$1::uuid`, importID).
		Scan(&status, &processed, &verificationState, &linkedVerificationJobID); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || processed != 0 || verificationState != ImportVerificationStateCompleted || linkedVerificationJobID == "" {
		t.Fatalf("header-only result status=%q processed=%d verification_state=%q job=%q",
			status, processed, verificationState, linkedVerificationJobID)
	}
}

func TestApprovalFunctionDeniesPreseedTenantAndReplayDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID, opts, _, _, preflight := seedConsentPreview(t, app, admin, tenantID, []string{"one@example.test"})
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `INSERT INTO subscriber_import_consent_approvals (
	 tenant_id,import_id,consent_fingerprint,source_file_fingerprint,source_fingerprint_scheme,
	 source_fingerprint_key_version,consent_source,source_url,captured_at,legal_basis,jurisdiction,
	 reason,policy_version,evidence_reference,scope,contract_version
) SELECT tenant_id,id,$3,source_fingerprint,source_fingerprint_scheme,source_fingerprint_key_version,
	 consent_source,consent_source_url,consent_captured_at,consent_legal_basis,consent_jurisdiction,
	 consent_reason,consent_policy_version,consent_evidence_reference,consent_scope,consent_contract_version
FROM subscriber_imports WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, importID, opts.consentFingerprint())
	var pgErr *pgconn.PgError
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("direct app-role preseed error=%v", err)
	}
	_ = tx.Rollback(ctx)

	tx, _ = db.WithTenant(ctx, app, tenantID)
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `SELECT * FROM create_subscriber_import_consent_approval($1::uuid,$2::uuid,$3,0,$4)`,
		uuid.NewString(), importID, preflight, opts.consentFingerprint())
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("cross-tenant function call error=%v", err)
	}
	_ = tx.Rollback(ctx)
	if _, err := admin.Exec(ctx, `UPDATE subscriber_imports
	SET preflight_at=now()-interval '2 minutes', preflight_expires_at=now()-interval '1 minute'
	WHERE id=$1::uuid`, importID); err != nil {
		t.Fatal(err)
	}
	tx, _ = db.WithTenant(ctx, app, tenantID)
	_, err = tx.Exec(ctx, `SELECT * FROM create_subscriber_import_consent_approval($1::uuid,$2::uuid,$3,0,$4)`,
		tenantID, importID, preflight, opts.consentFingerprint())
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "40001" {
		t.Fatalf("expired-preflight function call error=%v", err)
	}
	_ = tx.Rollback(ctx)
	if _, err := admin.Exec(ctx, `UPDATE subscriber_imports
	SET preflight_at=now(), preflight_expires_at=now()+interval '15 minutes'
	WHERE id=$1::uuid`, importID); err != nil {
		t.Fatal(err)
	}

	approvalID := createConsentApproval(t, app, tenantID, importID, preflight, opts)
	if approvalID == "" {
		t.Fatal("valid approval missing id")
	}
	tx, _ = db.WithTenant(ctx, app, tenantID)
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `SELECT * FROM create_subscriber_import_consent_approval($1::uuid,$2::uuid,$3,0,$4)`,
		tenantID, importID, preflight, opts.consentFingerprint())
	if err == nil {
		t.Fatal("approval replay unexpectedly succeeded")
	}
}

func TestImportErrorsRejectRawPIIAtDatabaseDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	importID := insertBasicPreview(t, admin, tenantID, 0)
	ctx := context.Background()

	for name, statement := range map[string]string{
		"raw identity columns": `INSERT INTO subscriber_import_errors
			(tenant_id,import_id,row_number,email,error,raw_row,error_code)
			VALUES ($1::uuid,$2::uuid,1,'alice@example.test','Invalid row','["alice@example.test"]'::jsonb,'invalid_email')`,
		"identity in message": `INSERT INTO subscriber_import_errors
			(tenant_id,import_id,row_number,email,error,raw_row,error_code)
			VALUES ($1::uuid,$2::uuid,1,NULL,'Invalid alice@example.test',NULL,'invalid_email')`,
	} {
		t.Run(name, func(t *testing.T) {
			tx, err := db.WithTenant(ctx, app, tenantID)
			if err != nil {
				t.Fatal(err)
			}
			_, err = tx.Exec(ctx, statement, tenantID, importID)
			var pgErr *pgconn.PgError
			if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "23514" {
				t.Fatalf("privacy-unsafe row error was not rejected: %v", err)
			}
			_ = tx.Rollback(ctx)
		})
	}

	tx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO subscriber_import_errors
		(tenant_id,import_id,row_number,email,error,raw_row,error_code)
		VALUES ($1::uuid,$2::uuid,1,NULL,'CSV row could not be parsed',NULL,'csv_parse_error')`, tenantID, importID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var safeRows int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM subscriber_import_errors
		WHERE tenant_id=$1::uuid AND import_id=$2::uuid AND email IS NULL AND raw_row IS NULL
		AND email_sha256 IS NULL AND raw_row_sha256 IS NULL`, tenantID, importID).Scan(&safeRows); err != nil || safeRows != 1 {
		t.Fatalf("privacy-safe row persistence count=%d err=%v", safeRows, err)
	}

	_, err = admin.Exec(ctx, `UPDATE subscriber_imports SET status='failed',
		error_code='import_failed',error='alice@example.test caused backend failure' WHERE id=$1::uuid`, importID)
	var pgErr *pgconn.PgError
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("PII-bearing public job error was not rejected: %v", err)
	}
}

type retentionStorage struct {
	mu       sync.Mutex
	deletes  map[string]int
	failOnce map[string]bool
}

func (s *retentionStorage) Put(context.Context, string, string, []byte) (string, error) {
	return "", nil
}
func (s *retentionStorage) Open(context.Context, string) (io.ReadCloser, string, error) {
	return nil, "", errors.New("not implemented")
}
func (s *retentionStorage) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deletes == nil {
		s.deletes = map[string]int{}
	}
	s.deletes[key]++
	if s.failOnce[key] {
		delete(s.failOnce, key)
		return errors.New("transient delete failure")
	}
	return nil
}

func TestArtifactPurgeLeasesAndRetriesWithoutDoubleDeleteDB(t *testing.T) {
	app, admin := subscriberImportDBPools(t)
	tenantID := seedImportTenant(t, admin)
	readyID := uuid.NewString()
	retryID := uuid.NewString()
	for _, row := range []struct{ id, key string }{{readyID, "imports/ready.csv"}, {retryID, "imports/retry.csv"}} {
		if _, err := admin.Exec(context.Background(), `
INSERT INTO subscriber_imports (
	id,tenant_id,object_key,original_filename,mapping,sample_rows,status,
	dry_run_results,source_delete_after,review_data_expires_at
) VALUES ($1::uuid,$2::uuid,$3,'private-name.csv',
	'{"headers":["private-header"],"columns":[],"rows":0}'::jsonb,
	'[{"private-header":"private-value"}]'::jsonb,'ready','{"private":"result"}'::jsonb,
	now()-interval '1 minute',now()-interval '1 minute')`,
			row.id, tenantID, row.key); err != nil {
			t.Fatal(err)
		}
	}
	storage := &retentionStorage{deletes: map[string]int{}, failOnce: map[string]bool{"imports/retry.csv": true}}
	worker := &Worker{Pool: app, Storage: storage}
	if err := worker.purgeExpiredArtifacts(context.Background()); err != nil {
		t.Fatal(err)
	}
	var key, filename string
	var reviewDataPurged bool
	var due *time.Time
	if err := admin.QueryRow(context.Background(), `SELECT object_key,source_delete_after,original_filename,
		mapping='{"headers":[],"columns":[],"rows":0}'::jsonb
		AND sample_rows='[]'::jsonb AND dry_run_results IS NULL
		FROM subscriber_imports WHERE id=$1::uuid`, readyID).
		Scan(&key, &due, &filename, &reviewDataPurged); err != nil {
		t.Fatal(err)
	}
	if key != "" || due != nil || filename != "expired-import.csv" || !reviewDataPurged {
		t.Fatalf("purged row key=%q due=%v filename=%q review_purged=%v",
			key, due, filename, reviewDataPurged)
	}
	if err := admin.QueryRow(context.Background(), `SELECT object_key,source_delete_after FROM subscriber_imports WHERE id=$1::uuid`, retryID).
		Scan(&key, &due); err != nil || key == "" || due == nil || !due.After(time.Now()) {
		t.Fatalf("failed delete did not retain leased object: key=%q due=%v err=%v", key, due, err)
	}
	if err := worker.purgeExpiredArtifacts(context.Background()); err != nil {
		t.Fatal(err)
	}
	storage.mu.Lock()
	if storage.deletes["imports/retry.csv"] != 1 {
		t.Fatalf("active lease was ignored: deletes=%d", storage.deletes["imports/retry.csv"])
	}
	storage.mu.Unlock()
	if _, err := admin.Exec(context.Background(), `UPDATE subscriber_imports SET source_delete_after=now()-interval '1 second' WHERE id=$1::uuid`, retryID); err != nil {
		t.Fatal(err)
	}
	if err := worker.purgeExpiredArtifacts(context.Background()); err != nil {
		t.Fatal(err)
	}
	storage.mu.Lock()
	deletes := storage.deletes["imports/retry.csv"]
	storage.mu.Unlock()
	if deletes != 2 {
		t.Fatalf("expired lease was not retried exactly once: deletes=%d", deletes)
	}
}
