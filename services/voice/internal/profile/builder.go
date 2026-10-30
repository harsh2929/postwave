package profile

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"log/slog"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
	"github.com/postwave/postwave/services/voice/internal/profile/wordfreq"
)

// SampleTokenBudget is the total tokens allotted to RepresentativeSamples.
const SampleTokenBudget = 8000

// Builder builds a VoiceProfile from a stream of ingested Items.
//
// Tone is computed by Tone (default: HeuristicClassifier). Set
// POSTWAVE_VOICE_TONE_CLASSIFIER=llm to opt into the LLM-backed
// classifier, which costs a Gemini API call per profile build but
// produces higher-quality scores. The LLM classifier falls back silently
// to the heuristic on any error so profile builds never fail because of
// a tone-API hiccup.
type Builder struct {
	LLM      LLMClient
	TenantID string
	// Tone is the pluggable tone classifier. If nil, the builder picks
	// HeuristicClassifier (or LLMClassifier when the env var opts in).
	Tone ToneClassifier
	// Embeddings is the Gemini text-embedding-004 client used for
	// semantic-signature centroid computation, embedding-clustered theme
	// extraction, and embedding-cosine sample diversity. Nil-safe — when
	// unset, the builder falls back to the legacy TF-IDF themes and the
	// Jaccard-5gram diversity test (mirrors the heuristic/fitted tone
	// fallback pattern). Concretely it accepts any embeddings.Embedder
	// implementation so MockEmbeddingClient flows through tests.
	Embeddings embeddings.Embedder
}

// NewBuilder constructs a Builder. If llm is nil, the LLM-derived fields
// (recurring themes via the legacy AnalyzeTonal call, metaphor patterns,
// self-disclosure rate) are left at zero values; the tone classifier
// always runs, defaulting to the heuristic.
//
// The embeddings client must be set explicitly via WithEmbeddings (or
// direct struct field assignment) — keeping the canonical constructor
// signature backwards-compatible with all existing call sites in
// main.go, handlers, and tests.
func NewBuilder(tenantID string, llm LLMClient) *Builder {
	return &Builder{
		TenantID: tenantID,
		LLM:      llm,
		Tone:     defaultToneClassifier(llm),
	}
}

// WithEmbeddings sets the Gemini embedding client and returns the
// builder for chaining. Pass nil to explicitly disable embeddings (the
// builder falls back to legacy TF-IDF themes + Jaccard diversity).
func (b *Builder) WithEmbeddings(client embeddings.Embedder) *Builder {
	b.Embeddings = client
	return b
}

// defaultToneClassifier picks the active classifier from the env-var
// switch. Default (unset / "heuristic") stays HeuristicClassifier so we
// don't shift production scoring without an explicit opt-in:
//
//   - POSTWAVE_VOICE_TONE_CLASSIFIER=llm    -> LLMClassifier (existing)
//   - POSTWAVE_VOICE_TONE_CLASSIFIER=fitted -> FittedClassifier (v0.2; will
//     become the default once weights are validated against tenant data)
//   - anything else / unset                 -> HeuristicClassifier
//
// The LLM and fitted classifiers both wrap with the heuristic as a
// fallback safety net so the builder never blocks on tone.
func defaultToneClassifier(llm LLMClient) ToneClassifier {
	switch os.Getenv("POSTWAVE_VOICE_TONE_CLASSIFIER") {
	case "llm":
		if llm != nil {
			return LLMClassifier{LLM: llm, Fallback: HeuristicClassifier{}}
		}
		return HeuristicClassifier{}
	case "fitted":
		w := DefaultFittedWeights()
		return FittedClassifier{Weights: &w}
	}
	return HeuristicClassifier{}
}

