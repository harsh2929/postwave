package handlers

import (
	"context"
	"net/http"
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/stretchr/testify/require"
)

func TestMailerLiteCannotRetargetJobWithReplacementKey(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	require.NoError(t, store.Create(jobstore.WithTenantID(context.Background(), "tenant"), &canonical.MigrationJob{ID: "original", TenantID: "tenant", Source: canonical.SourceMailerLite, Status: canonical.MigAwaitingConfirmation}))
	h := NewMigration("", store)
	rec := uploadTestRequest(h, "tenant", http.MethodPost, "/v1/migrations/original/source-session", `{"api_key":"a-different-account-key"}`, "")
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Contains(t, rec.Body.String(), "requires a new migration")
}
