// SPDX-License-Identifier: AGPL-3.0-only
package consent

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestColumnForPurpose(t *testing.T) {
	cases := map[Purpose]string{
		PurposeEmailMarketing: "consent_email_marketing_at",
		PurposeSMSMarketing:   "consent_sms_marketing_at",
		PurposeProfiling:      "consent_profiling_at",
		PurposeTargetedAds:    "consent_targeted_ads_at",
		PurposeAIProcessing:   "consent_ai_processing_at",
		Purpose("nope"):       "",
		Purpose(""):           "",
	}
	for p, want := range cases {
		if got := columnForPurpose(p); got != want {
			t.Errorf("columnForPurpose(%q): got %q want %q", p, got, want)
		}
	}
}

func TestIsConsentedForPurposeNilPool(t *testing.T) {
	// The compatibility helper reports no recorded consent without a pool.
	ok, err := IsConsentedForPurpose(context.Background(), nil, "t1", "x@y.z", PurposeAIProcessing)
	if err != nil {
		t.Fatalf("nil pool returned error: %v", err)
	}
	if ok {
		t.Fatalf("nil pool should return false (no recorded consent)")
	}
}

func TestEmailPurposeExpressionRequiresExactAddressProjection(t *testing.T) {
	expression, err := purposeEligibilityExpression(PurposeEmailMarketing)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"s.archived_at IS NULL",
		"s.consent_email_marketing_at IS NOT NULL",
		"FROM subscriber_emails AS se",
		"se.tenant_id = s.tenant_id",
		"se.subscriber_id = s.id",
		"lower(se.email::text) = lower(s.email::text)",
		"se.consent_status = 'subscribed'",
		"se.suppressed = false",
	} {
		if !strings.Contains(expression, required) {
			t.Fatalf("email eligibility missing %q: %s", required, expression)
		}
	}

	profiling, err := purposeEligibilityExpression(PurposeProfiling)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(profiling, "subscriber_emails") || profiling != "s.archived_at IS NULL AND s.consent_profiling_at IS NOT NULL" {
		t.Fatalf("non-email purpose unexpectedly changed: %s", profiling)
	}
}

func TestIsConsentedForPurposeMissingInputs(t *testing.T) {
	ok, err := IsConsentedForPurpose(context.Background(), nil, "", "x@y.z", PurposeAIProcessing)
	if err != nil || ok {
		t.Fatalf("empty tenant: ok=%v err=%v", ok, err)
	}
	ok, err = IsConsentedForPurpose(context.Background(), nil, "t1", "", PurposeAIProcessing)
	if err != nil || ok {
		t.Fatalf("empty email: ok=%v err=%v", ok, err)
	}
}

func TestPurposeLookupNilReceiverFailsClosed(t *testing.T) {
	var l *PurposeLookup
	ok, err := l.Allowed(context.Background(), "t1", "x@y.z", "email_marketing")
	if err == nil || ok {
		t.Fatalf("nil lookup should fail closed: ok=%v err=%v", ok, err)
	}
}

func TestPurposeLookupNilPoolFailsClosed(t *testing.T) {
	l := &PurposeLookup{Pool: nil}
	ok, err := l.Allowed(context.Background(), "t1", "x@y.z", "email_marketing")
	if err == nil || ok {
		t.Fatalf("nil pool should fail closed: ok=%v err=%v", ok, err)
	}
}

func TestPurposeLookupBatchNilPoolReturnsExplicitDeniedEntries(t *testing.T) {
	l := &PurposeLookup{}
	got, err := l.AllowedBatch(context.Background(),
		"11111111-1111-1111-1111-111111111111",
		[]string{"One@Example.com", "missing@example.com"},
		"email_marketing")
	if err == nil {
		t.Fatal("nil pool must return an availability error")
	}
	for _, email := range []string{"one@example.com", "missing@example.com"} {
		if allowed, exists := got[email]; !exists || allowed {
			t.Fatalf("%s = %v exists=%v; want explicit denial", email, allowed, exists)
		}
	}
}

func TestNormalizePurposeLookupBatchIsBoundedAndRejectsHostileEmail(t *testing.T) {
	got, normalized, err := normalizePurposeLookupBatch([]string{"One@Example.com", "one@example.com", "not an email"})
	if err == nil || normalized != nil {
		t.Fatalf("hostile batch accepted: normalized=%v err=%v", normalized, err)
	}
	for _, email := range []string{"one@example.com", "not an email"} {
		if allowed, exists := got[email]; !exists || allowed {
			t.Fatalf("%s = %v exists=%v; want explicit denial", email, allowed, exists)
		}
	}

	tooLarge := make([]string, purposeLookupBatchMaxEmails+1)
	if _, _, err := normalizePurposeLookupBatch(tooLarge); err == nil {
		t.Fatal("oversized purpose batch accepted")
	}
}

func TestPurposeLookupUnknownPurposeFailsClosed(t *testing.T) {
	// No query is made for an unknown purpose, so a zero-value non-nil
	// pool is sufficient to exercise the closed vocabulary check.
	l := &PurposeLookup{Pool: &db.Pool{}}
	ok, err := l.Allowed(context.Background(), "t1", "x@y.z", "nope")
	if err == nil || ok {
		t.Fatalf("unknown purpose should fail closed: ok=%v err=%v", ok, err)
	}
}
