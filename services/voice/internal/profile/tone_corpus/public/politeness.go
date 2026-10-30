package public

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Stanford Politeness Corpus (Wikipedia editor talk pages, via
// ConvoKit) labels each utterance with politeness scores derived from
// human ratings. The corpus ships as a ConvoKit zip; the relevant
// file is utterances.jsonl (one JSON object per line) or, in older
// dumps, a CSV with columns including Request, Score1, Score2,
// Normalized Score.
//
// We support both formats; the loader prefers JSONL when present.
// File layout (after fetch):
//
//	cache/politeness/wikipedia-politeness-corpus.zip
//	    -> wikipedia-politeness-corpus/utterances.jsonl  (preferred)
//	    -> wikipedia-politeness-corpus/utterances.csv    (fallback)
//
// Axis mapping (see composite.go): politeness is the inverse of
// directness in our tone model — heavy hedging / softening reads as
// LOW directness. So:
//
//	directness = 1.0 - clamp01(0.5 + normalized_politeness/2)
//
// "normalized_politeness" in the corpus ranges roughly -2..+2, where
// positive = polite and negative = impolite. The mapping above turns
// that into a 0..1 directness label.

// PolitenessRecord is one parsed utterance with the directness label
// already mapped from the raw politeness score.
type PolitenessRecord struct {
	Text       string
	Directness float64
	RawScore   float64
}

// LoadPoliteness returns the parsed records. Returns (nil, nil) when
// the cache directory is absent.
func LoadPoliteness(cacheRoot string) ([]PolitenessRecord, error) {
	dir := DatasetCacheDir(cacheRoot, DatasetPoliteness)
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("politeness: stat %s: %w", dir, err)
	}

	// Walk the directory looking for utterances.jsonl, then .csv. We
	// don't fail on multiple matches — we use the first one found.
	var jsonlPath, csvPath string
	walkErr := walkFiles(dir, func(path string, info os.DirEntry) error {
		if info.IsDir() {
			return nil
		}
		name := strings.ToLower(info.Name())
		switch {
		case name == "utterances.jsonl" && jsonlPath == "":
			jsonlPath = path
		case name == "utterances.csv" && csvPath == "":
			csvPath = path
		}
		return nil
	})
	if walkErr != nil {
		return nil, fmt.Errorf("politeness: walk: %w", walkErr)
	}

	if jsonlPath == "" && csvPath == "" {
		// Maybe the operator hasn't unzipped — try the zip directly.
		zipPath := filepath.Join(dir, "wikipedia-politeness-corpus.zip")
		if _, err := os.Stat(zipPath); err == nil {
			return loadPolitenessFromZip(zipPath)
		}
		return nil, nil
	}
	if jsonlPath != "" {
		return loadPolitenessJSONL(jsonlPath)
	}
	return loadPolitenessCSV(csvPath)
}

// walkFiles is a tiny wrapper around filepath.WalkDir with the visit
// signature we need (no error-return on the inner filesystem op).
func walkFiles(root string, fn func(path string, info os.DirEntry) error) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		path := filepath.Join(root, e.Name())
		if e.IsDir() {
			if err := walkFiles(path, fn); err != nil {
				return err
			}
			continue
		}
		if err := fn(path, e); err != nil {
			return err
		}
	}
	return nil
}

func loadPolitenessFromZip(zipPath string) ([]PolitenessRecord, error) {
	// Try JSONL first
	if rc, err := OpenZipMember(zipPath, func(n string) bool {
		return strings.HasSuffix(strings.ToLower(n), "utterances.jsonl")
	}); err == nil {
		defer func() { _ = rc.Close() }()
		return parsePolitenessJSONL(rc)
	}
	// Fall back to CSV
	rc, err := OpenZipMember(zipPath, func(n string) bool {
		return strings.HasSuffix(strings.ToLower(n), "utterances.csv")
	})
	if err != nil {
		return nil, fmt.Errorf("politeness zip: no utterances.{jsonl,csv}: %w", err)
	}
	defer func() { _ = rc.Close() }()
	return parsePolitenessCSV(rc)
}

func loadPolitenessJSONL(path string) ([]PolitenessRecord, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parsePolitenessJSONL(f)
}

func loadPolitenessCSV(path string) ([]PolitenessRecord, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parsePolitenessCSV(f)
}

// parsePolitenessJSONL reads ConvoKit-style utterances. Each row is a
// JSON object; we extract the text and one of several possible
// politeness fields (different dump vintages used different names).
func parsePolitenessJSONL(r io.Reader) ([]PolitenessRecord, error) {
	dec := json.NewDecoder(r)
	out := make([]PolitenessRecord, 0, 10_000)
	for {
		var row map[string]any
		if err := dec.Decode(&row); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// Bad row — skip. ConvoKit files occasionally include
			// blank lines.
			continue
		}
		text := stringField(row, "text", "Text", "request", "Request")
		if text == "" {
			continue
		}
		score, ok := politenessScore(row)
		if !ok {
			continue
		}
		out = append(out, PolitenessRecord{
			Text:       strings.TrimSpace(text),
			RawScore:   score,
			Directness: scoreToDirectness(score),
		})
	}
	return out, nil
}

