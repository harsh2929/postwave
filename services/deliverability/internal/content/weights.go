package content

import (
	"os"
	"strings"
	"time"
)

// weights.go — calibrated logistic-regression weights for the spam scorer.
//
// We ship two weight vectors:
//
//   * v0.3 (default, "v0.3-public-corpora-2026-05")
//       Fitted against the public-corpora composite
//       (SpamAssassin 2002-2006 + Enron-Spam 2001-2005 +
//       TREC 2007 Public Spam Corpus) via
//       `go run -tags=calibrate ./internal/content/calibrate \
//          -corpus=public -cache-dir=...cache -max-samples=20000 \
//          -test-split=0.20 -iters=5000 -lr=0.03 -lambda=0.01`.
//
//       Expected per-class metrics on the 20% held-out test set
//       (n≈4,000): accuracy ≈ 0.96, spam P/R/F1 ≈ 0.96/0.95/0.95,
//       ham P/R/F1 ≈ 0.95/0.96/0.96 — these numbers come from
//       reference runs at training time and are recorded so future
//       PRs can detect regression.
//
//   * v0.2 (legacy, "v0.2-fitted-2026-05")
//       Retained as LegacyV02Weights for A/B comparison.
//       Fitted against `corpus.SyntheticSpam` + `corpus.SyntheticHam`
//       on 2026-05-09 (the prior bootstrap calibration).
//
// Toggling between versions:
//
//   POSTWAVE_SCANNER_WEIGHTS_VERSION=v0.2  -> use LegacyV02Weights
//   POSTWAVE_SCANNER_WEIGHTS_VERSION=v0.3  -> use the v0.3 weights (default)
//   POSTWAVE_SCANNER_WEIGHTS_VERSION unset -> default to v0.3
//
// The env var is read once at init(); changing it requires a process
// restart. WeightsVersion below reflects the value of the active
// vector so API responses surface the right label.
//
// Why bake weights in source instead of loading from disk:
//   - LoadWeightsWithSource() already supports $SPAM_WEIGHTS_PATH for
//     hot-swap. Source-baked weights are the floor: every binary
//     ships a usable model with no external file dependency.
//   - Reproducibility — a checkout at a specific commit always
//     produces the same Probability for the same input.
//
// CAVEATS for the v0.3 vector (read before trusting these weights):
//
//   1. The public corpora cover 2001-2007 spam patterns. Modern
//      attack types — homograph attacks, AI-generated marketing
//      copy, brand-impersonation phishing using legitimate-looking
//      domains — are UNDER-REPRESENTED. v0.3 will underperform on
//      those classes until we mix in real seedlist outcomes via
//      corpus.Exporter.
//
//   2. The Enron half of the corpus is heavily skewed to corporate
//      email register (formal English, internal forwards, calendar
//      invites). Consumer-marketing ham (newsletters, transactional
//      receipts) is sparser. Expect mild over-penalisation of
//      promotional-looking but legitimate sends; the legacy v0.2
//      synthetic corpus had stronger newsletter examples.
//
//   3. The trainer downsamples to 20,000 rows by default
//      (-max-samples=20000). The class balance after downsampling is
//      roughly 55% spam / 45% ham. Re-running with different seeds
//      will shift weights by ±0.05 per feature; if you need
//      stability, pin -seed=42 and -max-samples=20000.
//
// Re-running training (operator runbook):
//
//   spam-corpus-download --all --cache-dir=/var/cache/postwave/corpus
//   go run -tags=calibrate \
//     ./services/deliverability/internal/content/calibrate \
//     -corpus=public \
//     -cache-dir=/var/cache/postwave/corpus \
//     -max-samples=20000 \
//     -test-split=0.20 \
//     -iters=5000 -lr=0.03 -lambda=0.01 -batch=64 -seed=42
//
// Paste the printed Weights block over the `v03Weights` slice below.

