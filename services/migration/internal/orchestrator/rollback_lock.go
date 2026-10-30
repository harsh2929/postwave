package orchestrator

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/postwave/migrate/canonical"
)

// Keep the original namespace value so deployments upgraded from the
// rollback-only guard contend on the same PostgreSQL advisory key. The lock is
// now shared by every destination-mutating migration execution path.
const rollbackAdvisoryLockNamespace = "postwave:migration:rollback:v1"

// ActiveCampaign operations share one provider-side request budget per
// account. This distinct namespace serializes credential-bearing work across
// migration jobs and service replicas without exposing the stored account
// fingerprint in PostgreSQL, logs, or user-facing errors.
const activeCampaignAccountAdvisoryLockNamespace = "postwave:migration:activecampaign-account:v1"

// HubSpot CRM search and private-app endpoints are quota-scoped to a portal.
// Serialize every credential-bearing migration operation for one opaque,
// provider-verified portal fingerprint across tenants, jobs, and replicas.
const hubSpotAccountAdvisoryLockNamespace = "postwave:migration:hubspot-account:v1"

// Beehiiv enforces its request budget at the workspace/organization level,
// not at the individual publication level. The caller supplies an opaque
// SHA-256 workspace fingerprint so publications in the same workspace share
// one process and PostgreSQL advisory lease without persisting the provider
// workspace id in the lock registry.
const beehiivWorkspaceAdvisoryLockNamespace = "postwave:migration:beehiiv-workspace:v1"

// Klaviyo applies endpoint quotas per account. Serialize all credentialed
// migration work for one opaque account fingerprint across jobs and replicas.
const klaviyoAccountAdvisoryLockNamespace = "postwave:migration:klaviyo-account:v1"

// Customer.io App API quotas are enforced on credentialed workspace reads.
// Serialize all migration work for one opaque region/workspace fingerprint so
// separate jobs, tenants, and service replicas cannot multiply the provider's
// documented 10 requests/second budget.
const customerIOWorkspaceAdvisoryLockNamespace = "postwave:migration:customerio-workspace:v1"

const activeCampaignAccountLeaseHandoffDelay = 200 * time.Millisecond

const hubSpotAccountLeaseHandoffDelay = 200 * time.Millisecond

// The adapter paces Beehiiv below the documented 180 requests/minute. Keep
// one pacing interval between replica owners so a newly-created in-process
// limiter cannot burst immediately behind the prior owner.
const beehiivWorkspaceLeaseHandoffDelay = 350 * time.Millisecond

const klaviyoAccountLeaseHandoffDelay = time.Second

// Leave one ordinary App API request interval between owners. Each process has
// its own in-memory limiter, so the delay prevents a fresh replica from
// immediately spending a full bucket behind the previous owner.
const customerIOWorkspaceLeaseHandoffDelay = 100 * time.Millisecond

// rollbackExecutionRegistry is deliberately package-wide in production. A
// handler can construct more than one RollbackEngine for a job during worker
// recovery, so an engine-local mutex would not provide process-wide
// singleflight semantics.
type rollbackExecutionRegistry struct {
	mu     sync.Mutex
	active map[string]struct{}
}

var defaultRollbackExecutionRegistry = &rollbackExecutionRegistry{
	active: make(map[string]struct{}),
}

func (r *rollbackExecutionRegistry) tryAcquire(key string) (func(), bool) {
	if r == nil {
		r = defaultRollbackExecutionRegistry
	}
	r.mu.Lock()
	if r.active == nil {
		r.active = make(map[string]struct{})
	}
	if _, exists := r.active[key]; exists {
		r.mu.Unlock()
		return nil, false
	}
	r.active[key] = struct{}{}
	r.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			r.mu.Lock()
			delete(r.active, key)
			r.mu.Unlock()
		})
	}, true
}

type rollbackAdvisoryLease interface {
	Release() error
}

type rollbackAdvisoryLeaseFunc func(context.Context, int64) (rollbackAdvisoryLease, error)

type postgresRollbackAdvisoryLease struct {
	conn *sql.Conn
	key  int64
	once sync.Once
	err  error
}

// MigrationExecutionLease owns both process-wide and PostgreSQL execution
// guards. Release is idempotent and always drops the process guard even if the
// database session has to be discarded.
type MigrationExecutionLease struct {
	processRelease func()
	advisory       rollbackAdvisoryLease
	releaseDelay   time.Duration
	sleep          func(time.Duration)
	once           sync.Once
	err            error
}

func rollbackExecutionIdentity(engineTenantID string, job *canonical.MigrationJob) string {
	tenantID := strings.TrimSpace(engineTenantID)
	if tenantID == "" && job != nil {
		tenantID = strings.TrimSpace(job.TenantID)
	}
	jobID := ""
	if job != nil {
		jobID = strings.TrimSpace(job.ID)
	}
	return rollbackAdvisoryLockNamespace + "\x00" + tenantID + "\x00" + jobID
}

