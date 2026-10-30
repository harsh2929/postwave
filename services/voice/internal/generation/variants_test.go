package generation

import (
	"strings"
	"testing"
)

func twoVariants() []EmailVariant {
	return []EmailVariant{
		{Key: "A", Subject: "Subject A", Body: "Body A", WeightBP: 5000},
		{Key: "B", Subject: "Subject B", Body: "Body B", WeightBP: 5000},
	}
}

func TestValidateVariantsAccepts(t *testing.T) {
	cases := map[string][]EmailVariant{
		"nil (no A/B test)":   nil,
		"empty (no A/B test)": {},
		"two even arms":       twoVariants(),
		"four uneven arms": {
			{Key: "a", Subject: "s", Body: "b", WeightBP: 1},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 9},
			{Key: "c", Subject: "s", Body: "b", WeightBP: 90},
			{Key: "d", Subject: "s", Body: "b", WeightBP: 9900},
		},
		"body_html only": {
			{Key: "a", Subject: "s", BodyHTML: "<p>hi</p>", WeightBP: 5000},
			{Key: "b", Subject: "s", BodyHTML: "<p>yo</p>", WeightBP: 5000},
		},
	}
	for name, vs := range cases {
		if err := ValidateVariants(vs); err != nil {
			t.Errorf("%s: unexpected error: %v", name, err)
		}
	}
}

func TestValidateVariantsRejects(t *testing.T) {
	cases := map[string][]EmailVariant{
		"single variant": {
			{Key: "a", Subject: "s", Body: "b", WeightBP: 10000},
		},
		"five variants": {
			{Key: "a", Subject: "s", Body: "b", WeightBP: 2000},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 2000},
			{Key: "c", Subject: "s", Body: "b", WeightBP: 2000},
			{Key: "d", Subject: "s", Body: "b", WeightBP: 2000},
			{Key: "e", Subject: "s", Body: "b", WeightBP: 2000},
		},
		"weights sum under 10000": {
			{Key: "a", Subject: "s", Body: "b", WeightBP: 4000},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 5000},
		},
		"weights sum over 10000": {
			{Key: "a", Subject: "s", Body: "b", WeightBP: 6000},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 5000},
		},
		"zero weight": {
			{Key: "a", Subject: "s", Body: "b", WeightBP: 0},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 10000},
		},
		"negative weight": {
			{Key: "a", Subject: "s", Body: "b", WeightBP: -1},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 10001},
		},
		"missing key": {
			{Key: " ", Subject: "s", Body: "b", WeightBP: 5000},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 5000},
		},
		"duplicate key (case-insensitive)": {
			{Key: "A", Subject: "s", Body: "b", WeightBP: 5000},
			{Key: "a", Subject: "s", Body: "b", WeightBP: 5000},
		},
		"key too long": {
			{Key: strings.Repeat("k", 33), Subject: "s", Body: "b", WeightBP: 5000},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 5000},
		},
		"missing subject": {
			{Key: "a", Subject: "  ", Body: "b", WeightBP: 5000},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 5000},
		},
		"missing body and body_html": {
			{Key: "a", Subject: "s", WeightBP: 5000},
			{Key: "b", Subject: "s", Body: "b", WeightBP: 5000},
		},
	}
	for name, vs := range cases {
		if err := ValidateVariants(vs); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}

func TestAssignVariantDeterministic(t *testing.T) {
	variants := twoVariants()
	const seqID = "11111111-2222-3333-4444-555555555555"
	emails := []string{
		"alice@example.com", "bob@example.com", "carol@example.com",
		"dave@example.com", "erin@example.com",
	}
	for _, email := range emails {
		first, err := AssignVariant(seqID, 1, email, variants)
		if err != nil {
			t.Fatalf("AssignVariant(%s): %v", email, err)
		}
		for i := 0; i < 50; i++ {
			again, err := AssignVariant(seqID, 1, email, variants)
			if err != nil {
				t.Fatalf("AssignVariant(%s) repeat: %v", email, err)
			}
			if again.Key != first.Key {
				t.Fatalf("AssignVariant(%s) unstable: got %q then %q", email, first.Key, again.Key)
			}
		}
	}
}

func TestAssignVariantTrimsOpaqueSubscriberID(t *testing.T) {
	variants := twoVariants()
	a, _ := AssignVariant("seq-1", 2, " subscriber_A ", variants)
	b, _ := AssignVariant("seq-1", 2, "subscriber_A", variants)
	if a.Key != b.Key {
		t.Fatalf("whitespace variation changed assignment: %q vs %q", a.Key, b.Key)
	}
}

func TestAssignVariantVariesByStepAndSequence(t *testing.T) {
	// Different (sequence, step) inputs must be able to land in
	// different arms for the same subscriber — scan a window of steps
	// and assert both arms appear (with a 50/50 split, 64 consecutive
	// identical assignments would mean the step isn't in the hash).
	variants := twoVariants()
	seen := map[string]bool{}
	for pos := 1; pos <= 64; pos++ {
		v, err := AssignVariant("seq-1", pos, "alice@example.com", variants)
		if err != nil {
			t.Fatalf("AssignVariant pos=%d: %v", pos, err)
		}
		seen[v.Key] = true
	}
	if !seen["A"] || !seen["B"] {
		t.Fatalf("expected both arms across step positions, saw %v", seen)
	}
}

func TestAssignVariantRespectsWeights(t *testing.T) {
	// 90/10 split over 2000 distinct subscribers should land roughly
	// 90% in the heavy arm. Allow a generous tolerance band; the test
	// guards against inverted or ignored weights, not exact uniformity.
	variants := []EmailVariant{
		{Key: "heavy", Subject: "s", Body: "b", WeightBP: 9000},
		{Key: "light", Subject: "s", Body: "b", WeightBP: 1000},
	}
	heavy := 0
	const n = 2000
	for i := 0; i < n; i++ {
		email := "user" + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + "-" + itoa(i) + "@example.com"
		v, err := AssignVariant("seq-w", 1, email, variants)
		if err != nil {
			t.Fatalf("AssignVariant: %v", err)
		}
		if v.Key == "heavy" {
			heavy++
		}
	}
	ratio := float64(heavy) / float64(n)
	if ratio < 0.85 || ratio > 0.95 {
		t.Fatalf("heavy-arm ratio = %.3f, want ~0.90", ratio)
	}
}

func TestAssignVariantErrors(t *testing.T) {
	if _, err := AssignVariant("seq", 1, "a@b.c", nil); err != ErrNoVariants {
		t.Fatalf("nil variants: err = %v, want ErrNoVariants", err)
	}
	bad := []EmailVariant{
		{Key: "a", Subject: "s", Body: "b", WeightBP: 4000},
		{Key: "b", Subject: "s", Body: "b", WeightBP: 4000},
	}
	if _, err := AssignVariant("seq", 1, "a@b.c", bad); err == nil {
		t.Fatal("invalid weights: expected error")
	}
}

// itoa is shared with engine_test.go in this package.
