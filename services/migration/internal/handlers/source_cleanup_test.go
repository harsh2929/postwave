package handlers

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
	"github.com/stretchr/testify/require"
)

func TestSourceCleanupIsScopedIdempotentAndPreservesDestinationJob(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	ctx := jobstore.WithTenantID(context.Background(), "owner")
	job := &canonical.MigrationJob{ID: "cleanup", TenantID: "owner", Source: canonical.SourceCSV, Status: canonical.MigCompleted, Cursor: map[string]*string{}}
	require.NoError(t, store.Create(ctx, job))
	require.NoError(t, store.SaveSession(ctx, job.ID, "owner", adapter.Session{AccessToken: "secret", Source: canonical.SourceCSV}, time.Now().Add(time.Hour)))
	path := "/v1/migrations/cleanup/source-session"
	rec := uploadTestRequest(h, "other", http.MethodDelete, path, "", "")
	require.Equal(t, 404, rec.Code)
	_, err := store.GetSession(ctx, "owner", job.ID, time.Now())
	require.NoError(t, err)
	lease, err := orchestrator.AcquireMigrationExecutionLease(ctx, nil, "owner", job.ID)
	require.NoError(t, err)
	rec = uploadTestRequest(h, "owner", http.MethodDelete, path, "", "")
	require.Equal(t, 409, rec.Code)
	require.NoError(t, lease.Release())
	for i := 0; i < 2; i++ {
		rec = uploadTestRequest(h, "owner", http.MethodDelete, path, "", "")
		require.Equal(t, 200, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), `"provider_access_revoked":false`)
	}
	_, err = store.GetSession(ctx, "owner", job.ID, time.Now())
	require.ErrorIs(t, err, jobstore.ErrNotFound)
	retained, err := store.Get(ctx, job.ID)
	require.NoError(t, err)
	require.Equal(t, canonical.MigCompleted, retained.Status)
}

func TestSourceCleanupBlocksRunningJobAndRemovesUploadedPayload(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "test")
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_BACKEND", "filesystem")
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	body := "email,status\na@example.com,subscribed\n"
	base := "/v1/migrations/csv/uploads/remove"
	rec := uploadTestRequest(h, "owner", http.MethodPut, base+"?filename=contacts.csv", body, fmt.Sprintf("bytes 0-%d/%d", len(body)-1, len(body)))
	require.Equal(t, 200, rec.Code)
	rec = uploadTestRequest(h, "owner", http.MethodPost, base+"/complete", "", "")
	require.Equal(t, 200, rec.Code)
	m, err := configuredUploadStore().Status(context.Background(), "owner", "csv", "remove")
	require.NoError(t, err)
	ctx := jobstore.WithTenantID(context.Background(), "owner")
	job, err := store.Get(ctx, m.JobID)
	require.NoError(t, err)
	job.Status = canonical.MigImporting
	require.NoError(t, store.Update(ctx, job))
	path := "/v1/migrations/" + job.ID + "/source-session"
	rec = uploadTestRequest(h, "owner", http.MethodDelete, path, "", "")
	require.Equal(t, 409, rec.Code)
	job.Status = canonical.MigFailed
	require.NoError(t, store.Update(ctx, job))
	rec = uploadTestRequest(h, "owner", http.MethodDelete, path, "", "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	rec = uploadTestRequest(h, "owner", http.MethodGet, base, "", "")
	require.Equal(t, 410, rec.Code)
	_, err = h.loadSession(ctx, "owner", job.ID)
	require.Error(t, err)
}

func TestCleanupRejectsOAuthAuthorizationIssuedBeforeRemoval(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	ctx := jobstore.WithTenantID(context.Background(), "owner")
	sess := adapter.Session{Source: canonical.SourceConvertKit, AccountID: "123", AccessToken: "key", Extra: map[string]string{"api_version": "4"}}
	id, err := h.createJob(ctx, "owner", canonical.SourceConvertKit, sess)
	require.NoError(t, err)
	oldIssued := time.Now().Add(-time.Minute)
	rec := uploadTestRequest(h, "owner", http.MethodDelete, "/v1/migrations/"+id+"/source-session", "", "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	_, err = h.completeOAuthJob(ctx, "owner", canonical.SourceConvertKit, oauthStateForJob("old", id), sess, oldIssued)
	require.ErrorIs(t, err, errOAuthAccountMismatch)
	_, err = store.GetSession(ctx, "owner", id, time.Now())
	require.ErrorIs(t, err, jobstore.ErrNotFound)
	_, err = h.completeOAuthJob(ctx, "owner", canonical.SourceConvertKit, oauthStateForJob("fresh", id), sess, time.Now().Add(time.Second))
	require.NoError(t, err)
	_, err = store.GetSession(ctx, "owner", id, time.Now())
	require.NoError(t, err)
}
