// SPDX-License-Identifier: AGPL-3.0-only

package compliance

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func hipaaRequest(method, path string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("framework", FrameworkHIPAA)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	return req.WithContext(ctx)
}

func TestHIPAAProgramIsAlwaysUnsupported(t *testing.T) {
	program := unsupportedHIPAAProgram()
	if program.Framework != FrameworkHIPAA || program.Status != "unsupported" {
		t.Fatalf("unexpected HIPAA policy program: %#v", program)
	}
	if !strings.Contains(program.Notes, "does not offer a Business Associate Agreement") ||
		!strings.Contains(program.Notes, "must not be used") {
		t.Fatalf("HIPAA policy reason is not explicit: %q", program.Notes)
	}
}

func TestHIPAAAttestationCannotBeSelfAsserted(t *testing.T) {
	w := httptest.NewRecorder()
	(&Deps{}).AttestProgram(w, hipaaRequest(http.MethodPost, "/api/v1/compliance/programs/hipaa/attest"))
	if w.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"framework_unavailable"`) ||
		!strings.Contains(w.Body.String(), "Protected Health Information") {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}

func TestHIPAAProgramDoesNotExposeLegacyReadiness(t *testing.T) {
	w := httptest.NewRecorder()
	(&Deps{}).GetProgram(w, hipaaRequest(http.MethodGet, "/api/v1/compliance/programs/hipaa"))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"status":"unsupported"`) {
		t.Fatalf("unexpected response: %s", body)
	}
	for _, forbidden := range []string{"baa_signed", "is_phi_ready", "redirectToHipaaModule"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("response exposed retired field %q: %s", forbidden, body)
		}
	}
}

