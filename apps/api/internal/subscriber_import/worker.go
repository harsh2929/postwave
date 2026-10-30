// SPDX-License-Identifier: AGPL-3.0-only
//
// worker.go — SUB-102-103 background importer.
//
// The HTTP Confirm handler used to drag the request connection across
// the entire import. A 50 MB CSV (200k rows) would routinely blow past
// our 60s gateway timeout, leaving subscriber_imports rows stuck in
// 'queued' forever. This worker drains 'queued' rows in 500-row chunks,
// writes per-chunk progress so the UI can poll, and bails out cleanly
// when the operator hits Cancel.
//
// Cross-tenant on purpose: the worker scans 'queued' rows with the
// app.outbox_worker permissive policy, then flips into a tenant-scoped
// tx (db.WithTenant) to do the actual subscribers writes under that
// tenant's RLS.

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/emailidentity"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/suppressions"

	migratecsv "github.com/postwave/migrate/csv"
)

// DefaultChunkSize is the row batch granularity. 500 rows is the sweet
// spot where pgx round-trip overhead amortises out but progress still
// updates often enough to feel live (≤2s gap on broadband).
const DefaultChunkSize = 500

// Worker drains queued subscriber_imports rows in the background.
type Worker struct {
	Pool    *db.Pool
	Storage Storage
	Logger  *slog.Logger
	// Verification is the provider-neutral adapter for confirmed import
	// enforcement. A configured local/full import fails closed when it is nil.
	Verification ImportExecutionVerifier
	Interval     time.Duration
	ChunkSize    int
}

const (
	importStatusPreview             = "preview"
	importStatusVerificationQueued  = "verification_queued"
	importStatusVerificationRunning = "verification_running"
)

func importQueuedStatus(mode string) string {
	if mode == ImportVerificationModeOff || strings.TrimSpace(mode) == "" {
		return "queued"
	}
	return importStatusVerificationQueued
}

func importRunningStatus(mode string) string {
	if mode == ImportVerificationModeOff || strings.TrimSpace(mode) == "" {
		return "running"
	}
	return importStatusVerificationRunning
}

func (w *Worker) interval() time.Duration {
	if w.Interval > 0 {
		return w.Interval
	}
	return 5 * time.Second
}

func (w *Worker) chunkSize() int {
	if w.ChunkSize > 0 {
		return w.ChunkSize
	}
	return DefaultChunkSize
}

