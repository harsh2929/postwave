// SPDX-License-Identifier: AGPL-3.0-only
//
// Characterization tests for the pre-existing /email-validation/check
// contract.
//
// This endpoint predates internal/verification and is consumed by the
// desktop client's bulk ValidationResultsModal, so its response shape
// and verdict semantics are a wire contract that must not drift. These
// tests pin that contract BEFORE the corpora underneath it are
// replaced with the shared ones from internal/verification, so the
// refactor is provably behaviour-preserving rather than merely
// believed to be.
//
// Two semantics here are deliberately unusual and are pinned on purpose:
//
//   - A role account is reported Valid=true with verdict
//     "role_account". Mail genuinely can be delivered to it; the flag
//     tells the operator to decide.
//   - A disposable-corpus hit with usable MX follows the same pattern:
//     Valid=true plus an advisory flag/verdict. The static corpus is not
//     authoritative enough to reject an address.
//   - A role account still performs the MX lookup, so HasMX is
//     populated for it.

package email_validator

import (
	"context"
	"testing"
)

// validator builds a Deps whose DNS tier is deterministic.
func validator(withMX map[string]bool) *Deps {
	return &Deps{
		lookupMX: func(_ context.Context, domain string) bool {
			return withMX[domain]
		},
	}
}

func TestValidateAcceptsAPlainDeliverableAddress(t *testing.T) {
	got := validator(map[string]bool{"example.com": true}).
		Validate(context.Background(), "person@example.com")

	if !got.Valid {
		t.Fatalf("Valid = false: %+v", got)
	}
	if got.Verdict != "ok" {
		t.Fatalf("Verdict = %q, want %q", got.Verdict, "ok")
	}
	if got.Domain != "example.com" {
		t.Fatalf("Domain = %q", got.Domain)
	}
	if !got.HasMX {
		t.Fatal("HasMX = false")
	}
	if got.Disposable || got.RoleAcct {
		t.Fatalf("unexpected flags: %+v", got)
	}
}

func TestValidateLowercasesAndTrimsTheAddress(t *testing.T) {
	got := validator(map[string]bool{"example.com": true}).
		Validate(context.Background(), "  Person@Example.COM  ")
	if got.Email != "person@example.com" {
		t.Fatalf("Email = %q", got.Email)
	}
}

func TestValidateRejectsMalformedSyntax(t *testing.T) {
	for _, bad := range []string{"", "no-at-sign", "@example.com", "a@", "a@nodot", "a b@example.com"} {
		got := validator(map[string]bool{}).Validate(context.Background(), bad)
		if got.Valid {
			t.Errorf("Validate(%q).Valid = true", bad)
		}
		if got.Verdict != "syntax_invalid" {
			t.Errorf("Validate(%q).Verdict = %q, want %q", bad, got.Verdict, "syntax_invalid")
		}
	}
}

func TestValidateTreatsDisposableCorpusAsAdvisoryWhenMailRouteExists(t *testing.T) {
	got := validator(map[string]bool{"mailinator.com": true}).
		Validate(context.Background(), "throwaway@mailinator.com")

	if !got.Valid {
		t.Fatalf("advisory corpus hit became terminal: %+v", got)
	}
	if got.Verdict != "disposable" {
		t.Fatalf("Verdict = %q, want %q", got.Verdict, "disposable")
	}
	if !got.Disposable {
		t.Fatal("Disposable = false")
	}
	if !got.HasMX {
		t.Fatal("HasMX = false; advisory corpus hit skipped structural validation")
	}
	if len(got.Reasons) == 0 {
		t.Fatal("advisory corpus hit has no explanation")
	}
}

func TestValidateCannotTerminallyRejectDubiousLegacyCorpusEntries(t *testing.T) {
	for _, domain := range []string{"mail.by", "yeah.net", "hotpop.com", "neomailbox.com", "inbox.si"} {
		t.Run(domain, func(t *testing.T) {
			got := validator(map[string]bool{domain: true}).
				Validate(context.Background(), "person@"+domain)
			if !got.Valid || !got.HasMX || !got.Disposable || got.Verdict != "disposable" {
				t.Fatalf("legacy corpus hit = %+v, want routable advisory result", got)
			}
		})
	}
}

func TestValidateTreatsRoleAccountsAsDeliverableButFlagged(t *testing.T) {
	// Pinned deliberately: this endpoint reports role accounts as
	// VALID with a flag, leaving the decision to the operator.
	got := validator(map[string]bool{"example.com": true}).
		Validate(context.Background(), "support@example.com")

	if !got.Valid {
		t.Fatalf("Valid = false; this contract reports role accounts as deliverable: %+v", got)
	}
	if got.Verdict != "role_account" {
		t.Fatalf("Verdict = %q, want %q", got.Verdict, "role_account")
	}
	if !got.RoleAcct {
		t.Fatal("RoleAcct = false")
	}
	if !got.HasMX {
		t.Fatal("HasMX = false; role accounts still resolve MX in this contract")
	}
	if len(got.Reasons) == 0 {
		t.Fatal("a flagged role account must carry a reason")
	}
}

func TestValidateRejectsDomainsWithoutMX(t *testing.T) {
	got := validator(map[string]bool{}).Validate(context.Background(), "person@nowhere.example")

	if got.Valid {
		t.Fatal("Valid = true for a domain with no MX")
	}
	if got.Verdict != "no_mx" {
		t.Fatalf("Verdict = %q, want %q", got.Verdict, "no_mx")
	}
	if got.HasMX {
		t.Fatal("HasMX = true")
	}
}

func TestValidateAlwaysReturnsANonNilReasonsSlice(t *testing.T) {
	// The desktop client renders Reasons directly; a null would
	// surface as a crash rather than an empty list.
	got := validator(map[string]bool{"example.com": true}).
		Validate(context.Background(), "person@example.com")
	if got.Reasons == nil {
		t.Fatal("Reasons = nil, want an empty slice")
	}
}

func TestValidateChecksDisposableBeforeRole(t *testing.T) {
	// info@mailinator.com is both. Keep the more specific display verdict while
	// both advisory flags survive and usable MX remains valid.
	got := validator(map[string]bool{"mailinator.com": true}).
		Validate(context.Background(), "info@mailinator.com")
	if got.Verdict != "disposable" {
		t.Fatalf("Verdict = %q, want %q", got.Verdict, "disposable")
	}
	if !got.Valid || !got.Disposable || !got.RoleAcct || !got.HasMX {
		t.Fatalf("combined advisory result = %+v", got)
	}
}

func TestValidateNoMailRouteOverridesDisposableAdvisory(t *testing.T) {
	got := validator(map[string]bool{}).
		Validate(context.Background(), "person@mailinator.com")
	if got.Valid || got.HasMX || !got.Disposable || got.Verdict != "no_mx" {
		t.Fatalf("no-mail structural result = %+v, want invalid no_mx with advisory flag", got)
	}
}

func TestValidateRejectsOverlongLocalPart(t *testing.T) {
	long := ""
	for i := 0; i < 65; i++ {
		long += "a"
	}
	got := validator(map[string]bool{"example.com": true}).
		Validate(context.Background(), long+"@example.com")
	if got.Verdict != "syntax_invalid" {
		t.Fatalf("Verdict = %q, want %q", got.Verdict, "syntax_invalid")
	}
}
