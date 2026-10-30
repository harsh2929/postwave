package segments

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCompileASTConsentAIProcessingTrue(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"consent.ai_processing","comparator":"equals","value":true}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "consent_ai_processing_at IS NOT NULL") {
		t.Fatalf("fragment did not project ai_processing column: %s", frag)
	}
	if len(args) != 1 || args[0] != true {
		t.Fatalf("args = %#v", args)
	}
}

func TestCompileASTConsentEmailMarketingFalse(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"consent.email_marketing","comparator":"equals","value":false}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "consent_email_marketing_at IS NOT NULL") {
		t.Fatalf("fragment did not project email_marketing column: %s", frag)
	}
	if len(args) != 1 || args[0] != false {
		t.Fatalf("args = %#v", args)
	}
}

func TestCompileASTConsentTargetedAdsBoolean(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"consent.targeted_ads","comparator":"equals","value":true}`)
	frag, _, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "consent_targeted_ads_at IS NOT NULL") {
		t.Fatalf("fragment did not project targeted_ads column: %s", frag)
	}
}

func TestCompileASTConsentProfilingNotEquals(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"consent.profiling","comparator":"not_equals","value":true}`)
	frag, _, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "consent_profiling_at IS NOT NULL") || !strings.Contains(frag, "<>") {
		t.Fatalf("fragment did not produce not_equals on profiling: %s", frag)
	}
}

func TestCompileASTConsentAIProcessingTimestampGT(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"consent.ai_processing_at","comparator":"gt","value":"2026-01-01T00:00:00Z"}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "consent_ai_processing_at") || !strings.Contains(frag, ">") {
		t.Fatalf("fragment did not produce gt on ai_processing_at: %s", frag)
	}
	if len(args) != 1 {
		t.Fatalf("args = %#v", args)
	}
}

func TestSchemaIncludesConsentVectorFields(t *testing.T) {
	fields := BaseFieldSchemas()
	want := map[string]bool{
		"consent.email_marketing": false,
		"consent.sms_marketing":   false,
		"consent.profiling":       false,
		"consent.targeted_ads":    false,
		"consent.ai_processing":   false,
	}
	for _, f := range fields {
		if _, ok := want[f.Key]; ok {
			if f.Type != "boolean" {
				t.Errorf("%s: want type=boolean, got %q", f.Key, f.Type)
			}
			want[f.Key] = true
		}
	}
	for k, ok := range want {
		if !ok {
			t.Errorf("schema missing %s", k)
		}
	}
}
