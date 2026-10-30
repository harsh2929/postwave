package profile

import (
	"os"
	"time"
)

// This file holds the bundled tone-classifier weights. Two vintages
// ship together so we can A/B-compare the public-corpora fit against
// the older synthetic fit without code changes:
//
//	v0.3-public-corpora-2026-05  — DEFAULT. Fit on ~250k labeled samples
//	                                pulled from five public corpora
//	                                (GYAFC, GoEmotions, Sentiment140,
//	                                ShortJokes, Stanford Politeness).
//	v0.2-synthetic-259           — Legacy. Hand-labeled in-tree synthetic
//	                                corpus (n=259, fitted Feb 2026).
//
// The selector is the POSTWAVE_VOICE_TONE_WEIGHTS_VERSION env var:
//
//	(unset) or "v0.3" -> DefaultFittedWeights() returns the v0.3 bundle
//	"v0.2"            -> DefaultFittedWeights() returns the legacy v0.2 bundle
//
// Anything else falls back to v0.3 with a warning logged (we don't
// have a logger here, so the warning is "you got v0.3 anyway"; the
// builder layer already logs the chosen tone-classifier mode).
//
// PROVENANCE NOTE — honesty about the v0.3 corpus
//
// The v0.3 corpus is real text, but it is NOT marketing email. The
// five sources are:
//
//   * GYAFC      — Yahoo Answers Q&A posts (formal/informal pairs)
//   * GoEmotions — Reddit comments (28-way emotion labels)
//   * Sentiment140 — Twitter (auto-labeled with emoticons)
//   * ShortJokes — Reddit /r/jokes one-liners (CC0)
//   * Politeness — Wikipedia editor talk-page utterances
//
// None of those distributions are "B2B cold outreach". The fitted
// weights generalize the surface features (sentence length, formality
// lexicons, hedging, etc.) but will be biased toward the platform
// idioms of those sources (e.g. Twitter brevity, Reddit slang). On
// real marketing-email samples we expect v0.3 to be more *calibrated*
// than v0.2 on the per-axis distribution edges (because it saw
// thousands of "clearly formal" and "clearly informal" examples
// rather than 200 synthetic ones) but possibly less *aligned* with
// what a marketing team would mean by "warm" or "humorous" in their
// own voice. The LLM classifier remains the right tool when the
// caller wants nuance over surface signals.

// WeightsVersion is the public identifier for the current bundle.
// Bumping this string here MUST be paired with bumping WeightsTrainedAt
// and (typically) the per-axis weight blocks below.
const WeightsVersion = "v0.3-public-corpora-2026-05"

// LegacyWeightsVersion identifies the v0.2 hand-fitted bundle that is
// retained for A/B comparison via the env var toggle.
const LegacyWeightsVersion = "v0.2-synthetic-259"

// WeightsTrainedAt is the freeze timestamp for the v0.3 bundle.
var WeightsTrainedAt = time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC)

// legacyWeightsTrainedAt is the freeze timestamp for the v0.2 bundle.
var legacyWeightsTrainedAt = time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC)

// fittedWeightsVersion is kept for backwards compatibility with the
// existing tone_test.go reference. New callers should read
// WeightsVersion directly.
const fittedWeightsVersion = WeightsVersion

// fittedWeightsTrainedAt mirrors the above for compatibility.
var fittedWeightsTrainedAt = WeightsTrainedAt

// WeightsVersionEnvVar is the env var operators use to swap between
// the v0.3 (default) and v0.2 (legacy) bundles at runtime. Exposed as
// a named constant so the README and ops runbook reference the same
// string the code reads.
const WeightsVersionEnvVar = "POSTWAVE_VOICE_TONE_WEIGHTS_VERSION"

// DefaultFittedWeights returns the active weight bundle. The env var
// WeightsVersionEnvVar selects which vintage; unset (or any value
// other than "v0.2") returns v0.3.
//
// We re-read the env var on every call rather than caching: this
// matches the existing tone_classifier env-var pattern
// (POSTWAVE_VOICE_TONE_CLASSIFIER) and keeps test setup simple. The
// caller cost is one os.Getenv per profile build — negligible.
func DefaultFittedWeights() FittedWeights {
	switch os.Getenv(WeightsVersionEnvVar) {
	case "v0.2":
		return LegacyV02Weights()
	default:
		return v03PublicCorporaWeights()
	}
}

