// SPDX-License-Identifier: AGPL-3.0-only
//
// dryrun.go — SUB-105: dry-run CSV import.
//
// The Confirm endpoint normally flips the row to 'queued' and the worker
// writes subscribers. A {"dry_run": true} body instead routes here: every
// row is fully validated — email format, in-file dedupe, custom-field
// types against the tenant registry — and the per-row OUTCOME is computed
// without a single write. The operator sees exactly what a real import
// WOULD do (created / updated / skipped / failed counts + the first N row
// details) before committing.
//
// The pass reuses the worker's row-shaping helpers (extractEmail,
// buildRowFields, mergeTags) so the dry-run mirrors the real import's
// behaviour 1:1. Custom-field validation reuses customfields.Validator so
// a type that would fail the live INSERT fails the preview too.
//
// Results land in subscriber_imports.dry_run_results (JSONB) so the
// wizard's Review step can render the preview without re-uploading, and
// the row stays in 'preview' so a subsequent real Confirm still works.

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"

	migratecsv "github.com/postwave/migrate/csv"
)

// maxDryRunRowDetails caps how many per-row detail entries we persist +
// return. A 200k-row file's full per-row list would blow the JSONB column
// and the response; the tallies still cover every row, and the details
// surface enough examples for the operator to spot a systemic mapping
// mistake. Failures are prioritised into the detail list over successes.
const maxDryRunRowDetails = 500

var errImportConfigurationChanged = errors.New("subscriber import configuration changed during preflight")

// dryRunOutcome is the would-be result for one row.
type dryRunOutcome string

const (
	outcomeCreate dryRunOutcome = "create"
	outcomeUpdate dryRunOutcome = "update"
	outcomeSkip   dryRunOutcome = "skip"
	outcomeFail   dryRunOutcome = "fail"
)

// dryRunRow is one row's validation detail.
type dryRunRow struct {
	RowNumber int64         `json:"row_number"`
	Outcome   dryRunOutcome `json:"outcome"`
	ErrorCode string        `json:"error_code,omitempty"`
	Error     string        `json:"error,omitempty"`
}

// dryRunResults is the full preview payload — tallies over every row plus
// a capped detail list. Persisted to dry_run_results and returned to the
// client verbatim.
type dryRunResults struct {
	RowsTotal                 int64       `json:"rows_total"`
	WouldCreate               int64       `json:"would_create"`
	WouldUpdate               int64       `json:"would_update"`
	WouldSkip                 int64       `json:"would_skip"`
	WouldFail                 int64       `json:"would_fail"`
	FileDupes                 int64       `json:"file_dupes"`
	Rows                      []dryRunRow `json:"rows"`
	DetailCapped              bool        `json:"detail_capped"`
	ValidatedAt               string      `json:"validated_at"`
	Authoritative             bool        `json:"authoritative"`
	PreflightFingerprint      string      `json:"preflight_fingerprint"`
	WouldBeSendable           int64       `json:"would_be_sendable"`
	WouldRemainProtected      int64       `json:"would_remain_protected"`
	ConsentContractState      string      `json:"consent_contract_state"`
	StateFingerprint          string      `json:"state_fingerprint"`
	CatalogFingerprint        string      `json:"catalog_fingerprint"`
	ExpiresAt                 string      `json:"expires_at"`
	PreflightVerificationMode string      `json:"preflight_verification_mode"`
	// Verification is the optional email-verification projection. nil
	// when no projector is wired or the projection failed — the preview
	// degrades by omitting the section, never by erroring.
	Verification *VerificationProjection `json:"verification,omitempty"`
}

// dryRunJob is the row state dryRun loads to drive the validation pass.
type dryRunJob struct {
	ObjectKey             string
	SourceFingerprint     string
	Mapping               migratecsv.Mapping
	OnExisting            string
	Options               importOptions
	ExistingStates        map[string]existingSubscriberState
	ConfigurationRevision int64
	// Erased holds the file identities an erasure tombstone protects; their
	// rows fail with erasure_blocked instead of being created or updated.
	Erased map[string]struct{}
	// CustomFieldPolicy decides how mapped custom-field keys and values are
	// judged, exactly as the worker will apply them.
	CustomFieldPolicy customFieldImportPolicy
}

