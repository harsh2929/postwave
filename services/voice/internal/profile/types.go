// Package profile defines the VoiceProfile schema and builder for Pillar 3.
//
// A VoiceProfile is a compact (~3KB JSON) distillation of a writer's source
// material. It is consumed downstream as few-shot context for Gemini
// generation and as a target for voice-fidelity scoring.
//
// PRD reference: §7.3.2.
package profile

import "time"

// VoiceProfile is the top-level voice fingerprint for a tenant/writer.
//
// All numeric features are normalized so the document is portable between
// model versions. Serializes to roughly 3KB JSON when RepresentativeSamples
// holds 8K tokens of passages (samples dominate the byte budget).
type VoiceProfile struct {
	TenantID              string                `json:"tenant_id"`
	Version               int                   `json:"version"`
	GeneratedAt           time.Time             `json:"generated_at"`
	Stylistic             Stylistic             `json:"stylistic"`
	Vocabulary            Vocabulary            `json:"vocabulary"`
	Structural            Structural            `json:"structural"`
	Tonal                 Tonal                 `json:"tonal"`
	Persona               Persona               `json:"persona"`
	RepresentativeSamples []Sample              `json:"representative_samples"`
	SourceSummary         map[string]SourceStat `json:"source_summary"`
	// SemanticSignature is the centroid of representative-sample embeddings
	// in Gemini text-embedding-004 space (768-dim by default). It is the
	// reference vector for voice-fidelity cosine scoring (see fidelity.go)
	// and powers per-tenant similarity queries downstream.
	//
	// Empty when GEMINI_API_KEY is unset at profile-build time; consumers
	// must handle nil/empty by either degrading to legacy heuristics or
	// surfacing a "rebuild profile to enable semantic scoring" prompt.
	// Tagged `omitempty` so old profiles serialized before this field
	// existed continue to round-trip cleanly.
	SemanticSignature []float64 `json:"semantic_signature,omitempty"`
	// SemanticModel records which embedding model produced the signature.
	// Used as the cache key in voice_semantic_signatures so a future
	// model upgrade triggers a rebuild rather than silently mixing old
	// and new vector spaces.
	SemanticModel string `json:"semantic_model,omitempty"`
}

// Stylistic captures sentence/paragraph shape and voice posture.
//
// Computed locally without LLMs:
//   - AvgSentenceLength: mean tokens per sentence (whitespace tokens).
//   - SentenceLengthVariance: variance of the same.
//   - AvgParagraphLength: mean sentences per paragraph (paragraphs split on \n\n).
//   - FormalityScore: 0..1 — blend of the public-corpus-fitted formality
//     axis and a structural prior from contraction rate, punctuation, and
//     word shape. Future tenant-specific labels can recalibrate the weights.
//   - HedgingFrequency: occurrences of {maybe, perhaps, might, could, seems,
//     I think, kind of, sort of, possibly} per 1000 words.
//   - PassiveVoicePct: fraction of sentences containing a passive construction
//     detected by HasPassiveVoice, a token-level be/get + participle detector
//     with irregular participles, adverb gaps, and stative-adjective guards.
type Stylistic struct {
	AvgSentenceLength      float64 `json:"avg_sentence_length"`
	SentenceLengthVariance float64 `json:"sentence_length_variance"`
	AvgParagraphLength     float64 `json:"avg_paragraph_length"`
	FormalityScore         float64 `json:"formality_score"`
	HedgingFrequency       float64 `json:"hedging_frequency"`
	PassiveVoicePct        float64 `json:"passive_voice_pct"`
}

// TermWeight is a single distinctive term + its tenant-adaptive TF-IDF score.
// The score blends the embedded English-frequency baseline with how widely a
// token appears across this writer's own source corpus.
type TermWeight struct {
	Term  string  `json:"term"`
	Score float64 `json:"score"`
}

// PhraseFreq is a recurring n-gram (n in 2..5) and its observed count.
type PhraseFreq struct {
	Phrase string `json:"phrase"`
	N      int    `json:"n"`
	Count  int    `json:"count"`
}

