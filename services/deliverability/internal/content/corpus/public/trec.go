package public

// trec.go — loader for the TREC 2007 Public Spam Corpus by Cormack.
//
// Source: http://plg.uwaterloo.ca/~gvcormac/treccorpus07/
// The corpus ships as a single ~4.5 GB archive (trec07p.tgz) which
// expands to:
//
//	trec07p/
//	  full/index            -- label index: lines of "<label> ../data/<gid>"
//	  data/<gid>             -- one RFC 822 message per gid
//	  delay/index            -- a "delayed-feedback" subset (ignored here)
//	  partial/...            -- per-partition subsets (ignored here)
//
// We use only the `full/index` mapping and the `data/` files; the
// delay/partial subsets are designed for online-learning evaluations
// outside our scope.
//
// Labels in full/index are "spam" or "ham" (one per line). Example:
//
//	spam ../data/inmail.1
//	ham ../data/inmail.2
//
// Operator caveats:
//
//   - This corpus is ~4.5 GB compressed and ~25 GB uncompressed.
//     Plan disk + bandwidth accordingly. The downloader does no
//     streaming-extract optimization.
//
//   - The University of Waterloo mirror requires accepting a usage
//     agreement (no commercial use, attribution required). Operators
//     who fetch this dataset are signing that agreement on
//     Moosewave's behalf.

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/content/corpus"
)

// TRECAssets returns the single TREC 2007 archive asset.
//
// We do NOT pin a SHA256: the upstream mirror occasionally re-rolls
// the archive (the data is stable, only the tar metadata changes),
// and the digest mismatch would otherwise block legitimate fetches.
// The downloader logs a warning when SHA256 is empty.
func TRECAssets() []Asset {
	return []Asset{
		{
			Dataset: "trec07",
			Name:    "trec07p.tgz",
			URL:     "https://plg.uwaterloo.ca/~gvcormac/treccorpus07/trec07p.tgz",
			SHA256:  "",
		},
	}
}

// LoadTREC walks <cacheDir>/trec07/, extracting the archive on first
// invocation and then walking the full/index file. Returns (nil, nil)
// when the dataset directory is missing.
func LoadTREC(ctx context.Context, cacheDir string) ([]corpus.Sample, error) {
	root := filepath.Join(cacheDir, "trec07")
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("stat %s: %w", root, err)
	}

	extracted := filepath.Join(root, "extracted")
	if err := os.MkdirAll(extracted, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir extracted: %w", err)
	}

	// Lazy-extract.
	archive := filepath.Join(root, "trec07p.tgz")
	dataDir := filepath.Join(extracted, "trec07p", "data")
	indexPath := filepath.Join(extracted, "trec07p", "full", "index")
	if _, err := os.Stat(indexPath); os.IsNotExist(err) {
		if _, statErr := os.Stat(archive); os.IsNotExist(statErr) {
			// Archive not downloaded; nothing to do.
			return nil, nil
		}
		if err := extractTarGz(archive, extracted); err != nil {
			return nil, fmt.Errorf("extract trec07p.tgz: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("stat %s: %w", indexPath, err)
	}

	f, err := os.Open(indexPath)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", indexPath, err)
	}
	defer func() { _ = f.Close() }()

	var samples []corpus.Sample
	scanner := bufio.NewScanner(f)
	// TREC message paths can have very long index lines; the default
	// 64 KB buffer is fine here but we set a generous limit to be
	// resilient to malformed inputs.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for scanner.Scan() {
		if err := ctxErr(ctx); err != nil {
			return nil, err
		}
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		label := strings.ToLower(fields[0])
		var isSpam bool
		switch label {
		case "spam":
			isSpam = true
		case "ham":
			isSpam = false
		default:
			continue
		}
		// The path is relative-to-full/, e.g. "../data/inmail.1".
		msgPath := filepath.Join(dataDir, filepath.Base(fields[1]))
		raw, err := readCorpusMessageFile(msgPath)
		if err != nil {
			// Skip orphaned index entries — these can occur on
			// truncated extractions. A warning would be too noisy
			// for ~75k samples.
			continue
		}
		subj, body := parseRFC822(raw)
		if subj == "" && len(body) < 4 {
			continue
		}
		samples = append(samples, corpus.Sample{
			Subject:  subj,
			BodyHTML: body,
			Text:     subj + "\n\n" + body,
			IsSpam:   isSpam,
			Source:   "trec07/" + label,
			SampleAt: time.Date(2007, 4, 8, 0, 0, 0, 0, time.UTC),
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan index: %w", err)
	}
	return samples, nil
}
