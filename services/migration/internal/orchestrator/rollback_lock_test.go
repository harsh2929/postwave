package orchestrator

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/canonical"
)

type fakeRollbackAdvisoryLocks struct {
	mu            sync.Mutex
	active        map[int64]struct{}
	blockNext     bool
	firstAcquired chan struct{}
	resumeFirst   chan struct{}
	maxActive     int
}

type fakeRollbackAdvisoryLease struct {
	once    sync.Once
	release func()
}

func newBlockingFakeRollbackAdvisoryLocks() *fakeRollbackAdvisoryLocks {
	return &fakeRollbackAdvisoryLocks{
		active:        make(map[int64]struct{}),
		blockNext:     true,
		firstAcquired: make(chan struct{}),
		resumeFirst:   make(chan struct{}),
	}
}

func (l *fakeRollbackAdvisoryLocks) acquire(ctx context.Context, key int64) (rollbackAdvisoryLease, error) {
	l.mu.Lock()
	if _, exists := l.active[key]; exists {
		l.mu.Unlock()
		return nil, fmt.Errorf("%w: fake cluster lease is held", ErrRollbackInProgress)
	}
	l.active[key] = struct{}{}
	if len(l.active) > l.maxActive {
		l.maxActive = len(l.active)
	}
	shouldBlock := l.blockNext
	l.blockNext = false
	l.mu.Unlock()

	release := func() {
		l.mu.Lock()
		delete(l.active, key)
		l.mu.Unlock()
	}
	if shouldBlock {
		close(l.firstAcquired)
		select {
		case <-l.resumeFirst:
		case <-ctx.Done():
			release()
			return nil, ctx.Err()
		}
	}
	return &fakeRollbackAdvisoryLease{release: release}, nil
}

func (l *fakeRollbackAdvisoryLease) Release() error {
	if l != nil {
		l.once.Do(l.release)
	}
	return nil
}

func (l *fakeRollbackAdvisoryLocks) activeCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.active)
}

func rollbackLockTestJob(now time.Time) *canonical.MigrationJob {
	rollbackUntil := now.Add(time.Hour)
	return &canonical.MigrationJob{
		ID:            "rollback-lock-job",
		TenantID:      "tenant-a",
		Source:        canonical.SourceMailchimp,
		Status:        canonical.MigCompleted,
		RollbackUntil: &rollbackUntil,
	}
}

func TestRollbackProcessSingleflightAcrossEngines(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	registry := &rollbackExecutionRegistry{active: make(map[string]struct{})}
	cluster := newBlockingFakeRollbackAdvisoryLocks()

	first := NewRollbackEngine(nil, nil, "tenant-a")
	first.Now = fixedNow(now)
	first.executionLocks = registry
	first.acquireAdvisoryLease = cluster.acquire
	firstJob := rollbackLockTestJob(now)
	firstResult := make(chan error, 1)
	go func() { firstResult <- first.Rollback(context.Background(), firstJob) }()
	select {
	case <-cluster.firstAcquired:
	case <-time.After(time.Second):
		t.Fatal("first rollback did not acquire its execution locks")
	}

	var secondAudits atomic.Int32
	second := NewRollbackEngine(nil, nil, "tenant-a")
	second.Now = fixedNow(now)
	second.executionLocks = registry
	second.acquireAdvisoryLease = cluster.acquire
	second.Audit = func(context.Context, string, map[string]interface{}) { secondAudits.Add(1) }
	secondJob := rollbackLockTestJob(now)
	err := second.Rollback(context.Background(), secondJob)
	require.ErrorIs(t, err, ErrRollbackInProgress)
	require.Equal(t, canonical.MigCompleted, secondJob.Status)
	require.Nil(t, second.Progress(secondJob.ID))
	require.Zero(t, secondAudits.Load())

	close(cluster.resumeFirst)
	require.NoError(t, <-firstResult)
	require.Equal(t, canonical.MigRolledBack, firstJob.Status)
	require.Zero(t, cluster.activeCount())
}

