package profile

import (
	"context"
	"errors"
	"math"
	"strings"

	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
)

// ErrNoSignature is returned when fidelity scoring is asked to operate on
// a profile whose SemanticSignature is empty (e.g. because the embedding
// client was nil at build time).
var ErrNoSignature = errors.New("profile: voice profile has no semantic signature; cannot score fidelity (set GEMINI_API_KEY and rebuild the profile)")

// ErrNoEmbedder is returned when ScoreFidelity is called without a live
// embedding client. Distinguishing this from ErrNoSignature lets callers
// emit a clear "client unwired" vs "profile not rebuilt yet" message.
var ErrNoEmbedder = errors.New("profile: embedding client not wired (set GEMINI_API_KEY)")

// NoFidelityScore is returned by ScoreFidelity as the sentinel value
// when a score could not be computed. Downstream callers can spot this
// and skip fidelity-gated rendering (or fall back to the legacy
// fidelity.Evaluator path).
const NoFidelityScore = -1.0

type FidelityMode string

const (
	FidelityModeSemantic  FidelityMode = "semantic"
	FidelityModeHeuristic FidelityMode = "heuristic"
)

// FidelityResult is the richer scorer output used by callers that can degrade
// gracefully when embeddings are unavailable.
type FidelityResult struct {
	Score           float64      `json:"score"`
	Mode            FidelityMode `json:"mode"`
	DegradedReason  string       `json:"degraded_reason,omitempty"`
	StyleScore      float64      `json:"style_score,omitempty"`
	VocabularyScore float64      `json:"vocabulary_score,omitempty"`
	ToneScore       float64      `json:"tone_score,omitempty"`
	StructuralScore float64      `json:"structural_score,omitempty"`
}

// ScoreFidelity returns a 0..1 voice-fidelity score for `generated`
// against the tenant's voice signature. 1.0 = perfect match; 0.0 =
// orthogonal; negative values clip up to 0 (cosine of [-1,1] mapped to
// [0,1] would be misleading on rare negative-similarity cases — for
// voice signature pairs the cosine almost always lives in [0,1] anyway).
//
// Returns (NoFidelityScore, ErrNoEmbedder) if client is nil and
// (NoFidelityScore, ErrNoSignature) if signature is empty. On any
// embedding error we return (NoFidelityScore, error) so callers can
// decide whether to retry or fall back.
func ScoreFidelity(ctx context.Context, client embeddings.Embedder, signature []float64, generated string) (float64, error) {
	if client == nil {
		return NoFidelityScore, ErrNoEmbedder
	}
	if len(signature) == 0 {
		return NoFidelityScore, ErrNoSignature
	}
	gen, err := client.Embed(ctx, generated, embeddings.TaskTypeSemanticSimilarity)
	if err != nil {
		return NoFidelityScore, err
	}
	sim := cosineSimilarity(signature, gen)
	// Clip [-1,1] -> [0,1]. In practice the dot product of two
	// SEMANTIC_SIMILARITY-task embeddings is in [0,1] for English prose;
	// the clip is defense-in-depth so a stray negative number can't
	// surface as a "negative voice fidelity" in the UI.
	if sim < 0 {
		sim = 0
	}
	if sim > 1 {
		sim = 1
	}
	return sim, nil
}

// ScoreFidelityWithFallback first attempts semantic-signature scoring and then
// falls back to profile-native heuristics when the embedder/signature is absent
// or the embedding call fails. The strict ScoreFidelity function above remains
// unchanged for callers that need explicit operational errors.
func ScoreFidelityWithFallback(ctx context.Context, client embeddings.Embedder, prof VoiceProfile, generated string) (FidelityResult, error) {
	if strings.TrimSpace(generated) == "" {
		return FidelityResult{Score: 0, Mode: FidelityModeHeuristic, DegradedReason: "empty generated text"}, nil
	}
	if client != nil && len(prof.SemanticSignature) > 0 {
		score, err := ScoreFidelity(ctx, client, prof.SemanticSignature, generated)
		if err == nil {
			return FidelityResult{Score: score, Mode: FidelityModeSemantic}, nil
		}
		result := heuristicFidelity(prof, generated)
		result.DegradedReason = err.Error()
		return result, nil
	}

	result := heuristicFidelity(prof, generated)
	switch {
	case client == nil:
		result.DegradedReason = ErrNoEmbedder.Error()
	case len(prof.SemanticSignature) == 0:
		result.DegradedReason = ErrNoSignature.Error()
	}
	return result, nil
}

