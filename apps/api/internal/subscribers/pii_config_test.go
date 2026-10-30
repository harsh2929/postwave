package subscribers

// SUB-072 — PII gateway control-plane handler tests. The store is an interface,
// so the GET/PATCH/token-lookup success + error paths are exercised end-to-end
// through httptest with a fake; the no-tenant gate mirrors the package's
// established short-circuit pattern.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

type fakePIIGateway struct {
	cfg        []pii_gateway.FieldSensitivity
	lastUpsert []pii_gateway.UpdateFieldInput
	tokens     map[string]string
	loadErr    error
}

func (f *fakePIIGateway) LoadConfig(_ context.Context, _ string) ([]pii_gateway.FieldSensitivity, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	return f.cfg, nil
}

func (f *fakePIIGateway) UpsertConfig(_ context.Context, _ string, in []pii_gateway.UpdateFieldInput) ([]pii_gateway.FieldSensitivity, error) {
	f.lastUpsert = in
	for _, u := range in {
		sensitive := true
		if u.Sensitive != nil {
			sensitive = *u.Sensitive
		}
		f.cfg = append(f.cfg, pii_gateway.FieldSensitivity{FieldName: u.FieldName, Sensitive: sensitive})
	}
	return f.cfg, nil
}

func (f *fakePIIGateway) LookupToken(_ context.Context, _ string, token string) (string, error) {
	v, ok := f.tokens[token]
	if !ok {
		return "", pii_gateway.ErrNotFound
	}
	return v, nil
}

func tenantReq(method, target, body string) *http.Request {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	return r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
}

func TestGetPIIConfig_NoTenantGate(t *testing.T) {
	d := &Deps{PIIGateway: &fakePIIGateway{}}
	w := httptest.NewRecorder()
	d.GetPIIConfig(w, httptest.NewRequest("GET", "/api/v1/settings/pii-config", nil))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestGetPIIConfig_Unconfigured503(t *testing.T) {
	d := &Deps{}
	w := httptest.NewRecorder()
	d.GetPIIConfig(w, tenantReq("GET", "/api/v1/settings/pii-config", ""))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 when gateway unconfigured", w.Code)
	}
}

func TestGetPIIConfig_ReturnsBuiltInsAndFields(t *testing.T) {
	fake := &fakePIIGateway{cfg: []pii_gateway.FieldSensitivity{{FieldName: "ssn", Sensitive: true}}}
	d := &Deps{PIIGateway: fake}
	w := httptest.NewRecorder()
	d.GetPIIConfig(w, tenantReq("GET", "/api/v1/settings/pii-config", ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["built_in_fields"]; !ok {
		t.Errorf("response missing built_in_fields")
	}
	if _, ok := body["fields"]; !ok {
		t.Errorf("response missing fields")
	}
}

func TestUpdatePIIConfig_EmptyFields422(t *testing.T) {
	d := &Deps{PIIGateway: &fakePIIGateway{}}
	w := httptest.NewRecorder()
	d.UpdatePIIConfig(w, tenantReq("PATCH", "/api/v1/settings/pii-config", `{"fields":[]}`))
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 on empty fields", w.Code)
	}
}

func TestUpdatePIIConfig_Upserts(t *testing.T) {
	fake := &fakePIIGateway{}
	d := &Deps{PIIGateway: fake}
	w := httptest.NewRecorder()
	d.UpdatePIIConfig(w, tenantReq("PATCH", "/api/v1/settings/pii-config",
		`{"fields":[{"field_name":"ssn","sensitive":true}]}`))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if len(fake.lastUpsert) != 1 || fake.lastUpsert[0].FieldName != "ssn" {
		t.Errorf("upsert not forwarded: %+v", fake.lastUpsert)
	}
}

func TestLookupPIIToken_Found(t *testing.T) {
	fake := &fakePIIGateway{tokens: map[string]string{"[[PII:EMAIL:abcd1234]]": "a@b.co"}}
	d := &Deps{PIIGateway: fake}
	w := httptest.NewRecorder()
	d.LookupPIIToken(w, tenantReq("POST", "/internal/pii-gateway/tokens", `{"token":"[[PII:EMAIL:abcd1234]]"}`))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["value"] != "a@b.co" {
		t.Errorf("value = %v, want a@b.co", body["value"])
	}
}

func TestLookupPIIToken_NotFound404(t *testing.T) {
	d := &Deps{PIIGateway: &fakePIIGateway{tokens: map[string]string{}}}
	w := httptest.NewRecorder()
	d.LookupPIIToken(w, tenantReq("POST", "/internal/pii-gateway/tokens", `{"token":"missing"}`))
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for unknown token", w.Code)
	}
}

func TestLookupPIIToken_MissingToken422(t *testing.T) {
	d := &Deps{PIIGateway: &fakePIIGateway{}}
	w := httptest.NewRecorder()
	d.LookupPIIToken(w, tenantReq("POST", "/internal/pii-gateway/tokens", `{}`))
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing token", w.Code)
	}
}
