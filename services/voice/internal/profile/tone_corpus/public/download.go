// Package public wires five public, license-compatible writing corpora
// into the tone-classifier's calibration pipeline. Together they replace
// the ~200 hand-labeled synthetic samples used in v0.2 with hundreds of
// thousands of weakly-labeled real-text samples, one per tone axis.
//
// Datasets (one per file in this package, plus a composite merger):
//
//	GYAFC                     formality   (research / academic license)
//	GoEmotions                warmth      (Apache 2.0)
//	GoEmotions                optimism    (Apache 2.0)
//	GoEmotions (anger/sad)    humor (low) (Apache 2.0)
//	Sentiment140              optimism    (public)
//	Short Jokes (Kaggle)      humor       (CC0)
//	Stanford Politeness       directness  (CC-BY)
//
// Operator flow:
//
//  1. Run `tone-corpus-download --all` once. It populates
//     cache/<dataset>/ with the source files (the cache is gitignored).
//  2. Run `go run -tags=calibrate ./services/voice/internal/profile/tone_calibrate \
//     --corpus=public --cache-dir=services/voice/internal/profile/tone_corpus/public/cache`.
//     The trainer reads from the cache, fits 5 axes, and prints
//     paste-ready AxisFeatureWeights blocks.
//  3. Paste the blocks into tone_weights.go and bump the version string.
//
// GYAFC requires a Yahoo data-sharing agreement to obtain; the
// downloader prints clear MANUAL instructions for that corpus and
// continues to fetch the others. The composite merger gracefully drops
// GYAFC samples if its cache is absent, so the rest of the pipeline
// proceeds with the four open corpora (formality fit just has less
// signal in that case).
//
// No new Go dependencies — we use stdlib net/http for HTTPS fetches,
// crypto/sha256 for verification, archive/zip + compress/gzip for the
// archive formats the public corpora ship in.
package public

