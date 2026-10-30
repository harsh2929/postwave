package public

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"

	tone_corpus "github.com/postwave/postwave/services/voice/internal/profile/tone_corpus"
)

// The composite tests use synthetic on-disk fixtures (not the real
// corpora) so the test suite runs without network access and without
// the operator-fetched cache. We write minimal valid samples for each
// dataset into a temp dir and assert the merger does the right thing.

func TestBuildCompositeCorpus_EmptyCache(t *testing.T) {
	// All five corpora missing — composite should return zero
	// samples and a zero stats struct, NOT an error.
	dir := t.TempDir()
	samples, stats, err := BuildCompositeCorpus(context.Background(), dir)
	if err != nil {
		t.Fatalf("BuildCompositeCorpus on empty dir: %v", err)
	}
	if len(samples) != 0 {
		t.Errorf("samples=%d, want 0 (empty cache)", len(samples))
	}
	if stats.Total != 0 {
		t.Errorf("stats.Total=%d, want 0", stats.Total)
	}
}

func TestBuildCompositeCorpus_ShortJokesOnly(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "short_jokes", "shortjokes.csv"),
		"ID,Joke\n1,Why did the chicken cross the road? To get to the other side.\n2,Knock knock. Who is there? A dad joke and it is bad.\n")

	samples, stats, err := BuildCompositeCorpus(context.Background(), dir)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if stats.ShortJokes != 2 {
		t.Errorf("ShortJokes=%d, want 2", stats.ShortJokes)
	}
	if len(samples) != 2 {
		t.Errorf("samples=%d, want 2", len(samples))
	}
	for _, s := range samples {
		if s.Humor != 0.9 {
			t.Errorf("joke sample Humor=%.2f, want 0.9", s.Humor)
		}
		// Other axes should be the unknown sentinel.
		for _, v := range []float64{s.Formality, s.Optimism, s.Directness, s.Warmth} {
			if AxisIsKnown(v) {
				t.Errorf("non-humor axis on joke sample: got %.3f, want AxisKnown sentinel", v)
			}
		}
	}
}

func TestBuildCompositeCorpus_GYAFCPairs(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "gyafc", "Family_Relationships", "train")
	mustWriteFile(t, filepath.Join(base, "formal"),
		"This is a well-considered and articulate explanation of the matter.\nFurthermore, the analysis demonstrates the desired outcome.\n")
	mustWriteFile(t, filepath.Join(base, "informal"),
		"yeah this is like, a thing i guess lol\nidk man, it works i think\n")

	samples, stats, err := BuildCompositeCorpus(context.Background(), dir)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if stats.GYAFCFormal != 2 || stats.GYAFCInformal != 2 {
		t.Errorf("GYAFC formal=%d informal=%d, want 2/2", stats.GYAFCFormal, stats.GYAFCInformal)
	}
	if len(samples) != 4 {
		t.Errorf("samples=%d, want 4", len(samples))
	}
	// Check the formality polarity is right: 2 samples at 0.9, 2 at 0.1.
	high, low := 0, 0
	for _, s := range samples {
		switch s.Formality {
		case 0.9:
			high++
		case 0.1:
			low++
		default:
			t.Errorf("unexpected GYAFC formality label %.2f", s.Formality)
		}
	}
	if high != 2 || low != 2 {
		t.Errorf("formality split high=%d low=%d, want 2/2", high, low)
	}
}

func TestBuildCompositeCorpus_GoEmotionsAxisMap(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "goemotions", "goemotions_1.csv"),
		"text,id,author,subreddit,link_id,parent_id,created_utc,rater_id,example_very_unclear,"+
			joinFields(goEmotionsLabelColumns)+"\n"+
			// Row 1: joy → warmth=0.9, optimism=0.9
			`"I'm so happy today!",1,a,b,c,d,e,f,0,`+bitmapWithOne("joy")+"\n"+
			// Row 2: anger → warmth=0.1, optimism=0.1, humor=0.1
			`"This is infuriating, I cannot stand it.",2,a,b,c,d,e,f,0,`+bitmapWithOne("anger")+"\n")

	samples, stats, err := BuildCompositeCorpus(context.Background(), dir)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if stats.GoEmotionsWarmth < 2 {
		t.Errorf("GoEmotions warmth=%d, want >=2", stats.GoEmotionsWarmth)
	}
	// Find the joy and anger samples and assert their labels.
	var joy, anger *tone_corpus.LabeledSample
	for i := range samples {
		s := &samples[i]
		switch s.Warmth {
		case 0.9:
			joy = s
		case 0.1:
			anger = s
		}
	}
	if joy == nil {
		t.Fatalf("missing joy sample (warmth=0.9)")
	}
	if anger == nil {
		t.Fatalf("missing anger sample (warmth=0.1)")
	}
	if math.Abs(joy.Optimism-0.9) > 1e-9 {
		t.Errorf("joy.Optimism=%.3f, want 0.9", joy.Optimism)
	}
	if math.Abs(anger.Humor-0.1) > 1e-9 {
		t.Errorf("anger.Humor=%.3f (want 0.1) — anti-humor signal missing", anger.Humor)
	}
}

