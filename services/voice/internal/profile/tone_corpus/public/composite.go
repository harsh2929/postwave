package public

import (
	"context"
	"fmt"
	"math"
	"strings"

	tone_corpus "github.com/postwave/postwave/services/voice/internal/profile/tone_corpus"
)

// AxisKnown is the sentinel float we use when an axis has no signal
// for a given sample. The trainer treats samples with AxisKnown=0.5
// as "unknown for this axis" and skips them when fitting that axis.
//
// We use 0.5 (not NaN) because the existing LabeledSample shape uses
// plain float64, and 0.5 is the neutral midpoint — if a downstream
// path accidentally reads it as a label, the consequence is "weakly
// nudge toward neutral", which is benign.
const AxisKnown = 0.5

// BuildOptions controls per-axis quotas and filtering. Defaults are
// tuned to produce a balanced corpus where no single axis drowns out
// the others.
type BuildOptions struct {
	// MaxGoEmotions caps the number of GoEmotions rows used. The
	// corpus has 58k rows; we deliberately keep them all by default.
	MaxGoEmotions int
	// MaxSentiment140 caps the (very large) Sentiment140 corpus. The
	// full 1.6M rows would dominate the trainer's wall time; default
	// 100k is a 16:1 downsample that still gives the optimism axis
	// far more data than v0.2 had total.
	MaxSentiment140 int
	// MaxShortJokes caps the joke set. Default 50k of ~231k — enough
	// to give the humor axis a strong positive signal without the
	// composite leaning too humor-heavy.
	MaxShortJokes int
	// MaxGYAFCPairs caps GYAFC pair count (each pair contributes 2
	// samples). Default 30k pairs → 60k samples.
	MaxGYAFCPairs int
	// MaxPoliteness caps the politeness corpus (it's small — ~10k
	// rows — so 0 means "take everything").
	MaxPoliteness int
	// MinTextLength is the minimum tokenized-character length of a
	// kept sample. Default 8 — drops one-word tweets like "lol" that
	// give the feature extractor nothing to chew on.
	MinTextLength int
}

// DefaultBuildOptions returns the production defaults.
func DefaultBuildOptions() BuildOptions {
	return BuildOptions{
		MaxGoEmotions:   0,       // take all
		MaxSentiment140: 100_000, // 16:1 downsample
		MaxShortJokes:   50_000,
		MaxGYAFCPairs:   30_000,
		MaxPoliteness:   0,
		MinTextLength:   8,
	}
}

// BuildCompositeCorpus loads all five public datasets from cacheRoot
// and merges them into the unified LabeledSample format. Each sample
// has all five axis labels set; axes with no signal for that sample
// are set to AxisKnown (0.5) and the trainer skips them at fit time.
//
// Missing datasets are NOT fatal — see the per-source comments below
// for the soft-fail behaviour. The function returns an aggregate
// stats summary (printed by the trainer) and the merged samples.
//
// Context is honored at coarse granularity (we check it between
// per-corpus loads, not inside loops). Loading the full corpus takes
// a few seconds at most so the context is mainly a sanity guard.
func BuildCompositeCorpus(ctx context.Context, cacheRoot string) ([]tone_corpus.LabeledSample, BuildStats, error) {
	return BuildCompositeCorpusWithOptions(ctx, cacheRoot, DefaultBuildOptions())
}

