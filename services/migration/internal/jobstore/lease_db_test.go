package jobstore

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestDBConcurrentWorkersClaimWithTenantUpdatePolicy(t *testing.T) {
	adminURL, appURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"), os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" || appURL == "" {
		t.Skip("isolated database URLs required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL)
	require.NoError(t, err)
	defer admin.Close()
	pool, err := pgxpool.New(ctx, appURL)
	require.NoError(t, err)
	defer pool.Close()
	store := NewPostgresJobStore(pool, nil)
	tenants := []string{uuid.NewString(), uuid.NewString()}
	expected := map[string]bool{}
	for _, tenant := range tenants {
		_, err := admin.Exec(ctx, `INSERT INTO tenants(id,slug,name,tier) VALUES($1,$2,'Lease regression','studio')`, tenant, "lease-"+tenant)
		require.NoError(t, err)
		defer admin.Exec(ctx, `DELETE FROM tenants WHERE id=$1`, tenant)
		for i := 0; i < 3; i++ {
			id := uuid.NewString()
			expected[id] = true
			require.NoError(t, store.Create(WithTenantID(ctx, tenant), &canonical.MigrationJob{ID: id, TenantID: tenant, Source: canonical.SourceCSV, Status: canonical.MigDryRun, StartedAt: time.Now()}))
		}
	}
	// An unscoped application connection still cannot update tenant jobs.
	tag, err := pool.Exec(ctx, `UPDATE migration_jobs SET notes='must not write' WHERE id=ANY($1::uuid[])`, keysForLeaseTest(expected))
	require.NoError(t, err)
	require.Zero(t, tag.RowsAffected())
	var wg sync.WaitGroup
	ids := make(chan string, 6)
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			job, err := store.ClaimJob(ctx, uuid.NewString(), time.Minute)
			if err != nil {
				errs <- err
				return
			}
			ids <- job.ID
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	seen := map[string]bool{}
	for id := range ids {
		require.True(t, expected[id])
		require.False(t, seen[id], "same job leased to two workers")
		seen[id] = true
	}
	require.Len(t, seen, 6)
	_, err = store.ClaimJob(ctx, uuid.NewString(), time.Minute)
	require.True(t, errors.Is(err, ErrJobNotClaimable))
}
func keysForLeaseTest(in map[string]bool) []string {
	var out []string
	for id := range in {
		out = append(out, id)
	}
	return out
}
