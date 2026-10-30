package warehouse

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeReverseETLMappingDefaultsAndValidates(t *testing.T) {
	in := ReverseETLMapping{
		SourceTable:    "  warehouse.traits  ",
		SourceColumn:   " ltv ",
		TargetFieldKey: " lifetime_value ",
	}
	if err := normalizeReverseETLMapping(&in); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if in.SourceTable != "warehouse.traits" || in.SourceColumn != "ltv" || in.TargetFieldKey != "lifetime_value" {
		t.Fatalf("trim failed: %#v", in)
	}
	if in.ProfileKeyColumn != "email" || in.ProfileKeyTarget != "email" {
		t.Fatalf("profile key defaults = %q/%q", in.ProfileKeyColumn, in.ProfileKeyTarget)
	}
	if in.CastType != "string" || in.Status != "active" {
		t.Fatalf("defaults = %q/%q", in.CastType, in.Status)
	}
}

func TestNormalizeReverseETLMappingRejectsBadInput(t *testing.T) {
	cases := map[string]ReverseETLMapping{
		"no source_table":  {SourceColumn: "c", TargetFieldKey: "k"},
		"no source_column": {SourceTable: "t", TargetFieldKey: "k"},
		"no target":        {SourceTable: "t", SourceColumn: "c"},
		"bad cast":         {SourceTable: "t", SourceColumn: "c", TargetFieldKey: "k", CastType: "blob"},
		"bad status":       {SourceTable: "t", SourceColumn: "c", TargetFieldKey: "k", Status: "live"},
		"bad key target":   {SourceTable: "t", SourceColumn: "c", TargetFieldKey: "k", ProfileKeyTarget: "phone"},
	}
	for name, in := range cases {
		m := in
		if err := normalizeReverseETLMapping(&m); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}

func TestCastValue(t *testing.T) {
	// number
	if got := castValue("number", "42.5"); got != 42.5 {
		t.Errorf("number string cast = %v", got)
	}
	if got := castValue("number", float64(7)); got != float64(7) {
		t.Errorf("number passthrough = %v", got)
	}
	if got := castValue("number", "not-a-number"); got != "not-a-number" {
		t.Errorf("number fallback = %v", got)
	}
	// boolean
	if got := castValue("boolean", "yes"); got != true {
		t.Errorf("bool yes = %v", got)
	}
	if got := castValue("boolean", "0"); got != false {
		t.Errorf("bool 0 = %v", got)
	}
	if got := castValue("boolean", true); got != true {
		t.Errorf("bool passthrough = %v", got)
	}
	// json
	got := castValue("json", `{"a":1}`)
	m, ok := got.(map[string]any)
	if !ok || m["a"] != float64(1) {
		t.Errorf("json cast = %#v", got)
	}
	// string default
	if got := castValue("string", 123); got != "123" {
		t.Errorf("string cast of int = %v", got)
	}
	if got := castValue("string", nil); got != "" {
		t.Errorf("string cast of nil = %v", got)
	}
	// date/datetime → string form
	if got := castValue("datetime", "2026-06-15T00:00:00Z"); got != "2026-06-15T00:00:00Z" {
		t.Errorf("datetime cast = %v", got)
	}
}

func TestRequireActiveReverseETLConnection(t *testing.T) {
	if err := requireActiveReverseETLConnection(&Connection{Status: "active"}); err != nil {
		t.Fatalf("active connection should pass: %v", err)
	}
	if err := requireActiveReverseETLConnection(nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("nil connection error = %v", err)
	}
	if err := requireActiveReverseETLConnection(&Connection{Status: "disconnected"}); !errors.Is(err, ErrDisconnected) {
		t.Fatalf("disconnected connection error = %v", err)
	}
	if err := requireActiveReverseETLConnection(&Connection{Status: "paused"}); err == nil || !strings.Contains(err.Error(), "must be active") {
		t.Fatalf("paused connection error = %v", err)
	}
}

func TestReverseETLHandlersRequireTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	handlers := []http.HandlerFunc{
		d.ListReverseETLMappings,
		d.CreateReverseETLMapping,
		d.DeleteReverseETLMapping,
		d.SyncReverseETL,
	}
	for i, h := range handlers {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/warehouse/connections/x/reverse-etl-mappings", nil)
		rec := httptest.NewRecorder()
		h(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("handler %d: status = %d want 401", i, rec.Code)
		}
	}
}
