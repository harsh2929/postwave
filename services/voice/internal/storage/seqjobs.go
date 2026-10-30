package storage

import (
	"context"
	"errors"

	"github.com/postwave/postwave/services/voice/internal/handlers"
	"github.com/postwave/postwave/services/voice/internal/seqjobstore"
)

// SequenceJobsAdapter bridges seqjobstore.Store (Postgres) to the
// handlers.SequenceJobStore contract. Same shape as IngestJobsAdapter:
// translates seqjobstore.Job → handlers.SequenceJob and
// seqjobstore.ErrNotFound → handlers' "not found" semantics so the
// handlers package can stay free of the seqjobstore import.
type SequenceJobsAdapter struct {
	Store *seqjobstore.Store
}

func NewSequenceJobsAdapter(s *seqjobstore.Store) *SequenceJobsAdapter {
	return &SequenceJobsAdapter{Store: s}
}

func (a *SequenceJobsAdapter) Create(ctx context.Context, tenantID, sequenceID string, position *int, request any) (string, error) {
	return a.Store.Create(ctx, tenantID, sequenceID, position, request)
}

func (a *SequenceJobsAdapter) Start(ctx context.Context, tenantID, jobID string) error {
	return a.Store.Start(ctx, tenantID, jobID)
}

func (a *SequenceJobsAdapter) Succeed(ctx context.Context, tenantID, jobID, sequenceID string) error {
	return a.Store.Succeed(ctx, tenantID, jobID, sequenceID)
}

func (a *SequenceJobsAdapter) Fail(ctx context.Context, tenantID, jobID, errMsg string) error {
	return a.Store.Fail(ctx, tenantID, jobID, errMsg)
}

func (a *SequenceJobsAdapter) Get(ctx context.Context, tenantID, jobID string) (handlers.SequenceJob, error) {
	j, err := a.Store.Get(ctx, tenantID, jobID)
	if errors.Is(err, seqjobstore.ErrNotFound) {
		// Match the handler's "not found" semantics — caller surfaces
		// a 404 either way, but explicit translation here keeps the
		// handlers package import-clean.
		return handlers.SequenceJob{}, errors.New("not found")
	}
	if err != nil {
		return handlers.SequenceJob{}, err
	}
	return handlers.SequenceJob{
		ID:            j.ID,
		TenantID:      j.TenantID,
		SequenceID:    j.SequenceID,
		EmailPosition: j.EmailPosition,
		Status:        string(j.Status),
		ErrorMessage:  j.ErrorMessage,
		StartedAt:     j.StartedAt,
		FinishedAt:    j.FinishedAt,
		CreatedAt:     j.CreatedAt,
		UpdatedAt:     j.UpdatedAt,
	}, nil
}

var _ handlers.SequenceJobStore = (*SequenceJobsAdapter)(nil)
