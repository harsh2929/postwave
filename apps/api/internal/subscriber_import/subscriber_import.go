// SPDX-License-Identifier: AGPL-3.0-only
//
// Package subscriber_import implements the polished CSV-import
// wizard:
//
//   1. POST /api/v1/subscriber-imports/preview (multipart)
//      → uploads + runs csv.DetectMapping + computes the dedupe
//      summary + returns a preview row.
//   2. PATCH /api/v1/subscriber-imports/{id}
//      → operator overrides the column mapping or the
//      on_existing strategy. Status stays 'preview'.
//   3. POST /api/v1/subscriber-imports/{id}/confirm
//      → status flips to 'queued'. The worker picks up + imports
//      under the tenant's existing subscribers RLS.
//   4. GET /api/v1/subscriber-imports/{id}
//      → poll until status='ready' (or 'failed').
//
// The preview endpoint is sync (DetectMapping reads the first 100
// rows, dedupe-counts query subscribers under the tenant's RLS) so
// the operator gets immediate feedback. The actual import is
// async to keep the request bounded.
//
// Field mapping reuses packages/migrate/csv.DetectMapping +
// canonical.Subscriber so the same detection logic the migration
// adapters use applies here.

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"

	migratecsv "github.com/postwave/migrate/csv"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// MaxUploadBytes caps the CSV upload at 50 MB — comfortably above
// the size of a 200k-subscriber list with 10 columns.
const MaxUploadBytes int64 = 50 << 20
const MaxImportRows int64 = 250_000

// MaxImportDecodedCells bounds the in-memory shape of decoded CSV records.
// The byte cap alone is insufficient because encoding/csv materializes one
// string header per cell; millions of empty cells can otherwise amplify a
// small upload into a large heap allocation. Three million cells supports
// 250k narrow identity files and 200k rows with a typical 10-column schema.
const MaxImportDecodedCells int64 = 3_000_000

const (
	MaxImportCellBytes       = 64 << 10
	MaxImportRowDecodedBytes = 1 << 20
	// A decoded byte can require at most two source bytes through CSV quote
	// escaping or CRLF normalization. Bound the raw logical record before
	// encoding/csv materializes its field-index slice.
	MaxImportRawRecordBytes   = 2*MaxImportRowDecodedBytes + 2*MaxImportColumns + 4
	MaxImportHeaderBytes      = 1024
	MaxImportSampleBytes      = 32 << 10
	MaxImportSampleValueBytes = 256
)

func normalizeImportFilename(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || !utf8.ValidString(name) || len(name) > 255 || utf8.RuneCountInString(name) > 128 ||
		strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", errors.New("uploaded filename is invalid")
	}
	for _, r := range name {
		if unicode.IsControl(r) || (r >= '\u202a' && r <= '\u202e') || (r >= '\u2066' && r <= '\u2069') || r == '\u200e' || r == '\u200f' {
			return "", errors.New("uploaded filename contains unsafe control characters")
		}
	}
	return name, nil
}

// Storage is the narrow object-storage interface the package needs.
// Matches assets.Storage so main.go can pass the wired client.
type Storage interface {
	Put(ctx context.Context, key, mime string, body []byte) (publicURL string, err error)
	Open(ctx context.Context, key string) (io.ReadCloser, string, error)
	Delete(ctx context.Context, key string) error
}

func readBoundedCSV(r io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, MaxUploadBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > MaxUploadBytes {
		return nil, fmt.Errorf("CSV exceeds %d-byte limit", MaxUploadBytes)
	}
	return body, nil
}

// Deps wires the handler + worker.
type Deps struct {
	Pool    *db.Pool
	Storage Storage
	// Logger is used by writeSubscriberImportInternal so 5xx responses log a
	// closed failure class with tenant_id + request_id. The source error may
	// contain row, address, provider, or storage detail and is never logged or
	// echoed. Wired by the caller in main.go; nil-safe at the wrapper.
	Logger *slog.Logger
	// Verification, when set, adds a credit-cost + list-quality
	// projection to the dry-run preview. nil omits the section.
	Verification ImportProjector
	// ExecutionVerification is the fail-closed, durable enforcement adapter
	// used at Confirm and by the worker. It is separate from the best-effort
	// preview projector because an unavailable enforcement dependency must
	// never silently turn a configured local/full policy into "off".
	ExecutionVerification ImportExecutionVerifier
}

// MountRoutes registers the wizard endpoints on r.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Post("/api/v1/subscriber-imports/preview", d.Preview)
	r.With(admin).Get("/api/v1/subscriber-imports/remap-options", d.RemapOptions)
	r.With(admin).Get("/api/v1/subscriber-imports", d.List)
	r.With(admin).Get("/api/v1/subscriber-imports/{id}", d.Get)
	r.With(admin).Patch("/api/v1/subscriber-imports/{id}", d.Patch)
	r.With(admin).Post("/api/v1/subscriber-imports/{id}/confirm", d.Confirm)
	// SUB-103 — background worker progress + cancel. confirm flips the
	// row to 'queued' (202) and the worker drains it; the desktop poller
	// streams progress over SSE and can request cancellation mid-run.
	// The per-row failures the worker has always recorded and nothing read.
	r.With(admin).Get("/api/v1/subscriber-imports/{id}/errors", d.RowErrors)
	r.With(admin).Get("/api/v1/subscriber-imports/{id}/progress", d.Progress)
	r.With(admin).Post("/api/v1/subscriber-imports/{id}/cancel", d.Cancel)
}

// previewResponse is the shape returned by the preview endpoint.
type previewResponse struct {
	ID                          string              `json:"id"`
	Status                      string              `json:"status"`
	Mapping                     *migratecsv.Mapping `json:"mapping"`
	SampleRows                  []map[string]string `json:"sample_rows"`
	RowsTotal                   int64               `json:"rows_total"`
	RowsNew                     int64               `json:"rows_new"`
	RowsExisting                int64               `json:"rows_existing"`
	RowsFileDupes               int64               `json:"rows_file_dupes"`
	OnExisting                  string              `json:"on_existing"`
	ClassificationAuthoritative bool                `json:"classification_authoritative"`
	UploadClassificationExact   bool                `json:"upload_classification_exact"`
	SourceFingerprint           string              `json:"source_fingerprint"`
	SourceFingerprintScheme     string              `json:"source_fingerprint_scheme"`
	SourceFingerprintKeyVersion string              `json:"source_fingerprint_key_version"`
	PreflightRequired           bool                `json:"preflight_required"`
	ConfigurationRevision       int64               `json:"configuration_revision"`
	SampleValuesTruncated       bool                `json:"sample_values_truncated"`
}

// Preview reads the uploaded CSV, runs DetectMapping, computes
// dedupe + writes the preview row.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Storage == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "storage_unavailable",
			"object storage not configured")
		return
	}
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "multipart/form-data" {
		httperror.Write(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be multipart/form-data")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxUploadBytes)
	if err := r.ParseMultipartForm(MaxUploadBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			httpbody.WriteError(w, httpbody.ErrTooLarge)
			return
		}
		httperror.Write(w, http.StatusBadRequest, "bad_form", "multipart form could not be parsed")
		return
	}
	if r.MultipartForm != nil {
		defer func() { _ = r.MultipartForm.RemoveAll() }()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "missing_file",
			"upload field 'file' is required")
		return
	}
	defer func() { _ = file.Close() }()
	filename, filenameErr := normalizeImportFilename(header.Filename)
	if filenameErr != nil {
		writeJSONErr(w, http.StatusBadRequest, "invalid_filename", filenameErr.Error())
		return
	}
	body, err := readBoundedCSV(file)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "read_failed",
			"could not read uploaded file")
		return
	}
	if err := validateRawCSVEnvelope(body); err != nil {
		httperror.WriteValidation(w, "invalid_csv", err.Error())
		return
	}

	// Sniff columns + read the first 10 rows for the sample preview.
	mapping, allRows, err := migratecsv.DetectMapping(bytes.NewReader(body))
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	// The generic migration mapper can infer row-level status and consent
	// timestamps, but this production import intentionally has no safe
	// per-row eligibility contract. Ignore those guesses by default; callers
	// may explicitly remap the source columns to ordinary custom fields.
	for i := range mapping.Columns {
		if mapping.Columns[i].Kind == migratecsv.KindStatus ||
			mapping.Columns[i].Kind == migratecsv.KindConsentTimestamp {
			mapping.Columns[i].Kind = migratecsv.KindIgnore
			mapping.Columns[i].CustomKey = ""
		}
	}
	suggestCustomFieldKeys(mapping)
	// Locate the email column. The wizard refuses to proceed
	// without one (every other field can be ignored / custom).
	emailCol := -1
	for _, c := range mapping.Columns {
		if c.Kind == migratecsv.KindEmail {
			emailCol = c.Index
			break
		}
	}
	if emailCol < 0 {
		writeJSONErr(w, http.StatusBadRequest, "no_email_column",
			"could not detect an email column; rename one column to 'email' and retry")
		return
	}

	_ = allRows // inference samples are not authoritative row data
	identityScan, err := scanImportIdentities(body, *mapping)
	if err != nil {
		httperror.WriteValidation(w, "invalid_csv", err.Error())
		return
	}
	mapping.Rows = int(identityScan.RowsTotal)

	// Compare against existing subscribers under tenant RLS.
	rowsExisting, rowsNew := int64(0), int64(0)
	if len(identityScan.Emails) > 0 {
		rowsExisting, rowsNew, err = d.countDedupeExhaustive(r.Context(), t.ID, identityScan.Emails)
		if err != nil {
			writeSubscriberImportInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	sourceFingerprint, err := sourceFileFingerprint(t.ID, body)
	if err != nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "source_fingerprint_unavailable",
			"subscriber import integrity service is not configured")
		return
	}

	// Upload the file to object storage for the async worker.
	suffix, err := randHex()
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	objectKey := fmt.Sprintf("imports/%s/%s.csv", t.ID, suffix)
	if _, err := d.Storage.Put(r.Context(), objectKey, "text/csv", body); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	keepObject := false
	defer func() {
		if !keepObject {
			_ = d.Storage.Delete(context.WithoutCancel(r.Context()), objectKey)
		}
	}()

	mappingJSON, _ := json.Marshal(mapping)
	sampleJSON, _ := json.Marshal(identityScan.Sample)

	u, _ := middleware.UserFromContext(r.Context())
	var userID any
	var userEmail any
	if u != nil {
		if u.ID != "" {
			userID = u.ID
		}
		if u.Email != "" {
			userEmail = u.Email
		}
	}

	// A new upload follows the workspace's Settings → Custom fields mode: auto
	// creates mapped keys it hasn't seen (the operator can opt out on Map),
	// strict and off never do.
	customFieldsMode, err := (&customfields.Repo{Pool: d.Pool}).GetMode(r.Context(), t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	autoCreateProperties := customFieldsMode == customfields.ModeAuto

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO subscriber_imports
  (tenant_id, requested_by, requested_by_email,
   object_key, original_filename, bytes_total,
   mapping, sample_rows, sample_values_truncated,
   rows_total, rows_existing, rows_new, rows_file_dupes,
   source_fingerprint, source_fingerprint_scheme, source_fingerprint_key_version,
   auto_create_properties)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6,
		$7::jsonb, $8::jsonb, $9,
		$10, $11, $12, $13, $14, $15, $16, $17)
