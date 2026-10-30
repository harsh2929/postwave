package privacy

import (
	"strings"
	"testing"
)

func TestNewVerificationTokenIsHexAndStable(t *testing.T) {
	plain, hash, err := newVerificationToken()
	if err != nil {
		t.Fatalf("newVerificationToken: %v", err)
	}
	if len(plain) != 64 {
		t.Fatalf("plain token len = %d, want 64 hex chars (32 bytes)", len(plain))
	}
	if len(hash) != 64 {
		t.Fatalf("hash len = %d, want 64", len(hash))
	}
	if plain == hash {
		t.Fatal("plain token must not equal its hash at rest")
	}
	if got := hashToken(plain); got != hash {
		t.Fatalf("hashToken(plain) mismatch: %s vs %s", got, hash)
	}
}

func TestHashTokenIsDeterministic(t *testing.T) {
	a := hashToken("ABCDEF")
	b := hashToken("ABCDEF")
	if a != b {
		t.Fatalf("hashToken not deterministic: %s vs %s", a, b)
	}
	if hashToken("abcdef") == a {
		t.Fatal("hashToken should be case-sensitive")
	}
}

func TestNormalizeVerificationMethod(t *testing.T) {
	cases := map[string]string{
		"":               "email_token",
		"EMAIL_TOKEN":    "email_token",
		"session":        "session",
		"Session":        "session",
		"admin_override": "admin_override",
		"admin":          "admin_override",
		"admin-override": "admin_override",
		"unknown":        "email_token",
	}
	for in, want := range cases {
		if got := normalizeVerificationMethod(in); got != want {
			t.Fatalf("normalizeVerificationMethod(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAllowedGenericRequestTypes(t *testing.T) {
	// These match DB enum values introduced in 0094_compliance_core.sql
	// — keep the API allowlist and DB CHECK constraint synchronized.
	for _, rt := range []string{
		"correction",
		"opt_out_sale_share",
		"opt_out_targeted_advertising",
		"limit_sensitive_data",
	} {
		if !allowedGenericRequestTypes[rt] {
			t.Fatalf("generic request type %q must be allowed", rt)
		}
	}
	// data_export / account_deletion have dedicated handlers — the
	// generic endpoint must reject them so callers don't bypass the
	// region-aware SLA selection for those two flows.
	for _, rt := range []string{"data_export", "account_deletion", "appeal", "subscriber_erasure", "evil"} {
		if allowedGenericRequestTypes[rt] {
			t.Fatalf("generic request type %q must NOT be allowed", rt)
		}
	}
}

func TestValidSubprocessorName(t *testing.T) {
	ok := []string{"stripe", "aws", "openai", "post-hog", "sentry_io", "datadog"}
	for _, name := range ok {
		if !validSubprocessorName.MatchString(name) {
			t.Fatalf("expected %q to be a valid subprocessor name", name)
		}
	}
	bad := []string{"", "A", "1stripe", "stripe.dot", "stripe;drop", "  spaces  ", strings.Repeat("a", 65)}
	for _, name := range bad {
		if validSubprocessorName.MatchString(name) {
			t.Fatalf("expected %q to be rejected as subprocessor name", name)
		}
	}
}

func TestNewRequestIDAppealPrefix(t *testing.T) {
	id, err := newRequestID("appeal")
	if err != nil {
		t.Fatalf("newRequestID: %v", err)
	}
	if !strings.HasPrefix(id, "prv_appeal_") {
		t.Fatalf("appeal id prefix wrong: %s", id)
	}
}

func TestNewRequestIDOptOutPrefixSlugifiesUnderscores(t *testing.T) {
	// newRequestID replaces _ with - in the resource-type segment so
	// the full id is dash-separated and trivially click-selectable.
	id, err := newRequestID("opt_out_sale_share")
	if err != nil {
		t.Fatalf("newRequestID: %v", err)
	}
	if !strings.HasPrefix(id, "prv_opt-out-sale-share_") {
		t.Fatalf("opt-out request id prefix wrong: %s", id)
	}
}
