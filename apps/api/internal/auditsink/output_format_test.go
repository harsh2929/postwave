// SPDX-License-Identifier: AGPL-3.0-only

package auditsink

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestRowPayloads_Native verifies that postwave_native preserves the
// historic AuditRow JSON shape.
func TestRowPayloads_Native(t *testing.T) {
	s := Sink{OutputFormat: FormatNative}
	rows := []AuditRow{{
		ID: 1, TenantID: "t-1", Action: "subscriber.create",
		ResourceType: "subscriber", ResourceID: "s-1",
		At: time.Unix(1_700_000_000, 0).UTC(),
	}}
	p := rowPayloads(s, rows)
	if len(p) != 1 {
		t.Fatalf("expected 1 payload, got %d", len(p))
	}
	if p[0]["action"] != "subscriber.create" {
		t.Errorf("native payload missing action: %v", p[0])
	}
	if _, hasOCSF := p[0]["class_uid"]; hasOCSF {
		t.Errorf("native payload should NOT have class_uid: %v", p[0])
	}
}

// TestRowPayloads_OCSF verifies that ocsf_1_8 produces an OCSF
// envelope with class_uid and metadata.
func TestRowPayloads_OCSF(t *testing.T) {
	s := Sink{OutputFormat: FormatOCSF18}
	rows := []AuditRow{{
		ID: 1, TenantID: "t-1", Action: "subscriber.delete",
		ResourceType: "subscriber", ResourceID: "s-1",
		At: time.Unix(1_700_000_000, 0).UTC(),
	}}
	p := rowPayloads(s, rows)
	if len(p) != 1 {
		t.Fatalf("expected 1 payload, got %d", len(p))
	}
	classID, ok := p[0]["class_uid"].(float64)
	if !ok {
		t.Fatalf("class_uid missing or wrong type: %v", p[0]["class_uid"])
	}
	if int(classID) != 3004 {
		t.Errorf("class_uid = %v, want 3004 (Entity Management)", classID)
	}
	meta, ok := p[0]["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("metadata missing")
	}
	if meta["version"] != "1.8.0" {
		t.Errorf("metadata.version = %v, want 1.8.0", meta["version"])
	}
	sev, _ := p[0]["severity_id"].(float64)
	if int(sev) != 4 {
		t.Errorf("severity_id = %v, want 4 (High) for delete action", sev)
	}
}

// TestRowPayloads_EmptyFormatFallsBackToNative — empty OutputFormat
// (legacy code paths constructing Sink manually) must default to
// the historic native shape.
func TestRowPayloads_EmptyFormatFallsBackToNative(t *testing.T) {
	s := Sink{OutputFormat: ""} // legacy
	rows := []AuditRow{{
		ID: 1, TenantID: "t-1", Action: "subscriber.create",
		At: time.Unix(1_700_000_000, 0).UTC(),
	}}
	p := rowPayloads(s, rows)
	if _, hasOCSF := p[0]["class_uid"]; hasOCSF {
		t.Errorf("empty OutputFormat should NOT produce OCSF: %v", p[0])
	}
}

// TestFormatLabel checks the public tag used in Datadog ddtags and
// elsewhere matches what the migration / spec defines.
func TestFormatLabel(t *testing.T) {
	if got := formatLabel(Sink{OutputFormat: FormatOCSF18}); got != "ocsf_1_8" {
		t.Errorf("ocsf label = %q, want ocsf_1_8", got)
	}
	if got := formatLabel(Sink{OutputFormat: FormatNative}); got != "postwave_native" {
		t.Errorf("native label = %q, want postwave_native", got)
	}
	if got := formatLabel(Sink{}); got != "postwave_native" {
		t.Errorf("empty label = %q, want postwave_native", got)
	}
}

// TestRowPayloads_OCSF_NDJSONSerializable confirms each OCSF payload
// can be re-encoded to single-line JSON (no embedded newlines, no
// unencodable types).
func TestRowPayloads_OCSF_NDJSONSerializable(t *testing.T) {
	s := Sink{OutputFormat: FormatOCSF18}
	rows := []AuditRow{
		{ID: 1, TenantID: "t-1", Action: "auth.login",
			At: time.Unix(1_700_000_000, 0).UTC()},
		{ID: 2, TenantID: "t-1", Action: "subscriber.create",
			At: time.Unix(1_700_000_001, 0).UTC()},
	}
	payloads := rowPayloads(s, rows)
	for i, p := range payloads {
		raw, err := json.Marshal(p)
		if err != nil {
			t.Fatalf("payload %d marshal: %v", i, err)
		}
		if strings.Contains(string(raw), "\n") {
			t.Errorf("payload %d contains embedded newline", i)
		}
	}
}
