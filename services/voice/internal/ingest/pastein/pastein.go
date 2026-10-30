// Package pastein ingests a single raw-text paste from the user.
//
// Used as a fallback when a writer has under 3,000 words of automatically
// reachable content (PRD §7.3.2 volume gate).
package pastein

import (
	"context"
	"fmt"
	"iter"
	"regexp"
	"strings"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

// Source splits pasted text into Items on blank-line boundaries.
type Source struct{}

// New returns a Source.
func New() *Source { return &Source{} }

// Type implements ingest.Source.
func (s *Source) Type() ingest.SourceType { return ingest.SourcePasteIn }

var paragraphSplit = regexp.MustCompile(`\n\s*\n+`)

// Ingest splits params.RawText on blank lines and yields one Item per
// non-empty paragraph.
func (s *Source) Ingest(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	if strings.TrimSpace(params.RawText) == "" {
		return nil, fmt.Errorf("pastein: RawText required")
	}
	parts := paragraphSplit.Split(params.RawText, -1)
	now := time.Now().UTC()

	return func(yield func(ingest.Item, error) bool) {
		idx := 0
		for _, p := range parts {
			if ctx.Err() != nil {
				yield(ingest.Item{}, ctx.Err())
				return
			}
			text := strings.TrimSpace(p)
			if text == "" {
				continue
			}
			it := ingest.Item{
				ID:          fmt.Sprintf("paste:%d", idx),
				SourceType:  ingest.SourcePasteIn,
				Text:        text,
				PublishedAt: now,
			}
			idx++
			if !yield(it, nil) {
				return
			}
		}
	}, nil
}
