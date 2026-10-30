package subscribers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// fieldSet collapses a []attributeChange into a name->{old,new} map for
// order-independent assertions.
func fieldSet(changes []attributeChange) map[string][2]string {
	out := map[string][2]string{}
	for _, c := range changes {
		var o, n string
		if c.old != nil {
			o = *c.old
		}
		if c.new != nil {
			n = *c.new
		}
		out[c.field] = [2]string{o, n}
	}
	return out
}

func TestDiffSubscriberAttributes_StatusChange(t *testing.T) {
	before := &Subscriber{Status: "enabled"}
	after := &Subscriber{Status: "disabled"}
	got := fieldSet(diffSubscriberAttributes(before, after))
	if v, ok := got["status"]; !ok || v != [2]string{"enabled", "disabled"} {
		t.Fatalf("status change = %v (ok=%v); want [enabled disabled]", got["status"], ok)
	}
	// No spurious fields for unchanged attributes.
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 change, got %d: %v", len(got), got)
	}
}

func TestDiffSubscriberAttributes_CustomFieldKeyDiff(t *testing.T) {
	before := &Subscriber{CustomFields: map[string]any{"phone": "555-1234", "plan": "free"}}
	after := &Subscriber{CustomFields: map[string]any{"phone": "555-5678", "plan": "free"}}
	got := fieldSet(diffSubscriberAttributes(before, after))
	if v, ok := got["custom_fields.phone"]; !ok || v != [2]string{"555-1234", "555-5678"} {
		t.Fatalf("phone change = %v (ok=%v)", got["custom_fields.phone"], ok)
	}
	if _, ok := got["custom_fields.plan"]; ok {
		t.Fatalf("unchanged plan should not appear: %v", got)
	}
}

func TestDiffSubscriberAttributes_AddAndRemoveKey(t *testing.T) {
	before := &Subscriber{CustomFields: map[string]any{"old": "x"}}
	after := &Subscriber{CustomFields: map[string]any{"new": "y"}}
	changes := diffSubscriberAttributes(before, after)
	byField := map[string]attributeChange{}
	for _, c := range changes {
		byField[c.field] = c
	}
	added, ok := byField["custom_fields.new"]
	if !ok || added.old != nil || added.new == nil || *added.new != "y" {
		t.Fatalf("added key: %+v", added)
	}
	removed, ok := byField["custom_fields.old"]
	if !ok || removed.new != nil || removed.old == nil || *removed.old != "x" {
		t.Fatalf("removed key: %+v", removed)
	}
}

func TestDiffSubscriberAttributes_NilBeforeTreatedAsEmpty(t *testing.T) {
	// A fresh insert (nil before) logs only its non-empty attributes.
	after := &Subscriber{Status: "enabled", CustomFields: map[string]any{"phone": "1"}}
	got := fieldSet(diffSubscriberAttributes(nil, after))
	if got["status"] != [2]string{"", "enabled"} {
		t.Fatalf("status from nil before = %v", got["status"])
	}
	if got["custom_fields.phone"] != [2]string{"", "1"} {
		t.Fatalf("phone from nil before = %v", got["custom_fields.phone"])
	}
}

func TestDiffSubscriberAttributes_TagsIgnored(t *testing.T) {
	before := &Subscriber{Tags: []string{"a"}}
	after := &Subscriber{Tags: []string{"a", "b"}}
	if changes := diffSubscriberAttributes(before, after); len(changes) != 0 {
		t.Fatalf("tags must not be diffed here (tag_history owns them); got %v", changes)
	}
}

func TestRenderAttrValue(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{"hello", "hello"},
		{true, "true"},
		{false, "false"},
		{float64(42), "42"},
		{float64(3.5), "3.5"},
		{nil, ""},
		{map[string]any{"k": "v"}, `{"k":"v"}`},
	}
	for _, tc := range cases {
		if got := renderAttrValue(tc.in); got != tc.want {
			t.Errorf("renderAttrValue(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// Handler guard: missing tenant → 401 (no DB touched).
func TestGetAttributeHistory_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/abc/attribute-history", nil)
	rec := httptest.NewRecorder()
	d.GetAttributeHistory(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// Handler guard: malformed ?before → 400 before any DB call.
func TestGetAttributeHistory_RejectsBadBefore(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := subscriberTenantRequest(http.MethodGet, "/api/v1/subscribers/abc/attribute-history?before=not-a-time", "")
	rec := httptest.NewRecorder()
	d.GetAttributeHistory(rec, r)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
