package quota

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestNoopQuota_AlwaysAllows is a dev-mode contract test — the noop
// implementation must never block a call regardless of input.
func TestNoopQuota_AlwaysAllows(t *testing.T) {
	q := NoopQuota{}
	for i := 0; i < 1000; i++ {
		if err := q.CheckAndConsume(context.Background(), "t1", "subject_line", 1); err != nil {
			t.Fatalf("noop quota rejected call %d: %v", i, err)
		}
	}
	lim, err := q.Limits(context.Background(), "t1")
	if err != nil {
		t.Fatalf("Limits: %v", err)
	}
	if lim.DailyTotal != 0 {
		t.Errorf("noop Limits.DailyTotal = %d, want 0 (unlimited sentinel)", lim.DailyTotal)
	}
}

// TestLimitsForTier_DefaultsAndOverrides locks in the env-override
// contract so an operator can bump a tier mid-incident without a
// code change.
func TestLimitsForTier_DefaultsAndOverrides(t *testing.T) {
	// Defaults.
	free := LimitsForTier(TierFree)
	if free.DailyTotal != defaultLimitFree {
		t.Errorf("free default = %d, want %d", free.DailyTotal, defaultLimitFree)
	}
	studio := LimitsForTier(TierStudio)
	if studio.DailyTotal != defaultLimitStudio {
		t.Errorf("studio default = %d, want %d", studio.DailyTotal, defaultLimitStudio)
	}
	scale := LimitsForTier(TierScale)
	if scale.DailyTotal != defaultLimitScale {
		t.Errorf("scale default = %d, want %d", scale.DailyTotal, defaultLimitScale)
	}

	// Env override.
	t.Setenv("POSTWAVE_AI_QUOTA_FREE", "42")
	if got := LimitsForTier(TierFree).DailyTotal; got != 42 {
		t.Errorf("env-override free = %d, want 42", got)
	}

	// Negative / non-numeric env values fall back to the default.
	t.Setenv("POSTWAVE_AI_QUOTA_STUDIO", "-5")
	if got := LimitsForTier(TierStudio).DailyTotal; got != defaultLimitStudio {
		t.Errorf("negative env override should fall back to default, got %d", got)
	}
	t.Setenv("POSTWAVE_AI_QUOTA_SCALE", "abc")
	if got := LimitsForTier(TierScale).DailyTotal; got != defaultLimitScale {
		t.Errorf("non-numeric env override should fall back to default, got %d", got)
	}
}

// TestLimitsForTier_UnknownFallsBackToFree codifies the fail-closed
// posture — a typo in the resolver must NOT grant scale-tier limits.
func TestLimitsForTier_UnknownFallsBackToFree(t *testing.T) {
	got := LimitsForTier("bogus-tier")
	if got.DailyTotal != defaultLimitFree {
		t.Errorf("unknown tier fell through to %d, want %d (free)", got.DailyTotal, defaultLimitFree)
	}
}

// TestResetsAtUTCMidnight verifies the response-body helper.
func TestResetsAtUTCMidnight(t *testing.T) {
	at := time.Date(2026, 5, 9, 14, 23, 0, 0, time.UTC)
	got := ResetsAtUTCMidnight(at)
	want := "2026-05-10T00:00:00Z"
	if got != want {
		t.Errorf("ResetsAtUTCMidnight = %q, want %q", got, want)
	}
}

// ----------------------------------------------------------------------
// PostgresQuota integration tests — skip when DATABASE_URL is unset,
// matching the suppressions/store_test.go pattern.
// ----------------------------------------------------------------------

// newTestPool opens a pool on DATABASE_URL. In CI that is the unprivileged
// postwave_app role, so every read and write below passes through the same RLS
// policies production does.
//
// The pool is closed by t.Cleanup, never by a deferred Close in the test body.
// Cleanups run after the test function has returned — after its defers — in
// last-registered-first order. The old `defer pool.Close()` therefore shut the
// pool before any cleanup ran, and every teardown failed with "closed pool".
// Registered here, ahead of everything else a test registers, this Close runs
// last.
func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	return pool
}

