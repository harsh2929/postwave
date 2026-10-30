// SPDX-License-Identifier: AGPL-3.0-only

// Package checkcalibration turns a measured false-positive count into a claim
// a release decision can rely on.
//
// §16.3 of the assurance blueprint is unusually specific about this:
//
//	False-positive acceptance targets must name a corpus and confidence
//	interval. "<1%" without sample size and composition is not a release
//	criterion.
//
// The failure it is guarding against is small-sample confidence. Run a
// detector over ten messages, see no false positives, and the point estimate is
// a flawless 0% — while the true rate could comfortably be 25%. The number
// looks identical to a real result measured over five thousand, which is
// exactly the property that makes it dangerous.
//
// So this package refuses to produce a bare rate. A Sample cannot yield one
// without a NAMED, versioned corpus with a stated composition, and MeetsTarget
// judges the interval's UPPER BOUND rather than the point estimate — the
// difference between "we measured 0%" and "we can rule out more than 1%".
package checkcalibration

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// Confidence is fixed at 95% rather than configurable. A tunable confidence
// level is a dial for making an uncomfortable result comfortable, and the
// blueprint asks for a stated interval, not a negotiable one.
const (
	confidenceLabel = "95%"
	zScore95        = 1.959963984540054
)

// Corpus identifies WHAT was measured. Composition is required because a
// false-positive rate over a corpus of 1000 newsletters says nothing about
// transactional mail, and a bare rate hides that entirely.
type Corpus struct {
	Name        string         `json:"name"`
	Version     string         `json:"version"`
	Composition map[string]int `json:"composition"`
}

func (c Corpus) validate() error {
	if strings.TrimSpace(c.Name) == "" {
		return errors.New("checkcalibration: corpus must be named")
	}
	if strings.TrimSpace(c.Version) == "" {
		return errors.New("checkcalibration: corpus must be versioned")
	}
	if len(c.Composition) == 0 {
		return errors.New("checkcalibration: corpus must state its composition")
	}
	return nil
}

// Describe renders the composition deterministically, so two runs of the same
// corpus produce comparable text.
func (c Corpus) Describe() string {
	classes := make([]string, 0, len(c.Composition))
	for class := range c.Composition {
		classes = append(classes, class)
	}
	sort.Strings(classes)
	parts := make([]string, 0, len(classes))
	for _, class := range classes {
		parts = append(parts, fmt.Sprintf("%s=%d", class, c.Composition[class]))
	}
	return strings.Join(parts, " ")
}

// Sample is one measurement run. Negatives is the number of items that SHOULD
// NOT have triggered the check — the denominator of a false-positive rate is
// the true negatives, not the whole corpus.
type Sample struct {
	Corpus         Corpus `json:"corpus"`
	Negatives      int    `json:"negatives"`
	FalsePositives int    `json:"false_positives"`
}

// Rate is a measured proportion with the interval it was measured to.
//
// Point, LowerBound and UpperBound travel together and there is no constructor
// that produces one without the others, so a caller cannot end up holding a
// bare rate with no idea how much sample stood behind it.
type Rate struct {
	Point           float64 `json:"point"`
	LowerBound      float64 `json:"lower_bound"`
	UpperBound      float64 `json:"upper_bound"`
	SampleSize      int     `json:"sample_size"`
	FalsePositives  int     `json:"false_positives"`
	ConfidenceLabel string  `json:"confidence"`
	Corpus          Corpus  `json:"corpus"`
}

// Rate computes the false-positive rate and its Wilson score interval.
func (s Sample) Rate() (Rate, error) {
	if err := s.Corpus.validate(); err != nil {
		return Rate{}, err
	}
	if s.Negatives <= 0 {
		// Not a low rate — no measurement. Returning 0 here is how an unrun
		// calibration becomes a passing one.
		return Rate{}, errors.New("checkcalibration: a rate needs at least one true negative")
	}
	if s.FalsePositives < 0 || s.FalsePositives > s.Negatives {
		return Rate{}, errors.New("checkcalibration: false positives must be within the sample")
	}
	lower, upper := wilsonInterval(s.FalsePositives, s.Negatives, zScore95)
	return Rate{
		Point:           float64(s.FalsePositives) / float64(s.Negatives),
		LowerBound:      lower,
		UpperBound:      upper,
		SampleSize:      s.Negatives,
		FalsePositives:  s.FalsePositives,
		ConfidenceLabel: confidenceLabel,
		Corpus:          s.Corpus,
	}, nil
}

// MeetsTarget reports whether the measurement RULES OUT a rate above target.
//
// It reads the upper bound, never the point estimate. That is the whole
// distinction the package exists for: 0 false positives in 10 items has a point
// estimate of 0% and an upper bound near 28%, and only the second number
// describes what the sample can actually support.
func (r Rate) MeetsTarget(target float64) bool {
	if r.SampleSize <= 0 || target <= 0 {
		return false
	}
	return r.UpperBound <= target
}

// Summary is the sentence a release decision reads. It always carries the
// corpus, the sample size and the interval, so the figure cannot be quoted
// onward stripped of the things that make it meaningful.
func (r Rate) Summary(target float64) string {
	verdict := "does not meet"
	if r.MeetsTarget(target) {
		verdict = "meets"
	}
	return fmt.Sprintf(
		"false-positive rate %.3f%% (%s CI %.3f%%–%.3f%%) from %d true negatives "+
			"in corpus %s@%s [%s]; %s a %.3f%% target, which is judged on the "+
			"interval's upper bound rather than the point estimate",
		r.Point*100, r.ConfidenceLabel, r.LowerBound*100, r.UpperBound*100,
		r.SampleSize, r.Corpus.Name, r.Corpus.Version, r.Corpus.Describe(),
		verdict, target*100,
	)
}

// wilsonInterval is the Wilson score interval for a binomial proportion.
//
// Deliberately not the normal approximation: near zero — where a
// false-positive rate lives if the detector works — the normal approximation
// produces intervals that extend below 0 and are far too narrow, which would
// make a tiny sample look conclusive. Wilson stays inside [0,1] and keeps
// honest width at small n and extreme proportions.
func wilsonInterval(successes, trials int, z float64) (float64, float64) {
	n := float64(trials)
	phat := float64(successes) / n
	z2 := z * z
	denominator := 1 + z2/n
	centre := (phat + z2/(2*n)) / denominator
	margin := (z / denominator) * math.Sqrt(phat*(1-phat)/n+z2/(4*n*n))
	lower, upper := math.Max(0, centre-margin), math.Min(1, centre+margin)
	// At the boundaries the interval is exactly closed, and floating-point
	// rounding otherwise leaves a lower bound of ~2e-17 on a zero-success
	// sample. That is not a rounding curiosity to shrug at: it puts the point
	// estimate outside its own interval, and any caller comparing the two would
	// read a contradiction.
	if successes == 0 {
		lower = 0
	}
	if successes == trials {
		upper = 1
	}
	return lower, upper
}