func rollbackAdvisoryKey(identity string) int64 {
	digest := sha256.Sum256([]byte(identity))
	return int64(binary.BigEndian.Uint64(digest[:8]))
}

func activeCampaignAccountExecutionIdentity(accountFingerprint string) (string, error) {
	fingerprint := strings.ToLower(strings.TrimSpace(accountFingerprint))
	decoded, err := hex.DecodeString(fingerprint)
	if err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("%w: a valid account fingerprint is required", ErrMigrationExecutionLockUnavailable)
	}
	// The authenticated fingerprint is already opaque. Hashing it again keeps
	// even that control-plane identifier out of the process registry identity.
	digest := sha256.Sum256([]byte(fingerprint))
	return fmt.Sprintf("%s\x00%x", activeCampaignAccountAdvisoryLockNamespace, digest), nil
}

func hubSpotAccountExecutionIdentity(accountFingerprint string) (string, error) {
	fingerprint := strings.ToLower(strings.TrimSpace(accountFingerprint))
	decoded, err := hex.DecodeString(fingerprint)
	if err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("%w: a valid HubSpot account fingerprint is required", ErrMigrationExecutionLockUnavailable)
	}
	digest := sha256.Sum256([]byte(fingerprint))
	return fmt.Sprintf("%s\x00%x", hubSpotAccountAdvisoryLockNamespace, digest), nil
}

func beehiivWorkspaceExecutionIdentity(workspaceFingerprint string) (string, error) {
	fingerprint := strings.ToLower(strings.TrimSpace(workspaceFingerprint))
	decoded, err := hex.DecodeString(fingerprint)
	if err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("%w: a valid Beehiiv workspace fingerprint is required", ErrMigrationExecutionLockUnavailable)
	}
	// Hash the already-opaque fingerprint again so neither the provider id nor
	// its stable control-plane fingerprint appears in process registry keys.
	digest := sha256.Sum256([]byte(fingerprint))
	return fmt.Sprintf("%s\x00%x", beehiivWorkspaceAdvisoryLockNamespace, digest), nil
}

func klaviyoAccountExecutionIdentity(accountFingerprint string) (string, error) {
	fingerprint := strings.ToLower(strings.TrimSpace(accountFingerprint))
	decoded, err := hex.DecodeString(fingerprint)
	if err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("%w: a valid Klaviyo account fingerprint is required", ErrMigrationExecutionLockUnavailable)
	}
	digest := sha256.Sum256([]byte(fingerprint))
	return fmt.Sprintf("%s\x00%x", klaviyoAccountAdvisoryLockNamespace, digest), nil
}

func customerIOWorkspaceExecutionIdentity(workspaceFingerprint string) (string, error) {
	fingerprint := strings.ToLower(strings.TrimSpace(workspaceFingerprint))
	decoded, err := hex.DecodeString(fingerprint)
	if err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("%w: a valid Customer.io workspace fingerprint is required", ErrMigrationExecutionLockUnavailable)
	}
	digest := sha256.Sum256([]byte(fingerprint))
	return fmt.Sprintf("%s\x00%x", customerIOWorkspaceAdvisoryLockNamespace, digest), nil
}

// AcquireMigrationExecutionLease fails closed when another import, delta,
// source-event replay, or rollback owns tenantID/jobID. DB-less local/demo
// execution still receives the process-wide guard; production callers pass
// the tenant-scoped application database to add the cluster-wide lease.
func AcquireMigrationExecutionLease(ctx context.Context, db *sql.DB, tenantID, jobID string) (*MigrationExecutionLease, error) {
	job := &canonical.MigrationJob{ID: strings.TrimSpace(jobID), TenantID: strings.TrimSpace(tenantID)}
	if job.ID == "" || job.TenantID == "" {
		return nil, fmt.Errorf("%w: tenant and job are required", ErrMigrationExecutionLockUnavailable)
	}
	identity := rollbackExecutionIdentity(job.TenantID, job)
	return acquireMigrationExecutionLease(ctx, db, identity, "tenant/job execution is already owned")
}

// AcquireMigrationSessionRefreshLease protects single-use OAuth refresh tokens
// across workers and replicas. Its namespace is separate from the execution
// lease because workers already own the execution lease when loading a token.
func AcquireMigrationSessionRefreshLease(ctx context.Context, db *sql.DB, tenantID, jobID string) (*MigrationExecutionLease, error) {
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return nil, fmt.Errorf("%w: tenant and job are required", ErrMigrationExecutionLockUnavailable)
	}
	return acquireMigrationExecutionLease(ctx, db, fmt.Sprintf("oauth-refresh:%q:%q", tenantID, jobID), "source credential refresh is already owned")
}

