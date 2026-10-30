package jobstore

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestPostgresWorkerEnumerationEntersReviewedTenantScope(t *testing.T) {
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

	tenantIDs := []string{uuid.NewString(), uuid.NewString()}
	jobIDs := []string{uuid.NewString(), uuid.NewString()}
	for i := range tenantIDs {
		_, err := admin.Exec(ctx, `
			INSERT INTO tenants (id, slug, name, tier)
			VALUES ($1::uuid, $2, 'Migration worker enumeration', 'studio')
		`, tenantIDs[i], "migration-worker-enumeration-"+uuid.NewString())
		require.NoError(t, err)
		_, err = admin.Exec(ctx, `
			INSERT INTO migration_jobs (id, tenant_id, source, status)
			VALUES ($1::uuid, $2::uuid, 'mailchimp', 'importing')
		`, jobIDs[i], tenantIDs[i])
		require.NoError(t, err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, tenantIDs[0], tenantIDs[1])
	})

	// Migration 1728 deliberately hides tenants unless a worker transaction
	// opts into the reviewed scope. This precondition makes the regression
	// visible: a bare enumeration would silently produce no work.
	var bareVisible int
	require.NoError(t, app.QueryRow(ctx, `SELECT count(*) FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, tenantIDs[0], tenantIDs[1]).Scan(&bareVisible))
	require.Zero(t, bareVisible)

	store := NewPostgresJobStore(app)
	due := time.Now().Add(-time.Minute)
	for i := range tenantIDs {
		scoped := WithTenantID(ctx, tenantIDs[i])
		_, err := store.UpsertShadowMonitor(scoped, ShadowMonitorRecord{
			JobID: jobIDs[i], TenantID: tenantIDs[i], Source: canonical.SourceMailchimp,
			IntervalSeconds: 3600, NextCheckAt: &due,
		})
		require.NoError(t, err)
		_, err = store.UpsertSourceEventMonitor(scoped, SourceEventMonitorRecord{
			JobID: jobIDs[i], TenantID: tenantIDs[i], Source: canonical.SourceMailchimp,
			Enabled: true, IntervalSeconds: 3600, NextSyncAt: &due,
		})
		require.NoError(t, err)
	}

	runnable, err := store.ListRunnable(ctx)
	require.NoError(t, err)
	for _, jobID := range jobIDs {
		require.True(t, containsMigrationJob(runnable, jobID), "runnable worker missed job %s", jobID)
	}
	shadow, err := store.ListDueShadowMonitors(ctx, time.Now(), 100)
	require.NoError(t, err)
	for _, jobID := range jobIDs {
		require.True(t, containsShadowMonitor(shadow, jobID), "shadow worker missed job %s", jobID)
	}
	events, err := store.ListDueSourceEventMonitors(ctx, time.Now(), 100)
	require.NoError(t, err)
	for _, jobID := range jobIDs {
		require.True(t, containsSourceEventMonitor(events, jobID), "source-event worker missed job %s", jobID)
	}
}

func containsMigrationJob(jobs []canonical.MigrationJob, jobID string) bool {
	for _, job := range jobs {
		if job.ID == jobID {
			return true
		}
	}
	return false
}

func containsShadowMonitor(monitors []ShadowMonitorRecord, jobID string) bool {
	for _, monitor := range monitors {
		if monitor.JobID == jobID {
			return true
		}
	}
	return false
}

func containsSourceEventMonitor(monitors []SourceEventMonitorRecord, jobID string) bool {
	for _, monitor := range monitors {
		if monitor.JobID == jobID {
			return true
		}
	}
	return false
}
