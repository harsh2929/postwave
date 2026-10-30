// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const adminTestDatabaseEnv = "POSTWAVE_TEST_ADMIN_DATABASE_URL"

// testPool returns an admin fixture pool. Production behavior still uses the
// restricted postwave_ops role; TestOpsRole_AuditLogPlatformLaneOnly creates a
// SET ROLE pool to prove that boundary. Keeping this DSN separate from the
// unprivileged TEST_DATABASE_URL lets the complete API suite exercise both.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := adminTestDSN(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	var reg *string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_regclass('ops_check_results')::text`).Scan(&reg); err != nil {
		t.Fatalf("checking for ops_check_results: %v", err)
	}
	if reg == nil {
		t.Skip("ops tables missing: apply with the canonical migrator")
	}

	return pool
}

func adminTestDSN(t *testing.T) string {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv(adminTestDatabaseEnv))
	if dsn == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL to the migrated fixture database")
	}
	return dsn
}

// restrictedOpsPool connects with the fixture administrator and immediately
// assumes postwave_ops on every physical connection. Migration 1700 keeps the
// role NOLOGIN by design; SET ROLE tests its grants/RLS without inventing a
// repository password or mutating the role in a fresh database.
func restrictedOpsPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	cfg, configErr := pgxpool.ParseConfig(adminTestDSN(t))
	if configErr != nil {
		t.Fatalf("parse admin fixture DSN: %v", configErr)
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET ROLE postwave_ops")
		return err
	}
	pool, configErr := pgxpool.NewWithConfig(context.Background(), cfg)
	if configErr != nil {
		t.Fatalf("connect with postwave_ops role: %v", configErr)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Fatalf("ping with postwave_ops role: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// truncate wipes the given ops tables between tests. It refuses to touch
// any table that is not an ops test table this package alone uses.
//
// Only this package's tests write the tables listed, and they run one at a
// time, so a TRUNCATE here cannot remove a row another package's test is
// asserting on. ops_push_state is not in the list: internal/ops/checks uses
// it too, so it is cleared only under pushstatetest.Lock (see pushTestPool).
func truncate(t *testing.T, pool *pgxpool.Pool, tables ...string) {
	t.Helper()

	allowed := map[string]bool{
		"ops_check_results": true,
		"ops_check_history": true,
		"ops_manual_log":    true,
		"ops_digest_state":  true,
	}
	for _, tbl := range tables {
		if !allowed[tbl] {
			t.Fatalf("truncate: %q is not an ops test table", tbl)
		}
	}
	if len(tables) == 0 {
		return
	}
	if _, err := pool.Exec(context.Background(),
		fmt.Sprintf("TRUNCATE %s", strings.Join(tables, ", "))); err != nil {
		t.Fatalf("truncate %v: %v", tables, err)
	}
}
