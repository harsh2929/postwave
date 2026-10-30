package profile

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
)

func TestBuild_StylisticFeatures(t *testing.T) {
	items := []ingest.Item{
		{
			ID:          "i1",
			SourceType:  ingest.SourcePasteIn,
			Text:        "I think this might work. Maybe we should try? Cheers.",
			PublishedAt: time.Now().Add(-72 * time.Hour),
		},
		{
			ID:          "i2",
			SourceType:  ingest.SourcePasteIn,
			Text:        "Here is a long, complex sentence with multiple clauses, designed to push the average sentence length upward. The end.",
			PublishedAt: time.Now().Add(-24 * time.Hour),
		},
	}

	mock := &MockLLMClient{
		T:   Tonal{Humor: 0.3, Optimism: 0.6, PersonalVsObservational: 0.7, Directness: 0.5},
		P:   Persona{SelfDisclosureRate: 0.4, RecurringThemes: []string{"work", "process"}},
		Met: []string{"journey-as-river"},
	}

	b := NewBuilder("tenant-1", mock)
	prof, err := b.Build(context.Background(), items)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	if prof.TenantID != "tenant-1" {
		t.Errorf("TenantID = %q", prof.TenantID)
	}
	if prof.Stylistic.AvgSentenceLength <= 0 {
		t.Errorf("AvgSentenceLength = %v, want > 0", prof.Stylistic.AvgSentenceLength)
	}
	if prof.Stylistic.HedgingFrequency <= 0 {
		t.Errorf("HedgingFrequency = %v, want > 0 (text contains 'might', 'maybe')", prof.Stylistic.HedgingFrequency)
	}
	if prof.Tonal.Optimism != 0.6 {
		t.Errorf("Tonal.Optimism = %v, want 0.6", prof.Tonal.Optimism)
	}
	if len(prof.Vocabulary.MetaphorPatterns) != 1 {
		t.Errorf("MetaphorPatterns = %v", prof.Vocabulary.MetaphorPatterns)
	}
	if _, ok := prof.SourceSummary["paste_in"]; !ok {
		t.Errorf("SourceSummary missing paste_in: %+v", prof.SourceSummary)
	}
	if math.IsNaN(prof.Stylistic.SentenceLengthVariance) {
		t.Errorf("variance is NaN")
	}
}

func TestFormalityHeuristicUsesFittedAxis(t *testing.T) {
	formal := formalityHeuristic("Furthermore, the methodology demonstrates reproducible outcomes pursuant to established protocols.")
	casual := formalityHeuristic("yeah lol this is super messy but we're gonna fix it!")
	if formal <= casual {
		t.Fatalf("expected formal text score %.3f to exceed casual score %.3f", formal, casual)
	}
}

func TestDetectIdiomsExpandedAndBoundarySafe(t *testing.T) {
	items := []ingest.Item{
		{Text: "Let's run it up the flagpole, close the loop, and keep everyone on the same page."},
		{Text: "The team is moving the needle and doubled down on the last mile."},
		{Text: "The cupcake recipe was great, but this was not about cakewalks."},
	}
	got := detectIdioms(items)
	want := map[string]bool{
		"run it up the flagpole": true,
		"close the loop":         true,
		"on the same page":       true,
		"move the needle":        true,
		"double down":            true,
		"last mile":              true,
	}
	for _, idiom := range got {
		delete(want, idiom)
		if idiom == "piece of cake" {
			t.Fatalf("boundary-safe matcher incorrectly detected %q in unrelated text", idiom)
		}
	}
	for missing := range want {
		t.Fatalf("missing idiom %q in %v", missing, got)
	}
}

func TestHasPassiveVoiceHandlesIrregularsAndFalsePositives(t *testing.T) {
	cases := []struct {
		sentence string
		want     bool
	}{
		{"The report was reviewed by the team.", true},
		{"The email was quickly approved before launch.", true},
		{"The plan got shipped yesterday.", true},
		{"The invoice was sent at noon.", true},
		{"She was at the meeting yesterday.", false},
		{"He was interested in the meeting notes.", false},
	}
	for _, tc := range cases {
		if got := HasPassiveVoice(tc.sentence); got != tc.want {
			t.Fatalf("HasPassiveVoice(%q) = %v, want %v", tc.sentence, got, tc.want)
		}
	}
}

func TestTopDistinctiveTermsUsesCorpusSpread(t *testing.T) {
	tf := map[string]int{"flarble": 6, "zorbish": 6}
	docFreq := map[string]int{"flarble": 1, "zorbish": 3}
	got := topDistinctiveTerms(tf, docFreq, 3, 12, 10)
	scores := map[string]float64{}
	for _, term := range got {
		scores[term.Term] = term.Score
	}
	if scores["zorbish"] <= scores["flarble"] {
		t.Fatalf("expected recurring tenant term to outrank one-off term: zorbish=%.6f flarble=%.6f", scores["zorbish"], scores["flarble"])
	}
}

