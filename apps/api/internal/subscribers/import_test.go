package subscribers

import (
	"reflect"
	"testing"
)

func TestDetectMergeField(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"FNAME", "FNAME"},
		{"  first_name  ", "FNAME"},
		{"firstName", "FNAME"},
		{"lname", "LNAME"},
		{"phone", "PHONE"},
		{"address", "ADDRESS"},
		{"company", "COMPANY"},
		{"birthday", "BIRTHDAY"},
		{"email", ""},  // never a merge field
		{"random", ""}, // unknown header
		{"", ""},       // empty
	}
	for _, c := range cases {
		if got := DetectMergeField(c.header); got != c.want {
			t.Errorf("DetectMergeField(%q) = %q, want %q", c.header, got, c.want)
		}
	}
}

func TestValidateMergeFieldType(t *testing.T) {
	if msg := ValidateMergeFieldType("PHONE", "555-1234"); msg != "" {
		t.Errorf("valid phone rejected: %s", msg)
	}
	if msg := ValidateMergeFieldType("PHONE", "abc"); msg == "" {
		t.Errorf("invalid phone should be rejected")
	}
	if msg := ValidateMergeFieldType("BIRTHDAY", "1990-01-15"); msg != "" {
		t.Errorf("valid birthday rejected: %s", msg)
	}
	if msg := ValidateMergeFieldType("BIRTHDAY", "12"); msg == "" {
		t.Errorf("short birthday should be rejected")
	}
	// Unknown keys pass through (delegated to the merge_fields validator).
	if msg := ValidateMergeFieldType("CUSTOM_FIELD", "anything"); msg != "" {
		t.Errorf("unknown merge key should pass: got %s", msg)
	}
}

func TestPartitionColumns(t *testing.T) {
	headers := []string{"email", "FNAME", "PHONE", "favorite_color"}
	cols, mergeMap := PartitionColumns(headers, true)
	if cols["email"] != 0 || cols["fname"] != 1 || cols["favorite_color"] != 3 {
		t.Errorf("columns lookup off: %+v", cols)
	}
	if mergeMap["fname"] != "FNAME" || mergeMap["phone"] != "PHONE" {
		t.Errorf("merge map wrong: %+v", mergeMap)
	}
	if _, isMerge := mergeMap["favorite_color"]; isMerge {
		t.Errorf("favorite_color should NOT be a merge field")
	}
	// Auto-detect off → mergeMap is empty.
	_, mergeMapOff := PartitionColumns(headers, false)
	if len(mergeMapOff) != 0 {
		t.Errorf("autoDetect=false should yield empty mergeMap, got %+v", mergeMapOff)
	}
}

func TestBuildCreateInputWithMergeFields(t *testing.T) {
	headers := []string{"email", "FNAME", "PHONE", "favorite_color"}
	cols, mergeMap := PartitionColumns(headers, true)
	record := []string{"alice@example.com", "Alice", "555-1234", "blue"}
	in, errs := BuildCreateInputWithMergeFields(record, cols, mergeMap)
	if len(errs) != 0 {
		t.Fatalf("unexpected errs: %+v", errs)
	}
	if in.Email != "alice@example.com" {
		t.Errorf("email not set: %q", in.Email)
	}
	if !reflect.DeepEqual(in.MergeFields, map[string]any{"FNAME": "Alice", "PHONE": "555-1234"}) {
		t.Errorf("merge_fields routing wrong: %+v", in.MergeFields)
	}
	if !reflect.DeepEqual(in.CustomFields, map[string]any{"favorite_color": "blue"}) {
		t.Errorf("custom_fields routing wrong: %+v", in.CustomFields)
	}
}

func TestBuildCreateInputWithMergeFieldsBadPhone(t *testing.T) {
	headers := []string{"email", "PHONE"}
	cols, mergeMap := PartitionColumns(headers, true)
	in, errs := BuildCreateInputWithMergeFields([]string{"x@y.com", "n/a"}, cols, mergeMap)
	if len(errs) == 0 {
		t.Fatalf("expected error for bad phone")
	}
	if _, ok := in.MergeFields["PHONE"]; ok {
		t.Errorf("invalid phone should not land in merge_fields")
	}
}

func TestMergeIntoOptions(t *testing.T) {
	q := map[string]string{
		"update_existing":       "true",
		"tag":                   "newsletter-2026",
		"create_missing_fields": "1",
		"merge_field_detect":    "false",
		"consent_source":        "form",
		"consent_form_id":       "abc-123",
	}
	get := func(k string) string { return q[k] }
	opts := MergeIntoOptions(get)
	if !opts.UpdateExisting {
		t.Errorf("update_existing should be true")
	}
	if opts.Tag != "newsletter-2026" {
		t.Errorf("tag wrong: %q", opts.Tag)
	}
	if !opts.CreateMissingFields {
		t.Errorf("create_missing_fields should be true")
	}
	if opts.AutoDetectMergeField {
		t.Errorf("merge_field_detect=false should disable autodetect")
	}
	if opts.ConsentSource != "form" || opts.ConsentFormID != "abc-123" {
		t.Errorf("consent fields wrong: %+v", opts)
	}
}

func TestEmailLooksValid(t *testing.T) {
	if !EmailLooksValid("a@b.com") {
		t.Errorf("a@b.com should be valid")
	}
	if EmailLooksValid("not an email") {
		t.Errorf("'not an email' should be invalid")
	}
	if EmailLooksValid("") {
		t.Errorf("empty should be invalid")
	}
}

func TestDefaultLabelForKeyHumanises(t *testing.T) {
	cases := map[string]string{
		"first_name":     "First Name",
		"favorite-color": "Favorite Color",
		"nps":            "Nps",
	}
	for in, want := range cases {
		if got := defaultLabelForKey(in); got != want {
			t.Errorf("defaultLabelForKey(%q) = %q, want %q", in, got, want)
		}
	}
}
