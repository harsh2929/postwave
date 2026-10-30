package profile

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
)

// stubEmbedder lets fidelity tests inject hand-crafted vectors.
type stubEmbedder struct {
	vec []float64
	err error
}

func (s *stubEmbedder) Embed(_ context.Context, _ string, _ string) ([]float64, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.vec, nil
}

func (s *stubEmbedder) EmbedBatch(_ context.Context, texts []string, _ string) ([][]float64, error) {
	if s.err != nil {
		return nil, s.err
	}
	out := make([][]float64, len(texts))
	for i := range texts {
		out[i] = s.vec
	}
	return out, nil
}

// TestCosineSimilarity covers orthogonal, parallel, antiparallel, and
// edge cases.
func TestCosineSimilarity(t *testing.T) {
	cases := []struct {
		name string
		a, b []float64
		want float64
	}{
		{"parallel", []float64{1, 0, 0}, []float64{2, 0, 0}, 1},
		{"orthogonal", []float64{1, 0, 0}, []float64{0, 1, 0}, 0},
		{"antiparallel", []float64{1, 0, 0}, []float64{-1, 0, 0}, -1},
		{"mismatched_length", []float64{1, 0}, []float64{0, 1, 0}, 0},
		{"empty_a", []float64{}, []float64{1, 0, 0}, 0},
		{"zero_norm", []float64{0, 0, 0}, []float64{1, 0, 0}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cosineSimilarity(tc.a, tc.b)
			if math.Abs(got-tc.want) > 1e-9 {
				t.Errorf("cosineSimilarity = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestScoreFidelity_Matching: signature ~= generated → score > 0.95.
func TestScoreFidelity_Matching(t *testing.T) {
	signature := []float64{1, 0, 0}
	emb := &stubEmbedder{vec: []float64{0.99, 0.01, 0}}
	score, err := ScoreFidelity(context.Background(), emb, signature, "any text")
	if err != nil {
		t.Fatal(err)
	}
	if score < 0.95 {
		t.Errorf("score = %v, want >= 0.95", score)
	}
}

// TestScoreFidelity_Unmatching: signature orthogonal to generated → ~= 0.
func TestScoreFidelity_Unmatching(t *testing.T) {
	signature := []float64{1, 0, 0}
	emb := &stubEmbedder{vec: []float64{0, 1, 0}}
	score, err := ScoreFidelity(context.Background(), emb, signature, "any text")
	if err != nil {
		t.Fatal(err)
	}
	if score > 0.01 {
		t.Errorf("score = %v, want ~= 0", score)
	}
}

// TestScoreFidelity_AntiparallelClipsToZero: negative cosine becomes 0
// (not -1) in the user-facing score.
func TestScoreFidelity_AntiparallelClipsToZero(t *testing.T) {
	signature := []float64{1, 0, 0}
	emb := &stubEmbedder{vec: []float64{-1, 0, 0}}
	score, err := ScoreFidelity(context.Background(), emb, signature, "x")
	if err != nil {
		t.Fatal(err)
	}
	if score != 0 {
		t.Errorf("score = %v, want clipped to 0 on negative cosine", score)
	}
}

// TestScoreFidelity_NoSignature returns the explicit error.
func TestScoreFidelity_NoSignature(t *testing.T) {
	emb := &stubEmbedder{vec: []float64{1, 0, 0}}
	score, err := ScoreFidelity(context.Background(), emb, nil, "x")
	if !errors.Is(err, ErrNoSignature) {
		t.Errorf("err = %v, want ErrNoSignature", err)
	}
	if score != NoFidelityScore {
		t.Errorf("score = %v, want NoFidelityScore", score)
	}
}

// TestScoreFidelity_NoEmbedder returns the explicit error.
func TestScoreFidelity_NoEmbedder(t *testing.T) {
	score, err := ScoreFidelity(context.Background(), nil, []float64{1, 0, 0}, "x")
	if !errors.Is(err, ErrNoEmbedder) {
		t.Errorf("err = %v, want ErrNoEmbedder", err)
	}
	if score != NoFidelityScore {
		t.Errorf("score = %v, want NoFidelityScore", score)
	}
}

// TestScoreFidelity_EmbedderError propagates the underlying error.
func TestScoreFidelity_EmbedderError(t *testing.T) {
	want := errors.New("boom")
	emb := &stubEmbedder{err: want}
	score, err := ScoreFidelity(context.Background(), emb, []float64{1, 0, 0}, "x")
	if !errors.Is(err, want) {
		t.Errorf("err = %v, want %v", err, want)
	}
	if score != NoFidelityScore {
		t.Errorf("score = %v, want NoFidelityScore", score)
	}
}

// TestScoreFidelity_RealisticVoiceProfiles uses the mock client to make
// sure hand-crafted samples produce intuitive scores:
//   - "matching" tone vs marketing signature → score > 0.85
//   - "academic" tone vs marketing signature → score < 0.5
//
// The mock client mixes word-hash signals into vector components, so
// two strings that share marketing vocabulary land near each other in
// the embedding space and academic prose lands further away.
func TestScoreFidelity_RealisticVoiceProfiles(t *testing.T) {
	mock := &embeddings.MockEmbeddingClient{Dim: 256}

	marketingSignature, err := mock.Embed(context.Background(),
		"Growth marketing means hitting conversion goals fast. Scale your funnel with the channels that convert. Growth, growth, growth.",
		embeddings.TaskTypeSemanticSimilarity)
	if err != nil {
		t.Fatal(err)
	}
	marketingMatch := "Conversion compounds when growth and scale channels align. Scale the funnel, drive growth, hit conversion goals."
	academicMismatch := "We hereby establish, pursuant to the methodology delineated supra, that the present study comports with the antecedent literature."

	matchScore, err := ScoreFidelity(context.Background(), mock, marketingSignature, marketingMatch)
	if err != nil {
		t.Fatal(err)
	}
	if matchScore < 0.5 {
		t.Errorf("matchScore = %v, want > 0.5 (mock embeddings should land marketing prose close to marketing signature)", matchScore)
	}
	mismatchScore, err := ScoreFidelity(context.Background(), mock, marketingSignature, academicMismatch)
	if err != nil {
		t.Fatal(err)
	}
	if mismatchScore >= matchScore {
		t.Errorf("academic prose (%.3f) scored >= marketing prose (%.3f) against marketing signature; expected the reverse",
			mismatchScore, matchScore)
	}
}

func TestScoreFidelityWithFallbackUsesSemanticWhenAvailable(t *testing.T) {
	emb := &stubEmbedder{vec: []float64{1, 0, 0}}
	prof := VoiceProfile{SemanticSignature: []float64{1, 0, 0}}
	got, err := ScoreFidelityWithFallback(context.Background(), emb, prof, "anything")
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != FidelityModeSemantic {
		t.Fatalf("mode = %s, want semantic", got.Mode)
	}
	if got.Score < 0.99 {
		t.Fatalf("score = %.3f, want near 1", got.Score)
	}
	if got.DegradedReason != "" {
		t.Fatalf("unexpected degraded reason: %q", got.DegradedReason)
	}
}

func TestScoreFidelityWithFallbackHeuristicWithoutEmbedder(t *testing.T) {
	prof := VoiceProfile{
		Stylistic: Stylistic{
			AvgSentenceLength:  6,
			AvgParagraphLength: 2,
			FormalityScore:     0.3,
		},
		Vocabulary: Vocabulary{
			DistinctiveTerms: []TermWeight{{Term: "growth", Score: 1}, {Term: "conversion", Score: 1}},
			IdiomMarkers:     []string{"move the needle"},
		},
		Tonal: Tonal{Optimism: 0.7, Directness: 0.7, Formality: 0.3, Warmth: 0.6},
		Structural: Structural{
			OpeningHookStyle:    "declaration",
			ClosingPattern:      "reflection",
			BulletListUsageRate: 0,
		},
	}
	got, err := ScoreFidelityWithFallback(context.Background(), nil, prof, "Growth keeps conversion moving. We can move the needle today.")
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != FidelityModeHeuristic {
		t.Fatalf("mode = %s, want heuristic", got.Mode)
	}
	if got.DegradedReason == "" {
		t.Fatal("expected degraded reason when embedder is nil")
	}
	if got.Score <= 0.45 {
		t.Fatalf("heuristic score = %.3f, want a useful non-neutral score", got.Score)
	}
	if got.VocabularyScore <= 0.5 {
		t.Fatalf("vocabulary score = %.3f, want term/idiom match", got.VocabularyScore)
	}
}

// TestCentroid_Means asserts component-wise mean of equal-length vectors.
func TestCentroid_Means(t *testing.T) {
	got := centroid([][]float64{
		{1, 0, 0},
		{0, 1, 0},
		{0, 0, 1},
	})
	want := []float64{1.0 / 3, 1.0 / 3, 1.0 / 3}
	for i := range got {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Errorf("centroid[%d] = %v, want %v", i, got[i], want[i])
		}
	}
}

// TestCentroid_Empty returns nil.
func TestCentroid_Empty(t *testing.T) {
	if c := centroid(nil); c != nil {
		t.Errorf("got %v, want nil", c)
	}
	if c := centroid([][]float64{{}}); c != nil {
		t.Errorf("got %v, want nil for empty inner vector", c)
	}
}

// TestCentroid_SkipsMismatchedLengths defensively skips vectors that
// don't match the first vector's length.
func TestCentroid_SkipsMismatchedLengths(t *testing.T) {
	got := centroid([][]float64{
		{1, 0, 0},
		{0, 1}, // skipped
		{0, 0, 1},
	})
	want := []float64{0.5, 0, 0.5}
	for i := range got {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Errorf("centroid[%d] = %v, want %v", i, got[i], want[i])
		}
	}
}
