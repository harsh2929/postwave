// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestTransformValue(t *testing.T) {
	cases := []struct {
		transform string
		in        any
		want      any
		ok        bool
	}{
		{"copy", "Hello", "Hello", true},
		{"lowercase", "HELLO", "hello", true},
		{"uppercase", "hello", "HELLO", true},
		{"trim", "  x  ", "x", true},
		{"number", "42.5", 42.5, true},
		{"number", float64(7), float64(7), true},
		{"number", "not-a-number", nil, false},
		{"boolean", "yes", true, true},
		{"boolean", "0", false, true},
		{"boolean", float64(3), true, true},
		{"boolean", "maybe", nil, false},
		{"unknown", "x", nil, false},
	}
	for _, c := range cases {
		got, ok := transformValue(c.transform, c.in)
		if ok != c.ok {
			t.Errorf("transformValue(%q,%v) ok=%v want %v", c.transform, c.in, ok, c.ok)
			continue
		}
		if ok && got != c.want {
			t.Errorf("transformValue(%q,%v) = %v want %v", c.transform, c.in, got, c.want)
		}
	}
}

func TestTransformDate(t *testing.T) {
	got, ok := transformValue("date", "2026-06-22")
	if !ok {
		t.Fatalf("date transform failed on YYYY-MM-DD")
	}
	if got != "2026-06-22T00:00:00Z" {
		t.Fatalf("date normalized to %v, want RFC3339", got)
	}
	if _, ok := transformValue("date", "garbage"); ok {
		t.Fatalf("garbage date should be skipped")
	}
}

func TestLookupSource_JSONPathNested(t *testing.T) {
	custom := map[string]any{
		"address": map[string]any{"city": "Berlin"},
	}
	v, ok := lookupSource("address.city", "json_path", nil, custom)
	if !ok || v != "Berlin" {
		t.Fatalf("nested json_path lookup = %v, %v", v, ok)
	}
	if _, ok := lookupSource("address.zip", "json_path", nil, custom); ok {
		t.Fatalf("missing nested key should not be found")
	}
}

func TestApplyPropertyTransforms_DerivesTargetIntoNilCustom_OnCreate(t *testing.T) {
	rules := []PropertyTransformRule{
		{Name: "norm_country", SourcePath: "country", TargetKey: "country_norm", Transform: "uppercase"},
	}
	merge := map[string]any{"country": "de"}
	var custom map[string]any // nil — allocated on Create (allocateIfNil=true)
	applyPropertyTransforms(rules, merge, &custom, true)
	if custom == nil {
		t.Fatalf("Create: expected custom map to be allocated when a rule fires")
	}
	if custom["country_norm"] != "DE" {
		t.Fatalf("derived target = %v, want DE", custom["country_norm"])
	}
}

// TestApplyPropertyTransforms_UpdateNeverFabricatesReplacement is the
// regression for the data-loss bug: on Update (allocateIfNil=false) a rule
// firing from merge_fields must NOT allocate a nil custom_fields, because
// Repo.Update treats a non-nil custom_fields as a full replacement and would
// wipe the subscriber's existing custom fields.
func TestApplyPropertyTransforms_UpdateNeverFabricatesReplacement(t *testing.T) {
	rules := []PropertyTransformRule{
		{Name: "norm_country", SourcePath: "country", TargetKey: "country_norm", Transform: "uppercase"},
	}
	merge := map[string]any{"country": "de"}
	var custom map[string]any // nil = "don't touch custom_fields" on PATCH
	applyPropertyTransforms(rules, merge, &custom, false)
	if custom != nil {
		t.Fatalf("Update: nil custom_fields must stay nil (don't-touch), got %v", custom)
	}
}

// When the PATCH already carries custom_fields, derived keys are still added.
func TestApplyPropertyTransforms_UpdateAddsToProvidedCustom(t *testing.T) {
	rules := []PropertyTransformRule{
		{Name: "norm_country", SourcePath: "country", TargetKey: "country_norm", Transform: "uppercase"},
	}
	custom := map[string]any{"existing": "keep"}
	applyPropertyTransforms(rules, map[string]any{"country": "de"}, &custom, false)
	if custom["country_norm"] != "DE" || custom["existing"] != "keep" {
		t.Fatalf("Update with provided custom_fields should add derived key + keep sent keys: %v", custom)
	}
}

func TestApplyPropertyTransforms_NoSourceLeavesCustomNil(t *testing.T) {
	rules := []PropertyTransformRule{
		{Name: "r", SourcePath: "missing", TargetKey: "x", Transform: "copy"},
	}
	var custom map[string]any
	applyPropertyTransforms(rules, map[string]any{"other": "v"}, &custom, true)
	if custom != nil {
		t.Fatalf("no matching source should leave custom nil, got %v", custom)
	}
}

func TestUpsertTransformRuleRejectsServerManagedID(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/profile-transform-rules", strings.NewReader(`{
		"id":"c4e24be6-a90d-41d7-8685-0dfd0eae6151",
		"name":"normalize_country",
		"source_path":"country",
		"target_key":"country_code"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	d.UpsertTransformRule(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "unknown_field") {
		t.Fatalf("status=%d body=%q, want strict unknown-field rejection", rec.Code, rec.Body.String())
	}
}

func TestUpsertTransformRulePreservesTypedBodyErrors(t *testing.T) {
	d := &Deps{}
	tenant := &middleware.Tenant{ID: "tenant-1"}

	oversized := httptest.NewRequest(http.MethodPost, "/api/v1/profile-transform-rules",
		strings.NewReader(`{"name":"`+strings.Repeat("x", int(subscriberJSONMaxBodyBytes)+1)+`"}`))
	oversized.Header.Set("Content-Type", "application/json")
	oversized = oversized.WithContext(middleware.WithTenant(oversized.Context(), tenant))
	oversizedRec := httptest.NewRecorder()
	d.UpsertTransformRule(oversizedRec, oversized)
	if oversizedRec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status=%d body=%q, want 413", oversizedRec.Code, oversizedRec.Body.String())
	}

	unsupported := httptest.NewRequest(http.MethodPost, "/api/v1/profile-transform-rules",
		strings.NewReader(`{"name":"rule"}`))
	unsupported.Header.Set("Content-Type", "text/plain")
	unsupported = unsupported.WithContext(middleware.WithTenant(unsupported.Context(), tenant))
	unsupportedRec := httptest.NewRecorder()
	d.UpsertTransformRule(unsupportedRec, unsupported)
	if unsupportedRec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("unsupported-media status=%d body=%q, want 415", unsupportedRec.Code, unsupportedRec.Body.String())
	}
}

func TestDeleteTransformRuleRejectsMalformedUUIDBeforeRepository(t *testing.T) {
	d := &Deps{}
	router := chi.NewRouter()
	router.Delete("/api/v1/profile-transform-rules/{id}", d.DeleteTransformRule)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/profile-transform-rules/not-a-uuid", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_id") {
		t.Fatalf("status=%d body=%q, want invalid_id", rec.Code, rec.Body.String())
	}
}
