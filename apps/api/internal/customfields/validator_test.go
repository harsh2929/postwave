package customfields

import (
	"errors"
	"testing"
	"time"
)

func TestParseMode(t *testing.T) {
	cases := []struct {
		in   string
		want Mode
	}{
		{"", DefaultMode},
		{"strict", ModeStrict},
		{"STRICT", ModeStrict},
		{" auto ", ModeAuto},
		{"off", ModeOff},
		{"garbage", DefaultMode},
	}
	for _, tc := range cases {
		if got := ParseMode(tc.in); got != tc.want {
			t.Errorf("ParseMode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestIsValidDataClassification covers the SUB-057 closed taxonomy: the six
// labels (+ empty) are valid; anything else and any uppercased variant that is
// not first canonicalised is rejected. The function lowercases internally, so
// "PII" is accepted here.
func TestIsValidDataClassification(t *testing.T) {
	for _, dc := range []string{"", "pii", "phi", "pci", "sensitive", "business", "none", " PII ", "Sensitive"} {
		if !isValidDataClassification(dc) {
			t.Errorf("data_classification %q should be valid", dc)
		}
	}
	for _, dc := range []string{"secret", "gdpr", "personal", "pii2", "p i i"} {
		if isValidDataClassification(dc) {
			t.Errorf("data_classification %q should be invalid", dc)
		}
	}
}

func TestDefaultLabelForKey(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"loyalty_tier", "Loyalty Tier"},
		{"signup_source", "Signup Source"},
		{"a", "A"},
		{"abc", "Abc"},
		{"foo__bar", "Foo  Bar"}, // collapsing multiple underscores is not the validator's job
	}
	for _, tc := range cases {
		if got := defaultLabelForKey(tc.in); got != tc.want {
			t.Errorf("defaultLabelForKey(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestInferType(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	cases := []struct {
		raw  any
		want FieldType
	}{
		{true, TypeBoolean},
		{false, TypeBoolean},
		{42, TypeNumber},
		{int64(42), TypeNumber},
		{1.5, TypeNumber},
		{"hello", TypeString},
		{"42", TypeString}, // strings stay strings even if numeric
		{now, TypeDate},    // RFC3339 promotes to date
		{nil, TypeString},
	}
	for _, tc := range cases {
		got, err := inferType("k", tc.raw)
		if err != nil {
			t.Errorf("inferType(%v) err: %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("inferType(%v) = %q, want %q", tc.raw, got, tc.want)
		}
	}
	if _, err := inferType("k", []string{"x"}); err == nil {
		t.Error("inferType([]string) should error — slices aren't supported")
	}
}

func TestCoerceString(t *testing.T) {
	cases := []struct {
		raw  any
		want string
	}{
		{"hi", "hi"},
		{[]byte("hi"), "hi"},
		{true, "true"},
		{false, "false"},
		{42, "42"},
		{int64(42), "42"},
		{1.5, "1.5"},
	}
	for _, tc := range cases {
		got, err := coerce("k", TypeString, tc.raw)
		if err != nil {
			t.Errorf("coerce(string, %v) err: %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("coerce(string, %v) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestCoerceNumber(t *testing.T) {
	got, err := coerce("k", TypeNumber, "42.5")
	if err != nil {
		t.Fatalf("coerce(number, \"42.5\") err: %v", err)
	}
	if got != 42.5 {
		t.Errorf("got %v, want 42.5", got)
	}
	if _, err := coerce("k", TypeNumber, "not a number"); err == nil {
		t.Error("expected ErrTypeMismatch for non-numeric string")
	} else {
		var tm *ErrTypeMismatch
		if !errors.As(err, &tm) {
			t.Errorf("expected *ErrTypeMismatch, got %T", err)
		}
	}
	if got, _ := coerce("k", TypeNumber, ""); got != nil {
		t.Errorf("empty string should coerce to nil, got %v", got)
	}
}

func TestCoerceBoolean(t *testing.T) {
	for _, in := range []string{"true", "TRUE", "1", "yes", "y", "t"} {
		got, err := coerce("k", TypeBoolean, in)
		if err != nil || got != true {
			t.Errorf("coerce(bool, %q) = %v, err=%v; want true", in, got, err)
		}
	}
	for _, in := range []string{"false", "0", "no", "f", ""} {
		got, err := coerce("k", TypeBoolean, in)
		if err != nil || got != false {
			t.Errorf("coerce(bool, %q) = %v, err=%v; want false", in, got, err)
		}
	}
	if _, err := coerce("k", TypeBoolean, "maybe"); err == nil {
		t.Error("'maybe' should not coerce to bool")
	}
}

func TestCoerceDate(t *testing.T) {
	cases := []struct {
		raw  any
		want string // RFC3339 prefix; we don't compare suffix because the
		// canonical form may differ on timezone-less inputs.
	}{
		{"2024-06-01", "2024-06-01T00:00:00"},
		{"2024-06-01T12:00:00Z", "2024-06-01T12:00:00Z"},
		{time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC), "2024-06-01T12:00:00Z"},
	}
	for _, tc := range cases {
		got, err := coerce("k", TypeDate, tc.raw)
		if err != nil {
			t.Errorf("coerce(date, %v) err: %v", tc.raw, err)
			continue
		}
		s, ok := got.(string)
		if !ok {
			t.Errorf("date coerce should return string, got %T", got)
			continue
		}
		if !timestampHasPrefix(s, tc.want) {
			t.Errorf("coerce(date, %v) = %q, want prefix %q", tc.raw, s, tc.want)
		}
	}
	if _, err := coerce("k", TypeDate, "not a date"); err == nil {
		t.Error("'not a date' should not coerce")
	}
}

func timestampHasPrefix(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	return s[:len(prefix)] == prefix
}

// --- SUB-006: richer custom-attribute type coercion -----------------------

func enumDef(opts ...string) CustomField {
	return CustomField{Key: "tier", Type: TypeEnum, Config: &FieldConfig{Options: opts}}
}

func TestCoerceEnum(t *testing.T) {
	def := enumDef("gold", "silver", "bronze")
	got, err := coerceField("tier", def, "gold")
	if err != nil || got != "gold" {
		t.Fatalf("coerceField(enum, gold) = %v, err=%v; want gold", got, err)
	}
	// Non-string value stringifies before matching.
	def2 := enumDef("1", "2", "3")
	if got, err := coerceField("tier", def2, 2.0); err != nil || got != "2" {
		t.Fatalf("coerceField(enum, 2.0) = %v, err=%v; want \"2\"", got, err)
	}
	// Value outside the option set is a violation.
	if _, err := coerceField("tier", def, "platinum"); err == nil {
		t.Error("expected violation for value outside enum options")
	} else {
		var v *ErrValueViolation
		if !errors.As(err, &v) {
			t.Errorf("expected *ErrValueViolation, got %T", err)
		}
	}
	// Enum with no options declared is itself a violation.
	if _, err := coerceField("tier", CustomField{Key: "tier", Type: TypeEnum}, "gold"); err == nil {
		t.Error("expected violation for enum with no options")
	}
}

func TestCoerceEmail(t *testing.T) {
	def := CustomField{Key: "contact", Type: TypeEmail}
	if got, err := coerceField("contact", def, "a@b.com"); err != nil || got != "a@b.com" {
		t.Fatalf("coerceField(email, a@b.com) = %v, err=%v", got, err)
	}
	if _, err := coerceField("contact", def, "not-an-email"); err == nil {
		t.Error("expected violation for malformed email")
	}
	// Empty string passes (field is optional).
	if got, err := coerceField("contact", def, ""); err != nil || got != "" {
		t.Errorf("empty email should pass, got %v err=%v", got, err)
	}
}

func TestCoercePhone(t *testing.T) {
	def := CustomField{Key: "mobile", Type: TypePhone}
	for _, ok := range []string{"+14155551234", "(415) 555-1234", "415-555-1234", "4155551234"} {
		if _, err := coerceField("mobile", def, ok); err != nil {
			t.Errorf("phone %q should pass: %v", ok, err)
		}
	}
	for _, bad := range []string{"abc", "123", "+1-800-CALL-NOW"} {
		if _, err := coerceField("mobile", def, bad); err == nil {
			t.Errorf("phone %q should be rejected", bad)
		}
	}
}

func TestCoerceURL(t *testing.T) {
	def := CustomField{Key: "site", Type: TypeURL}
	if _, err := coerceField("site", def, "https://example.com/x"); err != nil {
		t.Errorf("valid https url rejected: %v", err)
	}
	if _, err := coerceField("site", def, "ftp://example.com"); err == nil {
		t.Error("ftp url should be rejected (http/https only)")
	}
	if _, err := coerceField("site", def, "not a url"); err == nil {
		t.Error("garbage url should be rejected")
	}
}

func TestCoerceArray(t *testing.T) {
	def := CustomField{Key: "scores", Type: TypeArray, Config: &FieldConfig{ItemType: "number"}}
	got, err := coerceField("scores", def, []any{"1", 2.0, "3.5"})
	if err != nil {
		t.Fatalf("coerceField(array) err: %v", err)
	}
	arr, ok := got.([]any)
	if !ok || len(arr) != 3 {
		t.Fatalf("expected 3-element []any, got %T %v", got, got)
	}
	if arr[0] != 1.0 || arr[1] != 2.0 || arr[2] != 3.5 {
		t.Errorf("element coercion wrong: %v", arr)
	}
	// Non-array input is a type mismatch.
	if _, err := coerceField("scores", def, "nope"); err == nil {
		t.Error("non-array input should be rejected")
	}
	// An element that can't coerce to the item type fails.
	if _, err := coerceField("scores", def, []any{"x"}); err == nil {
		t.Error("non-numeric element should be rejected")
	}
	// Default item type is string when unset.
	defStr := CustomField{Key: "tags", Type: TypeArray}
	if got, err := coerceField("tags", defStr, []any{1.0, "a"}); err != nil {
		t.Errorf("default-string array rejected: %v", err)
	} else if arr := got.([]any); arr[0] != "1" || arr[1] != "a" {
		t.Errorf("default-string coercion wrong: %v", arr)
	}
}

func TestCoerceObject(t *testing.T) {
	def := CustomField{Key: "address", Type: TypeObject, Config: &FieldConfig{
		Schema: map[string]string{"zip": "string", "floor": "number"},
	}}
	got, err := coerceField("address", def, map[string]any{
		"zip":   94107,         // declared string → coerced to "94107"
		"floor": "3",           // declared number → coerced to 3.0
		"extra": "passthrough", // not in schema → verbatim
	})
	if err != nil {
		t.Fatalf("coerceField(object) err: %v", err)
	}
	m, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("expected map, got %T", got)
	}
	if m["zip"] != "94107" {
		t.Errorf("zip = %v, want \"94107\"", m["zip"])
	}
	if m["floor"] != 3.0 {
		t.Errorf("floor = %v, want 3.0", m["floor"])
	}
	if m["extra"] != "passthrough" {
		t.Errorf("extra should pass through, got %v", m["extra"])
	}
	// Non-object input is a type mismatch.
	if _, err := coerceField("address", def, "nope"); err == nil {
		t.Error("non-object input should be rejected")
	}
	// A schema property that fails coercion bubbles up.
	if _, err := coerceField("address", def, map[string]any{"floor": "tall"}); err == nil {
		t.Error("non-numeric floor should be rejected")
	}
}

func TestCoerceValidationRule(t *testing.T) {
	// A string field with a regex validation_rule rejects non-matching values.
	def := CustomField{Key: "sku", Type: TypeString, ValidationRule: `^SKU-[0-9]+$`}
	if _, err := coerceField("sku", def, "SKU-123"); err != nil {
		t.Errorf("matching value rejected: %v", err)
	}
	if _, err := coerceField("sku", def, "nope"); err == nil {
		t.Error("non-matching value should be rejected by validation_rule")
	}
}
