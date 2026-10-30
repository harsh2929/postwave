package public

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Sentiment140 is 1.6M Twitter messages auto-labeled as positive (4)
// or negative (0) by distant supervision over emoticons. We use it as
// the bulk source for the optimism axis (humor signal from tweets is
// too noisy without manual review).
//
// File layout (after fetch + extract):
//
//	cache/sentiment140/trainingandtestdata.zip
//	    -> training.1600000.processed.noemoticon.csv  (the bulk file)
//	    -> testdata.manual.2009.06.14.csv             (smaller, more carefully labeled)
//
// Each CSV row is comma-separated with NO header:
//
//	polarity (0|2|4), id, date, query, user, text
//
// We unzip lazily on first call (the zip is in cache; no point
// extracting eagerly into a second on-disk copy).

// Sentiment140Record is one parsed row with polarity normalized to a
// 0..1 optimism score:
//
//	4 (positive)  -> 0.85
//	2 (neutral)   -> 0.5 (uncommon; only present in testdata.manual)
//	0 (negative)  -> 0.15
type Sentiment140Record struct {
	Text     string
	Optimism float64
}

// LoadSentiment140 returns parsed records from the bulk training set
// AND the smaller hand-labeled test set (so neutral examples make it
// in). Returns (nil, nil) when cache directory is missing.
func LoadSentiment140(cacheRoot string) ([]Sentiment140Record, error) {
	dir := DatasetCacheDir(cacheRoot, DatasetSentiment140)
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("sentiment140: stat %s: %w", dir, err)
	}
	// Look for either an extracted CSV (operator may have unzipped it
	// themselves) or the zip archive.
	zipPath := filepath.Join(dir, "trainingandtestdata.zip")
	candidates := []string{
		filepath.Join(dir, "training.1600000.processed.noemoticon.csv"),
		filepath.Join(dir, "testdata.manual.2009.06.14.csv"),
	}
	out := make([]Sentiment140Record, 0, 1600000)
	for _, path := range candidates {
		if _, err := os.Stat(path); err == nil {
			recs, err := readSentiment140CSV(path)
			if err != nil {
				return nil, fmt.Errorf("sentiment140 %s: %w", filepath.Base(path), err)
			}
			out = append(out, recs...)
		}
	}
	if len(out) > 0 {
		return out, nil
	}
	// Fall back to reading directly from the zip — keeps the cache
	// directory single-file when the operator hasn't extracted.
	if _, err := os.Stat(zipPath); err == nil {
		recs, err := readSentiment140Zip(zipPath)
		if err != nil {
			return nil, fmt.Errorf("sentiment140 zip: %w", err)
		}
		return recs, nil
	}
	return nil, nil
}

func readSentiment140CSV(path string) ([]Sentiment140Record, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parseSentiment140CSV(f)
}

func readSentiment140Zip(zipPath string) ([]Sentiment140Record, error) {
	out := make([]Sentiment140Record, 0, 1600000)
	for _, name := range []string{
		"training.1600000.processed.noemoticon.csv",
		"testdata.manual.2009.06.14.csv",
	} {
		needle := name // capture for predicate
		rc, err := OpenZipMember(zipPath, func(n string) bool { return strings.HasSuffix(n, needle) })
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		recs, err := parseSentiment140CSV(rc)
		_ = rc.Close()
		if err != nil {
			return nil, err
		}
		out = append(out, recs...)
	}
	return out, nil
}

// parseSentiment140CSV reads the headerless 6-column CSV. Latin-1
// encoded — but we treat bytes as UTF-8 since the encoding errors
// (mostly smart quotes) won't change the bag-of-words features the
// trainer extracts.
func parseSentiment140CSV(r io.Reader) ([]Sentiment140Record, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	out := make([]Sentiment140Record, 0, 1024)
	for {
		row, err := cr.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// Skip malformed rows.
			continue
		}
		if len(row) < 6 {
			continue
		}
		polarity := row[0]
		text := strings.TrimSpace(row[5])
		if text == "" {
			continue
		}
		var opt float64
		switch polarity {
		case "4":
			opt = 0.85
		case "0":
			opt = 0.15
		case "2":
			opt = 0.5
		default:
			continue
		}
		out = append(out, Sentiment140Record{Text: text, Optimism: opt})
	}
	return out, nil
}