// AcquireActiveCampaignAccountExecutionLease serializes credential-bearing
// ActiveCampaign work for one provider account across tenants, jobs, and
// replicas. Callers that already have a migration job must acquire the
// tenant/job lease first so every path follows the same job-then-account lock
// order.
func AcquireActiveCampaignAccountExecutionLease(ctx context.Context, db *sql.DB, accountFingerprint string) (*MigrationExecutionLease, error) {
	identity, err := activeCampaignAccountExecutionIdentity(accountFingerprint)
	if err != nil {
		return nil, err
	}
	lease, err := acquireMigrationExecutionLease(ctx, db, identity, "an ActiveCampaign account operation is already owned")
	if err != nil {
		return nil, err
	}
	// Each replica has its own 5 RPS token bucket. Retaining the global lease
	// for one request interval after an operation prevents a newly owning
	// replica's full bucket from issuing immediately behind the prior request.
	lease.releaseDelay = activeCampaignAccountLeaseHandoffDelay
	lease.sleep = time.Sleep
	return lease, nil
}

// AcquireHubSpotAccountExecutionLease serializes all private-app-token work for
// one provider-verified HubSpot portal. Job-backed callers acquire the
// tenant/job lease first to preserve the global lock order.
func AcquireHubSpotAccountExecutionLease(ctx context.Context, db *sql.DB, accountFingerprint string) (*MigrationExecutionLease, error) {
	identity, err := hubSpotAccountExecutionIdentity(accountFingerprint)
	if err != nil {
		return nil, err
	}
	lease, err := acquireMigrationExecutionLease(ctx, db, identity, "a HubSpot account operation is already owned")
	if err != nil {
		return nil, err
	}
	lease.releaseDelay = hubSpotAccountLeaseHandoffDelay
	lease.sleep = time.Sleep
	return lease, nil
}

// AcquireBeehiivWorkspaceExecutionLease serializes credential-bearing
// Beehiiv work for one provider workspace across publications, tenants, jobs,
// and replicas. Job-backed callers must acquire the tenant/job lease first so
// every lifecycle path follows the same job-then-workspace lock order.
func AcquireBeehiivWorkspaceExecutionLease(ctx context.Context, db *sql.DB, workspaceFingerprint string) (*MigrationExecutionLease, error) {
	identity, err := beehiivWorkspaceExecutionIdentity(workspaceFingerprint)
	if err != nil {
		return nil, err
	}
	lease, err := acquireMigrationExecutionLease(ctx, db, identity, "a Beehiiv workspace operation is already owned")
	if err != nil {
		return nil, err
	}
	lease.releaseDelay = beehiivWorkspaceLeaseHandoffDelay
	lease.sleep = time.Sleep
	return lease, nil
}

// AcquireKlaviyoAccountExecutionLease serializes all token-bearing migration
// work for one Klaviyo account. Job-backed callers acquire the tenant/job
// lease first to preserve the global lock order.
func AcquireKlaviyoAccountExecutionLease(ctx context.Context, db *sql.DB, accountFingerprint string) (*MigrationExecutionLease, error) {
	identity, err := klaviyoAccountExecutionIdentity(accountFingerprint)
	if err != nil {
		return nil, err
	}
	lease, err := acquireMigrationExecutionLease(ctx, db, identity, "a Klaviyo account operation is already owned")
	if err != nil {
		return nil, err
	}
	lease.releaseDelay = klaviyoAccountLeaseHandoffDelay
	lease.sleep = time.Sleep
	return lease, nil
}

// AcquireCustomerIOWorkspaceExecutionLease serializes all token-bearing
// Customer.io migration work for one region/workspace. Job-backed callers
// acquire the tenant/job lease first to preserve the global lock order.
func AcquireCustomerIOWorkspaceExecutionLease(ctx context.Context, db *sql.DB, workspaceFingerprint string) (*MigrationExecutionLease, error) {
	identity, err := customerIOWorkspaceExecutionIdentity(workspaceFingerprint)
	if err != nil {
		return nil, err
	}
	lease, err := acquireMigrationExecutionLease(ctx, db, identity, "a Customer.io workspace operation is already owned")
	if err != nil {
		return nil, err
	}
	lease.releaseDelay = customerIOWorkspaceLeaseHandoffDelay
	lease.sleep = time.Sleep
	return lease, nil
}