func TestSharedMigrationExecutionLeaseContendsWithRollback(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	job := rollbackLockTestJob(now)
	lease, err := AcquireMigrationExecutionLease(context.Background(), nil, job.TenantID, job.ID)
	require.NoError(t, err)
	t.Cleanup(func() { _ = lease.Release() })

	engine := NewRollbackEngine(nil, nil, job.TenantID)
	engine.Now = fixedNow(now)
	err = engine.Rollback(context.Background(), job)
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
	require.Equal(t, canonical.MigCompleted, job.Status)
	require.Nil(t, engine.Progress(job.ID))

	require.NoError(t, lease.Release())
	require.NoError(t, engine.Rollback(context.Background(), job))
	require.Equal(t, canonical.MigRolledBack, job.Status)
}

func TestActiveCampaignAccountExecutionLeaseContendsAcrossJobsButNotAccounts(t *testing.T) {
	const tenantID = "tenant-a"
	accountOne := strings.Repeat("a", 64)
	accountTwo := strings.Repeat("b", 64)

	// Different job IDs can own their job-scoped leases concurrently.
	jobOne, err := AcquireMigrationExecutionLease(context.Background(), nil, tenantID, "job-one")
	require.NoError(t, err)
	defer func() { _ = jobOne.Release() }()
	jobTwo, err := AcquireMigrationExecutionLease(context.Background(), nil, tenantID, "job-two")
	require.NoError(t, err)
	defer func() { _ = jobTwo.Release() }()

	accountLease, err := AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, accountOne)
	require.NoError(t, err)
	defer func() { _ = accountLease.Release() }()

	_, err = AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, accountOne)
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
	require.NotContains(t, err.Error(), accountOne)

	otherAccount, err := AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, accountTwo)
	require.NoError(t, err)
	require.NoError(t, otherAccount.Release())

	// Provider limits are global to the ActiveCampaign account. A second
	// Moosewave tenant must contend on the same opaque account identity too.
	otherTenantJob, err := AcquireMigrationExecutionLease(context.Background(), nil, "tenant-b", "job-three")
	require.NoError(t, err)
	defer func() { _ = otherTenantJob.Release() }()
	_, err = AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, accountOne)
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
}

func TestActiveCampaignAccountAdvisoryIdentityExcludesSeparateProcesses(t *testing.T) {
	account := strings.Repeat("c", 64)
	identityOne, err := activeCampaignAccountExecutionIdentity(account)
	require.NoError(t, err)
	identityTwo, err := activeCampaignAccountExecutionIdentity(strings.ToUpper(account))
	require.NoError(t, err)
	require.Equal(t, identityOne, identityTwo)
	require.NotContains(t, identityOne, account)

	cluster := &fakeRollbackAdvisoryLocks{active: make(map[int64]struct{})}
	first, err := cluster.acquire(context.Background(), rollbackAdvisoryKey(identityOne))
	require.NoError(t, err)
	defer func() { _ = first.Release() }()

	_, err = cluster.acquire(context.Background(), rollbackAdvisoryKey(identityTwo))
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)

	otherIdentity, err := activeCampaignAccountExecutionIdentity(strings.Repeat("d", 64))
	require.NoError(t, err)
	other, err := cluster.acquire(context.Background(), rollbackAdvisoryKey(otherIdentity))
	require.NoError(t, err)
	require.NoError(t, other.Release())
}

func TestActiveCampaignAccountLeaseKeepsHandoffCooldownBeforeUnlock(t *testing.T) {
	account := strings.Repeat("e", 64)
	lease, err := AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, account)
	require.NoError(t, err)

	var slept time.Duration
	lease.sleep = func(delay time.Duration) {
		slept = delay
		_, contentionErr := AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, account)
		require.ErrorIs(t, contentionErr, ErrMigrationExecutionInProgress)
	}
	require.NoError(t, lease.Release())
	require.Equal(t, activeCampaignAccountLeaseHandoffDelay, slept)

	next, err := AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, account)
	require.NoError(t, err)
	next.sleep = func(time.Duration) {}
	require.NoError(t, next.Release())
}

