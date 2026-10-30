// SPDX-License-Identifier: AGPL-3.0-only
package cdp_transforms

import (
	"reflect"
	"strings"
	"testing"
)

func TestApply_LowercaseChangesValue(t *testing.T) {
	in := map[string]any{"email": "Alice@Example.com"}
	out := Apply(in, []Op{{Type: "lowercase", Field: "email"}})
	if out.Properties["email"] != "alice@example.com" {
		t.Errorf("email = %v, want alice@example.com", out.Properties["email"])
	}
	if !out.Results[0].Changed {
		t.Errorf("expected Changed=true")
	}
}

func TestApply_LowercaseIdempotent(t *testing.T) {
	first := Apply(map[string]any{"x": "Foo"}, []Op{{Type: "lowercase", Field: "x"}})
	second := Apply(first.Properties, []Op{{Type: "lowercase", Field: "x"}})
	if second.Results[0].Changed {
		t.Errorf("second pass should be no-op, got Changed=true")
	}
	if second.Properties["x"] != "foo" {
		t.Errorf("idempotent value drifted: %v", second.Properties["x"])
	}
}

func TestApply_DoesNotMutateInput(t *testing.T) {
	in := map[string]any{"x": "FOO", "nested": map[string]any{"y": "BAR"}}
	_ = Apply(in, []Op{{Type: "lowercase", Field: "x"}, {Type: "lowercase", Field: "nested.y"}})
	if in["x"] != "FOO" {
		t.Errorf("input mutated, x=%v", in["x"])
	}
	if inner, _ := in["nested"].(map[string]any); inner["y"] != "BAR" {
		t.Errorf("nested input mutated, nested.y=%v", inner["y"])
	}
}

func TestApply_UnknownOpRecordedAsFailure(t *testing.T) {
	out := Apply(map[string]any{"x": "y"}, []Op{{Type: "nonexistent", Field: "x"}})
	if out.Failed != 1 || out.Success != 0 {
		t.Errorf("unknown op should fail, got success=%d failed=%d", out.Success, out.Failed)
	}
	if !strings.Contains(out.Results[0].Error, "unknown op") {
		t.Errorf("expected unknown op error, got %q", out.Results[0].Error)
	}
}

func TestApply_NestedFieldPath(t *testing.T) {
	in := map[string]any{"addr": map[string]any{"country": "  United States  "}}
	out := Apply(in, []Op{
		{Type: "trim", Field: "addr.country"},
		{Type: "country_iso2", Field: "addr.country"},
	})
	addr, _ := out.Properties["addr"].(map[string]any)
	if addr["country"] != "US" {
		t.Errorf("nested transform failed, addr.country=%v", addr["country"])
	}
}

func TestApply_TitleCase(t *testing.T) {
	in := map[string]any{"name": "alice WONDERLAND"}
	out := Apply(in, []Op{{Type: "title_case", Field: "name"}})
	if out.Properties["name"] != "Alice Wonderland" {
		t.Errorf("title_case: %v", out.Properties["name"])
	}
}

func TestApply_StripHTML(t *testing.T) {
	in := map[string]any{"bio": "<b>hi</b> <i>there</i>"}
	out := Apply(in, []Op{{Type: "strip_html", Field: "bio"}})
	if out.Properties["bio"] != "hi there" {
		t.Errorf("strip_html: %v", out.Properties["bio"])
	}
}

func TestApply_DefaultValue(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]any
		want any
	}{
		{"missing key", map[string]any{}, "unknown"},
		{"empty string", map[string]any{"locale": ""}, "unknown"},
		{"whitespace", map[string]any{"locale": "   "}, "unknown"},
		{"existing value", map[string]any{"locale": "en-US"}, "en-US"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := Apply(c.in, []Op{{
				Type: "default_value", Field: "locale",
				Args: map[string]any{"value": "unknown"},
			}})
			if out.Properties["locale"] != c.want {
				t.Errorf("locale=%v, want %v", out.Properties["locale"], c.want)
			}
		})
	}
}

func TestApply_CoerceNumber(t *testing.T) {
	in := map[string]any{"a": "42", "b": "12.5", "c": true, "d": "not-a-number"}
	out := Apply(in, []Op{
		{Type: "coerce_number", Field: "a"},
		{Type: "coerce_number", Field: "b"},
		{Type: "coerce_number", Field: "c"},
		{Type: "coerce_number", Field: "d"},
	})
	if out.Properties["a"] != float64(42) {
		t.Errorf("a=%v", out.Properties["a"])
	}
	if out.Properties["b"] != 12.5 {
		t.Errorf("b=%v", out.Properties["b"])
	}
	if out.Properties["c"] != float64(1) {
		t.Errorf("c=%v", out.Properties["c"])
	}
	if out.Failed != 1 {
		t.Errorf("expected one failure for d, got Failed=%d", out.Failed)
	}
}

func TestApply_CoerceBool(t *testing.T) {
	in := map[string]any{"a": "yes", "b": "0", "c": "FALSE", "d": float64(7), "e": "maybe"}
	out := Apply(in, []Op{
		{Type: "coerce_bool", Field: "a"},
		{Type: "coerce_bool", Field: "b"},
		{Type: "coerce_bool", Field: "c"},
		{Type: "coerce_bool", Field: "d"},
		{Type: "coerce_bool", Field: "e"},
	})
	if out.Properties["a"] != true {
		t.Errorf("a=%v", out.Properties["a"])
	}
	if out.Properties["b"] != false {
		t.Errorf("b=%v", out.Properties["b"])
	}
	if out.Properties["c"] != false {
		t.Errorf("c=%v", out.Properties["c"])
	}
	if out.Properties["d"] != true {
		t.Errorf("d=%v", out.Properties["d"])
	}
	if out.Failed != 1 {
		t.Errorf("expected one failure for e, got Failed=%d", out.Failed)
	}
}

