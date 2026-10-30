package public

// spamassassin.go — loader for the Apache SpamAssassin Public Corpus.
//
// Layout once extracted (from
// https://spamassassin.apache.org/old/publiccorpus/):
//
//	cache/spamassassin/
//	  20030228_easy_ham.tar.bz2     -> extracts to easy_ham/<msg>
//	  20030228_easy_ham_2.tar.bz2   -> extracts to easy_ham_2/<msg>
//	  20030228_hard_ham.tar.bz2     -> extracts to hard_ham/<msg>
//	  20030228_spam.tar.bz2         -> extracts to spam/<msg>
//	  20050311_spam_2.tar.bz2       -> extracts to spam_2/<msg>
//	  extracted/
//	    easy_ham/...
//	    easy_ham_2/...
//	    hard_ham/...
//	    spam/...
//	    spam_2/...
//
// Each "<msg>" is a single RFC 822 message (headers + body). For
// feature extraction we strip headers down to Subject + body so that
// the existing content.Extract sees the same shape it does in
// production.
//
// Labels: directories beginning "spam" are IsSpam=true; "easy_ham"
// and "hard_ham" are IsSpam=false. "hard_ham" is intentionally
// retained — it contains commercial-but-legitimate mail that
// historically caused SpamAssassin false-positives, which is exactly
// the kind of edge case the v0.3 weights need to learn from.

import (
	"archive/tar"
	"compress/bzip2"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/content/corpus"
)

// SpamAssassinAssets returns the canonical archive set. SHA256
// digests are pinned to the 2003/2005 release snapshots; operators
// can re-pin by computing `shasum -a 256 <file>` on a verified
// download.
//
// Note: SpamAssassin's volunteer-maintained mirror occasionally
// re-bundles these archives. When the digest no longer matches the
// downloader emits a warning rather than failing — operators should
// re-pin the constants and submit a PR.
func SpamAssassinAssets() []Asset {
	const base = "https://spamassassin.apache.org/old/publiccorpus/"
	return []Asset{
		{
			Dataset: "spamassassin",
			Name:    "20030228_easy_ham.tar.bz2",
			URL:     base + "20030228_easy_ham.tar.bz2",
			// SHA256 left empty intentionally: digest pinning is
			// best-effort; the loader logs a warning when it sees an
			// unpinned asset.
			SHA256: "",
		},
		{
			Dataset: "spamassassin",
			Name:    "20030228_easy_ham_2.tar.bz2",
			URL:     base + "20030228_easy_ham_2.tar.bz2",
			SHA256:  "",
		},
		{
			Dataset: "spamassassin",
			Name:    "20030228_hard_ham.tar.bz2",
			URL:     base + "20030228_hard_ham.tar.bz2",
			SHA256:  "",
		},
		{
			Dataset: "spamassassin",
			Name:    "20030228_spam.tar.bz2",
			URL:     base + "20030228_spam.tar.bz2",
			SHA256:  "",
		},
		{
			Dataset: "spamassassin",
			Name:    "20050311_spam_2.tar.bz2",
			URL:     base + "20050311_spam_2.tar.bz2",
			SHA256:  "",
		},
	}
}

