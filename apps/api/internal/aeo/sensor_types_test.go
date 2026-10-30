// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure unit tests for the public Sensor aggregation helpers.
// DB-touching paths are covered by integration tests upstream; these
// tests pin the k-anon + aggregation math so the public surface
// stays stable.

package aeo

import (
	"testing"
	"time"
)

func TestAggregateRows_HappyPath(t *testing.T) {
	day := time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC)
	rl := AggregateRows(
		"saas", EngineChatGPT, day,
		[]float64{0.4, 0.5, 0.6, 0.5, 0.5},
		[]float64{0.1, 0.2, 0.1, 0.2, 0.1},
		[]int{10, 12, 8, 14, 16},
	)
	if rl.ContributorCount != 5 {
		t.Fatalf("expected contributor_count=5, got %d", rl.ContributorCount)
	}
	if rl.SampleSize != 60 {
		t.Fatalf("expected sample_size=60, got %d", rl.SampleSize)
	}
	if rl.MentionRate != 0.5 {
		t.Fatalf("expected mention_rate=0.5, got %v", rl.MentionRate)
	}
	if rl.CitationRate < 0.139 || rl.CitationRate > 0.141 {
		t.Fatalf("expected citation_rate~=0.14, got %v", rl.CitationRate)
	}
	if rl.IndustrySlug != "saas" || rl.Engine != EngineChatGPT {
		t.Fatalf("expected industry/engine to be preserved, got %s/%s", rl.IndustrySlug, rl.Engine)
	}
}

func TestAggregateRows_Empty(t *testing.T) {
	day := time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC)
	rl := AggregateRows("saas", EngineGemini, day, nil, nil, nil)
	if rl.ContributorCount != 0 || rl.SampleSize != 0 {
		t.Fatalf("empty inputs should yield zeros, got %+v", rl)
	}
	if rl.MentionRate != 0 || rl.CitationRate != 0 {
		t.Fatalf("empty inputs should yield zero rates, got %+v", rl)
	}
}

func TestSuppressedByKAnon(t *testing.T) {
	for _, tc := range []struct {
		count int
		want  bool
	}{
		{0, true},
		{1, true},
		{MinContributors - 1, true},
		{MinContributors, false},
		{MinContributors + 10, false},
	} {
		rl := SensorIndustryRollup{ContributorCount: tc.count}
		if got := rl.SuppressedByKAnon(); got != tc.want {
			t.Fatalf("ContributorCount=%d: want %v, got %v", tc.count, tc.want, got)
		}
	}
}