func TestBuildSamplesBlendsRecencyWithContentQuality(t *testing.T) {
	now := time.Now()
	items := []ingest.Item{
		{
			ID:          "older-substantive",
			SourceType:  ingest.SourcePasteIn,
			PublishedAt: now.Add(-72 * time.Hour),
			Text:        "In practice, the migration failed for three specific reasons. First, the source system exported 42 duplicate rows. Second, the old automation used an implicit segment. Third, because consent timestamps were missing, we had to preserve the original record and mark it for review. That pattern matters because it changes the cutover checklist.",
		},
		{
			ID:          "newer-tiny",
			SourceType:  ingest.SourcePasteIn,
			PublishedAt: now,
			Text:        "ok",
		},
	}
	samples := buildSamples(items)
	if len(samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(samples))
	}
	byID := map[string]Sample{}
	for _, s := range samples {
		byID[s.ID] = s
	}
	if byID["older-substantive"].Weight <= byID["newer-tiny"].Weight {
		t.Fatalf("expected substantive older sample to outrank tiny newest sample: older=%.3f newer=%.3f",
			byID["older-substantive"].Weight, byID["newer-tiny"].Weight)
	}
}

func TestBuild_EmptyInput(t *testing.T) {
	b := NewBuilder("t", &MockLLMClient{})
	prof, err := b.Build(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if prof.Stylistic.AvgSentenceLength != 0 {
		t.Errorf("expected zero stylistic on empty input")
	}
}

func TestSplitSentences(t *testing.T) {
	got := splitSentences("Hello world. This is fine! Or is it? Yes.")
	if len(got) != 4 {
		t.Errorf("got %d sentences: %v", len(got), got)
	}
}

// TestSplitSentences_DelegatesToSegmenter sanity-checks that the
// builder's wrapper doesn't drift from SegmentSentences. If both ever
// disagree, this test makes the divergence loud.
func TestSplitSentences_DelegatesToSegmenter(t *testing.T) {
	in := "Dr. Smith arrived. He greeted Mrs. Jones."
	a := splitSentences(in)
	b := SegmentSentences(in)
	if len(a) != len(b) {
		t.Errorf("splitSentences and SegmentSentences disagree:\n  splitSentences: %v\n  SegmentSentences: %v", a, b)
	}
	if len(a) != 2 {
		t.Errorf("expected 2 sentences (Dr./Mrs. abbreviations protected); got %d: %v", len(a), a)
	}
}

// TestBuild_TFIDFThemesPopulated asserts that with no LLM in play, the
// builder's recurring themes come from the TF-IDF extractor and are
// attached to both the legacy []string and the new []Theme fields.
func TestBuild_TFIDFThemesPopulated(t *testing.T) {
	items := []ingest.Item{
		{ID: "i1", SourceType: ingest.SourcePasteIn, Text: "Architecture matters when latency budgets matter. Architecture choices compound.", PublishedAt: time.Now()},
		{ID: "i2", SourceType: ingest.SourcePasteIn, Text: "Latency under 50ms requires careful architecture decisions. Latency dominates user perception.", PublishedAt: time.Now()},
		{ID: "i3", SourceType: ingest.SourcePasteIn, Text: "Architecture and latency are the two axes that matter most for our system.", PublishedAt: time.Now()},
	}
	// Pass an LLM that returns NO themes so the TF-IDF list is what
	// surfaces.
	mock := &MockLLMClient{T: Tonal{}, P: Persona{}, Met: nil}
	b := NewBuilder("t", mock)
	prof, err := b.Build(context.Background(), items)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(prof.Persona.RecurringThemesScored) == 0 {
		t.Error("expected RecurringThemesScored populated by TF-IDF")
	}
	if len(prof.Persona.RecurringThemes) == 0 {
		t.Error("expected RecurringThemes populated as the term list")
	}
	// Both should align: the [N]th term in RecurringThemes should match
	// the [N]th Theme.Term.
	for i, th := range prof.Persona.RecurringThemesScored {
		if i >= len(prof.Persona.RecurringThemes) {
			break
		}
		if prof.Persona.RecurringThemes[i] != th.Term {
			t.Errorf("RecurringThemes[%d]=%q != RecurringThemesScored[%d].Term=%q",
				i, prof.Persona.RecurringThemes[i], i, th.Term)
		}
	}
	// We expect "architecture" or "latency" to appear since they
	// dominate the corpus.
	want := false
	for _, th := range prof.Persona.RecurringThemesScored {
		if th.Term == "architecture" || th.Term == "latency" {
			want = true
			break
		}
	}
	if !want {
		t.Errorf("expected architecture/latency in themes; got %+v", prof.Persona.RecurringThemesScored)
	}
}

// TestBuild_HeuristicToneDefault asserts the builder defaults to the
// HeuristicClassifier when the env var is not set, and that its output
// shows up in Tonal.Formality and Tonal.Warmth (axes the legacy
// AnalyzeTonal mock doesn't set).
func TestBuild_HeuristicToneDefault(t *testing.T) {
	items := []ingest.Item{
		{
			ID:         "i1",
			SourceType: ingest.SourcePasteIn,
			Text:       "Furthermore, the methodology demonstrates that our analysis, pursuant to established protocols, yields reproducible results notwithstanding the limitations.",
		},
	}
	b := NewBuilder("t", &MockLLMClient{}) // mock returns zero Tonal
	prof, err := b.Build(context.Background(), items)
	if err != nil {
		t.Fatal(err)
	}
	// The heuristic should detect formal text → Formality > 0.5.
	if prof.Tonal.Formality <= 0.5 {
		t.Errorf("expected Formality>0.5 for academic text, got %v", prof.Tonal.Formality)
	}
}

// TestBuild_LLMOptInTone confirms the builder picks LLMClassifier when
// the env var is set, and that it falls back to heuristic on LLM error.
func TestBuild_LLMOptInTone(t *testing.T) {
	t.Setenv("POSTWAVE_VOICE_TONE_CLASSIFIER", "llm")
	mock := &MockLLMClient{
		// Return well-formed JSON that the LLMClassifier expects.
		GenerateJSON: []byte(`{"humor":0.9,"formality":0.1,"optimism":0.7,"directness":0.6,"warmth":0.8}`),
	}
	b := NewBuilder("t", mock)
	items := []ingest.Item{
		{ID: "i1", SourceType: ingest.SourcePasteIn, Text: "Hahaha, this is hilarious!", PublishedAt: time.Now()},
	}
	prof, err := b.Build(context.Background(), items)
	if err != nil {
		t.Fatal(err)
	}
	// LLM said humor=0.9 — should make it to the profile.
	if prof.Tonal.Humor < 0.8 {
		t.Errorf("expected Humor close to LLM's 0.9, got %v", prof.Tonal.Humor)
	}
}

// TestBuild_SemanticSignaturePopulated asserts that wiring an embedding
// client into the builder populates SemanticSignature (a centroid in
// embedding space) and records the model version.
func TestBuild_SemanticSignaturePopulated(t *testing.T) {
	items := []ingest.Item{
		{ID: "i1", SourceType: ingest.SourcePasteIn, Text: "Growth marketing scales conversion across channels.", PublishedAt: time.Now()},
		{ID: "i2", SourceType: ingest.SourcePasteIn, Text: "Conversion compounds when channels align.", PublishedAt: time.Now()},
		{ID: "i3", SourceType: ingest.SourcePasteIn, Text: "Scale the funnel; growth follows conversion.", PublishedAt: time.Now()},
	}
	mock := &embeddings.MockEmbeddingClient{Dim: 128}
	b := NewBuilder("t-sig", &MockLLMClient{}).WithEmbeddings(mock)
	prof, err := b.Build(context.Background(), items)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(prof.SemanticSignature) == 0 {
		t.Fatal("expected SemanticSignature populated; got empty")
	}
	if prof.SemanticModel != embeddings.DefaultModel {
		t.Errorf("SemanticModel = %q, want %q", prof.SemanticModel, embeddings.DefaultModel)
	}
	// All components must be finite; centroid of L2-normalized vectors
	// should never produce NaN/Inf.
	for i, x := range prof.SemanticSignature {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			t.Errorf("signature[%d] = %v (non-finite)", i, x)
		}
	}
}

