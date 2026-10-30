package profile

import (
	"context"
	"math/rand"
	"sort"
	"strings"

	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
	"github.com/postwave/postwave/services/voice/internal/profile/wordfreq"
)

// Theme is a single recurring topic surfaced from a writer's corpus.
//
// Two extraction paths share the same struct:
//
//   - TF-IDF (legacy / fallback): Term is the lowercased word, Score is
//     tf*idf against the embedded English-frequency baseline, Frequency is
//     the raw count. EmbeddingCentroid is empty.
//   - Embedding clustering (default when GEMINI_API_KEY is set): the writer's
//     samples are embedded, k-means clustered, and each cluster's nearest
//     sample contributes its most-distinctive TF-IDF token as Term. Score is
//     `1 - intra-cluster mean distance` (higher = tighter cluster).
//     Frequency is the cluster size. EmbeddingCentroid is the cluster
//     centroid in embedding space.
//
// We ship Score so callers can rank/threshold; we ship Frequency so the UI
// can show "appears 12 times" alongside the term; we ship
// EmbeddingCentroid so downstream consumers can do "show me items that
// fit this theme" cosine-similarity lookups without re-embedding the
// representative samples.
type Theme struct {
	Term              string    `json:"term"`
	Score             float64   `json:"score"`
	Frequency         int       `json:"frequency"`
	EmbeddingCentroid []float64 `json:"embedding_centroid,omitempty"`
}

// boilerplateBlocklist is a hand-curated list of non-content boilerplate
// (greetings, sign-offs, filler) that should never surface as a "theme"
// no matter how distinctive its IDF. The wordfreq baseline lacks coverage
// of some of these (rare in news/web corpora), so we explicitly drop them.
var boilerplateBlocklist = map[string]bool{
	"hi":         true,
	"hello":      true,
	"hey":        true,
	"dear":       true,
	"regards":    true,
	"thanks":     true,
	"thank":      true,
	"sincerely":  true,
	"cheers":     true,
	"yours":      true,
	"truly":      true,
	"warmly":     true,
	"greetings":  true,
	"goodbye":    true,
	"bye":        true,
	"farewell":   true,
	"howdy":      true,
	"folks":      true,
	"everyone":   true,
	"everybody":  true,
	"team":       true,
	"all":        true,
	"please":     true,
	"kindly":     true,
	"appreciate": true,
	"appreciat":  true, // stem catch
	"hope":       true, // common boilerplate ("hope you're well")
	"well":       true,
	"today":      true,
	"yesterday":  true,
	"tomorrow":   true,
	// generic stopwords that may still slip past the IDF threshold in
	// small corpora
	"would": true,
	"could": true,
	"might": true,
	"shall": true,
	"will":  true,
	"that":  true,
	"this":  true,
	"these": true,
	"those": true,
	"about": true,
	"there": true,
	"here":  true,
}

// hasDigit reports whether s contains any digit. We exclude digit-bearing
// "words" (years, version numbers, IDs) from theme extraction.
func hasDigit(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			return true
		}
	}
	return false
}

// ExtractThemes runs TF-IDF over `corpus` (a slice of writing samples,
// each sample is a string) and returns the top-K most distinctive terms
// as Theme records.
//
// Used as the fallback path when no embedding client is wired and as the
// per-cluster token picker by ExtractThemesEmbedding.
//
// Algorithm:
//  1. Concatenate corpus and tokenize on whitespace + lowercase.
//  2. For each unique token:
//     - skip if length < 3
//     - skip if contains a digit
//     - skip if in boilerplateBlocklist
//     - skip if the wordfreq IDF is below a stopword threshold
//     (very common words like "the", "and", "of")
//     - score = tf * idf where tf is the raw token frequency in the
//     corpus and idf is wordfreq.IDF(token).
//  3. Sort by score descending, return top-K with ties broken by frequency.
//
// Returns nil for empty corpus.
//
// Calibration: the stopword IDF threshold (3.0) was picked by inspecting
// IDF values from freq.txt — words below it are universally common
// (the, and, of, is). Values above it are journalistically common but
// not so common that they drown out distinctive vocabulary.
func ExtractThemes(corpus []string, k int) []Theme {
	if k <= 0 {
		return nil
	}

	tf := map[string]int{}
	for _, sample := range corpus {
		// Lowercase and split on non-letter; this handles "growth-stage"
		// -> "growth", "stage" without us hand-coding word boundaries.
		lower := strings.ToLower(sample)
		fields := strings.FieldsFunc(lower, isNotLetter)
		for _, w := range fields {
			tf[w]++
		}
	}
	if len(tf) == 0 {
		return nil
	}

	const stopwordIDFThreshold = 3.0
	out := make([]Theme, 0, len(tf))
	for term, freq := range tf {
		if len(term) < 3 {
			continue
		}
		if hasDigit(term) {
			continue
		}
		if boilerplateBlocklist[term] {
			continue
		}
		idf := wordfreq.IDF(term)
		if idf < stopwordIDFThreshold {
			continue
		}
		score := float64(freq) * idf
		out = append(out, Theme{Term: term, Score: score, Frequency: freq})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Frequency > out[j].Frequency
	})

	if len(out) > k {
		out = out[:k]
	}
	return out
}

