// Package linkedin ingests LinkedIn post exports supplied as CSV.
package linkedin

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"iter"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

type Source struct{}

const (
	maxLinkedInCSVBytes int64 = 10 << 20
	maxLinkedInCSVRows        = 25000
)

func New() *Source { return &Source{} }

func (s *Source) Type() ingest.SourceType { return ingest.SourceLinkedInExport }

func (s *Source) Ingest(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	params = ingest.NormalizeParams(ingest.SourceLinkedInExport, params)
	if err := ingest.ValidateParams(ctx, ingest.SourceLinkedInExport, params); err != nil {
		return nil, err
	}
	rows, err := readCSVRows(params)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("linkedin: empty csv")
	}
	header := indexHeader(rows[0])
	records := rows[1:]
	limit := params.Limit
	if limit > 0 && len(records) > limit {
		records = records[:limit]
	}

	return func(yield func(ingest.Item, error) bool) {
		for i, rec := range records {
			if ctx.Err() != nil {
				yield(ingest.Item{}, ctx.Err())
				return
			}
			text := firstColumn(rec, header,
				"sharecommentary", "share commentary", "commentary", "text", "content", "post", "body",
			)
			text = strings.TrimSpace(text)
			if text == "" {
				continue
			}
			when := parseLinkedInDate(firstColumn(rec, header, "date", "created at", "created_at", "published_at"))
			item := ingest.Item{
				ID:          fmt.Sprintf("linkedin:%d", i),
				SourceType:  ingest.SourceLinkedInExport,
				Text:        text,
				PublishedAt: when,
				URL:         firstColumn(rec, header, "url", "link", "permalink"),
				Title:       "LinkedIn post",
			}
			if !yield(item, nil) {
				return
			}
		}
	}, nil
}

func readCSVRows(params ingest.IngestParams) ([][]string, error) {
	if strings.TrimSpace(params.RawText) != "" {
		return readCSV(strings.NewReader(params.RawText))
	}
	f, err := os.Open(params.ArchivePath)
	if err != nil {
		return nil, fmt.Errorf("linkedin: open export: %w", err)
	}
	defer func() { _ = f.Close() }()
	return readCSV(f)
}

func readCSV(r io.Reader) ([][]string, error) {
	raw, err := readAllLimited(r, maxLinkedInCSVBytes, "linkedin csv")
	if err != nil {
		return nil, err
	}
	reader := csv.NewReader(bytes.NewReader(raw))
	reader.FieldsPerRecord = -1
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("linkedin: read csv: %w", err)
	}
	if len(rows) > maxLinkedInCSVRows {
		return nil, fmt.Errorf("linkedin: csv has %d rows; max is %d", len(rows), maxLinkedInCSVRows)
	}
	return rows, nil
}

func readAllLimited(r io.Reader, maxBytes int64, label string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%s exceeds %d bytes", label, maxBytes)
	}
	return data, nil
}

func indexHeader(header []string) map[string]int {
	out := make(map[string]int, len(header))
	for i, name := range header {
		out[normalizeHeader(name)] = i
	}
	return out
}

func normalizeHeader(s string) string {
	return strings.ToLower(strings.TrimSpace(strings.ReplaceAll(s, "_", " ")))
}

func firstColumn(rec []string, header map[string]int, names ...string) string {
	for _, name := range names {
		idx, ok := header[normalizeHeader(name)]
		if ok && idx >= 0 && idx < len(rec) && strings.TrimSpace(rec[idx]) != "" {
			return strings.TrimSpace(rec[idx])
		}
	}
	return ""
}

func parseLinkedInDate(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Now().UTC()
	}
	for _, layout := range []string{
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02",
		"Jan 2, 2006",
		"January 2, 2006",
	} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC()
		}
	}
	return time.Now().UTC()
}