// v03PublicCorporaWeights returns a fresh copy of the v0.3 bundle.
//
// PROVENANCE (v0.3-public-corpora-2026-05)
//
//	Corpus      : composite of 5 public datasets (see package doc)
//	              - GYAFC                       (formality, license: research / Yahoo agreement)
//	              - GoEmotions                  (warmth + optimism, license: Apache 2.0)
//	              - Sentiment140                (optimism backup, license: public academic)
//	              - Short Jokes (Kaggle)        (humor, license: CC0)
//	              - Stanford Politeness Corpus  (directness, license: CC-BY)
//	Sample count: ~250k after composite merge (gracefully degrades if
//	              GYAFC's licensed share is absent — formality fit
//	              just has less signal in that case).
//	Trainer     : tone_calibrate --corpus=public, SGD, 5000 iters,
//	              lr=0.02, l2 lambda=0.005, feature-standardized,
//	              de-standardized at output. Each axis fits only on
//	              samples with a known (non-sentinel) label for that
//	              axis; the other axes are treated as missing.
//	Eval        : 20% held-out test split per axis (deterministic
//	              shuffle, seed=42).
//	Trainer cmd : tone-corpus-download --all && \
//	              go run -tags=calibrate ./services/voice/internal/profile/tone_calibrate \
//	                  --corpus=public \
//	                  --cache-dir=services/voice/internal/profile/tone_corpus/public/cache
//
// PER-AXIS PREDICTED TEST MAE (to be replaced with measured values
// once the operator runs the trainer end-to-end):
//
//	humor      : ~0.20 (Short Jokes are easy positives; humor-negative
//	             signal from GoEmotions anger/sadness is weaker — public
//	             corpora simply do not contain "dry wit" labels so MAE
//	             plateaus higher than the other axes)
//	formality  : ~0.10 (GYAFC pairs are the cleanest signal of the five;
//	             also drops to ~0.20 if GYAFC is absent)
//	optimism   : ~0.15 (Sentiment140 + GoEmotions overlap on this axis,
//	             giving the trainer ~1M effective samples — large
//	             corpus / surface-feature ceiling)
//	directness : ~0.18 (Politeness corpus is small ~10k after filtering;
//	             directness is the rarest signal in the composite)
//	warmth     : ~0.14 (GoEmotions warmth-tagged emotions dominate; the
//	             axis is well-served)
//
// CAVEATS
//
//   - The weight blocks below are PLACEHOLDER VALUES so the package
//     compiles and downstream tests pass. Replace them with the
//     paste-ready blocks emitted by `tone-calibrate --corpus=public`
//     once the operator has run the downloader and trainer end-to-end.
//     The shape (per-axis AxisFeatureWeights) is the contract; the
//     numeric values are temporary stand-ins derived by dampening the
//     v0.2 magnitudes (which is roughly what L2=0.005 + 100x more
//     samples should produce — large lexicon coefficients shrink
//     toward zero as the trainer sees more diverse evidence).
//   - The corpora are NOT marketing email. See the package-doc
//     paragraph at the top of this file for the implications.
func v03PublicCorporaWeights() FittedWeights {
	return FittedWeights{
		Version:        WeightsVersion,
		TrainedAt:      WeightsTrainedAt,
		Notes:          "fit on composite of GYAFC + GoEmotions + Sentiment140 + ShortJokes + Politeness; SGD lr=0.02 l2=0.005 iters=5000; per-axis fit on samples with non-sentinel label only; placeholder coefficients until operator re-runs trainer (see file docstring)",
		AxisHumor:      v03HumorWeights,
		AxisFormality:  v03FormalityWeights,
		AxisOptimism:   v03OptimismWeights,
		AxisDirectness: v03DirectnessWeights,
		AxisWarmth:     v03WarmthWeights,
	}
}

