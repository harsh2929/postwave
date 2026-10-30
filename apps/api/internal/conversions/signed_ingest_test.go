// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testSecret = "sk_test_a5f2c9d1e8b47306a5f2c9d1e8b47306"

func TestEmailIdentityHMACNormalizesAndIsKeyScoped(t *testing.T) {
	got := EmailIdentityHMAC(testSecret, "  Buyer@Example.COM  ")
	mac := hmac.New(sha256.New, []byte(testSecret))
	_, _ = mac.Write([]byte("buyer@example.com"))
	want := hex.EncodeToString(mac.Sum(nil))
	if got != want {
		t.Fatalf("email identity HMAC = %q, want %q", got, want)
	}
	if rotated := EmailIdentityHMAC("sk_test_rotated_secret", "buyer@example.com"); rotated == got {
		t.Fatal("email identity HMAC must change when the signing secret rotates")
	}
	if EmailIdentityHMAC("", "buyer@example.com") != "" ||
		EmailIdentityHMAC(testSecret, "   ") != "" {
		t.Fatal("empty secret/address must not produce identity evidence")
	}
}

// A signature covers the timestamp as well as the body.
//
// This is the property that makes the replay fence mean anything. If only the
// body were signed, an attacker who captured one request could resend it forever
// with a fresh timestamp: the skew check would pass and the MAC would still
// verify, so the fence would be decorative.
func TestTheSignatureCoversTheTimestampNotJustTheBody(t *testing.T) {
	body := []byte(`{"event_name":"purchase","value":129.00}`)
	original := "1760000000"
	replayed := "1760000600"

	header := SignRequest(testSecret, "k1", original, body)
	_, mac, ok := ParseSignatureHeader(header)
	if !ok {
		t.Fatalf("could not parse the header we just produced: %q", header)
	}

	if !SignatureMatches(testSecret, "k1", original, body, mac) {
		t.Fatal("a signature does not verify against the request that produced it")
	}
	if SignatureMatches(testSecret, "k1", replayed, body, mac) {
		t.Fatal("the same MAC verified under a DIFFERENT timestamp — a captured " +
			"request can be replayed forever by advancing the clock, and the skew " +
			"check is decorative")
	}
}

// Any change to the body invalidates the signature.
func TestAnyBodyChangeInvalidatesTheSignature(t *testing.T) {
	timestamp := "1760000000"
	original := []byte(`{"event_name":"purchase","value":129.00}`)
	header := SignRequest(testSecret, "k1", timestamp, original)
	_, mac, _ := ParseSignatureHeader(header)

	for _, tampered := range []string{
		`{"event_name":"purchase","value":1290.00}`,
		`{"event_name":"refund","value":129.00}`,
		`{"event_name":"purchase","value":129.00} `,
		`{"value":129.00,"event_name":"purchase"}`,
	} {
		if SignatureMatches(testSecret, "k1", timestamp, []byte(tampered), mac) {
			t.Errorf("signature still verified after the body became %s", tampered)
		}
	}
}

// Version 2 binds the routing key into the MAC. Global uniqueness makes one key
// resolve to one workspace; signing the key prevents a captured request from
// being rerouted to a different key whose operator accidentally reused the same
// secret.
func TestTheSignatureBindsTheRoutingKey(t *testing.T) {
	timestamp := "1760000000"
	body := []byte(`{"event_name":"purchase"}`)
	header := SignRequest(testSecret, "workspace-a-key", timestamp, body)
	_, mac, ok := ParseSignatureHeader(header)
	if !ok {
		t.Fatalf("could not parse v2 signature %q", header)
	}
	if !SignatureMatches(testSecret, "workspace-a-key", timestamp, body, mac) {
		t.Fatal("signature did not verify for the key that produced it")
	}
	if SignatureMatches(testSecret, "workspace-b-key", timestamp, body, mac) {
		t.Fatal("signature verified after keyid substitution — a reused secret can reroute a request across workspaces")
	}
}