func acquireMigrationExecutionLease(ctx context.Context, db *sql.DB, identity, contentionDetail string) (*MigrationExecutionLease, error) {
	processRelease, acquired := defaultRollbackExecutionRegistry.tryAcquire(identity)
	if !acquired {
		return nil, fmt.Errorf("%w: %s", ErrMigrationExecutionInProgress, contentionDetail)
	}
	lease := &MigrationExecutionLease{processRelease: processRelease}
	if db == nil {
		return lease, nil
	}
	advisory, err := postgresRollbackAdvisoryLeaseFunc(db)(ctx, rollbackAdvisoryKey(identity))
	if err != nil {
		processRelease()
		return nil, err
	}
	lease.advisory = advisory
	return lease, nil
}

func (l *MigrationExecutionLease) Release() error {
	if l == nil {
		return nil
	}
	l.once.Do(func() {
		if l.releaseDelay > 0 {
			sleep := l.sleep
			if sleep == nil {
				sleep = time.Sleep
			}
			sleep(l.releaseDelay)
		}
		if l.advisory != nil {
			l.err = l.advisory.Release()
		}
		if l.processRelease != nil {
			l.processRelease()
		}
	})
	return l.err
}

func (r *RollbackEngine) tryAcquireProcessExecution(job *canonical.MigrationJob) (func(), error) {
	identity := rollbackExecutionIdentity(r.TenantID, job)
	registry := r.executionLocks
	if registry == nil {
		registry = defaultRollbackExecutionRegistry
	}
	release, acquired := registry.tryAcquire(identity)
	if !acquired {
		return nil, fmt.Errorf("%w: tenant/job execution is already owned", ErrRollbackInProgress)
	}
	return release, nil
}

func (r *RollbackEngine) tryAcquireAdvisoryExecution(ctx context.Context, job *canonical.MigrationJob) (func(), error) {
	acquire := r.acquireAdvisoryLease
	if acquire == nil && r.DB != nil {
		acquire = postgresRollbackAdvisoryLeaseFunc(r.DB)
	}
	// A DB-less engine is retained for zero-write unit/use cases. Any tracked
	// destination write still fails later in validateRollbackDestinations.
	if acquire == nil {
		return func() {}, nil
	}

	key := rollbackAdvisoryKey(rollbackExecutionIdentity(r.TenantID, job))
	lease, err := acquire(ctx, key)
	if err != nil {
		return nil, err
	}
	if lease == nil {
		return nil, fmt.Errorf("%w: PostgreSQL returned an empty lease", ErrRollbackLockUnavailable)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			// Release failures are fail-safe: the PostgreSQL implementation
			// discards the dedicated connection, which releases every session
			// advisory lock instead of returning a locked connection to the pool.
			_ = lease.Release()
		})
	}, nil
}

func postgresRollbackAdvisoryLeaseFunc(db *sql.DB) rollbackAdvisoryLeaseFunc {
	return func(ctx context.Context, key int64) (rollbackAdvisoryLease, error) {
		if db == nil {
			return nil, fmt.Errorf("%w: PostgreSQL is not configured", ErrRollbackLockUnavailable)
		}
		conn, err := db.Conn(ctx)
		if err != nil {
			return nil, fmt.Errorf("%w: reserve PostgreSQL connection: %v", ErrRollbackLockUnavailable, err)
		}

		var acquired bool
		if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", key).Scan(&acquired); err != nil {
			// The server may have acquired the lock immediately before the
			// context/connection error became visible. Never return this physical
			// session to the pool in that uncertain state.
			discardSQLConn(conn)
			return nil, fmt.Errorf("%w: acquire PostgreSQL advisory lock: %v", ErrRollbackLockUnavailable, err)
		}
		if !acquired {
			_ = conn.Close()
			return nil, fmt.Errorf("%w: PostgreSQL advisory lock is held by another worker", ErrRollbackInProgress)
		}
		return &postgresRollbackAdvisoryLease{conn: conn, key: key}, nil
	}
}

func (l *postgresRollbackAdvisoryLease) Release() error {
	if l == nil || l.conn == nil {
		return nil
	}
	l.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		var unlocked bool
		if err := l.conn.QueryRowContext(ctx, "SELECT pg_advisory_unlock($1)", l.key).Scan(&unlocked); err != nil {
			l.err = fmt.Errorf("release PostgreSQL migration advisory lock: %w", err)
			discardSQLConn(l.conn)
			return
		}
		if !unlocked {
			l.err = fmt.Errorf("release PostgreSQL migration advisory lock: lease was no longer held")
			// No lock is known to remain, but discard the session anyway. This
			// keeps an anomalous connection out of the shared pool.
			discardSQLConn(l.conn)
			return
		}
		l.err = l.conn.Close()
	})
	return l.err
}

// discardSQLConn marks the underlying driver connection unusable. This is
// essential for session advisory locks: sql.Conn.Close alone returns a healthy
// physical session to the pool, which would leak any lock whose unlock result
// was uncertain.
func discardSQLConn(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_ = conn.Raw(func(any) error { return driver.ErrBadConn })
	_ = conn.Close()
}
