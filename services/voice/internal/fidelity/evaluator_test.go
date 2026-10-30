package fidelity

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/profile"
)

func TestCosine_IdenticalVectors(t *testing.T) {
	a := []float64{1, 0, 0, 0}
	if got := cosine(a, a); math.Abs(got-1.0) > 1e-9 {
		t.Fatalf("cosine of identical vectors = %v, want 1", got)
	}
}

func TestCosine_OrthogonalVectors(t *testing.T) {
	a := []float64{1, 0}
	b := []float64{0, 1}
	if got := cosine(a, b); math.Abs(got) > 1e-9 {
		t.Fatalf("cosine of orthogonal vectors = %v, want 0", got)
	}
}

func TestStylisticSimilarity_PerfectMatchScoresHigh(t *testing.T) {
	text := "Quick note. Two short sentences. One paragraph.\n\nSecond paragraph. Same shape."
	prof := profile.Stylistic{
		AvgSentenceLength:      3,
		SentenceLengthVariance: 0.5,
		AvgParagraphLength:     2.5,
		FormalityScore:         0.4,
		HedgingFrequency:       0,
		PassiveVoicePct:        0,
	}
	score := stylisticSimilarity(text, prof)
	if score < 0.6 {
		t.Fatalf("stylisticSimilarity = %v, want >= 0.6", score)
	}
}

func TestStylisticSimilarity_DistantProfileScoresLow(t *testing.T) {
	text := "Hi. Bye."
	prof := profile.Stylistic{
		AvgSentenceLength:      35,
		SentenceLengthVariance: 90,
		AvgParagraphLength:     7,
		FormalityScore:         1,
		HedgingFrequency:       40,
		PassiveVoicePct:        0.9,
	}
	score := stylisticSimilarity(text, prof)
	if score > 0.5 {
		t.Fatalf("stylisticSimilarity for distant profile = %v, want < 0.5", score)
	}
}

func TestVocabularyOverlap_MatchesWeightedTerms(t *testing.T) {
	terms := []profile.TermWeight{
		{Term: "newsletter", Score: 0.5},
		{Term: "founders", Score: 0.4},
		{Term: "leverage", Score: 0.001},
	}
	high := vocabularyOverlap("a newsletter for founders", terms)
	low := vocabularyOverlap("nothing matches here at all", terms)
	if high <= low {
		t.Fatalf("expected high (%v) > low (%v)", high, low)
	}
}

func TestStructuralMatch_OpeningHook(t *testing.T) {
	prof := profile.Structural{
		OpeningHookStyle: "question",
		ClosingPattern:   "cta",
	}
	good := structuralMatch("Are you ready? Click here to subscribe.", prof)
	bad := structuralMatch("Today is Tuesday. The end.", prof)
	if good <= bad {
		t.Fatalf("expected good (%v) > bad (%v)", good, bad)
	}
}

func TestEmbeddingEvaluator_Score_EndToEnd(t *testing.T) {
	prof := profile.VoiceProfile{
		Stylistic: profile.Stylistic{
			AvgSentenceLength:  10,
			AvgParagraphLength: 3,
			FormalityScore:     0.4,
		},
		Vocabulary: profile.Vocabulary{
			DistinctiveTerms: []profile.TermWeight{
				{Term: "newsletter", Score: 0.5},
				{Term: "founders", Score: 0.4},
			},
		},
		Structural: profile.Structural{
			OpeningHookStyle: "declaration",
			ClosingPattern:   "signoff",
		},
		RepresentativeSamples: []profile.Sample{
			{Text: "A newsletter for indie founders. Short and direct.", Tokens: 10},
		},
	}
	ev := NewEmbeddingEvaluator(&MockEmbeddingClient{})
	generated := "A newsletter for indie founders. Direct and short.\n\nThanks,\nMaya"
	score, br, err := ev.Score(context.Background(), generated, prof)
	if err != nil {
		t.Fatalf("Score returned error: %v", err)
	}
	if score < 0 || score > 100 {
		t.Fatalf("score out of range: %v", score)
	}
	if br.EmbeddingSimilarity == 0 || br.StylisticDistance == 0 {
		t.Fatalf("expected non-zero components, got %+v", br)
	}
}

func TestMockEmbeddingClient_DeterministicAndUnit(t *testing.T) {
	c := &MockEmbeddingClient{}
	a, _ := c.Embed(context.Background(), []string{"hello"})
	b, _ := c.Embed(context.Background(), []string{"hello"})
	if cosine(a[0], b[0]) < 0.999 {
		t.Fatal("identical inputs should produce identical vectors")
	}
	// Roughly unit length.
	var n float64
	for _, x := range a[0] {
		n += x * x
	}
	if math.Abs(math.Sqrt(n)-1.0) > 1e-3 {
		t.Fatalf("expected unit vector, got norm %v", math.Sqrt(n))
	}
}

func TestOpenAIEmbeddingURLPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	got, err := openAIEmbeddingURL("https://api.example.test/proxy/")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://api.example.test/proxy/v1/embeddings" {
		t.Fatalf("openAIEmbeddingURL = %q", got)
	}

	for _, base := range []string{
		"https://user:pass@api.example.test",
		"https://api.example.test?token=x",
		"https://api.example.test#frag",
		"file:///tmp/openai",
	} {
		_, err := openAIEmbeddingURL(base)
		if err == nil || (!strings.Contains(err.Error(), "unsafe OpenAI base URL") &&
			!strings.Contains(err.Error(), "invalid OpenAI base URL") &&
			!strings.Contains(err.Error(), "unsupported OpenAI base URL scheme")) {
			t.Fatalf("base %q err = %v, want unsafe/invalid", base, err)
		}
	}
}

func TestOpenAIClientCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(openAIEmbeddingMaxResponseBytes)+1)))
	}))
	defer srv.Close()

	c := NewOpenAIClient("test-key")
	c.BaseURL = srv.URL
	c.HTTP = srv.Client()

	_, err := c.Embed(context.Background(), []string{"hello"})
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("Embed err = %v, want response body too large", err)
	}
}

func TestComputeStylistic_MatchesProfileBuilderShape(t *testing.T) {
	// Sanity check: feeding several short sentences yields a small avg.
	s := computeStylistic("One. Two. Three. Four.")
	if s.AvgSentenceLength > 3 {
		t.Fatalf("expected small avg sentence length, got %v", s.AvgSentenceLength)
	}
}