// Vocabulary captures the writer's distinctive lexicon.
//
//   - DistinctiveTerms: top-100 high-distinctiveness words ranked by TF,
//     embedded English IDF, and writer-corpus spread.
//   - RecurringPhrases: 2..5-grams with count ≥ 3 (cap top 50).
//   - IdiomMarkers: high-precision idiomatic expressions surfaced via a
//     boundary-safe curated lookup table. Domain-specific idiom extraction can
//     still be improved by an optional LLM/context pass later.
//   - MetaphorPatterns: extracted by the same LLM call that produces Tonal/Persona.
type Vocabulary struct {
	DistinctiveTerms []TermWeight `json:"distinctive_terms"`
	RecurringPhrases []PhraseFreq `json:"recurring_phrases"`
	IdiomMarkers     []string     `json:"idiom_markers"`
	MetaphorPatterns []string     `json:"metaphor_patterns"`
}

// Structural captures the writer's macro-shape habits.
//
//   - OpeningHookStyle ∈ {"anecdote","question","statistic","declaration","mixed"}
//     — categorized by inspecting the first sentence of each item.
//   - ClosingPattern ∈ {"cta","reflection","question","signoff","mixed"}
//     — categorized by inspecting the last sentence of each item.
//   - BulletListUsageRate: fraction of items containing at least one
//     bulleted/numbered list line.
//   - MarkdownStyleHint: free-text hint, e.g. "uses-bold-emphasis",
//     "prefers-em-dashes". Computed by simple regex sniffing.
type Structural struct {
	OpeningHookStyle    string  `json:"opening_hook_style"`
	ClosingPattern      string  `json:"closing_pattern"`
	BulletListUsageRate float64 `json:"bullet_list_usage_rate"`
	MarkdownStyleHint   string  `json:"markdown_style_hint"`
}

// Tonal axes are 0..1 each, produced by either the heuristic tone
// classifier (default) or the LLM tone classifier (opt-in via
// POSTWAVE_VOICE_TONE_CLASSIFIER=llm).
//
// Original axes (V1; produced by both heuristic and LLM):
//   - Humor: how often humor/wit shows up.
//   - Optimism: positive-vs-negative framing balance.
//   - PersonalVsObservational: 0 = third-person/observational, 1 = first-person/personal.
//   - Directness: 0 = hedged/exploratory, 1 = direct/imperative.
//
// V2 axes (added when the new tone classifier runs):
//   - Formality: 0 = texting/Slack, 1 = academic.
//   - Warmth: 0 = clinical/cold, 1 = warm/inviting.
//
// V2 fields are tagged `omitempty` so consumers reading old profiles
// won't choke on missing values; the Tonal struct is a strict superset
// of the V1 shape.
type Tonal struct {
	Humor                   float64 `json:"humor"`
	Optimism                float64 `json:"optimism"`
	PersonalVsObservational float64 `json:"personal_vs_observational"`
	Directness              float64 `json:"directness"`
	Formality               float64 `json:"formality,omitempty"`
	Warmth                  float64 `json:"warmth,omitempty"`
}

// Persona captures self-presentation patterns.
//
//   - PronounUsage: ratios for {"i","we","you"} (each 0..1, may not sum to 1
//     because "they"/"it"/etc. are excluded).
//   - SelfDisclosureRate: 0..1 estimate of how often the writer references
//     their own life/experience. LLM-produced.
//   - RecurringThemes: 5–10 short terms extracted via TF-IDF over the
//     writer's corpus (see themes.go). Kept as []string for backwards
//     compatibility with downstream consumers; for the scored/frequency
//     view, see RecurringThemesScored.
//   - RecurringThemesScored: same set of terms with TF-IDF score and raw
//     frequency. Optional; populated alongside RecurringThemes by the
//     builder. Strict superset of the V1 RecurringThemes field.
type Persona struct {
	PronounUsage          map[string]float64 `json:"pronoun_usage"`
	SelfDisclosureRate    float64            `json:"self_disclosure_rate"`
	RecurringThemes       []string           `json:"recurring_themes"`
	RecurringThemesScored []Theme            `json:"recurring_themes_scored,omitempty"`
}

// SourceStat summarizes what was ingested from one source type.
type SourceStat struct {
	WordCount      int       `json:"word_count"`
	ItemCount      int       `json:"item_count"`
	LastIngestedAt time.Time `json:"last_ingested_at"`
}
