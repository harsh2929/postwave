// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"strings"
	"testing"
)

// The honesty rule, applied to the text people actually see.
//
// `TestOnlyAnAvailableConnectorMakesAFullAvailabilityClaim` checks
// `PublicClaim`, which renders in ONE desktop panel. The catalog tiles and both
// web comparison pages render `Summary` — a different string, on far more
// surfaces, that nothing checked.
//
// It flags nothing today. That is the point: it is a ratchet against the next
// sentence, not a cleanup of the current ones, and a guard added while its
// subject is clean is the only kind whose first failure is a real finding.

func TestNoIncompleteConnectorSummaryOverclaims(t *testing.T) {
	checked := 0
	for _, item := range CatalogItems() {
		if item.RuntimeStatus == RuntimeAvailable {
			continue
		}
		checked++
		if phrase := FindOverclaim(item.Summary); phrase != "" {
			t.Errorf(
				"%s is %q but its catalog summary says %q. This string renders on "+
					"the catalog tiles and both comparison pages, where a prospect "+
					"reads it as a statement about a finished integration.\n  summary: %s",
				item.Slug, item.RuntimeStatus, phrase, item.Summary,
			)
		}
	}
	// Vacuity floor. If CatalogItems ever returns nothing — a build tag, a
	// refactor, a moved registry — every assertion above passes trivially and
	// this reports success having examined zero strings.
	if checked < 100 {
		t.Fatalf("only %d non-available connectors examined; the catalog cannot be "+
			"that small, so this test is measuring nothing", checked)
	}
}

// The phrases that are legitimate on an incomplete connector must STAY
// legitimate.
//
// "Local runtime-complete … live certification remains before full
// availability" is precise: the local runtime IS finished and the sentence says
// what is not. 27 partial connectors are worded that way. A future tightening
// that bans the word "complete" would flag all 27 truthful strings, and a guard
// that cries wolf on honest text is one somebody switches off — taking the real
// protection with it.
func TestQualifiedCompletenessLanguageIsNotTreatedAsAnOverclaim(t *testing.T) {
	honest := []string{
		"Local runtime-complete Google Data Manager slice; live certification remains before full availability.",
		"Local-runtime-complete/live-certification-pending Snowflake export.",
		"Capture Squarespace form submissions through webhooks until public native form APIs are verified.",
	}
	for _, text := range honest {
		if phrase := FindOverclaim(text); phrase != "" {
			t.Errorf("flagged %q in an honest, qualified sentence:\n  %s", phrase, text)
		}
	}

	// And the ones that must never pass, including the exact escape an
	// adversarial review used against the previous qualifier-based check.
	dishonest := []string{
		"Fully supported and production ready; certified and verified end to end, though some flows require live setup.",
		"This connector is Production Ready.",
		"Generally available for all tenants.",
		"Nothing is pending on this integration.",
	}
	for _, text := range dishonest {
		if FindOverclaim(text) == "" {
			t.Errorf("did not flag an unconditional overclaim:\n  %s", text)
		}
	}
}

// Partner-authored text is served under our catalog and must clear the same
// bar. It is the text we control least and, until now, the only text nothing
// checked at all — `partnerSummary` returned the partner's sentence verbatim.
func TestAPartnerCannotPublishAnOverclaimThroughTheirListing(t *testing.T) {
	cases := []struct {
		name    string
		in      partnerCatalogInput
		wantOut string
	}{
		{
			name: "an overclaiming summary is replaced, not published",
			in: partnerCatalogInput{
				Name:    "Acme Sync",
				Summary: "Fully supported and production ready two-way sync.",
			},
			wantOut: "Partner marketplace integration for Acme Sync.",
		},
		{
			name: "casing does not defeat the check",
			in: partnerCatalogInput{
				Name:    "Acme Sync",
				Summary: "Production Ready two-way sync.",
			},
			wantOut: "Partner marketplace integration for Acme Sync.",
		},
		{
			name: "an honest summary is published unchanged",
			in: partnerCatalogInput{
				Name:    "Acme Sync",
				Summary: "Two-way contact sync via the Acme partner API.",
			},
			wantOut: "Two-way contact sync via the Acme partner API.",
		},
		{
			name: "an overclaiming summary falls through to an honest description",
			in: partnerCatalogInput{
				Name:        "Acme Sync",
				Summary:     "Generally available for every plan.",
				Description: "Syncs Acme contacts on a schedule.",
			},
			wantOut: "Syncs Acme contacts on a schedule.",
		},
		{
			name: "both overclaiming falls all the way through to neutral",
			in: partnerCatalogInput{
				Name:        "Acme Sync",
				Summary:     "Generally available.",
				Description: "Fully supported.",
			},
			wantOut: "Partner marketplace integration for Acme Sync.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := partnerSummary(tc.in)
			if got != tc.wantOut {
				t.Fatalf("partnerSummary = %q, want %q", got, tc.wantOut)
			}
			if FindOverclaim(got) != "" {
				t.Fatalf("published summary still overclaims: %q", got)
			}
		})
	}
}

// The listing must survive its own bad wording. Rejecting it would hide a real
// integration and punish the customer for the partner's marketing copy.
func TestAnOverclaimingPartnerListingIsStillListed(t *testing.T) {
	item, ok := catalogItemFromPartnerListing(partnerCatalogInput{
		Name:                 "Acme Sync",
		Slug:                 "acme-sync",
		AppStatus:            "approved",
		PartnerProfileStatus: "certified",
		Distribution:         "marketplace",
		Summary:              "Fully supported and production ready.",
	})
	if !ok {
		t.Fatal("the listing was dropped; a wording problem must not remove a " +
			"working integration from the catalog")
	}
	if strings.Contains(strings.ToLower(item.Summary), "production ready") {
		t.Fatalf("the overclaim was published anyway: %q", item.Summary)
	}
	if item.RuntimeStatus != RuntimeDelegated {
		t.Fatalf("runtime status = %q, want delegated", item.RuntimeStatus)
	}
}
