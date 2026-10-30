// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import (
	"strings"
	"testing"
)

// Turns the corpus labels into an actual measurement: run the detectors over
// every case and record what fired, so FalsePositiveSamples has a real
// numerator instead of an assumed-empty one.
func TestAnalyzerRunProducesRealFiredCodes(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	outcomes, skipped := RunDetectors(corpus)
	if len(outcomes) == 0 {
		t.Fatal("no case produced an outcome")
	}
	// Non-vacuity: if nothing fired anywhere, an empty numerator would look
	// like a perfect result rather than a broken runner.
	fired := 0
	for _, outcome := range outcomes {
		fired += len(outcome.FiredCodes)
	}
	if fired == 0 {
		t.Fatal("the detector run produced no findings at all, so a zero " +
			"false-positive count would prove nothing")
	}
	t.Logf("ran %d cases (%d skipped as non-multipart), %d findings total",
		len(outcomes), skipped, fired)
}

// The corpus's positive labels are the control: a case that REQUIRES a code
// must actually produce it, or the runner is not exercising the detector the
// negatives are being measured against.
func TestAnalyzerRunReproducesTheCorpusRequiredCodes(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	outcomes, _ := RunDetectors(corpus)
	byID := map[string]CaseOutcome{}
	for _, outcome := range outcomes {
		byID[outcome.CaseID] = outcome
	}
	checked := 0
	for _, loaded := range corpus.Cases {
		required := loaded.Definition.Findings.RequiredCodes
		if len(required) == 0 {
			continue
		}
		outcome, ran := byID[loaded.Definition.ID]
		if !ran {
			continue
		}
		for _, code := range required {
			// Only content-dimension codes are reachable from a synthetic
			// compilation; artifact/receipt codes need a real compiler run.
			if !contentDimensionCode(code) {
				continue
			}
			checked++
			if !containsCode(outcome.FiredCodes, code) {
				t.Errorf("case %s requires %s but the run did not produce it (%s)",
					loaded.Definition.ID, code, strings.Join(outcome.FiredCodes, ","))
			}
		}
	}
	if checked == 0 {
		t.Fatal("no required content code was checked, so this control proves nothing")
	}
}

// The measurement that matters: with a real numerator, no forbidden code may
// fire on the case that forbids it.
func TestNoForbiddenContentCodeFiresOnItsCase(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	outcomes, _ := RunDetectors(corpus)
	samples := FalsePositiveSamples(corpus.Manifest.CorpusVersion,
		corpus.Manifest.CorpusVersion, outcomes)
	for code, sample := range samples {
		if !contentDimensionCode(code) {
			continue
		}
		if sample.FalsePositives != 0 {
			t.Errorf("%s fired on %d of %d cases that forbid it",
				code, sample.FalsePositives, sample.Negatives)
		}
	}
}

// Structured-data checks were unreachable while the synthesised compilation
// carried no structured projection: the run reported UNDECLARED_STRUCTURED_DATA
// and never got as far as validating the payload. Extracting the fixture's OWN
// ld+json bytes makes the dimension measurable without inventing anything.
func TestStructuredDataCodesAreReachable(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	outcomes, _ := RunDetectors(corpus)
	byID := map[string]CaseOutcome{}
	for _, outcome := range outcomes {
		byID[outcome.CaseID] = outcome
	}
	invalid, ran := byID["jsonld_invalid"]
	if !ran {
		t.Fatal("the jsonld_invalid fixture did not run")
	}
	if !containsCode(invalid.FiredCodes, "STRUCTURED_DATA_INVALID") {
		t.Fatalf("a fixture whose JSON-LD is invalid did not produce "+
			"STRUCTURED_DATA_INVALID: %v", invalid.FiredCodes)
	}
	// The projection must be the fixture's exact embedded bytes, or the parity
	// check fires on a difference this harness introduced rather than one the
	// message contains.
	if containsCode(invalid.FiredCodes, "STRUCTURED_DATA_EMBEDDING_MISMATCH") {
		t.Fatal("the synthesised projection does not match the embedded script, " +
			"so the harness is manufacturing a parity failure")
	}
}

// A message with no ld+json must still report the undeclared case correctly —
// extraction must not paper over a real finding by inventing an empty payload.
func TestMessagesWithoutStructuredDataAreUnaffected(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	outcomes, _ := RunDetectors(corpus)
	for _, outcome := range outcomes {
		if outcome.CaseID != "valid_multipart" {
			continue
		}
		for _, code := range outcome.FiredCodes {
			if code == "STRUCTURED_DATA_INVALID" || code == "UNDECLARED_STRUCTURED_DATA" {
				t.Fatalf("a message with no structured data produced %s", code)
			}
		}
		return
	}
	t.Fatal("the valid_multipart fixture did not run")
}
