// SPDX-License-Identifier: AGPL-3.0-only

// calibration.go — turns corpus results into false-positive samples.
//
// The corpus already carries the labels a false-positive rate needs. A case
// listing a code in ForbiddenCodes is asserting that the code MUST NOT fire on
// this message: that is a labelled true negative for that code, and the code
// firing anyway is a false positive.
//
// This bridge exists so §16.3's acceptance targets are measured against the
// versioned corpus rather than against a number somebody remembered. What it
// deliberately does not do is manufacture confidence: the embedded corpus is
// small, so the intervals it supports are wide, and checkcalibration reports
// that plainly instead of letting a clean run read as a proven low rate.

package assurancecorpus

import (
	"strings"

	"github.com/postwave/postwave/apps/api/internal/checkcalibration"
)

// CaseOutcome is one evaluated corpus case: what it asserted must not fire,
// and what actually did.
type CaseOutcome struct {
	CaseID         string
	ForbiddenCodes []string
	FiredCodes     []string
}

// FalsePositiveSamples produces one sample per check code that at least one
// case forbids.
//
// Only cases that FORBID a code enter that code's denominator. A case that
// requires the code is a true positive and belongs to a different measurement;
// counting it as a trial would inflate the denominator and understate the rate.
//
// A code no case forbids gets NO sample rather than an empty one, because a
// zero-trial sample would render as a 0% rate for a check that was never
// exercised — the precise overclaim checkcalibration exists to prevent.
func FalsePositiveSamples(corpusName, corpusVersion string, outcomes []CaseOutcome) map[string]checkcalibration.Sample {
	negatives := map[string]int{}
	falsePositives := map[string]int{}

	for _, outcome := range outcomes {
		fired := map[string]bool{}
		for _, code := range outcome.FiredCodes {
			if trimmed := strings.TrimSpace(code); trimmed != "" {
				fired[trimmed] = true
			}
		}
		seen := map[string]bool{}
		for _, code := range outcome.ForbiddenCodes {
			code = strings.TrimSpace(code)
			// A case listing the same code twice is one negative, not two.
			if code == "" || seen[code] {
				continue
			}
			seen[code] = true
			negatives[code]++
			if fired[code] {
				falsePositives[code]++
			}
		}
	}

	samples := make(map[string]checkcalibration.Sample, len(negatives))
	for code, count := range negatives {
		samples[code] = checkcalibration.Sample{
			Corpus: checkcalibration.Corpus{
				Name:    corpusName,
				Version: corpusVersion,
				// Composition is the sample's own shape rather than the whole
				// corpus: the rate is measured over these cases, and describing
				// it with the corpus total would overstate the evidence.
				Composition: map[string]int{"negative_cases": count},
			},
			Negatives:      count,
			FalsePositives: falsePositives[code],
		}
	}
	return samples
}