func TestHubSpotAccountExecutionLeaseContendsGloballyAndAllowsOtherPortal(t *testing.T) {
	portalOne := strings.Repeat("1", sha256.Size*2)
	portalTwo := strings.Repeat("2", sha256.Size*2)

	first, err := AcquireHubSpotAccountExecutionLease(context.Background(), nil, portalOne)
	require.NoError(t, err)
	defer func() { _ = first.Release() }()

	_, err = AcquireHubSpotAccountExecutionLease(context.Background(), nil, portalOne)
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
	require.NotContains(t, err.Error(), portalOne)

	other, err := AcquireHubSpotAccountExecutionLease(context.Background(), nil, portalTwo)
	require.NoError(t, err)
	other.sleep = func(time.Duration) {}
	require.NoError(t, other.Release())
}

func TestHubSpotAccountAdvisoryIdentityIsOpaqueAndNormalized(t *testing.T) {
	portal := strings.Repeat("a", sha256.Size*2)
	identityOne, err := hubSpotAccountExecutionIdentity(portal)
	require.NoError(t, err)
	identityTwo, err := hubSpotAccountExecutionIdentity(strings.ToUpper(portal))
	require.NoError(t, err)
	require.Equal(t, identityOne, identityTwo)
	require.NotContains(t, identityOne, portal)

	_, err = hubSpotAccountExecutionIdentity("raw-portal-id")
	require.ErrorIs(t, err, ErrMigrationExecutionLockUnavailable)
}

func TestHubSpotAccountLeaseKeepsHandoffCooldownBeforeUnlock(t *testing.T) {
	portal := strings.Repeat("b", sha256.Size*2)
	lease, err := AcquireHubSpotAccountExecutionLease(context.Background(), nil, portal)
	require.NoError(t, err)

	var slept time.Duration
	lease.sleep = func(delay time.Duration) {
		slept = delay
		_, contentionErr := AcquireHubSpotAccountExecutionLease(context.Background(), nil, portal)
		require.ErrorIs(t, contentionErr, ErrMigrationExecutionInProgress)
	}
	require.NoError(t, lease.Release())
	require.Equal(t, hubSpotAccountLeaseHandoffDelay, slept)

	next, err := AcquireHubSpotAccountExecutionLease(context.Background(), nil, portal)
	require.NoError(t, err)
	next.sleep = func(time.Duration) {}
	require.NoError(t, next.Release())
}

func TestBeehiivWorkspaceExecutionLeaseContendsGloballyAndAllowsOtherWorkspace(t *testing.T) {
	workspaceOne := strings.Repeat("1", 64)
	workspaceTwo := strings.Repeat("2", 64)

	first, err := AcquireBeehiivWorkspaceExecutionLease(context.Background(), nil, workspaceOne)
	require.NoError(t, err)
	defer func() { _ = first.Release() }()

	_, err = AcquireBeehiivWorkspaceExecutionLease(context.Background(), nil, workspaceOne)
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
	require.NotContains(t, err.Error(), workspaceOne)

	other, err := AcquireBeehiivWorkspaceExecutionLease(context.Background(), nil, workspaceTwo)
	require.NoError(t, err)
	other.sleep = func(time.Duration) {}
	require.NoError(t, other.Release())
}

func TestBeehiivWorkspaceAdvisoryIdentityIsOpaqueAndNormalized(t *testing.T) {
	workspace := strings.Repeat("a", 64)
	identityOne, err := beehiivWorkspaceExecutionIdentity(workspace)
	require.NoError(t, err)
	identityTwo, err := beehiivWorkspaceExecutionIdentity(strings.ToUpper(workspace))
	require.NoError(t, err)
	require.Equal(t, identityOne, identityTwo)
	require.NotContains(t, identityOne, workspace)

	_, err = beehiivWorkspaceExecutionIdentity("work_raw_provider_id")
	require.ErrorIs(t, err, ErrMigrationExecutionLockUnavailable)
}

func TestBeehiivWorkspaceLeaseKeepsPacingIntervalBeforeUnlock(t *testing.T) {
	workspace := strings.Repeat("b", 64)
	lease, err := AcquireBeehiivWorkspaceExecutionLease(context.Background(), nil, workspace)
	require.NoError(t, err)

	var slept time.Duration
	lease.sleep = func(delay time.Duration) {
		slept = delay
		_, contentionErr := AcquireBeehiivWorkspaceExecutionLease(context.Background(), nil, workspace)
		require.ErrorIs(t, contentionErr, ErrMigrationExecutionInProgress)
	}
	require.NoError(t, lease.Release())
	require.Equal(t, beehiivWorkspaceLeaseHandoffDelay, slept)
}