// The wrong secret never verifies.
func TestAnotherTenantsSecretDoesNotVerify(t *testing.T) {
	timestamp := "1760000000"
	body := []byte(`{"event_name":"purchase"}`)
	header := SignRequest(testSecret, "k1", timestamp, body)
	_, mac, _ := ParseSignatureHeader(header)

	if SignatureMatches("sk_test_someone_elses_secret_entirely", "k1", timestamp, body, mac) {
		t.Fatal("a signature verified under a different secret")
	}
	// The real risk is an attacker who signs WITH the empty secret against a
	// tenant whose secret column is empty — a MAC computed the same way on both
	// sides WOULD match, so this needs its own guard rather than relying on the
	// MACs differing. An earlier version of this test passed a MAC made with the
	// real secret, which an empty key never reproduces, so it proved nothing.
	emptyKeyHeader := SignRequest("", "k1", timestamp, body)
	_, emptyKeyMAC, _ := ParseSignatureHeader(emptyKeyHeader)
	if SignatureMatches("", "k1", timestamp, body, emptyKeyMAC) {
		t.Fatal("a signature computed with an EMPTY secret verified against an " +
			"empty stored secret — a tenant whose secret was never set, or was " +
			"cleared, would accept requests from anyone who noticed")
	}
}

// The replay fence rejects both stale AND future timestamps.
//
// The future direction matters and is easy to forget: a far-future timestamp
// mints a signature that stays valid for as long as the attacker chose.
func TestTheReplayFenceRejectsStaleAndFutureTimestamps(t *testing.T) {
	now := time.Unix(1760000000, 0).UTC()
	for _, tc := range []struct {
		name   string
		offset time.Duration
		want   bool
	}{
		{"now", 0, true},
		{"one minute ago", -time.Minute, true},
		{"four minutes ago", -4 * time.Minute, true},
		{"six minutes ago is stale", -6 * time.Minute, false},
		{"an hour ago is stale", -time.Hour, false},
		{"a minute ahead tolerates clock skew", time.Minute, true},
		{"six minutes ahead is refused", 6 * time.Minute, false},
		{"a year ahead would mint a long-lived signature", 365 * 24 * time.Hour, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stamp := now.Add(tc.offset).Unix()
			got := TimestampFresh(strconv.FormatInt(stamp, 10), now)
			if got != tc.want {
				t.Fatalf("fresh(%v) = %v, want %v", tc.offset, got, tc.want)
			}
		})
	}
	// Garbage must not be treated as fresh.
	for _, raw := range []string{"", "not-a-number", "1760000000.5", "0x68"} {
		if TimestampFresh(raw, now) {
			t.Errorf("%q was accepted as a timestamp", raw)
		}
	}
}

// A malformed header is refused rather than partially parsed.
func TestAMalformedSignatureHeaderIsRefused(t *testing.T) {
	for _, raw := range []string{
		"", "garbage", "keyid=k1", "v1=abc123",
		"keyid=,v1=abc", "keyid=k1,v1=",
	} {
		if _, _, ok := ParseSignatureHeader(raw); ok {
			t.Errorf("%q parsed as a valid signature header", raw)
		}
	}
	keyID, mac, ok := ParseSignatureHeader("keyid=k1,v1=deadbeef")
	if !ok || keyID != "k1" || mac != "deadbeef" {
		t.Fatalf("well-formed header parsed as %q/%q ok=%v", keyID, mac, ok)
	}
}

// The batch cap is the PRD's 500.
func TestTheBatchCapIsFiveHundred(t *testing.T) {
	if MaxBatchConversions != 500 {
		t.Fatalf("MaxBatchConversions = %d, want 500", MaxBatchConversions)
	}
}

// Errors must not distinguish an unknown key from a bad MAC.
//
// Two different messages let an attacker enumerate valid key ids without ever
// holding a secret: they learn which half of the credential they guessed right.
func TestUnknownKeyAndBadMACShareOneError(t *testing.T) {
	if !strings.Contains(ErrUnsignedRequest.Error(), "signature invalid") {
		t.Fatalf("unexpected error text: %v", ErrUnsignedRequest)
	}
	// Stale is deliberately distinct: a customer with a skewed clock needs to be
	// told that, and it reveals nothing about the secret.
	if ErrStaleSignature.Error() == ErrUnsignedRequest.Error() {
		t.Error("a stale timestamp is indistinguishable from a bad signature, so a " +
			"customer with a clock problem cannot be told what is wrong")
	}
}