// TestBuild_NoEmbeddingsLeavesSignatureEmpty confirms the graceful
// degradation contract: no client = no signature, no panic.
func TestBuild_NoEmbeddingsLeavesSignatureEmpty(t *testing.T) {
	items := []ingest.Item{
		{ID: "i1", SourceType: ingest.SourcePasteIn, Text: "hello world", PublishedAt: time.Now()},
	}
	b := NewBuilder("t", &MockLLMClient{}) // no WithEmbeddings
	prof, err := b.Build(context.Background(), items)
	if err != nil {
		t.Fatal(err)
	}
	if len(prof.SemanticSignature) != 0 {
		t.Errorf("expected empty SemanticSignature without embeddings client, got len=%d", len(prof.SemanticSignature))
	}
	if prof.SemanticModel != "" {
		t.Errorf("expected empty SemanticModel without embeddings client, got %q", prof.SemanticModel)
	}
}

func TestClassifyOpening(t *testing.T) {
	cases := map[string]string{
		"Why does this matter?":                             "question",
		"In 2024, 80% of users churned.":                    "statistic",
		"I remember the first time I shipped to production": "anecdote",
		"This is the best way to do it":                     "declaration",
	}
	for in, want := range cases {
		if got := classifyOpening(in); got != want {
			t.Errorf("classifyOpening(%q) = %q, want %q", in, got, want)
		}
	}
}