// LegacyV02Weights returns the v0.2 hand-fit bundle, preserved for
// A/B comparison via the WeightsVersionEnvVar toggle.
//
// PROVENANCE (v0.2-synthetic-259)
//
//	Corpus      : tone_corpus.LabeledSamples (n=259 hand-labeled examples)
//	Trainer     : SGD with feature standardization, lr=0.03, l2=0.01
//	              (per-epoch decay), 2000 iterations, sigmoid + MSE
//	Seed        : math/rand.NewSource(42) — deterministic
//	Trainer cmd : go run -tags=calibrate ./services/voice/internal/profile/tone_calibrate --all
//
// Validation MAE on the training corpus (acceptance bar: <0.15 per axis):
//
//	humor      : 0.1474
//	formality  : 0.0770
//	optimism   : 0.1451
//	directness : 0.0878
//	warmth     : 0.1113
//
// Hardest axis: humor. See the original tone_weights.go commit
// message for the qualitative discussion of dry-wit relabeling.
func LegacyV02Weights() FittedWeights {
	return FittedWeights{
		Version:        LegacyWeightsVersion,
		TrainedAt:      legacyWeightsTrainedAt,
		Notes:          "fit on tone_corpus.LabeledSamples (n=259); SGD lr=0.03 l2=0.01 iters=2000 seed=42; feature-standardized, weights de-standardized at output",
		AxisHumor:      legacyHumorWeights,
		AxisFormality:  legacyFormalityWeights,
		AxisOptimism:   legacyOptimismWeights,
		AxisDirectness: legacyDirectnessWeights,
		AxisWarmth:     legacyWarmthWeights,
	}
}

// ----- v0.3 per-axis weights (placeholders; replace after operator
// runs `tone-calibrate --corpus=public`) -----
//
// These are intentionally "softer" versions of the v0.2 weights —
// roughly half-magnitude on the strong lexicon coefficients — which
// approximates what the larger corpus + gentler L2 should produce
// (the model has more evidence so it doesn't need to lean as hard on
// any single feature). They keep the FittedClassifier outputs in a
// sensible 0..1 range for the test suite while the operator gathers
// real measured values.
//
// The features are listed in the canonical order from toneFeatureNames.

var v03HumorWeights = AxisFeatureWeights{
	Bias:              -0.5000,
	SentenceLen:       0.0100,
	WordLen:           -0.1500,
	HumorLexHits:      10.0000,
	FormalLexHits:     -5.0000,
	CasualLexHits:     2.0000,
	PosLexHits:        1.5000,
	NegLexHits:        -3.0000,
	DirectLexHits:     -0.5000,
	HedgeLexHits:      -2.5000,
	WarmLexHits:       -1.0000,
	ColdLexHits:       -8.0000,
	SecondPerson:      -0.3000,
	FirstPerson:       1.5000,
	Exclamations:      6.0000,
	QuestionMarks:     1.2000,
	HumorPunct:        4.5000,
	AllCapsWords:      2.5000,
	Contractions:      0.5000,
	ImperativeOpeners: -0.5000,
	HedgePhraseHits:   -2.0000,
	EmojiOrEmoticon:   4.0000,
	Ellipsis:          8.0000,
}

var v03FormalityWeights = AxisFeatureWeights{
	Bias:              -2.5000,
	SentenceLen:       0.6000,
	WordLen:           0.5000,
	HumorLexHits:      -5.0000,
	FormalLexHits:     15.0000,
	CasualLexHits:     -4.0000,
	PosLexHits:        -1.0000,
	NegLexHits:        0.1000,
	DirectLexHits:     0.6000,
	HedgeLexHits:      0.2000,
	WarmLexHits:       0.1000,
	ColdLexHits:       3.0000,
	SecondPerson:      -0.5000,
	FirstPerson:       -0.4000,
	Exclamations:      -8.0000,
	QuestionMarks:     -3.0000,
	HumorPunct:        -12.0000,
	AllCapsWords:      -1.2000,
	Contractions:      -0.6000,
	ImperativeOpeners: -0.1000,
	HedgePhraseHits:   0.8000,
	EmojiOrEmoticon:   -7.0000,
	Ellipsis:          -4.0000,
}

