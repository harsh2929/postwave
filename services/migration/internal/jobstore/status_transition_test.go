package jobstore

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestMemoryUpdateIfStatusAllowsExactlyOneConcurrentTransition(t *testing.T) {
	store := NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        uuid.NewString(),
		TenantID:  uuid.NewString(),
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	require.NoError(t, store.Create(context.Background(), job))
	first := cloneJob(job)
	first.Status = canonical.MigImporting
	second := cloneJob(job)
	second.Status = canonical.MigRollingBack

	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, candidate := range []*canonical.MigrationJob{&first, &second} {
		wg.Add(1)
		go func(candidate *canonical.MigrationJob) {
			defer wg.Done()
			<-start
			results <- store.UpdateIfStatus(WithTenantID(context.Background(), job.TenantID), candidate, canonical.MigCompleted)
		}(candidate)
	}
	close(start)
	wg.Wait()
	close(results)
	assertSingleTransitionWinner(t, results)
}

func TestMemoryCancelIfStatusPreservesCheckpoint(t *testing.T) {
	store := NewMemoryJobStore()
	cursor := "page-9"
	job := &canonical.MigrationJob{
		ID:        uuid.NewString(),
		TenantID:  uuid.NewString(),
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{"subscribers": &cursor},
		Progress:  canonical.MigrationProgress{SubscribersDone: 900, SubscribersTotal: 1000},
	}
	require.NoError(t, store.Create(context.Background(), job))
	rollbackUntil := time.Now().Add(7 * 24 * time.Hour)
	scoped := WithTenantID(context.Background(), job.TenantID)
	require.NoError(t, store.CancelIfStatus(scoped, job.ID, "migration cancelled by operator", &rollbackUntil, canonical.MigImporting))

	stored, err := store.Get(scoped, job.ID)
	require.NoError(t, err)
	require.Equal(t, canonical.MigFailed, stored.Status)
	require.NotNil(t, stored.Error)
	require.Equal(t, "migration cancelled by operator", *stored.Error)
	require.Equal(t, 900, stored.Progress.SubscribersDone)
	require.NotNil(t, stored.Cursor["subscribers"])
	require.Equal(t, "page-9", *stored.Cursor["subscribers"])
	require.WithinDuration(t, rollbackUntil, *stored.RollbackUntil, time.Millisecond)
	require.ErrorIs(t, store.CancelIfStatus(scoped, job.ID, "migration cancelled by operator", &rollbackUntil, canonical.MigImporting), ErrStatusTransitionConflict)
}

func TestPostgresUpdateIfStatusAllowsExactlyOneConcurrentConnection(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if appURL == "" {
		appURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and TEST_DATABASE_URL/DATABASE_URL are required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(admin.Close)
	app, err := pgxpool.New(ctx, appURL)
	require.NoError(t, err)
	t.Cleanup(app.Close)
	var role string
	require.NoError(t, app.QueryRow(ctx, `SELECT current_user`).Scan(&role))
	if role != "postwave_app" {
		t.Skipf("application connection uses %q, want postwave_app", role)
	}
	tenantID := uuid.NewString()
	jobID := uuid.NewString()
	_, err = admin.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1::uuid, $2, 'Status transition test', 'studio')
	`, tenantID, "status-transition-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	_, err = admin.Exec(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status)
		VALUES ($1::uuid, $2::uuid, 'mailchimp', 'completed')
	`, jobID, tenantID)
	require.NoError(t, err)

	store := NewPostgresJobStore(app)
	scoped := WithTenantID(ctx, tenantID)
	first, err := store.Get(scoped, jobID)
	require.NoError(t, err)
	second, err := store.Get(scoped, jobID)
	require.NoError(t, err)
	first.Status = canonical.MigImporting
	second.Status = canonical.MigRollingBack

	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, candidate := range []*canonical.MigrationJob{first, second} {
		wg.Add(1)
		go func(candidate *canonical.MigrationJob) {
			defer wg.Done()
			<-start
			results <- store.UpdateIfStatus(scoped, candidate, canonical.MigCompleted)
		}(candidate)
	}
	close(start)
	wg.Wait()
	close(results)
	assertSingleTransitionWinner(t, results)
	stored, err := store.Get(scoped, jobID)
	require.NoError(t, err)
	require.Contains(t, []canonical.MigrationStatus{canonical.MigImporting, canonical.MigRollingBack}, stored.Status)
}

func TestPostgresCancelIfStatusPreservesCheckpoint(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if appURL == "" {
		appURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and TEST_DATABASE_URL/DATABASE_URL are required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(admin.Close)
	app, err := pgxpool.New(ctx, appURL)
	require.NoError(t, err)
	t.Cleanup(app.Close)
	var role string
	require.NoError(t, app.QueryRow(ctx, `SELECT current_user`).Scan(&role))
	if role != "postwave_app" {
		t.Skipf("application connection uses %q, want postwave_app", role)
	}
	tenantID := uuid.NewString()
	jobID := uuid.NewString()
	_, err = admin.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1::uuid, $2, 'Cancellation transition test', 'studio')
	`, tenantID, "cancellation-transition-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	_, err = admin.Exec(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status, progress, cursor)
		VALUES ($1::uuid, $2::uuid, 'mailchimp', 'importing',
		        '{"subscribers_done":900,"subscribers_total":1000}'::jsonb,
		        '{"subscribers":"page-9"}'::jsonb)
	`, jobID, tenantID)
	require.NoError(t, err)

	store := NewPostgresJobStore(app)
	scoped := WithTenantID(ctx, tenantID)
	rollbackUntil := time.Now().UTC().Add(7 * 24 * time.Hour)
	require.NoError(t, store.CancelIfStatus(scoped, jobID, "migration cancelled by operator", &rollbackUntil, canonical.MigImporting))
	stored, err := store.Get(scoped, jobID)
	require.NoError(t, err)
	require.Equal(t, canonical.MigFailed, stored.Status)
	require.NotNil(t, stored.Error)
	require.Equal(t, "migration cancelled by operator", *stored.Error)
	require.Equal(t, 900, stored.Progress.SubscribersDone)
	require.NotNil(t, stored.Cursor["subscribers"])
	require.Equal(t, "page-9", *stored.Cursor["subscribers"])
	require.NotNil(t, stored.RollbackUntil)
	require.WithinDuration(t, rollbackUntil, stored.RollbackUntil.UTC(), time.Millisecond)
	require.ErrorIs(t, store.CancelIfStatus(scoped, jobID, "migration cancelled by operator", &rollbackUntil, canonical.MigImporting), ErrStatusTransitionConflict)
}

func assertSingleTransitionWinner(t *testing.T, results <-chan error) {
	t.Helper()
	winners := 0
	conflicts := 0
	for err := range results {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, ErrStatusTransitionConflict):
			conflicts++
		default:
			t.Fatalf("unexpected transition result: %v", err)
		}
	}
	require.Equal(t, 1, winners)
	require.Equal(t, 1, conflicts)
}
