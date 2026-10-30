package listmonk_events

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
	"time"
)

func signListmonkTest(t *testing.T, secret string, body []byte, ts time.Time) (sigHex, tsHeader string) {
	t.Helper()
	tsHeader = strconv.FormatInt(ts.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(tsHeader))
	mac.Write([]byte("."))
	mac.Write(body)
	sigHex = hex.EncodeToString(mac.Sum(nil))
	return
}

func TestVerifyHMACBindsTimestamp(t *testing.T) {
	secret := "shhh"
	body := []byte(`{"event":"opened"}`)
	ts := time.Now().UTC()

	sig, tsHeader := signListmonkTest(t, secret, body, ts)
	if !verifyHMAC(secret, body, sig, tsHeader) {
		t.Fatal("valid signature with matching timestamp must verify")
	}

	// Same body + sig with a DIFFERENT timestamp must fail.
	other := strconv.FormatInt(ts.Add(time.Hour).Unix(), 10)
	if verifyHMAC(secret, body, sig, other) {
		t.Fatal("signature must NOT verify when the timestamp the signer used differs")
	}

	// Tampered body must fail.
	if verifyHMAC(secret, []byte(`{"event":"clicked"}`), sig, tsHeader) {
		t.Fatal("tampered body must not verify")
	}

	// Wrong secret must fail.
	if verifyHMAC("nope", body, sig, tsHeader) {
		t.Fatal("wrong secret must not verify")
	}
}

func TestVerifyHMACRejectsBadHex(t *testing.T) {
	if verifyHMAC("k", []byte("body"), "not-hex!", "1700000000") {
		t.Fatal("non-hex signature must be rejected without panicking")
	}
}

func TestReplayToleranceConstantIsReasonable(t *testing.T) {
	// Document the contract: tolerance is ≤10 minutes (Stripe-equivalent).
	// A sloppy bump here is something a security review should catch.
	if ReplayTolerance > 10*time.Minute {
		t.Fatalf("ReplayTolerance widened to %v — over 10m is dangerous", ReplayTolerance)
	}
	if ReplayTolerance < time.Minute {
		t.Fatalf("ReplayTolerance shrunk to %v — under 1m breaks legit clock skew", ReplayTolerance)
	}
}
