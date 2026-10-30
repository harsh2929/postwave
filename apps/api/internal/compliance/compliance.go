// SPDX-License-Identifier: AGPL-3.0-only
//
// Package compliance implements the operator-facing compliance tracker for:
//
//   SOC 2, GDPR, CCPA, PCI DSS, ISO 27001, CAN-SPAM, CASL.
//
// The frontend `Compliance` page calls List to render the grid; each
// row carries the framework slug + status + attest/renewal stamps.
// HIPAA appears only as an explicit unsupported policy entry. Moosewave does
// not offer a Business Associate Agreement and customers must not upload,
// store, process, or send Protected Health Information (PHI). Historical BAA
// columns and ledger rows are preserved for record retention, but they do not
// authorize PHI use and are not exposed as readiness state.
//
// Endpoints:
//
//   GET    /api/v1/compliance/programs                  — list all
//   GET    /api/v1/compliance/programs/{framework}      — one
//   POST   /api/v1/compliance/programs/{framework}/attest  — sign/renew
//   POST   /api/v1/compliance/programs/{framework}/revoke  — undo
//   GET    /api/v1/compliance/programs/{framework}/events  — audit chain

package compliance

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Framework slugs — the canonical key used in the URL + in the
// (tenant_id, framework) PK. HIPAA is an informational unsupported entry and
// is never written to compliance_programs.
const (
	FrameworkHIPAA    = "hipaa"
	FrameworkSOC2     = "soc2"
	FrameworkGDPR     = "gdpr"
	FrameworkCCPA     = "ccpa"
	FrameworkPCIDSS   = "pci_dss"
	FrameworkISO27001 = "iso27001"
	FrameworkCANSPAM  = "can_spam"
	FrameworkCASL     = "casl"
)

// SupportedFrameworks is the static catalogue used by List to
// guarantee one row per framework, even when nothing has been
// attested yet. Order is the display order in the grid.
var SupportedFrameworks = []string{
	FrameworkHIPAA,
	FrameworkSOC2,
	FrameworkGDPR,
	FrameworkCCPA,
	FrameworkPCIDSS,
	FrameworkISO27001,
	FrameworkCANSPAM,
	FrameworkCASL,
}

// Program is one row in the per-framework state table.
type Program struct {
	Framework      string     `json:"framework"`
	Status         string     `json:"status"`
	SignedByEmail  string     `json:"signedByEmail,omitempty"`
	SignerName     string     `json:"signerName,omitempty"`
	DocumentPath   string     `json:"documentPath,omitempty"`
	DocumentSHA256 string     `json:"documentSha256,omitempty"`
	Notes          string     `json:"notes,omitempty"`
	AttestedAt     *time.Time `json:"attestedAt,omitempty"`
	RenewalAt      *time.Time `json:"renewalAt,omitempty"`
	UpdatedAt      *time.Time `json:"updatedAt,omitempty"`
}

