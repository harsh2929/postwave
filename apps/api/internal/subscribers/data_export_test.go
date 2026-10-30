package subscribers

// Tests for the per-subscriber DSAR export. The DB-backed handler is
// covered by the no-tenant 401 short-circuit (mirroring the CSV-export
// test pattern); the pure-Go zip + filename + JSONL marshal helpers
// are tested directly so the file-structure contract is locked.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDataExport_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/abc/data-export.zip", nil)
	w := httptest.NewRecorder()
	d.DataExport(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestSanitizeEmailForFilename(t *testing.T) {
	cases := map[string]string{
		"alice@example.com":   "alice-example.com",
		"ALICE@Example.COM":   "alice-example.com",
		"a+b@c.io":            "a-b-c.io",
		" weird@e.co ":        "weird-e.co",
		"---":                 "subscriber",
		"":                    "subscriber",
		"unicode@éxample.com": "unicode--xample.com",
	}
	for in, want := range cases {
		got := sanitizeEmailForFilename(strings.TrimSpace(in))
		if got != want {
			t.Errorf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestDataExportZip_HasRequiredEntries — the ZIP must contain every
// file the acceptance criteria call out, in the documented format.
func TestDataExportZip_HasRequiredEntries(t *testing.T) {
	bundle := map[string]any{
		"subscriber":         map[string]any{"email": "x@y.co", "status": "enabled"},
		"events":             []map[string]any{{"event_type": "open", "at": "2026-01-01T00:00:00Z"}, {"event_type": "click", "at": "2026-01-02T00:00:00Z"}},
		"consent_receipts":   []map[string]any{{"id": int64(1), "new_state": "granted", "source": "form"}},
		"subscriber_notes":   []map[string]any{{"body": "hello", "created_at": "2026-01-01T00:00:00Z"}},
		"email_suppressions": []map[string]any{{"reason": "complaint"}},
		"sms_suppressions":   []map[string]any{},
	}
	zipBytes, err := buildDataExportZip("req-123", "x@y.co", time.Date(2026, 6, 3, 0, 0, 0, 0, time.UTC), bundle)
	if err != nil {
		t.Fatalf("buildDataExportZip: %v", err)
	}
	rdr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	got := map[string][]byte{}
	for _, f := range rdr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		got[f.Name] = b
	}
	for _, name := range []string{
		"README.txt",
		"subscriber.json",
		"events.jsonl",
		"consent_receipts.jsonl",
		"notes.jsonl",
		"suppressions.json",
		"bundle.json",
	} {
		if _, ok := got[name]; !ok {
			t.Errorf("missing %q in zip; have %v", name, keys(got))
		}
	}

	// subscriber.json parses as a JSON object with the email field.
	var sub map[string]any
	if err := json.Unmarshal(got["subscriber.json"], &sub); err != nil {
		t.Fatalf("subscriber.json not valid JSON: %v", err)
	}
	if sub["email"] != "x@y.co" {
		t.Errorf("subscriber.json email = %v", sub["email"])
	}

	// events.jsonl has one JSON object per line.
	lines := strings.Split(strings.TrimSpace(string(got["events.jsonl"])), "\n")
	if len(lines) != 2 {
		t.Fatalf("events.jsonl lines = %d, want 2; body=%q", len(lines), string(got["events.jsonl"]))
	}
	for _, ln := range lines {
		var row map[string]any
		if err := json.Unmarshal([]byte(ln), &row); err != nil {
			t.Errorf("events line not JSON: %v (line=%q)", err, ln)
		}
	}

	// suppressions.json has both email + sms keys.
	var sup map[string]any
	if err := json.Unmarshal(got["suppressions.json"], &sup); err != nil {
		t.Fatalf("suppressions.json: %v", err)
	}
	if _, ok := sup["email"]; !ok {
		t.Errorf("suppressions.json missing email key")
	}
	if _, ok := sup["sms"]; !ok {
		t.Errorf("suppressions.json missing sms key")
	}
}

// TestDataExportZip_EmptyBundle — bundle sections may be nil/absent;
// the zip must still contain the expected entries.
func TestDataExportZip_EmptyBundle(t *testing.T) {
	zipBytes, err := buildDataExportZip("req-empty", "z@y.co", time.Now(), map[string]any{})
	if err != nil {
		t.Fatalf("buildDataExportZip: %v", err)
	}
	rdr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	names := map[string]bool{}
	for _, f := range rdr.File {
		names[f.Name] = true
	}
	for _, want := range []string{"subscriber.json", "events.jsonl", "consent_receipts.jsonl", "notes.jsonl", "suppressions.json"} {
		if !names[want] {
			t.Errorf("empty bundle missing %q", want)
		}
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
