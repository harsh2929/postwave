// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The committed report is the artifact a release decision reads. A report that
// lives only in a test log is not published, and a published report that has
// drifted from the corpus is worse than none — it states a rate nobody
// measured any more.
const reportPath = "../../../../docs/assurance/false-positive-calibration.md"

func TestCommittedCalibrationReportMatchesTheCorpus(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	rendered := BuildReport(corpus).Markdown()

	committed, err := os.ReadFile(filepath.Clean(reportPath))
	if err != nil {
		t.Fatalf("the calibration report is not committed: %v\n"+
			"Regenerate it with: go test ./internal/assurancecorpus/ -run TestWriteCalibrationReport -update", err)
	}
	if string(committed) != rendered {
		t.Fatalf("the committed calibration report no longer matches the corpus.\n"+
			"Regenerate with: go test ./internal/assurancecorpus/ -run TestWriteCalibrationReport -update\n"+
			"committed %d bytes, current %d bytes", len(committed), len(rendered))
	}
}

// Every claim in the report has to be defensible on its own, because it will be
// read away from this code.
func TestReportStatesMethodologyAndItsLimits(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	rendered := BuildReport(corpus).Markdown()
	for _, required := range []string{
		"95%",                       // the interval is stated
		"upper bound",               // and which end the verdict reads
		"Wilson",                    // and how it was computed
		"requires_compiler_receipt", // what was excluded and why
		"Fact Contract",             // the other exclusion
	} {
		if !strings.Contains(rendered, required) {
			t.Errorf("the report omits %q, so a reader cannot judge the number", required)
		}
	}
	// The one claim it must never make.
	for _, forbidden := range []string{"meets a 1% target", "under 1%"} {
		if strings.Contains(rendered, forbidden) {
			t.Errorf("the report claims %q on evidence that cannot support it", forbidden)
		}
	}
}

// A code the corpus exercises but never forbids has no denominator. Listing it
// with a blank rate is honest; omitting it silently would hide a check nobody
// is measuring.
func TestReportListsExercisedChecksWithNoNegatives(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	report := BuildReport(corpus)
	if len(report.Unmeasured) == 0 {
		return
	}
	rendered := report.Markdown()
	for _, code := range report.Unmeasured {
		if !strings.Contains(rendered, code) {
			t.Errorf("check %s fires on the corpus but is absent from the report", code)
		}
	}
}