// Build computes a VoiceProfile from items.
//
// Pipeline:
//  1. Tokenize + sentence-segment via SegmentSentences (abbreviation-aware).
//  2. Compute Stylistic, Vocabulary, Structural, pronoun usage locally.
//  3. Pick representative samples (8K-token budget).
//  4. Send representative passages to the LLM for Tonal + Persona +
//     MetaphorPatterns. If the LLM is nil, leave defaults.
//  5. Tabulate per-source stats.
func (b *Builder) Build(ctx context.Context, items []ingest.Item) (VoiceProfile, error) {
	prof := VoiceProfile{
		TenantID:      b.TenantID,
		Version:       1,
		GeneratedAt:   time.Now().UTC(),
		SourceSummary: map[string]SourceStat{},
	}
	if len(items) == 0 {
		return prof, nil
	}

	// ---- Stylistic ----
	var (
		sentLens         []float64
		paraLens         []float64
		totalWords       int
		hedgeHits        int
		passiveSentences int
		passiveTotal     int
		formalSum        float64
		bulletItems      int
	)
	openCounts := map[string]int{}
	closeCounts := map[string]int{}
	pronounCounts := map[string]int{"i": 0, "we": 0, "you": 0}

	// term frequency for vocabulary
	tf := map[string]int{}
	docFreq := map[string]int{}
	docCount := 0
	// recurring n-grams
	ngramCounts := map[string]int{}
	ngramN := map[string]int{}

	for _, it := range items {
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		itemTerms := map[string]struct{}{}
		// per-source rollup
		s := prof.SourceSummary[string(it.SourceType)]
		s.ItemCount++
		w := strings.Fields(text)
		s.WordCount += len(w)
		if it.PublishedAt.After(s.LastIngestedAt) {
			s.LastIngestedAt = it.PublishedAt
		}
		prof.SourceSummary[string(it.SourceType)] = s

		paragraphs := splitParagraphs(text)
		for _, p := range paragraphs {
			sentences := splitSentences(p)
			paraLens = append(paraLens, float64(len(sentences)))
			for _, sent := range sentences {
				toks := strings.Fields(sent)
				if len(toks) == 0 {
					continue
				}
				sentLens = append(sentLens, float64(len(toks)))
				passiveTotal++
				if HasPassiveVoice(sent) {
					passiveSentences++
				}
				for _, t := range toks {
					lower := normalizeToken(t)
					if lower == "" {
						continue
					}
					totalWords++
					tf[lower]++
					itemTerms[lower] = struct{}{}
					if _, ok := pronounCounts[lower]; ok {
						pronounCounts[lower]++
					}
					if hedgeSet[lower] {
						hedgeHits++
					}
				}
				// n-grams
				for n := 2; n <= 5 && n <= len(toks); n++ {
					for i := 0; i+n <= len(toks); i++ {
						gram := strings.ToLower(strings.Join(toks[i:i+n], " "))
						ngramCounts[gram]++
						ngramN[gram] = n
					}
				}
			}
		}
		if len(itemTerms) > 0 {
			docCount++
			for term := range itemTerms {
				docFreq[term]++
			}
		}

		// structural
		first := firstSentence(text)
		last := lastSentence(text)
		openCounts[classifyOpening(first)]++
		closeCounts[classifyClosing(last)]++
		if bulletRe.MatchString(text) {
			bulletItems++
		}
		formalSum += formalityHeuristic(text)
	}

	prof.Stylistic.AvgSentenceLength = mean(sentLens)
	prof.Stylistic.SentenceLengthVariance = variance(sentLens)
	prof.Stylistic.AvgParagraphLength = mean(paraLens)
	if len(items) > 0 {
		prof.Stylistic.FormalityScore = clamp01(formalSum / float64(len(items)))
	}
	if totalWords > 0 {
		prof.Stylistic.HedgingFrequency = float64(hedgeHits) / float64(totalWords) * 1000.0
	}
	if passiveTotal > 0 {
		prof.Stylistic.PassiveVoicePct = float64(passiveSentences) / float64(passiveTotal)
	}

	// ---- Vocabulary ----
	prof.Vocabulary.DistinctiveTerms = topDistinctiveTerms(tf, docFreq, docCount, totalWords, 100)
	prof.Vocabulary.RecurringPhrases = topRecurringPhrases(ngramCounts, ngramN, 50)
	prof.Vocabulary.IdiomMarkers = detectIdioms(items)
	// MetaphorPatterns filled from LLM below.

	// ---- Structural ----
	prof.Structural.OpeningHookStyle = pickDominant(openCounts)
	prof.Structural.ClosingPattern = pickDominantClosing(closeCounts)
	if len(items) > 0 {
		prof.Structural.BulletListUsageRate = float64(bulletItems) / float64(len(items))
	}
	prof.Structural.MarkdownStyleHint = sniffMarkdownStyle(items)

	// ---- Persona pronouns ----
	prof.Persona.PronounUsage = map[string]float64{}
	if totalWords > 0 {
		for k, v := range pronounCounts {
			prof.Persona.PronounUsage[k] = float64(v) / float64(totalWords)
		}
	}

	// ---- Representative samples ----
	all := buildSamples(items)
	// When embeddings are wired, use cosine-similarity diversity instead
	// of the legacy Jaccard-5gram test. PickRepresentativeEmbedding
	// transparently falls back to PickRepresentative on any embedding
	// failure so a network blip never blocks a profile build.
	if b.Embeddings != nil {
		prof.RepresentativeSamples = PickRepresentativeEmbedding(ctx, b.Embeddings, all, SampleTokenBudget)
	} else {
		prof.RepresentativeSamples = PickRepresentative(all, SampleTokenBudget)
	}

	sampleTexts := make([]string, 0, len(prof.RepresentativeSamples))
	for _, s := range prof.RepresentativeSamples {
		sampleTexts = append(sampleTexts, s.Text)
	}

	// ---- Tone (always runs; heuristic by default, LLM via env opt-in) ----
	tone := b.Tone
	if tone == nil {
		tone = HeuristicClassifier{}
	}
	// LLMClassifier returns the heuristic-fallback axes alongside any non-nil
	// error so transient LLM failures (no API key, rate limit, network) still
	// produce useful tone scores. We log the error but always apply the axes.
	axes, err := tone.Classify(ctx, sampleTexts)
	if err != nil {
		slog.Warn("tone classify degraded to fallback", "err", err.Error())
	}
	prof.Tonal.Humor = axes.Humor
	prof.Tonal.Optimism = axes.Optimism
	prof.Tonal.Directness = axes.Directness
	prof.Tonal.Formality = axes.Formality
	prof.Tonal.Warmth = axes.Warmth
	// PersonalVsObservational stays at zero unless LLM produces it
	// below — the heuristic doesn't have a calibrated signal here.

	// ---- Themes ----
	// When embeddings are wired, prefer k-means clustering in the
	// embedding space (ExtractThemesEmbedding) — it surfaces topical
	// groupings that single-word TF-IDF misses ("growth marketing" vs
	// "post-hoc analysis"). Falls back to TF-IDF when the client is nil
	// or the embedding call fails.
	corpus := make([]string, 0, len(items))
	for _, it := range items {
		if t := strings.TrimSpace(it.Text); t != "" {
			corpus = append(corpus, t)
		}
	}
	var scoredThemes []Theme
	if b.Embeddings != nil {
		scoredThemes = ExtractThemesEmbedding(ctx, b.Embeddings, corpus, ThemeClusterK)
	} else {
		scoredThemes = ExtractThemes(corpus, 10)
	}
	prof.Persona.RecurringThemesScored = scoredThemes
	if len(scoredThemes) > 0 {
		terms := make([]string, 0, len(scoredThemes))
		for _, th := range scoredThemes {
			terms = append(terms, th.Term)
		}
		prof.Persona.RecurringThemes = terms
	}

	// ---- Semantic signature centroid ----
	// Mean of the representative-sample embeddings, in the same
	// embedding space we use for fidelity scoring. Stored on the
	// profile so consumers (apps/api fidelity gates, the chat-handler
	// fidelity overlay) can score generated drafts without re-embedding
	// the writer's corpus on every request. Empty when no embedding
	// client is wired — downstream callers must handle nil/empty by
	// either degrading to legacy heuristics or asking the operator to
	// rebuild the profile.
	if b.Embeddings != nil && len(sampleTexts) > 0 {
		vecs, eerr := b.Embeddings.EmbedBatch(ctx, sampleTexts, embeddings.TaskTypeSemanticSimilarity)
		if eerr != nil {
			slog.Warn("embeddings: signature build failed; leaving SemanticSignature empty",
				"err", eerr.Error(),
				"samples", len(sampleTexts))
		} else {
			prof.SemanticSignature = centroid(vecs)
			prof.SemanticModel = embeddings.DefaultModel
		}
	}

	// ---- LLM-derived fields (SelfDisclosureRate, MetaphorPatterns,
	//      PersonalVsObservational) ----
	//
	// We still call AnalyzeTonal for axes the new tone classifier
	// doesn't cover. Themes from the LLM (if present) override the
	// TF-IDF list — the LLM tends to surface noun-phrase themes that
	// a single-word TF-IDF run can't capture. On any error we keep
	// the heuristic-derived values.
	if b.LLM != nil {
		t, p, met, err := b.LLM.AnalyzeTonal(ctx, sampleTexts)
		if err == nil {
			// Take the legacy axis the new classifier doesn't compute.
			prof.Tonal.PersonalVsObservational = t.PersonalVsObservational
			// If our heuristic produced a near-neutral score (a sign it
			// failed to discriminate), prefer the LLM's value for the
			// shared axes. Otherwise keep the heuristic — it's
			// deterministic and consistent run-to-run.
			if math.Abs(prof.Tonal.Humor-0.5) < 0.05 {
				prof.Tonal.Humor = t.Humor
			}
			if math.Abs(prof.Tonal.Optimism-0.5) < 0.05 {
				prof.Tonal.Optimism = t.Optimism
			}
			if math.Abs(prof.Tonal.Directness-0.5) < 0.05 {
				prof.Tonal.Directness = t.Directness
			}
			prof.Persona.SelfDisclosureRate = p.SelfDisclosureRate
			if len(p.RecurringThemes) > 0 {
				prof.Persona.RecurringThemes = p.RecurringThemes
			}
			prof.Vocabulary.MetaphorPatterns = met
		}
	}

	return prof, nil
}

