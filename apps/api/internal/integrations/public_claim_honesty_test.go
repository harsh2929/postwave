// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"strings"
	"testing"
)

// A connector must never claim more than its runtime status.
//
// `publicClaim` is a ~70-arm switch keyed on slug, hand-maintained, and its
// output is what the catalog UI and the comparison pages show a prospect. The
// existing tests assert the CONTENT of a handful of named connectors' claims —
// that Google Ads mentions "add/remove delivery", and so on — which pins those
// strings and says nothing about the other six hundred entries or about any
// connector added tomorrow.
//
// The invariant that actually matters is the one nobody stated: the language
// reserved for a fully-available connector must appear ONLY on a fully
// available connector. A `partial` entry that reads as verified is not a
// cosmetic slip — it is the product telling someone an integration is finished
// while its own catalog says the runtime is not.

// The phrases `publicClaim` uses to describe a COMPLETE connector. A
// non-available connector carrying any of these is overclaiming.
var fullAvailabilityPhrases = []string{
	"verified auth, sync, monitoring, and lifecycle coverage",
}

// Phrases that are an overclaim on a non-available connector NO MATTER what
// else the sentence says.
//
// The list above is one exact sentence, and an adversarial review measured what
// that actually caught: ZERO of 604 non-available connectors. It detects a
// copy-pasted `available` arm and nothing else. It also showed the qualifier
// check below could be satisfied by an unrelated clause — a claim reading
// "Fully supported and production ready… certified and verified end to end"
// passed because the words "require live" appeared later in a sentence about an
// upsell.
//
// These are unconditional. Unlike "runtime complete" — which is legitimate on a
// `partial` connector, where it means the LOCAL runtime is finished and the
// same sentence says live certification is still required — none of these can
// be true of something the catalog calls incomplete.
var unconditionalOverclaims = UnconditionalOverclaims

func TestOnlyAnAvailableConnectorMakesAFullAvailabilityClaim(t *testing.T) {
	for _, item := range CatalogItems() {
		if item.RuntimeStatus == RuntimeAvailable {
			continue
		}
		claim := ContractFor(item).PublicClaim
		for _, phrase := range fullAvailabilityPhrases {
			if strings.Contains(claim, phrase) {
				t.Errorf(
					"%s is %q but its public claim carries the full-availability "+
						"phrase %q. The catalog says the runtime is not complete "+
						"while the sentence a prospect reads says it is.\n  claim: %s",
					item.Slug, item.RuntimeStatus, phrase, claim,
				)
			}
		}
		lower := strings.ToLower(claim)
		for _, phrase := range unconditionalOverclaims {
			if strings.Contains(lower, phrase) {
				t.Errorf(
					"%s is %q but its public claim says %q, which cannot be true of "+
						"something the catalog calls incomplete — and no qualifier "+
						"elsewhere in the sentence redeems it.\n  claim: %s",
					item.Slug, item.RuntimeStatus, phrase, claim,
				)
			}
		}
	}
}

// A `partial` connector must SAY it is partial.
//
// The generic fallthrough does ("full API verification and runtime coverage are
// still in progress"), and each hand-written arm carries its own qualifier
// ("public full-availability claims require live … certification evidence").
// Nothing enforced that a NEW arm keeps doing so — and the switch is long
// enough that adding one by copying the `available` arm is the obvious mistake.
func TestEveryPartialConnectorQualifiesItsClaim(t *testing.T) {
	// Any one of these makes the incompleteness legible to a reader. Deliberately
	// a set rather than one phrase: the hand-written arms word it differently by
	// connector, and forcing a single sentence would push authors toward a
	// boilerplate line that says less than what they wrote.
	qualifiers := []string{
		"still in progress",
		"require live",
		"certification evidence",
		"before treating it as fully built out",
		"not yet",
	}
	for _, item := range CatalogItems() {
		if item.RuntimeStatus != RuntimePartial {
			continue
		}
		claim := ContractFor(item).PublicClaim
		qualified := false
		for _, q := range qualifiers {
			if strings.Contains(claim, q) {
				qualified = true
				break
			}
		}
		if !qualified {
			t.Errorf(
				"%s is \"partial\" but its public claim states no limit, so it "+
					"reads as finished:\n  %s",
				item.Slug, claim,
			)
		}
	}
}

// A `planned` connector must not describe a runtime at all.
//
// It has none. A claim that describes syncing or monitoring for something not
// built is the strongest form of this failure.
func TestAPlannedConnectorDescribesNoRuntime(t *testing.T) {
	forbidden := []string{"sync", "monitoring", "lifecycle coverage", "retry"}
	for _, item := range CatalogItems() {
		if item.RuntimeStatus != RuntimePlanned {
			continue
		}
		claim := strings.ToLower(ContractFor(item).PublicClaim)
		for _, word := range forbidden {
			if strings.Contains(claim, word) {
				t.Errorf("%s is \"planned\" but its claim describes %q runtime: %s",
					item.Slug, word, claim)
			}
		}
	}
}

// The invariant above is only worth anything if the phrase it looks for is
// still the one an available connector actually uses.
//
// Without this, renaming the sentence in `publicClaim` would leave
// `fullAvailabilityPhrases` matching nothing — every test above would pass
// vacuously, forever, and nothing would say so.
func TestTheFullAvailabilityPhraseIsStillInUse(t *testing.T) {
	for _, phrase := range fullAvailabilityPhrases {
		found := false
		for _, item := range CatalogItems() {
			if item.RuntimeStatus != RuntimeAvailable {
				continue
			}
			if strings.Contains(ContractFor(item).PublicClaim, phrase) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf(
				"no available connector uses the phrase %q any more, so the "+
					"overclaim checks match nothing and pass for the wrong reason",
				phrase,
			)
		}
	}
}
