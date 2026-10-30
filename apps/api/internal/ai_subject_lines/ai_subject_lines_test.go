package ai_subject_lines

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
)

// fakeVoice mirrors aicompose_test's fakeVoice but is local so we
// don't take a test-only dependency on internal symbols. The package
// under test calls Composer.Voice.Generate directly (not
// Composer.ComposeVariants), so the shape we need is the same.
type fakeVoice struct {
	mu       sync.Mutex
	call     int32
	subjects []string
	fail     error
}

func (f *fakeVoice) Generate(_ context.Context, _ string, kind aicompose.ChatKind, _, _ string) (aicompose.GenerateResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return aicompose.GenerateResult{}, f.fail
	}
	if kind != aicompose.KindSubjectLine {
		return aicompose.GenerateResult{Text: "unexpected kind"}, nil
	}
	idx := int(atomic.AddInt32(&f.call, 1)) - 1
	if idx < len(f.subjects) {
		return aicompose.GenerateResult{Text: f.subjects[idx]}, nil
	}
	return aicompose.GenerateResult{Text: fmt.Sprintf("Generated subject %d", idx+1)}, nil
}

func newDeps(v *fakeVoice) *Deps {
	return &Deps{Composer: aicompose.New(v)}
}

func TestSanitizeSubject_StripsQuotesAndPrefixes(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{`"Black Friday is here"`, "Black Friday is here"},
		{"1. Get 50% off this weekend", "Get 50% off this weekend"},
		{"Subject: Limited time offer", "Limited time offer"},
		{"  multi\nline\nresponse", "multi"},
		{"“curly quotes”", "curly quotes"},
		{"- bullet line", "bullet line"},
	}
	for _, c := range cases {
		got := sanitizeSubject(c.in)
		if got != c.want {
			t.Errorf("sanitizeSubject(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeSubject_CapsLength(t *testing.T) {
	in := strings.Repeat("x", 300)
	got := sanitizeSubject(in)
	if len([]rune(got)) > 200 {
		t.Errorf("sanitizeSubject returned %d runes, expected ≤200", len([]rune(got)))
	}
}

func TestDedupeNonEmpty_PreservesOrderCaseFold(t *testing.T) {
	in := []string{"Black Friday", "", "black friday", "Cyber Monday", "BLACK FRIDAY", "Cyber Monday"}
	got := dedupeNonEmpty(in)
	want := []string{"Black Friday", "Cyber Monday"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("got[%d]=%q want %q", i, got[i], want[i])
		}
	}
}

func TestGenerate_HappyPath_ReturnsThreeDistinctCandidates(t *testing.T) {
	v := &fakeVoice{subjects: []string{
		"Black Friday is here — 50% off everything",
		"Don't miss your VIP access this weekend",
		"Cyber Monday preview: a sneak peek inside",
	}}
	d := newDeps(v)
	out, err := d.generate(context.Background(), "tenant1", "announce black friday sale", "witty", "paid annual subscribers", 3)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(out.Candidates) != 3 {
		t.Fatalf("want 3 candidates, got %d: %v", len(out.Candidates), out.Candidates)
	}
	if out.Fallback {
		t.Errorf("happy path should not set fallback=true")
	}
	if out.GeneratedAt.IsZero() {
		t.Errorf("GeneratedAt should be set")
	}
}

func TestGenerate_DedupesIdenticalCandidates(t *testing.T) {
	v := &fakeVoice{subjects: []string{
		"Black Friday is here",
		"black friday is here",
		"Black Friday is here",
	}}
	d := newDeps(v)
	out, err := d.generate(context.Background(), "tenant1", "announce black friday sale", "", "", 3)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	// Three identical (case-folded) responses → one unique candidate.
	// generate then backfills with prompt-derived placeholders since
	// we asked for 3, so we should see Fallback=true.
	if !out.Fallback {
		t.Errorf("expected Fallback=true when dedup reduced count")
	}
	if len(out.Candidates) != 3 {
		t.Errorf("want 3 candidates (1 real + 2 backfilled), got %d", len(out.Candidates))
	}
}

func TestGenerate_PropagatesVoiceUnavailable(t *testing.T) {
	v := &fakeVoice{fail: aicompose.ErrVoiceUnavailable}
	d := newDeps(v)
	_, err := d.generate(context.Background(), "tenant1", "announce black friday sale", "", "", 3)
	if err == nil {
		t.Fatalf("expected error when voice is unavailable")
	}
	if err != aicompose.ErrVoiceUnavailable {
		t.Errorf("expected ErrVoiceUnavailable, got %v", err)
	}
}

func TestParseIntQuery_BoundsAndDefaults(t *testing.T) {
	cases := []struct {
		raw               string
		def, lo, hi, want int
	}{
		{"", 90, 7, 365, 90},
		{"junk", 90, 7, 365, 90},
		{"5", 90, 7, 365, 7},
		{"500", 90, 7, 365, 365},
		{"30", 90, 7, 365, 30},
	}
	for _, c := range cases {
		got := parseIntQuery(c.raw, c.def, c.lo, c.hi)
		if got != c.want {
			t.Errorf("parseIntQuery(%q,%d,%d,%d) = %d, want %d", c.raw, c.def, c.lo, c.hi, got, c.want)
		}
	}
}
