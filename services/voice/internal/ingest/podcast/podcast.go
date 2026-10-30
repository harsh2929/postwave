// Package podcast ingests user-provided podcast/webinar transcripts.
package podcast

import (
	"context"
	"fmt"
	"iter"
	"regexp"
	"strings"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

var transcriptBoundary = regexp.MustCompile(`\n\s*\n+`)
var timestampPrefix = regexp.MustCompile(`(?m)^\s*(?:\[[0-9:.]+\]|[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\s*[-–—:]?\s*`)

type Source struct{}

func New() *Source { return &Source{} }

func (s *Source) Type() ingest.SourceType { return ingest.SourcePodcastTranscript }

func (s *Source) Ingest(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	raw := strings.TrimSpace(params.RawText)
	if raw == "" {
		return nil, fmt.Errorf("podcast: RawText transcript required")
	}
	title := firstNonEmpty(params.Extra["title"], "Podcast transcript")
	url := params.Extra["url"]
	parts := transcriptBoundary.Split(raw, -1)
	now := time.Now().UTC()

	return func(yield func(ingest.Item, error) bool) {
		idx := 0
		for _, part := range parts {
			if ctx.Err() != nil {
				yield(ingest.Item{}, ctx.Err())
				return
			}
			text := cleanTranscriptBlock(part)
			if text == "" {
				continue
			}
			item := ingest.Item{
				ID:          fmt.Sprintf("podcast:%d", idx),
				SourceType:  ingest.SourcePodcastTranscript,
				Text:        text,
				PublishedAt: now,
				URL:         url,
				Title:       title,
			}
			idx++
			if !yield(item, nil) {
				return
			}
		}
	}, nil
}

func cleanTranscriptBlock(raw string) string {
	lines := strings.Split(raw, "\n")
	cleaned := make([]string, 0, len(lines))
	for _, line := range lines {
		line = timestampPrefix.ReplaceAllString(line, "")
		line = strings.TrimSpace(line)
		if line != "" {
			cleaned = append(cleaned, line)
		}
	}
	return strings.Join(cleaned, "\n")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
