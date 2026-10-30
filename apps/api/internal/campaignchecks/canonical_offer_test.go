// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import "testing"

func codesIn(report Report) map[string]int {
	out := map[string]int{}
	for _, finding := range report.Findings {
		out[finding.Code]++
	}
	return out
}

// A message naming a canonical offer that does not exist must BLOCK.
//
// An agent asked about this offer resolves nothing, so the message makes a
// promise the product cannot answer for. That is different from the two records
// merely disagreeing, and the two are separate codes because they have separate
// fixes — a single code would make a sender guess which they had.
func TestAMissingCanonicalOfferBlocksTheSend(t *testing.T) {
	input := legacyCheckInput(t, "<p>Spring sale</p>", "Spring sale")
	input.CanonicalOffers = []CanonicalOfferBinding{{
		NodeID: "blk_offer", CanonicalOfferID: "off_deleted", Missing: true,
	}}

	report := Analyze(input)
	codes := codesIn(report)
	if codes["OFFER_CANONICAL_MISSING"] == 0 {
		t.Fatalf("a message naming a deleted offer produced no finding: %v", codes)
	}
	blocking := false
	for _, finding := range report.Findings {
		if finding.Code == "OFFER_CANONICAL_MISSING" && finding.Blocking {
			blocking = true
		}
	}
	if !blocking {
		t.Fatal("a message naming an entity that does not exist did not block the send")
	}
}

// A disagreement must be REPORTED but must not block.
//
// The two records diverging is often legitimate and transient — an entity edited
// after the draft was written, an offer since sold out — so blocking would stop
// a correct message going out because a field moved. What matters is that the
// sender is told, because otherwise the recipient and an agent are given
// different answers and neither knows.
func TestACanonicalDisagreementIsReportedWithoutBlocking(t *testing.T) {
	input := legacyCheckInput(t, "<p>Spring sale</p>", "Spring sale")
	input.CanonicalOffers = []CanonicalOfferBinding{{
		NodeID: "blk_offer", CanonicalOfferID: "off_live",
		Disagreements: []CanonicalOfferDisagreement{{
			Field: "inventory_state", InMessage: "in_stock", Canonical: "sold_out",
			Detail: "the entity reports the offer is sold out",
		}},
	}}

	report := Analyze(input)
	found := false
	for _, finding := range report.Findings {
		if finding.Code != "OFFER_CANONICAL_DISAGREEMENT" {
			continue
		}
		found = true
		if finding.Blocking {
			t.Fatal("a transient disagreement blocked the send")
		}
	}
	if !found {
		t.Fatalf("a disagreement produced no finding: %v", codesIn(report))
	}
}

// An UNRESOLVED bridge must not read as agreement.
//
// Nil means nobody performed the read. Reporting nothing for it is correct;
// reporting it as "checked, no problems" would be a claim about an entity the
// system never looked at — the same tri-state rule the summary-stability check
// follows.
func TestAnUnresolvedBridgeProducesNoOfferFindings(t *testing.T) {
	input := legacyCheckInput(t, "<p>Spring sale</p>", "Spring sale")
	input.CanonicalOffers = nil

	codes := codesIn(Analyze(input))
	if codes["OFFER_CANONICAL_MISSING"] != 0 || codes["OFFER_CANONICAL_DISAGREEMENT"] != 0 {
		t.Fatalf("an unresolved bridge produced offer findings: %v", codes)
	}

	// Guard the guard: with a binding present the rule DOES fire, so the silence
	// above is the nil case and not a rule that never runs.
	input.CanonicalOffers = []CanonicalOfferBinding{{
		NodeID: "blk_offer", CanonicalOfferID: "off_deleted", Missing: true,
	}}
	if codesIn(Analyze(input))["OFFER_CANONICAL_MISSING"] == 0 {
		t.Fatal("the rule never fires at all, so the nil assertion above is vacuous")
	}
}
