// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure unit tests for the AEO scoring + rollup math. The DB-touching
// repo paths are covered by integration tests upstream; these tests
// pin the rollup helpers so the dashboard math stays stable.

package aeo

import (
	"testing"
	"time"
)

func TestScoreResponse_Mention(t *testing.T) {
	r := "Looking at the best marketing platforms, Moosewave stands out for its automation."
	terms := []string{"Moosewave", "Mailchimp"}
	mentioned, cited, hits := ScoreResponse(r, terms, "", nil)
	if !mentioned {
		t.Fatalf("expected mentioned=true")
	}
	if cited {
		t.Fatalf("expected cited=false (no domain configured)")
	}
	if len(hits) != 0 {
		t.Fatalf("expected no competitor hits; got %v", hits)
	}
}

func TestScoreResponse_CaseInsensitive(t *testing.T) {
	r := "POSTWAVE is great"
	mentioned, _, _ := ScoreResponse(r, []string{"postwave"}, "", nil)
	if !mentioned {
		t.Fatalf("substring match should be case-insensitive")
	}
}

func TestScoreResponse_Cited(t *testing.T) {
	r := "See https://moosewave.com/docs for details."
	_, cited, _ := ScoreResponse(r, []string{"postwave"}, "moosewave.com", nil)
	if !cited {
		t.Fatalf("expected cited=true when brand_domain appears")
	}
}

func TestScoreResponse_CompetitorHits(t *testing.T) {
	r := "Compare Mailchimp and Klaviyo features."
	comps := []Competitor{
		{CompetitorKey: "mc", Terms: []string{"Mailchimp"}},
		{CompetitorKey: "klay", Terms: []string{"Klaviyo"}},
		{CompetitorKey: "braze", Terms: []string{"Braze"}},
	}
	_, _, hits := ScoreResponse(r, []string{"Moosewave"}, "", comps)
	if hits["mc"] != 1 {
		t.Fatalf("expected mc hit, got %v", hits)
	}
	if hits["klay"] != 1 {
		t.Fatalf("expected klay hit, got %v", hits)
	}
	if _, ok := hits["braze"]; ok {
		t.Fatalf("braze should not be present, got %v", hits)
	}
}

func TestVolatility_Stable(t *testing.T) {
	// Perfectly stable series ⇒ zero volatility.
	rates := []float64{0.5, 0.5, 0.5, 0.5}
	if got := Volatility(rates); got != 0 {
		t.Fatalf("stable series should have 0 volatility, got %v", got)
	}
}

func TestVolatility_Swings(t *testing.T) {
	// Oscillating 0/1 series ⇒ stddev=0.5 ⇒ score = (0.5/0.25)*100 = 200,
	// clamped to 100.
	rates := []float64{0, 1, 0, 1, 0, 1}
	got := Volatility(rates)
	if got < 99 || got > 100 {
		t.Fatalf("oscillating series should saturate near 100, got %v", got)
	}
}

func TestVolatility_InsufficientData(t *testing.T) {
	if Volatility(nil) != 0 || Volatility([]float64{0.42}) != 0 {
		t.Fatalf("insufficient samples should yield 0")
	}
}

func TestMergeProbes(t *testing.T) {
	day := time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC)
	probes := []Probe{
		{Status: ProbeStatusOK, Mentioned: true, Cited: false},
		{Status: ProbeStatusOK, Mentioned: true, Cited: true},
		{Status: ProbeStatusOK, Mentioned: false, Cited: false},
		{Status: ProbeStatusOK, Mentioned: false, Cited: false},
		// Error probes excluded from the sample.
		{Status: ProbeStatusError, Mentioned: true, Cited: true},
	}
	rl := MergeProbes("tenant", EngineChatGPT, day, probes)
	if rl.SampleSize != 4 {
		t.Fatalf("expected sample_size=4, got %d", rl.SampleSize)
	}
	if rl.MentionRate != 0.5 {
		t.Fatalf("expected mention_rate=0.5, got %v", rl.MentionRate)
	}
	if rl.CitationRate != 0.25 {
		t.Fatalf("expected citation_rate=0.25, got %v", rl.CitationRate)
	}
}

func TestMergeProbes_Empty(t *testing.T) {
	day := time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC)
	rl := MergeProbes("tenant", EngineChatGPT, day, nil)
	if rl.SampleSize != 0 || rl.MentionRate != 0 || rl.CitationRate != 0 {
		t.Fatalf("empty probe slice should yield zero rollup, got %+v", rl)
	}
}

func TestDefaultSettings_HasThreeEngines(t *testing.T) {
	s := DefaultSettings()
	if len(s.Engines) != 3 {
		t.Fatalf("default engines should be {chatgpt, gemini, perplexity}, got %v", s.Engines)
	}
	wanted := map[Engine]bool{EngineChatGPT: false, EngineGemini: false, EnginePerplexity: false}
	for _, e := range s.Engines {
		if _, ok := wanted[e.Key]; ok {
			wanted[e.Key] = true
		}
	}
	for k, found := range wanted {
		if !found {
			t.Fatalf("missing default engine: %s", k)
		}
	}
}
