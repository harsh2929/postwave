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

// Short Jokes (Kaggle / Moudgil, CC0) is a 231k-row CSV scraped from
// joke subreddits. Each row is a self-contained one- or two-liner
// joke; we use the entire corpus as a high-confidence humor=0.9
// signal. The composite pipeline pairs it with anti-humor samples
// pulled from GoEmotions' anger/sadness clusters to give the humor
// fit both poles.
//
// File layout:
//
//	cache/short_jokes/shortjokes.csv
//
// Header: "ID,Joke" — two columns, comma-separated. Joke text often
// contains commas, so we rely on the csv package's quoting handling
// rather than splitting manually.

// ShortJokeRecord is one parsed joke row.
type ShortJokeRecord struct {
	ID   string
	Text string
}

// LoadShortJokes reads cache/short_jokes/shortjokes.csv and returns
// the parsed records. Returns (nil, nil) when the file is missing.
func LoadShortJokes(cacheRoot string) ([]ShortJokeRecord, error) {
	path := filepath.Join(DatasetCacheDir(cacheRoot, DatasetShortJokes), "shortjokes.csv")
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("short_jokes: open: %w", err)
	}
	defer func() { _ = f.Close() }()
	return parseShortJokesCSV(f)
}

func parseShortJokesCSV(r io.Reader) ([]ShortJokeRecord, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true

	// Header row: if first row's first cell isn't a number, treat it
	// as a header and skip. Robust to both header-ful and header-less
	// mirrors.
	first, err := cr.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]ShortJokeRecord, 0, 200_000)
	if len(first) >= 2 && !looksLikeNumericID(first[0]) {
		// header — skip
	} else if len(first) >= 2 {
		out = append(out, ShortJokeRecord{ID: first[0], Text: strings.TrimSpace(first[1])})
	}
	for {
		row, err := cr.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			continue // tolerate malformed rows
		}
		if len(row) < 2 {
			continue
		}
		text := strings.TrimSpace(row[1])
		if text == "" {
			continue
		}
		out = append(out, ShortJokeRecord{ID: row[0], Text: text})
	}
	return out, nil
}

// looksLikeNumericID is a tiny helper used to decide whether the first
// CSV row is a header. Mirrors `strconv.Atoi(s) == nil` minus the
// import (keeps the dependency surface tight).
func looksLikeNumericID(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