type existingSubscriberState struct {
	Status             string
	Sendable           bool
	Protected          bool
	Tags               []string
	ContentFingerprint string
}

// dryRun handles a Confirm carrying {"dry_run": true}. Validates the file
// without writing, persists + returns the per-row outcomes, and leaves the
// row in 'preview'.
func (d *Deps) dryRun(w http.ResponseWriter, r *http.Request, tenantID, importID string) {
	if d.Storage == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "storage_unavailable",
			"object storage not configured")
		return
	}
	job, err := d.loadDryRunJob(r.Context(), tenantID, importID)
	if err != nil {
		httperror.Write(w, http.StatusConflict, "not_in_preview",
			"job not found or not in preview state")
		return
	}
	canonical, canonicalErr := canonicalizeMapping(job.Mapping, append([]string(nil), job.Mapping.Headers...))
	if canonicalErr != nil {
		writeJSONErr(w, http.StatusConflict, canonicalErr.code, canonicalErr.msg)
		return
	}
	job.Mapping = canonical
	if verr := validateMappingTargets(job.Mapping); verr != nil {
		writeJSONErr(w, http.StatusConflict, verr.code, verr.msg)
		return
	}
	rdr, _, err := d.Storage.Open(r.Context(), job.ObjectKey)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = rdr.Close() }()
	body, err := readBoundedCSV(rdr)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	actualFingerprint, fingerprintErr := sourceFileFingerprintWithVersion(tenantID, body, job.Options.SourceFingerprintKeyVersion)
	if fingerprintErr != nil || job.Options.SourceFingerprintScheme != sourceFingerprintScheme ||
		job.SourceFingerprint == "" || actualFingerprint != job.SourceFingerprint {
		writeJSONErr(w, http.StatusConflict, "source_fingerprint_mismatch",
			"the uploaded object no longer matches the previewed file; upload it again")
		return
	}

	identityScan, scanErr := scanImportIdentities(body, job.Mapping)
	if scanErr != nil {
		writeJSONErr(w, http.StatusUnprocessableEntity, "invalid_csv", scanErr.Error())
		return
	}
	existing, states, stateFingerprint, derr := d.dryRunExistingEmails(r.Context(), tenantID, identityScan.Emails)
	if derr != nil {
		writeSubscriberImportInternal(w, d.Logger, derr, r.Context())
		return
	}
	job.ExistingStates = states
	if job.Erased, derr = d.erasedImportAddresses(r.Context(), tenantID, identityScan.Emails); derr != nil {
		writeSubscriberImportInternal(w, d.Logger, derr, r.Context())
		return
	}
	readOnlySchema, catalogFingerprint, derr := d.dryRunCustomFieldState(r.Context(), tenantID, job)
	if derr != nil {
		writeSubscriberImportInternal(w, d.Logger, derr, r.Context())
		return
	}

	results, err := dryRunValidate(r.Context(), body, job, existing, readOnlySchema, tenantID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	results.Authoritative = true
	verificationMode, modeErr := d.currentImportVerificationMode(r.Context(), tenantID)
	if modeErr != nil {
		httperror.Write(w, http.StatusServiceUnavailable, "verification_policy_unavailable",
			"the import verification policy could not be read; retry the preflight")
		return
	}
	// Verification projection: free, never bills, and omitted entirely
	// on any failure so a mature preview surface cannot regress.
	results.Verification = d.projectVerification(r.Context(), tenantID, identityScan.Emails)
	if results.Verification != nil {
		projectedMode, normalizeErr := normalizeImportVerificationMode(results.Verification.Mode)
		if normalizeErr != nil || projectedMode != verificationMode {
			writeJSONErr(w, http.StatusConflict, "verification_policy_changed",
				"the import verification policy changed during preflight; run it again")
			return
		}
	}
	results.PreflightVerificationMode = verificationMode
	results.StateFingerprint = stateFingerprint
	results.CatalogFingerprint = catalogFingerprint
	results.ExpiresAt = time.Now().UTC().Add(15 * time.Minute).Format(time.RFC3339)
	results.PreflightFingerprint = computePreflightFingerprint(job.SourceFingerprint, job.Mapping, job.OnExisting, job.Options,
		stateFingerprint, catalogFingerprint, verificationMode)
	if job.Options.hasConsent() {
		results.ConsentContractState = "complete"
	} else {
		results.ConsentContractState = "none"
	}

	// Persist the results onto the (still-preview) row so the wizard can
	// re-render the preview without a re-upload.
	if err := d.persistDryRun(r.Context(), tenantID, importID, results,
		int64(len(identityScan.Emails))-int64(len(existing)), int64(len(existing)), identityScan.FileDupes,
		job.ConfigurationRevision); err != nil {
		if errors.Is(err, errImportConfigurationChanged) {
			writeJSONErr(w, http.StatusConflict, "preflight_stale",
				"the import settings changed during validation; run the exhaustive preflight again")
			return
		}
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":              importID,
		"status":          "preview",
		"dry_run":         true,
		"dry_run_results": results,
	})
}

