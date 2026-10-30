// Package public owns loaders for publicly available labeled spam/ham
// corpora used to recalibrate the spam scorer past the synthetic
// (designer-intuition) corpus shipped at corpus/synthetic_data.go.
//
// Three corpora are wired in:
//
//   - SpamAssassin Public Corpus (2002-2006)
//     https://spamassassin.apache.org/old/publiccorpus/
//     ~1,900 spam + ~4,150 ham, Apache 2.0 license.
//
//   - Enron-Spam (2001-2005)
//     http://nlp.cs.aueb.gr/software_and_datasets/Enron-Spam
//     ~17,000 spam + ~19,000 ham, public-domain.
//
//   - TREC 2007 Public Spam Corpus (2007)
//     http://plg.uwaterloo.ca/~gvcormac/treccorpus07/
//     ~50,000 spam + ~25,000 ham, public-research-use.
//
// IMPORTANT operator caveats:
//
//   - These archives ship 2001–2007 spam patterns. Modern
//     attack types — homograph attacks, AI-generated body copy,
//     brand-impersonation phishing — are under-represented. v0.3
//     weights inherit this bias. Continue to mix in real seedlist
//     outcomes (corpus.Exporter) once available to close the
//     drift.
//
//   - The downloader is intentionally network-only at operator
//     invocation time (see cmd/spam-corpus-download). It does NOT
//     run as part of `go test` or any service binary. The cache
//     directory is gitignored.
//
//   - No new Go dependencies are introduced. tar.gz is handled by
//     archive/tar + compress/gzip, .tar.bz2 by archive/tar +
//     compress/bzip2 (both stdlib). HTTP is net/http.
package public

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Asset describes one downloadable corpus archive.
type Asset struct {
	// Dataset is the high-level dataset bucket. Used to compose the
	// per-dataset cache subdirectory and to label samples.
	Dataset string
	// Name is a human-readable filename for logs ("20030228_spam.tar.bz2").
	Name string
	// URL is the canonical mirror to fetch from.
	URL string
	// SHA256 is the lowercase hex digest of the archive contents.
	// Set per-archive in the per-dataset registry. When empty (e.g.
	// for archives where the upstream changes regularly), the
	// downloader skips the digest check and emits a warning.
	SHA256 string
	// Bytes is the expected file size in bytes, when known. Purely
	// informational — used to print a download summary.
	Bytes int64
}

// Downloader fetches Asset archives into a cache directory, verifying
// their sha256 digest. It is intentionally minimal:
//
//   - No retries / backoff. The operator is expected to re-run
//     `spam-corpus-download` on transient failure.
//   - No parallelism. We download serially to be polite to the
//     upstream mirrors (especially SpamAssassin's, which is a
//     volunteer-maintained Apache mirror).
//   - No streaming-extraction at download time. We fetch the raw
//     archive bytes into cache/<dataset>/<name>; the per-dataset
//     loader extracts on its own schedule.
type Downloader struct {
	// CacheDir is the directory where archive files are persisted.
	// Per-dataset subdirectories ("spamassassin", "enron", "trec07")
	// are created under it as needed.
	CacheDir string

	// HTTPClient is the http.Client used for the GET. Tests override
	// this with a stub. Defaults to a 5 minute timeout per request.
	HTTPClient *http.Client

	// Logf is the optional warn/info sink. Defaults to log.Printf-like
	// behaviour writing to stderr.
	Logf func(format string, args ...any)
}

// NewDownloader returns a Downloader rooted at cacheDir.
func NewDownloader(cacheDir string) *Downloader {
	return &Downloader{
		CacheDir: cacheDir,
		HTTPClient: &http.Client{
			Timeout: 5 * time.Minute,
		},
	}
}

// FetchAll downloads each asset in order. Already-cached archives
// with matching sha256 are not re-fetched. Returns the first error
// encountered, or nil on success.
func (d *Downloader) FetchAll(ctx context.Context, assets []Asset) error {
	for _, a := range assets {
		if err := d.Fetch(ctx, a); err != nil {
			return fmt.Errorf("fetch %s/%s: %w", a.Dataset, a.Name, err)
		}
	}
	return nil
}

// Fetch downloads a single asset and verifies its sha256. The asset
// file is placed at <CacheDir>/<Dataset>/<Name>.
//
// Behaviour:
//
//   - If the destination already exists and (when SHA256 is set)
//     its digest matches, Fetch is a no-op.
//   - If the destination exists but the digest mismatches, the file
//     is removed and re-downloaded.
//   - On a successful download, the digest is verified before the
//     temporary file is renamed into place; an atomic-style write
//     ensures partial downloads cannot be loaded as if complete.
func (d *Downloader) Fetch(ctx context.Context, a Asset) error {
	if d.CacheDir == "" {
		return fmt.Errorf("downloader: CacheDir is empty")
	}
	if a.URL == "" {
		return fmt.Errorf("downloader: asset %s has empty URL", a.Name)
	}

	dir := filepath.Join(d.CacheDir, a.Dataset)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	dst := filepath.Join(dir, a.Name)

	// Fast-path: already cached and digest matches.
	if ok, err := d.cachedOK(dst, a.SHA256); err != nil {
		return err
	} else if ok {
		d.logf("downloader: cached %s/%s", a.Dataset, a.Name)
		return nil
	}

	d.logf("downloader: fetching %s/%s from %s", a.Dataset, a.Name, a.URL)
	client := d.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("http GET: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("http GET %s: status %d", a.URL, resp.StatusCode)
	}

	tmp, err := os.CreateTemp(dir, a.Name+".partial-*")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup of the temp file if we leave early.
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	h := sha256.New()
	mw := io.MultiWriter(tmp, h)
	n, err := io.Copy(mw, resp.Body)
	if err != nil {
		_ = tmp.Close()
		return fmt.Errorf("copy body: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}

	gotSum := hex.EncodeToString(h.Sum(nil))
	if a.SHA256 != "" && gotSum != a.SHA256 {
		return fmt.Errorf("sha256 mismatch for %s: got %s, want %s", a.Name, gotSum, a.SHA256)
	}
	if a.SHA256 == "" {
		d.logf("downloader: warn: no expected sha256 for %s/%s — got %s (%d bytes)", a.Dataset, a.Name, gotSum, n)
	}

	if err := os.Rename(tmpName, dst); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	cleanup = false
	d.logf("downloader: ok %s/%s (%d bytes, sha256=%s)", a.Dataset, a.Name, n, gotSum)
	return nil
}

// cachedOK returns (true, nil) when dst exists and, if expected is
// non-empty, the file's sha256 matches expected. If the file exists
// but the digest mismatches, it is removed and the function returns
// (false, nil) so the caller re-downloads.
func (d *Downloader) cachedOK(dst, expected string) (bool, error) {
	fi, err := os.Stat(dst)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if fi.IsDir() {
		return false, fmt.Errorf("downloader: cache path %s is a directory", dst)
	}
	if expected == "" {
		// No digest to verify against — accept the cached file as-is.
		return true, nil
	}
	f, err := os.Open(dst)
	if err != nil {
		return false, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got == expected {
		return true, nil
	}
	d.logf("downloader: cached %s digest mismatch (got %s, want %s); removing", dst, got, expected)
	if err := os.Remove(dst); err != nil {
		return false, err
	}
	return false, nil
}

func (d *Downloader) logf(format string, args ...any) {
	if d.Logf != nil {
		d.Logf(format, args...)
		return
	}
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}
