package public

// composite.go — merges every public-corpus loader into one
// deterministic []corpus.Sample stream for the calibrate trainer.
//
// Design constraints (these are intentional, not accidental):
//
//   - "Loader missing dataset" is NOT fatal. Each per-corpus loader
//     returns (nil, nil) when its cache directory is absent, so an
//     operator who only fetched SpamAssassin still gets a usable
//     composite — they just see lower row counts. We log a warning
//     per absent corpus so the operator notices the omission.
//
//   - Downsampling is deterministic when maxSamples > 0. We use
//     math/rand with a fixed seed (the same seed the trainer uses,
//     unless overridden) so that two runs against the same cache
//     produce the same training set.
//
//   - Per-corpus contribution is reported via BuildSummary so the
//     trainer can print "loaded 1900 SpamAssassin + 17000 Enron =
//     18900 rows (downsampled to 20000)" on stderr.

import (
	"context"
	"fmt"
	"math/rand"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/content/corpus"
)

// BuildSummary describes per-corpus contributions to the final
// composite dataset. Returned alongside the merged []Sample so the
// caller can print a human-readable run header.
type BuildSummary struct {
	// Counts is dataset → row contribution AFTER any downsampling.
	// Datasets that were absent appear in Missing instead.
	Counts map[string]int
	// Missing lists dataset names whose loader returned nil because
	// the cache directory was absent. Surfaced so operators notice
	// they ran the trainer against a partial cache.
	Missing []string
	// PreDownsample is the row count before maxSamples downsampling.
	// Equals len(samples) when maxSamples == 0 or the corpus was
	// already smaller than maxSamples.
	PreDownsample int
	// Seed is the math/rand seed used for downsampling. Surfaced so
	// the operator can reproduce the same training set.
	Seed int64
}

// String renders a one-line summary suitable for log output.
func (s BuildSummary) String() string {
	if len(s.Counts) == 0 {
		return "public-corpus: empty"
	}
	parts := make([]string, 0, len(s.Counts))
	total := 0
	for name, n := range s.Counts {
		parts = append(parts, fmt.Sprintf("%s=%d", name, n))
		total += n
	}
	out := fmt.Sprintf("public-corpus: total=%d (%s) pre-downsample=%d seed=%d",
		total, strings.Join(parts, ","), s.PreDownsample, s.Seed)
	if len(s.Missing) > 0 {
		out += " missing=[" + strings.Join(s.Missing, ",") + "]"
	}
	return out
}

// CompositeOptions configures BuildCompositeCorpus.
type CompositeOptions struct {
	// CacheDir is the directory the loaders read from. The same path
	// the downloader writes to. Required.
	CacheDir string
	// MaxSamples, when > 0, caps the final composite at MaxSamples
	// rows via deterministic random sampling. 0 means "take
	// everything".
	MaxSamples int
	// Seed seeds the downsampling RNG. 0 defaults to 42 so behaviour
	// matches the calibrate trainer's default seed.
	Seed int64
	// IncludeTREC enables the TREC 2007 loader. Defaults to true; an
	// operator who fetched only SpamAssassin+Enron may want to skip
	// the TREC walk explicitly.
	IncludeTREC bool
	// Logf is the warn sink used when a corpus directory is missing.
	// Defaults to fmt.Fprintf(os.Stderr, ...).
	Logf func(format string, args ...any)
}

// BuildCompositeCorpus loads every available public corpus, merges
// them into a single []Sample slice (preserving per-loader order),
// optionally downsamples deterministically, and returns the result
// along with a BuildSummary describing the contributions.
//
// Per-loader errors are surfaced — only "directory missing" is
// soft-handled.
func BuildCompositeCorpus(ctx context.Context, opts CompositeOptions) ([]corpus.Sample, BuildSummary, error) {
	if opts.CacheDir == "" {
		return nil, BuildSummary{}, fmt.Errorf("public.BuildCompositeCorpus: CacheDir is required")
	}
	if opts.Seed == 0 {
		opts.Seed = 42
	}

	summary := BuildSummary{
		Counts: map[string]int{},
		Seed:   opts.Seed,
	}

	logf := opts.Logf
	if logf == nil {
		logf = func(format string, args ...any) {
			fmt.Printf(format+"\n", args...)
		}
	}

	loaders := []struct {
		name string
		fn   func(context.Context, string) ([]corpus.Sample, error)
	}{
		{"spamassassin", LoadSpamAssassin},
		{"enron", LoadEnron},
	}
	if opts.IncludeTREC {
		loaders = append(loaders, struct {
			name string
			fn   func(context.Context, string) ([]corpus.Sample, error)
		}{"trec07", LoadTREC})
	}

	var all []corpus.Sample
	for _, l := range loaders {
		samples, err := l.fn(ctx, opts.CacheDir)
		if err != nil {
			return nil, summary, fmt.Errorf("load %s: %w", l.name, err)
		}
		if len(samples) == 0 {
			summary.Missing = append(summary.Missing, l.name)
			logf("public-corpus: warn: %s contributed 0 rows (cache likely missing — run spam-corpus-download --dataset=%s)", l.name, l.name)
			continue
		}
		summary.Counts[l.name] = len(samples)
		all = append(all, samples...)
	}

	summary.PreDownsample = len(all)
	if opts.MaxSamples > 0 && len(all) > opts.MaxSamples {
		all = deterministicDownsample(all, opts.MaxSamples, opts.Seed)
		// Re-tally per-dataset contributions after downsampling.
		summary.Counts = map[string]int{}
		for _, s := range all {
			ds := datasetOf(s.Source)
			summary.Counts[ds]++
		}
	}

	return all, summary, nil
}

// datasetOf maps a Sample.Source string ("spamassassin/spam_2",
// "enron/enron3/ham", "trec07/spam") back to the top-level dataset
// name used in BuildSummary.Counts.
func datasetOf(source string) string {
	if i := strings.Index(source, "/"); i > 0 {
		return source[:i]
	}
	return source
}

// deterministicDownsample reservoir-samples `keep` records out of
// `in` using a math/rand source seeded with `seed`. Reservoir
// sampling is overkill for in-memory slices but keeps the function
// trivially correct and produces uniform-random output.
//
// Why not just Shuffle + truncate? It's equivalent for our case but
// reservoir sampling makes the intent explicit and stays correct if
// `in` is ever swapped for an iterator over a streaming source.
func deterministicDownsample(in []corpus.Sample, keep int, seed int64) []corpus.Sample {
	if keep >= len(in) {
		return in
	}
	rng := rand.New(rand.NewSource(seed))
	out := make([]corpus.Sample, keep)
	copy(out, in[:keep])
	for i := keep; i < len(in); i++ {
		j := rng.Intn(i + 1)
		if j < keep {
			out[j] = in[i]
		}
	}
	return out
}