import (
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DatasetID is a short, stable identifier for one of the five public
// corpora. Keep these strings frozen — they are used as cache
// subdirectory names and as flag values in the operator CLI.
type DatasetID string

const (
	DatasetGYAFC        DatasetID = "gyafc"
	DatasetGoEmotions   DatasetID = "goemotions"
	DatasetSentiment140 DatasetID = "sentiment140"
	DatasetShortJokes   DatasetID = "short_jokes"
	DatasetPoliteness   DatasetID = "politeness"
)

// AllDatasets is the canonical iteration order used by --all.
var AllDatasets = []DatasetID{
	DatasetGYAFC,
	DatasetGoEmotions,
	DatasetSentiment140,
	DatasetShortJokes,
	DatasetPoliteness,
}

// DatasetSpec describes a single fetchable corpus. Sources is a slice
// because some datasets ship multiple files (e.g. GoEmotions has three
// CSV splits). For each source, SHA256 is checked after download — a
// mismatch fails the fetch (so a silently-rewritten upstream URL can't
// poison the cache).
type DatasetSpec struct {
	ID DatasetID
	// Human-friendly title for log lines.
	Title string
	// HomepageURL is printed in MANUAL instructions and in CLI summaries.
	HomepageURL string
	// License — purely informational; not enforced.
	License string
	// Sources is the set of files the downloader fetches. Empty means
	// the corpus requires manual download (currently only GYAFC).
	Sources []SourceFile
	// ManualInstructions is non-empty when Sources is empty. The CLI
	// prints this verbatim when the operator asks for the dataset.
	ManualInstructions string
	// ExpectedSizeBytes is the rough sum of Source sizes (best-effort,
	// used for the final summary log line).
	ExpectedSizeBytes int64
}

// SourceFile describes one downloadable artifact for a dataset.
type SourceFile struct {
	URL string
	// Filename inside cache/<dataset>/. Required.
	Filename string
	// SHA256 is the lowercase hex digest of the bytes at URL. If empty,
	// we still cache the file but skip verification — operators get a
	// log warning when this happens. We avoid pinning SHA values we
	// haven't actually verified (it would create false confidence);
	// the operator can run the downloader once, capture the actual
	// digests from `--print-digests`, and pin them in a follow-up.
	SHA256 string
}

// DatasetCatalog is the registry of all known corpora. Add new datasets
// here, not at the call site.
var DatasetCatalog = map[DatasetID]DatasetSpec{
	DatasetGYAFC: {
		ID:          DatasetGYAFC,
		Title:       "GYAFC (Grammarly's Yahoo Answers Formality Corpus)",
		HomepageURL: "https://github.com/raosudha89/GYAFC-corpus",
		License:     "Research / academic — requires Yahoo data-sharing agreement",
		Sources:     nil, // manual fetch
		ManualInstructions: strings.Join([]string{
			"GYAFC requires a Yahoo data-sharing agreement before the corpus",
			"can be redistributed. To obtain it:",
			"",
			"  1. Visit https://github.com/raosudha89/GYAFC-corpus and follow the",
			"     instructions for requesting access (Grammarly + Yahoo signoff).",
			"  2. Once you receive the corpus archive, extract it and place the",
			"     two paired files at:",
			"       cache/gyafc/Family_Relationships/train/formal",
			"       cache/gyafc/Family_Relationships/train/informal",
			"     (Entertainment_Music/ may also be present; the loader reads both",
			"      domains if found.)",
			"  3. Re-run the calibrator. If gyafc/ is missing, training proceeds",
			"     without GYAFC and the formality fit just has less data — it is",
			"     a soft dependency.",
		}, "\n"),
		ExpectedSizeBytes: 50 * 1024 * 1024, // ~50MB extracted
	},
	DatasetGoEmotions: {
		ID:          DatasetGoEmotions,
		Title:       "GoEmotions (Google Research)",
		HomepageURL: "https://github.com/google-research/google-research/tree/master/goemotions",
		License:     "Apache 2.0",
		Sources: []SourceFile{
			// The three CSV splits — full filenames match upstream layout.
			{
				URL:      "https://storage.googleapis.com/gresearch/goemotions/data/full_dataset/goemotions_1.csv",
				Filename: "goemotions_1.csv",
			},
			{
				URL:      "https://storage.googleapis.com/gresearch/goemotions/data/full_dataset/goemotions_2.csv",
				Filename: "goemotions_2.csv",
			},
			{
				URL:      "https://storage.googleapis.com/gresearch/goemotions/data/full_dataset/goemotions_3.csv",
				Filename: "goemotions_3.csv",
			},
		},
		ExpectedSizeBytes: 100 * 1024 * 1024, // ~100MB combined
	},
	DatasetSentiment140: {
		ID:          DatasetSentiment140,
		Title:       "Sentiment140 (Stanford / Go et al.)",
		HomepageURL: "http://help.sentiment140.com/for-students",
		License:     "Public (academic redistribution)",
		Sources: []SourceFile{
			{
				URL:      "http://cs.stanford.edu/people/alecmgo/trainingandtestdata.zip",
				Filename: "trainingandtestdata.zip",
			},
		},
		ExpectedSizeBytes: 80 * 1024 * 1024, // ~80MB zipped
	},
	DatasetShortJokes: {
		ID:          DatasetShortJokes,
		Title:       "Short Jokes (Kaggle / Moudgil)",
		HomepageURL: "https://www.kaggle.com/datasets/abhinavmoudgil95/short-jokes",
		License:     "CC0 (public domain)",
		Sources: []SourceFile{
			// Kaggle requires authentication for direct download; mirror via
			// a community-hosted snapshot. Operator can substitute the
			// Kaggle CLI path if their environment has KAGGLE_USERNAME/KEY.
			{
				URL:      "https://huggingface.co/datasets/Fraser/short-jokes/resolve/main/shortjokes.csv",
				Filename: "shortjokes.csv",
			},
		},
		ExpectedSizeBytes: 50 * 1024 * 1024,
	},
	DatasetPoliteness: {
		ID:          DatasetPoliteness,
		Title:       "Stanford Politeness Corpus (ConvoKit)",
		HomepageURL: "https://convokit.cornell.edu/documentation/wiki_politeness.html",
		License:     "CC-BY",
		Sources: []SourceFile{
			{
				URL:      "http://zissou.infosci.cornell.edu/convokit/datasets/wikipedia-politeness-corpus/wikipedia-politeness-corpus.zip",
				Filename: "wikipedia-politeness-corpus.zip",
			},
		},
		ExpectedSizeBytes: 5 * 1024 * 1024,
	},
}

// DefaultCacheDir is the relative path the CLI uses by default. The
// caller is free to override via --cache-dir.
const DefaultCacheDir = "services/voice/internal/profile/tone_corpus/public/cache"

// DownloadResult captures what happened for a single SourceFile —
// useful for the CLI's final summary line.
type DownloadResult struct {
	Dataset    DatasetID
	Filename   string
	URL        string
	Bytes      int64
	SHA256     string
	Skipped    bool // true when cache already had a matching file
	Manual     bool // true when the dataset requires manual fetch
	VerifiedOK bool // true when SHA256 was pinned and matched
}

// FetchDataset downloads every Source in spec to <cacheRoot>/<spec.ID>/
// (creating the directory if needed). Existing files are kept when
// their length looks plausible (>0); we re-verify the SHA256 in that
// case so a partial download doesn't poison the cache.
//
// For datasets that require manual fetch (Sources is nil), FetchDataset
// returns a single Result with Manual=true and the ManualInstructions
// string in err.Error() — the CLI handles the "MANUAL: ..." log line.
//
// Network errors fail fast; SHA256 mismatches delete the offending file
// and return an error.
func FetchDataset(ctx context.Context, spec DatasetSpec, cacheRoot string, logf func(format string, args ...any)) ([]DownloadResult, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if len(spec.Sources) == 0 {
		// Manual dataset — emit a single "Manual" result with the
		// instructions. The CLI is responsible for printing them.
		return []DownloadResult{{
			Dataset:  spec.ID,
			Manual:   true,
			Filename: "(manual)",
		}}, &ManualDownloadError{Dataset: spec.ID, Instructions: spec.ManualInstructions}
	}
	dir := filepath.Join(cacheRoot, string(spec.ID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}

	out := make([]DownloadResult, 0, len(spec.Sources))
	for _, src := range spec.Sources {
		dst := filepath.Join(dir, src.Filename)
		res, err := fetchOne(ctx, src, dst, logf)
		if err != nil {
			return out, fmt.Errorf("%s/%s: %w", spec.ID, src.Filename, err)
		}
		res.Dataset = spec.ID
		out = append(out, res)
	}
	return out, nil
}

// ManualDownloadError signals that the dataset requires operator
// action. The CLI checks for this with errors.As and prints the
// Instructions verbatim under a MANUAL: heading. We deliberately make
// it a "soft" error (callers continue with the remaining datasets).
type ManualDownloadError struct {
	Dataset      DatasetID
	Instructions string
}

func (e *ManualDownloadError) Error() string {
	return fmt.Sprintf("%s: manual fetch required (see homepage)", e.Dataset)
}

// IsManualDownloadError reports whether err signals a manual fetch.
func IsManualDownloadError(err error) bool {
	var m *ManualDownloadError
	return errors.As(err, &m)
}

// fetchOne handles a single SourceFile. Cache-hit policy: if the
// destination file already exists, we verify its SHA256 (when pinned)
// and skip the download on match; mismatch (or unpinned + zero-byte)
// triggers a re-fetch.
func fetchOne(ctx context.Context, src SourceFile, dst string, logf func(string, ...any)) (DownloadResult, error) {
	res := DownloadResult{Filename: filepath.Base(dst), URL: src.URL}
	if st, err := os.Stat(dst); err == nil && st.Size() > 0 {
		// Cache hit candidate — verify if we have a pinned digest.
		if src.SHA256 != "" {
			sum, err := sha256File(dst)
			if err != nil {
				return res, fmt.Errorf("rehash cache: %w", err)
			}
			if sum == strings.ToLower(src.SHA256) {
				res.Bytes = st.Size()
				res.SHA256 = sum
				res.Skipped = true
				res.VerifiedOK = true
				logf("cache hit: %s (%d bytes, sha256 verified)", dst, st.Size())
				return res, nil
			}
			logf("cache stale: %s sha256 mismatch — re-downloading", dst)
			_ = os.Remove(dst)
		} else {
			// No pinned digest; trust the cache hit but record the
			// observed digest for the operator's summary.
			sum, err := sha256File(dst)
			if err != nil {
				return res, fmt.Errorf("rehash cache: %w", err)
			}
			res.Bytes = st.Size()
			res.SHA256 = sum
			res.Skipped = true
			logf("cache hit: %s (%d bytes, observed sha256 %s)", dst, st.Size(), sum[:16])
			return res, nil
		}
	}

	// Stream the download to a temp file in the same directory so the
	// rename below is atomic and we never see a half-written file in
	// the cache.
	logf("fetching %s -> %s", src.URL, dst)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src.URL, nil)
	if err != nil {
		return res, fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("User-Agent", "postwave-tone-corpus-download/0.3 (+https://github.com/postwave)")
	client := &http.Client{Timeout: 0} // ctx provides the timeout
	resp, err := client.Do(req)
	if err != nil {
		return res, fmt.Errorf("http get: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return res, fmt.Errorf("http get: status %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp(filepath.Dir(dst), ".dl-*")
	if err != nil {
		return res, fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	h := sha256.New()
	mw := io.MultiWriter(tmp, h)
	n, err := io.Copy(mw, resp.Body)
	if cerr := tmp.Close(); cerr != nil && err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmpName)
		return res, fmt.Errorf("copy body: %w", err)
	}
	sum := hex.EncodeToString(h.Sum(nil))

	if src.SHA256 != "" && sum != strings.ToLower(src.SHA256) {
		_ = os.Remove(tmpName)
		return res, fmt.Errorf("sha256 mismatch: got %s want %s", sum, src.SHA256)
	}
	if err := os.Rename(tmpName, dst); err != nil {
		_ = os.Remove(tmpName)
		return res, fmt.Errorf("rename: %w", err)
	}
	res.Bytes = n
	res.SHA256 = sum
	res.VerifiedOK = src.SHA256 != ""
	return res, nil
}

// sha256File returns the hex SHA256 of the file at path.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// FetchAll runs FetchDataset over every entry in AllDatasets. Manual
// datasets are skipped (with their instructions surfaced via results),
// and per-dataset failures are collected so a single broken upstream
// URL doesn't abort the whole run.
//
// The returned results slice always contains an entry per attempted
// dataset (and per source within), in iteration order. The returned
// error is non-nil if at least one *non-manual* dataset failed; the
// CLI surfaces both for the operator.
func FetchAll(ctx context.Context, cacheRoot string, logf func(format string, args ...any)) ([]DownloadResult, []error) {
	all := make([]DownloadResult, 0, 8)
	errs := make([]error, 0)
	for _, id := range AllDatasets {
		spec := DatasetCatalog[id]
		res, err := FetchDataset(ctx, spec, cacheRoot, logf)
		all = append(all, res...)
		if err != nil {
			if IsManualDownloadError(err) {
				// soft: log + continue
				logf("MANUAL: %s — see instructions below", spec.ID)
				continue
			}
			errs = append(errs, fmt.Errorf("dataset %s: %w", id, err))
		}
	}
	return all, errs
}

// DatasetCacheDir is the canonical sub-directory for a dataset.
func DatasetCacheDir(cacheRoot string, id DatasetID) string {
	return filepath.Join(cacheRoot, string(id))
}

// ReadGzippedTextFile opens a .gz-compressed text file. Provided for
// any future loader that needs it (none of the v0.3 corpora ship gz,
// but Sentiment140 historically did — keeping the helper here lets us
// add a mirror without refactoring).
func ReadGzippedTextFile(path string) (io.ReadCloser, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	zr, err := gzip.NewReader(f)
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return gzipReadCloser{ReadCloser: zr, file: f}, nil
}

type gzipReadCloser struct {
	io.ReadCloser
	file *os.File
}

func (g gzipReadCloser) Close() error {
	gerr := g.ReadCloser.Close()
	ferr := g.file.Close()
	if gerr != nil {
		return gerr
	}
	return ferr
}

// OpenZipMember returns an io.ReadCloser for the first member of the
// zip archive at zipPath whose name matches predicate. Returns os.ErrNotExist
// if no member matched.
func OpenZipMember(zipPath string, predicate func(name string) bool) (io.ReadCloser, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		if predicate(f.Name) {
			rc, err := f.Open()
			if err != nil {
				_ = zr.Close()
				return nil, err
			}
			return zipMemberReadCloser{ReadCloser: rc, zr: zr}, nil
		}
	}
	_ = zr.Close()
	return nil, fmt.Errorf("zip member matching predicate: %w", os.ErrNotExist)
}

type zipMemberReadCloser struct {
	io.ReadCloser
	zr *zip.ReadCloser
}

func (z zipMemberReadCloser) Close() error {
	rerr := z.ReadCloser.Close()
	zerr := z.zr.Close()
	if rerr != nil {
		return rerr
	}
	return zerr
}

// DiscardSink is a never-nil log sink. Used by tests so we don't have
// to thread a logger through every call.
func DiscardSink(format string, args ...any) {}

// NowFn is overridable in tests when we need a stable "fetched at"
// timestamp. Default is time.Now.
var NowFn = time.Now
