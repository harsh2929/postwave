// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"strings"
	"testing"
)

// Reaching the rule through the internal helper proves the rule; this proves it
// is CONNECTED. Input.DeclaredSendSurface would otherwise be a field nobody
// reads — the "scaffolding exceeds wiring" failure this codebase keeps meeting.
func TestDeclaredSurfaceReachesTheEngineThroughAnalyze(t *testing.T) {
	promotionMarkup := `{"@context":"https://schema.org","@type":"DiscountOffer"}`

	transactional := analysisFixture(t, promotionMarkup, "transactional")
	if !hasFinding(transactional, "STRUCTURED_DATA_TYPE_UNSUPPORTED") {
		t.Fatalf("declaring a transactional send did not reach the structured check; findings=%v",
			surfaceFindingCodes(transactional))
	}

	promotions := analysisFixture(t, promotionMarkup, "promotions")
	if hasFinding(promotions, "STRUCTURED_DATA_TYPE_UNSUPPORTED") {
		t.Fatalf("a Promotions annotation on a declared Promotions send was rejected; findings=%v",
			surfaceFindingCodes(promotions))
	}

	undeclared := analysisFixture(t, promotionMarkup, "")
	if hasFinding(undeclared, "STRUCTURED_DATA_TYPE_UNSUPPORTED") {
		t.Fatalf("no declaration should fall back to the union, not reject; findings=%v",
			surfaceFindingCodes(undeclared))
	}
}

func analysisFixture(t *testing.T, structuredData, surface string) []Finding {
	t.Helper()
	analysis := &analysis{
		input:       Input{DeclaredSendSurface: surface},
		deduplicate: map[string]struct{}{},
	}
	analysis.input.Compilation.StructuredData = []byte(structuredData)
	analyzeStructuredScripts(analysis, &htmlAnalysis{
		jsonLDScripts: []string{structuredData},
	})
	return analysis.findings
}

func hasFinding(findings []Finding, code string) bool {
	for _, finding := range findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}

func surfaceFindingCodes(findings []Finding) string {
	codes := make([]string, 0, len(findings))
	for _, finding := range findings {
		codes = append(codes, finding.Code)
	}
	return strings.Join(codes, ",")
}