func TestRetiredHIPAARoutesAreNotMounted(t *testing.T) {
	router := chi.NewRouter()
	(&Deps{}).MountRoutes(router)

	for _, route := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/hipaa/status"},
		{http.MethodPost, "/api/v1/hipaa/sign"},
		{http.MethodPost, "/api/v1/hipaa/revoke"},
		{http.MethodGet, "/api/v1/hipaa/events"},
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`)))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s %s status=%d, want 404", route.method, route.path, w.Code)
		}
	}
}

// TestAttestProgramUpsert_PreservesPriorHashOnEmptyInput is a regression
// test for a P0 audit-chain bug. The previous form of the upsert clause:
//
//	document_sha256 = EXCLUDED.document_sha256
//
// wiped the previously-attested SHA-256 whenever a renewal request was
// posted without a fresh hash (which the API treats as the empty
// string). That broke the auditable hash chain — every renewal that
// only bumped renewal_at would zero out the prior document_sha256 on
// the row, even though the underlying signed document was unchanged.
//
// The fix maps empty input to NULL via NULLIF(...) and then COALESCEs
// against the existing row so the prior hash survives renewal:
//
//	document_sha256 = COALESCE(NULLIF(EXCLUDED.document_sha256, ''),
//	                           compliance_programs.document_sha256)
//
// This test guards the SQL string so a future refactor cannot silently
// regress the behaviour. The same guarantee applies to document_path,
// which shared the same wiping bug.
func TestAttestProgramUpsert_PreservesPriorHashOnEmptyInput(t *testing.T) {
	sql := attestProgramUpsertSQL

	// The fix MUST be present for document_sha256: empty new input
	// falls through to the prior column value.
	wantHashClause := "document_sha256 = COALESCE(NULLIF(EXCLUDED.document_sha256, ''), compliance_programs.document_sha256)"
	if !strings.Contains(normalizeSpaces(sql), normalizeSpaces(wantHashClause)) {
		t.Errorf("attest upsert MUST preserve prior document_sha256 on empty input.\n"+
			"want substring: %q\nin SQL:\n%s", wantHashClause, sql)
	}

	// document_path shared the same wiping bug — guard it too.
	wantPathClause := "document_path = COALESCE(NULLIF(EXCLUDED.document_path, ''), compliance_programs.document_path)"
	if !strings.Contains(normalizeSpaces(sql), normalizeSpaces(wantPathClause)) {
		t.Errorf("attest upsert MUST preserve prior document_path on empty input.\n"+
			"want substring: %q\nin SQL:\n%s", wantPathClause, sql)
	}

	// Defence-in-depth: the regressing form (direct overwrite from
	// EXCLUDED) MUST NOT reappear for these two columns. Catch any
	// future refactor that drops the COALESCE wrapper.
	bad := []string{
		"document_sha256 = EXCLUDED.document_sha256",
		"document_path   = EXCLUDED.document_path",
		"document_path = EXCLUDED.document_path",
	}
	norm := normalizeSpaces(sql)
	for _, b := range bad {
		if strings.Contains(norm, normalizeSpaces(b)) {
			t.Errorf("attest upsert MUST NOT directly overwrite from EXCLUDED for hash/path: found %q", b)
		}
	}
}

// TestAttestProgramUpsert_AcceptsExplicitReplacement documents the
// other half of the contract: when the caller DOES supply a non-empty
// new hash/path, the upsert must accept it (i.e. NULLIF must only
// suppress the empty-string case, not real values). Verified at the
// SQL-shape level — full behavioural verification requires a DB.
func TestAttestProgramUpsert_AcceptsExplicitReplacement(t *testing.T) {
	sql := normalizeSpaces(attestProgramUpsertSQL)

	// EXCLUDED.document_sha256 must still appear inside the COALESCE
	// (as the first NULLIF arg) — otherwise replacement would be
	// impossible and renewals could never update the hash.
	if !strings.Contains(sql, "NULLIF(EXCLUDED.document_sha256, '')") {
		t.Errorf("attest upsert MUST still reference EXCLUDED.document_sha256 inside NULLIF for explicit replacement.\nSQL:\n%s", sql)
	}
	if !strings.Contains(sql, "NULLIF(EXCLUDED.document_path, '')") {
		t.Errorf("attest upsert MUST still reference EXCLUDED.document_path inside NULLIF for explicit replacement.\nSQL:\n%s", sql)
	}
}

func TestAttestProgramUpsert_RequiresExactRevisionOnConflict(t *testing.T) {
	sql := normalizeSpaces(attestProgramUpsertSQL)
	for _, clause := range []string{
		"WHERE compliance_programs.updated_at = $9",
		"RETURNING updated_at, document_path, document_sha256",
	} {
		if !strings.Contains(sql, normalizeSpaces(clause)) {
			t.Fatalf("attest upsert lost atomic stale-write guard %q\nSQL:\n%s", clause, sql)
		}
	}
}

func TestValidateAttestRequestBoundsAndNormalizesEvidence(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	renewal := now.AddDate(1, 0, 0)
	expected := now.Add(-time.Hour)
	req := attestReq{
		SignedByEmail:     "  owner@example.com ",
		SignerName:        " Counsel ",
		DocumentPath:      " s3://private/evidence.pdf ",
		DocumentSHA256:    strings.ToUpper(strings.Repeat("a", 64)),
		Notes:             " Reviewed ",
		RenewalAt:         &renewal,
		ExpectedUpdatedAt: &expected,
	}
	if code, message := validateAttestRequest(&req, now); code != "" {
		t.Fatalf("valid request rejected: %s %s", code, message)
	}
	if req.SignedByEmail != "owner@example.com" || req.SignerName != "Counsel" ||
		req.DocumentSHA256 != strings.Repeat("a", 64) || req.Notes != "Reviewed" {
		t.Fatalf("request was not normalized: %#v", req)
	}

	tests := []struct {
		name   string
		mutate func(*attestReq)
		want   string
	}{
		{"display-name email", func(r *attestReq) { r.SignedByEmail = "Owner <owner@example.com>" }, "invalid_signer"},
		{"bad sha", func(r *attestReq) { r.DocumentSHA256 = "abc" }, "invalid_document_sha256"},
		{"path line break", func(r *attestReq) { r.DocumentPath = "s3://bucket/key\nforged" }, "invalid_document_path"},
		{"notes too long", func(r *attestReq) { r.Notes = strings.Repeat("n", maxNotesBytes+1) }, "invalid_notes"},
		{"renewal too old", func(r *attestReq) { value := now.Add(-48 * time.Hour); r.RenewalAt = &value }, "invalid_renewal_at"},
		{"zero precondition", func(r *attestReq) { value := time.Time{}; r.ExpectedUpdatedAt = &value }, "invalid_precondition"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := req
			tt.mutate(&candidate)
			if code, _ := validateAttestRequest(&candidate, now); code != tt.want {
				t.Fatalf("code=%q, want %q", code, tt.want)
			}
		})
	}
}

func TestValidateRevokeRequestRequiresRevisionAndBoundsReason(t *testing.T) {
	missing := revokeReq{Reason: "reviewed"}
	if code, _ := validateRevokeRequest(&missing); code != "precondition_required" {
		t.Fatalf("missing revision code=%q", code)
	}

	version := time.Now().UTC()
	tooLong := revokeReq{
		Reason:            strings.Repeat("r", maxRevokeReasonBytes+1),
		ExpectedUpdatedAt: &version,
	}
	if code, _ := validateRevokeRequest(&tooLong); code != "invalid_reason" {
		t.Fatalf("oversized reason code=%q", code)
	}
}

func TestComplianceResponsesArePrivateNoStore(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control=%q, want private no-store", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options=%q, want nosniff", got)
	}
}

func TestMalformedMutationResponseStillDisablesCaching(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost,
		"/api/v1/compliance/programs/soc2/attest", strings.NewReader(`{"signedByEmail":`))
	request.Header.Set("Content-Type", "application/json")
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("framework", FrameworkSOC2)
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, routeContext)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	response := httptest.NewRecorder()
	(&Deps{}).AttestProgram(response, request.WithContext(ctx))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control=%q, want private no-store", got)
	}
}

func TestStoredEvidenceMustFitBoundedResponseContract(t *testing.T) {
	program := Program{
		Framework:      FrameworkSOC2,
		Status:         "attested",
		SignedByEmail:  "owner@example.com",
		DocumentSHA256: strings.Repeat("a", 64),
		AttestedAt:     ptrTime(time.Now().Add(-time.Hour)),
		UpdatedAt:      ptrTime(time.Now()),
	}
	if err := validateProgramOutput(program); err != nil {
		t.Fatalf("valid program rejected: %v", err)
	}
	program.Notes = strings.Repeat("n", maxNotesBytes+1)
	if err := validateProgramOutput(program); err == nil {
		t.Fatal("oversized stored programme notes were accepted")
	}

	event := Event{
		ID: 1, Framework: FrameworkSOC2, EventType: "attested",
		DocumentSHA256: strings.Repeat("b", 64), At: time.Now(),
		Metadata: map[string]any{"value": strings.Repeat("m", maxEventMetadataBytes)},
	}
	if err := validateEventOutput(event); err == nil {
		t.Fatal("oversized event metadata was accepted")
	}
}

func TestEventCursorIsCanonicalAndBoundToTenantAndFramework(t *testing.T) {
	tenantID := "00000000-0000-4000-8000-000000000001"
	event := Event{ID: 42, Framework: FrameworkSOC2, At: time.Now().UTC().Truncate(time.Microsecond)}
	cursor, err := encodeEventCursor(tenantID, FrameworkSOC2, event)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/events?cursor="+cursor, nil)
	parsed, err := parseEventCursor(request, tenantID, FrameworkSOC2)
	if err != nil || parsed == nil || parsed.ID != event.ID || !parsed.At.Equal(event.At) {
		t.Fatalf("parse cursor=%#v err=%v", parsed, err)
	}
	if _, err := parseEventCursor(request, "00000000-0000-4000-8000-000000000002", FrameworkSOC2); err == nil {
		t.Fatal("cursor was accepted in a different tenant")
	}
	if _, err := parseEventCursor(request, tenantID, FrameworkGDPR); err == nil {
		t.Fatal("cursor was accepted for a different framework")
	}
	duplicate := httptest.NewRequest(http.MethodGet, "/events?cursor="+cursor+"&cursor="+cursor, nil)
	if _, err := parseEventCursor(duplicate, tenantID, FrameworkSOC2); err == nil {
		t.Fatal("duplicate cursor was accepted")
	}
	unknown := httptest.NewRequest(http.MethodGet, "/events?offset=10", nil)
	if _, err := parseEventCursor(unknown, tenantID, FrameworkSOC2); err == nil {
		t.Fatal("unknown event-ledger query parameter was accepted")
	}
	malformed := httptest.NewRequest(http.MethodGet, "/events?cursor=%zz", nil)
	if _, err := parseEventCursor(malformed, tenantID, FrameworkSOC2); err == nil {
		t.Fatal("malformed event-ledger query encoding was accepted")
	}
}

func ptrTime(value time.Time) *time.Time { return &value }

// normalizeSpaces collapses runs of whitespace to single spaces so SQL
// formatting (multi-line, aligned columns) doesn't break substring
// assertions.
func normalizeSpaces(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
