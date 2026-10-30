// SPDX-License-Identifier: AGPL-3.0-only
//
// repo_test.go — exercises the parts of repo.go that don't need a live
// DB: the per-row HMAC signing (the receipt's tamper-evidence). The pgx
// paths are covered by integration tests against a real DB elsewhere.
package activation_firewall

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/consent"
)

func TestPurposeBatchAdapterNilFailsClosedWithCompleteDenials(t *testing.T) {
	var adapter *PurposeBatchAdapter
	out, err := adapter.AllowedBatch(context.Background(), tid,
		[]string{"One@Example.com", "missing@example.com"},
		string(consent.PurposeEmailMarketing))
	if err == nil {
		t.Fatal("nil adapter returned no availability error")
	}
	for _, email := range []string{"one@example.com", "missing@example.com"} {
		if allowed, exists := out[email]; !exists || allowed {
			t.Fatalf("out[%s] = %v exists=%v; want explicit denial", email, allowed, exists)
		}
	}
}

func TestSignReceiptRow_DeterministicAndKeyed(t *testing.T) {
	at := time.Unix(1_700_000_000, 0).UTC()
	rec := ExclusionRecord{
		SubscriberEmail: "b@x.com",
		RuleClass:       RuleClassConsent,
		RuleReason:      "consent_targeted_ads_at null",
		Purpose:         "targeted_ads",
		DestinationType: "meta",
	}
	sig1 := SignReceiptRow("k1", tid, "run-1", rec, at)
	sig2 := SignReceiptRow("k1", tid, "run-1", rec, at)
	if sig1 == "" || sig1 != sig2 {
		t.Fatalf("signing must be deterministic for the same inputs, got %q vs %q", sig1, sig2)
	}

	// A different key must change the signature.
	if other := SignReceiptRow("k2", tid, "run-1", rec, at); other == sig1 {
		t.Fatal("different key must produce a different signature")
	}
	// A different field must change the signature (tamper-evidence).
	rec2 := rec
	rec2.RuleClass = RuleClassPolicy
	if tampered := SignReceiptRow("k1", tid, "run-1", rec2, at); tampered == sig1 {
		t.Fatal("changing rule_class must change the signature")
	}
}

func TestSignReceiptRow_EmptyKeyEmptySignature(t *testing.T) {
	if got := SignReceiptRow("", tid, "run-1", ExclusionRecord{SubscriberEmail: "a@x.com"}, time.Now()); got != "" {
		t.Fatalf("empty key must yield empty signature, got %q", got)
	}
}

func TestSignReceiptRow_MatchesHMACContract(t *testing.T) {
	// Pin the exact canonical-field concatenation so a downstream verifier
	// (or the integrator) can reproduce it independently.
	at := time.Unix(1_700_000_000, 0).UTC()
	rec := ExclusionRecord{
		SubscriberEmail: "b@x.com",
		RuleClass:       RuleClassSuppression,
		RuleReason:      "hard_bounce",
		Purpose:         "profiling",
		DestinationType: "warehouse",
	}
	want := func() string {
		material := strings.Join([]string{
			tid, "run-9", rec.SubscriberEmail, rec.RuleClass, rec.RuleReason,
			rec.Purpose, rec.DestinationType, strconv.FormatInt(at.Unix(), 10),
		}, ".")
		mac := hmac.New(sha256.New, []byte("secret"))
		mac.Write([]byte(material))
		return hex.EncodeToString(mac.Sum(nil))
	}()
	if got := SignReceiptRow("secret", tid, "run-9", rec, at); got != want {
		t.Fatalf("signature contract drift:\n got  %s\n want %s", got, want)
	}
}
