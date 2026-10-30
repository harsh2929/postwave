// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import "testing"

func outcomes() []CaseOutcome {
	return []CaseOutcome{
		// Two cases assert HIDDEN_PROMPT_MANIPULATION must not fire; it fires on
		// one of them, which is a false positive.
		{CaseID: "a", ForbiddenCodes: []string{"HIDDEN_PROMPT_MANIPULATION"}, FiredCodes: nil},
		{CaseID: "b", ForbiddenCodes: []string{"HIDDEN_PROMPT_MANIPULATION"},
			FiredCodes: []string{"HIDDEN_PROMPT_MANIPULATION"}},
		// A case that REQUIRES the code is not a negative for it and must not
		// enter the denominator — counting true positives as trials would
		// understate the rate.
		{CaseID: "c", FiredCodes: []string{"HIDDEN_PROMPT_MANIPULATION"}},
		// A different code entirely.
		{CaseID: "d", ForbiddenCodes: []string{"MIME_PART_CONTENT_MISMATCH"}, FiredCodes: nil},
	}
}

func TestFalsePositiveSamplesCountOnlyForbiddenCases(t *testing.T) {
	samples := FalsePositiveSamples("corpus-x", "v1", outcomes())

	hidden, ok := samples["HIDDEN_PROMPT_MANIPULATION"]
	if !ok {
		t.Fatal("no sample for a code with forbidden cases")
	}
	if hidden.Negatives != 2 {
		t.Fatalf("negatives = %d, want 2 (only the cases that forbid the code)", hidden.Negatives)
	}
	if hidden.FalsePositives != 1 {
		t.Fatalf("false positives = %d, want 1", hidden.FalsePositives)
	}

	mime := samples["MIME_PART_CONTENT_MISMATCH"]
	if mime.Negatives != 1 || mime.FalsePositives != 0 {
		t.Fatalf("unexpected sample for a clean code: %+v", mime)
	}
}

// A code nobody asserts anything about has no measurement, and inventing an
// empty sample for it would let a caller report a 0% rate for a check that was
// never exercised.
func TestCodesWithNoForbiddenCasesGetNoSample(t *testing.T) {
	samples := FalsePositiveSamples("corpus-x", "v1", outcomes())
	if _, present := samples["SUMMARY_UNSTABLE"]; present {
		t.Fatal("a code with no forbidden cases was given a sample")
	}
}

// The sample must carry the corpus identity through, or the rate it produces
// cannot satisfy §16.3's requirement to name the corpus it was measured over.
func TestSamplesCarryTheCorpusIdentityAndComposition(t *testing.T) {
	samples := FalsePositiveSamples("corpus-x", "v1", outcomes())
	sample := samples["HIDDEN_PROMPT_MANIPULATION"]
	if sample.Corpus.Name != "corpus-x" || sample.Corpus.Version != "v1" {
		t.Fatalf("corpus identity lost: %+v", sample.Corpus)
	}
	if sample.Corpus.Composition["negative_cases"] != 2 {
		t.Fatalf("composition does not describe the sample: %+v", sample.Corpus.Composition)
	}
	// And the sample must actually be usable — a Rate() that errors here would
	// mean the bridge produces samples the harness rejects.
	if _, err := sample.Rate(); err != nil {
		t.Fatalf("bridge produced a sample the harness refuses: %v", err)
	}
}

// The honest headline result: the corpus is too small to support a 1% target,
// whatever the detectors do on it.
//
// Note what this does NOT measure. FiredCodes is empty here, so the numerator
// is unmeasured rather than measured-as-zero — populating it means running the
// analyzer over each case, which needs compiled artifacts this loader does not
// build. That is deliberate: the assertion below is about the DENOMINATOR, and
// it holds regardless of how many false positives a real run finds, because a
// sample this small cannot support the claim even at zero. Reporting "0% false
// positives" from this data would be the exact overclaim the harness exists to
// prevent.
func TestTheEmbeddedCorpusCannotYetSupportAOnePercentClaim(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatalf("load embedded corpus: %v", err)
	}
	var built []CaseOutcome
	for _, loaded := range corpus.Cases {
		built = append(built, CaseOutcome{
			CaseID:         loaded.Definition.ID,
			ForbiddenCodes: loaded.Definition.Findings.ForbiddenCodes,
		})
	}
	samples := FalsePositiveSamples(corpus.Manifest.CorpusVersion, corpus.Manifest.CorpusVersion, built)
	if len(samples) == 0 {
		t.Fatal("embedded corpus has no forbidden-code negatives, so it cannot support a false-positive claim")
	}
	for code, sample := range samples {
		rate, err := sample.Rate()
		if err != nil {
			t.Fatalf("%s: %v", code, err)
		}
		if rate.MeetsTarget(0.01) {
			t.Fatalf("%s: a corpus of %d negatives was accepted as proving <1%%; "+
				"upper bound %v", code, sample.Negatives, rate.UpperBound)
		}
	}
}
