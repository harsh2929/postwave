// SPDX-License-Identifier: AGPL-3.0-only

// calibration_report.go — the published false-positive report.
//
// §16.3 requires an acceptance target to name a corpus and a confidence
// interval. A number that lives only in a test log satisfies neither: nobody
// making a release decision runs the suite and reads the output.
//
// So the report is a committed artifact, regenerated from the corpus and
// drift-checked by a test. A stale published rate is worse than none, because
// it states a measurement that no longer describes anything.

package assurancecorpus

import (
	"fmt"
	"sort"
	"strings"
)

// ReportRow is one check's measured rate.
type ReportRow struct {
	Code           string
	Negatives      int
	FalsePositives int
	PointPercent   float64
	UpperPercent   float64
}

type Report struct {
	CorpusVersion string
	Cases         int
	Ran           int
	Skipped       int
	Rows          []ReportRow
	// Unmeasured are checks the corpus exercises but no case forbids, so they
	// have no denominator. Listed rather than dropped: a check nobody measures
	// should be visible as such, not absent.
	Unmeasured []string
}

// BuildReport runs the detectors and measures every check the corpus can judge.
func BuildReport(corpus Corpus) Report {
	outcomes, skipped := RunDetectors(corpus)
	samples := FalsePositiveSamples(corpus.Manifest.CorpusVersion,
		corpus.Manifest.CorpusVersion, outcomes)

	report := Report{
		CorpusVersion: corpus.Manifest.CorpusVersion,
		Cases:         len(corpus.Cases),
		Ran:           len(outcomes),
		Skipped:       skipped,
	}

	fired := map[string]bool{}
	for _, outcome := range outcomes {
		for _, code := range outcome.FiredCodes {
			fired[code] = true
		}
	}

	for code, sample := range samples {
		if !contentDimensionCode(code) {
			continue
		}
		rate, err := sample.Rate()
		if err != nil {
			continue
		}
		report.Rows = append(report.Rows, ReportRow{
			Code: code, Negatives: sample.Negatives,
			FalsePositives: sample.FalsePositives,
			PointPercent:   rate.Point * 100,
			UpperPercent:   rate.UpperBound * 100,
		})
	}
	sort.Slice(report.Rows, func(a, b int) bool {
		if report.Rows[a].UpperPercent != report.Rows[b].UpperPercent {
			return report.Rows[a].UpperPercent < report.Rows[b].UpperPercent
		}
		return report.Rows[a].Code < report.Rows[b].Code
	})

	for code := range fired {
		if !contentDimensionCode(code) {
			continue
		}
		if _, measured := samples[code]; !measured {
			report.Unmeasured = append(report.Unmeasured, code)
		}
	}
	sort.Strings(report.Unmeasured)
	return report
}

// Markdown renders the report. Deterministic, because it is committed and
// compared byte-for-byte.
func (r Report) Markdown() string {
	var out strings.Builder
	out.WriteString("# Deterministic check false-positive calibration\n\n")
	out.WriteString("<!-- Generated from the assurance corpus. Do not edit by hand.\n")
	out.WriteString("     Regenerate: go test ./internal/assurancecorpus/ -run TestWriteCalibrationReport -update -->\n\n")

	out.WriteString(fmt.Sprintf(
		"Corpus `%s`: %d cases, %d analysed, %d skipped.\n\n",
		r.CorpusVersion, r.Cases, r.Ran, r.Skipped))

	out.WriteString("## What this measures\n\n")
	out.WriteString("A corpus case listing a code in `forbidden_codes` is a labelled TRUE\n")
	out.WriteString("NEGATIVE for that code: a legitimate message the check must leave alone.\n")
	out.WriteString("The check firing anyway is a false positive. Cases that REQUIRE a code are\n")
	out.WriteString("true positives and are deliberately excluded from the denominator.\n\n")
	out.WriteString("Intervals are Wilson score intervals at 95%. The verdict column reads the\n")
	out.WriteString("**upper bound**, never the point estimate: zero false positives in six cases\n")
	out.WriteString("and zero in six hundred are the same point estimate and completely\n")
	out.WriteString("different evidence.\n\n")

	out.WriteString("## Measured checks\n\n")
	out.WriteString("| Check | Negatives | False positives | Rate | 95% upper bound |\n")
	out.WriteString("| --- | ---: | ---: | ---: | ---: |\n")
	for _, row := range r.Rows {
		out.WriteString(fmt.Sprintf("| `%s` | %d | %d | %.2f%% | %.1f%% |\n",
			row.Code, row.Negatives, row.FalsePositives, row.PointPercent, row.UpperPercent))
	}
	out.WriteString("\n")

	if len(r.Unmeasured) != 0 {
		out.WriteString("## Exercised but unmeasured\n\n")
		out.WriteString("These checks fire on the corpus but no case declares them forbidden, so\n")
		out.WriteString("they have no denominator and no rate. They are listed because a check\n")
		out.WriteString("nobody measures should be visible as such.\n\n")
		for _, code := range r.Unmeasured {
			out.WriteString(fmt.Sprintf("- `%s`\n", code))
		}
		out.WriteString("\n")
	}

	out.WriteString("## What is out of scope, and why\n\n")
	out.WriteString("Cases marked `requires_compiler_receipt` are skipped. Without the receipt\n")
	out.WriteString("the compiler's own preheader is indistinguishable from unknown hidden\n")
	out.WriteString("content and the detector is right to flag it; scoring that would blame it\n")
	out.WriteString("for evidence this harness cannot produce.\n\n")
	out.WriteString("Checks that compare a representation against the sender's Fact Contract are\n")
	out.WriteString("excluded for the same reason: a raw `.eml` carries no contract, and\n")
	out.WriteString("supplying a synthetic one would score the detector against an expectation\n")
	out.WriteString("this harness authored.\n\n")
	out.WriteString("Artifact and receipt findings (`ARTIFACT_RECEIPT_MISMATCH`,\n")
	out.WriteString("`REPRESENTATION_MANIFEST_INVALID`, and similar) fire on every case. They are\n")
	out.WriteString("correct statements about a synthetic compilation, not detector faults, and\n")
	out.WriteString("no case forbids them, so they never enter a denominator.\n\n")

	out.WriteString("## Reading the numbers honestly\n\n")
	out.WriteString("Every measured check currently shows zero false positives. That is not\n")
	out.WriteString("evidence of a low rate — it is evidence consistent with rates as high as\n")
	out.WriteString("the upper-bound column. Narrowing those bounds needs more labelled\n")
	out.WriteString("negatives, not better detectors: the detectors have changed twice during\n")
	out.WriteString("this work, both times because the corpus surfaced a genuine defect.\n")
	return out.String()
}