// dryRunCustomFieldState resolves the workspace's custom-field policy once and
// derives everything the preflight binds from that single reading: the schema
// snapshot rows are validated against and the catalog fingerprint Confirm and
// the worker re-check.
func (d *Deps) dryRunCustomFieldState(ctx context.Context, tenantID string, job *dryRunJob) (*customfields.ReadOnlySchema, string, error) {
	policy, err := resolveCustomFieldImportPolicy(ctx, d.Pool, tenantID, job.Options.AutoCreateProps)
	if err != nil {
		return nil, "", err
	}
	job.CustomFieldPolicy = policy
	schema, err := prepareCustomFieldSchema(ctx, d.Pool, tenantID, job.Mapping, policy)
	if err != nil {
		return nil, "", err
	}
	fingerprint, err := customFieldCatalogFingerprint(ctx, d.Pool, tenantID, job.Mapping, policy)
	if err != nil {
		return nil, "", err
	}
	return schema, fingerprint, nil
}

// loadDryRunJob reads the preview row's mapping + options under tenant RLS.
func (d *Deps) loadDryRunJob(ctx context.Context, tenantID, importID string) (*dryRunJob, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		objectKey, onExisting    string
		mappingJSON              []byte
		opts                     importOptions
		jobConfigurationRevision int64
	)
	err = tx.QueryRow(ctx, `
SELECT object_key, mapping, COALESCE(on_existing, 'skip'),
       COALESCE(consent_source, ''), COALESCE(consent_source_url, ''),
       consent_captured_at, COALESCE(consent_legal_basis, ''),
       COALESCE(consent_jurisdiction, ''), COALESCE(consent_reason, ''),
       COALESCE(consent_policy_version, ''), COALESCE(consent_evidence_reference, ''),
       COALESCE(consent_scope, ''), consent_scope_acknowledged,
	   COALESCE(consent_contract_version, ''), COALESCE(source_fingerprint, ''),
	   COALESCE(source_fingerprint_scheme, ''), COALESCE(source_fingerprint_key_version, ''),
       COALESCE(tags, '{}'::text[]), auto_create_properties,
	   COALESCE(configuration_revision, 0),
	   COALESCE(schedule_type, 'immediate'), COALESCE(schedule_cron, ''),
	   scheduled_at, COALESCE(drip_hours_interval, 0), COALESCE(drip_hours_total, 0)
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'preview'`,
		tenantID, importID).Scan(&objectKey, &mappingJSON, &onExisting,
		&opts.ConsentSource, &opts.ConsentSourceURL,
		&opts.ConsentCapturedAt, &opts.ConsentLegalBasis,
		&opts.ConsentJurisdiction, &opts.ConsentReason,
		&opts.ConsentPolicyVersion, &opts.ConsentEvidenceReference,
		&opts.ConsentScope, &opts.ConsentScopeAcknowledged,
		&opts.ConsentContractVersion, &opts.SourceFingerprint,
		&opts.SourceFingerprintScheme, &opts.SourceFingerprintKeyVersion,
		&opts.Tags, &opts.AutoCreateProps, &jobConfigurationRevision,
		&opts.ScheduleType, &opts.ScheduleCron, &opts.ScheduledAt,
		&opts.DripHoursInterval, &opts.DripHoursTotal)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	var mapping migratecsv.Mapping
	if err := json.Unmarshal(mappingJSON, &mapping); err != nil {
		return nil, err
	}
	return &dryRunJob{
		ObjectKey: objectKey, SourceFingerprint: opts.SourceFingerprint, Mapping: mapping,
		OnExisting: onExisting, Options: opts, ConfigurationRevision: jobConfigurationRevision,
	}, nil
}

