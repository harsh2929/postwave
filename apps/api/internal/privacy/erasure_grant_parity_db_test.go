// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"context"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Every table erasure deletes from must be deletable by the role that runs it.
//
// Erasure removes a subscriber's data across a list of tables. All but one
// granted DELETE to `postwave_app`; `subscriber_pii_findings` did not, so an
// erasure request reaching it raised "permission denied" and left behind the
// record of what sensitive data that person had — the exact category the
// request exists to remove.
//
// THE LIST IS READ FROM THE SOURCE, not copied here. A copy drifts: the bug was
// a table list and a grant list maintained separately, and a test that
// duplicates the table list a third time would reproduce the same failure mode.
// Adding a table to erasure without its grant fails this test.
var erasureTablePattern = regexp.MustCompile(`\{"([a-z_]+)", ` + "`" + `DELETE FROM`)

func TestErasureCanDeleteEveryTableItTouches(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping erasure grant parity test")
	}
	source, err := os.ReadFile("erasure.go")
	if err != nil {
		t.Fatalf("read erasure.go: %v", err)
	}
	matches := erasureTablePattern.FindAllStringSubmatch(string(source), -1)
	if len(matches) < 5 {
		// A floor: if the pattern stops matching, "every table is deletable"
		// would be vacuously true over an empty list.
		t.Fatalf("found only %d erasure tables in the source; the scan is not "+
			"reading the list and this check is measuring nothing", len(matches))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	for _, m := range matches {
		table := m[1]
		var allowed bool
		if err := pool.QueryRow(ctx,
			`SELECT has_table_privilege('postwave_app', $1, 'DELETE')`, table).Scan(&allowed); err != nil {
			t.Fatalf("check DELETE on %s: %v", table, err)
		}
		if !allowed {
			t.Errorf("erasure deletes from %s, but postwave_app has no DELETE on "+
				"it. A subject-erasure request fails partway and leaves that "+
				"person's data in place.", table)
		}
	}
}