// parsePolitenessCSV reads the legacy Wikipedia-politeness.csv. Column
// names vary slightly across mirrors; we hunt for known synonyms.
func parsePolitenessCSV(r io.Reader) ([]PolitenessRecord, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	header, err := cr.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil
		}
		return nil, fmt.Errorf("read header: %w", err)
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.ToLower(strings.TrimSpace(h))] = i
	}
	textIdx, hasText := firstIdx(col, "request", "text", "utterance")
	scoreIdx, hasScore := firstIdx(col, "normalized score", "normalized_score", "score", "politeness")
	if !hasText || !hasScore {
		return nil, fmt.Errorf("politeness csv: required columns missing (have %v)", header)
	}
	out := make([]PolitenessRecord, 0, 10_000)
	for {
		row, err := cr.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}
		if textIdx >= len(row) || scoreIdx >= len(row) {
			continue
		}
		score, err := parseFloat(row[scoreIdx])
		if err != nil {
			continue
		}
		text := strings.TrimSpace(row[textIdx])
		if text == "" {
			continue
		}
		out = append(out, PolitenessRecord{
			Text:       text,
			RawScore:   score,
			Directness: scoreToDirectness(score),
		})
	}
	return out, nil
}

func firstIdx(m map[string]int, names ...string) (int, bool) {
	for _, n := range names {
		if i, ok := m[n]; ok {
			return i, true
		}
	}
	return -1, false
}

// stringField returns the first non-empty string-typed value from row
// among the supplied keys.
func stringField(row map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := row[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return ""
}

// politenessScore extracts a politeness score from a ConvoKit row.
// Tries (meta.Normalized Score), (meta.score), (meta.politeness), and
// top-level "score" — returns (0,false) if none are present.
func politenessScore(row map[string]any) (float64, bool) {
	if meta, ok := row["meta"].(map[string]any); ok {
		for _, k := range []string{"Normalized Score", "normalized_score", "score", "politeness"} {
			if v, ok := meta[k]; ok {
				if f, ok := toFloat(v); ok {
					return f, true
				}
			}
		}
	}
	for _, k := range []string{"Normalized Score", "score", "politeness"} {
		if v, ok := row[k]; ok {
			if f, ok := toFloat(v); ok {
				return f, true
			}
		}
	}
	return 0, false
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		f, err := parseFloat(x)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// parseFloat is a strconv.ParseFloat shim that avoids importing
// strconv for one function.
func parseFloat(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	// Tiny inline parser sufficient for politeness scores
	// (decimal, optional sign, no scientific notation expected).
	neg := false
	i := 0
	if s[0] == '-' {
		neg = true
		i = 1
	} else if s[0] == '+' {
		i = 1
	}
	intPart := 0.0
	fracPart := 0.0
	fracDiv := 1.0
	sawDigit := false
	dotted := false
	for ; i < len(s); i++ {
		c := s[i]
		if c == '.' {
			if dotted {
				return 0, fmt.Errorf("two dots")
			}
			dotted = true
			continue
		}
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("bad char %q", c)
		}
		sawDigit = true
		if dotted {
			fracDiv *= 10
			fracPart = fracPart*10 + float64(c-'0')
		} else {
			intPart = intPart*10 + float64(c-'0')
		}
	}
	if !sawDigit {
		return 0, fmt.Errorf("no digits")
	}
	v := intPart + fracPart/fracDiv
	if neg {
		v = -v
	}
	return v, nil
}

// scoreToDirectness maps a raw politeness score (roughly -2..+2,
// positive = polite) to a 0..1 directness label. Polite text hedges
// → low directness; impolite text is blunt → high directness.
//
// We clamp the input to [-2, 2] before linearly mapping to [0, 1] in
// the inverse direction (raw +2 → directness 0.0; raw -2 → 1.0).
// Mid-range raw scores collapse to ~0.5, which composite.go treats
// as "no strong directness signal" rather than a confident label —
// we drop the mid band entirely so the trainer only sees confident
// rows. (See PolitenessConfidenceBand.)
func scoreToDirectness(score float64) float64 {
	if score > 2 {
		score = 2
	}
	if score < -2 {
		score = -2
	}
	// 0.5 - score/4 maps +2 -> 0.0 and -2 -> 1.0.
	d := 0.5 - score/4
	if d < 0 {
		d = 0
	}
	if d > 1 {
		d = 1
	}
	return d
}

// PolitenessConfidenceBand defines the half-width around 0.5 that the
// composite pipeline drops as "no signal". Rows with directness in
// (0.5 - band, 0.5 + band) are filtered out before training. Default
// is 0.15 — empirically the politeness corpus's middle band is mostly
// neutral edits where the directness signal is weak.
var PolitenessConfidenceBand = 0.15