func TestBuildCompositeCorpus_PolitenessDirectness(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "politeness", "utterances.csv"),
		"Request,Normalized Score\n"+
			`"Hey could you maybe possibly take a look at this when you get a moment?",1.5`+"\n"+
			`"Do it now.",-1.5`+"\n")

	samples, stats, err := BuildCompositeCorpus(context.Background(), dir)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if stats.Politeness != 2 {
		t.Errorf("Politeness=%d, want 2", stats.Politeness)
	}
	// Polite → low directness, impolite → high directness.
	var polite, impolite *tone_corpus.LabeledSample
	for i := range samples {
		s := &samples[i]
		if s.Directness < 0.3 {
			polite = s
		} else if s.Directness > 0.7 {
			impolite = s
		}
	}
	if polite == nil {
		t.Errorf("missing polite-side sample with directness < 0.3 (got %+v)", samples)
	}
	if impolite == nil {
		t.Errorf("missing impolite-side sample with directness > 0.7 (got %+v)", samples)
	}
}

func TestBuildCompositeCorpus_Sentiment140(t *testing.T) {
	dir := t.TempDir()
	// Sentiment140 CSV is headerless — 6 columns, polarity in col 0,
	// text in col 5.
	mustWriteFile(t, filepath.Join(dir, "sentiment140", "training.1600000.processed.noemoticon.csv"),
		`"4","1","date","NO_QUERY","user","I love sunshine and ice cream"`+"\n"+
			`"0","2","date","NO_QUERY","user","Everything is broken and terrible today"`+"\n")
	samples, stats, err := BuildCompositeCorpus(context.Background(), dir)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if stats.Sentiment140 != 2 {
		t.Errorf("Sentiment140=%d, want 2", stats.Sentiment140)
	}
	var pos, neg *tone_corpus.LabeledSample
	for i := range samples {
		s := &samples[i]
		if s.Optimism == 0.85 {
			pos = s
		} else if s.Optimism == 0.15 {
			neg = s
		}
	}
	if pos == nil {
		t.Errorf("missing positive sentiment140 sample")
	}
	if neg == nil {
		t.Errorf("missing negative sentiment140 sample")
	}
}

func TestAxisIsKnown(t *testing.T) {
	if !AxisIsKnown(0.9) {
		t.Errorf("0.9 should be known")
	}
	if AxisIsKnown(AxisKnown) {
		t.Errorf("AxisKnown sentinel should be unknown")
	}
	if AxisIsKnown(0.5) {
		t.Errorf("0.5 (== AxisKnown) should be unknown")
	}
}

func TestScoreToDirectness(t *testing.T) {
	cases := []struct {
		score float64
		want  float64
	}{
		{2.0, 0.0},
		{-2.0, 1.0},
		{0.0, 0.5},
		{1.0, 0.25},
		{-1.0, 0.75},
		{5.0, 0.0},  // clamp top
		{-5.0, 1.0}, // clamp bottom
	}
	for _, c := range cases {
		got := scoreToDirectness(c.score)
		if math.Abs(got-c.want) > 1e-9 {
			t.Errorf("scoreToDirectness(%v)=%v, want %v", c.score, got, c.want)
		}
	}
}

// ----- test helpers -----

func mustWriteFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// joinFields returns the comma-joined column names for the
// GoEmotions header row.
func joinFields(cols []string) string {
	out := ""
	for i, c := range cols {
		if i > 0 {
			out += ","
		}
		out += c
	}
	return out
}

// bitmapWithOne returns a comma-separated 28-wide bitmap with 1 set
// only at the column matching target.
func bitmapWithOne(target string) string {
	out := ""
	for i, c := range goEmotionsLabelColumns {
		if i > 0 {
			out += ","
		}
		if c == target {
			out += "1"
		} else {
			out += "0"
		}
	}
	return out
}