func heuristicFidelity(prof VoiceProfile, generated string) FidelityResult {
	style := heuristicStyleSimilarity(generated, prof.Stylistic)
	vocab := heuristicVocabularySimilarity(generated, prof.Vocabulary)
	tone := heuristicToneSimilarity(generated, prof.Tonal)
	structure := heuristicStructuralSimilarity(generated, prof.Structural)
	score := clamp01(0.35*style + 0.30*vocab + 0.20*tone + 0.15*structure)
	return FidelityResult{
		Score:           score,
		Mode:            FidelityModeHeuristic,
		StyleScore:      style,
		VocabularyScore: vocab,
		ToneScore:       tone,
		StructuralScore: structure,
	}
}

func heuristicStyleSimilarity(generated string, target Stylistic) float64 {
	gen := stylisticSnapshot(generated)
	g := []float64{
		clamp01(gen.AvgSentenceLength / 40.0),
		clamp01(gen.SentenceLengthVariance / 100.0),
		clamp01(gen.AvgParagraphLength / 8.0),
		clamp01(gen.FormalityScore),
		clamp01(gen.HedgingFrequency / 50.0),
		clamp01(gen.PassiveVoicePct),
	}
	p := []float64{
		clamp01(target.AvgSentenceLength / 40.0),
		clamp01(target.SentenceLengthVariance / 100.0),
		clamp01(target.AvgParagraphLength / 8.0),
		clamp01(target.FormalityScore),
		clamp01(target.HedgingFrequency / 50.0),
		clamp01(target.PassiveVoicePct),
	}
	var sum float64
	for i := range g {
		d := g[i] - p[i]
		sum += d * d
	}
	return clamp01(1 - math.Sqrt(sum)/math.Sqrt(float64(len(g))))
}

func stylisticSnapshot(text string) Stylistic {
	var out Stylistic
	paragraphs := splitParagraphs(text)
	var sentLens []float64
	paraLens := make([]float64, 0, len(paragraphs))
	totalWords := 0
	hedgeHits := 0
	passiveHits := 0
	passiveTotal := 0
	for _, paragraph := range paragraphs {
		sentences := SegmentSentences(paragraph)
		paraLens = append(paraLens, float64(len(sentences)))
		for _, sentence := range sentences {
			toks := strings.Fields(sentence)
			if len(toks) == 0 {
				continue
			}
			sentLens = append(sentLens, float64(len(toks)))
			passiveTotal++
			if HasPassiveVoice(sentence) {
				passiveHits++
			}
			for _, tok := range toks {
				normalized := normalizeToken(tok)
				if normalized == "" {
					continue
				}
				totalWords++
				if hedgeSet[normalized] {
					hedgeHits++
				}
			}
		}
	}
	out.AvgSentenceLength = mean(sentLens)
	out.SentenceLengthVariance = variance(sentLens)
	out.AvgParagraphLength = mean(paraLens)
	out.FormalityScore = formalityHeuristic(text)
	if totalWords > 0 {
		out.HedgingFrequency = float64(hedgeHits) / float64(totalWords) * 1000
	}
	if passiveTotal > 0 {
		out.PassiveVoicePct = float64(passiveHits) / float64(passiveTotal)
	}
	return out
}