func TestApply_EmailNormalizeGmailCanonical(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Alice+Promos@Gmail.com", "alice@gmail.com"},
		{"a.l.i.c.e@gmail.com", "alice@gmail.com"},
		{"alice@GoogleMail.com", "alice@googlemail.com"},
		{"alice@example.com", "alice@example.com"},
		{"  AB+work@gmail.com  ", "ab@gmail.com"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			out := Apply(map[string]any{"e": c.in}, []Op{{Type: "email_normalize", Field: "e"}})
			if out.Properties["e"] != c.want {
				t.Errorf("email_normalize(%q) = %v, want %v", c.in, out.Properties["e"], c.want)
			}
		})
	}
}

func TestApply_PhoneE164DefaultCC(t *testing.T) {
	out := Apply(map[string]any{"phone": "(415) 555-2671"}, []Op{
		{Type: "phone_e164", Field: "phone", Args: map[string]any{"default_country_code": "1"}},
	})
	if out.Properties["phone"] != "+14155552671" {
		t.Errorf("phone_e164: %v", out.Properties["phone"])
	}
}

func TestApply_CountryISO2(t *testing.T) {
	cases := []struct{ in, want string }{
		{"United States", "US"},
		{"  uk  ", "GB"}, // trim+lowercase happens inside the handler for lookup
		{"FR", "FR"},
		{"Germany", "DE"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			out := Apply(map[string]any{"c": c.in}, []Op{{Type: "country_iso2", Field: "c"}})
			if out.Properties["c"] != c.want {
				t.Errorf("country_iso2(%q) = %v, want %v", c.in, out.Properties["c"], c.want)
			}
		})
	}
}

func TestApply_DeleteRemovesField(t *testing.T) {
	in := map[string]any{"a": 1, "b": 2}
	out := Apply(in, []Op{{Type: "delete", Field: "a"}})
	if _, exists := out.Properties["a"]; exists {
		t.Errorf("delete didn't remove field: %v", out.Properties)
	}
	if out.Properties["b"] != 2 {
		t.Errorf("delete removed wrong field: %v", out.Properties)
	}
}

func TestApply_DeleteNestedFieldCleansEmptyParents(t *testing.T) {
	in := map[string]any{"a": map[string]any{"b": map[string]any{"c": 1}}}
	out := Apply(in, []Op{{Type: "delete", Field: "a.b.c"}})
	if _, exists := out.Properties["a"]; exists {
		t.Errorf("empty parents not trimmed: %v", out.Properties)
	}
}

func TestApply_RegexReplace(t *testing.T) {
	out := Apply(map[string]any{"x": "foo-bar-baz"}, []Op{{
		Type: "regex_replace", Field: "x",
		Args: map[string]any{"pattern": "-", "replacement": "_"},
	}})
	if out.Properties["x"] != "foo_bar_baz" {
		t.Errorf("regex_replace: %v", out.Properties["x"])
	}
}

func TestApply_Truncate(t *testing.T) {
	out := Apply(map[string]any{"x": "abcdef"}, []Op{{
		Type: "truncate", Field: "x",
		Args: map[string]any{"max": 3},
	}})
	if out.Properties["x"] != "abc" {
		t.Errorf("truncate: %v", out.Properties["x"])
	}
}

func TestApply_TruncateRequiresMax(t *testing.T) {
	out := Apply(map[string]any{"x": "abcdef"}, []Op{{Type: "truncate", Field: "x"}})
	if out.Failed != 1 {
		t.Errorf("truncate without max should fail, got Failed=%d", out.Failed)
	}
}

func TestApply_MultipleOpsAppliedInOrder(t *testing.T) {
	in := map[string]any{"email": "  Alice+Promos@GMAIL.com  "}
	out := Apply(in, []Op{
		{Type: "trim", Field: "email"},
		{Type: "email_normalize", Field: "email"},
	})
	if out.Properties["email"] != "alice@gmail.com" {
		t.Errorf("chained = %v", out.Properties["email"])
	}
	if out.Success != 2 {
		t.Errorf("expected 2 success, got %d", out.Success)
	}
}

func TestRegisteredReturnsAllOps(t *testing.T) {
	ops := Registered()
	want := []string{
		"lowercase", "uppercase", "trim", "title_case", "strip_html",
		"default_value", "coerce_number", "coerce_bool", "truncate",
		"email_normalize", "phone_e164", "country_iso2", "delete", "regex_replace",
	}
	got := map[string]bool{}
	for _, o := range ops {
		got[o] = true
	}
	for _, w := range want {
		if !got[w] {
			t.Errorf("Registered missing %q", w)
		}
	}
}

func TestDeepCloneIsolatesNested(t *testing.T) {
	in := map[string]any{"a": map[string]any{"b": []any{1, 2, 3}}}
	out := deepClone(in)
	out["a"].(map[string]any)["b"].([]any)[0] = 99
	if reflect.DeepEqual(in, out) {
		t.Errorf("deepClone failed to isolate: in=%v out=%v", in, out)
	}
}
