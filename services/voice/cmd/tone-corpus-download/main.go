// Command tone-corpus-download fetches the five public writing
// corpora used by the v0.3 tone-classifier trainer into a local cache
// directory. The downloaded files (~500MB combined) are gitignored
// and consumed by:
//
//	go run -tags=calibrate ./services/voice/internal/profile/tone_calibrate \
//	    --corpus=public --cache-dir=<cache-dir>
//
// Usage:
//
//	tone-corpus-download --all
//	tone-corpus-download --dataset=goemotions
//	tone-corpus-download --dataset=politeness --cache-dir=/tmp/corpora
//	tone-corpus-download --list                   # show known datasets
//
// GYAFC requires a Yahoo data-sharing agreement; for that dataset the
// CLI prints a MANUAL: instruction block and proceeds with the rest.
// All other downloads stream via stdlib net/http, verify SHA256 when
// pinned, and atomic-rename into place so partial files never poison
// the cache.
//
// Exit codes:
//
//	0   all requested datasets fetched (or skipped as manual)
//	1   one or more non-manual datasets failed
//	2   invalid flags
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	public_corpus "github.com/postwave/postwave/services/voice/internal/profile/tone_corpus/public"
)

func main() {
	os.Exit(run())
}

func run() int {
	all := flag.Bool("all", false, "fetch every known dataset")
	dataset := flag.String("dataset", "", "fetch a single dataset by ID (see --list)")
	list := flag.Bool("list", false, "print the dataset catalog and exit")
	cacheDir := flag.String("cache-dir", public_corpus.DefaultCacheDir, "cache root (subdirectories per dataset)")
	timeout := flag.Duration("timeout", 30*time.Minute, "overall fetch timeout")
	flag.Parse()

	if *list {
		printCatalog(os.Stdout)
		return 0
	}

	if !*all && *dataset == "" {
		fmt.Fprintln(os.Stderr, "tone-corpus-download: pass --all or --dataset=<id> (or --list)")
		flag.Usage()
		return 2
	}
	if *all && *dataset != "" {
		fmt.Fprintln(os.Stderr, "tone-corpus-download: --all and --dataset are mutually exclusive")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	logf := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "tone-corpus-download: "+format+"\n", args...)
	}

	logf("cache dir: %s", *cacheDir)
	if err := os.MkdirAll(*cacheDir, 0o755); err != nil {
		logf("mkdir %s: %v", *cacheDir, err)
		return 1
	}

	var results []public_corpus.DownloadResult
	var failures []error

	if *all {
		results, failures = public_corpus.FetchAll(ctx, *cacheDir, logf)
		// FetchAll already logs MANUAL: per dataset; print the
		// instruction blocks below so the operator has something to
		// copy from.
		for _, id := range public_corpus.AllDatasets {
			spec := public_corpus.DatasetCatalog[id]
			if len(spec.Sources) == 0 {
				printManual(os.Stdout, spec)
			}
		}
	} else {
		id := public_corpus.DatasetID(*dataset)
		spec, ok := public_corpus.DatasetCatalog[id]
		if !ok {
			logf("unknown dataset %q — see --list", *dataset)
			return 2
		}
		res, err := public_corpus.FetchDataset(ctx, spec, *cacheDir, logf)
		results = append(results, res...)
		if err != nil {
			if public_corpus.IsManualDownloadError(err) {
				printManual(os.Stdout, spec)
			} else {
				failures = append(failures, fmt.Errorf("dataset %s: %w", id, err))
			}
		}
	}

	printSummary(os.Stdout, results)

	if len(failures) > 0 {
		fmt.Fprintln(os.Stderr, "tone-corpus-download: errors:")
		for _, e := range failures {
			fmt.Fprintf(os.Stderr, "  %v\n", e)
		}
		return 1
	}
	return 0
}

func printCatalog(w *os.File) {
	ids := make([]string, 0, len(public_corpus.AllDatasets))
	for _, id := range public_corpus.AllDatasets {
		ids = append(ids, string(id))
	}
	sort.Strings(ids)
	_, _ = fmt.Fprintln(w, "Known datasets:")
	for _, id := range ids {
		spec := public_corpus.DatasetCatalog[public_corpus.DatasetID(id)]
		manualNote := ""
		if len(spec.Sources) == 0 {
			manualNote = " [MANUAL]"
		}
		_, _ = fmt.Fprintf(w, "  %-14s %s%s\n      license: %s\n      home:    %s\n",
			id, spec.Title, manualNote, spec.License, spec.HomepageURL)
	}
}

// printManual emits the per-dataset manual-fetch instructions block
// under a clear MANUAL: heading so it's easy to grep in operator logs.
func printManual(w *os.File, spec public_corpus.DatasetSpec) {
	_, _ = fmt.Fprintln(w, "")
	_, _ = fmt.Fprintf(w, "MANUAL: %s (%s)\n", spec.ID, spec.Title)
	_, _ = fmt.Fprintf(w, "  homepage: %s\n", spec.HomepageURL)
	_, _ = fmt.Fprintf(w, "  license:  %s\n", spec.License)
	_, _ = fmt.Fprintln(w, "")
	for _, line := range strings.Split(spec.ManualInstructions, "\n") {
		_, _ = fmt.Fprintf(w, "  %s\n", line)
	}
	_, _ = fmt.Fprintln(w, "")
}

// printSummary prints the post-fetch size summary the operator uses
// to sanity-check the cache state.
func printSummary(w *os.File, results []public_corpus.DownloadResult) {
	_, _ = fmt.Fprintln(w, "")
	_, _ = fmt.Fprintln(w, "tone-corpus-download summary:")
	var total int64
	for _, r := range results {
		if r.Manual {
			_, _ = fmt.Fprintf(w, "  %-14s %s (manual — see MANUAL block above)\n", r.Dataset, "—")
			continue
		}
		verif := "(unpinned)"
		if r.VerifiedOK {
			verif = "verified"
		}
		state := "fetched"
		if r.Skipped {
			state = "cached"
		}
		_, _ = fmt.Fprintf(w, "  %-14s %-30s %12s  %10d bytes  %s  sha256:%s\n",
			r.Dataset, r.Filename, state, r.Bytes, verif, shortSHA(r.SHA256))
		total += r.Bytes
	}
	_, _ = fmt.Fprintf(w, "  TOTAL cache bytes: %s\n", humanBytes(total))
}

func humanBytes(n int64) string {
	const (
		k = 1024
		m = 1024 * k
		g = 1024 * m
	)
	switch {
	case n >= g:
		return fmt.Sprintf("%.1f GiB", float64(n)/float64(g))
	case n >= m:
		return fmt.Sprintf("%.1f MiB", float64(n)/float64(m))
	case n >= k:
		return fmt.Sprintf("%.1f KiB", float64(n)/float64(k))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

func shortSHA(s string) string {
	if len(s) < 16 {
		return s
	}
	return s[:16]
}
