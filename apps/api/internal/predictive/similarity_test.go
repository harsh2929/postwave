package predictive

import "testing"

func TestDomainOf(t *testing.T) {
	cases := map[string]string{
		"alice@example.com": "example.com",
		"BOB@Example.COM":   "example.com",
		"  c@d.io  ":        "d.io", // domain trimmed; note local part not trimmed but '@' split is on last '@'
		"no-at-sign":        "",
		"trailing@":         "",
		"a@b@final.test":    "final.test",
	}
	for in, want := range cases {
		if got := DomainOf(in); got != want {
			t.Errorf("DomainOf(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestCosine_Bounds(t *testing.T) {
	a := FeatureVector{"x": 1, "y": 1}
	// Identical vectors → 1.
	if got := Cosine(a, FeatureVector{"x": 1, "y": 1}); got < 0.999 {
		t.Errorf("Cosine(identical) = %v; want ~1", got)
	}
	// Orthogonal → 0.
	if got := Cosine(FeatureVector{"x": 1}, FeatureVector{"y": 1}); got != 0 {
		t.Errorf("Cosine(orthogonal) = %v; want 0", got)
	}
	// Empty side → 0 (no signal).
	if got := Cosine(FeatureVector{}, a); got != 0 {
		t.Errorf("Cosine(empty,_) = %v; want 0", got)
	}
}

// TestRank_PrefersSimilarFirstParty: a seed of high-engagement gmail.com
// signups should rank a matching candidate above a low-engagement
// different-domain candidate, exclude seed members, and honour the limit.
func TestRank_PrefersSimilarFirstParty(t *testing.T) {
	seed := []Profile{
		{SubscriberID: "s1", Email: "a@gmail.com", SignupSource: "embedded_form", EngagementScore: 90, ChurnScore: 10},
		{SubscriberID: "s2", Email: "b@gmail.com", SignupSource: "embedded_form", EngagementScore: 85, ChurnScore: 15},
	}
	candidates := []Profile{
		// Looks like the seed: gmail + embedded_form + high engagement + low churn.
		{SubscriberID: "c1", Email: "match@gmail.com", SignupSource: "embedded_form", EngagementScore: 88, ChurnScore: 12},
		// Unlike the seed: different domain + import + low engagement + high churn.
		{SubscriberID: "c2", Email: "diff@yahoo.com", SignupSource: "import", EngagementScore: 5, ChurnScore: 95},
		// A seed member sneaking into the candidate pool must be excluded.
		{SubscriberID: "s1", Email: "a@gmail.com", SignupSource: "embedded_form", EngagementScore: 90, ChurnScore: 10},
	}

	ranked := Rank(seed, candidates, 0, 10)
	if len(ranked) != 2 {
		t.Fatalf("ranked len = %d; want 2 (seed member excluded)", len(ranked))
	}
	if ranked[0].Profile.SubscriberID != "c1" {
		t.Errorf("top match = %q; want c1", ranked[0].Profile.SubscriberID)
	}
	if ranked[0].Similarity <= ranked[1].Similarity {
		t.Errorf("c1 similarity %v should exceed c2 %v", ranked[0].Similarity, ranked[1].Similarity)
	}
	for _, s := range ranked {
		if s.Profile.SubscriberID == "s1" {
			t.Errorf("seed member s1 leaked into ranked output")
		}
	}

	// Limit truncates.
	if got := Rank(seed, candidates, 0, 1); len(got) != 1 || got[0].Profile.SubscriberID != "c1" {
		t.Errorf("Rank(limit=1) = %+v; want [c1]", got)
	}
	// Threshold drops the dissimilar candidate.
	hi := Rank(seed, candidates, 0.5, 10)
	for _, s := range hi {
		if s.Similarity < 0.5 {
			t.Errorf("threshold not applied: %v < 0.5", s.Similarity)
		}
	}
}

// TestRank_EmptySeed yields no scores (a centroid of nothing matches nothing).
func TestRank_EmptySeed(t *testing.T) {
	candidates := []Profile{{SubscriberID: "c1", Email: "x@y.com", EngagementScore: 50}}
	if got := Rank(nil, candidates, 0, 10); len(got) != 0 {
		t.Errorf("Rank(emptySeed) = %d items; want 0", len(got))
	}
}
