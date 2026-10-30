package customfields

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestValidateKey(t *testing.T) {
	cases := []struct {
		in    string
		valid bool
	}{
		{"", false},
		{"loyalty_tier", true},
		{"a", true},
		{"abc_123", true},
		{"1abc", false},         // must start with a letter
		{"ABC", false},          // uppercase rejected
		{"with-dash", false},    // dash rejected
		{"with space", false},   // space rejected
		{"loyalty.tier", false}, // dot rejected
		{strings.Repeat("a", MaxKeyLength), true},
		{strings.Repeat("a", MaxKeyLength+1), false},
	}
	for _, tc := range cases {
		err := validateKey(tc.in)
		got := err == nil
		if got != tc.valid {
			t.Errorf("validateKey(%q) ok=%v, want %v (err=%v)", tc.in, got, tc.valid, err)
		}
	}
}

func TestIsValidType(t *testing.T) {
	for _, t1 := range []string{"string", "number", "boolean", "date"} {
		if !isValidType(t1) {
			t.Errorf("type %q should be valid", t1)
		}
	}
	for _, t1 := range []string{"", "STRING", "int", "datetime"} {
		if isValidType(t1) {
			t.Errorf("type %q should be invalid", t1)
		}
	}
}

// TestIsValidTypeExtended covers the richer custom-attribute types added by
// SUB-006: enum/array/object/email/url/phone/region are now valid, while
// clearly-bogus type names still reject.
func TestIsValidTypeExtended(t *testing.T) {
	for _, t1 := range []string{"enum", "array", "object", "email", "url", "phone", "region"} {
		if !isValidType(t1) {
			t.Errorf("extended type %q should be valid", t1)
		}
	}
	for _, t1 := range []string{"ENUM", "list", "map", "e-mail", "uri", "tel"} {
		if isValidType(t1) {
			t.Errorf("type %q should be invalid", t1)
		}
	}
}

// TestValidateConfig checks the type-aware config validation that the Create
// handler runs before persisting: enum needs options, array item_type and
// object schema types must be scalar, and a bad regex pattern is rejected.
func TestValidateConfig(t *testing.T) {
	if err := validateConfig(TypeEnum, &FieldConfig{Options: []string{"a", "b"}}); err != nil {
		t.Errorf("valid enum config rejected: %v", err)
	}
	if err := validateConfig(TypeEnum, &FieldConfig{}); err == nil {
		t.Error("enum without options should be rejected")
	}
	if err := validateConfig(TypeArray, &FieldConfig{ItemType: "number"}); err != nil {
		t.Errorf("valid array config rejected: %v", err)
	}
	if err := validateConfig(TypeArray, &FieldConfig{ItemType: "object"}); err == nil {
		t.Error("array of object should be rejected (item_type must be scalar)")
	}
	if err := validateConfig(TypeObject, &FieldConfig{Schema: map[string]string{"age": "number"}}); err != nil {
		t.Errorf("valid object schema rejected: %v", err)
	}
	if err := validateConfig(TypeObject, &FieldConfig{Schema: map[string]string{"x": "array"}}); err == nil {
		t.Error("object schema with non-scalar type should be rejected")
	}
	if err := validateConfig(TypeString, &FieldConfig{Pattern: "([bad"}); err == nil {
		t.Error("invalid regex pattern should be rejected")
	}
	if err := validateConfig(TypeString, nil); err != nil {
		t.Errorf("nil config should pass: %v", err)
	}
}

// TestValidateConfigDataClassification covers the SUB-057 data-classification
// taxonomy: valid labels pass on any field type, an unknown label is rejected,
// and a mixed-case label is canonicalised to lowercase in place.
func TestValidateConfigDataClassification(t *testing.T) {
	for _, dc := range []string{"pii", "phi", "pci", "sensitive", "business", "none", ""} {
		if err := validateConfig(TypeString, &FieldConfig{DataClassification: dc}); err != nil {
			t.Errorf("data_classification %q should be valid: %v", dc, err)
		}
	}
	for _, dc := range []string{"PHI-ish", "secret", "gdpr", "personal"} {
		if err := validateConfig(TypeString, &FieldConfig{DataClassification: dc}); err == nil {
			t.Errorf("data_classification %q should be rejected", dc)
		}
	}
	// Mixed case is canonicalised to lowercase in place so the stored jsonb
	// matches the migration 0549 CHECK constraint.
	c := &FieldConfig{DataClassification: "PII"}
	if err := validateConfig(TypeString, c); err != nil {
		t.Fatalf("PII should be valid after lowercasing: %v", err)
	}
	if c.DataClassification != "pii" {
		t.Errorf("data_classification not canonicalised: got %q, want %q", c.DataClassification, "pii")
	}
	// Classification is type-independent: works on an enum field too.
	if err := validateConfig(TypeEnum, &FieldConfig{Options: []string{"a"}, DataClassification: "sensitive"}); err != nil {
		t.Errorf("classification on enum should be valid: %v", err)
	}
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	deps := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"key":"company","label":"` + strings.Repeat("x", int(customFieldJSONMaxBodyBytes)) + `","type":"string"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/custom-fields", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.Create(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