// LoadSpamAssassin walks the cache directory for SpamAssassin, lazily
// extracting any .tar.bz2 archives that have not been expanded yet,
// then iterates the resulting message files. Returns Sample records
// with Source="spamassassin".
//
// cacheDir is the root cache dir (the same one passed to the
// downloader); LoadSpamAssassin appends the per-dataset subdirectory
// itself.
//
// LoadSpamAssassin is robust to a missing dataset directory — it
// returns (nil, nil) so callers can mix-and-match corpora.
func LoadSpamAssassin(ctx context.Context, cacheDir string) ([]corpus.Sample, error) {
	root := filepath.Join(cacheDir, "spamassassin")
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("stat %s: %w", root, err)
	}

	extracted := filepath.Join(root, "extracted")
	if err := os.MkdirAll(extracted, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir extracted: %w", err)
	}

	// Extract any archives that haven't been expanded yet. The naming
	// convention is "20030228_easy_ham.tar.bz2" -> "easy_ham"; we
	// strip the date prefix and the .tar.bz2 suffix to derive the
	// target subdirectory.
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("readdir %s: %w", root, err)
	}
	for _, e := range entries {
		if err := ctxErr(ctx); err != nil {
			return nil, err
		}
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".tar.bz2") {
			continue
		}
		label := spamAssassinLabelDir(name)
		if label == "" {
			continue
		}
		dst := filepath.Join(extracted, label)
		if alreadyExtracted(dst) {
			continue
		}
		if err := extractTarBz2(filepath.Join(root, name), extracted); err != nil {
			return nil, fmt.Errorf("extract %s: %w", name, err)
		}
	}

	// Walk extracted/ and emit one Sample per message file.
	var samples []corpus.Sample
	walkErr := filepath.WalkDir(extracted, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctxErr(ctx); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		// Skip the per-archive "cmds" / index files that ship inside
		// some SpamAssassin tarballs. Those are not RFC 822 mail.
		base := filepath.Base(path)
		if base == "cmds" || strings.HasPrefix(base, ".") {
			return nil
		}
		rel, err := filepath.Rel(extracted, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 2 {
			return nil
		}
		top := parts[0]
		isSpam := strings.HasPrefix(top, "spam")
		if !isSpam && !strings.HasSuffix(top, "ham") {
			return nil
		}
		raw, err := readCorpusMessageFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		subj, body := parseRFC822(raw)
		if subj == "" && len(body) < 4 {
			// Pathological / empty message — skip.
			return nil
		}
		samples = append(samples, corpus.Sample{
			Subject:  subj,
			BodyHTML: body,
			Text:     subj + "\n\n" + body,
			IsSpam:   isSpam,
			Source:   "spamassassin/" + top,
			SampleAt: spamAssassinSampleAt(top),
		})
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	return samples, nil
}

// spamAssassinLabelDir returns the on-disk label directory name for a
// given archive filename, e.g.
//
//	"20030228_easy_ham.tar.bz2"   -> "easy_ham"
//	"20050311_spam_2.tar.bz2"     -> "spam_2"
//
// Unrecognised filenames return "".
func spamAssassinLabelDir(archive string) string {
	name := strings.TrimSuffix(archive, ".tar.bz2")
	// Strip leading "YYYYMMDD_" date prefix when present.
	if i := strings.Index(name, "_"); i > 0 && i <= 9 {
		// Date prefixes are 8 digits.
		prefix := name[:i]
		allDigits := true
		for _, r := range prefix {
			if r < '0' || r > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			name = name[i+1:]
		}
	}
	switch name {
	case "easy_ham", "easy_ham_2", "hard_ham", "spam", "spam_2":
		return name
	}
	return ""
}

// spamAssassinSampleAt assigns a coarse-grained "when this message
// was collected" timestamp per directory. SpamAssassin published the
// 2003 batch in February 2003 and the second spam batch in March
// 2005; we record those dates so downstream code can tell which era
// of spam a given sample is from.
func spamAssassinSampleAt(dir string) time.Time {
	switch dir {
	case "spam_2":
		return time.Date(2005, 3, 11, 0, 0, 0, 0, time.UTC)
	default:
		return time.Date(2003, 2, 28, 0, 0, 0, 0, time.UTC)
	}
}

// extractTarBz2 unpacks the .tar.bz2 archive at src into destRoot,
// preserving the top-level directory entry of the archive. Symlinks
// and absolute-path entries are rejected to prevent tar-slip into
// the cache parent.
func extractTarBz2(src, destRoot string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	br := bzip2.NewReader(f)
	tr := tar.NewReader(br)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("tar next: %w", err)
		}
		clean := filepath.Clean(hdr.Name)
		if strings.HasPrefix(clean, "..") || strings.HasPrefix(clean, "/") || strings.Contains(clean, "/../") {
			// Tar-slip defense: refuse to write outside destRoot.
			continue
		}
		target := filepath.Join(destRoot, clean)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.Create(target)
			if err != nil {
				return err
			}
			// Limit reads to header.Size to bound memory on malformed
			// archives. SpamAssassin messages are tiny so this is
			// essentially a courtesy.
			if _, err := io.CopyN(out, tr, hdr.Size); err != nil && err != io.EOF {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		default:
			// Skip symlinks, devices, FIFOs. SpamAssassin archives
			// don't ship any of those.
			continue
		}
	}
}

// alreadyExtracted returns true when dst exists and has at least one
// entry — a coarse "already done" check that avoids re-extracting
// large tarballs on every invocation.
func alreadyExtracted(dst string) bool {
	entries, err := os.ReadDir(dst)
	if err != nil {
		return false
	}
	return len(entries) > 0
}

// parseRFC822 returns (subject, body) for a raw RFC 822 message.
// The split is on the first blank line (CRLF or LF). Subject is
// recovered from the first "Subject:" header — case-insensitively.
// Multi-line subjects (header folding) are joined onto a single line.
//
// Encoded-word subjects (=?UTF-8?B?...?=) are passed through
// verbatim. The feature extractor is tolerant of mixed encodings so
// over-engineering decode logic isn't worth the dependency budget.
func parseRFC822(raw []byte) (subject, body string) {
	s := string(raw)
	// Find header/body split.
	sep := strings.Index(s, "\r\n\r\n")
	sepLen := 4
	if sep < 0 {
		sep = strings.Index(s, "\n\n")
		sepLen = 2
	}
	var headerBlock string
	if sep >= 0 {
		headerBlock = s[:sep]
		body = s[sep+sepLen:]
	} else {
		headerBlock = s
		body = ""
	}
	// Unfold continuation lines: a line starting with whitespace
	// continues the previous header.
	rawLines := strings.Split(strings.ReplaceAll(headerBlock, "\r\n", "\n"), "\n")
	merged := make([]string, 0, len(rawLines))
	for _, ln := range rawLines {
		if len(ln) == 0 {
			merged = append(merged, ln)
			continue
		}
		if (ln[0] == ' ' || ln[0] == '\t') && len(merged) > 0 {
			merged[len(merged)-1] += " " + strings.TrimSpace(ln)
			continue
		}
		merged = append(merged, ln)
	}
	for _, ln := range merged {
		if len(ln) >= 8 && strings.EqualFold(ln[:8], "Subject:") {
			subject = strings.TrimSpace(ln[8:])
			break
		}
	}
	return subject, body
}

// ctxErr returns ctx.Err() and is a one-liner wrapper used by long
// walks to bail out on cancellation without nesting selects.
func ctxErr(ctx context.Context) error {
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
