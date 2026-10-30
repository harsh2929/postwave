// Package archive ingests a tenant's own newsletter archive.
//
// Moosewave's Pillar-1 migration imports historical campaigns into a Postgres
// table (`campaign_archive` — owned by another agent). This source reads
// that table for a given tenant and emits one Item per archived campaign.
//
// The actual SQL is deferred to the ArchiveStore interface so this package
// does not own a database connection. services/voice/main.go wires the
// Postgres implementation from internal/storage when DATABASE_URL is set.
package archive

import (
	"context"
	"fmt"
	"iter"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

// CampaignRow mirrors the canonical archive row for a tenant.
type CampaignRow struct {
	ID          string
	Subject     string
	BodyText    string
	URL         string
	PublishedAt time.Time
}

// ArchiveStore abstracts the Postgres lookup for campaign_archive.
type ArchiveStore interface {
	ListCampaigns(ctx context.Context, tenantID string, limit int) ([]CampaignRow, error)
}

// Source ingests campaign archive rows.
type Source struct {
	Store ArchiveStore
}

// New constructs a Source backed by the given store.
func New(store ArchiveStore) *Source { return &Source{Store: store} }

// Type implements ingest.Source.
func (s *Source) Type() ingest.SourceType { return ingest.SourceNewsletterArchive }

// Ingest pulls campaign rows for params.TenantID and yields them as Items.
func (s *Source) Ingest(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	if s.Store == nil {
		return nil, fmt.Errorf("archive: ArchiveStore not wired")
	}
	if params.TenantID == "" {
		return nil, fmt.Errorf("archive: TenantID required")
	}
	rows, err := s.Store.ListCampaigns(ctx, params.TenantID, params.Limit)
	if err != nil {
		return nil, fmt.Errorf("archive: list campaigns: %w", err)
	}

	return func(yield func(ingest.Item, error) bool) {
		for _, r := range rows {
			if ctx.Err() != nil {
				yield(ingest.Item{}, ctx.Err())
				return
			}
			it := ingest.Item{
				ID:          "campaign:" + r.ID,
				SourceType:  ingest.SourceNewsletterArchive,
				Text:        r.BodyText,
				URL:         r.URL,
				Title:       r.Subject,
				PublishedAt: r.PublishedAt,
			}
			if !yield(it, nil) {
				return
			}
		}
	}, nil
}