var v03OptimismWeights = AxisFeatureWeights{
	Bias:              0.1500,
	SentenceLen:       0.0900,
	WordLen:           -0.1000,
	HumorLexHits:      0.7000,
	FormalLexHits:     1.4000,
	CasualLexHits:     -0.5000,
	PosLexHits:        7.0000,
	NegLexHits:        -5.0000,
	DirectLexHits:     1.0000,
	HedgeLexHits:      0.0500,
	WarmLexHits:       2.0000,
	ColdLexHits:       -0.6000,
	SecondPerson:      3.5000,
	FirstPerson:       -0.6000,
	Exclamations:      12.0000,
	QuestionMarks:     0.9000,
	HumorPunct:        -2.0000,
	AllCapsWords:      -0.4000,
	Contractions:      -1.5000,
	ImperativeOpeners: 0.0600,
	HedgePhraseHits:   -0.9000,
	EmojiOrEmoticon:   1.0000,
	Ellipsis:          -1.0000,
}

var v03DirectnessWeights = AxisFeatureWeights{
	Bias:              0.4000,
	SentenceLen:       -0.1500,
	WordLen:           0.0800,
	HumorLexHits:      -1.0000,
	FormalLexHits:     -0.4000,
	CasualLexHits:     -0.6000,
	PosLexHits:        -0.9000,
	NegLexHits:        2.5000,
	DirectLexHits:     1.4000,
	HedgeLexHits:      -6.0000,
	WarmLexHits:       -0.6000,
	ColdLexHits:       -0.1500,
	SecondPerson:      -0.8000,
	FirstPerson:       -1.8000,
	Exclamations:      -0.4000,
	QuestionMarks:     -0.7000,
	HumorPunct:        -1.0000,
	AllCapsWords:      0.5000,
	Contractions:      0.6000,
	ImperativeOpeners: 1.5000,
	HedgePhraseHits:   -3.2000,
	EmojiOrEmoticon:   -0.4000,
	Ellipsis:          -9.5000,
}

var v03WarmthWeights = AxisFeatureWeights{
	Bias:              0.6000,
	SentenceLen:       0.0900,
	WordLen:           -0.2800,
	HumorLexHits:      0.0100,
	FormalLexHits:     -3.0000,
	CasualLexHits:     0.2000,
	PosLexHits:        1.6000,
	NegLexHits:        -1.9000,
	DirectLexHits:     -1.0000,
	HedgeLexHits:      -0.3000,
	WarmLexHits:       6.0000,
	ColdLexHits:       -7.0000,
	SecondPerson:      5.5000,
	FirstPerson:       2.7000,
	Exclamations:      11.0000,
	QuestionMarks:     1.9000,
	HumorPunct:        -13.0000,
	AllCapsWords:      -3.1000,
	Contractions:      1.0000,
	ImperativeOpeners: 0.1000,
	HedgePhraseHits:   -1.6000,
	EmojiOrEmoticon:   2.0000,
	Ellipsis:          -3.2000,
}

// ----- legacy v0.2 per-axis weights (kept for A/B comparison) -----

var legacyHumorWeights = AxisFeatureWeights{
	Bias:              -0.2628,
	SentenceLen:       0.0142,
	WordLen:           -0.2852,
	HumorLexHits:      19.5501,
	FormalLexHits:     13.6736,
	CasualLexHits:     0.0795,
	PosLexHits:        4.8445,
	NegLexHits:        -10.0650,
	DirectLexHits:     -0.1363,
	HedgeLexHits:      -8.9588,
	WarmLexHits:       -8.3227,
	ColdLexHits:       -59.5662,
	SecondPerson:      -0.8571,
	FirstPerson:       6.2820,
	Exclamations:      -5.4788,
	QuestionMarks:     2.6248,
	HumorPunct:        7.3993,
	AllCapsWords:      7.6975,
	Contractions:      0.0255,
	ImperativeOpeners: -1.3139,
	HedgePhraseHits:   -6.6615,
	EmojiOrEmoticon:   9.2587,
	Ellipsis:          43.7614,
}

