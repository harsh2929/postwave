package storage

import (
	"context"
	"errors"

	"github.com/postwave/postwave/services/voice/internal/handlers"
	"github.com/postwave/postwave/services/voice/internal/jobstore"
)

// IngestJobsAdapter bridges jobstore.Store (Postgres) to the handlers.IngestJobStore
// contract. Kept thin: the only real work is mapping jobstore.Job → handlers.IngestJob
// and translating jobstore.ErrNotFound to handlers.ErrNotFound so the handler can
// route 404s without importing jobstore.
type IngestJobsAdapter struct {
	Store *jobstore.Store
}

func NewIngestJobsAdapter(s *jobstore.Store) *IngestJobsAdapter {
	return &IngestJobsAdapter{Store: s}
}

func (a *IngestJobsAdapter) Create(ctx context.Context, tenantID, sourceID string) (string, error) {
	return a.Store.Create(ctx, tenantID, sourceID)
}

func (a *IngestJobsAdapter) Start(ctx context.Context, tenantID, jobID string) error {
	return a.Store.Start(ctx, tenantID, jobID)
}

func (a *IngestJobsAdapter) Succeed(ctx context.Context, tenantID, jobID string, itemCount int) error {
	return a.Store.Succeed(ctx, tenantID, jobID, itemCount)
}

func (a *IngestJobsAdapter) Fail(ctx context.Context, tenantID, jobID, errMsg string) error {
	return a.Store.Fail(ctx, tenantID, jobID, errMsg)
}

func (a *IngestJobsAdapter) Get(ctx context.Context, tenantID, jobID string) (handlers.IngestJob, error) {
	j, err := a.Store.Get(ctx, tenantID, jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		return handlers.IngestJob{}, handlers.ErrNotFound
	}
	if err != nil {
		return handlers.IngestJob{}, err
	}
	return handlers.IngestJob{
		ID:           j.ID,
		TenantID:     j.TenantID,
		SourceID:     j.SourceID,
		Status:       string(j.Status),
		ItemCount:    j.ItemCount,
		ErrorMessage: j.ErrorMessage,
		StartedAt:    j.StartedAt,
		FinishedAt:   j.FinishedAt,
		CreatedAt:    j.CreatedAt,
		UpdatedAt:    j.UpdatedAt,
	}, nil
}

var _ handlers.IngestJobStore = (*IngestJobsAdapter)(nil)
