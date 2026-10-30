// Package fidelity scores how closely a piece of generated prose matches
// a writer's VoiceProfile. The Combined score is 0..100 and the engine's
// auto-retry threshold is 60.
//
// Components:
//
//   - EmbeddingSimilarity: avg cosine similarity between the generated text's
//     embedding and the embeddings of the profile's representative samples.
//     Computed via an EmbeddingClient (OpenAI text-embedding-3-small in prod,
//     deterministic mock in tests).
//   - StylisticDistance: Euclidean distance between feature vectors derived
//     from the generated text and the profile's Stylistic block, normalized
//     and inverted to a 0..1 similarity score.
//   - VocabularyOverlap: distinctiveness-weighted Jaccard between the
//     generated text's vocabulary and the profile's distinctive_terms.
//   - StructuralMatch: opening-hook + closing-pattern + bullet-usage match.
//
// Combined = 0.4*emb + 0.3*styl + 0.2*vocab + 0.1*struct, scaled to 0..100.
package fidelity

import (
	"context"
	"math"
	"regexp"
	"strings"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/profile"
)

// FidelityBreakdown is re-exported here so callers can use either name.
// generation.FidelityBreakdown is structurally identical.
type FidelityBreakdown = generation.FidelityBreakdown

// Evaluator is the interface generation.Engine consumes.
type Evaluator interface {
	Score(ctx context.Context, generated string, prof profile.VoiceProfile) (float64, FidelityBreakdown, error)
}

// EmbeddingEvaluator is the production Evaluator. Pass an EmbeddingClient
// (OpenAIClient or MockEmbeddingClient).
type EmbeddingEvaluator struct {
	Embeddings EmbeddingClient
}

// NewEmbeddingEvaluator constructs an Evaluator backed by the supplied
// embedding client.
func NewEmbeddingEvaluator(emb EmbeddingClient) *EmbeddingEvaluator {
	return &EmbeddingEvaluator{Embeddings: emb}
}

// Score implements Evaluator. Returns the 0..100 Combined score plus a
// breakdown for diagnostics.
func (e *EmbeddingEvaluator) Score(ctx context.Context, generated string, prof profile.VoiceProfile) (float64, FidelityBreakdown, error) {
	br := FidelityBreakdown{}

	// --- Embedding similarity ---
	if e.Embeddings != nil && len(prof.RepresentativeSamples) > 0 {
		sim, err := e.embeddingSimilarity(ctx, generated, prof.RepresentativeSamples)
		if err != nil {
			return 0, br, err
		}
		br.EmbeddingSimilarity = sim
	} else {
		// No embeddings available — treat as neutral (0.5) so we don't
		// punish the absence of an embedding client.
		br.EmbeddingSimilarity = 0.5
	}

	// --- Stylistic distance (returns a 0..1 similarity, higher is better) ---
	br.StylisticDistance = stylisticSimilarity(generated, prof.Stylistic)

	// --- Vocabulary overlap (Jaccard, distinctiveness-weighted) ---
	br.VocabularyOverlap = vocabularyOverlap(generated, prof.Vocabulary.DistinctiveTerms)

	// --- Structural match ---
	br.StructuralMatch = structuralMatch(generated, prof.Structural)

	br.Combined = 100.0 * (0.4*br.EmbeddingSimilarity +
		0.3*br.StylisticDistance +
		0.2*br.VocabularyOverlap +
		0.1*br.StructuralMatch)

	if br.Combined < 0 {
		br.Combined = 0
	}
	if br.Combined > 100 {
		br.Combined = 100
	}
	return br.Combined, br, nil
}

// embeddingSimilarity returns the mean cosine similarity between the
// generated text and the representative samples, scaled to 0..1.
func (e *EmbeddingEvaluator) embeddingSimilarity(ctx context.Context, generated string, samples []profile.Sample) (float64, error) {
	texts := []string{generated}
	for _, s := range samples {
		texts = append(texts, s.Text)
	}
	embs, err := e.Embeddings.Embed(ctx, texts)
	if err != nil {
		return 0, err
	}
	if len(embs) < 2 {
		return 0.5, nil
	}
	gen := embs[0]
	var total float64
	count := 0
	for i := 1; i < len(embs); i++ {
		total += cosine(gen, embs[i])
		count++
	}
	if count == 0 {
		return 0.5, nil
	}
	mean := total / float64(count)
	// Cosine is -1..1; map to 0..1 for the combined score.
	// Floating-point dot products can overshoot the mathematical cosine range
	// by a few ulps. Clamp before this value becomes a signed evidence receipt;
	// downstream regression validation intentionally rejects out-of-range
	// components rather than persisting them.
	return clamp01((mean + 1) / 2), nil
}