// Run blocks until ctx is canceled. Workers can be safely run more than
// once per process — claimNextJob uses a FOR UPDATE SKIP LOCKED so
// concurrent workers never grab the same job.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("subscriber_import worker: missing pool")
	}
	if w.Logger != nil {
		w.Logger.Info("subscriber_import worker: starting",
			"interval", w.interval().String(),
			"chunk_size", w.chunkSize())
	}
	t := time.NewTicker(w.interval())
	defer t.Stop()
	for {
		if err := w.purgeExpiredErrors(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("subscriber_import error-retention purge failed",
				"error_class", subscriberImportLogErrorClass(err))
		}
		if err := w.purgeExpiredArtifacts(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("subscriber_import artifact-retention purge failed",
				"error_class", subscriberImportLogErrorClass(err))
		}
		// Drain everything queued each tick (cheap: one query that returns
		// 0 rows in the happy idle case). Bounded by 50 jobs per tick so a
		// flood doesn't starve other tickers.
		for i := 0; i < 50; i++ {
			job, err := w.claimNextJob(ctx)
			if err != nil {
				if w.Logger != nil {
					w.Logger.Warn("subscriber_import claim failed",
						"error_class", subscriberImportLogErrorClass(err))
				}
				break
			}
			if job == nil {
				break
			}
			if err := w.processJob(ctx, job); err != nil && w.Logger != nil {
				w.Logger.Warn("subscriber_import job failed",
					"tenant", job.TenantID, "import", job.ID,
					"error_class", subscriberImportLogErrorClass(err))
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// claimedJob is the minimal row the worker needs to drive an import.
type claimedJob struct {
	ID         string
	TenantID   string
	ObjectKey  string
	Mapping    migratecsv.Mapping
	OnExisting string
	ChunkSize  int
	// Options carries the A11 job-level wizard answers: consent
	// provenance, job tags, auto_create_properties.
	Options                     importOptions
	ProcessedRows               int64
	ClaimGeneration             int64
	PreflightStateFingerprint   string
	ExecutionStateFingerprint   string
	PreflightCatalogFingerprint string
	PreflightRowsFailed         int64
	PreflightRowsExisting       int64
	ConsentApprovalID           string
	VerificationMode            string
	VerificationState           string
	VerificationJobID           string
	VerificationDecisions       map[string]ImportVerificationDecision
	// SourceEmails exists only in worker memory. It is the frozen, unique,
	// normalized source order used to compute the execution-state watermark.
	SourceEmails    []string
	SourcePositions map[string]int
	// ExpectedStates is the last committed state for every source identity.
	// A stale claim hydrates it once from the durable aggregate watermark;
	// each chunk then verifies and advances only the identities it touches.
	ExpectedStates map[string]existingSubscriberState
	// CustomFieldPolicy is the workspace custom-field policy resolved at the
	// execution boundary; it matched the reviewed preflight's catalog binding.
	CustomFieldPolicy customFieldImportPolicy
	// CustomFieldSchema freezes the catalog that matched the reviewed
	// preflight so every chunk applies identical coercion rules.
	CustomFieldSchema *customfields.ReadOnlySchema
	// TargetListID is the list every imported contact joins, or "" for none.
	// Stored as the canonical Moosewave list UUID; each chunk re-resolves it in
	// its own writing transaction.
	TargetListID string
}

// claimNextJob atomically flips one 'queued' row to 'running' and
// returns it. FOR UPDATE SKIP LOCKED makes this safe across multiple
// worker processes.
func (w *Worker) claimNextJob(ctx context.Context) (*claimedJob, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		id, tenantID, objectKey, onExisting                                               string
		mappingJSON                                                                       []byte
		chunkSize                                                                         int
		opts                                                                              importOptions
		processedRows                                                                     int64
		claimGeneration                                                                   int64
		preflightStateFingerprint, executionStateFingerprint, preflightCatalogFingerprint string
		preflightRowsFailed, preflightRowsExisting                                        int64
		consentApprovalID                                                                 string
		verificationMode, verificationState, verificationJobID                            string
		targetListID                                                                      string
	)
	// SUB-104 — only claim rows that are DUE: next_scheduled_at NULL
	// (immediate) or already elapsed. A one-time scheduled row stays
	// invisible to the worker until its due time. Ordering
	// by next_scheduled_at NULLS FIRST then created_at matches the
	// 1324 partial index so this stays an index scan.
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, object_key, mapping,
       COALESCE(on_existing, 'skip'), COALESCE(chunk_size, 500),
       COALESCE(consent_source, ''), COALESCE(consent_source_url, ''),
       consent_captured_at, COALESCE(consent_legal_basis, ''),
       COALESCE(consent_jurisdiction, ''), COALESCE(consent_reason, ''),
       COALESCE(consent_policy_version, ''), COALESCE(consent_evidence_reference, ''),
       COALESCE(consent_scope, ''), consent_scope_acknowledged,
	   COALESCE(consent_contract_version, ''), COALESCE(source_fingerprint, ''),
	   COALESCE(source_fingerprint_scheme, ''), COALESCE(source_fingerprint_key_version, ''),
	   COALESCE(tags, '{}'::text[]), auto_create_properties,
	   COALESCE(processed_rows, 0),
	   COALESCE(claim_generation, 0),
	   COALESCE(preflight_state_fingerprint, ''), COALESCE(execution_state_fingerprint, ''),
	   COALESCE(preflight_catalog_fingerprint, ''),
	   COALESCE(preflight_rows_failed, 0), COALESCE(preflight_rows_existing, 0),
	   COALESCE((SELECT a.id::text FROM subscriber_import_consent_approvals a
	              WHERE a.tenant_id = subscriber_imports.tenant_id
	                AND a.import_id = subscriber_imports.id), ''),
	   COALESCE(verification_mode, 'off'), COALESCE(verification_state, 'off'),
	   COALESCE(verification_job_id::text, ''),
	   COALESCE(target_list_id::text, '')
  FROM subscriber_imports
 WHERE (
       status IN ('queued', 'verification_queued')
       AND (next_scheduled_at IS NULL OR next_scheduled_at <= now())
   ) OR (
       status IN ('running', 'verification_running')
       AND COALESCE(last_chunk_at, started_at, created_at) < now() - interval '30 minutes'
   )
 ORDER BY next_scheduled_at NULLS FIRST, created_at
 LIMIT 1
   FOR UPDATE SKIP LOCKED`).
		Scan(&id, &tenantID, &objectKey, &mappingJSON, &onExisting, &chunkSize,
			&opts.ConsentSource, &opts.ConsentSourceURL,
			&opts.ConsentCapturedAt, &opts.ConsentLegalBasis,
			&opts.ConsentJurisdiction, &opts.ConsentReason,
			&opts.ConsentPolicyVersion, &opts.ConsentEvidenceReference,
			&opts.ConsentScope, &opts.ConsentScopeAcknowledged,
			&opts.ConsentContractVersion, &opts.SourceFingerprint,
			&opts.SourceFingerprintScheme, &opts.SourceFingerprintKeyVersion,
			&opts.Tags, &opts.AutoCreateProps,
			&processedRows, &claimGeneration,
			&preflightStateFingerprint, &executionStateFingerprint, &preflightCatalogFingerprint,
			&preflightRowsFailed, &preflightRowsExisting, &consentApprovalID,
			&verificationMode, &verificationState, &verificationJobID, &targetListID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET status = CASE WHEN verification_mode = 'off' THEN 'running' ELSE 'verification_running' END,
       started_at = COALESCE(started_at, now()),
       last_chunk_at = now(),
       claim_generation = claim_generation + 1
	 WHERE id = $1::uuid`, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	var mapping migratecsv.Mapping
	if err := json.Unmarshal(mappingJSON, &mapping); err != nil {
		return nil, fmt.Errorf("mapping: %w", err)
	}
	if chunkSize <= 0 {
		chunkSize = w.chunkSize()
	}
	return &claimedJob{
		ID: id, TenantID: tenantID, ObjectKey: objectKey,
		Mapping: mapping, OnExisting: onExisting, ChunkSize: chunkSize,
		Options:                     opts,
		ProcessedRows:               processedRows,
		ClaimGeneration:             claimGeneration + 1,
		PreflightStateFingerprint:   preflightStateFingerprint,
		ExecutionStateFingerprint:   executionStateFingerprint,
		PreflightCatalogFingerprint: preflightCatalogFingerprint,
		PreflightRowsFailed:         preflightRowsFailed,
		PreflightRowsExisting:       preflightRowsExisting,
		ConsentApprovalID:           consentApprovalID,
		VerificationMode:            verificationMode,
		VerificationState:           verificationState,
		VerificationJobID:           verificationJobID,
		TargetListID:                targetListID,
	}, nil
}

// processJob streams the CSV from storage and walks rows in chunks.
// Per-row errors land in subscriber_import_errors (so the UI can offer
// retry) instead of poisoning the whole batch.
// jobFailure names a terminal import failure that processJob records through
// markFailedJob: the stable failure code plus the underlying cause, if any.
type jobFailure struct {
	code string
	err  error
}

// resolveJobMapping canonicalizes the claimed job's frozen column mapping,
// validates its targets and collision strategy, and returns the email column
// index. The canonical mapping is written back to the job before the
// collision strategy is checked, exactly as the inline code did.
func (w *Worker) resolveJobMapping(j *claimedJob) (int, *jobFailure) {
	if w.Storage == nil {
		return 0, &jobFailure{code: "storage_unavailable"}
	}
	canonical, mappingErr := canonicalizeMapping(j.Mapping, append([]string(nil), j.Mapping.Headers...))
	if mappingErr != nil {
		return 0, &jobFailure{code: "mapping_invalid", err: mappingErr}
	}
	if targetErr := validateMappingTargets(canonical); targetErr != nil {
		return 0, &jobFailure{code: "mapping_invalid", err: targetErr}
	}
	j.Mapping = canonical
	if j.OnExisting != "skip" && j.OnExisting != "update" && j.OnExisting != "error" {
		return 0, &jobFailure{code: "collision_strategy_invalid"}
	}
	emailCol := emailColumnIndex(j.Mapping)
	if emailCol < 0 {
		return 0, &jobFailure{code: "mapping_invalid", err: errors.New("email mapping missing")}
	}
	return emailCol, nil
}

// readVerifiedSource opens the immutable import source, buffers it through
// the bounded CSV reader, re-derives the tenant-bound fingerprint against the
// frozen options and re-validates the consent contract. The body is fully
// buffered, so the storage reader is closed before returning.
func (w *Worker) readVerifiedSource(ctx context.Context, j *claimedJob) ([]byte, *jobFailure) {
	rdr, _, openErr := w.Storage.Open(ctx, j.ObjectKey)
	if openErr != nil {
		return nil, &jobFailure{code: "source_open_failed", err: openErr}
	}
	defer func() { _ = rdr.Close() }()
	body, readErr := readBoundedCSV(rdr)
	if readErr != nil {
		return nil, &jobFailure{code: "source_read_failed", err: readErr}
	}
	actualFingerprint, fingerprintErr := sourceFileFingerprintWithVersion(j.TenantID, body, j.Options.SourceFingerprintKeyVersion)
	if fingerprintErr != nil || j.Options.SourceFingerprintScheme != sourceFingerprintScheme ||
		j.Options.SourceFingerprint == "" || actualFingerprint != j.Options.SourceFingerprint {
		return nil, &jobFailure{code: "source_integrity_failed", err: fingerprintErr}
	}
	if consentErr := j.Options.validateForConfirm(time.Now().UTC()); consentErr != nil {
		return nil, &jobFailure{code: "consent_contract_invalid", err: consentErr}
	}
	if j.Options.hasConsent() && j.ConsentApprovalID == "" {
		return nil, &jobFailure{code: "consent_approval_missing"}
	}
	return body, nil
}

func (w *Worker) processJob(ctx context.Context, j *claimedJob) error {
	cancelled, cancelErr := w.cancelRequested(ctx, j.ID)
	if cancelErr != nil {
		return cancelErr
	}
	if cancelled {
		return w.markCancelled(ctx, j)
	}
	emailCol, mappingFailure := w.resolveJobMapping(j)
	if mappingFailure != nil {
		return w.markFailedJob(ctx, j, mappingFailure.code, mappingFailure.err)
	}
	body, sourceFailure := w.readVerifiedSource(ctx, j)
	if sourceFailure != nil {
		return w.markFailedJob(ctx, j, sourceFailure.code, sourceFailure.err)
	}
	identityScan, scanErr := scanImportIdentities(body, j.Mapping)
	if scanErr != nil {
		return w.markFailedJob(ctx, j, "source_validation_failed", scanErr)
	}
	deps := &Deps{Pool: w.Pool}
	_, currentStates, currentStateFingerprint, stateErr := deps.dryRunExistingEmails(ctx, j.TenantID, identityScan.Emails)
	if stateErr != nil {
		return w.markFailedJob(ctx, j, "preflight_state_check_failed", stateErr)
	}
	policy, policyErr := resolveCustomFieldImportPolicy(ctx, w.Pool, j.TenantID, j.Options.AutoCreateProps)
	if policyErr != nil {
		return w.markFailedJob(ctx, j, "catalog_check_failed", policyErr)
	}
	j.CustomFieldPolicy = policy
	currentCatalogFingerprint, catalogErr := customFieldCatalogFingerprint(ctx, w.Pool, j.TenantID, j.Mapping, policy)
	if catalogErr != nil {
		return w.markFailedJob(ctx, j, "catalog_check_failed", catalogErr)
	}
	expectedStateFingerprint := j.PreflightStateFingerprint
	if j.ProcessedRows > 0 {
		expectedStateFingerprint = j.ExecutionStateFingerprint
	}
	if expectedStateFingerprint == "" || currentStateFingerprint != expectedStateFingerprint ||
		currentCatalogFingerprint != j.PreflightCatalogFingerprint {
		return w.markFailedJob(ctx, j, "preflight_state_changed", nil)
	}
	j.SourceEmails = append([]string(nil), identityScan.Emails...)
	j.SourcePositions = make(map[string]int, len(identityScan.Emails))
	for position, email := range identityScan.Emails {
		j.SourcePositions[email] = position
	}
	j.ExpectedStates = currentStates
	if j.OnExisting == "error" && (j.PreflightRowsFailed != 0 || j.PreflightRowsExisting != 0) {
		return w.markFailedJob(ctx, j, "preflight_conflicts", nil)
	}
	verificationReady, verificationErr := w.ensureVerificationReady(ctx, j, identityScan.Emails)
	if verificationErr != nil {
		return verificationErr
	}
	if !verificationReady {
		// The import claim was durably yielded while its linked verification
		// job runs. A later claim re-opens the immutable source and continues
		// only after every decision is complete.
		return nil
	}
	// Auto-register mapped custom-field keys only after the source bytes and
	// frozen consent contract have passed execution-boundary verification, and
	// only where the workspace's validator mode allows it.
	if j.CustomFieldPolicy.AutoCreate {
		if err := ensureCustomProperties(ctx, w.Pool, j.TenantID, j.Mapping); err != nil {
			return w.markFailedJob(ctx, j, "property_schema_failed", err)
		}
	}
	if j.CustomFieldPolicy.Validate && hasMappedCustomFields(j.Mapping) {
		validator := &customfields.Validator{Repo: &customfields.Repo{Pool: w.Pool}}
		var schemaErr error
		j.CustomFieldSchema, schemaErr = validator.PrepareReadOnly(ctx, j.TenantID, nil)
		if schemaErr != nil {
			return w.markFailedJob(ctx, j, "property_schema_failed", schemaErr)
		}
	}
	cr := csv.NewReader(bytes.NewReader(body))
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	header, herr := cr.Read()
	if herr != nil {
		return w.markFailedJob(ctx, j, "source_header_invalid", herr)
	}
	if herr := validateSourceHeader(header, j.Mapping); herr != nil {
		return w.markFailedJob(ctx, j, "source_header_invalid", herr)
	}

	// Rehydrate the file-level dedupe set while advancing the durable cursor.
	// Without this, a duplicate after a committed-chunk/crash boundary could be imported
	// even though its first occurrence was already committed.
	seen := map[string]struct{}{}
	skip := j.ProcessedRows
	for skip > 0 {
		row, rerr := cr.Read()
		if rerr == io.EOF {
			return w.markFailedJob(ctx, j, "recovery_cursor_invalid", nil)
		}
		if rerr == nil {
			if email := extractEmail(row, emailCol); email != "" {
				seen[email] = struct{}{}
			}
		}
		skip--
	}

	chunk := make([]numberedRow, 0, j.ChunkSize)
	pendingErrors := make([]rowError, 0)
	var pendingConsumed int64
	totals := processResult{}
	// Row numbering is global across stale-worker recovery. A resumed job has
	// already applied j.ProcessedRows rows, so the next logical row is
	// ProcessedRows+1. Seeding the counter preserves durable error coordinates.
	rowNum := j.ProcessedRows
	flush := func() error {
		if pendingConsumed == 0 {
			return nil
		}
		res, _, applyErr := w.applyChunk(ctx, j, chunk, seen, pendingConsumed, pendingErrors)
		if applyErr != nil {
			return applyErr
		}
		totals.Imported += res.Imported
		totals.Skipped += res.Skipped
		totals.Failed += res.Failed
		totals.VerificationRejected += res.VerificationRejected
		chunk = chunk[:0]
		pendingErrors = pendingErrors[:0]
		pendingConsumed = 0
		return nil
	}

	for {
		cancelled, cancelErr := w.cancelRequested(ctx, j.ID)
		if cancelErr != nil {
			return cancelErr
		}
		if cancelled {
			if err := flush(); err != nil {
				return w.markFailedJob(ctx, j, importChunkFailureCode(err), err)
			}
			return w.markCancelled(ctx, j)
		}
		row, rerr := cr.Read()
		if rerr == io.EOF {
			break
		}
		rowNum++
		pendingConsumed++
		if rerr != nil {
			pendingErrors = append(pendingErrors, rowError{
				RowNumber: rowNum, Code: "csv_parse_error", Message: "CSV row could not be parsed",
			})
		} else {
			chunk = append(chunk, numberedRow{Number: rowNum, Values: row})
		}
		if pendingConsumed >= int64(j.ChunkSize) && j.OnExisting != "error" {
			if err := flush(); err != nil {
				return w.markFailedJob(ctx, j, importChunkFailureCode(err), err)
			}
		}
	}
	if err := flush(); err != nil {
		return w.markFailedJob(ctx, j, importChunkFailureCode(err), err)
	}
	// Catch a mutation to an already-processed or otherwise untouched source
	// identity that happened during this run. The expensive all-source read is
	// deliberately paid only at the execution boundaries, not per chunk.
	_, _, finalStateFingerprint, stateErr := deps.dryRunExistingEmails(ctx, j.TenantID, j.SourceEmails)
	if stateErr != nil {
		return w.markFailedJob(ctx, j, "preflight_state_check_failed", stateErr)
	}
	expectedFinalStateFingerprint := j.ExecutionStateFingerprint
	if expectedFinalStateFingerprint == "" {
		// A valid header-only import has no chunk from which to persist an
		// execution watermark; its unchanged preflight state is final.
		expectedFinalStateFingerprint = j.PreflightStateFingerprint
	}
	if expectedFinalStateFingerprint == "" || finalStateFingerprint != expectedFinalStateFingerprint {
		return w.markFailedJob(ctx, j, "preflight_state_changed", nil)
	}
	finalPolicy, policyErr := resolveCustomFieldImportPolicy(ctx, w.Pool, j.TenantID, j.Options.AutoCreateProps)
	if policyErr != nil {
		return w.markFailedJob(ctx, j, "catalog_check_failed", policyErr)
	}
	finalCatalogFingerprint, catalogErr := customFieldCatalogFingerprint(ctx, w.Pool, j.TenantID, j.Mapping, finalPolicy)
	if catalogErr != nil {
		return w.markFailedJob(ctx, j, "catalog_check_failed", catalogErr)
	}
	if finalCatalogFingerprint != j.PreflightCatalogFingerprint {
		return w.markFailedJob(ctx, j, "preflight_state_changed", nil)
	}
	return w.markReady(ctx, j, totals)
}

const importVerificationPollInterval = 5 * time.Second

// ensureVerificationReady is the import's fail-closed admission barrier. It
// creates (or idempotently reuses) one durable verification job, yields the
// import while that job runs, and exposes immutable completed decisions only
// after their completeness has been checked against the frozen source set.
func (w *Worker) ensureVerificationReady(ctx context.Context, j *claimedJob, emails []string) (bool, error) {
	mode, err := normalizeImportVerificationMode(j.VerificationMode)
	if err != nil {
		if markErr := w.markVerificationFailed(ctx, j, ""); markErr != nil {
			return false, markErr
		}
		return false, w.markFailedJob(ctx, j, "email_verification_failed", err)
	}
	if mode == ImportVerificationModeOff {
		j.VerificationDecisions = nil
		return true, nil
	}
	if w.Verification == nil {
		if markErr := w.markVerificationFailed(ctx, j, ""); markErr != nil {
			return false, markErr
		}
		return false, w.markFailedJob(ctx, j, "email_verification_unavailable",
			errors.New("subscriber import verification adapter is unavailable"))
	}

	var run ImportVerificationRun
	if j.VerificationJobID == "" {
		run, err = w.Verification.EnsureImportVerification(ctx, j.TenantID, j.ID, mode, emails)
	} else {
		run, err = w.Verification.GetImportVerification(ctx, j.TenantID, j.ID,
			j.VerificationJobID, mode)
	}
	if err != nil {
		if errors.Is(err, ErrImportVerificationBinding) {
			if markErr := w.markVerificationFailed(ctx, j, j.VerificationJobID); markErr != nil {
				return false, markErr
			}
			return false, w.markFailedJob(ctx, j, "email_verification_failed", err)
		}
		// No import mutation has happened. Yield promptly instead of waiting for
		// the stale-running timeout; the deterministic idempotency key ensures a
		// retry reuses any job committed before the transient error.
		if yieldErr := w.yieldVerificationRetry(ctx, j); yieldErr != nil {
			return false, yieldErr
		}
		if w.Logger != nil {
			w.Logger.Warn("subscriber_import: verification state temporarily unavailable",
				"tenant", j.TenantID, "import", j.ID,
				"error_class", subscriberImportLogErrorClass(err))
		}
		return false, nil
	}
	if run.JobID == "" {
		if markErr := w.markVerificationFailed(ctx, j, ""); markErr != nil {
			return false, markErr
		}
		return false, w.markFailedJob(ctx, j, "email_verification_failed",
			errors.New("verification adapter returned no durable job"))
	}
	if j.VerificationJobID != "" && j.VerificationJobID != run.JobID {
		if markErr := w.markVerificationFailed(ctx, j, j.VerificationJobID); markErr != nil {
			return false, markErr
		}
		return false, w.markFailedJob(ctx, j, "email_verification_failed",
			errors.New("verification adapter changed the bound job"))
	}
	// Close the race where cancellation is requested after the import was
	// claimed but while Ensure was committing the durable verification job.
	// Persist the binding first; markCancelled then cancels it before making
	// the import terminal, so no paid work can be orphaned from the import.
	if cancelled, cancelErr := w.cancelRequested(ctx, j.ID); cancelErr == nil && cancelled {
		switch run.State {
		case ImportVerificationStatePending, ImportVerificationStateRunning:
			if err := w.yieldForVerification(ctx, j, run); err != nil {
				return false, err
			}
		case ImportVerificationStateCompleted:
			if err := w.markVerificationCompleted(ctx, j, run.JobID); err != nil {
				return false, err
			}
		case ImportVerificationStateFailed:
			if err := w.markVerificationFailed(ctx, j, run.JobID); err != nil {
				return false, err
			}
		default:
			if err := w.markVerificationFailed(ctx, j, run.JobID); err != nil {
				return false, err
			}
		}
		return false, w.markCancelled(ctx, j)
	}

	switch run.State {
	case ImportVerificationStatePending, ImportVerificationStateRunning:
		if err := w.yieldForVerification(ctx, j, run); err != nil {
			return false, err
		}
		if err := w.Verification.ActivateImportVerification(ctx, j.TenantID, j.ID, run.JobID, mode); err != nil {
			if errors.Is(err, ErrImportVerificationBinding) {
				if markErr := w.markVerificationFailed(ctx, j, run.JobID); markErr != nil {
					return false, markErr
				}
				return false, w.markFailedJob(ctx, j, "email_verification_failed", err)
			}
			if yieldErr := w.yieldVerificationRetry(ctx, j); yieldErr != nil {
				return false, errors.Join(err, yieldErr)
			}
			return false, nil
		}
		// Re-check after the durable link is visible. A concurrent HTTP cancel
		// that raced Ensure now sees and cancels this exact job; if it only set
		// cancel_requested while the import was running, this worker closes the
		// loop immediately instead of waiting for the next poll.
		cancelled, cancelErr := w.cancelRequested(ctx, j.ID)
		if cancelErr != nil {
			return false, cancelErr
		}
		if cancelled {
			return false, w.markCancelled(ctx, j)
		}
		return false, nil
	case ImportVerificationStateFailed:
		if err := w.markVerificationFailed(ctx, j, run.JobID); err != nil {
			return false, err
		}
		return false, w.markFailedJob(ctx, j, "email_verification_failed",
			fmt.Errorf("durable verification job failed with code %q", run.FailureCode))
	case ImportVerificationStateCompleted:
		if err := validateImportVerificationDecisions(emails, run.Decisions); err != nil {
			if markErr := w.markVerificationFailed(ctx, j, run.JobID); markErr != nil {
				return false, markErr
			}
			return false, w.markFailedJob(ctx, j, "email_verification_results_incomplete", err)
		}
		if err := w.markVerificationCompleted(ctx, j, run.JobID); err != nil {
			return false, err
		}
		j.VerificationDecisions = run.Decisions
		return true, nil
	default:
		if markErr := w.markVerificationFailed(ctx, j, run.JobID); markErr != nil {
			return false, markErr
		}
		return false, w.markFailedJob(ctx, j, "email_verification_failed",
			fmt.Errorf("verification adapter returned unsupported state %q", run.State))
	}
}

func (w *Worker) yieldVerificationRetry(ctx context.Context, j *claimedJob) error {
	tx, err := db.WithTenantWorker(ctx, w.Pool, j.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
	SET status = CASE WHEN verification_mode = 'off' THEN 'queued' ELSE 'verification_queued' END,
	   verification_state = 'pending',
       verification_completed_at = NULL,
       next_scheduled_at = now() + $3::interval, last_chunk_at = now()
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ('running', 'verification_running')
   AND claim_generation = $4 AND verification_mode IN ('local', 'full')`,
		j.TenantID, j.ID, durationAsPostgresInterval(importVerificationPollInterval),
		j.ClaimGeneration)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("subscriber import verification retry claim was superseded")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	j.VerificationState = ImportVerificationStatePending
	return nil
}

func (w *Worker) yieldForVerification(ctx context.Context, j *claimedJob, run ImportVerificationRun) error {
	tx, err := db.WithTenantWorker(ctx, w.Pool, j.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
	SET status = CASE WHEN verification_mode = 'off' THEN 'queued' ELSE 'verification_queued' END,
       verification_job_id = $3::uuid,
       verification_state = $4,
       verification_completed_at = NULL,
       next_scheduled_at = now() + $5::interval,
       last_chunk_at = now()
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ('running', 'verification_running')
   AND claim_generation = $6
   AND verification_mode IN ('local', 'full')
   AND (verification_job_id IS NULL OR verification_job_id = $3::uuid)`,
		j.TenantID, j.ID, run.JobID, run.State,
		durationAsPostgresInterval(importVerificationPollInterval), j.ClaimGeneration)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("subscriber import verification claim was superseded")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	j.VerificationJobID = run.JobID
	j.VerificationState = run.State
	return nil
}

func durationAsPostgresInterval(d time.Duration) string {
	return fmt.Sprintf("%d microseconds", d.Microseconds())
}

func (w *Worker) markVerificationCompleted(ctx context.Context, j *claimedJob, jobID string) error {
	tx, err := db.WithTenantWorker(ctx, w.Pool, j.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET verification_job_id = $3::uuid,
       verification_state = 'completed',
       verification_completed_at = COALESCE(verification_completed_at, now())
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ('running', 'verification_running')
   AND claim_generation = $4
   AND verification_mode IN ('local', 'full')
   AND (verification_job_id IS NULL OR verification_job_id = $3::uuid)`,
		j.TenantID, j.ID, jobID, j.ClaimGeneration)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("subscriber import verification completion claim was superseded")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	j.VerificationJobID = jobID
	j.VerificationState = ImportVerificationStateCompleted
	return nil
}

func (w *Worker) markVerificationFailed(ctx context.Context, j *claimedJob, jobID string) error {
	tx, err := db.WithTenantWorker(ctx, w.Pool, j.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if jobID == "" {
		jobID = j.VerificationJobID
	}
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET verification_job_id = COALESCE(verification_job_id, NULLIF($3, '')::uuid),
       verification_state = 'failed',
       verification_completed_at = COALESCE(verification_completed_at, now())
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ('running', 'verification_running')
   AND claim_generation = $4
   AND verification_mode IN ('local', 'full')
   AND ($3 = '' OR verification_job_id IS NULL OR verification_job_id = $3::uuid)`,
		j.TenantID, j.ID, jobID, j.ClaimGeneration)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("subscriber import verification failure claim was superseded")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	j.VerificationJobID = jobID
	j.VerificationState = ImportVerificationStateFailed
	return nil
}

func (w *Worker) cancelVerification(ctx context.Context, j *claimedJob) error {
	if w == nil || j == nil || j.VerificationJobID == "" {
		return nil
	}
	if w.Verification == nil {
		return errors.New("subscriber import verification adapter is unavailable for cancellation")
	}
	return w.Verification.CancelImportVerification(ctx, j.TenantID, j.VerificationJobID)
}

// applyChunk inserts up to ChunkSize rows under the tenant's RLS in a
// single tx via the SUB-110 batched COPY → staged-MERGE path. Invalid /
// file-duplicate rows are filtered (and recorded) by prepareBatchRows;
// the survivors are COPY'd into a per-tx staging table and merged into
// `subscribers` in one statement — no per-row SAVEPOINT churn.
//
// Behavioural note vs. the old per-row path: a DB-level error now aborts
// the whole chunk's accepted set (the merge is one statement) rather than
// failing a single row. The pre-merge validation (invalid email, dupes)
// is unchanged and still per-row exact.
func (w *Worker) applyChunk(ctx context.Context, j *claimedJob, rows []numberedRow, seen map[string]struct{}, consumed int64, preErrors []rowError) (processResult, []rowError, error) {
	baseRes := processResult{}
	// Pure validation + shaping (invalid emails → errors, in-file dupes →
	// skips). Done before touching the DB so the counters stay exact.
	batch := prepareNumberedBatchRows(rows, j.Mapping, j.Options, seen)
	baseRes.VerificationRejected = enforceImportVerification(&batch, j.VerificationDecisions)
	errs := append(append([]rowError(nil), preErrors...), batch.Errors...)
	baseRes.Failed = int64(len(errs))
	baseRes.Skipped = batch.Skipped

	if err := w.validateChunkCustomFields(ctx, j, &batch, &errs, &baseRes); err != nil {
		return baseRes, errs, err
	}

	for i := range batch.Accepted {
		batch.Accepted[i].RowFingerprint = sourceRowFingerprint(j.ID, j.Options.SourceFingerprint, batch.Accepted[i].RowNumber)
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		res := baseRes
		tx, err := db.WithTenantOptions(ctx, w.Pool, j.TenantID, pgx.TxOptions{IsoLevel: pgx.Serializable})
		if err != nil {
			return res, errs, fmt.Errorf("open atomic import chunk: %w", err)
		}
		var activeGeneration int64
		if err := tx.QueryRow(ctx, `
SELECT claim_generation
  FROM subscriber_imports
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ('running', 'verification_running')
 FOR UPDATE`, j.TenantID, j.ID).Scan(&activeGeneration); err != nil {
			_ = tx.Rollback(ctx)
			return res, errs, fmt.Errorf("lock import claim: %w", err)
		}
		if activeGeneration != j.ClaimGeneration {
			_ = tx.Rollback(ctx)
			return res, errs, errors.New("subscriber import claim was superseded")
		}
		// Re-check erasure inside this serializable attempt: a contact deleted
		// or erased since the preflight is refused here even though Review
		// predicted a write. Per-attempt copies keep a 40001 retry exact.
		candidateEmails := make([]string, 0, len(batch.Accepted))
		for _, candidate := range batch.Accepted {
			candidateEmails = append(candidateEmails, candidate.Email)
		}
		erased, err := suppressions.ErasedAddresses(ctx, tx, j.TenantID, candidateEmails)
		if err != nil {
			_ = tx.Rollback(ctx)
			lastErr = err
			if isImportRetryableTxError(err) {
				continue
			}
			return res, errs, fmt.Errorf("check erased import addresses: %w", err)
		}
		writable, erasureErrs := withoutErasedCandidates(batch.Accepted, erased)
		attemptErrs := append(append([]rowError(nil), errs...), erasureErrs...)
		res.Failed += int64(len(erasureErrs))
		stateEmails := make([]string, 0, len(writable))
		for _, candidate := range writable {
			stateEmails = append(stateEmails, candidate.Email)
		}
		beforeStates := map[string]existingSubscriberState{}
		if len(stateEmails) > 0 {
			if err := stageSubscriberStateEmails(ctx, tx, stateEmails); err != nil {
				_ = tx.Rollback(ctx)
				return res, errs, fmt.Errorf("stage execution state: %w", err)
			}
			_, beforeStates, _, err = readStagedSubscriberStates(ctx, tx, j.TenantID, stateEmails)
			if err != nil {
				_ = tx.Rollback(ctx)
				return res, errs, fmt.Errorf("read execution state: %w", err)
			}
			for _, email := range stateEmails {
				actual, actualExists := beforeStates[email]
				expected, expectedExists := j.ExpectedStates[email]
				if !sameExistingSubscriberState(actual, actualExists, expected, expectedExists) {
					_ = tx.Rollback(ctx)
					return res, errs, errors.New("subscriber state changed outside the reviewed execution watermark")
				}
			}
		}
		expectedStateFingerprint := j.PreflightStateFingerprint
		if j.ExecutionStateFingerprint != "" {
			expectedStateFingerprint = j.ExecutionStateFingerprint
		}
		if expectedStateFingerprint == "" || j.SourcePositions == nil || j.ExpectedStates == nil {
			_ = tx.Rollback(ctx)
			return res, errs, errors.New("subscriber execution watermark was not hydrated")
		}

		var bres batchUpsertResult
		if len(writable) > 0 {
			bres, err = executeBatchedUpsert(ctx, tx, j.TenantID, j.OnExisting, writable, j.Options)
			if err != nil {
				_ = tx.Rollback(ctx)
				lastErr = err
				if isImportRetryableTxError(err) {
					continue
				}
				return res, errs, err
			}
		}
		// The imported audience joins the list the wizard named, in this same
		// transaction: a committed chunk and its memberships stand or fall
		// together.
		if listErr := addImportedToTargetList(ctx, tx, j.TenantID, j.TargetListID, stateEmails); listErr != nil {
			_ = tx.Rollback(ctx)
			lastErr = listErr
			if isImportRetryableTxError(listErr) {
				continue
			}
			return res, errs, listErr
		}
		receiptsWritten, proofErr := recordAppliedConsentProofs(ctx, tx, j, bres.Applied)
		if proofErr != nil {
			_ = tx.Rollback(ctx)
			lastErr = proofErr
			if isImportRetryableTxError(proofErr) {
				continue
			}
			return res, errs, fmt.Errorf("atomic consent proof: %w", proofErr)
		}
		res.Imported += bres.Imported
		res.Skipped += bres.Skipped
		var sendableAfter, protectedExisting int64
		for _, applied := range bres.Applied {
			if applied.SendableAfter {
				sendableAfter++
			}
			if applied.Operation == "updated" && !applied.SendableAfter {
				protectedExisting++
			}
		}
		if recordErr := insertImportRowErrors(ctx, tx, j, attemptErrs); recordErr != nil {
			_ = tx.Rollback(ctx)
			return res, errs, fmt.Errorf("record import row outcomes: %w", recordErr)
		}
		postStates := map[string]existingSubscriberState{}
		if len(stateEmails) > 0 {
			_, postStates, _, err = readStagedSubscriberStates(ctx, tx, j.TenantID, stateEmails)
			if err != nil {
				_ = tx.Rollback(ctx)
				return res, errs, fmt.Errorf("read post-chunk execution state: %w", err)
			}
		}
		postStateFingerprint, err := advanceSubscriberStateFingerprint(
			expectedStateFingerprint, j.SourcePositions, stateEmails, beforeStates, postStates,
		)
		if err != nil {
			_ = tx.Rollback(ctx)
			return res, errs, fmt.Errorf("advance execution state watermark: %w", err)
		}
		progressTag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET processed_rows = processed_rows + $3,
       rows_imported = rows_imported + $4,
       rows_skipped = rows_skipped + $5,
       rows_failed = rows_failed + $6,
	       rows_sendable_after = rows_sendable_after + $7,
	       rows_protected_existing = rows_protected_existing + $8,
	       consent_receipts_written = consent_receipts_written + $9,
	       rows_verification_rejected = rows_verification_rejected + $10,
	   execution_state_fingerprint = $11,
       last_chunk_at = now()
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ('running', 'verification_running')
	   AND claim_generation = $12`,
			j.TenantID, j.ID, consumed, res.Imported, res.Skipped, res.Failed,
			sendableAfter, protectedExisting, receiptsWritten, res.VerificationRejected,
			postStateFingerprint, j.ClaimGeneration)
		if err != nil {
			_ = tx.Rollback(ctx)
			lastErr = err
			if isImportRetryableTxError(err) {
				continue
			}
			return res, errs, fmt.Errorf("record atomic chunk progress: %w", err)
		}
		if progressTag.RowsAffected() != 1 {
			_ = tx.Rollback(ctx)
			return res, errs, errors.New("subscriber import claim was superseded before progress commit")
		}
		if err := tx.Commit(ctx); err != nil {
			lastErr = err
			if isImportRetryableTxError(err) {
				continue
			}
			return res, errs, fmt.Errorf("commit atomic import chunk: %w", err)
		}
		j.ExecutionStateFingerprint = postStateFingerprint
		for _, email := range stateEmails {
			state, exists := postStates[email]
			if exists {
				j.ExpectedStates[email] = state
			} else {
				delete(j.ExpectedStates, email)
			}
		}
		return res, attemptErrs, nil
	}
	return baseRes, errs, fmt.Errorf("atomic import chunk exhausted serialization retries: %w", lastErr)
}

func isImportRetryableTxError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01")
}

func insertImportRowErrors(ctx context.Context, tx pgx.Tx, j *claimedJob, errs []rowError) error {
	for _, rowErr := range errs {
		if rowErr.RowNumber < 1 || rowErr.Code == "" || rowErr.Message == "" {
			return errors.New("invalid privacy-safe row outcome")
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_import_errors
  (tenant_id, import_id, row_number, email, error, raw_row, error_code,
   email_sha256, raw_row_sha256, expires_at)
VALUES ($1::uuid, $2::uuid, $3, NULL, $4, NULL, $5, NULL, NULL,
        now() + interval '30 days')`,
			j.TenantID, j.ID, rowErr.RowNumber, rowErr.Message, rowErr.Code); err != nil {
			return err
		}
	}
	return nil
}

// ensureCanonicalAddressProjection materializes the per-address consent
// projection row for an imported subscriber inside the chunk transaction.
//
// Migration 1766 made subscribers.consent_email_marketing_at (which this
// importer writes for a reviewed consent contract) legal only while the exact
// canonical subscriber_emails row carries a 'proven' terminal decision. That
// state is produced exclusively by refresh_subscriber_email_consent_projection,
// which the consent_records / subscriber_import_consent_receipts insert
// triggers call — and which returns 'missing_address' without proving anything
// when no address row exists yet.
//
// For a brand-new subscriber the address row is created by the DEFERRED
// subscribers_reconcile_email_identity trigger at COMMIT, i.e. after the proof
// ledger rows have already been written, and it is initialized failed_closed by
// initialize_subscriber_email_consent_classification. Nothing re-folds it, so
// every consent-bearing import of a new address aborted at commit with
// "raw email-marketing purpose projection requires latest exact grant
// evidence". Creating the address up front lets the receipt-driven refresh fold
// the import approval chain into a proven decision in the same transaction.
//
// is_primary stays false here: the deferred identity reconciler promotes the
// canonical address at commit, and claiming primary early would race the
// partial one-primary unique index for an existing profile. ON CONFLICT DO
// NOTHING keeps the step idempotent, including for an address row the
// restrictive positive-visibility policy hides from this role.
//
// The call site is ordered deliberately: strictly AFTER the consent_records
// insert and strictly BEFORE the receipt insert. An import grant is only valid
// once the approval/receipt chain is complete, so a refresh triggered by the
// consent_records insert alone folds "invalid_grant" and clears
// consent_email_marketing_at — which then trips 1761's
// validate_subscriber_import_consent_receipt_insert
// ("receipt outcome does not match subscriber state") because the receipt
// asserts sendable_after. Creating the address after the record keeps that
// refresh a no-op ('missing_address'), and the receipt's own AFTER-INSERT
// refresh — which runs once the chain is complete — is the one that folds the
// proven decision.
func ensureCanonicalAddressProjection(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, email string) error {
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails (tenant_id, subscriber_id, email, is_primary, consent_status)
VALUES ($1::uuid, $2::uuid, $3::citext, false, 'never_subscribed')
ON CONFLICT DO NOTHING`, tenantID, subscriberID, email); err != nil {
		return fmt.Errorf("ensure canonical consent address projection: %w", err)
	}
	return nil
}

func recordAppliedConsentProofs(ctx context.Context, tx pgx.Tx, j *claimedJob, applied []appliedSubscriber) (int64, error) {
	if !j.Options.hasConsent() || len(applied) == 0 {
		return 0, nil
	}
	consentFingerprint := j.Options.consentFingerprint()
	var written int64
	for _, row := range applied {
		if row.ID == "" || row.RowFingerprint == "" {
			return written, errors.New("applied subscriber identity is incomplete")
		}
		if row.Operation == "updated" && row.StatusBefore != row.StatusAfter {
			return written, errors.New("existing subscriber eligibility status changed during import")
		}
		// Serialize one logical source row across crash recovery or a stale-job
		// reclaim. This avoids an orphan consent_records row racing the unique
		// receipt key.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, row.RowFingerprint); err != nil {
			return written, err
		}
		evidenceFingerprint := importEvidenceFingerprint(consentFingerprint, row.RowFingerprint)
		var existingConsentRecordID, existingSubscriberID, existingEvidenceFingerprint string
		err := tx.QueryRow(ctx, `
SELECT consent_record_id::text, subscriber_id::text, evidence_fingerprint
  FROM subscriber_import_consent_receipts
 WHERE tenant_id = $1::uuid AND import_id = $2::uuid AND source_row_fingerprint = $3`,
			j.TenantID, j.ID, row.RowFingerprint).
			Scan(&existingConsentRecordID, &existingSubscriberID, &existingEvidenceFingerprint)
		if err == nil {
			if existingSubscriberID != row.ID || existingEvidenceFingerprint != evidenceFingerprint {
				return written, errors.New("idempotency receipt conflicts with the frozen import evidence")
			}
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return written, err
		}

		evidence, err := json.Marshal(j.Options.proofInput(
			j.TenantID, j.ID, j.ConsentApprovalID, row.ID, row.Email,
			row.RowFingerprint, evidenceFingerprint,
		).Evidence)
		if err != nil {
			return written, err
		}
		var consentRecordID string
		if err := tx.QueryRow(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    source_url, captured_at, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'granted', $4,
    $5, $6::timestamptz, $7::jsonb
)
RETURNING id::text`,
			j.TenantID, row.ID, row.Email, proofSource(j.Options.ConsentSource),
			nil, j.Options.ConsentCapturedAt, string(evidence)).Scan(&consentRecordID); err != nil {
			return written, err
		}
		// Strictly between the two ledger writes: see
		// ensureCanonicalAddressProjection.
		if err := ensureCanonicalAddressProjection(ctx, tx, j.TenantID, row.ID, row.Email); err != nil {
			return written, err
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_import_consent_receipts (
    tenant_id, import_id, approval_id, subscriber_id, consent_record_id,
	 source_row_fingerprint, evidence_fingerprint, source_file_fingerprint,
    operation, status_before, status_after, sendable_before, sendable_after,
	eligibility_transition_applied
) VALUES (
	$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
	$6, $7, $8, $9, NULLIF($10, ''), $11, $12, $13, $14
)`,
			j.TenantID, j.ID, j.ConsentApprovalID, row.ID, consentRecordID,
			row.RowFingerprint, evidenceFingerprint, j.Options.SourceFingerprint,
			row.Operation, row.StatusBefore, row.StatusAfter,
			row.SendableBefore, row.SendableAfter, row.Operation == "created"); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

func (w *Worker) purgeExpiredErrors(ctx context.Context) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM subscriber_import_errors
 WHERE id IN (
       SELECT id
         FROM subscriber_import_errors
        WHERE expires_at <= now()
        ORDER BY expires_at, id
        LIMIT 1000
        FOR UPDATE SKIP LOCKED
 )`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type expiredImportArtifact struct {
	ID        string
	ObjectKey string
	Status    string
}

// purgeExpiredArtifacts leases due terminal/abandoned objects before deleting
// them outside a DB transaction. Object deletion is idempotent; a failed
// delete leaves the leased timestamp to retry on a later tick. Review-only
// raw material is cleared after its separate 24-hour support window.
func (w *Worker) purgeExpiredArtifacts(ctx context.Context) error {
	if w.Storage != nil {
		tx, err := db.WithWorkerScope(ctx, w.Pool)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
WITH due AS (
	SELECT id
	  FROM subscriber_imports
	 WHERE object_key <> ''
	   AND source_delete_after IS NOT NULL
	   AND source_delete_after <= now()
	   AND status IN ('preview','ready','failed','cancelled')
	 ORDER BY source_delete_after, id
	 LIMIT 100
	 FOR UPDATE SKIP LOCKED
)
UPDATE subscriber_imports i
   SET source_delete_after = now() + interval '10 minutes'
  FROM due
 WHERE i.id = due.id
RETURNING i.id::text, i.object_key, i.status`)
		if err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		leased := make([]expiredImportArtifact, 0)
		for rows.Next() {
			var artifact expiredImportArtifact
			if err := rows.Scan(&artifact.ID, &artifact.ObjectKey, &artifact.Status); err != nil {
				rows.Close()
				_ = tx.Rollback(ctx)
				return err
			}
			leased = append(leased, artifact)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			_ = tx.Rollback(ctx)
			return err
		}
		rows.Close()
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		for _, artifact := range leased {
			if err := w.Storage.Delete(ctx, artifact.ObjectKey); err != nil {
				if w.Logger != nil {
					w.Logger.Warn("subscriber_import source purge failed", "import", artifact.ID,
						"error_class", subscriberImportLogErrorClass(err))
				}
				continue
			}
			finishTx, err := db.WithWorkerScope(ctx, w.Pool)
			if err != nil {
				return err
			}
			_, err = finishTx.Exec(ctx, `
UPDATE subscriber_imports
   SET object_key = '', bytes_total = 0, source_delete_after = NULL,
	   status = CASE WHEN status = 'preview' THEN 'cancelled' ELSE status END,
	   completed_at = CASE WHEN status = 'preview' THEN now() ELSE completed_at END,
	   error_code = CASE WHEN status = 'preview' THEN NULL ELSE error_code END,
	   error = CASE WHEN status = 'preview' THEN NULL ELSE error END,
	   review_data_expires_at = CASE WHEN status = 'preview' THEN now() ELSE review_data_expires_at END
 WHERE id = $1::uuid AND object_key = $2
	AND status IN ('preview','ready','failed','cancelled')`, artifact.ID, artifact.ObjectKey)
			if err == nil {
				err = finishTx.Commit(ctx)
			} else {
				_ = finishTx.Rollback(ctx)
			}
			if err != nil {
				return err
			}
			if w.Logger != nil {
				w.Logger.Info("subscriber_import source purged", "import", artifact.ID, "previous_status", artifact.Status)
			}
		}
	}

	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET sample_rows = '[]'::jsonb,
	   dry_run_results = NULL,
	   mapping = '{"headers":[],"columns":[],"rows":0}'::jsonb,
	   original_filename = 'expired-import.csv'
 WHERE review_data_expires_at <= now()
	AND status IN ('ready','failed','cancelled')
	AND (sample_rows <> '[]'::jsonb OR dry_run_results IS NOT NULL
	     OR mapping <> '{"headers":[],"columns":[],"rows":0}'::jsonb
	     OR original_filename <> 'expired-import.csv')`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// cancelRequested checks the cancel flag. Cheap — read by row id.
func (w *Worker) cancelRequested(ctx context.Context, importID string) (bool, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var cancel bool
	err = tx.QueryRow(ctx,
		`SELECT cancel_requested FROM subscriber_imports WHERE id = $1::uuid`,
		importID).Scan(&cancel)
	return cancel, err
}

func (w *Worker) markReady(ctx context.Context, job *claimedJob, totals processResult) error {
	return w.finalizeClaim(ctx, job, "ready", "", "")
}

func (w *Worker) markCancelled(ctx context.Context, job *claimedJob) error {
	if err := w.cancelLinkedVerificationBeforeTerminal(ctx, job); err != nil {
		return w.deferTerminalForVerificationCancellation(ctx, job, err)
	}
	if err := w.markVerificationTerminalFailure(ctx, job); err != nil {
		return err
	}
	return w.finalizeClaim(ctx, job, "cancelled", "", "")
}

func (w *Worker) markFailedJob(ctx context.Context, job *claimedJob, code string, cause error) error {
	if cause != nil && w.Logger != nil {
		w.Logger.Warn("subscriber_import execution failure",
			"tenant", job.TenantID, "import", job.ID, "code", code,
			"error_class", subscriberImportLogErrorClass(cause))
	}
	if err := w.cancelLinkedVerificationBeforeTerminal(ctx, job); err != nil {
		return w.deferTerminalForVerificationCancellation(ctx, job, err)
	}
	if err := w.markVerificationTerminalFailure(ctx, job); err != nil {
		return err
	}
	return w.finalizeClaim(ctx, job, "failed", safeImportJobErrorCode(code, "failed"), safeImportJobErrorMessage(code, "failed"))
}

func (w *Worker) markVerificationTerminalFailure(ctx context.Context, job *claimedJob) error {
	if job == nil || job.VerificationMode == ImportVerificationModeOff ||
		job.VerificationState == ImportVerificationStateCompleted ||
		job.VerificationState == ImportVerificationStateFailed {
		return nil
	}
	return w.markVerificationFailed(ctx, job, job.VerificationJobID)
}

func (w *Worker) cancelLinkedVerificationBeforeTerminal(ctx context.Context, job *claimedJob) error {
	if job == nil || job.VerificationJobID == "" {
		return nil
	}
	switch job.VerificationState {
	case ImportVerificationStateCompleted, ImportVerificationStateOff:
		return nil
	default:
		return w.cancelVerification(ctx, job)
	}
}

func (w *Worker) deferTerminalForVerificationCancellation(ctx context.Context, job *claimedJob, cause error) error {
	if w.Logger != nil {
		w.Logger.Warn("subscriber_import: linked verification cancellation failed; retrying before terminal transition",
			"tenant", job.TenantID, "import", job.ID,
			"error_class", subscriberImportLogErrorClass(cause))
	}
	if err := w.yieldVerificationRetry(ctx, job); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func (w *Worker) finalizeClaim(ctx context.Context, job *claimedJob, status, code, msg string) error {
	tx, err := db.WithTenantWorker(ctx, w.Pool, job.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET status = $2,
	   error_code = NULLIF($3, ''),
       error = NULLIF($4, ''),
	   completed_at = now(),
	   source_delete_after = now(),
	   review_data_expires_at = LEAST(review_data_expires_at, now() + interval '24 hours')
	WHERE tenant_id = $6::uuid AND id = $1::uuid AND claim_generation = $5
	  AND status IN ('running', 'verification_running')`,
		job.ID, status, code, msg, job.ClaimGeneration, job.TenantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// A newer stale-job recovery claim owns the row. The old worker must
		// not overwrite its lifecycle state.
		return nil
	}
	return tx.Commit(ctx)
}

// importChunkFailureCode names the terminal failure a chunk error records. A
// target list deleted mid-import is called out by name: "chunk_failed" would
// have sent the operator looking at their CSV for a problem that is not in it.
func importChunkFailureCode(err error) string {
	if errors.Is(err, lists.ErrListIDNotMapped) {
		return "target_list_missing"
	}
	return "chunk_failed"
}

func safeImportJobErrorCode(code, status string) string {
	if status != "failed" {
		return ""
	}
	switch code {
	case "storage_unavailable", "mapping_invalid", "collision_strategy_invalid",
		"source_open_failed", "source_read_failed", "source_integrity_failed",
		"consent_contract_invalid", "consent_approval_missing", "source_validation_failed",
		"preflight_state_check_failed", "catalog_check_failed", "preflight_state_changed",
		"preflight_conflicts", "property_schema_failed", "source_header_invalid",
		"recovery_cursor_invalid", "chunk_failed", "target_list_missing",
		"email_verification_unavailable",
		"email_verification_failed", "email_verification_results_incomplete":
		return code
	default:
		return "import_failed"
	}
}

func safeImportJobErrorMessage(code, status string) string {
	if status != "failed" {
		return ""
	}
	switch safeImportJobErrorCode(code, status) {
	case "storage_unavailable":
		return "Import storage is temporarily unavailable."
	case "mapping_invalid":
		return "The saved column mapping is invalid; review and upload the file again."
	case "collision_strategy_invalid":
		return "The saved existing-subscriber strategy is invalid."
	case "source_open_failed", "source_read_failed":
		return "The uploaded source could not be read."
	case "source_integrity_failed":
		return "The uploaded source no longer matches the reviewed file."
	case "consent_contract_invalid", "consent_approval_missing":
		return "The reviewed consent contract could not be verified."
	case "source_validation_failed", "source_header_invalid":
		return "The uploaded source no longer satisfies the reviewed CSV contract."
	case "preflight_state_check_failed", "catalog_check_failed":
		return "The reviewed import state could not be revalidated."
	case "preflight_state_changed":
		return "Subscriber state changed outside the reviewed import; run a fresh preflight."
	case "preflight_conflicts":
		return "The conflict-free import preflight is no longer valid."
	case "property_schema_failed":
		return "Mapped custom fields could not be prepared."
	case "recovery_cursor_invalid":
		return "The durable import recovery cursor no longer matches the source."
	case "chunk_failed":
		return "An atomic import batch failed and was rolled back."
	case "target_list_missing":
		return "The list this import adds contacts to was deleted while it ran, so it stopped. Contacts already imported were kept; choose a list again to import the rest."
	case "email_verification_unavailable":
		return "Import verification is configured but temporarily unavailable; no subscribers were admitted."
	case "email_verification_failed":
		return "The linked email-verification job did not complete safely; no unverified subscribers were admitted."
	case "email_verification_results_incomplete":
		return "The linked email-verification result set was incomplete; no unverified subscribers were admitted."
	default:
		return "The subscriber import failed safely."
	}
}

// rowError is what we persist into subscriber_import_errors.
type rowError struct {
	RowNumber int64
	Code      string
	Message   string
}

// emailColumnIndex finds the email column index in a mapping or -1.
func emailColumnIndex(m migratecsv.Mapping) int {
	for _, c := range m.Columns {
		if c.Kind == migratecsv.KindEmail {
			return c.Index
		}
	}
	return -1
}

func extractEmail(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	email, err := emailidentity.Normalize(row[idx])
	if err != nil {
		return ""
	}
	return email
}

// rowFields is one CSV row shaped into the subscriber columns the upsert
// writes. FullName is what lands in subscribers.full_name and .display_name;
// FirstName / LastName land in the columns migration 0413 promoted, so a
// contact imported from the usual "first_name,last_name" export is sortable
// and addressable by given name instead of hiding in custom_fields.
type rowFields struct {
	FullName  string
	FirstName string
	LastName  string
	Tags      []string
	Custom    map[string]any
}

// buildRowFields walks the mapping once per row, producing the name, tag and
// custom-field payload used by the upsert. KindEmail is skipped because it's
// the conflict key, not a payload.
//
// A file that carries first/last but no full-name column still gets a
// full_name: it is derived here ("Ada Lovelace"), because full_name is what
// every greeting and the directory's name column read.
func buildRowFields(row []string, mapping migratecsv.Mapping) (rowFields, error) {
	out := rowFields{Tags: []string{}, Custom: map[string]any{}}
	mappedFullName := ""
	for _, c := range mapping.Columns {
		if c.Index < 0 || c.Index >= len(row) {
			continue
		}
		val := strings.TrimSpace(row[c.Index])
		if val == "" {
			continue
		}
		switch c.Kind {
		case migratecsv.KindTags:
			for _, t := range strings.FieldsFunc(val, func(r rune) bool {
				return r == ',' || r == ';' || r == '|'
			}) {
				t = strings.TrimSpace(t)
				if t != "" {
					out.Tags = append(out.Tags, t)
				}
			}
		case migratecsv.KindName:
			if err := checkImportedNameLength(val); err != nil {
				return rowFields{}, err
			}
			mappedFullName = val
		case migratecsv.KindFirstName:
			if err := checkImportedNameLength(val); err != nil {
				return rowFields{}, err
			}
			out.FirstName = val
		case migratecsv.KindLastName:
			if err := checkImportedNameLength(val); err != nil {
				return rowFields{}, err
			}
			out.LastName = val
		case migratecsv.KindCustom:
			if len(val) > MaxImportedCustomValueBytes {
				return rowFields{}, fmt.Errorf("custom field %q exceeds the %d-byte limit", canonicalCustomKey(c), MaxImportedCustomValueBytes)
			}
			out.Custom[canonicalCustomKey(c)] = val
		}
	}
	out.FullName = mappedFullName
	if out.FullName == "" {
		out.FullName = strings.TrimSpace(out.FirstName + " " + out.LastName)
		if err := checkImportedNameLength(out.FullName); err != nil {
			return rowFields{}, err
		}
	}
	return out, nil
}

func checkImportedNameLength(val string) error {
	if utf8.RuneCountInString(val) > MaxImportedNameRunes {
		return fmt.Errorf("name exceeds the %d-character limit", MaxImportedNameRunes)
	}
	return nil
}
