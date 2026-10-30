// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import "strings"

// What a connector may not claim about itself.
//
// This list lived in `public_claim_honesty_test.go` and was therefore reachable
// only by tests. That was fine while the only text at risk was our own —
// `publicClaim` is a hand-written switch, and a test is the right place to
// police what we wrote. It stopped being fine the moment the catalog started
// serving text we did NOT write: `partnerSummary` returns a partner's own
// sentence verbatim, under our catalog, as a Moosewave integration listing. No
// test can police that, because the string does not exist until a partner types
// it into their listing at runtime.
//
// So the rule moves into the package and gets two callers: the guard that
// checks the built-in catalog at build time, and the sanitiser that checks
// partner text at serve time. One definition — a second copy would drift, and
// the copy that drifted would be the one facing the text we control least.

// UnconditionalOverclaims are phrases that cannot be true of a connector whose
// runtime the catalog itself calls incomplete, no matter what else the sentence
// says.
//
// Unconditional is the operative word. An earlier version required only that
// SOME qualifier appear somewhere in the string, and an adversarial review
// walked straight through it: "Fully supported and production ready… certified
// and verified end to end" passed, because the words "require live" turned up
// later in an unrelated clause about an upsell.
//
// Deliberately absent: "runtime complete" and "complete". They appear on 27
// partial connectors in sentences like "Local runtime-complete … live
// certification remains before full availability", which is precise and honest —
// the LOCAL runtime is finished and the sentence says what is not. Banning the
// word would flag 27 truthful strings, and a guard that cries wolf on honest
// text is a guard someone turns off.
var UnconditionalOverclaims = []string{
	"fully supported",
	"production ready",
	"production-ready",
	"verified end to end",
	"verified end-to-end",
	"nothing is pending",
	"fully available",
	"generally available",
}

// FindOverclaim returns the first unconditional overclaim in text, or "".
//
// Case-insensitive: a partner writing "Production Ready" is making the same
// claim as one writing "production ready", and a check that missed it would be
// trivially defeated by the shift key.
func FindOverclaim(text string) string {
	lower := strings.ToLower(text)
	for _, phrase := range UnconditionalOverclaims {
		if strings.Contains(lower, phrase) {
			return phrase
		}
	}
	return ""
}

// ClaimIsHonest reports whether text is safe to publish for a connector at the
// given runtime status.
//
// An `available` connector may say any of it — that is what available means.
// Everything else, including `delegated`, may not: a delegated connector is one
// Moosewave routes to rather than runs, so "production ready" is a claim about
// somebody else's software that we are in no position to make.
func ClaimIsHonest(status RuntimeStatus, text string) bool {
	if status == RuntimeAvailable {
		return true
	}
	return FindOverclaim(text) == ""
}