func TestCustomerIOWorkspaceExecutionLeaseContendsGloballyAndAllowsOtherWorkspace(t *testing.T) {
	workspaceOne := strings.Repeat("3", 64)
	workspaceTwo := strings.Repeat("4", 64)

	first, err := AcquireCustomerIOWorkspaceExecutionLease(context.Background(), nil, workspaceOne)
	require.NoError(t, err)
	defer func() { _ = first.Release() }()

	_, err = AcquireCustomerIOWorkspaceExecutionLease(context.Background(), nil, workspaceOne)
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
	require.NotContains(t, err.Error(), workspaceOne)

	other, err := AcquireCustomerIOWorkspaceExecutionLease(context.Background(), nil, workspaceTwo)
	require.NoError(t, err)
	other.sleep = func(time.Duration) {}
	require.NoError(t, other.Release())
}

func TestCustomerIOWorkspaceAdvisoryIdentityIsOpaqueAndNormalized(t *testing.T) {
	workspace := strings.Repeat("c", 64)
	identityOne, err := customerIOWorkspaceExecutionIdentity(workspace)
	require.NoError(t, err)
	identityTwo, err := customerIOWorkspaceExecutionIdentity(strings.ToUpper(workspace))
	require.NoError(t, err)
	require.Equal(t, identityOne, identityTwo)
	require.NotContains(t, identityOne, workspace)

	_, err = customerIOWorkspaceExecutionIdentity("raw-workspace-id")
	require.ErrorIs(t, err, ErrMigrationExecutionLockUnavailable)
}

func TestCustomerIOWorkspaceLeaseKeepsRequestIntervalBeforeUnlock(t *testing.T) {
	workspace := strings.Repeat("d", 64)
	lease, err := AcquireCustomerIOWorkspaceExecutionLease(context.Background(), nil, workspace)
	require.NoError(t, err)

	var slept time.Duration
	lease.sleep = func(delay time.Duration) {
		slept = delay
		_, contentionErr := AcquireCustomerIOWorkspaceExecutionLease(context.Background(), nil, workspace)
		require.ErrorIs(t, contentionErr, ErrMigrationExecutionInProgress)
	}
	require.NoError(t, lease.Release())
	require.Equal(t, customerIOWorkspaceLeaseHandoffDelay, slept)
}

func TestRollbackAdvisoryLeaseExcludesSeparateProcessRegistries(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	cluster := newBlockingFakeRollbackAdvisoryLocks()

	first := NewRollbackEngine(nil, nil, "tenant-a")
	first.Now = fixedNow(now)
	first.executionLocks = &rollbackExecutionRegistry{active: make(map[string]struct{})}
	first.acquireAdvisoryLease = cluster.acquire
	firstJob := rollbackLockTestJob(now)
	firstResult := make(chan error, 1)
	go func() { firstResult <- first.Rollback(context.Background(), firstJob) }()
	select {
	case <-cluster.firstAcquired:
	case <-time.After(time.Second):
		t.Fatal("first rollback did not acquire the simulated cluster lease")
	}

	second := NewRollbackEngine(nil, nil, "tenant-a")
	second.Now = fixedNow(now)
	// A distinct registry models a different service process. Only the shared
	// PostgreSQL lease can exclude this engine.
	second.executionLocks = &rollbackExecutionRegistry{active: make(map[string]struct{})}
	second.acquireAdvisoryLease = cluster.acquire
	secondJob := rollbackLockTestJob(now)
	err := second.Rollback(context.Background(), secondJob)
	require.ErrorIs(t, err, ErrRollbackInProgress)
	require.Equal(t, canonical.MigCompleted, secondJob.Status)
	require.Nil(t, second.Progress(secondJob.ID))

	close(cluster.resumeFirst)
	require.NoError(t, <-firstResult)
	require.Equal(t, canonical.MigRolledBack, firstJob.Status)
	require.Equal(t, 1, cluster.maxActive)
	require.Zero(t, cluster.activeCount())
}