// --- helpers ---

func cosine(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
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

// stylisticSimilarity computes Euclidean distance between the generated
// text's stylistic feature vector and the profile's, then converts to
// a 0..1 similarity.
func stylisticSimilarity(generated string, profStyl profile.Stylistic) float64 {
	gen := computeStylistic(generated)
	// Feature vector: each component is normalized into roughly 0..1 by
	// dividing by a sensible cap.
	g := []float64{
		clamp01(gen.AvgSentenceLength / 40.0),
		clamp01(gen.SentenceLengthVariance / 100.0),
		clamp01(gen.AvgParagraphLength / 8.0),
		clamp01(gen.FormalityScore),
		clamp01(gen.HedgingFrequency / 50.0),
		clamp01(gen.PassiveVoicePct),
	}
	p := []float64{
		clamp01(profStyl.AvgSentenceLength / 40.0),
		clamp01(profStyl.SentenceLengthVariance / 100.0),
		clamp01(profStyl.AvgParagraphLength / 8.0),
		clamp01(profStyl.FormalityScore),
		clamp01(profStyl.HedgingFrequency / 50.0),
		clamp01(profStyl.PassiveVoicePct),
	}
	var sum float64
	for i := range g {
		d := g[i] - p[i]
		sum += d * d
	}
	dist := math.Sqrt(sum) / math.Sqrt(float64(len(g)))
	return clamp01(1 - dist)
}

// computeStylistic is a smaller version of profile.Builder's stylistic
// computation. We don't import profile.Builder to avoid circular concerns;
// the duplication is small and intentional.
func computeStylistic(text string) profile.Stylistic {
	out := profile.Stylistic{}
	if strings.TrimSpace(text) == "" {
		return out
	}
	paragraphs := paraSplitRe.Split(text, -1)
	var sentLens []float64
	paraLens := make([]float64, 0, len(paragraphs))
	totalWords := 0
	hedgeHits := 0
	passive := 0
	passiveTotal := 0
	contractions := strings.Count(text, "'")
	excl := strings.Count(text, "!")
	for _, p := range paragraphs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		sents := profile.SegmentSentences(p)
		paraLens = append(paraLens, float64(len(sents)))
		for _, s := range sents {
			toks := strings.Fields(s)
			if len(toks) == 0 {
				continue
			}
			sentLens = append(sentLens, float64(len(toks)))
			passiveTotal++
			if profile.HasPassiveVoice(s) {
				passive++
			}
			for _, tk := range toks {
				lower := strings.ToLower(strings.Trim(tk, ".,!?;:\"'()"))
				totalWords++
				if hedgeWords[lower] {
					hedgeHits++
				}
			}
		}
	}
	out.AvgSentenceLength = mean(sentLens)
	out.SentenceLengthVariance = variance(sentLens)
	out.AvgParagraphLength = mean(paraLens)
	if totalWords > 0 {
		out.HedgingFrequency = float64(hedgeHits) / float64(totalWords) * 1000
	}
	if passiveTotal > 0 {
		out.PassiveVoicePct = float64(passive) / float64(passiveTotal)
	}
	if totalWords > 0 {
		// Cheap formality heuristic, mirrored from profile.Builder.
		var totalLen int
		for _, w := range strings.Fields(text) {
			totalLen += len(w)
		}
		avg := float64(totalLen) / float64(totalWords)
		score := math.Min(1, math.Max(0, (avg-3.5)/4.0))
		score -= float64(contractions) / float64(totalWords) * 2
		score -= float64(excl) / float64(totalWords) * 2
		out.FormalityScore = clamp01(score)
	}
	return out
}