// ThemeClusterK is the default number of k-means clusters for embedding-
// based theme extraction. Calibrated against the original "5-10 themes
// per profile" target — k=8 is the midpoint and matches the UI's theme
// slot budget. Callers can pass a different k via the parameter.
const ThemeClusterK = 8

// ThemeKMeansMaxIters is the k-means iteration cap. Converges fast for
// the few hundred samples a typical voice profile holds; the cap is
// defense-in-depth against a degenerate input that wouldn't otherwise
// stabilize.
const ThemeKMeansMaxIters = 25

// ThemeKMeansSeed makes clustering deterministic across builds. Critical
// for tests and for "rebuild the profile and the themes shouldn't shuffle
// just because the seed changed". Operators who want fresh clustering on
// every build can pass their own *rand.Rand to extractThemesEmbedding.
const ThemeKMeansSeed = 0xC0FFEE

// ExtractThemesEmbedding embeds each sample, k-means clusters them in the
// embedding space, and returns one Theme per non-empty cluster. The
// Theme.Term is the most-distinctive TF-IDF token from the cluster
// member nearest the centroid; Theme.Frequency is the cluster size;
// Theme.Score is `1 - meanIntraClusterDistance` (clamped to [0,1]);
// Theme.EmbeddingCentroid is the centroid vector.
//
// Returns the TF-IDF fallback when:
//   - client is nil (no GEMINI_API_KEY)
//   - the embedding call fails (so a network blip never blocks a
//     profile build)
//   - corpus has fewer items than k (clustering would degenerate to
//     "one cluster per sample")
//
// k clamps to len(corpus) when smaller. K = 0 / negative falls back to
// the legacy TF-IDF path.
func ExtractThemesEmbedding(ctx context.Context, client embeddings.Embedder, corpus []string, k int) []Theme {
	if k <= 0 {
		return nil
	}
	if client == nil {
		return ExtractThemes(corpus, k)
	}
	// Drop empties so embedding requests don't choke on whitespace.
	trimmed := make([]string, 0, len(corpus))
	for _, s := range corpus {
		t := strings.TrimSpace(s)
		if t == "" {
			continue
		}
		trimmed = append(trimmed, t)
	}
	if len(trimmed) < k {
		// Too few samples to cluster meaningfully. Fall back rather than
		// shoehorn into k clusters.
		return ExtractThemes(corpus, k)
	}

	vecs, err := client.EmbedBatch(ctx, trimmed, embeddings.TaskTypeClustering)
	if err != nil || len(vecs) != len(trimmed) {
		return ExtractThemes(corpus, k)
	}

	clusters := kMeans(vecs, k, ThemeKMeansMaxIters, rand.New(rand.NewSource(ThemeKMeansSeed)))
	if len(clusters) == 0 {
		return ExtractThemes(corpus, k)
	}

	out := make([]Theme, 0, len(clusters))
	for _, cl := range clusters {
		if len(cl.Members) == 0 {
			continue
		}
		// Find the cluster member nearest the centroid; use its TF-IDF
		// top token as the theme label. This is more stable than
		// "label = centroid's nearest dictionary word" because we never
		// have a labeled dictionary to project the centroid back into.
		nearestIdx := nearestToCentroid(cl.Centroid, vecs, cl.Members)
		// Compute the per-cluster TF-IDF token set so the label reflects
		// what is distinctive *within this cluster's samples*, not the
		// global corpus.
		clusterCorpus := make([]string, 0, len(cl.Members))
		for _, m := range cl.Members {
			clusterCorpus = append(clusterCorpus, trimmed[m])
		}
		topTokens := ExtractThemes(clusterCorpus, 1)
		label := ""
		if len(topTokens) > 0 {
			label = topTokens[0].Term
		}
		if label == "" {
			// Hard fallback: pick the longest word from the nearest sample
			// (skip stopwords, digits, boilerplate).
			label = firstContentWord(trimmed[nearestIdx])
		}
		score := 1.0 - cl.MeanDistance
		if score < 0 {
			score = 0
		}
		if score > 1 {
			score = 1
		}
		out = append(out, Theme{
			Term:              label,
			Score:             score,
			Frequency:         len(cl.Members),
			EmbeddingCentroid: cl.Centroid,
		})
	}
	// Sort by frequency descending, score tie-break — bigger clusters
	// surface first, mirroring the legacy TF-IDF ranking shape.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Frequency != out[j].Frequency {
			return out[i].Frequency > out[j].Frequency
		}
		return out[i].Score > out[j].Score
	})
	if len(out) > k {
		out = out[:k]
	}
	return out
}

