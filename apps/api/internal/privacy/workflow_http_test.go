package privacy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// These tests exercise the early-return branches of the new workflow
// handlers: missing tenant context, missing required body fields, and
// invalid URL params. They run without a live database — they cover
// the contract that bad input never reaches the DB layer.

func TestIssueVerificationRejectsMissingTenant(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests/prv_data-export_x/verify", nil)
	w := httptest.NewRecorder()
	d.IssueVerification(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "no_tenant") {
		t.Fatalf("expected no_tenant error code, got %s", w.Body.String())
	}
}

func TestConfirmVerificationRejectsEmptyToken(t *testing.T) {
	d := &Deps{}
	body := bytes.NewBufferString(`{"token":""}`)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests/prv_data-export_x/verify/confirm", body)
	r.Header.Set("Content-Type", "application/json")
	// chi URL params are populated by the router; in unit tests we
	// have to attach them manually via RouteContext.
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("request_id", "prv_data-export_x")
	r = r.WithContext(addRouteCtx(r, rctx))
	r = r.WithContext(addTenantCtx(r))
	w := httptest.NewRecorder()
	d.ConfirmVerification(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 missing token, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing_token") {
		t.Fatalf("expected missing_token, got %s", w.Body.String())
	}
}

func TestDenyRequestRejectsMissingReason(t *testing.T) {
	d := &Deps{}
	body := bytes.NewBufferString(`{}`)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests/prv_data-export_x/deny", body)
	r.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("request_id", "prv_data-export_x")
	r = r.WithContext(addRouteCtx(r, rctx))
	r = r.WithContext(addTenantCtx(r))
	w := httptest.NewRecorder()
	d.DenyRequest(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing_reason") {
		t.Fatalf("expected missing_reason, got %s", w.Body.String())
	}
}

func TestCreateGenericRequestRejectsUnknownRequestType(t *testing.T) {
	d := &Deps{}
	payload := map[string]any{
		"request_type": "data_export", // dedicated handler exists; not allowed here
		"region":       "GDPR",
	}
	raw, _ := json.Marshal(payload)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests", bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(addTenantCtx(r))
	w := httptest.NewRecorder()
	d.CreateGenericRequest(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid_request_type") {
		t.Fatalf("expected invalid_request_type, got %s", w.Body.String())
	}
}

func TestRecordSubprocessorAckRejectsBadSlug(t *testing.T) {
	d := &Deps{}
	body := bytes.NewBufferString(`{"status":"acknowledged"}`)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests/prv_data-export_x/subprocessors/EVIL.DOT/ack", body)
	r.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("request_id", "prv_data-export_x")
	rctx.URLParams.Add("subprocessor", "EVIL.DOT")
	r = r.WithContext(addRouteCtx(r, rctx))
	r = r.WithContext(addTenantCtx(r))
	w := httptest.NewRecorder()
	d.RecordSubprocessorAck(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid_subprocessor") {
		t.Fatalf("expected invalid_subprocessor, got %s", w.Body.String())
	}
}

func TestSetLegalHoldRejectsMissingReason(t *testing.T) {
	d := &Deps{}
	body := bytes.NewBufferString(`{"reason":"   "}`)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests/prv_data-export_x/hold", body)
	r.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("request_id", "prv_data-export_x")
	r = r.WithContext(addRouteCtx(r, rctx))
	r = r.WithContext(addTenantCtx(r))
	w := httptest.NewRecorder()
	d.SetLegalHold(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing_reason") {
		t.Fatalf("expected missing_reason, got %s", w.Body.String())
	}
}

func TestCreateAppealRejectsMissingReason(t *testing.T) {
	d := &Deps{}
	body := bytes.NewBufferString(`{}`)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/requests/prv_data-export_x/appeal", body)
	r.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("request_id", "prv_data-export_x")
	r = r.WithContext(addRouteCtx(r, rctx))
	r = r.WithContext(addTenantCtx(r))
	w := httptest.NewRecorder()
	d.CreateAppeal(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing_reason") {
		t.Fatalf("expected missing_reason, got %s", w.Body.String())
	}
}