// dryRunExistingEmails classifies every unique file identity through a temp
// table. It also captures the final send-gate state of existing rows so the
// preflight can distinguish a merge from an eligibility transition.
func (d *Deps) dryRunExistingEmails(ctx context.Context, tenantID string, emails []string) (map[string]struct{}, map[string]existingSubscriberState, string, error) {
	if len(emails) == 0 {
		return map[string]struct{}{}, map[string]existingSubscriberState{}, emptySubscriberStateFingerprint(), nil
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := stageSubscriberStateEmails(ctx, tx, emails); err != nil {
		return nil, nil, "", err
	}
	out, states, fingerprint, err := readStagedSubscriberStates(ctx, tx, tenantID, emails)
	if err != nil {
		return nil, nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, "", err
	}
	return out, states, fingerprint, nil
}

const subscriberImportStateTable = "subscriber_import_state_emails"

func emptySubscriberStateFingerprint() string {
	return subscriberStateFingerprint(nil, nil)
}

func stageSubscriberStateEmails(ctx context.Context, tx pgx.Tx, emails []string) error {
	if _, err := tx.Exec(ctx, `
CREATE TEMP TABLE IF NOT EXISTS subscriber_import_state_emails (
    email citext PRIMARY KEY
) ON COMMIT DROP`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `TRUNCATE subscriber_import_state_emails`); err != nil {
		return err
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{subscriberImportStateTable},
		[]string{"email"}, pgx.CopyFromSlice(len(emails), func(i int) ([]any, error) {
			return []any{emails[i]}, nil
		})); err != nil {
		return err
	}
	return nil
}

func readStagedSubscriberStates(ctx context.Context, tx pgx.Tx, tenantID string, emails []string) (map[string]struct{}, map[string]existingSubscriberState, string, error) {
	out := map[string]struct{}{}
	states := map[string]existingSubscriberState{}
	rows, err := tx.Query(ctx, `
SELECT s.email::text,
       s.status,
       (
           s.status = 'enabled'
           AND s.consent_email_marketing_at IS NOT NULL
           AND s.archived_at IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM v_suppressions_unified v
                WHERE v.tenant_id = $1::uuid
                  AND lower(v.email) = lower(s.email::text)
                  AND (v.expires_at IS NULL OR v.expires_at > now())
           )
		) AS sendable,
		COALESCE(s.tags, '{}'::text[]),
		subscriber_import_sha256_parts(
			'subscriber-import-state-content/v1',
			COALESCE(s.custom_fields, '{}'::jsonb)::text,
			COALESCE(s.full_name, ''), COALESCE(s.display_name, '')
		)
	  FROM subscriber_import_state_emails p
  JOIN subscribers s
    ON s.tenant_id = $1::uuid AND s.email = p.email`, tenantID)
	if err != nil {
		return nil, nil, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var e, status, contentFingerprint string
		var sendable bool
		var tags []string
		if err := rows.Scan(&e, &status, &sendable, &tags, &contentFingerprint); err != nil {
			return nil, nil, "", err
		}
		e = strings.ToLower(strings.TrimSpace(e))
		out[e] = struct{}{}
		states[e] = existingSubscriberState{
			Status: status, Sendable: sendable, Protected: !sendable, Tags: tags,
			ContentFingerprint: contentFingerprint,
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, "", err
	}
	rows.Close()
	return out, states, subscriberStateFingerprint(emails, states), nil
}

// dryRunUniqueEmails walks the CSV body once and returns up to `cap`
// unique lowercased emails (header skipped). Pure helper — no DB.
func dryRunUniqueEmails(body []byte, emailCol, capN int) []string {
	cr := csv.NewReader(bytes.NewReader(body))
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	if _, err := cr.Read(); err != nil { // header
		return nil
	}
	seen := map[string]struct{}{}
	out := []string{}
	for {
		row, err := cr.Read()
		if err != nil {
			break
		}
		email := extractEmail(row, emailCol)
		if email == "" {
			continue
		}
		if _, dup := seen[email]; dup {
			continue
		}
		seen[email] = struct{}{}
		out = append(out, email)
		if len(out) >= capN {
			break
		}
	}
	return out
}

// dryRunValidate is the core validation pass: walk every row, classify the
// would-be outcome, and validate custom-field shapes — all without writes.
// `existing` is the set of emails already present (→ update/skip rather
// than create). A nil validator skips custom-field type checks (unit
// tests / no-pool paths) but still does email + dedupe classification.
func dryRunValidate(_ context.Context, body []byte, job *dryRunJob, existing map[string]struct{}, schema *customfields.ReadOnlySchema, _ string) (dryRunResults, error) {
	res := dryRunResults{ValidatedAt: time.Now().UTC().Format(time.RFC3339)}
	emailCol := emailColumnIndex(job.Mapping)
	cr := csv.NewReader(bytes.NewReader(body))
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	if _, err := cr.Read(); err != nil { // skip header
		return res, nil
	}
	seen := map[string]struct{}{}
	var rowNum int64
	for {
		row, rerr := cr.Read()
		if rerr == io.EOF {
			break
		}
		rowNum++
		res.RowsTotal++
		if rerr != nil {
			res.WouldFail++
			res.appendRow(dryRunRow{RowNumber: rowNum, Outcome: outcomeFail, ErrorCode: "csv_parse_error", Error: "CSV row could not be parsed"})
			continue
		}
		email := extractEmail(row, emailCol)
		detail := dryRunRow{RowNumber: rowNum}
		if email == "" {
			res.WouldFail++
			detail.Outcome = outcomeFail
			detail.ErrorCode = "invalid_email"
			detail.Error = "invalid email"
			res.appendRow(detail)
			continue
		}
		if _, dup := seen[email]; dup {
			res.WouldSkip++
			res.FileDupes++
			detail.Outcome = outcomeSkip
			detail.ErrorCode = "duplicate_in_file"
			detail.Error = "duplicate within file"
			res.appendRow(detail)
			continue
		}
		seen[email] = struct{}{}

		// Custom-field shape validation — the same coercion the live INSERT
		// path runs. A type mismatch (e.g. "abc" into a number field) fails
		// the row in the preview exactly as it would in the real import.
		fields, shapeErr := buildRowFields(row, job.Mapping)
		if shapeErr != nil {
			res.WouldFail++
			detail.Outcome = outcomeFail
			detail.ErrorCode = "row_shape_invalid"
			detail.Error = shapeErr.Error()
			res.appendRow(detail)
			continue
		}
		proposedTags, shapeErr := mergeTags(fields.Tags, job.Options.Tags)
		if shapeErr != nil {
			res.WouldFail++
			detail.Outcome = outcomeFail
			detail.ErrorCode = "tag_budget_exceeded"
			detail.Error = shapeErr.Error()
			res.appendRow(detail)
			continue
		}
		if schema != nil && len(fields.Custom) > 0 {
			if _, verr := schema.Validate(fields.Custom); verr != nil {
				res.WouldFail++
				detail.Outcome = outcomeFail
				detail.ErrorCode, detail.Error = customFieldRowFailure(verr, schema, job.CustomFieldPolicy)
				res.appendRow(detail)
				continue
			}
		}
		// Last gate before classification, as in the worker: an erased address
		// is never created or updated, whatever on_existing says.
		if _, erased := job.Erased[email]; erased {
			res.WouldFail++
			detail.Outcome = outcomeFail
			detail.ErrorCode = rowCodeErasureBlocked
			detail.Error = rowMessageErasureBlocked
			res.appendRow(detail)
			continue
		}

		// Classify create vs update/skip by existing-subscriber presence,
		// honouring on_existing.
		if _, exists := existing[email]; exists {
			if state, known := job.ExistingStates[email]; known {
				if job.OnExisting == "update" {
					if _, tagErr := mergeTags(state.Tags, proposedTags); tagErr != nil {
						res.WouldFail++
						detail.Outcome = outcomeFail
						detail.ErrorCode = "tag_budget_exceeded"
						detail.Error = tagErr.Error()
						res.appendRow(detail)
						continue
					}
				}
				if state.Sendable {
					res.WouldBeSendable++
				} else if state.Protected {
					res.WouldRemainProtected++
				}
			}
			switch job.OnExisting {
			case "update":
				res.WouldUpdate++
				detail.Outcome = outcomeUpdate
			case "error":
				res.WouldFail++
				detail.Outcome = outcomeFail
				detail.ErrorCode = "existing_subscriber_conflict"
				detail.Error = "subscriber already exists (on_existing=error)"
			default: // skip
				res.WouldSkip++
				detail.Outcome = outcomeSkip
			}
		} else {
			res.WouldCreate++
			detail.Outcome = outcomeCreate
			if job.Options.hasConsent() {
				res.WouldBeSendable++
			}
		}
		res.appendRow(detail)
	}
	return res, nil
}

// appendRow adds a detail row up to the cap, prioritising failures: once
// the cap is hit, a failing row evicts the first non-failing detail so the
// operator always sees the errors that matter.
func (res *dryRunResults) appendRow(row dryRunRow) {
	if len(res.Rows) < maxDryRunRowDetails {
		res.Rows = append(res.Rows, row)
		return
	}
	res.DetailCapped = true
	if row.Outcome != outcomeFail {
		return
	}
	for i, existing := range res.Rows {
		if existing.Outcome != outcomeFail {
			res.Rows[i] = row
			return
		}
	}
}

// persistDryRun stores the results JSON onto the preview row + stamps the
// dry_run flag and timestamp. The row stays in 'preview'.
func (d *Deps) persistDryRun(ctx context.Context, tenantID, importID string, results dryRunResults, rowsNew, rowsExisting, fileDupes, configurationRevision int64) error {
	payload, err := json.Marshal(results)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_imports
   SET dry_run = true,
       dry_run_results = $3::jsonb,
       dry_run_at = now(),
       preflight_fingerprint = $4,
       preflight_at = now(),
	   preflight_expires_at = now() + interval '15 minutes',
	   preflight_rows_total = $5,
	   preflight_rows_failed = $9,
	   preflight_rows_existing = $7,
	   preflight_state_fingerprint = $10,
	   preflight_catalog_fingerprint = $11,
	   preflight_verification_mode = $13,
	   rows_total = $5,
       rows_new = $6,
       rows_existing = $7,
	   rows_file_dupes = $8,
	   review_data_expires_at = now() + interval '24 hours'
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'preview'
	   AND configuration_revision = $12`,
		tenantID, importID, string(payload), results.PreflightFingerprint,
		results.RowsTotal, rowsNew, rowsExisting, fileDupes, results.WouldFail,
		results.StateFingerprint, results.CatalogFingerprint, configurationRevision,
		results.PreflightVerificationMode)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errImportConfigurationChanged
	}
	return tx.Commit(ctx)
}