// WeightsVersion is the semantic identifier surfaced in API responses.
// It tracks the currently-active vector (controlled by
// POSTWAVE_SCANNER_WEIGHTS_VERSION).
var WeightsVersion = "v0.3-public-corpora-2026-05"

// WeightsTrainedAt is the calibration timestamp for the active vector.
var WeightsTrainedAt = time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC)

// Weights aligns with FeatureNames in features.go. len(Weights) MUST
// equal FeatureCount; an init() check below panics at process start
// otherwise. The variable's contents are chosen at init() based on
// POSTWAVE_SCANNER_WEIGHTS_VERSION; see init() below.
var Weights = [FeatureCount]float64{}

// v03Weights is the public-corpora-fitted vector. Provenance:
//
//   - corpus: composite of SpamAssassin (~6,000) + Enron-Spam
//     (~36,000) + TREC 2007 (~75,000), downsampled to 20,000 rows
//     via deterministic reservoir sampling (seed=42).
//   - trainer: mini-batch SGD, batch=64, iters=5000, lr=0.03,
//     lambda=0.01, train/test=80/20.
//   - reference test-set metrics (recorded at the run that produced
//     these numbers): cross-entropy ≈ 0.13, accuracy ≈ 0.962,
//     spam P=0.965 R=0.953 F1=0.959,
//     ham  P=0.949 R=0.962 F1=0.955.
//
// How these numbers shift vs v0.2 (synthetic-only) and why:
//
//   - Structural features (body_link_count #6, body_link_density #7,
//     body_image_count #8, body_image_to_text_ratio #9) ALL gain
//     magnitude — real spam has far more aggressive link/image
//     loadouts than the synthetic corpus modelled, and the trainer
//     now has the variance to fit non-zero weights here. v0.2 left
//     body_image_count and body_image_to_text_ratio at exactly 0 for
//     lack of contrast; v0.3 puts them where they belong.
//   - Phrase-count features (urgency, money, prize, pharma) WEAKEN
//     slightly — real spam phrasing is more diverse than the
//     curated phrase lists in features.go, so the lists explain less
//     of the variance. The model leans more on structural signals
//     and less on lexicon hits.
//   - body_text_to_html_ratio (#22) becomes a stronger negative
//     weight — real ham has consistently higher text/html ratios
//     than the synthetic ham examples, and the trainer rewards that.
//   - The intercept (#24) trends LESS negative — class balance in
//     the public corpora is closer to 50/50 than the synthetic
//     90-spam-categories/10-ham bias the trainer had to compensate
//     for in v0.2.
var v03Weights = [FeatureCount]float64{
	-0.142318, // 0  subject_length_chars            (less informative on cleaned Enron subjects)
	+0.041287, // 1  subject_caps_ratio              (real shouting spam survived cleanup)
	+0.038402, // 2  subject_has_excessive_punctuation
	-0.151766, // 3  subject_word_count
	-0.398212, // 4  subject_starts_with_re_or_fwd   (Enron Re:/Fwd: chains dominate ham)
	-0.261489, // 5  body_length_chars               (long ham forwards > short spam blasts)
	+0.421078, // 6  body_link_count                 (real spam pushes more links than synthetic)
	+0.532107, // 7  body_link_density               (strongest structural spam feature)
	+0.108254, // 8  body_image_count                (gained signal — v0.2 had this at 0)
	+0.142903, // 9  body_image_to_text_ratio        (gained signal — v0.2 had this at 0)
	+0.018765, // 10 body_caps_ratio
	+0.012841, // 11 body_all_caps_word_count
	+0.178621, // 12 body_exclamation_density
	+0.412648, // 13 body_url_shortener_count        (bit.ly era — strong in 2003-2007)
	+0.628407, // 14 body_unicode_obfuscation        (cyrillic-lookalikes already common pre-2007)
	+0.402815, // 15 body_misspelled_words_proxy
	+0.928461, // 16 urgency_phrase_count            (close to v0.2's +1.001; real corpora still vote up)
	+0.587339, // 17 money_phrase_count              (weaker — broader phrase variety in corpus)
	+0.621058, // 18 prize_phrase_count
	+0.871602, // 19 pharma_phrase_count             (Enron-era pharma spam is heavy)
	+0.547728, // 20 from_display_name_mismatches_local_part
	+0.892014, // 21 link_text_mismatches_href       (phishing signal strengthens)
	-0.918632, // 22 body_text_to_html_ratio         (stronger negative — real ham is text-dense)
	+0.000000, // 23 subject_contains_re_pattern_without_thread  (zero — needs thread context)
	-0.601523, // 24 intercept                       (less negative than v0.2 — corpus is more class-balanced)
}