func heuristicVocabularySimilarity(generated string, vocab Vocabulary) float64 {
	tokenSet := map[string]struct{}{}
	for _, tok := range strings.Fields(generated) {
		if normalized := normalizeToken(tok); len(normalized) > 2 {
			tokenSet[normalized] = struct{}{}
		}
	}
	termScore := 0.5
	if len(vocab.DistinctiveTerms) > 0 && len(tokenSet) > 0 {
		var matched, total float64
		for _, term := range vocab.DistinctiveTerms {
			total += term.Score
			if _, ok := tokenSet[strings.ToLower(term.Term)]; ok {
				matched += term.Score
			}
		}
		if total > 0 {
			termScore = clamp01(math.Sqrt(matched / total))
		}
	}

	normalized := normalizePhraseText(generated)
	phraseTotal := len(vocab.RecurringPhrases) + len(vocab.IdiomMarkers)
	if phraseTotal == 0 {
		return termScore
	}
	phraseHits := 0
	for _, phrase := range vocab.RecurringPhrases {
		if containsNormalizedPhrase(normalized, phrase.Phrase) {
			phraseHits++
		}
	}
	for _, idiom := range vocab.IdiomMarkers {
		if containsNormalizedPhrase(normalized, idiom) || containsIdiomVariant(normalized, idiom) {
			phraseHits++
		}
	}
	phraseScore := clamp01(float64(phraseHits) / float64(phraseTotal))
	return clamp01(0.7*termScore + 0.3*math.Sqrt(phraseScore))
}

func heuristicToneSimilarity(generated string, target Tonal) float64 {
	axes, err := (HeuristicClassifier{}).Classify(context.Background(), []string{generated})
	if err != nil {
		return 0.5
	}
	pairs := [][2]float64{
		{axes.Humor, target.Humor},
		{axes.Optimism, target.Optimism},
		{axes.Directness, target.Directness},
		{axes.Formality, target.Formality},
		{axes.Warmth, target.Warmth},
	}
	used := 0
	var dist float64
	for _, pair := range pairs {
		// Old profiles may have zero-valued V2 axes. Keep 0 meaningful for
		// classic axes only when at least one other target tone field is set.
		if pair[1] == 0 && target.Humor == 0 && target.Optimism == 0 &&
			target.Directness == 0 && target.Formality == 0 && target.Warmth == 0 {
			continue
		}
		dist += math.Abs(pair[0] - pair[1])
		used++
	}
	if used == 0 {
		return 0.5
	}
	return clamp01(1 - dist/float64(used))
}

func heuristicStructuralSimilarity(generated string, target Structural) float64 {
	checks := 0
	score := 0
	first := firstSentence(generated)
	last := lastSentence(generated)
	if target.OpeningHookStyle != "" {
		checks++
		if target.OpeningHookStyle == "mixed" || classifyOpening(first) == target.OpeningHookStyle {
			score++
		}
	}
	if target.ClosingPattern != "" {
		checks++
		if target.ClosingPattern == "mixed" || classifyClosing(last) == target.ClosingPattern {
			score++
		}
	}
	checks++
	if bulletRe.MatchString(generated) == (target.BulletListUsageRate > 0.3) {
		score++
	}
	if checks == 0 {
		return 0.5
	}
	return float64(score) / float64(checks)
}

// cosineSimilarity returns the dot product of a and b divided by the
// product of their L2 norms. Vectors of different length yield 0.
func cosineSimilarity(a, b []float64) float64 {
	if len(a) == 0 || len(b) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// centroid returns the component-wise mean of `vecs`. Returns nil for an
// empty input. All input vectors are assumed to have the same length;
// the result length matches vecs[0]. Vectors of mismatched length are
// skipped (defensive — Gemini always returns same-length vectors but
// hand-crafted test inputs may not).
func centroid(vecs [][]float64) []float64 {
	if len(vecs) == 0 {
		return nil
	}
	dim := len(vecs[0])
	if dim == 0 {
		return nil
	}
	out := make([]float64, dim)
	count := 0
	for _, v := range vecs {
		if len(v) != dim {
			continue
		}
		for i, x := range v {
			out[i] += x
		}
		count++
	}
	if count == 0 {
		return nil
	}
	inv := 1.0 / float64(count)
	for i := range out {
		out[i] *= inv
	}
	return out
}