// BuildCompositeCorpusWithOptions is the parameterized variant. Most
// callers can use BuildCompositeCorpus.
func BuildCompositeCorpusWithOptions(ctx context.Context, cacheRoot string, opts BuildOptions) ([]tone_corpus.LabeledSample, BuildStats, error) {
	if opts.MinTextLength == 0 {
		opts.MinTextLength = 8
	}
	stats := BuildStats{}
	out := make([]tone_corpus.LabeledSample, 0, 250_000)

	// ----- GYAFC (formality) -----
	if err := checkCtx(ctx); err != nil {
		return nil, stats, err
	}
	pairs, err := LoadGYAFC(cacheRoot)
	if err != nil {
		return nil, stats, fmt.Errorf("composite: gyafc: %w", err)
	}
	if opts.MaxGYAFCPairs > 0 && len(pairs) > opts.MaxGYAFCPairs {
		pairs = pairs[:opts.MaxGYAFCPairs]
	}
	for _, p := range pairs {
		if len(p.Formal) >= opts.MinTextLength {
			out = append(out, neutralWith(p.Formal, formality(0.9)))
			stats.GYAFCFormal++
		}
		if len(p.Informal) >= opts.MinTextLength {
			out = append(out, neutralWith(p.Informal, formality(0.1)))
			stats.GYAFCInformal++
		}
	}

	// ----- GoEmotions (warmth + optimism + anti-humor) -----
	if err := checkCtx(ctx); err != nil {
		return nil, stats, err
	}
	ge, err := LoadGoEmotions(cacheRoot)
	if err != nil {
		return nil, stats, fmt.Errorf("composite: goemotions: %w", err)
	}
	if opts.MaxGoEmotions > 0 && len(ge) > opts.MaxGoEmotions {
		ge = ge[:opts.MaxGoEmotions]
	}
	for _, rec := range ge {
		if len(rec.Text) < opts.MinTextLength {
			continue
		}
		warmth, optimism, ok := aggregateGoEmotions(rec.Emotions)
		humor, hasHumor := aggregateHumorSignal(rec.Emotions)
		if !ok && !hasHumor {
			continue
		}
		s := tone_corpus.LabeledSample{
			Text:       rec.Text,
			Humor:      AxisKnown,
			Formality:  AxisKnown,
			Optimism:   AxisKnown,
			Directness: AxisKnown,
			Warmth:     AxisKnown,
		}
		if ok {
			s.Warmth = warmth
			s.Optimism = optimism
			stats.GoEmotionsWarmth++
			stats.GoEmotionsOptimism++
		}
		if hasHumor {
			s.Humor = humor
			stats.GoEmotionsHumor++
		}
		out = append(out, s)
	}

	// ----- Sentiment140 (optimism backup) -----
	if err := checkCtx(ctx); err != nil {
		return nil, stats, err
	}
	s140, err := LoadSentiment140(cacheRoot)
	if err != nil {
		return nil, stats, fmt.Errorf("composite: sentiment140: %w", err)
	}
	if opts.MaxSentiment140 > 0 && len(s140) > opts.MaxSentiment140 {
		// Even downsample: take every Nth row so positives + negatives
		// stay roughly balanced (the upstream file is sorted by label,
		// so a head-cut would yield only negatives).
		stride := len(s140) / opts.MaxSentiment140
		if stride < 1 {
			stride = 1
		}
		downsampled := make([]Sentiment140Record, 0, opts.MaxSentiment140)
		for i := 0; i < len(s140); i += stride {
			downsampled = append(downsampled, s140[i])
			if len(downsampled) >= opts.MaxSentiment140 {
				break
			}
		}
		s140 = downsampled
	}
	for _, rec := range s140 {
		if len(rec.Text) < opts.MinTextLength {
			continue
		}
		out = append(out, neutralWith(rec.Text, optimismLabel(rec.Optimism)))
		stats.Sentiment140++
	}

	// ----- Short Jokes (humor positives) -----
	if err := checkCtx(ctx); err != nil {
		return nil, stats, err
	}
	jokes, err := LoadShortJokes(cacheRoot)
	if err != nil {
		return nil, stats, fmt.Errorf("composite: short_jokes: %w", err)
	}
	if opts.MaxShortJokes > 0 && len(jokes) > opts.MaxShortJokes {
		jokes = jokes[:opts.MaxShortJokes]
	}
	for _, j := range jokes {
		if len(j.Text) < opts.MinTextLength {
			continue
		}
		out = append(out, neutralWith(j.Text, humorLabel(0.9)))
		stats.ShortJokes++
	}

	// ----- Stanford Politeness (directness) -----
	if err := checkCtx(ctx); err != nil {
		return nil, stats, err
	}
	pol, err := LoadPoliteness(cacheRoot)
	if err != nil {
		return nil, stats, fmt.Errorf("composite: politeness: %w", err)
	}
	if opts.MaxPoliteness > 0 && len(pol) > opts.MaxPoliteness {
		pol = pol[:opts.MaxPoliteness]
	}
	for _, rec := range pol {
		if len(rec.Text) < opts.MinTextLength {
			continue
		}
		// Drop mid-band rows — see PolitenessConfidenceBand.
		if math.Abs(rec.Directness-0.5) < PolitenessConfidenceBand {
			stats.PolitenessDropped++
			continue
		}
		out = append(out, neutralWith(rec.Text, directnessLabel(rec.Directness)))
		stats.Politeness++
	}

	stats.Total = len(out)
	return out, stats, nil
}

