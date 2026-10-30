// SPDX-License-Identifier: AGPL-3.0-only

package checkcalibration

import (
	"math"
	"testing"
)

func namedCorpus() Corpus {
	return Corpus{
		Name:    "campaign-html-2026-08",
		Version: "v1",
		Composition: map[string]int{
			"promotional":   400,
			"transactional": 300,
			"newsletter":    300,
		},
	}
}

// §16.3: "False-positive acceptance targets must name a corpus and confidence
// interval. '<1%' without sample size and composition is not a release
// criterion." An unnamed corpus is the most common way that rule is broken.
func TestRateRequiresANamedCorpus(t *testing.T) {
	for name, corpus := range map[string]Corpus{
		"no name":        {Version: "v1", Composition: map[string]int{"a": 10}},
		"no version":     {Name: "c", Composition: map[string]int{"a": 10}},
		"no composition": {Name: "c", Version: "v1"},
		"empty composition": {
			Name: "c", Version: "v1", Composition: map[string]int{},
		},
	} {
		sample := Sample{Corpus: corpus, Negatives: 1000, FalsePositives: 3}
		if _, err := sample.Rate(); err == nil {
			t.Fatalf("%s: produced a rate anyway", name)
		}
	}
}

// A rate over no items is not a small rate, it is no measurement.
func TestRateRefusesAnEmptySample(t *testing.T) {
	sample := Sample{Corpus: namedCorpus(), Negatives: 0}
	if _, err := sample.Rate(); err == nil {
		t.Fatal("an empty sample produced a rate")
	}
}

func TestRateRefusesMoreFalsePositivesThanItems(t *testing.T) {
	sample := Sample{Corpus: namedCorpus(), Negatives: 10, FalsePositives: 11}
	if _, err := sample.Rate(); err == nil {
		t.Fatal("more false positives than negatives produced a rate")
	}
}

// THE point of the whole package. A perfect score on a tiny sample is not
// evidence of a low rate — with 10 items and no false positives the true rate
// could still be 25%. Judging by the point estimate is how "<1%" gets claimed
// from a sample that cannot support it.
func TestASmallPerfectSampleDoesNotMeetATightTarget(t *testing.T) {
	small := Sample{Corpus: namedCorpus(), Negatives: 10, FalsePositives: 0}
	rate, err := small.Rate()
	if err != nil {
		t.Fatal(err)
	}
	if rate.Point != 0 {
		t.Fatalf("point estimate = %v, want 0", rate.Point)
	}
	if rate.MeetsTarget(0.01) {
		t.Fatalf("0/10 was accepted as under 1%%; interval upper bound is %v", rate.UpperBound)
	}
	if rate.UpperBound <= 0.01 {
		t.Fatalf("upper bound %v is implausibly tight for n=10", rate.UpperBound)
	}
}

// The same perfect score on a large sample does support the claim.
func TestALargePerfectSampleMeetsTheTarget(t *testing.T) {
	large := Sample{Corpus: namedCorpus(), Negatives: 5000, FalsePositives: 0}
	rate, err := large.Rate()
	if err != nil {
		t.Fatal(err)
	}
	if !rate.MeetsTarget(0.01) {
		t.Fatalf("0/5000 did not meet a 1%% target; upper bound %v", rate.UpperBound)
	}
}

// The interval is a proportion, so it cannot leave [0,1]. The normal
// approximation famously produces negative lower bounds near zero, which is
// why this uses a Wilson score interval.
func TestIntervalStaysWithinZeroAndOne(t *testing.T) {
	for _, sample := range []Sample{
		{Corpus: namedCorpus(), Negatives: 5, FalsePositives: 0},
		{Corpus: namedCorpus(), Negatives: 5, FalsePositives: 5},
		{Corpus: namedCorpus(), Negatives: 1, FalsePositives: 0},
		{Corpus: namedCorpus(), Negatives: 2000, FalsePositives: 1},
	} {
		rate, err := sample.Rate()
		if err != nil {
			t.Fatal(err)
		}
		if rate.LowerBound < 0 || rate.UpperBound > 1 || rate.LowerBound > rate.UpperBound {
			t.Fatalf("interval [%v,%v] is not a valid proportion range for %d/%d",
				rate.LowerBound, rate.UpperBound, sample.FalsePositives, sample.Negatives)
		}
		if rate.Point < rate.LowerBound || rate.Point > rate.UpperBound {
			t.Fatalf("point %v outside interval [%v,%v]", rate.Point, rate.LowerBound, rate.UpperBound)
		}
	}
}

// More evidence must never widen the interval.
func TestIntervalNarrowsAsTheSampleGrows(t *testing.T) {
	previous := math.Inf(1)
	for _, n := range []int{10, 100, 1000, 10000} {
		rate, err := Sample{Corpus: namedCorpus(), Negatives: n, FalsePositives: n / 100}.Rate()
		if err != nil {
			t.Fatal(err)
		}
		width := rate.UpperBound - rate.LowerBound
		if width > previous {
			t.Fatalf("interval widened from %v to %v at n=%d", previous, width, n)
		}
		previous = width
	}
}

// The report is the artifact a release decision reads, so it must carry the
// things §16.3 requires rather than a bare number.
func TestReportStatesTheCorpusSampleAndInterval(t *testing.T) {
	rate, err := Sample{Corpus: namedCorpus(), Negatives: 5000, FalsePositives: 7}.Rate()
	if err != nil {
		t.Fatal(err)
	}
	summary := rate.Summary(0.01)
	for _, required := range []string{"campaign-html-2026-08", "5000", "95%"} {
		if !contains(summary, required) {
			t.Fatalf("summary omits %q: %s", required, summary)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
