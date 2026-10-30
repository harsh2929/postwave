// Package storage adapts the narrower Postgres stores to handlers.VoiceStore.
package storage

import (
	"context"
	"errors"

	"github.com/postwave/postwave/services/voice/internal/handlers"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/profilestore"
	"github.com/postwave/postwave/services/voice/internal/sourcestore"
)

// VoiceStore composes source/item persistence with profile persistence.
type VoiceStore struct {
	Sources  *sourcestore.Store
	Profiles *profilestore.Store
}

func NewVoiceStore(src *sourcestore.Store, prof *profilestore.Store) *VoiceStore {
	return &VoiceStore{Sources: src, Profiles: prof}
}

func (s *VoiceStore) RegisterSource(ctx context.Context, tenantID string, t ingest.SourceType, params ingest.IngestParams) (string, error) {
	return s.Sources.RegisterSource(ctx, tenantID, t, params)
}

func (s *VoiceStore) ListSources(ctx context.Context, tenantID string) ([]handlers.SourceRecord, error) {
	rows, err := s.Sources.ListSources(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	out := make([]handlers.SourceRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, convertSource(row))
	}
	return out, nil
}

func (s *VoiceStore) GetSource(ctx context.Context, tenantID, sourceID string) (handlers.SourceRecord, error) {
	row, err := s.Sources.GetSourceForTenant(ctx, tenantID, sourceID)
	if errors.Is(err, sourcestore.ErrNotFound) {
		return handlers.SourceRecord{}, handlers.ErrNotFound
	}
	if err != nil {
		return handlers.SourceRecord{}, err
	}
	return convertSource(row), nil
}

func (s *VoiceStore) DeleteSource(ctx context.Context, tenantID, sourceID string) error {
	err := s.Sources.DeleteSourceForTenant(ctx, tenantID, sourceID)
	if errors.Is(err, sourcestore.ErrNotFound) {
		return handlers.ErrNotFound
	}
	return err
}

func (s *VoiceStore) RecordIngest(ctx context.Context, tenantID, sourceID string, items []ingest.Item) error {
	err := s.Sources.RecordIngestForTenant(ctx, tenantID, sourceID, items)
	if errors.Is(err, sourcestore.ErrNotFound) {
		return handlers.ErrNotFound
	}
	return err
}

func (s *VoiceStore) ListItems(ctx context.Context, tenantID string) ([]ingest.Item, error) {
	return s.Sources.ListItems(ctx, tenantID)
}

func (s *VoiceStore) SaveProfile(ctx context.Context, p profile.VoiceProfile) error {
	return s.Profiles.SaveProfile(ctx, p)
}

func (s *VoiceStore) GetProfile(ctx context.Context, tenantID string) (profile.VoiceProfile, error) {
	p, err := s.Profiles.GetProfile(ctx, tenantID)
	if errors.Is(err, profilestore.ErrNotFound) {
		return profile.VoiceProfile{}, handlers.ErrNotFound
	}
	return p, err
}

func convertSource(row sourcestore.SourceRecord) handlers.SourceRecord {
	return handlers.SourceRecord{
		ID:            row.ID,
		TenantID:      row.TenantID,
		Type:          row.Type,
		Params:        row.Params,
		LastIngest:    row.LastIngest,
		LastItemCount: row.LastItemCount,
	}
}

var _ handlers.VoiceStore = (*VoiceStore)(nil)
