// SPDX-License-Identifier: AGPL-3.0-only
package segments

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// withTenantCtx attaches a stub tenant to req so the handler bypasses
// the up-front no_tenant guard and exercises the body-decode / AST
// validation path we care about in unit tests. The handlers never call
// the DB in these paths since they bail before reaching Repo.
func withTenantCtx(req *http.Request) *http.Request {
	t := &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"}
	return req.WithContext(middleware.WithTenant(req.Context(), t))
}

func TestPreviewCountRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"text":"` + strings.Repeat("x", int(segmentJSONMaxBodyBytes)) + `"}`
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/preview-count", strings.NewReader(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PreviewCount(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPreviewCountRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/preview-count",
		strings.NewReader(`{"queryAst":{"op":"condition","field":"status","comparator":"equals","value":"enabled"}}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PreviewCount(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPreviewCountRequiresInput(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/preview-count",
		strings.NewReader(`{}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PreviewCount(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_input") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPreviewCountUnsupportedText(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/preview-count",
		strings.NewReader(`{"text":"this text matches nothing in the deterministic compiler"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PreviewCount(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unsupported_text") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPreviewCountBadAST(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/preview-count",
		strings.NewReader(`{"queryAst":{"op":"nonsense"}}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PreviewCount(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_ast") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestRecomputeRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/abc/recompute", nil)
	rec := httptest.NewRecorder()

	deps.Recompute(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// --- SUB-051: target_channel auto-exclude on preview-count ------------

// TestApplyChannelConsent_EmptyIsNoOp: with no target_channel the
// compiled fragment is returned byte-identical (historic behaviour).
func TestApplyChannelConsent_EmptyIsNoOp(t *testing.T) {
	const frag = "subscribers.status = $1"
	got, err := applyChannelConsent(frag, "")
	if err != nil {
		t.Fatalf("applyChannelConsent: %v", err)
	}
	if got != frag {
		t.Fatalf("empty channel mutated fragment: %q", got)
	}
}

// TestApplyChannelConsent_EmailGate: an email target_channel ANDs the
// email consent-vector gate onto the compiled fragment without disturbing
// the original placeholders (the gate is arg-free).
func TestApplyChannelConsent_EmailGate(t *testing.T) {
	const frag = "subscribers.status = $1"
	got, err := applyChannelConsent(frag, "email")
	if err != nil {
		t.Fatalf("applyChannelConsent: %v", err)
	}
	if !strings.Contains(got, "subscribers.status = $1") {
		t.Fatalf("base predicate lost: %q", got)
	}
	if !strings.Contains(got, "consent_email_marketing_at IS NOT NULL") {
		t.Fatalf("email consent gate not applied: %q", got)
	}
	for _, required := range []string{
		"FROM subscriber_emails AS channel_email",
		"channel_email.subscriber_id = subscribers.id",
		"lower(channel_email.email::text) = lower(subscribers.email::text)",
		"channel_email.consent_status = 'subscribed'",
		"channel_email.suppressed = false",
	} {
		if !strings.Contains(got, required) {
			t.Fatalf("exact-address consent gate missing %q: %q", required, got)
		}
	}
	// No new placeholder should have been introduced.
	if strings.Contains(got, "$2") {
		t.Fatalf("gate introduced a placeholder, must be arg-free: %q", got)
	}
}

// TestApplyChannelConsent_UnknownChannelErrors: a typo'd channel surfaces
// as an error so the handler can 4xx rather than silently dropping the
// gate.
func TestApplyChannelConsent_UnknownChannelErrors(t *testing.T) {
	if _, err := applyChannelConsent("TRUE", "carrier_pigeon"); err == nil {
		t.Fatalf("expected error for unsupported channel")
	}
}

// TestPreviewCountBadTargetChannel drives the handler with a valid AST but
// an unsupported target_channel and asserts the structured 400.
func TestPreviewCountBadTargetChannel(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/preview-count",
		strings.NewReader(`{"queryAst":{"op":"condition","field":"status","comparator":"equals","value":"enabled"},"target_channel":"carrier_pigeon"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PreviewCount(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_target_channel") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