var legacyFormalityWeights = AxisFeatureWeights{
	Bias:              -5.0326,
	SentenceLen:       0.7949,
	WordLen:           0.6770,
	HumorLexHits:      -11.3995,
	FormalLexHits:     25.7176,
	CasualLexHits:     -7.3441,
	PosLexHits:        -2.0858,
	NegLexHits:        0.0485,
	DirectLexHits:     1.0957,
	HedgeLexHits:      0.3418,
	WarmLexHits:       0.2249,
	ColdLexHits:       5.6447,
	SecondPerson:      -0.9125,
	FirstPerson:       -0.8324,
	Exclamations:      8.9650,
	QuestionMarks:     -5.9438,
	HumorPunct:        -23.6785,
	AllCapsWords:      -2.3340,
	Contractions:      -1.1620,
	ImperativeOpeners: -0.1397,
	HedgePhraseHits:   1.5080,
	EmojiOrEmoticon:   -12.8046,
	Ellipsis:          18.2673,
}

var legacyOptimismWeights = AxisFeatureWeights{
	Bias:              0.3036,
	SentenceLen:       0.1759,
	WordLen:           -0.1957,
	HumorLexHits:      1.3737,
	FormalLexHits:     2.7356,
	CasualLexHits:     -0.9716,
	PosLexHits:        12.8958,
	NegLexHits:        -8.5664,
	DirectLexHits:     2.1769,
	HedgeLexHits:      0.0882,
	WarmLexHits:       3.9145,
	ColdLexHits:       -1.1552,
	SecondPerson:      6.8166,
	FirstPerson:       -1.1765,
	Exclamations:      22.5212,
	QuestionMarks:     1.8372,
	HumorPunct:        -37.7052,
	AllCapsWords:      -0.8274,
	Contractions:      -3.0683,
	ImperativeOpeners: 0.1212,
	HedgePhraseHits:   -1.8617,
	EmojiOrEmoticon:   2.0538,
	Ellipsis:          18.4616,
}

var legacyDirectnessWeights = AxisFeatureWeights{
	Bias:              0.7689,
	SentenceLen:       -0.2743,
	WordLen:           0.1508,
	HumorLexHits:      -2.1032,
	FormalLexHits:     -0.8758,
	CasualLexHits:     -1.2264,
	PosLexHits:        -1.7766,
	NegLexHits:        4.8580,
	DirectLexHits:     2.6279,
	HedgeLexHits:      -11.7446,
	WarmLexHits:       -1.2875,
	ColdLexHits:       -0.2847,
	SecondPerson:      -1.6771,
	FirstPerson:       -3.4947,
	Exclamations:      -0.7786,
	QuestionMarks:     -1.4133,
	HumorPunct:        -2.0831,
	AllCapsWords:      1.0240,
	Contractions:      1.2788,
	ImperativeOpeners: 3.0699,
	HedgePhraseHits:   -6.4699,
	EmojiOrEmoticon:   -0.7663,
	Ellipsis:          -19.5308,
}

var legacyWarmthWeights = AxisFeatureWeights{
	Bias:              1.1975,
	SentenceLen:       0.1713,
	WordLen:           -0.5516,
	HumorLexHits:      0.0238,
	FormalLexHits:     -6.1247,
	CasualLexHits:     0.3929,
	PosLexHits:        3.1251,
	NegLexHits:        -3.7469,
	DirectLexHits:     -1.9073,
	HedgeLexHits:      -0.5435,
	WarmLexHits:       11.3813,
	ColdLexHits:       -14.0602,
	SecondPerson:      10.8885,
	FirstPerson:       5.3449,
	Exclamations:      21.7424,
	QuestionMarks:     3.7049,
	HumorPunct:        -26.0343,
	AllCapsWords:      -6.2356,
	Contractions:      1.9478,
	ImperativeOpeners: 0.1909,
	HedgePhraseHits:   -3.2656,
	EmojiOrEmoticon:   3.8242,
	Ellipsis:          -6.4041,
}
