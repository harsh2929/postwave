// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testPool uses the explicit admin fixture DSN. TEST_DATABASE_URL is reserved
// for the unprivileged postwave_app integration path so both role classes can
// run in one complete API test invocation.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL to the migrated fixture database")
	}

	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	for _, table := range []string{"ops_check_results", "stripe_webhook_attempts"} {
		var reg *string
		if err := pool.QueryRow(context.Background(),
			`SELECT to_regclass($1)::text`, table).Scan(&reg); err != nil {
			t.Fatalf("checking for %s: %v", table, err)
		}
		if reg == nil {
			t.Fatalf("table %q missing: apply infra/migrations/1700_ops_console.sql (and 0089_status_and_retry.sql if needed)", table)
		}
	}

	return pool
}
