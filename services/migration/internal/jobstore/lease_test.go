package jobstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/migrate/canonical"
)

func newRunnableJob(id, tenant string, started time.Time) *canonical.MigrationJob {
	return &canonical.MigrationJob{
		ID:        id,
		TenantID:  tenant,
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigImporting,
		StartedAt: started,
		Cursor:    map[string]*string{},
	}
}

func TestMemoryStoreClaimJobReturnsRunnableAndLeases(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := NewMemoryJobStore()
	store.SetClock(func() time.Time { return clock })

	if _, err := store.ClaimJob(ctx, "owner-a", time.Minute); !errors.Is(err, ErrJobNotClaimable) {
		t.Fatalf("empty store should return ErrJobNotClaimable, got %v", err)
	}

	if err := store.Create(ctx, newRunnableJob("job-1", "tenant-x", clock)); err != nil {
		t.Fatalf("create: %v", err)
	}

	job, err := store.ClaimJob(ctx, "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if job.ID != "job-1" {
		t.Fatalf("claimed job id = %q, want job-1", job.ID)
	}

	// Second claim by anyone immediately must fail — the job is leased.
	if _, err := store.ClaimJob(ctx, "owner-b", time.Minute); !errors.Is(err, ErrJobNotClaimable) {
		t.Fatalf("second claim while leased should fail; got %v", err)
	}
}

func TestMemoryStoreClaimJobIsFIFOByStartedAt(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := NewMemoryJobStore()
	store.SetClock(func() time.Time { return clock })
	if err := store.Create(ctx, newRunnableJob("late", "tenant-x", clock.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(ctx, newRunnableJob("early", "tenant-x", clock)); err != nil {
		t.Fatal(err)
	}
	first, err := store.ClaimJob(ctx, "w", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "early" {
		t.Fatalf("first claim should be the older job; got %q", first.ID)
	}
}

func TestMemoryStoreClaimJobRespectsLeaseExpiry(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	clock := now
	store := NewMemoryJobStore()
	store.SetClock(func() time.Time { return clock })
	if err := store.Create(ctx, newRunnableJob("job-1", "t", now)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, "owner-a", 30*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, "owner-b", 30*time.Second); !errors.Is(err, ErrJobNotClaimable) {
		t.Fatalf("re-claim before expiry must fail; got %v", err)
	}
	// Advance past expiry; another worker may now claim it.
	clock = clock.Add(time.Minute)
	job, err := store.ClaimJob(ctx, "owner-b", 30*time.Second)
	if err != nil {
		t.Fatalf("claim after expiry: %v", err)
	}
	if job.ID != "job-1" {
		t.Fatalf("expired claim should be re-issued for job-1, got %q", job.ID)
	}
}

func TestMemoryStoreRenewExtendsLease(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := NewMemoryJobStore()
	store.SetClock(func() time.Time { return clock })
	if err := store.Create(ctx, newRunnableJob("job-1", "t", clock)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, "owner-a", 30*time.Second); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(20 * time.Second)
	if err := store.RenewLease(ctx, "job-1", "owner-a", 30*time.Second); err != nil {
		t.Fatalf("renew: %v", err)
	}
	// At t+50s, original lease would have expired (claim+30s) but we
	// renewed at +20s for another 30s, so lease now ends at +50s.
	clock = clock.Add(20 * time.Second) // total t+40s
	if _, err := store.ClaimJob(ctx, "owner-b", 30*time.Second); !errors.Is(err, ErrJobNotClaimable) {
		t.Fatalf("renewed lease must still hold; got %v", err)
	}
	clock = clock.Add(15 * time.Second) // total t+55s — past the renewed window
	if _, err := store.ClaimJob(ctx, "owner-b", 30*time.Second); err != nil {
		t.Fatalf("after renewed lease expiry, owner-b should claim: %v", err)
	}
}

func TestMemoryStoreRenewByForeignOwnerRefuses(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryJobStore()
	if err := store.Create(ctx, newRunnableJob("job-1", "t", time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, "owner-a", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := store.RenewLease(ctx, "job-1", "owner-b", time.Minute); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("foreign renew should return ErrLeaseLost; got %v", err)
	}
}

func TestMemoryStoreReleaseClearsLease(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryJobStore()
	if err := store.Create(ctx, newRunnableJob("job-1", "t", time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, "owner-a", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := store.ReleaseLease(ctx, "job-1", "owner-a"); err != nil {
		t.Fatalf("release: %v", err)
	}
	// After release, anyone may claim.
	if _, err := store.ClaimJob(ctx, "owner-b", time.Minute); err != nil {
		t.Fatalf("post-release claim: %v", err)
	}
}

func TestMemoryStoreReleaseByForeignOwnerRefuses(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryJobStore()
	if err := store.Create(ctx, newRunnableJob("job-1", "t", time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, "owner-a", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := store.ReleaseLease(ctx, "job-1", "owner-b"); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("foreign release should return ErrLeaseLost; got %v", err)
	}
}

func TestMemoryStoreNonRunnableJobsAreNotClaimed(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryJobStore()
	job := newRunnableJob("done", "t", time.Now().UTC())
	job.Status = canonical.MigCompleted
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, "w", time.Minute); !errors.Is(err, ErrJobNotClaimable) {
		t.Fatalf("completed jobs must not be claimed; got %v", err)
	}
}
