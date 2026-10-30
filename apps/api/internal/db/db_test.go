package db

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestWithTenant_SetsAppTenantID verifies that WithTenant binds
// `app.tenant_id` to the chosen value for the lifetime of the tx.
//
// Skips silently when DATABASE_URL is unset so CI without a database is
// not blocked.
func TestWithTenant_SetsAppTenantID(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// Stable hard-coded UUID; the test does not persist anything (tx is
	// rolled back), so collisions across runs don't matter.
	const tenantID = "00000000-0000-0000-0000-0000deadbeef"

	tx, err := WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var got string
	if err := tx.QueryRow(ctx, "SELECT current_setting('app.tenant_id', true)").Scan(&got); err != nil {
		t.Fatalf("read setting: %v", err)
	}
	if got != tenantID {
		t.Fatalf("app.tenant_id = %q, want %q", got, tenantID)
	}
}

// TestWithTenant_RejectsEmpty makes sure we don't silently open a tx with
// no tenant scoping — that would defeat RLS.
func TestWithTenant_RejectsEmpty(t *testing.T) {
	if _, err := WithTenant(context.Background(), nil, ""); err == nil {
		t.Fatal("expected error for empty tenant id")
	}
}

// TestWithWorkerScope_SetsOutboxWorker verifies that WithWorkerScope binds
// `app.outbox_worker = 'true'` for the lifetime of the tx, and that the
// scope is gone after Rollback (i.e. it was SET LOCAL, not SET session).
//
// Skips when DATABASE_URL is unset so CI without a database is not blocked.
func TestWithWorkerScope_SetsOutboxWorker(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	tx, err := WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("WithWorkerScope: %v", err)
	}

	var got string
	if err := tx.QueryRow(ctx, "SELECT current_setting('app.outbox_worker', true)").Scan(&got); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read setting: %v", err)
	}
	if got != "true" {
		_ = tx.Rollback(ctx)
		t.Fatalf("app.outbox_worker = %q, want %q", got, "true")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback: %v", err)
	}

	// After rollback the scope must be gone on the *next* checkout —
	// AfterRelease + SET LOCAL together guarantee that.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var after *string
	if err := conn.QueryRow(ctx, "SELECT current_setting('app.outbox_worker', true)").Scan(&after); err != nil {
		t.Fatalf("read setting after release: %v", err)
	}
	if after != nil && *after == "true" {
		t.Fatalf("app.outbox_worker leaked across release: got %q, want empty/default", *after)
	}
}

// TestTransactionLocalScopeDoesNotSurviveAutoCommit pins the PostgreSQL
// behavior behind the raw-connection regression guard: set_config(..., true)
// on a pooled connection succeeds, but its value belongs only to that one
// implicit transaction and is gone before the next statement.
func TestTransactionLocalScopeDoesNotSurviveAutoCommit(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		t.Fatalf("set transaction-local scope: %v", err)
	}
	var got *string
	if err := conn.QueryRow(ctx, "SELECT current_setting('app.outbox_worker', true)").Scan(&got); err != nil {
		t.Fatalf("read setting after auto-commit: %v", err)
	}
	if got != nil && *got == "true" {
		t.Fatalf("transaction-local scope unexpectedly survived auto-commit: %q", *got)
	}
}

// TestWithWorkerScope_RejectsNilPool guards against a nil-pool deref crash.
func TestWithWorkerScope_RejectsNilPool(t *testing.T) {
	if _, err := WithWorkerScope(context.Background(), nil); err == nil {
		t.Fatal("expected error for nil pool")
	}
}

func TestPrivilegedRoleBypassIsLocalOnly(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}

	allowed, err := privilegedRoleBypassAllowed(env(map[string]string{
		"POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE": "1",
		"POSTWAVE_ENV":                      "development",
	}))
	if err != nil || !allowed {
		t.Fatalf("local diagnostic bypass = (%v, %v), want (true, nil)", allowed, err)
	}

	for _, protected := range []string{"production", "prod", "staging", "stage"} {
		t.Run(protected, func(t *testing.T) {
			allowed, err := privilegedRoleBypassAllowed(env(map[string]string{
				"POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE": "1",
				"POSTWAVE_ENV":                      protected,
			}))
			if err == nil || allowed {
				t.Fatalf("protected bypass = (%v, %v), want (false, error)", allowed, err)
			}
		})
	}
}
