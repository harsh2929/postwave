// Package ingest defines the source-agnostic ingestion interface used by
// Pillar 3 to pull writer source material into a normalized Item stream.
package ingest

import (
	"context"
	"errors"
	"iter"
	"time"
)

// SourceType enumerates ingestion sources known to the voice service.
type SourceType string

const (
	SourceNewsletterArchive SourceType = "newsletter_archive"
	SourceTwitter           SourceType = "twitter"
	SourceBlogRSS           SourceType = "blog_rss"
	SourcePodcastTranscript SourceType = "podcast_transcript"
	SourceLinkedInExport    SourceType = "linkedin_export"
	SourcePasteIn           SourceType = "paste_in"
)

// Item is a single normalized unit of writer text.
type Item struct {
	ID          string
	SourceType  SourceType
	Text        string
	PublishedAt time.Time
	URL         string
	Title       string
}

// IngestParams carry per-call configuration. Sources interpret only the
// fields they care about; unknown fields are ignored.
type IngestParams struct {
	// FeedURL is used by RSS / blog sources.
	FeedURL string
	// Limit caps the number of items returned (0 = source default).
	Limit int
	// TenantID scopes archive/database-backed sources.
	TenantID string
	// RawText is consumed by the paste-in source.
	RawText string
	// ArchivePath is a local relative path to an uploaded export file
	// (Twitter tweets.js, LinkedIn posts CSV, etc.).
	ArchivePath string
	// Extra is a freeform bag for source-specific knobs.
	Extra map[string]string
}

// Source is the contract every ingestion implementation satisfies.
//
// Ingest returns a Go 1.23 range-over-func iterator so callers can stream
// large feeds without buffering everything in memory.
type Source interface {
	Type() SourceType
	Ingest(ctx context.Context, params IngestParams) (iter.Seq2[Item, error], error)
}

// ErrUnsupported indicates a source cannot be ingested by the configured
// connector set.
var ErrUnsupported = errors.New("ingest: unsupported source")
