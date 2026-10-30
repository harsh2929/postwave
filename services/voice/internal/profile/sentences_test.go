package profile

import (
	"strings"
	"testing"
)

// Each test case states what the naive `[.!?]\s+[A-Z]` regex would
// produce vs what the improved segmenter should produce. The "broken"
// expectation is documented inline so a reviewer can sanity-check that
// the new behavior is actually better.
func TestSegmentSentences(t *testing.T) {
	cases := []struct {
		name string
		in   string
		// want is the exact desired sentence list.
		want []string
		// brokenWould is what the old regex segmenter produces (informational
		// only — used in the failure message to make the bug visible).
		brokenWould []string
	}{
		{
			name:        "simple two sentences",
			in:          "Hello world. This is fine.",
			want:        []string{"Hello world.", "This is fine."},
			brokenWould: []string{"Hello world.", "This is fine."},
		},
		{
			name:        "title abbreviation Dr.",
			in:          "Dr. Smith arrived early. He greeted Mrs. Jones at the door.",
			want:        []string{"Dr. Smith arrived early.", "He greeted Mrs. Jones at the door."},
			brokenWould: []string{"Dr.", "Smith arrived early.", "He greeted Mrs.", "Jones at the door."},
		},
		{
			name:        "corporate suffix Inc.",
			in:          "We acquired Acme Inc. Last quarter the deal closed.",
			want:        []string{"We acquired Acme Inc.", "Last quarter the deal closed."},
			brokenWould: []string{"We acquired Acme Inc.", "Last quarter the deal closed."},
		},
		{
			name:        "Latin abbrev e.g.",
			in:          "Use small models, e.g. Haiku for quick tasks. Keep budgets tight.",
			want:        []string{"Use small models, e.g. Haiku for quick tasks.", "Keep budgets tight."},
			brokenWould: []string{"Use small models, e.g.", "Haiku for quick tasks.", "Keep budgets tight."},
		},
		{
			name:        "Latin abbrev i.e.",
			in:          "Pick the cheapest path, i.e. cache-only. Then measure latency.",
			want:        []string{"Pick the cheapest path, i.e. cache-only.", "Then measure latency."},
			brokenWould: []string{"Pick the cheapest path, i.e.", "cache-only. Then measure latency."},
		},
		{
			name:        "ellipsis preserved",
			in:          "I was going to say... Then I changed my mind.",
			want:        []string{"I was going to say...", "Then I changed my mind."},
			brokenWould: []string{"I was going to say... Then I changed my mind."},
		},
		{
			name:        "URL preserved",
			in:          "Check https://example.com/foo. Then ping me back.",
			want:        []string{"Check https://example.com/foo.", "Then ping me back."},
			brokenWould: []string{"Check https://example.", "com/foo.", "Then ping me back."},
		},
		{
			name:        "decimal preserved",
			in:          "GDP grew 3.14 percent. That beats expectations.",
			want:        []string{"GDP grew 3.14 percent.", "That beats expectations."},
			brokenWould: []string{"GDP grew 3.14 percent.", "That beats expectations."},
		},
		{
			name:        "U.S. country abbreviation",
			in:          "She moved from the U.S. to Canada last year.",
			want:        []string{"She moved from the U.S. to Canada last year."},
			brokenWould: []string{"She moved from the U.S. to Canada last year."},
		},
		{
			name:        "initialism can end sentence",
			in:          "I went to D.C. The next morning we shipped.",
			want:        []string{"I went to D.C.", "The next morning we shipped."},
			brokenWould: []string{"I went to D.C. The next morning we shipped."},
		},
		{
			name:        "casual lowercase sentence start",
			in:          "We shipped the patch. then we measured again.",
			want:        []string{"We shipped the patch.", "then we measured again."},
			brokenWould: []string{"We shipped the patch. then we measured again."},
		},
		{
			name:        "a.m. time of day",
			in:          "The flight leaves at 6 a.m. Tomorrow is going to be long.",
			want:        []string{"The flight leaves at 6 a.m.", "Tomorrow is going to be long."},
			brokenWould: []string{"The flight leaves at 6 a.m.", "Tomorrow is going to be long."},
		},
		{
			name:        "exclamation and question",
			in:          "What a day! Did you see the news? Yes I did.",
			want:        []string{"What a day!", "Did you see the news?", "Yes I did."},
			brokenWould: []string{"What a day!", "Did you see the news?", "Yes I did."},
		},
		{
			name:        "initials in name",
			in:          "J. R. R. Tolkien wrote The Hobbit. The book is great.",
			want:        []string{"J. R. R. Tolkien wrote The Hobbit.", "The book is great."},
			brokenWould: []string{"J.", "R.", "R.", "Tolkien wrote The Hobbit.", "The book is great."},
		},
		{
			name:        "month abbreviation",
			in:          "We met in Jan. The trip was unforgettable.",
			want:        []string{"We met in Jan.", "The trip was unforgettable."},
			brokenWould: []string{"We met in Jan.", "The trip was unforgettable."},
		},
		{
			name:        "Latin etc.",
			in:          "We ship apples, oranges, etc. Then we close the warehouse.",
			want:        []string{"We ship apples, oranges, etc.", "Then we close the warehouse."},
			brokenWould: []string{"We ship apples, oranges, etc.", "Then we close the warehouse."},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SegmentSentences(tc.in)
			if !equalStrings(got, tc.want) {
				t.Errorf("SegmentSentences(%q)\n got: %q\nwant: %q\n(naive regex would have produced: %q)",
					tc.in, got, tc.want, tc.brokenWould)
			}
		})
	}
}

func TestSegmentSentences_Empty(t *testing.T) {
	if got := SegmentSentences(""); got != nil {
		t.Errorf("empty input: got %v, want nil", got)
	}
	if got := SegmentSentences("   \n  "); got != nil {
		t.Errorf("whitespace-only input: got %v, want nil", got)
	}
}

func TestRestoreInitialismSentenceBoundaries(t *testing.T) {
	masked := hardAbbrevRe.ReplaceAllStringFunc("I went to D.C. The next morning.", maskPeriods)
	restored := restoreInitialismSentenceBoundaries(masked)
	if !strings.Contains(restored, "D"+sentinelStr+"C. The") {
		t.Fatalf("restoreInitialismSentenceBoundaries(%q) = %q", masked, restored)
	}
	soft := softAbbrevRe.ReplaceAllStringFunc(restored, softAbbrevReplacer)
	withBoundaries := boundaryRe.ReplaceAllString(soft, "$1\x1f$3")
	if !strings.Contains(withBoundaries, "\x1f") {
		t.Fatalf("boundary not inserted: masked=%q restored=%q soft=%q boundary=%q", masked, restored, soft, withBoundaries)
	}
}

func TestSegmentSentences_NoSentinelLeak(t *testing.T) {
	// If the text contains a literal sentinel rune, it must round-trip
	// unchanged after restore (we only replace the in-mask sentinel back
	// to '.', so an original sentinel is also turned into '.'; that's a
	// known accepted lossy edge).
	in := "Hello. World."
	got := SegmentSentences(in)
	for _, s := range got {
		if strings.ContainsRune(s, sentinel) {
			t.Errorf("sentinel rune leaked into output: %q", s)
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