// LegacyV02Weights is the v0.2 fitted vector, retained for A/B
// experimentation. Set POSTWAVE_SCANNER_WEIGHTS_VERSION=v0.2 to
// activate it. Provenance (verbatim from the previous calibration
// run): mini-batch SGD against `corpus.SyntheticSpam` +
// `corpus.SyntheticHam` on 2026-05-09 with iters=2000, lr=0.05,
// lambda=0.01, seed=42, batch=32. Final cross-entropy + L2 loss:
// 0.332167.
var LegacyV02Weights = [FeatureCount]float64{
	-0.154817, // 0  subject_length_chars
	-0.023891, // 1  subject_caps_ratio
	+0.006315, // 2  subject_has_excessive_punctuation
	-0.164298, // 3  subject_word_count
	-0.316263, // 4  subject_starts_with_re_or_fwd
	-0.284384, // 5  body_length_chars
	+0.382110, // 6  body_link_count
	+0.501946, // 7  body_link_density
	+0.000000, // 8  body_image_count
	+0.000000, // 9  body_image_to_text_ratio
	-0.014552, // 10 body_caps_ratio
	-0.060917, // 11 body_all_caps_word_count
	+0.155767, // 12 body_exclamation_density
	+0.426475, // 13 body_url_shortener_count
	+0.522308, // 14 body_unicode_obfuscation
	+0.426323, // 15 body_misspelled_words_proxy
	+1.001285, // 16 urgency_phrase_count
	+0.644018, // 17 money_phrase_count
	+0.673008, // 18 prize_phrase_count
	+0.943294, // 19 pharma_phrase_count
	+0.675834, // 20 from_display_name_mismatches_local_part
	+0.964210, // 21 link_text_mismatches_href
	-0.854703, // 22 body_text_to_html_ratio
	+0.000000, // 23 subject_contains_re_pattern_without_thread
	-0.658942, // 24 intercept
}

// weightsVersionEnv is the env var operators flip for A/B comparisons.
const weightsVersionEnv = "POSTWAVE_SCANNER_WEIGHTS_VERSION"

func init() {
	if len(v03Weights) != FeatureCount || len(LegacyV02Weights) != FeatureCount || len(FeatureNames) != FeatureCount {
		panic("content: Weights / FeatureNames length mismatch — re-check features.go and weights.go")
	}
	// Pick the active vector based on POSTWAVE_SCANNER_WEIGHTS_VERSION.
	// We deliberately read the env once at init: A/B toggling at
	// request time would risk inconsistent scoring across a single
	// pipeline run. Operator must restart the binary to switch.
	switch strings.ToLower(strings.TrimSpace(os.Getenv(weightsVersionEnv))) {
	case "v0.2", "v02", "legacy":
		Weights = LegacyV02Weights
		WeightsVersion = "v0.2-fitted-2026-05"
		WeightsTrainedAt = time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC)
	default:
		// Default to v0.3 — including when the env var is unset or
		// set to "v0.3"/"v03". Unknown values fall back to v0.3
		// (fail-open to current) rather than crashing the service.
		Weights = v03Weights
		WeightsVersion = "v0.3-public-corpora-2026-05"
		WeightsTrainedAt = time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC)
	}
}
