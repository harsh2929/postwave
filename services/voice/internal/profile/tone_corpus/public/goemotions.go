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

// GoEmotions is a 58k Reddit-comment corpus labeled with 28 emotion
// classes (multi-label, plus "neutral"). Released by Google Research
// under Apache 2.0.
//
// File layout (after `tone-corpus-download --dataset=goemotions`):
//
//	cache/goemotions/goemotions_{1,2,3}.csv
//
// Each CSV row is comma-separated:
//
//	text, id, author, subreddit, link_id, parent_id, created_utc,
//	rater_id, example_very_unclear, <28 emotion columns 0/1>
//
// We map emotions to two of our tone axes (warmth, optimism) plus a
// derived humor-negative signal. Mapping is intentionally coarse — we
// are translating per-utterance affect to writer-level tone, which is
// noisy at the unit level but converges in aggregate.

// GoEmotionsRecord is one parsed row with the fields we care about.
type GoEmotionsRecord struct {
	Text        string
	Emotions    []string // names of the 1-labeled emotion columns
	VeryUnclear bool
}

// goEmotionsLabelColumns lists the 28 emotion columns in the order they
// appear in the CSV. Frozen — must match upstream column order or the
// loader silently mis-attributes labels.
var goEmotionsLabelColumns = []string{
	"admiration", "amusement", "anger", "annoyance", "approval", "caring",
	"confusion", "curiosity", "desire", "disappointment", "disapproval",
	"disgust", "embarrassment", "excitement", "fear", "gratitude", "grief",
	"joy", "love", "nervousness", "optimism", "pride", "realization",
	"relief", "remorse", "sadness", "surprise", "neutral",
}

// goEmotionsHeaderColumns: the non-emotion prefix columns we need to
// skip over to locate the emotion bitmap. (We don't actually consume
// most of them, but we keep the count so the bitmap offsets are
// correct.)
const goEmotionsHeaderCount = 9 // text, id, author, subreddit, link_id, parent_id, created_utc, rater_id, example_very_unclear

// LoadGoEmotions reads all three CSV splits from cache/goemotions/.
// Returns (nil, nil) when the directory is absent (treated as "no
// signal" rather than a fatal error).
func LoadGoEmotions(cacheRoot string) ([]GoEmotionsRecord, error) {
	dir := DatasetCacheDir(cacheRoot, DatasetGoEmotions)
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("goemotions: stat %s: %w", dir, err)
	}
	files := []string{"goemotions_1.csv", "goemotions_2.csv", "goemotions_3.csv"}
	out := make([]GoEmotionsRecord, 0, 64*1024)
	for _, fn := range files {
		path := filepath.Join(dir, fn)
		recs, err := readGoEmotionsCSV(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("goemotions %s: %w", fn, err)
		}
		out = append(out, recs...)
	}
	return out, nil
}

func readGoEmotionsCSV(path string) ([]GoEmotionsRecord, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1 // upstream rows vary in trailing-comma handling
	r.LazyQuotes = true

	// Read header so we can lookup emotion columns by name. The header
	// also lets us tolerate future column reorderings without silent
	// mis-attribution.
	header, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	colIndex := map[string]int{}
	for i, name := range header {
		colIndex[strings.TrimSpace(name)] = i
	}
	textIdx, hasText := colIndex["text"]
	unclearIdx, hasUnclear := colIndex["example_very_unclear"]
	if !hasText {
		// Some mirrors strip headers; fall back to fixed offsets that
		// match the upstream CSV documented at the GoEmotions repo.
		textIdx = 0
		hasText = true
		unclearIdx = 8
		hasUnclear = true
		_ = goEmotionsHeaderCount // referenced below for the fallback
	}
	emotionIdx := make(map[string]int, len(goEmotionsLabelColumns))
	for _, name := range goEmotionsLabelColumns {
		if i, ok := colIndex[name]; ok {
			emotionIdx[name] = i
		}
	}
	// Fallback when header was missing: place emotion columns
	// contiguously after the 9 header cols, in canonical order.
	if len(emotionIdx) == 0 {
		for i, name := range goEmotionsLabelColumns {
			emotionIdx[name] = goEmotionsHeaderCount + i
		}
	}

	out := make([]GoEmotionsRecord, 0, 8192)
	for {
		row, err := r.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// Skip malformed rows rather than aborting the whole load —
			// GoEmotions has a handful of comment rows with embedded
			// newlines that the csv package occasionally rejects.
			continue
		}
		if !hasText || textIdx >= len(row) {
			continue
		}
		rec := GoEmotionsRecord{Text: row[textIdx]}
		if hasUnclear && unclearIdx < len(row) {
			rec.VeryUnclear = row[unclearIdx] == "1"
		}
		if rec.VeryUnclear || strings.TrimSpace(rec.Text) == "" {
			continue
		}
		for name, idx := range emotionIdx {
			if idx < len(row) && row[idx] == "1" {
				rec.Emotions = append(rec.Emotions, name)
			}
		}
		if len(rec.Emotions) == 0 {
			continue
		}
		out = append(out, rec)
	}
	return out, nil
}

// EmotionToTone maps a single GoEmotions label to (warmth, optimism)
// contributions. Multi-label rows are averaged in composite.go.
//
// The mapping mirrors the spec in the package doc:
//
//	joy / love / admiration / gratitude      → warmth=0.9, optimism=0.9
//	anger / disappointment / grief           → warmth=0.1, optimism=0.1
//	sadness / fear                           → warmth=0.3, optimism=0.2
//	neutral                                  → 0.5, 0.5
//
// Unmapped emotions return (-1, -1) sentinels so composite.go can skip
// them when computing the per-axis average.
func EmotionToTone(emotion string) (warmth, optimism float64) {
	switch emotion {
	case "joy", "love", "admiration", "gratitude":
		return 0.9, 0.9
	case "amusement", "excitement", "approval":
		return 0.8, 0.85
	case "anger", "disappointment", "grief":
		return 0.1, 0.1
	case "annoyance", "disapproval", "disgust":
		return 0.2, 0.15
	case "sadness", "fear":
		return 0.3, 0.2
	case "remorse", "embarrassment":
		return 0.35, 0.25
	case "caring":
		return 0.85, 0.7
	case "optimism":
		return 0.7, 0.95
	case "pride", "relief":
		return 0.7, 0.8
	case "neutral":
		return 0.5, 0.5
	}
	return -1, -1
}

// EmotionHumorSignal returns 0.1 for emotions whose presence in a
// comment strongly implies it is NOT a joke (anger, annoyance,
// sadness), and -1 (no signal) otherwise. The composite pipeline pairs
// these "anti-joke" samples with the Short Jokes positive class to
// give the humor axis both poles.
func EmotionHumorSignal(emotion string) float64 {
	switch emotion {
	case "anger", "annoyance", "sadness", "grief", "fear", "disappointment":
		return 0.1
	case "amusement":
		// amusement IS the closest analog to "this is funny"; treat it
		// as a weak humor-positive (jokes corpus contributes the
		// strong positive samples).
		return 0.75
	}
	return -1
}