RETURNING id::text`,
		t.ID, userID, userEmail,
		objectKey, filename, len(body),
		string(mappingJSON), string(sampleJSON), identityScan.SampleValuesTruncated,
		identityScan.RowsTotal, rowsExisting, rowsNew, identityScan.FileDupes,
		sourceFingerprint, sourceFingerprintScheme, sourceFingerprintKeyVersion(),
		autoCreateProperties).Scan(&id)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	keepObject = true
	setImportConfigurationETag(w, 0)
	writeJSON(w, http.StatusOK, previewResponse{
		ID:                          id,
		Status:                      "preview",
		Mapping:                     mapping,
		SampleRows:                  identityScan.Sample,
		RowsTotal:                   identityScan.RowsTotal,
		RowsNew:                     rowsNew,
		RowsExisting:                rowsExisting,
		RowsFileDupes:               identityScan.FileDupes,
		OnExisting:                  "skip",
		ClassificationAuthoritative: false,
		UploadClassificationExact:   true,
		SourceFingerprint:           sourceFingerprint,
		SourceFingerprintScheme:     sourceFingerprintScheme,
		SourceFingerprintKeyVersion: sourceFingerprintKeyVersion(),
		PreflightRequired:           true,
		ConfigurationRevision:       0,
		SampleValuesTruncated:       identityScan.SampleValuesTruncated,
	})
}

// patchInput supports overriding the detected mapping + the dedupe
// strategy before confirming, plus the wizard's job-level options
// (A11): consent provenance, job tags, and property auto-creation.
// Pointer fields distinguish "absent" (leave untouched) from
// "explicit empty" (clear).
type patchInput struct {
	ConfigurationRevision    *int64              `json:"configuration_revision"`
	Mapping                  *migratecsv.Mapping `json:"mapping,omitempty"`
	OnExisting               string              `json:"on_existing,omitempty"`
	ConsentSource            *string             `json:"consent_source,omitempty"`
	ConsentSourceURL         *string             `json:"consent_source_url,omitempty"`
	ConsentCapturedAt        *string             `json:"consent_captured_at,omitempty"` // RFC3339
	ConsentLegalBasis        *string             `json:"consent_legal_basis,omitempty"`
	ConsentJurisdiction      *string             `json:"consent_jurisdiction,omitempty"`
	ConsentReason            *string             `json:"consent_reason,omitempty"`
	ConsentPolicyVersion     *string             `json:"consent_policy_version,omitempty"`
	ConsentEvidenceReference *string             `json:"consent_evidence_reference,omitempty"`
	ConsentScope             *string             `json:"consent_scope,omitempty"`
	ConsentScopeAcknowledged *bool               `json:"consent_scope_acknowledged,omitempty"`
	Tags                     []string            `json:"tags,omitempty"` // nil = untouched; [] = clear
	AutoCreateProperties     *bool               `json:"auto_create_properties,omitempty"`
	// TargetListID is the list every imported contact joins, as the list's
	// engine id or its uuid (the two forms every list picker holds). Omitted =
	// leave the current choice alone; "" = no list.
	TargetListID *string `json:"target_list_id,omitempty"`
	// Legacy pacing fields remain decodable so they can be rejected explicitly;
	// the supported wizard contract is immediate or one-time scheduled execution.
	// Embedded so the schedule fields decode from the same PATCH body.
	scheduleInput
}

// patchValues is the validated / normalised subset of patchInput that
// maps 1:1 onto subscriber_imports columns. Factored out of the
// handler so the validation contract is unit-testable without a DB.
type patchValues struct {
	ConsentPatchPresent      bool
	ClearConsentContract     bool
	ConsentSource            *string
	ConsentSourceURL         *string
	ConsentCapturedAt        *time.Time
	ConsentLegalBasis        *string
	ConsentJurisdiction      *string
	ConsentReason            *string
	ConsentPolicyVersion     *string
	ConsentEvidenceReference *string
	ConsentScope             *string
	ConsentScopeAcknowledged *bool
	Tags                     []string // nil = untouched
	AutoCreateProps          *bool    // nil = untouched
	// TargetListID carries the SHAPE-validated list id; the handler resolves
	// it to a live list of this tenant inside its writing transaction.
	// ClearTargetList is the explicit "no list" an operator can go back to.
	TargetListID    *string
	ClearTargetList bool
	// One-time schedule values plus explicit legacy pacing rejection fields.
	Schedule scheduleValues
}

// patchValidationError carries the HTTP error code alongside the
// operator-facing message.
type patchValidationError struct {
	code string
	msg  string
}

func (e *patchValidationError) Error() string { return e.msg }

// validatePatch normalises + validates the A11 fields of a PATCH
// body. Mapping/OnExisting stay with the handler (pre-existing
// contract, left as-is).
func validatePatch(in patchInput) (patchValues, *patchValidationError) {
	var pv patchValues
	pv.ConsentPatchPresent = in.ConsentSource != nil || in.ConsentSourceURL != nil ||
		in.ConsentCapturedAt != nil || in.ConsentLegalBasis != nil ||
		in.ConsentJurisdiction != nil || in.ConsentReason != nil ||
		in.ConsentPolicyVersion != nil || in.ConsentEvidenceReference != nil ||
		in.ConsentScope != nil || in.ConsentScopeAcknowledged != nil
	if pv.ConsentPatchPresent {
		if in.ConsentScopeAcknowledged == nil {
			return pv, &patchValidationError{"incomplete_consent_contract",
				"consent_scope_acknowledged is required whenever consent evidence is changed"}
		}
		pv.ConsentScopeAcknowledged = in.ConsentScopeAcknowledged
		if !*in.ConsentScopeAcknowledged {
			// A negative acknowledgement means "no positive grant". Clear the
			// complete tuple atomically so stale fields can never look partial.
			pv.ClearConsentContract = true
		} else {
			if in.ConsentSource == nil || in.ConsentSourceURL == nil || in.ConsentCapturedAt == nil ||
				in.ConsentLegalBasis == nil || in.ConsentJurisdiction == nil ||
				in.ConsentReason == nil || in.ConsentPolicyVersion == nil ||
				in.ConsentEvidenceReference == nil || in.ConsentScope == nil {
				return pv, &patchValidationError{"incomplete_consent_contract",
					"a positive grant requires source, HTTPS source URL, captured time, legal basis, jurisdiction, reason, policy version, typed evidence reference, and email_marketing scope"}
			}
			source := strings.ToLower(strings.TrimSpace(*in.ConsentSource))
			if len(source) > MaxConsentSourceLen || !isReviewedImportConsentSource(source) {
				return pv, &patchValidationError{"invalid_consent_source",
					"consent_source must identify reviewed first-party evidence: double_optin, single_optin, signed_form, preference_center, or direct_request"}
			}
			sourceURL := strings.TrimSpace(*in.ConsentSourceURL)
			if err := validateConsentURL(sourceURL); err != nil {
				return pv, &patchValidationError{"invalid_consent_source_url", err.Error()}
			}
			rawCaptured := strings.TrimSpace(*in.ConsentCapturedAt)
			captured, err := time.Parse(time.RFC3339, rawCaptured)
			if err != nil {
				return pv, &patchValidationError{"invalid_consent_captured_at",
					"consent_captured_at must be an RFC3339 timestamp"}
			}
			captured = captured.UTC()
			if captured.After(time.Now().UTC()) {
				return pv, &patchValidationError{"future_consent_captured_at",
					"consent_captured_at cannot be in the future"}
			}
			legalBasis := strings.ToLower(strings.TrimSpace(*in.ConsentLegalBasis))
			if legalBasis != "consent" {
				return pv, &patchValidationError{"invalid_consent_legal_basis",
					"positive subscriber-import grants require consent_legal_basis=consent"}
			}
			jurisdiction := strings.ToUpper(strings.TrimSpace(*in.ConsentJurisdiction))
			if len(jurisdiction) > MaxConsentJurisdictionLen || !consentJurisdictionRE.MatchString(jurisdiction) {
				return pv, &patchValidationError{"invalid_consent_jurisdiction",
					"consent_jurisdiction must be a 2-32 character jurisdiction code such as GB, EU, or US-CA"}
			}
			reason := strings.TrimSpace(*in.ConsentReason)
			if err := validateConsentReason(reason); err != nil {
				return pv, &patchValidationError{"invalid_consent_reason", err.Error()}
			}
			policyVersion := strings.TrimSpace(*in.ConsentPolicyVersion)
			if policyVersion == "" || len(policyVersion) > MaxConsentPolicyVersionLen || unsafeSecretShapeRE.MatchString(policyVersion) {
				return pv, &patchValidationError{"invalid_consent_policy_version",
					fmt.Sprintf("consent_policy_version is required, must be %d characters or fewer, and must not contain secrets", MaxConsentPolicyVersionLen)}
			}
			evidenceReference := strings.TrimSpace(*in.ConsentEvidenceReference)
			if err := validateEvidenceReference(evidenceReference); err != nil {
				return pv, &patchValidationError{"invalid_consent_evidence_reference", err.Error()}
			}
			scope := strings.ToLower(strings.TrimSpace(*in.ConsentScope))
			if scope != ImportConsentScope {
				return pv, &patchValidationError{"invalid_consent_scope",
					"consent_scope must be email_marketing"}
			}
			pv.ConsentSource = &source
			pv.ConsentSourceURL = &sourceURL
			pv.ConsentCapturedAt = &captured
			pv.ConsentLegalBasis = &legalBasis
			pv.ConsentJurisdiction = &jurisdiction
			pv.ConsentReason = &reason
			pv.ConsentPolicyVersion = &policyVersion
			pv.ConsentEvidenceReference = &evidenceReference
			pv.ConsentScope = &scope
		}
	}
	if in.Tags != nil {
		tags, err := normalizeTags(in.Tags)
		if err != nil {
			return pv, &patchValidationError{"invalid_tags", err.Error()}
		}
		pv.Tags = tags
	}
	pv.AutoCreateProps = in.AutoCreateProperties
	// The target list's SHAPE is judged here, before any transaction opens: a
	// malformed id is the caller's mistake and must never reach a ::uuid cast.
	// Whether it names a live list of this tenant is decided in the writing
	// transaction, where the answer cannot go stale.
	if in.TargetListID != nil {
		raw := strings.TrimSpace(*in.TargetListID)
		if raw == "" {
			pv.ClearTargetList = true
		} else {
			if _, _, err := lists.ParseListID(raw); err != nil {
				return pv, &patchValidationError{"invalid_target_list_id",
					"target_list_id must be the list's numeric id or its UUID"}
			}
			pv.TargetListID = &raw
		}
	}
	// Schedule validation shares the same error contract.
	sv, serr := validateSchedule(in.scheduleInput)
	if serr != nil {
		return pv, serr
	}
	pv.Schedule = sv
	return pv, nil
}

// mergeFieldOption is one canonical remap target the wizard's per-column
// dropdown offers (SUB-102). Kind is the migratecsv.FieldKind the column
// is remapped to; Label is the human-readable option text.
type mergeFieldOption struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

// customFieldOption is one tenant-registered custom field the wizard can
// remap a column onto (the column becomes Kind=custom with this key).
type customFieldOption struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

// canonicalMergeFields is the fixed remap target set the wizard exposes
// alongside the tenant's custom fields. These mirror the migratecsv
// FieldKind values the import pipeline understands; "ignore" lets the
// operator skip a column entirely. The order is the dropdown order.
var canonicalMergeFields = []mergeFieldOption{
	{Kind: string(migratecsv.KindEmail), Label: "Email (required)"},
	{Kind: string(migratecsv.KindName), Label: "Full name"},
	{Kind: string(migratecsv.KindFirstName), Label: "First name"},
	{Kind: string(migratecsv.KindLastName), Label: "Last name"},
	{Kind: string(migratecsv.KindTags), Label: "Tags"},
	{Kind: string(migratecsv.KindCustom), Label: "Custom field"},
	{Kind: string(migratecsv.KindIgnore), Label: "Skip this column"},
}

// RemapOptions GET /api/v1/subscriber-imports/remap-options — lists the
// canonical merge-field kinds plus the tenant's registered custom fields
// so the wizard can populate each column's remap dropdown (SUB-102).
func (d *Deps) RemapOptions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	repo := &customfields.Repo{Pool: d.Pool}
	fields, err := repo.List(r.Context(), t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	custom := make([]customFieldOption, 0, len(fields))
	for _, f := range fields {
		custom = append(custom, customFieldOption{
			Key:   f.Key,
			Label: f.Label,
			Type:  string(f.Type),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"merge_fields":  canonicalMergeFields,
		"custom_fields": custom,
	})
}

// knownCustomKeys returns the set of custom-field keys registered for the
// tenant, used to validate KindCustom remap targets in a PATCH. A nil pool
// (unit tests) yields an empty set — validateMappingOverride then treats
// any custom_key as needing auto_create_properties, which the worker handles.
func (d *Deps) knownCustomKeys(ctx context.Context, tenantID string) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	if d.Pool == nil {
		return out, nil
	}
	repo := &customfields.Repo{Pool: d.Pool}
	fields, err := repo.List(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, f := range fields {
		out[f.Key] = struct{}{}
	}
	return out, nil
}

// Patch PATCH /api/v1/subscriber-imports/{id} — operator overrides.
func (d *Deps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	var in patchInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	var known map[string]struct{}
	if in.Mapping != nil {
		var kerr error
		known, kerr = d.knownCustomKeys(r.Context(), t.ID)
		if kerr != nil {
			writeSubscriberImportInternal(w, d.Logger, kerr, r.Context())
			return
		}
		if verr := validateMappingOverride(*in.Mapping, known); verr != nil {
			writeJSONErr(w, http.StatusBadRequest, verr.code, verr.msg)
			return
		}
	}
	if in.OnExisting != "" {
		switch in.OnExisting {
		case "skip", "update", "error":
		default:
			writeJSONErr(w, http.StatusBadRequest, "invalid_on_existing",
				"on_existing must be skip|update|error")
			return
		}
	}
	pv, verr := validatePatch(in)
	if verr != nil {
		writeJSONErr(w, http.StatusBadRequest, verr.code, verr.msg)
		return
	}
	if pv.AutoCreateProps != nil && *pv.AutoCreateProps {
		mode, modeErr := (&customfields.Repo{Pool: d.Pool}).GetMode(r.Context(), t.ID)
		if modeErr != nil {
			writeSubscriberImportInternal(w, d.Logger, modeErr, r.Context())
			return
		}
		if mode == customfields.ModeStrict {
			writeJSONErr(w, http.StatusConflict, "custom_fields_mode_strict",
				"this workspace only accepts custom fields defined under Settings › Custom fields, so an import can't create new ones")
			return
		}
	}
	if in.ConfigurationRevision == nil {
		writeJSONErr(w, http.StatusPreconditionRequired, "configuration_revision_required",
			"configuration_revision from the latest preview or GET response is required")
		return
	}
	if *in.ConfigurationRevision < 0 {
		writeJSONErr(w, http.StatusBadRequest, "invalid_configuration_revision", "configuration_revision must be non-negative")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var status string
	var currentRevision int64
	var frozenMappingRaw []byte
	var frozenSchedule confirmSchedule
	if err := tx.QueryRow(r.Context(), `