// vocabularyOverlap computes a distinctiveness-weighted Jaccard similarity
// between the generated text's vocabulary and the profile's distinctive
// terms. Matches against high-score terms count more.
func vocabularyOverlap(generated string, terms []profile.TermWeight) float64 {
	if len(terms) == 0 {
		return 0.5
	}
	genTokens := tokenSet(generated)
	if len(genTokens) == 0 {
		return 0
	}
	var matchedScore, totalScore float64
	for _, tw := range terms {
		totalScore += tw.Score
		if _, ok := genTokens[strings.ToLower(tw.Term)]; ok {
			matchedScore += tw.Score
		}
	}
	if totalScore == 0 {
		return 0.5
	}
	// Distinctiveness-weighted recall against the writer's distinctive
	// lexicon. We compress with sqrt because matching the entire top-100
	// would be unusual; matching ~10% is already meaningful.
	return clamp01(math.Sqrt(matchedScore / totalScore))
}

// structuralMatch checks opening-hook / closing-pattern / bullet usage
// alignment. Returns 0..1.
func structuralMatch(generated string, structural profile.Structural) float64 {
	if structural.OpeningHookStyle == "" && structural.ClosingPattern == "" {
		return 0.5
	}
	score := 0.0
	checks := 0.0

	first, last := firstLastSentences(generated)
	if structural.OpeningHookStyle != "" {
		checks++
		if classifyOpening(first) == structural.OpeningHookStyle ||
			structural.OpeningHookStyle == "mixed" {
			score++
		}
	}
	if structural.ClosingPattern != "" {
		checks++
		if classifyClosing(last) == structural.ClosingPattern ||
			structural.ClosingPattern == "mixed" {
			score++
		}
	}
	// Bullet usage: a coarse +/- 30% check.
	hasBullets := bulletRe.MatchString(generated)
	expected := structural.BulletListUsageRate > 0.3
	checks++
	if hasBullets == expected {
		score++
	}

	if checks == 0 {
		return 0.5
	}
	return score / checks
}

// --- regex / lookups (kept private, mirror profile.Builder) ---

var (
	paraSplitRe = regexp.MustCompile(`\n\s*\n+`)
	bulletRe    = regexp.MustCompile(`(?m)^\s*(?:[-*+]\s+|\d+\.\s+)`)
	tokenStrip  = regexp.MustCompile(`[^a-zA-Z']`)
)

var hedgeWords = map[string]bool{
	"maybe": true, "perhaps": true, "might": true, "could": true,
	"seems": true, "kind": true, "sort": true, "possibly": true,
}

func tokenSet(s string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, w := range strings.Fields(s) {
		w = strings.ToLower(tokenStrip.ReplaceAllString(w, ""))
		if len(w) <= 2 {
			continue
		}
		out[w] = struct{}{}
	}
	return out
}

func firstLastSentences(text string) (string, string) {
	sents := profile.SegmentSentences(strings.TrimSpace(text))
	clean := make([]string, 0, len(sents))
	for _, s := range sents {
		s = strings.TrimSpace(s)
		if s != "" {
			clean = append(clean, s)
		}
	}
	if len(clean) == 0 {
		return "", ""
	}
	return clean[0], clean[len(clean)-1]
}

func classifyOpening(s string) string {
	if s == "" {
		return "mixed"
	}
	low := strings.ToLower(s)
	if strings.Contains(s, "?") {
		return "question"
	}
	if regexp.MustCompile(`\b\d+(\.\d+)?%|\b\d{2,}\b`).MatchString(s) {
		return "statistic"
	}
	if strings.HasPrefix(low, "i ") || strings.HasPrefix(low, "last ") || strings.HasPrefix(low, "yesterday") || strings.HasPrefix(low, "when i ") {
		return "anecdote"
	}
	return "declaration"
}

func classifyClosing(s string) string {
	if s == "" {
		return "mixed"
	}
	low := strings.ToLower(s)
	if strings.Contains(s, "?") {
		return "question"
	}
	if regexp.MustCompile(`(?i)\b(click|subscribe|sign up|join|reply|share|read more|learn more)\b`).MatchString(s) {
		return "cta"
	}
	if strings.HasPrefix(low, "thanks") || strings.HasPrefix(low, "cheers") || strings.HasPrefix(low, "talk soon") || strings.HasPrefix(low, "—") {
		return "signoff"
	}
	return "reflection"
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

func variance(xs []float64) float64 {
	if len(xs) < 2 {
		return 0
	}
	m := mean(xs)
	var s float64
	for _, x := range xs {
		s += (x - m) * (x - m)
	}
	return s / float64(len(xs)-1)
}

func clamp01(x float64) float64 {
	if x < 0 {
		return 0
	}
	if x > 1 {
		return 1
	}
	return x
}