func TestRollbackFailsClosedWhenAdvisoryLeaseCannotBeProven(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	var audits atomic.Int32
	engine := NewRollbackEngine(nil, nil, "tenant-a")
	engine.Now = fixedNow(now)
	engine.executionLocks = &rollbackExecutionRegistry{active: make(map[string]struct{})}
	engine.acquireAdvisoryLease = func(context.Context, int64) (rollbackAdvisoryLease, error) {
		return nil, fmt.Errorf("%w: injected database failure", ErrRollbackLockUnavailable)
	}
	engine.Audit = func(context.Context, string, map[string]interface{}) { audits.Add(1) }
	job := rollbackLockTestJob(now)

	err := engine.Rollback(context.Background(), job)
	require.ErrorIs(t, err, ErrRollbackLockUnavailable)
	require.Equal(t, canonical.MigCompleted, job.Status)
	require.Nil(t, engine.Progress(job.ID))
	require.Zero(t, audits.Load())

	// The process guard must also be released on lock-acquisition failures so
	// an operator can retry after PostgreSQL recovers.
	engine.acquireAdvisoryLease = nil
	require.NoError(t, engine.Rollback(context.Background(), job))
}

func TestPostgresRollbackAdvisoryLeaseExcludesSecondConnection(t *testing.T) {
	databaseURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("TEST_DATABASE_URL")
	}
	if databaseURL == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL or TEST_DATABASE_URL to run PostgreSQL advisory-lock test")
	}
	db, err := sql.Open("pgx", databaseURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	key := rollbackAdvisoryKey(rollbackAdvisoryLockNamespace + "\x00integration\x00" + t.Name())
	acquire := postgresRollbackAdvisoryLeaseFunc(db)
	first, err := acquire(ctx, key)
	require.NoError(t, err)
	t.Cleanup(func() { _ = first.Release() })

	_, err = acquire(ctx, key)
	require.True(t, errors.Is(err, ErrRollbackInProgress), "expected lock contention, got %v", err)
	require.NoError(t, first.Release())

	second, err := acquire(ctx, key)
	require.NoError(t, err)
	require.NoError(t, second.Release())
}

func TestPostgresActiveCampaignAccountLeaseExcludesSecondReplica(t *testing.T) {
	databaseURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("TEST_DATABASE_URL")
	}
	if databaseURL == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL or TEST_DATABASE_URL to run PostgreSQL advisory-lock test")
	}
	db, err := sql.Open("pgx", databaseURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	identity, err := activeCampaignAccountExecutionIdentity(strings.Repeat("f", 64))
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	acquire := postgresRollbackAdvisoryLeaseFunc(db)
	first, err := acquire(ctx, rollbackAdvisoryKey(identity))
	require.NoError(t, err)
	t.Cleanup(func() { _ = first.Release() })

	_, err = acquire(ctx, rollbackAdvisoryKey(identity))
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
	require.NoError(t, first.Release())

	second, err := acquire(ctx, rollbackAdvisoryKey(identity))
	require.NoError(t, err)
	require.NoError(t, second.Release())
}

func TestPostgresBeehiivWorkspaceLeaseExcludesSecondReplica(t *testing.T) {
	databaseURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("TEST_DATABASE_URL")
	}
	if databaseURL == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL or TEST_DATABASE_URL to run PostgreSQL advisory-lock test")
	}
	db, err := sql.Open("pgx", databaseURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	identity, err := beehiivWorkspaceExecutionIdentity(strings.Repeat("9", 64))
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	acquire := postgresRollbackAdvisoryLeaseFunc(db)
	first, err := acquire(ctx, rollbackAdvisoryKey(identity))
	require.NoError(t, err)
	t.Cleanup(func() { _ = first.Release() })

	_, err = acquire(ctx, rollbackAdvisoryKey(identity))
	require.ErrorIs(t, err, ErrMigrationExecutionInProgress)
	require.NoError(t, first.Release())

	second, err := acquire(ctx, rollbackAdvisoryKey(identity))
	require.NoError(t, err)
	require.NoError(t, second.Release())
}