// Event is one entry in a supported framework's attestation history.
type Event struct {
	ID              int64          `json:"id"`
	Framework       string         `json:"framework"`
	EventType       string         `json:"eventType"`
	SignedByEmail   string         `json:"signedByEmail,omitempty"`
	CounterSignedBy string         `json:"counterSignedBy,omitempty"`
	DocumentPath    string         `json:"documentPath,omitempty"`
	DocumentSHA256  string         `json:"documentSha256,omitempty"`
	Notes           string         `json:"notes,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
	At              time.Time      `json:"at"`
}

const (
	complianceEventPageLimit   = 100
	maxEventMetadataBytes      = 4 << 10
	maxEventMetadataProperties = 256
)

type eventCursor struct {
	TenantID  string    `json:"tenantId"`
	Framework string    `json:"framework"`
	At        time.Time `json:"at"`
	ID        int64     `json:"id"`
}

func encodeEventCursor(tenantID, framework string, event Event) (string, error) {
	encoded, err := json.Marshal(eventCursor{
		TenantID: tenantID, Framework: framework, At: event.At, ID: event.ID,
	})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func parseEventCursor(r *http.Request, tenantID, framework string) (*eventCursor, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, errors.New("compliance event query is malformed")
	}
	for key, values := range query {
		if key != "cursor" {
			return nil, errors.New("unsupported compliance event query parameter")
		}
		if len(values) != 1 || values[0] == "" {
			return nil, errors.New("compliance event cursor must be supplied exactly once")
		}
	}
	values, ok := query["cursor"]
	if !ok {
		return nil, nil
	}
	raw := values[0]
	if len(raw) > 512 || strings.TrimSpace(raw) != raw {
		return nil, errors.New("compliance event cursor is malformed")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) == 0 || len(decoded) > 256 {
		return nil, errors.New("compliance event cursor is malformed")
	}
	var cursor eventCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.At.IsZero() || cursor.ID <= 0 ||
		cursor.TenantID != tenantID || cursor.Framework != framework {
		return nil, errors.New("compliance event cursor is malformed")
	}
	canonical, err := json.Marshal(cursor)
	if err != nil || base64.RawURLEncoding.EncodeToString(canonical) != raw {
		return nil, errors.New("compliance event cursor is non-canonical")
	}
	return &cursor, nil
}

// Deps wires the compliance handlers.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

// MountRoutes registers the compliance endpoints. The caller is
// expected to wrap them with the admin scope.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/compliance/programs", d.ListPrograms)
	r.Get("/api/v1/compliance/programs/{framework}", d.GetProgram)
	r.Post("/api/v1/compliance/programs/{framework}/attest", d.AttestProgram)
	r.Post("/api/v1/compliance/programs/{framework}/revoke", d.RevokeProgram)
	r.Get("/api/v1/compliance/programs/{framework}/events", d.ListEvents)
}

// ListPrograms GET /api/v1/compliance/programs.
//
// Returns one row per catalogue entry. HIPAA is always returned as
// status="unsupported"; other missing rows use status="in_progress".
func (d *Deps) ListPrograms(w http.ResponseWriter, r *http.Request) {
	setPrivateResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	stored := map[string]Program{}
	rows, err := tx.Query(r.Context(), `
SELECT framework, status, signed_by_email, signer_name,
       document_path, document_sha256, notes,
       attested_at, renewal_at, updated_at
  FROM compliance_programs
 WHERE tenant_id = $1::uuid`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for rows.Next() {
		var p Program
		var attestedAt, renewalAt, updatedAt *time.Time
		if err := rows.Scan(&p.Framework, &p.Status, &p.SignedByEmail,
			&p.SignerName, &p.DocumentPath, &p.DocumentSHA256, &p.Notes,
			&attestedAt, &renewalAt, &updatedAt); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		p.AttestedAt = attestedAt
		p.RenewalAt = renewalAt
		p.UpdatedAt = updatedAt
		if err := validateProgramOutput(p); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		stored[p.Framework] = p
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rows.Close()

	out := make([]Program, 0, len(SupportedFrameworks))
	for _, fw := range SupportedFrameworks {
		if fw == FrameworkHIPAA {
			out = append(out, unsupportedHIPAAProgram())
			continue
		}
		if p, ok := stored[fw]; ok {
			out = append(out, p)
		} else {
			out = append(out, Program{Framework: fw, Status: "in_progress"})
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"programs": out})
}

// GetProgram GET /api/v1/compliance/programs/{framework}.
func (d *Deps) GetProgram(w http.ResponseWriter, r *http.Request) {
	setPrivateResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	fw := chi.URLParam(r, "framework")
	if !isSupported(fw) {
		writeJSONErr(w, http.StatusNotFound, "unknown_framework", "")
		return
	}
	if fw == FrameworkHIPAA {
		writeJSON(w, http.StatusOK, unsupportedHIPAAProgram())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var p Program
	p.Framework = fw
	p.Status = "in_progress"
	var attestedAt, renewalAt, updatedAt *time.Time
	err = tx.QueryRow(r.Context(), `
SELECT status, signed_by_email, signer_name,
       document_path, document_sha256, notes,
       attested_at, renewal_at, updated_at
  FROM compliance_programs
 WHERE tenant_id = $1::uuid AND framework = $2`, t.ID, fw,
	).Scan(&p.Status, &p.SignedByEmail, &p.SignerName,
		&p.DocumentPath, &p.DocumentSHA256, &p.Notes,
		&attestedAt, &renewalAt, &updatedAt)
	if err == nil {
		p.AttestedAt = attestedAt
		p.RenewalAt = renewalAt
		p.UpdatedAt = updatedAt
	} else if !errors.Is(err, pgx.ErrNoRows) {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := validateProgramOutput(p); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type attestReq struct {
	SignedByEmail  string     `json:"signedByEmail"`
	SignerName     string     `json:"signerName"`
	DocumentPath   string     `json:"documentPath"`
	DocumentSHA256 string     `json:"documentSha256"`
	Notes          string     `json:"notes"`
	RenewalAt      *time.Time `json:"renewalAt"`
	// ExpectedUpdatedAt is omitted only when the caller has freshly observed
	// that no stored programme row exists. Existing rows require the exact
	// timestamp returned by Get/List; the upsert predicate enforces the check
	// atomically, including two clients racing to create the first row.
	ExpectedUpdatedAt *time.Time `json:"expectedUpdatedAt"`
}

const (
	maxSignerEmailBytes  = 320
	maxSignerNameBytes   = 200
	maxDocumentPathBytes = 2048
	maxNotesBytes        = 4000
	maxRevokeReasonBytes = 2000
)

var sha256HexRE = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validateProgramOutput(p Program) error {
	if len(p.Framework) > 32 || len(p.Status) > 32 ||
		len(p.SignedByEmail) > maxSignerEmailBytes ||
		len(p.SignerName) > maxSignerNameBytes ||
		len(p.DocumentPath) > maxDocumentPathBytes ||
		len(p.Notes) > maxNotesBytes ||
		(len(p.DocumentSHA256) > 0 && !sha256HexRE.MatchString(strings.ToLower(p.DocumentSHA256))) {
		return errors.New("stored compliance programme exceeds the bounded response contract")
	}
	switch p.Status {
	case "attested", "in_progress", "revoked", "unsupported":
	default:
		return errors.New("stored compliance programme has an unknown status")
	}
	if (p.Status == "attested" || p.Status == "revoked") &&
		(p.AttestedAt == nil || p.UpdatedAt == nil) {
		return errors.New("stored compliance programme is missing lifecycle evidence")
	}
	return nil
}

func validateEventOutput(event Event) error {
	if event.ID <= 0 || len(event.Framework) > 32 ||
		len(event.SignedByEmail) > maxSignerEmailBytes ||
		len(event.CounterSignedBy) > maxSignerNameBytes ||
		len(event.DocumentPath) > maxDocumentPathBytes ||
		len(event.Notes) > maxNotesBytes ||
		(len(event.DocumentSHA256) > 0 && !sha256HexRE.MatchString(strings.ToLower(event.DocumentSHA256))) {
		return errors.New("stored compliance event exceeds the bounded response contract")
	}
	switch event.EventType {
	case "attested", "revoked", "renewed", "amended":
	default:
		return errors.New("stored compliance event has an unknown event type")
	}
	if len(event.Metadata) > maxEventMetadataProperties {
		return errors.New("stored compliance event metadata exceeds the bounded response contract")
	}
	if len(event.Metadata) > 0 {
		encoded, err := json.Marshal(event.Metadata)
		if err != nil || len(encoded) > maxEventMetadataBytes {
			return errors.New("stored compliance event metadata exceeds the bounded response contract")
		}
	}
	return nil
}

func hasUnsafeControl(value string) bool {
	return strings.ContainsAny(value, "\x00\r\n")
}

func validateAttestRequest(req *attestReq, now time.Time) (string, string) {
	req.SignedByEmail = strings.TrimSpace(req.SignedByEmail)
	req.SignerName = strings.TrimSpace(req.SignerName)
	req.DocumentPath = strings.TrimSpace(req.DocumentPath)
	req.DocumentSHA256 = strings.ToLower(strings.TrimSpace(req.DocumentSHA256))
	req.Notes = strings.TrimSpace(req.Notes)

	if req.SignedByEmail == "" {
		return "missing_signer", "signedByEmail required"
	}
	if len(req.SignedByEmail) > maxSignerEmailBytes || hasUnsafeControl(req.SignedByEmail) {
		return "invalid_signer", "signedByEmail must be a single address of at most 320 bytes"
	}
	parsed, err := mail.ParseAddress(req.SignedByEmail)
	if err != nil || parsed.Address != req.SignedByEmail {
		return "invalid_signer", "signedByEmail must be a valid email address without a display name"
	}
	if len(req.SignerName) > maxSignerNameBytes || hasUnsafeControl(req.SignerName) {
		return "invalid_signer_name", "signerName must be at most 200 bytes and contain no line breaks"
	}
	if len(req.DocumentPath) > maxDocumentPathBytes || hasUnsafeControl(req.DocumentPath) {
		return "invalid_document_path", "documentPath must be at most 2048 bytes and contain no line breaks"
	}
	if req.DocumentSHA256 != "" && !sha256HexRE.MatchString(req.DocumentSHA256) {
		return "invalid_document_sha256", "documentSha256 must be exactly 64 hexadecimal characters"
	}
	if len(req.Notes) > maxNotesBytes || strings.ContainsRune(req.Notes, '\x00') {
		return "invalid_notes", "notes must be at most 4000 bytes and contain no null bytes"
	}
	if req.RenewalAt != nil {
		if req.RenewalAt.Before(now.Add(-24 * time.Hour)) {
			return "invalid_renewal_at", "renewalAt cannot be in the past"
		}
		if req.RenewalAt.After(now.AddDate(10, 0, 0)) {
			return "invalid_renewal_at", "renewalAt cannot be more than 10 years in the future"
		}
	}
	if req.ExpectedUpdatedAt != nil && req.ExpectedUpdatedAt.IsZero() {
		return "invalid_precondition", "expectedUpdatedAt must be the exact timestamp returned by the programme detail"
	}
	return "", ""
}

// attestProgramUpsertSQL is the AttestProgram upsert statement, lifted to
// a package-level constant so the regression test in compliance_test.go
// can assert on its shape without standing up a database.
//
// Renewal-friendly behavior: when a renewal request omits the document
// hash/path (e.g. the operator is just bumping renewal_at and keeping the
// previously-signed document), the prior values MUST be preserved. The
// earlier `document_sha256 = EXCLUDED.document_sha256` form silently wiped
// the prior hash whenever the caller sent an empty string — which broke
// the auditable hash chain after the first renewal. Mapping empty input
// to NULL via NULLIF and then COALESCEing against the existing row keeps
// the prior value intact while still allowing an explicit replacement
// when a fresh hash IS supplied.
const attestProgramUpsertSQL = `
INSERT INTO compliance_programs
  (tenant_id, framework, status, signed_by_email, signer_name,
   document_path, document_sha256, notes, attested_at, renewal_at, updated_at)
VALUES ($1::uuid, $2, 'attested', $3, $4, $5, $6, $7, now(), $8, now())
ON CONFLICT (tenant_id, framework) DO UPDATE
   SET status          = 'attested',
       signed_by_email = EXCLUDED.signed_by_email,
       signer_name     = EXCLUDED.signer_name,
       document_path   = COALESCE(NULLIF(EXCLUDED.document_path, ''),   compliance_programs.document_path),
       document_sha256 = COALESCE(NULLIF(EXCLUDED.document_sha256, ''), compliance_programs.document_sha256),
       notes           = EXCLUDED.notes,
       attested_at     = COALESCE(compliance_programs.attested_at, EXCLUDED.attested_at),
       renewal_at      = EXCLUDED.renewal_at,
       updated_at      = clock_timestamp()
 WHERE compliance_programs.updated_at = $9
RETURNING updated_at, document_path, document_sha256`

// AttestProgram POST /api/v1/compliance/programs/{framework}/attest.
//
// Upserts the program row + writes an event. HIPAA always returns 409 because
// Moosewave does not offer a BAA and cannot accept PHI workloads.
func (d *Deps) AttestProgram(w http.ResponseWriter, r *http.Request) {
	setPrivateResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	fw := chi.URLParam(r, "framework")
	if !isSupported(fw) {
		writeJSONErr(w, http.StatusNotFound, "unknown_framework", "")
		return
	}
	if fw == FrameworkHIPAA {
		writeJSONErr(w, http.StatusConflict, "framework_unavailable",
			hipaaUnsupportedReason)
		return
	}
	var req attestReq
	if err := httpbody.DecodeJSON(w, r, 16<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if code, message := validateAttestRequest(&req, time.Now()); code != "" {
		writeJSONErr(w, http.StatusBadRequest, code, message)
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Determine the event type — first attestation vs renewal.
	var prevStatus string
	var previousUpdatedAt time.Time
	err = tx.QueryRow(r.Context(),
		`SELECT status, updated_at FROM compliance_programs WHERE tenant_id = $1::uuid AND framework = $2`,
		t.ID, fw).Scan(&prevStatus, &previousUpdatedAt)
	switch {
	case err == nil && req.ExpectedUpdatedAt == nil:
		writeJSONErr(w, http.StatusPreconditionRequired, "precondition_required",
			"expectedUpdatedAt is required when changing an existing compliance programme")
		return
	case err == nil && !previousUpdatedAt.Equal(*req.ExpectedUpdatedAt):
		writeJSONErr(w, http.StatusConflict, "stale_program",
			"The compliance programme changed after it was loaded; refresh and review the latest evidence")
		return
	case errors.Is(err, pgx.ErrNoRows) && req.ExpectedUpdatedAt != nil:
		writeJSONErr(w, http.StatusConflict, "stale_program",
			"The compliance programme no longer matches the loaded state; refresh and retry")
		return
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	eventType := "attested"
	if prevStatus == "attested" {
		eventType = "renewed"
	}

	var updatedAt time.Time
	var effectiveDocumentPath, effectiveDocumentSHA256 string
	if err := tx.QueryRow(r.Context(), attestProgramUpsertSQL,
		t.ID, fw, req.SignedByEmail, req.SignerName,
		req.DocumentPath, req.DocumentSHA256, req.Notes, req.RenewalAt,
		req.ExpectedUpdatedAt,
	).Scan(&updatedAt, &effectiveDocumentPath, &effectiveDocumentSHA256); errors.Is(err, pgx.ErrNoRows) {
		writeJSONErr(w, http.StatusConflict, "stale_program",
			"The compliance programme changed while this request was being recorded; refresh and review the latest evidence")
		return
	} else if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	if _, err := tx.Exec(r.Context(), `
INSERT INTO compliance_program_events
  (tenant_id, framework, event_type, signed_by_email, counter_signed_by,
   document_path, document_sha256, notes)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
		t.ID, fw, eventType, req.SignedByEmail, req.SignerName,
		effectiveDocumentPath, effectiveDocumentSHA256, req.Notes,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Audit emit — Phase 5 wiring. One row per mutation: capture the
	// prior status as before-state and the new attested/renewed shape
	// as after-state so the Compliance UI can diff renewals cleanly.
	var beforeState map[string]any
	if prevStatus != "" {
		beforeState = map[string]any{"status": prevStatus}
	}
	audit.EmitOrLog(r.Context(), d.Pool, "compliance.attest", "compliance_program", fw,
		beforeState,
		map[string]any{
			"framework":    fw,
			"status":       "attested",
			"event_type":   eventType,
			"signed_by":    req.SignedByEmail,
			"signer_name":  req.SignerName,
			"document_sha": effectiveDocumentSHA256,
		},
		nil,
	)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "framework": fw, "updatedAt": updatedAt,
	})
}

