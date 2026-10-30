// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Every table the Listmonk import rollback deletes from must be deletable.
//
// The rollback removes each row it created across five tables. Four granted
// DELETE to `postwave_app`; `campaign_report_events` did not, so a rollback
// that reached one raised "permission denied" and left a partially-undone
// import — the single state a rollback exists to prevent.
//
// Asserted as a GROUP rather than one table, because the defect was an odd one
// out: the value is in the parity, and a sixth table added to that rollback
// without its grant should fail here too.
func TestTheImportRollbackCanDeleteEveryTableItTouches(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping rollback grant parity test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	// The tables services/migration's import rollback deletes from.
	rollbackTables := []string{
		"commerce_integrations",
		"campaigns",
		"campaign_report_events",
		"campaign_archive",
		"migration_paid_subscriptions",
	}
	for _, table := range rollbackTables {
		var allowed bool
		if err := pool.QueryRow(ctx,
			`SELECT has_table_privilege('postwave_app', $1, 'DELETE')`, table).Scan(&allowed); err != nil {
			t.Fatalf("check DELETE on %s: %v", table, err)
		}
		if !allowed {
			t.Errorf("the import rollback deletes from %s, but postwave_app — the "+
				"role services/migration connects as — has no DELETE on it. A "+
				"rollback reaching that row fails and leaves the import half undone.",
				table)
		}
	}
}
