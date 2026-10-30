package pii_gateway

import (
	"context"
	"strings"
	"testing"
)

func TestValueSanitizer_RedactsAndRestores(t *testing.T) {
	san := NewSanitizerFromKindValues("req-1", []KindValue{
		{Kind: "EMAIL", Value: "alice@example.com"},
		{Kind: "PHONE", Value: "+15551234567"},
	})
	prompt := "Email alice@example.com or call +15551234567 today."
	red := san.Sanitize(prompt)
	if strings.Contains(red, "alice@example.com") {
		t.Errorf("sanitized prompt still leaks email: %q", red)
	}
	if strings.Contains(red, "+15551234567") {
		t.Errorf("sanitized prompt still leaks phone: %q", red)
	}
	// The model "responds" echoing the placeholders; Restore must bring back PII.
	restored := san.Restore(red)
	if !strings.Contains(restored, "alice@example.com") || !strings.Contains(restored, "+15551234567") {
		t.Errorf("restore failed: %q", restored)
	}
}

func TestValueSanitizer_NoSensitiveValuesPassthrough(t *testing.T) {
	san := NewSanitizerFromKindValues("s", nil)
	in := "nothing sensitive here"
	if got := san.Sanitize(in); got != in {
		t.Errorf("empty value set must pass through, got %q", got)
	}
}

func TestValueSanitizer_SubstringSafeOrdering(t *testing.T) {
	// A value that is a substring of another must not corrupt the longer one.
	san := NewSanitizerFromKindValues("s", []KindValue{
		{Kind: "SHORT", Value: "ann@x.co"},
		{Kind: "LONG", Value: "ann@x.com"},
	})
	prompt := "ann@x.com and ann@x.co"
	red := san.Sanitize(prompt)
	if strings.Contains(red, "ann@x.com") || strings.Contains(red, "ann@x.co") {
		t.Errorf("both values must be redacted; got %q", red)
	}
	restored := san.Restore(red)
	if !strings.Contains(restored, "ann@x.com") || !strings.Contains(restored, "ann@x.co") {
		t.Errorf("both values must restore; got %q", restored)
	}
}

func TestNewSensitiveFieldSet_BuiltInsAlwaysOn(t *testing.T) {
	set := NewSensitiveFieldSet(nil)
	for _, f := range BuiltInSensitiveFields {
		if !set.IsSensitive(f) {
			t.Errorf("built-in field %q must always be sensitive", f)
		}
	}
	// Attempting to unlock a built-in via config must be ignored.
	set = NewSensitiveFieldSet([]FieldSensitivity{{FieldName: "email", Sensitive: false}})
	if !set.IsSensitive("email") {
		t.Errorf("email must remain sensitive even when config says false")
	}
}

func TestNewSensitiveFieldSet_CustomFieldToggle(t *testing.T) {
	set := NewSensitiveFieldSet([]FieldSensitivity{
		{FieldName: "ssn", Sensitive: true},
		{FieldName: "favorite_color", Sensitive: false},
	})
	if !set.IsSensitive("SSN") { // case-insensitive
		t.Errorf("ssn marked sensitive must be sensitive")
	}
	if set.IsSensitive("favorite_color") {
		t.Errorf("favorite_color marked not-sensitive must not be sensitive")
	}
	if set.IsSensitive("unconfigured") {
		t.Errorf("unconfigured custom field must default not-sensitive")
	}
}

func TestBuildSensitiveValues(t *testing.T) {
	set := NewSensitiveFieldSet([]FieldSensitivity{
		{FieldName: "ssn", Sensitive: true},
		{FieldName: "notes", Sensitive: false},
	})
	vals := BuildSensitiveValues(set, "a@b.co", "+15550000000",
		map[string]any{"ssn": "123-45-6789", "notes": "harmless", "age": 30},
		nil)
	got := map[string]bool{}
	for _, v := range vals {
		got[v.Value] = true
	}
	if !got["a@b.co"] || !got["+15550000000"] || !got["123-45-6789"] {
		t.Errorf("expected email+phone+ssn in value set, got %v", vals)
	}
	if got["harmless"] {
		t.Errorf("non-sensitive notes must be excluded, got %v", vals)
	}
	if got["30"] { // non-string field value skipped
		t.Errorf("non-string field value must be skipped, got %v", vals)
	}
}

func TestWrapVoiceClient_RoundTripThroughInner(t *testing.T) {
	san := NewSanitizerFromKindValues("s", []KindValue{{Kind: "EMAIL", Value: "z@q.io"}})
	var seenByModel string
	inner := func(_ context.Context, prompt string) (string, error) {
		seenByModel = prompt
		// Model echoes the (tokenized) prompt back.
		return "Reply: " + prompt, nil
	}
	wrapped := WrapVoiceClient(san, inner)
	out, err := wrapped(context.Background(), "contact z@q.io")
	if err != nil {
		t.Fatalf("wrapped Generate: %v", err)
	}
	if strings.Contains(seenByModel, "z@q.io") {
		t.Errorf("model must NOT see cleartext PII, saw %q", seenByModel)
	}
	if !strings.Contains(out, "z@q.io") {
		t.Errorf("final response must be detokenized, got %q", out)
	}
}

func TestWrapVoiceClient_NilSanitizerPassthrough(t *testing.T) {
	called := false
	inner := func(_ context.Context, prompt string) (string, error) {
		called = true
		if prompt != "raw" {
			t.Errorf("nil sanitizer must pass prompt unchanged, got %q", prompt)
		}
		return "ok", nil
	}
	wrapped := WrapVoiceClient(nil, inner)
	if _, err := wrapped(context.Background(), "raw"); err != nil {
		t.Fatalf("err: %v", err)
	}
	if !called {
		t.Errorf("inner must be invoked")
	}
}
