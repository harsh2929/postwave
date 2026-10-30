package audit

// Tests for the audit "Request access" flow (desktop-audit gap A14)
// with focus on the API-key flood guard: rows with requested_by IS
// NULL sit outside the pending-per-user partial unique index from
// migration 0382, so CreateAccessRequest pre-checks for an existing
// pending row with the same actor_label and returns it instead of
// inserting a duplicate.
//
// The SQL paths follow the package convention (see trim_test.go):
// they run against a real Postgres when DATABASE_URL is set and the
// audit_access_requests table exists, and skip otherwise.

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NormalizeAccessRequestNote is covered in events_by_id_test.go.

func TestCreateAccessRequest_InputGuards(t *testing.T) {
	ctx := context.Background()
	if _, _, err := CreateAccessRequest(ctx, nil, CreateAccessRequestInput{TenantID: "t"}); err == nil {
		t.Fatal("nil pool must error")
	}
	// Tenant guard runs before any pool use, so a zero-value pool is
	// safe here.
	if _, _, err := CreateAccessRequest(ctx, &pgxpool.Pool{}, CreateAccessRequestInput{}); err == nil {
		t.Fatal("missing tenant must error")
	}
}

// accessRequestsPool returns a pool against DATABASE_URL with the
// audit_access_requests table present; skips otherwise.
func accessRequestsPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed access-request test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgx connect: %v", err)
	}
	t.Cleanup(pool.Close)
	var one int
	if err := pool.QueryRow(context.Background(),
		"SELECT 1 FROM audit_access_requests LIMIT 1").Scan(&one); err != nil &&
		!strings.Contains(err.Error(), "no rows") {
		t.Fatalf("audit_access_requests not queryable (migration 0382 not applied?): %v", err)
	}
	return pool
}

const accessReqTestTenant = "00000000-0000-0000-0000-00000000a14a"

func ensureAccessReqTenant(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	// The tenants INSERT policy is `id = current_setting('app.tenant_id')`, so
	// the seed has to run inside a transaction that names the tenant it is
	// creating. A bare pool Exec leaves the GUC unset, the insert is refused,
	// and the Skipf that used to be here reported that as a PASS.
	tx, txErr := pool.Begin(ctx)
	if txErr != nil {
		t.Fatalf("begin access-request tenant seed: %v", txErr)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, accessReqTestTenant); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("scope access-request tenant seed: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'access-req-test', 'access-req-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, accessReqTestTenant); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit access-request tenant seed: %v", err)
	}
	t.Cleanup(func() {
		// Scoped, like the seed. A bare pool Exec sets no app.tenant_id, so
		// tenant_isolation filtered the DELETE to zero rows and every run left
		// its access requests behind — which the NEXT run then saw as an
		// existing pending row, so the dedupe test's "first" create was not
		// first. Silent, because the cleanup discards its error.
		bg := context.Background()
		cx, cerr := pool.Begin(bg)
		if cerr != nil {
			return
		}
		defer func() { _ = cx.Rollback(bg) }()
		if _, err := cx.Exec(bg, `SELECT set_config('app.tenant_id', $1, true)`, accessReqTestTenant); err != nil {
			return
		}
		_, _ = cx.Exec(bg,
			"DELETE FROM audit_access_requests WHERE tenant_id = $1::uuid", accessReqTestTenant)
		_ = cx.Commit(bg)
	})
}

// TestCreateAccessRequest_APIKeyDedupe — the A14 flood guard. Two
// requests with the same actor_label and no user must collapse onto
// one pending row (created=false on the second, first ask wins); a
// different actor_label still inserts its own row.
func TestCreateAccessRequest_APIKeyDedupe(t *testing.T) {
	pool := accessRequestsPool(t)
	ensureAccessReqTenant(t, pool)
	ctx := context.Background()

	first, created, err := CreateAccessRequest(ctx, pool, CreateAccessRequestInput{
		TenantID:   accessReqTestTenant,
		ActorLabel: "apikey:pk_dedupe_test",
		Note:       "first ask",
	})
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if !created {
		t.Fatalf("first create: created = false, want true")
	}

	second, created, err := CreateAccessRequest(ctx, pool, CreateAccessRequestInput{
		TenantID:   accessReqTestTenant,
		ActorLabel: "apikey:pk_dedupe_test",
		Note:       "button mash",
	})
	if err != nil {
		t.Fatalf("second create: %v", err)
	}
	if created {
		t.Fatal("second create with same actor_label: created = true, want false (dedupe)")
	}
	if second.ID != first.ID {
		t.Fatalf("dedupe returned row %s, want existing row %s", second.ID, first.ID)
	}
	if second.Note != "first ask" {
		t.Fatalf("dedupe note = %q, want the first row's note (first ask wins)", second.Note)
	}

	third, created, err := CreateAccessRequest(ctx, pool, CreateAccessRequestInput{
		TenantID:   accessReqTestTenant,
		ActorLabel: "apikey:pk_other_key",
	})
	if err != nil {
		t.Fatalf("third create: %v", err)
	}
	if !created || third.ID == first.ID {
		t.Fatalf("distinct actor_label must insert its own row (created=%v id=%s)", created, third.ID)
	}
}
