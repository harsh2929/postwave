// SPDX-License-Identifier: AGPL-3.0-only

package auditsink

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

// TestValidWebhookFormat — the allow-list must match migration 0264's
// CHECK constraint exactly.
func TestValidWebhookFormat(t *testing.T) {
	cases := map[string]bool{
		WebhookFormatPostwaveV1:      true,
		WebhookFormatStandardWebhook: true,
		"":                           false,
		"svix":                       false,
		"v1":                         false,
		"STANDARD_WEBHOOKS":          false,
	}
	for in, want := range cases {
		if got := validWebhookFormat(in); got != want {
			t.Errorf("validWebhookFormat(%q) = %v, want %v", in, got, want)
		}
	}
}

// TestWebhookFormatConstantsMatchMigration — Go consts must match the
// migration's CHECK constraint enum strings.
func TestWebhookFormatConstantsMatchMigration(t *testing.T) {
	if WebhookFormatPostwaveV1 != "postwave_v1" {
		t.Errorf("WebhookFormatPostwaveV1 = %q, want postwave_v1", WebhookFormatPostwaveV1)
	}
	if WebhookFormatStandardWebhook != "standard_webhooks" {
		t.Errorf("WebhookFormatStandardWebhook = %q, want standard_webhooks",
			WebhookFormatStandardWebhook)
	}
}

// TestSignatureV1_KnownVector verifies SignatureV1 matches the
// standardwebhooks.com SDK behavior: signature = base64-no-pad(
// hmac_sha256(secret, id "." ts "." body)).
func TestSignatureV1_KnownVector(t *testing.T) {
	secret := []byte("topsecret-key-bytes")
	id := "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W"
	ts := time.Unix(1_700_000_000, 0)
	body := []byte(`{"hello":"world"}`)

	got := SignatureV1(secret, id, ts, body)
	if !strings.HasPrefix(got, "v1,") {
		t.Fatalf("SignatureV1: want prefix v1,, got %q", got)
	}
	// Recompute by hand and compare.
	want := hmac.New(sha256.New, secret)
	want.Write([]byte(id))
	want.Write([]byte("."))
	want.Write([]byte("1700000000"))
	want.Write([]byte("."))
	want.Write(body)
	expected := "v1," + base64.StdEncoding.WithPadding(base64.NoPadding).EncodeToString(want.Sum(nil))
	if got != expected {
		t.Errorf("SignatureV1 mismatch:\n got  %q\n want %q", got, expected)
	}
	// And the unpadded base64 should never contain '='.
	if strings.Contains(got, "=") {
		t.Errorf("SignatureV1: base64 must be unpadded, got %q", got)
	}
}

// TestSignatureV1_DifferentInputs — different id/ts/body must all
// produce different signatures (sanity check, no accidental collisions
// from constant assembly).
func TestSignatureV1_DifferentInputs(t *testing.T) {
	secret := []byte("k")
	ts := time.Unix(1, 0)
	a := SignatureV1(secret, "id1", ts, []byte("body"))
	b := SignatureV1(secret, "id2", ts, []byte("body"))
	c := SignatureV1(secret, "id1", ts.Add(time.Second), []byte("body"))
	d := SignatureV1(secret, "id1", ts, []byte("body2"))
	sigs := map[string]bool{a: true, b: true, c: true, d: true}
	if len(sigs) != 4 {
		t.Errorf("SignatureV1: expected 4 distinct signatures, got %d", len(sigs))
	}
}

// TestLegacySignatureV1_KnownVector — postwave_v1 backward-compat
// signature is sha256=<hex(hmac(secret, body))>.
func TestLegacySignatureV1_KnownVector(t *testing.T) {
	secret := []byte("legacy-secret")
	body := []byte("payload")
	got := LegacySignatureV1(secret, body)
	if !strings.HasPrefix(got, "sha256=") {
		t.Fatalf("LegacySignatureV1: want sha256= prefix, got %q", got)
	}
	want := hmac.New(sha256.New, secret)
	want.Write(body)
	expected := "sha256=" + hex.EncodeToString(want.Sum(nil))
	if got != expected {
		t.Errorf("LegacySignatureV1 mismatch:\n got  %q\n want %q", got, expected)
	}
}

// TestDeriveEventID_Deterministic — same inputs MUST produce the same
// UUID across calls. This is the keystone property: replays must carry
// the same webhook-id end-to-end so receivers can dedupe.
func TestDeriveEventID_Deterministic(t *testing.T) {
	at := time.Unix(1_700_000_000, 0)
	a := DeriveEventID("tenant-1", "subscriber.create", "subscriber", "sub-42",
		"claude-code", at)
	b := DeriveEventID("tenant-1", "subscriber.create", "subscriber", "sub-42",
		"claude-code", at)
	if a != b {
		t.Errorf("DeriveEventID not deterministic: %q != %q", a, b)
	}
	// Format check: canonical 8-4-4-4-12 hex.
	if len(a) != 36 {
		t.Errorf("DeriveEventID: want 36-char UUID, got %d chars: %q", len(a), a)
	}
	// UUIDv5 stamp: byte 6 high nibble = 5; byte 8 high bits = 10.
	parts := strings.Split(a, "-")
	if len(parts) != 5 {
		t.Fatalf("DeriveEventID: malformed UUID %q", a)
	}
	if parts[2][0] != '5' {
		t.Errorf("DeriveEventID: want version 5 nibble, got %q in %q", parts[2][0:1], a)
	}
	// Variant: first nibble of group 4 must be in {8,9,a,b}.
	switch parts[3][0] {
	case '8', '9', 'a', 'b':
	default:
		t.Errorf("DeriveEventID: want RFC 4122 variant in group 4, got %q in %q",
			parts[3][0:1], a)
	}
}

// TestDeriveEventID_DistinctInputs — changing any tuple field yields a
// different UUID.
func TestDeriveEventID_DistinctInputs(t *testing.T) {
	at := time.Unix(1, 0)
	base := DeriveEventID("t", "a", "rt", "rid", "al", at)
	tests := []struct {
		name string
		got  string
	}{
		{"tenant", DeriveEventID("t2", "a", "rt", "rid", "al", at)},
		{"action", DeriveEventID("t", "a2", "rt", "rid", "al", at)},
		{"resource_type", DeriveEventID("t", "a", "rt2", "rid", "al", at)},
		{"resource_id", DeriveEventID("t", "a", "rt", "rid2", "al", at)},
		{"actor_label", DeriveEventID("t", "a", "rt", "rid", "al2", at)},
		{"at", DeriveEventID("t", "a", "rt", "rid", "al", at.Add(time.Second))},
	}
	for _, c := range tests {
		if c.got == base {
			t.Errorf("DeriveEventID: changing %s did not change UUID (%q)", c.name, c.got)
		}
	}
}