SELECT status, mapping, COALESCE(configuration_revision, 0),
	   COALESCE(schedule_type, 'immediate'), COALESCE(schedule_cron, ''), scheduled_at,
	   COALESCE(drip_hours_interval, 0), COALESCE(drip_hours_total, 0)
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, t.ID, id).Scan(&status, &frozenMappingRaw, &currentRevision,
		&frozenSchedule.ScheduleType, &frozenSchedule.ScheduleCron, &frozenSchedule.ScheduledAt,
		&frozenSchedule.DripHoursInterval, &frozenSchedule.DripHoursTotal); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONErr(w, http.StatusNotFound, "import_not_found", "subscriber import not found")
			return
		}
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	if status != "preview" {
		writeJSONErr(w, http.StatusConflict, "not_in_preview", "subscriber import configuration is frozen after confirmation")
		return
	}
	if currentRevision != *in.ConfigurationRevision {
		writeJSONErr(w, http.StatusConflict, "configuration_revision_mismatch",
			"subscriber import configuration changed; reload the latest review state before saving")
		return
	}
	var frozenMapping migratecsv.Mapping
	if err := json.Unmarshal(frozenMappingRaw, &frozenMapping); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	mergedSchedule := mergeSchedule(frozenSchedule, pv.Schedule)
	if pv.Schedule.touched() {
		if scheduleErr := validateConfirmExecutionAt(mergedSchedule, time.Now().UTC()); scheduleErr != nil {
			writeJSONErr(w, http.StatusBadRequest, scheduleErr.code, scheduleErr.msg)
			return
		}
	}

	sets := make([]string, 0, 24)
	args := make([]any, 0, 26)
	add := func(column, cast string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("%s = $%d%s", column, len(args), cast))
	}
	if in.Mapping != nil {
		canonical, mErr := canonicalizeMapping(*in.Mapping, append([]string(nil), frozenMapping.Headers...))
		if mErr != nil {
			writeJSONErr(w, http.StatusBadRequest, mErr.code, mErr.msg)
			return
		}
		canonical.Path = frozenMapping.Path
		canonical.Rows = frozenMapping.Rows
		if mErr := validateMappingOverride(canonical, known); mErr != nil {
			writeJSONErr(w, http.StatusBadRequest, mErr.code, mErr.msg)
			return
		}
		raw, err := json.Marshal(canonical)
		if err != nil {
			writeSubscriberImportInternal(w, d.Logger, err, r.Context())
			return
		}
		add("mapping", "::jsonb", string(raw))
	}
	if in.OnExisting != "" {
		add("on_existing", "", in.OnExisting)
	}
	if pv.ConsentPatchPresent {
		if pv.ClearConsentContract {
			sets = append(sets,
				"consent_source = NULL", "consent_source_url = NULL", "consent_captured_at = NULL",
				"consent_legal_basis = NULL", "consent_jurisdiction = NULL", "consent_reason = NULL",
				"consent_policy_version = NULL", "consent_evidence_reference = NULL", "consent_scope = NULL",
				"consent_scope_acknowledged = false")
			add("consent_contract_version", "", ImportConsentContractVersion)
		} else {
			add("consent_source", "", *pv.ConsentSource)
			add("consent_source_url", "", *pv.ConsentSourceURL)
			add("consent_captured_at", "::timestamptz", pv.ConsentCapturedAt)
			add("consent_legal_basis", "", *pv.ConsentLegalBasis)
			add("consent_jurisdiction", "", *pv.ConsentJurisdiction)
			add("consent_reason", "", *pv.ConsentReason)
			add("consent_policy_version", "", *pv.ConsentPolicyVersion)
			add("consent_evidence_reference", "", *pv.ConsentEvidenceReference)
			add("consent_scope", "", *pv.ConsentScope)
			sets = append(sets, "consent_scope_acknowledged = true")
			add("consent_contract_version", "", ImportConsentContractVersion)
		}
	}
	if pv.Tags != nil {
		add("tags", "::text[]", pv.Tags)
	}
	if pv.AutoCreateProps != nil {
		add("auto_create_properties", "", *pv.AutoCreateProps)
	}
	// The chosen list is resolved HERE, in the transaction that stores it, so a
	// list deleted a moment ago is a 404 instead of a stored id pointing at
	// nothing. Only the canonical uuid is persisted — the engine id the picker
	// sent is an alias, and memberships are keyed on the uuid.
	if pv.ClearTargetList {
		add("target_list_id", "::uuid", nil)
	} else if pv.TargetListID != nil {
		list, listErr := lists.ResolveListIdentityTx(r.Context(), tx, t.ID, *pv.TargetListID)
		switch {
		case errors.Is(listErr, lists.ErrListIDNotMapped):
			writeJSONErr(w, http.StatusNotFound, "target_list_not_found",
				"That list doesn't exist in this workspace. It may have been deleted; refresh and choose the list again.")
			return
		case errors.Is(listErr, lists.ErrInvalidListID):
			writeJSONErr(w, http.StatusBadRequest, "invalid_target_list_id",
				"target_list_id must be the list's numeric id or its UUID")
			return
		case listErr != nil:
			writeSubscriberImportInternal(w, d.Logger, listErr, r.Context())
			return
		}
		add("target_list_id", "::uuid", list.UUID)
	}
	sc := pv.Schedule
	if sc.ScheduleType != nil {
		add("schedule_type", "", *sc.ScheduleType)
	}
	if sc.ScheduleCron != nil {
		args = append(args, *sc.ScheduleCron)
		sets = append(sets, fmt.Sprintf("schedule_cron = NULLIF($%d, '')", len(args)))
	}
	if sc.ScheduledAt != nil || sc.ClearScheduledAt {
		add("scheduled_at", "::timestamptz", sc.ScheduledAt)
	}
	if sc.DripHoursInterval != nil {
		add("drip_hours_interval", "", *sc.DripHoursInterval)
	}
	if sc.DripHoursTotal != nil {
		add("drip_hours_total", "", *sc.DripHoursTotal)
	}
	if len(sets) == 0 {
		if err := tx.Commit(r.Context()); err != nil {
			writeSubscriberImportInternal(w, d.Logger, err, r.Context())
			return
		}
		setImportConfigurationETag(w, currentRevision)
		writeJSON(w, http.StatusOK, map[string]any{
			"id": id, "status": "preview", "updated": false,
			"configuration_revision": currentRevision,
		})
		return
	}
	args = append(args, t.ID, id)
	args = append(args, currentRevision)
	var nextRevision int64
	err = tx.QueryRow(r.Context(), `UPDATE subscriber_imports SET `+strings.Join(sets, ", ")+fmt.Sprintf(`
 WHERE tenant_id = $%d::uuid AND id = $%d::uuid AND status = 'preview'
	   AND configuration_revision = $%d
 RETURNING configuration_revision`, len(args)-2, len(args)-1, len(args)), args...).Scan(&nextRevision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONErr(w, http.StatusConflict, "configuration_revision_mismatch", "subscriber import configuration changed concurrently")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	setImportConfigurationETag(w, nextRevision)
	if nextRevision == currentRevision {
		writeJSON(w, http.StatusOK, map[string]any{
			"id": id, "status": "preview", "updated": false,
			"configuration_revision": nextRevision,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "status": "preview", "updated": true,
		"configuration_revision": nextRevision,
		"preflight_required":     true,
	})
}

func setImportConfigurationETag(w http.ResponseWriter, revision int64) {
	w.Header().Set("ETag", fmt.Sprintf(`W/"subscriber-import-revision-%d"`, revision))
}

// confirmInput is the optional Confirm body. dry_run (SUB-105) routes the
// request through a validation-only pass that writes nothing. An empty
// body keeps the historical behaviour (immediate / scheduled queue).
type confirmInput struct {
	DryRun bool `json:"dry_run,omitempty"`
}

// Confirm POST /api/v1/subscriber-imports/{id}/confirm — flip
// status to 'queued' so the background worker picks it up.
//
// SUB-103: this is a true async hand-off. The handler returns 202
// Accepted with the job id; the worker (worker.go) drains the 'queued'
// row in chunks.
//
// A one-time scheduled row receives its due timestamp. Legacy recurring or
// paced rows are rejected before queueing because the worker cannot honour
// those visible contracts durably.
//
// SUB-105: a {"dry_run": true} body short-circuits into dryRunImport —
// every row is fully validated, nothing is written, and the per-row
// outcomes land in dry_run_results for the wizard's Review step. The row
// stays in 'preview' so a later real Confirm still works.
// targetListStillExists resolves the import's destination list, if it named one,
// inside the caller's writing transaction. It answers the request itself and
// returns false when the list can no longer be used, so Confirm stays one
// decision per gate.
func (d *Deps) targetListStillExists(
	w http.ResponseWriter, r *http.Request, tx pgx.Tx, tenantID, targetListID string,
) bool {
	if targetListID == "" {
		return true
	}
	_, err := lists.ResolveListIdentityTx(r.Context(), tx, tenantID, targetListID)
	switch {
	case err == nil:
		return true
	case errors.Is(err, lists.ErrListIDNotMapped), errors.Is(err, lists.ErrInvalidListID):
		writeJSONErr(w, http.StatusConflict, "target_list_not_found",
			"The list this import would add contacts to no longer exists. Choose another list, or clear it, then confirm again.")
	default:
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
	}
	return false
}

func (d *Deps) Confirm(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))

	// Body is optional. Tolerate an empty body (legacy clients POST no
	// payload) but reject malformed JSON when bytes are present.
	var in confirmInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}

	if in.DryRun {
		d.dryRun(w, r, t.ID, id)
		return
	}

	// Read one immutable candidate snapshot, then perform object-storage I/O,
	// CSV decoding, and exhaustive state/catalog checks without pinning a DB
	// connection or holding the import row lock. The final short transaction
	// queues only if configuration_revision + preflight fingerprint still match.
	confirmation, mappingErr := d.loadConfirmationState(r.Context(), t.ID, id)
	if mappingErr != nil {
		if errors.Is(mappingErr, pgx.ErrNoRows) {
			writeJSONErr(w, http.StatusConflict, "not_in_preview",
				"job not found or not in preview state")
			return
		}
		writeSubscriberImportInternal(w, d.Logger, mappingErr, r.Context())
		return
	}
	canonical, canonicalErr := canonicalizeMapping(confirmation.Mapping, append([]string(nil), confirmation.Mapping.Headers...))
	if canonicalErr != nil {
		writeJSONErr(w, http.StatusConflict, canonicalErr.code, canonicalErr.msg)
		return
	}
	confirmation.Mapping = canonical
	if validationErr := validateMappingTargets(confirmation.Mapping); validationErr != nil {
		writeJSONErr(w, http.StatusConflict, validationErr.code, validationErr.msg)
		return
	}
	if err := confirmation.Options.validateForConfirm(time.Now().UTC()); err != nil {
		writeJSONErr(w, http.StatusConflict, "invalid_consent_contract", err.Error())
		return
	}
	if confirmation.Options.SourceFingerprint == "" || confirmation.Options.SourceFingerprintScheme != sourceFingerprintScheme {
		writeJSONErr(w, http.StatusConflict, "source_fingerprint_missing",
			"this legacy preview is not bound to uploaded bytes; upload the file again")
		return
	}
	if confirmation.OnExisting != "skip" && confirmation.OnExisting != "update" && confirmation.OnExisting != "error" {
		writeJSONErr(w, http.StatusConflict, "invalid_on_existing", "on_existing must be skip|update|error")
		return
	}
	if confirmation.PreflightExpiresAt == nil || !confirmation.PreflightExpiresAt.After(time.Now().UTC()) {
		writeJSONErr(w, http.StatusConflict, "preflight_expired", "the exhaustive preflight expired; run it again against current subscriber state")
		return
	}
	if d.Storage == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "storage_unavailable", "object storage not configured")
		return
	}
	rdr, _, err := d.Storage.Open(r.Context(), confirmation.ObjectKey)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	body, readErr := readBoundedCSV(rdr)
	_ = rdr.Close()
	actualFingerprint, fingerprintErr := sourceFileFingerprintWithVersion(t.ID, body, confirmation.Options.SourceFingerprintKeyVersion)
	if readErr != nil || fingerprintErr != nil || actualFingerprint != confirmation.Options.SourceFingerprint {
		writeJSONErr(w, http.StatusConflict, "source_fingerprint_mismatch", "the uploaded object no longer matches the reviewed source")
		return
	}
	identityScan, scanErr := scanImportIdentities(body, confirmation.Mapping)
	if scanErr != nil {
		writeJSONErr(w, http.StatusConflict, "invalid_csv", scanErr.Error())
		return
	}
	_, _, currentStateFingerprint, stateErr := d.dryRunExistingEmails(r.Context(), t.ID, identityScan.Emails)
	if stateErr != nil {
		writeSubscriberImportInternal(w, d.Logger, stateErr, r.Context())
		return
	}
	policy, catalogErr := resolveCustomFieldImportPolicy(r.Context(), d.Pool, t.ID, confirmation.Options.AutoCreateProps)
	if catalogErr != nil {
		writeSubscriberImportInternal(w, d.Logger, catalogErr, r.Context())
		return
	}
	currentCatalogFingerprint, catalogErr := customFieldCatalogFingerprint(r.Context(), d.Pool, t.ID, confirmation.Mapping, policy)
	if catalogErr != nil {
		writeSubscriberImportInternal(w, d.Logger, catalogErr, r.Context())
		return
	}
	verificationMode, modeErr := d.currentImportVerificationMode(r.Context(), t.ID)
	if modeErr != nil {
		httperror.Write(w, http.StatusServiceUnavailable, "verification_policy_unavailable",
			"the import verification policy could not be confirmed; retry before importing")
		return
	}
	if confirmation.PreflightVerificationMode != verificationMode {
		writeJSONErr(w, http.StatusConflict, "verification_policy_changed",
			"the import verification policy changed after preflight; run a fresh exhaustive preflight")
		return
	}
	expectedPreflight := computePreflightFingerprint(confirmation.Options.SourceFingerprint,
		confirmation.Mapping, confirmation.OnExisting, confirmation.Options,
		confirmation.PreflightStateFingerprint, confirmation.PreflightCatalogFingerprint,
		verificationMode)
	if !confirmation.preflightStillBinds(expectedPreflight, identityScan.RowsTotal,
		currentStateFingerprint, currentCatalogFingerprint) {
		writeJSONErr(w, http.StatusConflict, "preflight_required",
			"subscriber or custom-field state changed; run a fresh exhaustive preflight before confirming")
		return
	}
	if confirmation.OnExisting == "error" && (confirmation.PreflightRowsExisting != 0 || confirmation.PreflightRowsFailed != 0) {
		writeJSONErr(w, http.StatusConflict, "preflight_has_conflicts",
			"on_existing=error requires a clean exhaustive preflight with zero existing-subscriber conflicts and zero invalid rows")
		return
	}

	sched := confirmSchedule{
		ScheduleType: confirmation.Options.ScheduleType, ScheduleCron: confirmation.Options.ScheduleCron,
		ScheduledAt: confirmation.Options.ScheduledAt, DripHoursInterval: confirmation.Options.DripHoursInterval,
		DripHoursTotal: confirmation.Options.DripHoursTotal,
	}
	if validationErr := validateConfirmExecution(sched); validationErr != nil {
		writeJSONErr(w, http.StatusConflict, validationErr.code, validationErr.msg)
		return
	}
	nextRun := computeNextRun(sched, time.Now().UTC())

	// Short queue transaction. PATCH/Confirm races are resolved by the captured
	// revision and preflight CAS; the worker independently re-verifies source,
	// catalog, and subscriber-state watermarks at the execution boundary.
	tx, err := db.WithTenantOptions(r.Context(), d.Pool, t.ID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// The destination list is re-resolved at the commit point, in the queueing
	// transaction. A list deleted after it was chosen is refused here, where the
	// operator can pick another one — not discovered by the worker half way
	// through the file, with some contacts already written.
	if !d.targetListStillExists(w, r, tx, t.ID, confirmation.TargetListID) {
		return
	}
	consentFingerprint := confirmation.Options.consentFingerprint()
	if confirmation.Options.hasConsent() {
		var approvalID, databaseFingerprint string
		err := tx.QueryRow(r.Context(), `
SELECT approval_id::text, consent_fingerprint
  FROM create_subscriber_import_consent_approval(
	   $1::uuid, $2::uuid, $3, $4, $5
  )`, t.ID, id, expectedPreflight, confirmation.ConfigurationRevision,
			consentFingerprint).Scan(&approvalID, &databaseFingerprint)
		if err != nil || approvalID == "" || databaseFingerprint != consentFingerprint {
			writeJSONErr(w, http.StatusConflict, "confirmation_snapshot_stale",
				"the reviewed configuration changed before confirmation; reload and run a fresh preflight")
			return
		}
	}

	queuedStatus := importQueuedStatus(verificationMode)
	tag, err := tx.Exec(r.Context(),
		`UPDATE subscriber_imports
		    SET status = $8,
		        cancel_requested = false,
		        processed_rows = 0,
		        rows_imported = 0,
		        rows_skipped = 0,
		        rows_failed = 0,
		        next_scheduled_at = $3::timestamptz,
		        last_drip_at = NULL,
		        confirmed_consent_fingerprint = NULLIF($4, ''),
		        execution_state_fingerprint = NULL,
		        source_delete_after = NULL,
		        verification_mode = $7,
		        verification_state = CASE WHEN $7 = 'off' THEN 'off' ELSE 'pending' END,
		        verification_job_id = NULL,
		        verification_completed_at = NULL,
		        rows_verification_rejected = 0
		   WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'preview'
		     AND preflight_fingerprint = $5
		     AND configuration_revision = $6`,
		t.ID, id, nextRun, consentFingerprint, expectedPreflight, confirmation.ConfigurationRevision,
		verificationMode, queuedStatus)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSONErr(w, http.StatusConflict, "preflight_stale",
			"the import settings or preflight changed during confirmation; review a fresh exhaustive preflight")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	// 202 Accepted — the worker owns execution from here. The client
	// polls GET /{id} or streams GET /{id}/progress for completion.
	resp := map[string]any{
		"id":                           id,
		"status":                       "queued",
		"preflight_fingerprint":        expectedPreflight,
		"classification_authoritative": true,
		"verification_mode":            verificationMode,
		"consent_contract_state": func() string {
			if confirmation.Options.hasConsent() {
				return "complete"
			}
			return "none"
		}(),
	}
	if nextRun != nil {
		resp["scheduled"] = true
		resp["next_scheduled_at"] = nextRun.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusAccepted, resp)
}