type revokeReq struct {
	Reason            string     `json:"reason"`
	ExpectedUpdatedAt *time.Time `json:"expectedUpdatedAt"`
}

func validateRevokeRequest(req *revokeReq) (string, string) {
	req.Reason = strings.TrimSpace(req.Reason)
	if len(req.Reason) > maxRevokeReasonBytes || strings.ContainsRune(req.Reason, '\x00') {
		return "invalid_reason", "reason must be at most 2000 bytes and contain no null bytes"
	}
	if req.ExpectedUpdatedAt == nil || req.ExpectedUpdatedAt.IsZero() {
		return "precondition_required", "expectedUpdatedAt must be the exact timestamp returned by the attested programme detail"
	}
	return "", ""
}

// RevokeProgram POST /api/v1/compliance/programs/{framework}/revoke.
func (d *Deps) RevokeProgram(w http.ResponseWriter, r *http.Request) {
	setPrivateResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	fw := chi.URLParam(r, "framework")
	if !isSupported(fw) {
		writeJSONErr(w, http.StatusNotFound, "unknown_framework", "")
		return
	}
	if fw == FrameworkHIPAA {
		writeJSONErr(w, http.StatusConflict, "framework_unavailable",
			hipaaUnsupportedReason)
		return
	}
	var req revokeReq
	if err := httpbody.DecodeJSONWith(w, r, 4<<10, &req, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if code, message := validateRevokeRequest(&req); code != "" {
		status := http.StatusBadRequest
		if code == "precondition_required" {
			status = http.StatusPreconditionRequired
		}
		writeJSONErr(w, status, code, message)
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var updatedAt time.Time
	if err := tx.QueryRow(r.Context(), `
UPDATE compliance_programs
	SET status = 'revoked', updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND framework = $2
	AND status = 'attested' AND updated_at = $3
RETURNING updated_at`, t.ID, fw, req.ExpectedUpdatedAt).Scan(&updatedAt); errors.Is(err, pgx.ErrNoRows) {
		writeJSONErr(w, http.StatusConflict, "stale_program",
			"The programme is no longer the attested revision you reviewed; refresh before revoking")
		return
	} else if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(), `
INSERT INTO compliance_program_events
  (tenant_id, framework, event_type, notes)
VALUES ($1::uuid, $2, 'revoked', $3)`, t.ID, fw, req.Reason); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Audit emit — Phase 5 wiring. Reason flows through the metadata
	// context block so it surfaces under payload.context.reason in the
	// Compliance UI without colliding with before/after.
	beforeState := map[string]any{"status": "attested"}
	var metadata map[string]any
	if strings.TrimSpace(req.Reason) != "" {
		metadata = map[string]any{"reason": req.Reason}
	}
	audit.EmitOrLog(r.Context(), d.Pool, "compliance.revoke", "compliance_program", fw,
		beforeState,
		map[string]any{"framework": fw, "status": "revoked"},
		metadata,
	)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updatedAt": updatedAt})
}

// ListEvents GET /api/v1/compliance/programs/{framework}/events.
//
// HIPAA returns an empty informational response because the legacy BAA ledger
// is preserved as historical storage, not exposed as an active product flow.
// Other frameworks read from compliance_program_events.
func (d *Deps) ListEvents(w http.ResponseWriter, r *http.Request) {
	setPrivateResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	fw := chi.URLParam(r, "framework")
	if !isSupported(fw) {
		writeJSONErr(w, http.StatusNotFound, "unknown_framework", "")
		return
	}
	cursor, err := parseEventCursor(r, t.ID, fw)
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "invalid_cursor", err.Error())
		return
	}
	if fw == FrameworkHIPAA {
		writeJSON(w, http.StatusOK, map[string]any{
			"framework":  FrameworkHIPAA,
			"status":     "unsupported",
			"reason":     hipaaUnsupportedReason,
			"events":     []Event{},
			"hasMore":    false,
			"limit":      complianceEventPageLimit,
			"nextCursor": nil,
		})
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var cursorAt *time.Time
	var cursorID int64
	if cursor != nil {
		cursorAt = &cursor.At
		cursorID = cursor.ID
	}
	rows, err := tx.Query(r.Context(), `
SELECT id, event_type, signed_by_email, counter_signed_by,
       document_path, document_sha256, notes, metadata, at
  FROM compliance_program_events
 WHERE tenant_id = $1::uuid AND framework = $2
	AND ($3::timestamptz IS NULL OR (at, id) < ($3::timestamptz, $4::bigint))
 ORDER BY at DESC, id DESC LIMIT $5`, t.ID, fw, cursorAt, cursorID, complianceEventPageLimit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out := []Event{}
	for rows.Next() {
		var e Event
		var meta map[string]any
		if err := rows.Scan(&e.ID, &e.EventType, &e.SignedByEmail,
			&e.CounterSignedBy, &e.DocumentPath, &e.DocumentSHA256,
			&e.Notes, &meta, &e.At); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		e.Framework = fw
		if len(meta) > 0 {
			e.Metadata = meta
		}
		if err := validateEventOutput(e); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rows.Close()
	hasMore := len(out) > complianceEventPageLimit
	var nextCursor any
	if hasMore {
		out = out[:complianceEventPageLimit]
		encodedCursor, err := encodeEventCursor(t.ID, fw, out[len(out)-1])
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		nextCursor = encodedCursor
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"events": out, "hasMore": hasMore,
		"limit": complianceEventPageLimit, "nextCursor": nextCursor,
	})
}

const hipaaUnsupportedReason = "Moosewave does not offer a Business Associate Agreement and must not be used to upload, store, process, or send Protected Health Information (PHI)"

func unsupportedHIPAAProgram() Program {
	return Program{
		Framework: FrameworkHIPAA,
		Status:    "unsupported",
		Notes:     hipaaUnsupportedReason,
	}
}

func isSupported(fw string) bool {
	for _, f := range SupportedFrameworks {
		if f == fw {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	setPrivateResponseHeaders(w)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func setPrivateResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// Reference imports kept so build tags don't strip them out
// if a future refactor temporarily drops a caller.
var (
	_ = context.Background
	_ = errors.New
)