// seedTenant creates a tenant that belongs to the calling test alone and
// removes it when the test ends.
//
// tenant_ai_usage.tenant_id references tenants(id) (migration 1730), and a
// freshly migrated database — which is what CI runs against — holds no tenants
// at all. These tests used to borrow the fixed ids ...0077, ...0078 and ...0079,
// which nothing ever created, so on a clean database the very first upsert
// failed the foreign key. A fresh id per test also means no counter can survive
// from an earlier run, so there is nothing to pre-clean.
//
// The insert runs under the new tenant's own app.tenant_id, the only shape the
// tenants INSERT policy admits for the application role, and the same shape
// signup uses (auth.Repo.CreateTenantWithOwner). The delete runs under the same
// scope and cascades to tenant_ai_usage. A teardown that removes nothing is
// reported, because it means the tenant and its counters leaked.
func seedTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	inTenantTx(t, pool, tenantID, "seed tenant", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'voice quota test', 'studio')`, tenantID, "voice-quota-"+tenantID)
		return err
	})
	t.Cleanup(func() {
		var removed int64
		inTenantTx(t, pool, tenantID, "delete tenant", func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			removed = tag.RowsAffected()
			return err
		})
		if removed != 1 {
			t.Errorf("tenant teardown removed %d tenant rows, want 1; tenant %s leaked", removed, tenantID)
		}
	})
	return tenantID
}

// inTenantTx runs a fixture step (seed, read-back, teardown) in one transaction
// scoped to tenantID and commits it. It builds its own bounded context so it
// also works from t.Cleanup, after the test body's contexts are gone.
//
// It retries while Postgres reports its shared lock table full (SQLSTATE 53200,
// "out of shared memory"). Deleting a tenant cascades through every table that
// references tenants(id) — 735 foreign keys at migration head — and holds a
// lock on each of those tables and their indexes until commit: about 3,300
// locks for a single DELETE. The shared lock table holds roughly
// max_locks_per_transaction × max_connections entries (64 × 100 on the stock
// postgres:16 image CI runs), so two tenant deletes from other packages
// running at the same moment can fill it, and any statement that needs a new
// lock fails until one of them commits. That is contention on the shared test
// database, not a defect in the code under test, and it clears on its own; the
// whole transaction is rolled back and replayed. Only fixture steps retry: the
// calls under test run once.
func inTenantTx(t *testing.T, pool *pgxpool.Pool, tenantID, what string, fn func(context.Context, pgx.Tx) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	backoff := 50 * time.Millisecond
	for {
		err := runTenantTx(ctx, pool, tenantID, fn)
		if err == nil {
			return
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "53200" {
			t.Fatalf("%s: %v", what, err)
		}
		t.Logf("%s: shared lock table full, retrying in %v: %v", what, backoff, err)
		select {
		case <-ctx.Done():
			t.Fatalf("%s: lock table still full after retrying: %v", what, err)
		case <-time.After(backoff):
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}
}

func runTenantTx(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(context.Context, pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("set_config: %w", err)
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// TestPostgresQuota_AllowsUpToLimit_RejectsOverflow runs CheckAndConsume
// in a tight loop and confirms the (limit+1)th call hits ErrOverQuota.
func TestPostgresQuota_AllowsUpToLimit_RejectsOverflow(t *testing.T) {
	pool := newTestPool(t)
	tenantID := seedTenant(t, pool)
	t.Setenv("POSTWAVE_AI_QUOTA_FREE", "5")

	q := &PostgresQuota{
		Pool: pool,
		Tier: func(_ context.Context, _ string) (string, error) { return TierFree, nil },
	}

	for i := 0; i < 5; i++ {
		if err := q.CheckAndConsume(context.Background(), tenantID, "subject_line", 1); err != nil {
			t.Fatalf("call %d should have succeeded, got %v", i+1, err)
		}
	}
	// 6th call must fail.
	err := q.CheckAndConsume(context.Background(), tenantID, "subject_line", 1)
	if !errors.Is(err, ErrOverQuota) {
		t.Fatalf("6th call: got %v, want ErrOverQuota", err)
	}
}

// TestPostgresQuota_DailyResetMintsFreshBudget proves that the day-keyed
// PRIMARY KEY does its job — bumping the test clock past midnight
// makes a brand-new row, so the tenant gets a fresh quota.
func TestPostgresQuota_DailyResetMintsFreshBudget(t *testing.T) {
	pool := newTestPool(t)
	tenantID := seedTenant(t, pool)
	t.Setenv("POSTWAVE_AI_QUOTA_FREE", "2")

	day1 := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	q := &PostgresQuota{
		Pool: pool,
		Tier: func(_ context.Context, _ string) (string, error) { return TierFree, nil },
		Now:  func() time.Time { return day1 },
	}

	// Spend the day-1 budget.
	if err := q.CheckAndConsume(context.Background(), tenantID, "body", 1); err != nil {
		t.Fatalf("day1 call 1: %v", err)
	}
	if err := q.CheckAndConsume(context.Background(), tenantID, "body", 1); err != nil {
		t.Fatalf("day1 call 2: %v", err)
	}
	if err := q.CheckAndConsume(context.Background(), tenantID, "body", 1); !errors.Is(err, ErrOverQuota) {
		t.Fatalf("day1 call 3: got %v, want ErrOverQuota", err)
	}

	// Roll the clock forward — same tenant, same kind, fresh quota.
	q.Now = func() time.Time { return day1.Add(48 * time.Hour) }
	if err := q.CheckAndConsume(context.Background(), tenantID, "body", 1); err != nil {
		t.Fatalf("day3 call 1 should succeed (fresh day): %v", err)
	}
}

// TestPostgresQuota_RejectIsAtomic confirms that a rejected call does
// NOT advance the counter — i.e. once a tenant is at the limit, every
// subsequent attempt is rejected too (no leakage).
func TestPostgresQuota_RejectIsAtomic(t *testing.T) {
	pool := newTestPool(t)
	tenantID := seedTenant(t, pool)
	t.Setenv("POSTWAVE_AI_QUOTA_FREE", "1")

	// One pinned clock for the writes and the read-back. Two separate
	// time.Now() calls could straddle UTC midnight, and the counter would be
	// looked up under a day the calls never wrote.
	at := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	q := &PostgresQuota{
		Pool: pool,
		Tier: func(_ context.Context, _ string) (string, error) { return TierFree, nil },
		Now:  func() time.Time { return at },
	}
	if err := q.CheckAndConsume(context.Background(), tenantID, "summary", 1); err != nil {
		t.Fatalf("first call should succeed: %v", err)
	}
	for i := 0; i < 5; i++ {
		if err := q.CheckAndConsume(context.Background(), tenantID, "summary", 1); !errors.Is(err, ErrOverQuota) {
			t.Fatalf("call %d should still be over quota, got %v", i+2, err)
		}
	}

	// The DB row should still show count=1, not count=6.
	got := readCount(t, pool, tenantID, "summary", at)
	if got != 1 {
		t.Errorf("count = %d, want 1 (rejected calls must not advance the counter)", got)
	}
}

// readCount reads the per-(tenant, kind, day) counter for assertions. A
// missing row reads as 0; any other error fails the test rather than posing
// as an empty counter.
func readCount(t *testing.T, pool *pgxpool.Pool, tenantID, kind string, at time.Time) int {
	t.Helper()
	day := time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
	var n int
	inTenantTx(t, pool, tenantID, "read count", func(ctx context.Context, tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
SELECT count FROM tenant_ai_usage
 WHERE tenant_id = $1::uuid AND day = $2::date AND kind = $3`,
			tenantID, day, kind).Scan(&n)
		if errors.Is(err, pgx.ErrNoRows) {
			n = 0
			return nil
		}
		return err
	})
	return n
}