// firstContentWord returns the first word in `s` longer than 2 chars,
// not a digit-bearing token, not in the boilerplate blocklist. Lowercased.
// Returns "" if no qualifying word exists.
func firstContentWord(s string) string {
	for _, w := range strings.FieldsFunc(strings.ToLower(s), isNotLetter) {
		if len(w) < 3 || hasDigit(w) || boilerplateBlocklist[w] {
			continue
		}
		return w
	}
	return ""
}

// cluster is the internal k-means result: list of member indices into
// the original vec slice, the centroid, and the mean intra-cluster
// (euclidean) distance.
type cluster struct {
	Members      []int
	Centroid     []float64
	MeanDistance float64
}

// kMeans runs deterministic k-means using k-means++ initialization.
// Returns up to k clusters; empty clusters are dropped.
func kMeans(vecs [][]float64, k int, maxIters int, rng *rand.Rand) []cluster {
	if len(vecs) == 0 || k <= 0 {
		return nil
	}
	if k > len(vecs) {
		k = len(vecs)
	}
	dim := len(vecs[0])

	// k-means++ init: first centroid is random; subsequent centroids are
	// chosen with probability proportional to squared distance from the
	// nearest already-chosen centroid. Spreads initial centroids without
	// being sensitive to outliers the way Forgy initialization is.
	centroids := make([][]float64, 0, k)
	first := rng.Intn(len(vecs))
	centroids = append(centroids, copyVec(vecs[first]))
	for len(centroids) < k {
		dists := make([]float64, len(vecs))
		var total float64
		for i, v := range vecs {
			best := euclidSq(v, centroids[0])
			for c := 1; c < len(centroids); c++ {
				if d := euclidSq(v, centroids[c]); d < best {
					best = d
				}
			}
			dists[i] = best
			total += best
		}
		if total == 0 {
			// All remaining points are duplicates of an existing centroid;
			// just take any.
			centroids = append(centroids, copyVec(vecs[rng.Intn(len(vecs))]))
			continue
		}
		pick := rng.Float64() * total
		var acc float64
		picked := len(vecs) - 1
		for i, d := range dists {
			acc += d
			if acc >= pick {
				picked = i
				break
			}
		}
		centroids = append(centroids, copyVec(vecs[picked]))
	}

	assignments := make([]int, len(vecs))
	for iter := 0; iter < maxIters; iter++ {
		changed := false
		for i, v := range vecs {
			best := 0
			bestD := euclidSq(v, centroids[0])
			for c := 1; c < k; c++ {
				if d := euclidSq(v, centroids[c]); d < bestD {
					bestD = d
					best = c
				}
			}
			if assignments[i] != best {
				assignments[i] = best
				changed = true
			}
		}
		// Recompute centroids.
		newCentroids := make([][]float64, k)
		counts := make([]int, k)
		for c := 0; c < k; c++ {
			newCentroids[c] = make([]float64, dim)
		}
		for i, c := range assignments {
			for d := 0; d < dim; d++ {
				newCentroids[c][d] += vecs[i][d]
			}
			counts[c]++
		}
		for c := 0; c < k; c++ {
			if counts[c] == 0 {
				// Re-seed empty cluster at a random vec to keep the
				// partition non-trivial.
				newCentroids[c] = copyVec(vecs[rng.Intn(len(vecs))])
				continue
			}
			inv := 1.0 / float64(counts[c])
			for d := 0; d < dim; d++ {
				newCentroids[c][d] *= inv
			}
		}
		centroids = newCentroids
		if !changed {
			break
		}
	}

	// Build the result, skipping empty clusters and computing the mean
	// intra-cluster euclidean distance (square-rooted from the squared
	// distance we already use elsewhere).
	out := make([]cluster, 0, k)
	for c := 0; c < k; c++ {
		members := make([]int, 0)
		var sumD2 float64
		for i, a := range assignments {
			if a == c {
				members = append(members, i)
				sumD2 += euclidSq(vecs[i], centroids[c])
			}
		}
		if len(members) == 0 {
			continue
		}
		mean := 0.0
		if len(members) > 0 {
			mean = sumD2 / float64(len(members))
		}
		out = append(out, cluster{
			Members:      members,
			Centroid:     centroids[c],
			MeanDistance: mean,
		})
	}
	return out
}

func euclidSq(a, b []float64) float64 {
	var s float64
	for i := range a {
		d := a[i] - b[i]
		s += d * d
	}
	return s
}

func copyVec(v []float64) []float64 {
	out := make([]float64, len(v))
	copy(out, v)
	return out
}

func nearestToCentroid(centroid []float64, vecs [][]float64, members []int) int {
	best := members[0]
	bestD := euclidSq(centroid, vecs[best])
	for _, m := range members[1:] {
		if d := euclidSq(centroid, vecs[m]); d < bestD {
			bestD = d
			best = m
		}
	}
	return best
}

func isNotLetter(r rune) bool {
	return !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'))
}
