package views

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
)

// readerDB connects as the role this Reader actually runs as: postwave_ops.
//
// It used DATABASE_URL, which is postwave_app — a role with no grants on the
// ops views or the ops_* functions, so every test here failed with "permission
// denied for function ops_billing_by_tenant" and friends. That is not a defect
// in the Reader; it was being exercised as the wrong principal.
//
// Mirrors internal/ops's restrictedOpsPool: connect with the fixture
// administrator and SET ROLE on every physical connection. Migration 1700 keeps
// postwave_ops NOLOGIN by design, so SET ROLE is how its grants and RLS are
// tested without inventing a password.
func readerDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if url == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL; the ops views are granted to " +
			"postwave_ops, which is NOLOGIN and reachable only via SET ROLE")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse admin DSN: %v", err)
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, execErr := conn.Exec(ctx, "SET ROLE postwave_ops")
		return execErr
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping as postwave_ops: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestListTenants_ReturnsCrossTenantRows(t *testing.T) {
	pool := readerDB(t)
	r := &Reader{Pool: pool}
	rows, err := r.ListTenants(context.Background(), "", 50)
	if err != nil {
		t.Fatalf("ListTenants: %v", err)
	}
	for _, row := range rows {
		if row.TenantID == "" {
			t.Fatal("every directory row must carry tenant_id")
		}
		if row.Health == "" {
			t.Fatalf("row %s has no derived health", row.TenantID)
		}
	}
}

// adminDB is the FIXTURE pool: the administrator, no SET ROLE.
//
// The ops console is read-mostly — postwave_ops can read the ops_* views and
// functions but cannot write ops_incident_updates, as one of these tests says
// in its own comment. Seeding therefore needs the administrator while the
// Reader under test stays on postwave_ops, which is the whole point of
// readerDB. One pool for both made the fixture the thing being permission-
// tested instead of the Reader.
func adminDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if url == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL for ops view fixtures")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