// BuildStats is a per-source tally used by the trainer's log output
// and by composite_test.go for sanity checks.
type BuildStats struct {
	Total              int
	GYAFCFormal        int
	GYAFCInformal      int
	GoEmotionsWarmth   int
	GoEmotionsOptimism int
	GoEmotionsHumor    int
	Sentiment140       int
	ShortJokes         int
	Politeness         int
	PolitenessDropped  int
}

// String renders BuildStats as a one-line summary suitable for log
// output. Keep the field order frozen for greppability.
func (s BuildStats) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "total=%d gyafc=%d/%d goemotions=warm:%d/opt:%d/humor:%d s140=%d jokes=%d politeness=%d (dropped:%d)",
		s.Total, s.GYAFCFormal, s.GYAFCInformal,
		s.GoEmotionsWarmth, s.GoEmotionsOptimism, s.GoEmotionsHumor,
		s.Sentiment140, s.ShortJokes, s.Politeness, s.PolitenessDropped)
	return b.String()
}

// aggregateGoEmotions averages EmotionToTone over a row's labels.
// Returns ok=false when no emotion in the row has a (warmth, optimism)
// mapping (i.e. all emotions returned the -1 sentinel).
func aggregateGoEmotions(emotions []string) (warmth, optimism float64, ok bool) {
	var wSum, oSum float64
	var wN, oN int
	for _, e := range emotions {
		w, o := EmotionToTone(e)
		if w >= 0 {
			wSum += w
			wN++
		}
		if o >= 0 {
			oSum += o
			oN++
		}
	}
	if wN == 0 && oN == 0 {
		return 0, 0, false
	}
	if wN > 0 {
		warmth = wSum / float64(wN)
	} else {
		warmth = AxisKnown
	}
	if oN > 0 {
		optimism = oSum / float64(oN)
	} else {
		optimism = AxisKnown
	}
	return warmth, optimism, true
}

// aggregateHumorSignal averages EmotionHumorSignal across a row's
// labels. Returns ok=false when no emotion has a humor signal.
func aggregateHumorSignal(emotions []string) (humor float64, ok bool) {
	var sum float64
	var n int
	for _, e := range emotions {
		v := EmotionHumorSignal(e)
		if v >= 0 {
			sum += v
			n++
		}
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}

// neutralWith returns a LabeledSample with all axes set to AxisKnown
// (unknown) and then overridden by the apply function. Two-step so we
// can build sparse-axis samples in one expression at the call site.
func neutralWith(text string, apply func(*tone_corpus.LabeledSample)) tone_corpus.LabeledSample {
	s := tone_corpus.LabeledSample{
		Text:       text,
		Humor:      AxisKnown,
		Formality:  AxisKnown,
		Optimism:   AxisKnown,
		Directness: AxisKnown,
		Warmth:     AxisKnown,
	}
	apply(&s)
	return s
}

func formality(v float64) func(*tone_corpus.LabeledSample) {
	return func(s *tone_corpus.LabeledSample) { s.Formality = v }
}
func optimismLabel(v float64) func(*tone_corpus.LabeledSample) {
	return func(s *tone_corpus.LabeledSample) { s.Optimism = v }
}
func humorLabel(v float64) func(*tone_corpus.LabeledSample) {
	return func(s *tone_corpus.LabeledSample) { s.Humor = v }
}
func directnessLabel(v float64) func(*tone_corpus.LabeledSample) {
	return func(s *tone_corpus.LabeledSample) { s.Directness = v }
}

func checkCtx(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

// AxisIsKnown reports whether v is a labeled value (not the AxisKnown
// sentinel). The trainer calls this once per (sample, axis) pair so
// it only fits on samples with real signal.
//
// Note: a "real" label of 0.5 (e.g. GoEmotions neutral) collides with
// the sentinel. We accept this collision because it is genuinely
// uncommon: only GoEmotions' rare neutral-only row produces it, and
// in that case skipping it is the right move (a neutral-only row
// gives the trainer no gradient anyway).
func AxisIsKnown(v float64) bool {
	return math.Abs(v-AxisKnown) > 1e-9
}
