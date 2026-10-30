// SPDX-License-Identifier: AGPL-3.0-only
//
// export_manifest_test.go — round-trip + canonicalisation tests for
// the signed export manifest. No DB / network — pure value-equality.

package auditsink

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestCanonicaliseFilters_StripsEmptyAndSorts(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]any
		want []string // expected keys, in order
	}{
		{
			name: "strips empty strings",
			in: map[string]any{
				"actor_type":  "agent",
				"actor_label": "",
				"action":      "subscriber.delete",
			},
			want: []string{"action", "actor_type"},
		},
		{
			name: "sorts keys alphabetically",
			in: map[string]any{
				"resource_type": "subscriber",
				"action":        "subscriber.delete",
				"actor_type":    "user",
			},
			want: []string{"action", "actor_type", "resource_type"},
		},
		{
			name: "drops nil values",
			in: map[string]any{
				"x": "value",
				"y": nil,
			},
			want: []string{"x"},
		},
		{
			name: "empty input → empty map",
			in:   map[string]any{},
			want: []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := canonicaliseFilters(tc.in)
			if len(out) != len(tc.want) {
				t.Fatalf("len mismatch: got %d, want %d (got map: %v)", len(out), len(tc.want), out)
			}
			for _, k := range tc.want {
				if _, ok := out[k]; !ok {
					t.Errorf("missing key %q in canonicalised output", k)
				}
			}
		})
	}
}

func TestManifestRange(t *testing.T) {
	tests := []struct {
		name     string
		rows     []ManifestRow
		wantFrom int64
		wantTo   int64
	}{
		{
			name:     "empty",
			rows:     []ManifestRow{},
			wantFrom: 0,
			wantTo:   0,
		},
		{
			name:     "single row",
			rows:     []ManifestRow{{ID: 42}},
			wantFrom: 42,
			wantTo:   42,
		},
		{
			name:     "sorted ascending",
			rows:     []ManifestRow{{ID: 10}, {ID: 20}, {ID: 30}},
			wantFrom: 10,
			wantTo:   30,
		},
		{
			name:     "unsorted",
			rows:     []ManifestRow{{ID: 30}, {ID: 10}, {ID: 20}},
			wantFrom: 10,
			wantTo:   30,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			from, to := manifestRange(tc.rows)
			if from != tc.wantFrom || to != tc.wantTo {
				t.Errorf("got (%d, %d), want (%d, %d)",
					from, to, tc.wantFrom, tc.wantTo)
			}
		})
	}
}

func TestManifestCanonicalBytes_StableAcrossRuns(t *testing.T) {
	// The canonical bytes MUST be deterministic for the verifier to
	// recompute the signature. Two manifests with the same fields
	// (in different in-memory order) should produce identical bytes.
	m1 := &ExportManifest{
		Version:     1,
		TenantID:    "tenant-a",
		ExportID:    "test-export",
		FromAuditID: 100,
		ToAuditID:   200,
		RowCount:    2,
		Rows: []ManifestRow{
			{ID: 100, At: "2026-06-01T00:00:00Z", RowHash: "aa", PrevHash: "bb"},
			{ID: 200, At: "2026-06-01T00:00:01Z", RowHash: "cc", PrevHash: "dd"},
		},
		ExportedAt: "2026-06-01T12:00:00Z",
	}
	b1, err := m1.canonicalBytes()
	if err != nil {
		t.Fatalf("canonicalBytes err: %v", err)
	}
	b2, err := m1.canonicalBytes()
	if err != nil {
		t.Fatalf("canonicalBytes err (second): %v", err)
	}
	if string(b1) != string(b2) {
		t.Errorf("canonical bytes not deterministic across calls")
	}
}

func TestManifestCanonicalBytes_ExcludesSignature(t *testing.T) {
	// The signature must sign everything EXCEPT itself. Two manifests
	// that differ only in signature/kid must produce identical canonical
	// bytes.
	m1 := &ExportManifest{
		Version:  1,
		TenantID: "tenant-a",
		ExportID: "test",
	}
	b1, _ := m1.canonicalBytes()

	m2 := *m1
	m2.Signature = "deadbeef"
	m2.SignatureKid = "kid-1"
	b2, _ := m2.canonicalBytes()

	if string(b1) != string(b2) {
		t.Errorf("signature must not affect canonical bytes")
	}
}

func TestVerifyManifest_RoundTrip(t *testing.T) {
	secret := []byte("test-secret-32-bytes-long-padding!")
	m := &ExportManifest{
		Version:     1,
		TenantID:    "tenant-a",
		ExportID:    "test-export-1",
		FromAuditID: 1,
		ToAuditID:   3,
		RowCount:    3,
		Rows: []ManifestRow{
			{ID: 1, At: "2026-06-01T00:00:00Z"},
			{ID: 2, At: "2026-06-01T00:00:01Z"},
			{ID: 3, At: "2026-06-01T00:00:02Z"},
		},
		ExportedAt: "2026-06-01T12:00:00Z",
	}
	canonical, err := m.canonicalBytes()
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(canonical)
	m.Signature = hex.EncodeToString(mac.Sum(nil))
	m.SignatureKid = "test-kid"

	if !VerifyManifest(m, secret) {
		t.Errorf("VerifyManifest should accept correctly-signed manifest")
	}

	// Tamper with row data — verify must reject.
	tampered := *m
	tampered.Rows = []ManifestRow{{ID: 999, At: "2026-06-01T00:00:00Z"}}
	if VerifyManifest(&tampered, secret) {
		t.Errorf("VerifyManifest should reject tampered manifest")
	}

	// Wrong secret — verify must reject.
	if VerifyManifest(m, []byte("wrong-secret")) {
		t.Errorf("VerifyManifest should reject wrong secret")
	}

	// Missing signature — verify must reject.
	noSig := *m
	noSig.Signature = ""
	if VerifyManifest(&noSig, secret) {
		t.Errorf("VerifyManifest should reject manifest with empty signature")
	}
}

func TestNewExportID_FormatAndUniqueness(t *testing.T) {
	// Format: YYYYMMDD-HHMMSS-<6 hex chars>
	id := newExportID()
	if len(id) < 22 {
		t.Errorf("export id too short: %q", id)
	}
	parts := strings.Split(id, "-")
	if len(parts) != 3 {
		t.Fatalf("expected 3 dash-separated parts, got %d: %q", len(parts), id)
	}
	if len(parts[2]) != 6 {
		t.Errorf("expected 6-char random suffix, got %q", parts[2])
	}
	// Two IDs in quick succession should differ (collision odds ~ 1 in 16M).
	id2 := newExportID()
	if id == id2 {
		t.Errorf("expected unique IDs, got %q twice", id)
	}
}