// TestCheckAndConsumeSerializesPerTenantNotPerRow pins the fix for a race the
// code's own comment used to deny.
//
// CheckAndConsume upserts into (tenant_id, day, kind) and then sums across all
// kinds. The old comment claimed "two concurrent calls are serialized by the
// row-level lock the UPSERT takes". That holds only for the SAME kind. Two
// calls with DIFFERENT kinds touch different rows, share no lock, and under
// READ COMMITTED neither one's SUM sees the other's uncommitted increment — so
// both read a total under the cap and both commit.
//
// Demonstrated against Postgres before the fix: two transactions incrementing
// different kinds each read a total of 1 while the committed total became 2.
// This service passes at least five distinct kinds (sequence, sequence_draft,
// regenerate, template_generate, and chat's caller-supplied kind), and every
// unit over the cap is a paid generation.
//
// The repair is a transaction-scoped advisory lock keyed on the tenant. This
// test asserts it is taken BEFORE the upsert — a lock acquired afterwards would
// serialize nothing, because the read that matters has already happened.
func TestCheckAndConsumeSerializesPerTenantNotPerRow(t *testing.T) {
	src, err := os.ReadFile("quota.go")
	if err != nil {
		t.Fatalf("read quota.go: %v", err)
	}
	body := string(src)

	fn := strings.Index(body, "func (q *PostgresQuota) CheckAndConsume(")
	if fn < 0 {
		t.Fatal("CheckAndConsume not found; the scan is broken")
	}
	scope := body[fn:]
	if end := strings.Index(scope, "\nfunc "); end > 0 {
		scope = scope[:end]
	}

	lockAt := strings.Index(scope, "pg_advisory_xact_lock")
	if lockAt < 0 {
		t.Fatal("CheckAndConsume no longer takes a per-tenant advisory lock; " +
			"concurrent calls with different kinds can both pass the cap")
	}
	upsertAt := strings.Index(scope, "INSERT INTO tenant_ai_usage")
	if upsertAt < 0 {
		t.Fatal("the usage upsert is gone; re-check what this test is protecting")
	}
	if lockAt > upsertAt {
		t.Error("the advisory lock is taken AFTER the upsert; it must precede " +
			"the read-modify-write or it serializes nothing")
	}

	// The lock must be transaction-scoped. pg_advisory_lock (session-scoped)
	// would leak across pooled connections and never be released.
	if strings.Contains(scope, "pg_advisory_lock(") {
		t.Error("session-scoped advisory lock used; pooled connections would never release it")
	}

	// And it must key on the TENANT. A constant key would serialize every
	// tenant in the deployment behind one another.
	//
	// Scoped to the lock CALL, not the whole function: `tenantID` appears all
	// over CheckAndConsume (resolveTier, the upsert args, the compensating
	// update), so a function-wide Contains check can never fail and proves
	// nothing — it passed happily when the lock key was replaced by a literal.
	lockCall := scope[lockAt:]
	if end := strings.Index(lockCall, "err != nil"); end > 0 {
		lockCall = lockCall[:end]
	}
	if !strings.Contains(lockCall, "hashtext($2)") {
		t.Error("the advisory lock does not hash a bound parameter")
	}
	if !strings.Contains(lockCall, "tenantID") {
		t.Errorf("the advisory lock is not keyed on the tenant id: %q", lockCall)
	}
}

// TestAdvisoryLockNamespaceIsFixed guards the guard: a namespace that moved
// would silently stop serializing against locks already held elsewhere.
func TestAdvisoryLockNamespaceIsFixed(t *testing.T) {
	if advisoryLockNamespace == 0 {
		t.Fatal("advisoryLockNamespace must be a fixed non-zero constant")
	}
}
