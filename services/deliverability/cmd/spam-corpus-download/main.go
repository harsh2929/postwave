// Command spam-corpus-download fetches the public spam/ham corpora
// used by the v0.3 spam scorer calibration into a local cache
// directory. It is an OPERATOR tool — run once per fresh machine,
// then point the calibrate trainer at the same cache directory:
//
//	spam-corpus-download --all \
//	  --cache-dir=/var/cache/postwave/corpus
//
//	go run -tags=calibrate \
//	  ./services/deliverability/internal/content/calibrate \
//	  -corpus=public \
//	  -cache-dir=/var/cache/postwave/corpus \
//	  -max-samples=20000 -test-split=0.20 \
//	  -iters=5000 -lr=0.03 -lambda=0.01 -batch=64
//
// Datasets:
//
//   - spamassassin  (~50 MB compressed, ~80 MB uncompressed,  ~6,000 messages)
//   - enron         (~50 MB compressed, ~190 MB uncompressed, ~36,000 messages)
//   - trec07        (~4.5 GB compressed, ~25 GB uncompressed, ~75,000 messages)
//
// Flags:
//
//	--all          fetch every dataset
//	--dataset=X    fetch only X (one of spamassassin|enron|trec07)
//	--cache-dir=P  cache directory (default: ./services/deliverability/internal/content/corpus/public/cache)
//	--skip-trec    when --all is set, skip the large TREC archive
//
// The cache directory is gitignored. Re-running this command is
// idempotent: archives whose sha256 matches the cached copy are not
// re-downloaded.
//
// Operator caveats — see internal/content/corpus/public/{trec,enron,spamassassin}.go
// for license + per-corpus operational notes (TREC requires accepting
// a usage agreement; Enron mirror is volunteer-maintained; etc.).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/content/corpus/public"
)

func main() {
	os.Exit(run())
}

func run() int {
	var (
		all       = flag.Bool("all", false, "fetch every dataset (SpamAssassin + Enron + TREC unless --skip-trec)")
		dataset   = flag.String("dataset", "", "fetch a single dataset (spamassassin|enron|trec07)")
		cacheDir  = flag.String("cache-dir", defaultCacheDir(), "cache directory for archives")
		skipTREC  = flag.Bool("skip-trec", false, "when --all is set, skip the large TREC archive")
		timeout   = flag.Duration("timeout", 30*time.Minute, "overall timeout for the download run")
		printOnly = flag.Bool("print", false, "print the planned download set and exit without fetching")
	)
	flag.Parse()

	if !*all && *dataset == "" {
		fmt.Fprintln(os.Stderr, "spam-corpus-download: --all or --dataset=X is required")
		flag.Usage()
		return 2
	}

	plan := buildPlan(*all, *dataset, *skipTREC)
	if len(plan) == 0 {
		log.Printf("spam-corpus-download: unknown --dataset=%q (one of spamassassin|enron|trec07)", *dataset)
		return 1
	}

	if *printOnly {
		printPlan(plan)
		return 0
	}

	if err := os.MkdirAll(*cacheDir, 0o755); err != nil {
		log.Printf("spam-corpus-download: mkdir cache: %v", err)
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	// Honour Ctrl-C cleanly so partial downloads don't poison the
	// cache (the downloader writes via temp+rename, so a SIGINT
	// leaves only a .partial-* file we can safely ignore on the
	// next run).
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		fmt.Fprintln(os.Stderr, "spam-corpus-download: received interrupt, cancelling")
		cancel()
	}()

	d := public.NewDownloader(*cacheDir)
	d.Logf = func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "  "+format+"\n", args...)
	}

	fmt.Fprintf(os.Stderr, "spam-corpus-download: %d assets to fetch (cache=%s)\n", len(plan), *cacheDir)
	start := time.Now()
	if err := d.FetchAll(ctx, plan); err != nil {
		log.Printf("spam-corpus-download: %v", err)
		return 1
	}
	elapsed := time.Since(start).Round(time.Second)
	printSummary(*cacheDir, plan, elapsed)
	return 0
}

// buildPlan resolves --all / --dataset flags into the asset list.
// Returns nil for an unrecognised dataset name.
func buildPlan(all bool, dataset string, skipTREC bool) []public.Asset {
	if all {
		out := append([]public.Asset{}, public.SpamAssassinAssets()...)
		out = append(out, public.EnronAssets()...)
		if !skipTREC {
			out = append(out, public.TRECAssets()...)
		}
		return out
	}
	switch strings.ToLower(dataset) {
	case "spamassassin", "sa":
		return public.SpamAssassinAssets()
	case "enron":
		return public.EnronAssets()
	case "trec07", "trec", "trec2007":
		return public.TRECAssets()
	}
	return nil
}

func printPlan(plan []public.Asset) {
	fmt.Printf("planned %d downloads:\n", len(plan))
	for _, a := range plan {
		sum := a.SHA256
		if sum == "" {
			sum = "(unpinned)"
		}
		fmt.Printf("  %-12s %-30s sha256=%s url=%s\n", a.Dataset, a.Name, sum, a.URL)
	}
}

// printSummary emits a per-dataset size + total bytes summary after a
// successful fetch. Sizes are pulled from the on-disk file rather
// than the Asset.Bytes field so the operator gets ground truth.
func printSummary(cacheDir string, plan []public.Asset, elapsed time.Duration) {
	var total int64
	perDataset := map[string]int64{}
	perDatasetN := map[string]int{}
	for _, a := range plan {
		path := filepath.Join(cacheDir, a.Dataset, a.Name)
		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		total += fi.Size()
		perDataset[a.Dataset] += fi.Size()
		perDatasetN[a.Dataset]++
	}
	fmt.Fprintf(os.Stderr, "spam-corpus-download: complete in %s, %s total\n", elapsed, humanBytes(total))
	for ds, sz := range perDataset {
		fmt.Fprintf(os.Stderr, "  %-12s %s across %d archive(s)\n", ds, humanBytes(sz), perDatasetN[ds])
	}
	fmt.Fprintln(os.Stderr, "spam-corpus-download: next step:")
	fmt.Fprintln(os.Stderr, "  go run -tags=calibrate \\")
	fmt.Fprintln(os.Stderr, "    ./services/deliverability/internal/content/calibrate \\")
	fmt.Fprintln(os.Stderr, "    -corpus=public \\")
	fmt.Fprintf(os.Stderr, "    -cache-dir=%s \\\n", cacheDir)
	fmt.Fprintln(os.Stderr, "    -max-samples=20000 -test-split=0.20 -iters=5000 -lr=0.03 -lambda=0.01 -batch=64 -seed=42")
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// defaultCacheDir returns the cache path used when --cache-dir is
// not set. We prefer a path inside the repo so casual operators
// don't have to think about ~/.cache vs /var/cache; the
// `.gitignore` excludes the directory itself.
func defaultCacheDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return "corpus-cache"
	}
	return filepath.Join(wd, "services", "deliverability", "internal", "content", "corpus", "public", "cache")
}