// ----- helpers -----

// splitSentences delegates to the abbreviation-aware SegmentSentences
// (see sentences.go). Kept as a wrapper so older call sites continue to
// compile; new code should call SegmentSentences directly.
func splitSentences(text string) []string {
	return SegmentSentences(text)
}

var paraRe = regexp.MustCompile(`\n\s*\n+`)

func splitParagraphs(text string) []string {
	parts := paraRe.Split(text, -1)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return []string{text}
	}
	return out
}

var (
	// bulletRe spots markdown bullets / numbered lists at line start.
	bulletRe   = regexp.MustCompile(`(?m)^\s*(?:[-*+]\s+|\d+\.\s+)`)
	hedgeWords = []string{"maybe", "perhaps", "might", "could", "seems", "kind", "sort", "possibly"}
	// "I think" / "kind of" / "sort of" handled at phrase level below.
)

var hedgeSet = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range hedgeWords {
		m[w] = true
	}
	return m
}()

var tokenStripRe = regexp.MustCompile(`[^a-zA-Z']`)

func normalizeToken(t string) string {
	t = strings.ToLower(t)
	t = tokenStripRe.ReplaceAllString(t, "")
	return t
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

// formalityHeuristic returns 0..1. Higher = more formal.
//
// The score now blends the public-corpus-fitted formality axis with a
// lightweight structural prior (word length, contraction rate, exclamation
// density). That keeps the stylistic field stable for short samples while
// avoiding the old pure regex/word-length read.
func formalityHeuristic(text string) float64 {
	contractions := strings.Count(text, "'")
	excl := strings.Count(text, "!")
	words := strings.Fields(text)
	if len(words) == 0 {
		return 0.5
	}
	totalLen := 0
	for _, w := range words {
		totalLen += len(w)
	}
	avg := float64(totalLen) / float64(len(words))
	structural := math.Min(1, math.Max(0, (avg-3.5)/4.0))
	structural -= float64(contractions) / float64(len(words)) * 2
	structural -= float64(excl) / float64(len(words)) * 2
	structural = clamp01(structural)

	var fitted float64
	if axes, err := (FittedClassifier{}).Classify(context.Background(), []string{text}); err == nil {
		fitted = axes.Formality
	} else {
		fitted = scoreHeuristic(text).Formality
	}
	return clamp01(0.7*fitted + 0.3*structural)
}

func firstSentence(text string) string {
	s := splitSentences(text)
	if len(s) == 0 {
		return ""
	}
	return s[0]
}

func lastSentence(text string) string {
	s := splitSentences(text)
	if len(s) == 0 {
		return ""
	}
	return s[len(s)-1]
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

func pickDominant(counts map[string]int) string {
	best := ""
	bestN := 0
	total := 0
	for k, v := range counts {
		total += v
		if v > bestN {
			best, bestN = k, v
		}
	}
	if best == "" || total == 0 {
		return "mixed"
	}
	if float64(bestN)/float64(total) < 0.5 {
		return "mixed"
	}
	return best
}

// pickDominantClosing is identical to pickDominant but exists so we can tune
// independently if we discover closings need a different threshold.
func pickDominantClosing(counts map[string]int) string {
	return pickDominant(counts)
}

func sniffMarkdownStyle(items []ingest.Item) string {
	bold, ems := 0, 0
	for _, it := range items {
		if strings.Contains(it.Text, "**") {
			bold++
		}
		if strings.Contains(it.Text, "—") {
			ems++
		}
	}
	switch {
	case bold > 0 && ems > 0:
		return "bold-and-em-dashes"
	case bold > 0:
		return "uses-bold-emphasis"
	case ems > 0:
		return "prefers-em-dashes"
	default:
		return "plain"
	}
}

// detectIdioms scans for a high-precision lookup-table of common idioms and
// business/writing expressions. We normalize punctuation and hyphens before
// matching so "low hanging fruit" and "low-hanging fruit" collapse to the
// same phrase, while word boundaries avoid substring false positives.
var idiomLookup = []string{
	"piece of cake", "hit the ground running", "cut to the chase",
	"the elephant in the room", "boil the ocean", "low-hanging fruit",
	"move the needle", "ship it", "all-hands", "first principles",
	"back to square one", "ballpark estimate", "bandwidth", "big picture",
	"bite the bullet", "break the ice", "bring to the table",
	"call the shots", "close the loop", "deep dive", "double down",
	"draw a line in the sand", "drop the ball", "game changer",
	"get buy-in", "give a heads up", "go the extra mile", "gut check",
	"in the weeds", "keep the lights on", "kick the can",
	"land the plane", "level playing field", "long pole in the tent",
	"make or break", "no-brainer", "not rocket science",
	"on the same page", "out of pocket", "push the envelope",
	"raise the bar", "reinvent the wheel", "run it up the flagpole",
	"silver bullet", "single source of truth", "source of truth",
	"table stakes", "take it offline", "the tip of the iceberg",
	"through line", "under the hood", "walk the talk", "wheelhouse",
	"zero sum", "north star", "paved road", "sharp edges", "paper cuts",
	"escape hatch", "footgun", "happy path", "pit of success",
	"death by a thousand cuts", "yak shave", "rubber meets the road",
	"burn the boats", "cross the chasm", "flywheel", "forcing function",
	"golden path", "guardrails", "hair on fire", "muscle memory",
	"one-way door", "two-way door", "painted door", "wartime mode",
	"peacetime mode", "work backwards", "write the docs first",
	"measure twice cut once", "show your work", "strong opinions loosely held",
	"trust but verify", "default alive", "default dead",
	"thread the needle", "needle in a haystack", "tip the scales",
	"read between the lines", "connect the dots", "turn the corner",
	"clear the air", "raise a red flag", "red flag", "green light",
	"blue sky", "boil down", "storm in a teacup", "calm before the storm",
	"writing on the wall", "bend over backwards", "pull the plug",
	"plug the gap", "keep powder dry", "play it by ear", "stay the course",
	"change horses midstream", "cross that bridge", "last mile",
	"mile wide inch deep", "inch deep", "tiptoe around", "sweep under the rug",
	"under the rug", "needle mover", "heavy lift", "lift and shift",
}

func detectIdioms(items []ingest.Item) []string {
	hits := map[string]struct{}{}
	for _, it := range items {
		normalized := normalizePhraseText(it.Text)
		for _, idi := range idiomLookup {
			if containsNormalizedPhrase(normalized, idi) || containsIdiomVariant(normalized, idi) {
				hits[idi] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(hits))
	for k := range hits {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

var nonPhraseCharRe = regexp.MustCompile(`[^a-z0-9]+`)

func normalizePhraseText(text string) string {
	text = strings.ToLower(text)
	text = nonPhraseCharRe.ReplaceAllString(text, " ")
	return strings.Join(strings.Fields(text), " ")
}

func containsNormalizedPhrase(normalizedText, phrase string) bool {
	normalizedPhrase := normalizePhraseText(phrase)
	if normalizedText == "" || normalizedPhrase == "" {
		return false
	}
	return strings.Contains(" "+normalizedText+" ", " "+normalizedPhrase+" ")
}

var idiomVariants = map[string][]string{
	"close the loop":          {"closed the loop", "closes the loop", "closing the loop"},
	"move the needle":         {"moved the needle", "moves the needle", "moving the needle"},
	"double down":             {"doubled down", "doubling down", "doubles down"},
	"drop the ball":           {"dropped the ball", "dropping the ball", "drops the ball"},
	"raise the bar":           {"raised the bar", "raising the bar", "raises the bar"},
	"reinvent the wheel":      {"reinvented the wheel", "reinventing the wheel", "reinvents the wheel"},
	"push the envelope":       {"pushed the envelope", "pushing the envelope", "pushes the envelope"},
	"take it offline":         {"took it offline", "taking it offline", "takes it offline"},
	"hit the ground running":  {"hits the ground running"},
	"cut to the chase":        {"cuts to the chase", "cutting to the chase"},
	"bite the bullet":         {"bit the bullet", "biting the bullet", "bites the bullet"},
	"break the ice":           {"broke the ice", "breaking the ice", "breaks the ice"},
	"call the shots":          {"called the shots", "calling the shots"},
	"draw a line in the sand": {"drew a line in the sand", "drawing a line in the sand"},
	"land the plane":          {"landed the plane", "landing the plane", "lands the plane"},
	"work backwards":          {"worked backwards", "working backwards", "works backwards"},
	"connect the dots":        {"connected the dots", "connecting the dots", "connects the dots"},
	"turn the corner":         {"turned the corner", "turning the corner", "turns the corner"},
	"pull the plug":           {"pulled the plug", "pulling the plug", "pulls the plug"},
	"stay the course":         {"stayed the course", "staying the course", "stays the course"},
}

func containsIdiomVariant(normalizedText, idiom string) bool {
	for _, variant := range idiomVariants[idiom] {
		if containsNormalizedPhrase(normalizedText, variant) {
			return true
		}
	}
	return false
}

func topDistinctiveTerms(tf map[string]int, docFreq map[string]int, docCount int, total int, k int) []TermWeight {
	if total == 0 {
		return nil
	}
	scored := make([]TermWeight, 0, len(tf))
	for term, n := range tf {
		if len(term) <= 2 {
			continue
		}
		idf := wordfreq.IDF(term)
		coverage := 1.0
		if docCount > 1 {
			coverage = float64(docFreq[term]) / float64(docCount)
		}
		if coverage <= 0 {
			coverage = 1.0 / float64(maxInt(docCount, 1))
		}
		// Blend the global English-frequency baseline with tenant-corpus
		// spread. A one-off rare word in a single long post should not outrank
		// a writer's recurring vocabulary across multiple pieces.
		spreadBoost := 0.65 + 0.35*math.Sqrt(clamp01(coverage))
		if docCount >= 3 && docFreq[term] <= 1 {
			spreadBoost *= 0.55
		}
		score := (float64(n) / float64(total)) * idf * spreadBoost
		scored = append(scored, TermWeight{Term: term, Score: score})
	}
	sort.Slice(scored, func(i, j int) bool { return scored[i].Score > scored[j].Score })
	if len(scored) > k {
		scored = scored[:k]
	}
	return scored
}

func topRecurringPhrases(counts map[string]int, ns map[string]int, k int) []PhraseFreq {
	out := make([]PhraseFreq, 0, len(counts))
	for p, c := range counts {
		if c < 3 {
			continue
		}
		out = append(out, PhraseFreq{Phrase: p, N: ns[p], Count: c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].N > out[j].N
	})
	if len(out) > k {
		out = out[:k]
	}
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// buildSamples converts items into Sample candidates. Weight blends recency
// with content quality so a tiny recent post does not crowd out an older,
// more representative essay. Target-template relevance is still applied later
// by prompt selection/generation; this layer stays profile-generic.
func buildSamples(items []ingest.Item) []Sample {
	if len(items) == 0 {
		return nil
	}
	// find time range
	var minT, maxT time.Time
	for _, it := range items {
		if it.PublishedAt.IsZero() {
			continue
		}
		if minT.IsZero() || it.PublishedAt.Before(minT) {
			minT = it.PublishedAt
		}
		if it.PublishedAt.After(maxT) {
			maxT = it.PublishedAt
		}
	}
	span := maxT.Sub(minT).Seconds()
	out := make([]Sample, 0, len(items))
	for _, it := range items {
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		w := 0.5
		if span > 0 && !it.PublishedAt.IsZero() {
			w = it.PublishedAt.Sub(minT).Seconds() / span
		}
		if w < 0.1 {
			w = 0.1
		}
		w = clamp01(0.3*w + 0.7*sampleContentQuality(text))
		out = append(out, Sample{
			ID:         sampleID(it.ID, text),
			SourceType: string(it.SourceType),
			Text:       text,
			Tokens:     approxTokens(text),
			Weight:     w,
		})
	}
	return out
}

var specificityRe = regexp.MustCompile(`(?i)\b\d+([.,:]\d+)*%?\b|https?://|\b(because|therefore|for example|for instance|specifically|in practice|in other words|the reason)\b`)

func sampleContentQuality(text string) float64 {
	words := strings.Fields(text)
	if len(words) == 0 {
		return 0
	}
	wordCount := len(words)
	lengthScore := clamp01(float64(wordCount) / 120.0)
	if wordCount > 900 {
		lengthScore = clamp01(1.0 - float64(wordCount-900)/1800.0)
	}
	sentenceCount := len(SegmentSentences(text))
	sentenceScore := clamp01(float64(sentenceCount) / 4.0)
	if sentenceCount > 14 {
		sentenceScore = clamp01(1.0 - float64(sentenceCount-14)/28.0)
	}
	specificityScore := clamp01(float64(len(specificityRe.FindAllString(text, -1))) / 3.0)
	unique := map[string]struct{}{}
	for _, w := range words {
		if tok := normalizeToken(w); tok != "" {
			unique[tok] = struct{}{}
		}
	}
	densityScore := 0.5
	if len(words) > 0 {
		densityScore = clamp01(float64(len(unique)) / float64(len(words)) * 1.5)
	}
	return clamp01(0.35*lengthScore + 0.25*sentenceScore + 0.25*specificityScore + 0.15*densityScore)
}

func sampleID(seed, text string) string {
	if seed != "" {
		return seed
	}
	h := sha1.Sum([]byte(text))
	return hex.EncodeToString(h[:8])
}

// approxTokens estimates token count as words * 1.3 (rough English heuristic).
func approxTokens(text string) int {
	w := len(strings.Fields(text))
	return int(float64(w) * 1.3)
}