// readSchedule loads the saved schedule columns of one preview row under
// tenant RLS. Returns an error when the row isn't visible/found so Confirm
// can fall back to the immediate default.
func (d *Deps) readSchedule(ctx context.Context, tenantID, importID string) (confirmSchedule, error) {
	var s confirmSchedule
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return s, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT COALESCE(schedule_type, 'immediate'),
       COALESCE(schedule_cron, ''),
       scheduled_at,
       COALESCE(drip_hours_interval, 0),
       COALESCE(drip_hours_total, 0)
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'preview'`,
		tenantID, importID).Scan(&s.ScheduleType, &s.ScheduleCron, &s.ScheduledAt,
		&s.DripHoursInterval, &s.DripHoursTotal)
	if err != nil {
		return s, err
	}
	if err := tx.Commit(ctx); err != nil {
		return s, err
	}
	return s, nil
}

func (d *Deps) readPreviewMapping(ctx context.Context, tenantID, importID string) (migratecsv.Mapping, error) {
	var mapping migratecsv.Mapping
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return mapping, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var encoded []byte
	err = tx.QueryRow(ctx, `
SELECT mapping
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'preview'`,
		tenantID, importID).Scan(&encoded)
	if err != nil {
		return mapping, err
	}
	if err := json.Unmarshal(encoded, &mapping); err != nil {
		return mapping, fmt.Errorf("decode subscriber import mapping: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapping, err
	}
	return mapping, nil
}

// Cancel POST /api/v1/subscriber-imports/{id}/cancel — set
// cancel_requested=true. The worker checks this flag between chunks
// (worker.go cancelRequested) and finalizes the row as 'cancelled'.
// SUB-103. Cancelling a job that already reached a terminal state
// (ready/failed/cancelled) is a 409 — there's nothing left to stop.
//
// The same route discards an unconfirmed upload ('preview'): it becomes
// 'cancelled' at once, and both its source object and its review data (sample
// rows, mapping, preflight results) fall due for the next purge tick instead
// of lingering for the 24-hour abandoned-preview window.
//
// A discard must never stop an import the person has already started, and
// the wizard can send one while its Confirm is still in flight or for a draft
// another tab confirmed. So a caller that means "discard" sends
// {"expected_status":"preview"}: the transition then applies only while the
// row is still a preview, and anything else answers 409 not_a_preview with
// the row untouched. Without the body the route keeps its cancel semantics.
func (d *Deps) Cancel(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	var in cancelInput
	if r.Body != nil {
		// The body is optional and older clients send none, or "{}" without a
		// Content-Type, so both stay a plain cancel.
		if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &in,
			httpbody.Options{AllowEmptyBody: true, AllowMissingContentType: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}
	if in.ExpectedStatus != "" && in.ExpectedStatus != importStatusPreview {
		writeJSONErr(w, http.StatusBadRequest, "invalid_expected_status",
			`expected_status accepts only "preview"`)
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var resultingStatus, verificationJobID string
	err = tx.QueryRow(r.Context(),
		`UPDATE subscriber_imports
		    SET cancel_requested = true,
		        status = CASE WHEN status IN ('preview','queued','verification_queued') THEN 'cancelled' ELSE status END,
		        completed_at = CASE WHEN status IN ('preview','queued','verification_queued') THEN now() ELSE completed_at END,
		        source_delete_after = CASE WHEN status IN ('preview','queued','verification_queued') THEN now() ELSE source_delete_after END,
		        review_data_expires_at = CASE WHEN status = 'preview' THEN now() ELSE review_data_expires_at END,
		        error_code = CASE WHEN status IN ('preview','queued','verification_queued') THEN NULL ELSE error_code END,
		        error = CASE WHEN status IN ('preview','queued','verification_queued') THEN NULL ELSE error END,
		        verification_state = CASE
		            WHEN status IN ('queued','verification_queued') AND verification_mode <> 'off' THEN 'failed'
		            ELSE verification_state END,
		        verification_completed_at = CASE
		            WHEN status IN ('queued','verification_queued') AND verification_mode <> 'off'
		            THEN COALESCE(verification_completed_at, now()) ELSE verification_completed_at END
		   WHERE tenant_id = $1::uuid AND id = $2::uuid
		     AND status IN ('preview', 'queued', 'running', 'verification_queued', 'verification_running')
		     AND ($3::text = '' OR status = $3::text)
		 RETURNING status, COALESCE(verification_job_id::text, '')`, t.ID, id, in.ExpectedStatus).
		Scan(&resultingStatus, &verificationJobID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if in.ExpectedStatus == importStatusPreview {
				writeJSONErr(w, http.StatusConflict, "not_a_preview",
					"This upload has already started importing, finished or been discarded, so there is nothing to discard.")
				return
			}
			writeJSONErr(w, http.StatusConflict, "not_cancellable", "job not found or not in a cancellable state")
			return
		}
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	if verificationJobID != "" {
		if d.ExecutionVerification == nil {
			writeSubscriberImportInternal(w, d.Logger,
				errors.New("subscriber import verification adapter is unavailable for cancellation"), r.Context())
			return
		}
		// Cancel the linked durable job before committing the import's terminal
		// transition. If cancellation is temporarily unavailable, rolling this
		// transaction back leaves the import retryably cancellable instead of
		// orphaning paid verification behind a terminal import row.
		if err := d.ExecutionVerification.CancelImportVerification(r.Context(), t.ID, verificationJobID); err != nil {
			writeSubscriberImportInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"id":               id,
		"status":           publicImportStatus(resultingStatus),
		"cancel_requested": true,
	})
}

// cancelInput is the optional body of POST /{id}/cancel. ExpectedStatus
// "preview" turns the call into a discard that only an unconfirmed upload
// accepts.
type cancelInput struct {
	ExpectedStatus string `json:"expected_status"`
}

// progressEvent is the per-tick SSE payload streamed by Progress. It
// mirrors the subscriber_imports progress columns the worker writes.
type progressEvent struct {
	Status        string `json:"status"`
	ProcessedRows int64  `json:"processed_rows"`
	TotalRows     int64  `json:"total_rows"`
	RowsImported  int64  `json:"rows_imported"`
	RowsSkipped   int64  `json:"rows_skipped"`
	RowsFailed    int64  `json:"rows_failed"`
}

// terminalStatus reports whether a status means the worker is done
// with the row — the SSE stream emits one final event and closes.
func terminalStatus(s string) bool {
	switch s {
	case "ready", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func publicImportStatus(status string) string {
	switch status {
	case importStatusVerificationQueued:
		return "queued"
	case importStatusVerificationRunning:
		return "running"
	default:
		return status
	}
}

// progressPollInterval is how often Progress re-reads the row. 1s is
// fast enough to feel live against the worker's 500-row chunks.
const progressPollInterval = 1 * time.Second

// progressMaxDuration caps a single SSE connection so a slept laptop
// or proxy flap can't leak a server goroutine. The browser's
// EventSource reconnects automatically.
const progressMaxDuration = 30 * time.Minute

// Progress GET /api/v1/subscriber-imports/{id}/progress — Server-Sent
// Events stream of the import's progress (SUB-103). Emits one
// `progress` event per poll while the worker advances, plus periodic
// `heartbeat` events so reverse proxies keep the idle connection open,
// and a final `progress` event when the row reaches a terminal status.
func (d *Deps) Progress(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	stream, ok := sse.Open(w)
	if !ok {
		writeJSONErr(w, http.StatusInternalServerError, "no_flusher",
			"server-sent events require a flushable writer")
		return
	}
	// Confirm the row exists under tenant RLS before we open the
	// stream, so a bad id gets a clean 404 instead of an empty SSE.
	ev, err := d.readProgress(r.Context(), t.ID, id)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "subscriber import not found")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx: don't buffer SSE
	w.WriteHeader(http.StatusOK)
	if stream.Flush() != nil {
		return
	}
	// Comment-style hello so EventSource fires onopen immediately.
	_, _ = fmt.Fprint(stream, ": stream open\n\n")
	emitProgress(stream, ev)
	if stream.Flush() != nil {
		return
	}
	if terminalStatus(ev.Status) {
		// Already done — nothing more to stream.
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), progressMaxDuration)
	defer cancel()
	poll := time.NewTicker(progressPollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = stream.Sendf("event: closed\ndata: {\"reason\":\"max_duration\"}\n\n")
			return
		case <-heartbeat.C:
			// A failed write means the client is gone.
			if stream.Sendf("event: heartbeat\ndata: {\"at\":%q}\n\n",
				time.Now().UTC().Format(time.RFC3339)) != nil {
				return
			}
		case <-poll.C:
			next, perr := d.readProgress(ctx, t.ID, id)
			if perr != nil {
				// Transient read error — next tick retries. A vanished
				// row (deleted mid-stream) would 0-row; tolerate it.
				continue
			}
			emitProgress(stream, next)
			if stream.Flush() != nil || terminalStatus(next.Status) {
				return
			}
		}
	}
}

// emitProgress writes one `progress` SSE event for ev. Takes an io.Writer
// (not http.ResponseWriter) so the framing is unit-testable in isolation.
func emitProgress(w io.Writer, ev progressEvent) {
	payload, err := json.Marshal(ev)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: progress\ndata: %s\n\n", payload)
}

// readProgress reads the current progress snapshot of one import row
// under tenant RLS. Returns an error when the row doesn't exist for
// the tenant (so Progress can 404 before opening the stream).
func (d *Deps) readProgress(ctx context.Context, tenantID, importID string) (progressEvent, error) {
	var ev progressEvent
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return ev, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT status,
       COALESCE(processed_rows, 0),
       COALESCE(rows_total, 0),
       COALESCE(rows_imported, 0),
       COALESCE(rows_skipped, 0),
       COALESCE(rows_failed, 0)
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, importID).Scan(&ev.Status, &ev.ProcessedRows, &ev.TotalRows,
		&ev.RowsImported, &ev.RowsSkipped, &ev.RowsFailed)
	if err != nil {
		return ev, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ev, err
	}
	ev.Status = publicImportStatus(ev.Status)
	return ev, nil
}

// processResult is the counter set the inline processor writes back.
type processResult struct {
	Imported             int64
	Skipped              int64
	Failed               int64
	VerificationRejected int64
}

// (The synchronous processImport / upsertRow path was removed in SUB-103:
// imports are now drained exclusively by the background Worker in worker.go,
// which shares buildRowFields + upsertSQL so the row-shaping logic stays in
// one place. Confirm flips the row to 'queued' and returns 202.)

// List GET /api/v1/subscriber-imports.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			writeJSONErr(w, http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 200")
			return
		}
		limit = parsed
	}
	var cursorAt any
	var cursorID any
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		decoded, err := decodeImportListCursor(raw)
		if err != nil {
			writeJSONErr(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed or expired")
			return
		}
		cursorAt, cursorID = decoded.CreatedAt, decoded.ID
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, original_filename, status,
       rows_total, rows_new, rows_existing, rows_file_dupes,
       rows_imported, rows_skipped, rows_failed,
	   on_existing, COALESCE(error_code,''), created_at,
	   COALESCE(processed_rows, 0), cancel_requested, last_chunk_at
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid
	AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
 ORDER BY created_at DESC, id DESC
 LIMIT $4`, t.ID, cursorAt, cursorID, limit+1)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	var lastCursor importListCursor
	hasMore := false
	for rows.Next() {
		var (
			id, fn, status, onExisting, jobErrorCode string
			createdAt                                time.Time
			rt, rn, re, rd, ri, rs, rf, processed    int64
			cancelRequested                          bool
			lastChunkAt                              *time.Time
		)
		if err := rows.Scan(&id, &fn, &status, &rt, &rn, &re, &rd,
			&ri, &rs, &rf, &onExisting, &jobErrorCode, &createdAt,
			&processed, &cancelRequested, &lastChunkAt); err != nil {
			writeSubscriberImportInternal(w, d.Logger, err, r.Context())
			return
		}
		if len(out) >= limit {
			hasMore = true
			break
		}
		status = publicImportStatus(status)
		out = append(out, map[string]any{
			"id":               id,
			"filename":         fn,
			"status":           status,
			"rows_total":       rt,
			"rows_new":         rn,
			"rows_existing":    re,
			"rows_file_dupes":  rd,
			"rows_imported":    ri,
			"rows_skipped":     rs,
			"rows_failed":      rf,
			"on_existing":      onExisting,
			"error_code":       safeImportJobErrorCode(jobErrorCode, status),
			"error":            safeImportJobErrorMessage(jobErrorCode, status),
			"created_at":       createdAt.UTC().Format(time.RFC3339Nano),
			"processed_rows":   processed,
			"cancel_requested": cancelRequested,
			"last_chunk_at":    rfc3339OrEmpty(lastChunkAt),
		})
		lastCursor = importListCursor{CreatedAt: createdAt.UTC(), ID: id}
	}
	if err := rows.Err(); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	rows.Close()
	if err := tx.Commit(r.Context()); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	nextCursor := ""
	if hasMore {
		nextCursor = encodeImportListCursor(lastCursor)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"imports": out, "has_more": hasMore, "next_cursor": nextCursor,
	})
}

type importListCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

func encodeImportListCursor(cursor importListCursor) string {
	raw, _ := json.Marshal(importListCursor{CreatedAt: cursor.CreatedAt.UTC(), ID: cursor.ID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeImportListCursor(raw string) (importListCursor, error) {
	var cursor importListCursor
	if len(raw) == 0 || len(raw) > 1024 {
		return importListCursor{}, errors.New("invalid import list cursor")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) > 512 || json.Unmarshal(decoded, &cursor) != nil ||
		cursor.CreatedAt.IsZero() || uuid.Validate(cursor.ID) != nil {
		return importListCursor{}, errors.New("invalid import list cursor")
	}
	return cursor, nil
}

// Get GET /api/v1/subscriber-imports/{id}.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		fn, status, onExisting, jobErrorCode      string
		createdAt                                 time.Time
		mapping, sample                           []byte
		sampleValuesTruncated                     bool
		rt, rn, re, rd, ri, rs, rf, processedRows int64
		cancelRequested                           bool
		lastChunkAt                               *time.Time
		configurationRevision                     int64
		opts                                      importOptions
		// SUB-104 schedule + SUB-105 dry-run echo.
		scheduleType, scheduleCron                                       string
		scheduledAt, nextScheduledAt                                     *time.Time
		dripInterval, dripTotal                                          int
		dryRun                                                           bool
		dryRunResultsJSON                                                []byte
		dryRunAt                                                         *time.Time
		preflightFingerprint, confirmedConsentFingerprint                string
		preflightAt                                                      *time.Time
		preflightExpiresAt                                               *time.Time
		preflightRowsTotal                                               *int64
		preflightRowsFailed, preflightRowsExisting                       int64
		preflightStateFingerprint, preflightCatalogFingerprint           string
		preflightVerificationMode, verificationMode, verificationState   string
		verificationJobID                                                string
		verificationCompletedAt                                          *time.Time
		rowsVerificationRejected                                         int64
		executionStateFingerprint                                        string
		rowsSendableAfter, rowsProtectedExisting, consentReceiptsWritten int64
		targetListID                                                     string
	)
	err = tx.QueryRow(r.Context(), `
SELECT original_filename, status, mapping, sample_rows, sample_values_truncated,
       rows_total, rows_new, rows_existing, rows_file_dupes,
       rows_imported, rows_skipped, rows_failed,
       on_existing, COALESCE(error_code,''), created_at,
       COALESCE(consent_source, ''), COALESCE(consent_source_url, ''),
       consent_captured_at, COALESCE(consent_legal_basis, ''),
       COALESCE(consent_jurisdiction, ''), COALESCE(consent_reason, ''),
       COALESCE(consent_policy_version, ''), COALESCE(consent_evidence_reference, ''),
       COALESCE(consent_scope, ''), consent_scope_acknowledged,
	   COALESCE(consent_contract_version, ''), COALESCE(source_fingerprint, ''),
	   COALESCE(source_fingerprint_scheme, ''), COALESCE(source_fingerprint_key_version, ''),
       COALESCE(tags, '{}'::text[]), auto_create_properties,
       COALESCE(schedule_type, 'immediate'), COALESCE(schedule_cron, ''),
       scheduled_at, next_scheduled_at,
       COALESCE(drip_hours_interval, 0), COALESCE(drip_hours_total, 0),
       COALESCE(dry_run, false), dry_run_results, dry_run_at,
	   COALESCE(preflight_fingerprint, ''), preflight_at, preflight_expires_at,
	   preflight_rows_total, COALESCE(preflight_rows_failed, 0),
	   COALESCE(preflight_rows_existing, 0), COALESCE(preflight_state_fingerprint, ''),
	   COALESCE(preflight_catalog_fingerprint, ''), COALESCE(preflight_verification_mode, 'off'),
       COALESCE(confirmed_consent_fingerprint, ''),
       COALESCE(rows_sendable_after, 0), COALESCE(rows_protected_existing, 0),
	   COALESCE(consent_receipts_written, 0), COALESCE(processed_rows, 0),
	   cancel_requested, last_chunk_at, COALESCE(configuration_revision, 0),
	   COALESCE(execution_state_fingerprint, ''),
	   COALESCE(verification_mode, 'off'), COALESCE(verification_state, 'off'),
	   COALESCE(verification_job_id::text, ''), verification_completed_at,
	   COALESCE(rows_verification_rejected, 0),
	   COALESCE(target_list_id::text, '')
  FROM subscriber_imports
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id).Scan(&fn, &status, &mapping, &sample, &sampleValuesTruncated,
		&rt, &rn, &re, &rd, &ri, &rs, &rf, &onExisting, &jobErrorCode, &createdAt,
		&opts.ConsentSource, &opts.ConsentSourceURL,
		&opts.ConsentCapturedAt, &opts.ConsentLegalBasis,
		&opts.ConsentJurisdiction, &opts.ConsentReason,
		&opts.ConsentPolicyVersion, &opts.ConsentEvidenceReference,
		&opts.ConsentScope, &opts.ConsentScopeAcknowledged,
		&opts.ConsentContractVersion, &opts.SourceFingerprint,
		&opts.SourceFingerprintScheme, &opts.SourceFingerprintKeyVersion,
		&opts.Tags, &opts.AutoCreateProps,
		&scheduleType, &scheduleCron, &scheduledAt, &nextScheduledAt,
		&dripInterval, &dripTotal,
		&dryRun, &dryRunResultsJSON, &dryRunAt,
		&preflightFingerprint, &preflightAt, &preflightExpiresAt, &preflightRowsTotal,
		&preflightRowsFailed, &preflightRowsExisting,
		&preflightStateFingerprint, &preflightCatalogFingerprint, &preflightVerificationMode,
		&confirmedConsentFingerprint, &rowsSendableAfter,
		&rowsProtectedExisting, &consentReceiptsWritten, &processedRows,
		&cancelRequested, &lastChunkAt, &configurationRevision, &executionStateFingerprint,
		&verificationMode, &verificationState, &verificationJobID, &verificationCompletedAt,
		&rowsVerificationRejected, &targetListID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "subscriber import not found")
		} else {
			writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	var m migratecsv.Mapping
	if err := json.Unmarshal(mapping, &m); err != nil {
		writeSubscriberImportInternal(w, d.Logger, fmt.Errorf("decode subscriber import mapping: %w", err), r.Context())
		return
	}
	var sampleRows []map[string]string
	if err := json.Unmarshal(sample, &sampleRows); err != nil {
		writeSubscriberImportInternal(w, d.Logger, fmt.Errorf("decode subscriber import sample: %w", err), r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	status = publicImportStatus(status)
	capturedAt := ""
	if opts.ConsentCapturedAt != nil {
		capturedAt = opts.ConsentCapturedAt.UTC().Format(time.RFC3339)
	}
	if opts.Tags == nil {
		opts.Tags = []string{}
	}
	opts.ScheduleType = scheduleType
	opts.ScheduleCron = scheduleCron
	opts.ScheduledAt = scheduledAt
	opts.DripHoursInterval = dripInterval
	opts.DripHoursTotal = dripTotal
	expectedPreflightFingerprint := computePreflightFingerprint(opts.SourceFingerprint, m, onExisting, opts,
		preflightStateFingerprint, preflightCatalogFingerprint, preflightVerificationMode)
	authoritative := importClassificationAuthoritative(status, opts.SourceFingerprint,
		opts.SourceFingerprintScheme, opts.SourceFingerprintKeyVersion,
		preflightFingerprint, expectedPreflightFingerprint,
		preflightStateFingerprint, preflightCatalogFingerprint,
		preflightRowsTotal, rt, preflightExpiresAt, time.Now().UTC())
	body := map[string]any{
		"id":                      id,
		"filename":                fn,
		"status":                  status,
		"mapping":                 m,
		"sample_rows":             sampleRows,
		"sample_values_truncated": sampleValuesTruncated,
		"rows_total":              rt,
		"rows_new":                rn,
		"rows_existing":           re,
		"rows_file_dupes":         rd,
		"rows_imported":           ri,
		"rows_skipped":            rs,
		"rows_failed":             rf,
		"on_existing":             onExisting,
		"error_code":              safeImportJobErrorCode(jobErrorCode, status),
		"error":                   safeImportJobErrorMessage(jobErrorCode, status),
		"created_at":              createdAt.UTC().Format(time.RFC3339Nano),
		"processed_rows":          processedRows,
		"cancel_requested":        cancelRequested,
		"last_chunk_at":           rfc3339OrEmpty(lastChunkAt),
		"configuration_revision":  configurationRevision,
		// A11 job-level options — echoed back so the wizard's
		// consent / tags / properties steps round-trip after PATCH.
		"consent_source":             opts.ConsentSource,
		"consent_source_url":         opts.ConsentSourceURL,
		"consent_captured_at":        capturedAt,
		"consent_legal_basis":        opts.ConsentLegalBasis,
		"consent_jurisdiction":       opts.ConsentJurisdiction,
		"consent_reason":             opts.ConsentReason,
		"consent_policy_version":     opts.ConsentPolicyVersion,
		"consent_evidence_reference": opts.ConsentEvidenceReference,
		"consent_scope":              opts.ConsentScope,
		"consent_scope_acknowledged": opts.ConsentScopeAcknowledged,
		"consent_contract_version":   opts.ConsentContractVersion,
		"consent_contract_state": func() string {
			if opts.hasConsent() {
				return "complete"
			}
			if opts.hasAnyConsentMetadata() {
				return "incomplete"
			}
			return "none"
		}(),
		"source_fingerprint":             opts.SourceFingerprint,
		"source_fingerprint_scheme":      opts.SourceFingerprintScheme,
		"source_fingerprint_key_version": opts.SourceFingerprintKeyVersion,
		"tags":                           opts.Tags,
		"auto_create_properties":         opts.AutoCreateProps,
		// The list imported contacts join ("" = none), so a reopened or resumed
		// wizard shows the choice that is actually stored.
		"target_list_id": targetListID,
		// Schedule state, including zeroed legacy columns retained by the schema.
		"schedule_type":       scheduleType,
		"schedule_cron":       scheduleCron,
		"scheduled_at":        rfc3339OrEmpty(scheduledAt),
		"next_scheduled_at":   rfc3339OrEmpty(nextScheduledAt),
		"drip_hours_interval": dripInterval,
		"drip_hours_total":    dripTotal,
		// SUB-105 dry-run — surfaces the last validation-only pass.
		"dry_run":                             dryRun,
		"dry_run_at":                          rfc3339OrEmpty(dryRunAt),
		"classification_authoritative":        authoritative,
		"preflight_required":                  status == "preview" && !authoritative,
		"preflight_fingerprint":               preflightFingerprint,
		"preflight_at":                        rfc3339OrEmpty(preflightAt),
		"preflight_expires_at":                rfc3339OrEmpty(preflightExpiresAt),
		"preflight_rows_total":                preflightRowsTotal,
		"preflight_rows_failed":               preflightRowsFailed,
		"preflight_rows_existing":             preflightRowsExisting,
		"preflight_state_fingerprint":         preflightStateFingerprint,
		"preflight_catalog_fingerprint":       preflightCatalogFingerprint,
		"preflight_verification_mode":         preflightVerificationMode,
		"execution_state_fingerprint":         executionStateFingerprint,
		"verification_mode":                   verificationMode,
		"verification_state":                  verificationState,
		"verification_job_id":                 verificationJobID,
		"verification_completed_at":           rfc3339OrEmpty(verificationCompletedAt),
		"rows_verification_rejected":          rowsVerificationRejected,
		"confirmed_consent_fingerprint":       confirmedConsentFingerprint,
		"rows_sendable_after":                 rowsSendableAfter,
		"rows_protected_existing":             rowsProtectedExisting,
		"consent_receipts_written":            consentReceiptsWritten,
		"existing_contact_eligibility_policy": "preserve",
	}
	if len(dryRunResultsJSON) > 0 {
		var drr dryRunResults
		if json.Unmarshal(dryRunResultsJSON, &drr) == nil {
			body["dry_run_results"] = drr
		}
	}
	setImportConfigurationETag(w, configurationRevision)
	writeJSON(w, http.StatusOK, body)
}

func importClassificationAuthoritative(
	status, sourceFingerprint, sourceScheme, sourceKeyVersion,
	preflightFingerprint, expectedPreflightFingerprint,
	stateFingerprint, catalogFingerprint string,
	preflightRowsTotal *int64, observedRowsTotal int64,
	expiresAt *time.Time, now time.Time,
) bool {
	return status == "preview" && sourceFingerprint != "" &&
		sourceScheme == sourceFingerprintScheme && sourceFingerprintKeyVersionRE.MatchString(sourceKeyVersion) &&
		preflightFingerprint != "" && preflightFingerprint == expectedPreflightFingerprint &&
		stateFingerprint != "" && catalogFingerprint != "" &&
		preflightRowsTotal != nil && *preflightRowsTotal == observedRowsTotal && observedRowsTotal >= 0 &&
		expiresAt != nil && expiresAt.After(now.UTC())
}

// rfc3339OrEmpty formats a nullable timestamp as RFC3339 UTC, or "".
func rfc3339OrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep errors imported for future typed-error sentinels.
var _ = errors.New
