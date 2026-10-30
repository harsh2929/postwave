package profile

import (
	"context"
	"sort"
	"strings"

	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
)

// Sample is a representative passage stored in a VoiceProfile and used as
// few-shot context during generation.
type Sample struct {
	ID         string  `json:"id"`
	SourceType string  `json:"source_type"`
	Text       string  `json:"text"`
	Tokens     int     `json:"tokens"`
	Weight     float64 `json:"weight"` // relevance/recency 0..1
}

// EmbeddingDiversityThreshold is the cosine-similarity cutoff above
// which two candidate samples are considered "too similar" — the
// higher-weight one is kept, the other rejected. 0.9 was picked so that
// near-duplicate paragraphs (a writer's recurring opener, two tweets
// with the same hook) are deduped but stylistically-similar passages on
// different topics still both make the cut.
const EmbeddingDiversityThreshold = 0.9

// PickRepresentative selects a diverse, high-weight subset of samples whose
// total Tokens does not exceed tokenBudget.
//
// Strategy (V1, intentionally simple):
//  1. Sort by Weight descending.
//  2. Greedily add samples whose 5-gram Jaccard similarity to anything
//     already chosen is below 0.4 (diversity guard).
//  3. Stop when the next sample would exceed tokenBudget.
//
// For semantic-aware diversity use PickRepresentativeEmbedding instead —
// it replaces the Jaccard guard with embedding cosine similarity.
func PickRepresentative(samples []Sample, tokenBudget int) []Sample {
	if tokenBudget <= 0 || len(samples) == 0 {
		return nil
	}
	sorted := make([]Sample, len(samples))
	copy(sorted, samples)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Weight > sorted[j].Weight
	})

	picked := make([]Sample, 0, len(sorted))
	chosenGrams := make([]map[string]struct{}, 0, len(sorted))
	used := 0
	for _, s := range sorted {
		if s.Tokens <= 0 {
			continue
		}
		if used+s.Tokens > tokenBudget {
			continue
		}
		grams := fivegrams(s.Text)
		tooSimilar := false
		for _, prev := range chosenGrams {
			if jaccard(grams, prev) >= 0.4 {
				tooSimilar = true
				break
			}
		}
		if tooSimilar {
			continue
		}
		picked = append(picked, s)
		chosenGrams = append(chosenGrams, grams)
		used += s.Tokens
	}
	return picked
}

// PickRepresentativeEmbedding is the semantic-diversity counterpart of
// PickRepresentative. Strategy:
//
//  1. Sort by Weight descending.
//  2. Batch-embed all candidates up front (single round-trip; 100/batch).
//  3. Greedily admit samples whose cosine similarity to every already-
//     chosen sample is below EmbeddingDiversityThreshold (0.9).
//  4. Stop when the next sample would exceed tokenBudget.
//
// If client is nil or batch-embedding fails, falls back to the legacy
// Jaccard-5gram diversity test so a network blip never blocks a profile
// build. The fallback uses the same token budget and weight ordering as
// PickRepresentative.
//
// This is the path that resolves the historical
// "TODO(diversity-embeddings)" in this file.
func PickRepresentativeEmbedding(ctx context.Context, client embeddings.Embedder, samples []Sample, tokenBudget int) []Sample {
	if tokenBudget <= 0 || len(samples) == 0 {
		return nil
	}
	if client == nil {
		return PickRepresentative(samples, tokenBudget)
	}
	sorted := make([]Sample, len(samples))
	copy(sorted, samples)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Weight > sorted[j].Weight
	})

	texts := make([]string, len(sorted))
	for i, s := range sorted {
		texts[i] = s.Text
	}
	vecs, err := client.EmbedBatch(ctx, texts, embeddings.TaskTypeSemanticSimilarity)
	if err != nil || len(vecs) != len(sorted) {
		return PickRepresentative(samples, tokenBudget)
	}

	picked := make([]Sample, 0, len(sorted))
	pickedVecs := make([][]float64, 0, len(sorted))
	used := 0
	for i, s := range sorted {
		if s.Tokens <= 0 {
			continue
		}
		if used+s.Tokens > tokenBudget {
			continue
		}
		tooSimilar := false
		for _, prev := range pickedVecs {
			if cosineSimilarity(vecs[i], prev) > EmbeddingDiversityThreshold {
				tooSimilar = true
				break
			}
		}
		if tooSimilar {
			continue
		}
		picked = append(picked, s)
		pickedVecs = append(pickedVecs, vecs[i])
		used += s.Tokens
	}
	return picked
}

func fivegrams(text string) map[string]struct{} {
	out := map[string]struct{}{}
	toks := strings.Fields(strings.ToLower(text))
	if len(toks) < 5 {
		// fall back to whatever we have so short samples still produce a key
		out[strings.Join(toks, " ")] = struct{}{}
		return out
	}
	for i := 0; i+5 <= len(toks); i++ {
		out[strings.Join(toks[i:i+5], " ")] = struct{}{}
	}
	return out
}

func jaccard(a, b map[string]struct{}) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	inter := 0
	for k := range a {
		if _, ok := b[k]; ok {
			inter++
		}
	}
	union := len(a) + len(b) - inter
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}
