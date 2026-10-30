package profile

import "testing"

func TestPickRepresentative_RespectsBudget(t *testing.T) {
	samples := []Sample{
		{ID: "a", Text: "the quick brown fox jumps over the lazy dog one two three", Tokens: 600, Weight: 0.9},
		{ID: "b", Text: "completely different content about birds flying south for the winter", Tokens: 400, Weight: 0.8},
		{ID: "c", Text: "yet another distinct passage about cooking risotto with saffron", Tokens: 500, Weight: 0.7},
		{ID: "d", Text: "the quick brown fox jumps over the lazy dog one two three", Tokens: 600, Weight: 0.6}, // dup of a
	}
	got := PickRepresentative(samples, 1100)
	total := 0
	for _, s := range got {
		total += s.Tokens
	}
	if total > 1100 {
		t.Errorf("budget exceeded: %d", total)
	}
	if len(got) == 0 {
		t.Fatalf("expected at least one sample")
	}
	// Highest-weight sample should be first.
	if got[0].ID != "a" {
		t.Errorf("expected 'a' first, got %q", got[0].ID)
	}
	// Diversity guard: 'd' must not be picked because it duplicates 'a'.
	for _, s := range got {
		if s.ID == "d" {
			t.Errorf("duplicate sample 'd' selected; diversity guard failed")
		}
	}
}

func TestPickRepresentative_EmptyOrZeroBudget(t *testing.T) {
	if got := PickRepresentative(nil, 100); got != nil {
		t.Errorf("nil input should yield nil")
	}
	if got := PickRepresentative([]Sample{{Tokens: 10, Weight: 1}}, 0); got != nil {
		t.Errorf("zero budget should yield nil")
	}
}
