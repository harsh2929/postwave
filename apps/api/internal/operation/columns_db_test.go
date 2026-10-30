// SPDX-License-Identifier: AGPL-3.0-only

package operation

import (
	"context"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A declared column that does not exist is a view that returns nothing.
//
// `FamilyColumns` is hand-written, and every entry is interpolated straight
// into SQL. A typo does not fail a build or a unit test — it fails at request
// time, for one family, as an error the aggregator deliberately swallows so one
// broken table cannot blank the whole page. The result is a family that
// silently stops appearing, which is indistinguishable from a family with
// nothing running.
//
// So the declaration is checked against the live schema, the same way the state
// map already is. Anything else makes the column map a comment.

func columnsPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping operation column test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func liveColumns(t *testing.T, pool *db.Pool, table string) map[string]bool {
	t.Helper()
	ctx := context.Background()
	// pg_attribute, not information_schema.columns. The latter shows only
	// tables the connected role holds SOME privilege on, and `postwave_app` has
	// none at all on `ops_action_runs` — so information_schema reported that
	// table as nonexistent, which is a different and much more alarming fact
	// than "the API cannot read it". Reading the catalog keeps the two apart.
	rows, err := pool.Query(ctx, `
SELECT a.attname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relname = $1`, table)
	if err != nil {
		t.Fatalf("read columns for %s: %v", table, err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[name] = true
	}
	return out
}

func TestEveryRegisteredFamilyDeclaresItsColumns(t *testing.T) {
	if len(Families) == 0 {
		t.Fatal("no families registered; this test would prove nothing")
	}
	for _, f := range Families {
		if _, ok := FamilyColumns[f.Table]; !ok {
			t.Errorf("%s is registered but has no FamilyColumns entry, so the shared "+
				"operations view cannot read it and it is invisible there", f.Table)
		}
	}
	for table := range FamilyColumns {
		found := false
		for _, f := range Families {
			if f.Table == table {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("FamilyColumns names %s, which is not a registered family — a "+
				"stale entry that will quietly stop matching anything", table)
		}
	}
}

func TestDeclaredColumnsExistAndAbsencesAreReal(t *testing.T) {
	pool := columnsPool(t)
	checked := 0
	for _, f := range Families {
		cols, ok := FamilyColumns[f.Table]
		if !ok {
			continue
		}
		live := liveColumns(t, pool, f.Table)
		if len(live) == 0 {
			t.Errorf("%s: table not found in the live schema", f.Table)
			continue
		}
		checked++

		// Every name we claim must be there.
		for label, name := range map[string]string{
			"TenantID": cols.TenantID, "CreatedAt": cols.CreatedAt,
			"StartedAt": cols.StartedAt, "FinishedAt": cols.FinishedAt, "Error": cols.Error,
		} {
			if name == "" {
				continue
			}
			if !live[name] {
				t.Errorf("%s.%s declares column %q, which does not exist. The "+
					"aggregator swallows this family's query error, so the only "+
					"symptom is that %s stops appearing in the shared view.",
					f.Table, label, name, f.Kind)
			}
		}

		// And every absence we claim must be a real absence. A blank
		// FinishedAt on a table that HAS completed_at is a family whose runs
		// look permanently unfinished — the opposite failure, equally silent.
		if cols.TenantID == "" && live["tenant_id"] {
			t.Errorf("%s is declared not tenant-scoped but has a tenant_id column; "+
				"it is being excluded from the tenant view for no reason", f.Table)
		}
		for label, candidates := range map[string][]string{
			"CreatedAt":  {"created_at"},
			"StartedAt":  {"started_at"},
			"FinishedAt": {"finished_at", "completed_at"},
			// last_error_code is the fourth spelling, found by registering a
			// family that used it: the guard had three, so a table using a name
			// it did not know would have passed as "keeps no failure text" —
			// the exact silent absence this check exists to catch.
			"Error": {"error", "error_message", "last_error", "last_error_code"},
		} {
			declared := map[string]string{
				"CreatedAt": cols.CreatedAt, "StartedAt": cols.StartedAt,
				"FinishedAt": cols.FinishedAt, "Error": cols.Error,
			}[label]
			if declared != "" {
				continue
			}
			for _, candidate := range candidates {
				if live[candidate] {
					t.Errorf("%s.%s is declared absent, but the table has %q. That "+
						"column's facts are dropped from the shared view for every "+
						"run of this family.", f.Table, label, candidate)
				}
			}
		}
	}
	if checked < 15 {
		t.Fatalf("only %d families checked against the live schema; the registry "+
			"cannot be that small, so this is measuring almost nothing", checked)
	}
}

// `ops_action_runs` is not merely un-scoped, it is unreadable: the API's role
// holds no privilege on it whatsoever. That is the ops console's boundary
// working as designed, and it is a second, independent reason the family cannot
// appear in a tenant view — worth pinning, because a future GRANT would make
// the aggregator's exclusion the only thing standing between an operator's
// action log and a tenant's dashboard.
func TestTheApiRoleCannotEvenReadTheOpsActionLog(t *testing.T) {
	pool := columnsPool(t)
	ctx := context.Background()
	var n int
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'ops_action_runs'`).Scan(&n); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if n != 0 {
		t.Errorf("the API role can now see ops_action_runs (%d columns visible). "+
			"If it has been granted access, the tenant operations view's exclusion "+
			"is the only thing keeping the ops console's action log out of a "+
			"customer dashboard.", n)
	}
}

// The three known non-tenant families are the reason the aggregator has an
// exclusion at all. Pinned by name so that if either gains a tenant_id, this
// says so rather than leaving them silently missing from the tenant view.
func TestTheNonTenantFamiliesAreExactlyTheKnownThree(t *testing.T) {
	var global []string
	for _, f := range Families {
		if !FamilyColumns[f.Table].TenantScoped() {
			global = append(global, f.Table)
		}
	}
	sort.Strings(global)
	// Now THREE. Consent reconciliation sweeps every tenant in a single pass and
	// has no tenant_id at all, so it cannot appear in a tenant-scoped view —
	// stated here rather than discovered later as a family that is simply missing.
	// Now FIVE. affiliate_payouts and campaign_template_preview_assets are
	// platform-scoped — neither table has a tenant_id — so both are registered
	// for their state mapping and both are absent from the tenant view. Naming
	// them here is the "stated out loud" this test exists to force.
	want := []string{
		"affiliate_payouts", "campaign_template_preview_assets", "ops_action_runs",
		"subscriber_email_consent_reconciliation_runs", "webmention_parser_runs",
	}
	if strings.Join(global, ",") != strings.Join(want, ",") {
		t.Fatalf("non-tenant families = %v, want %v. A family leaving this list "+
			"must be added to the tenant view; a family joining it disappears from "+
			"that view, and both changes are worth stating out loud.", global, want)
	}
	// And the tenant view must actually be most of the registry — an exclusion
	// that quietly grew to cover everything would leave an empty view.
	if len(TenantFamilies()) != len(Families)-len(want) {
		t.Fatalf("TenantFamilies() = %d of %d registered; the split does not add up",
			len(TenantFamilies()), len(Families))
	}
}

// Why the aggregator's explicit tenant filter is belt, not braces.
//
// Neutering the `WHERE tenant_id = $1` in `familySelect` does NOT make the
// cross-tenant test fail, and that is correct rather than alarming: every
// tenant-scoped family carries FORCE ROW LEVEL SECURITY, so Postgres filters
// the rows whatever the query says. The mutation stopped being a defect.
//
// It is only correct while that stays true of ALL of them. One family shipped
// without RLS and the WHERE clause becomes the single thing standing between
// two tenants' operation lists — with no test able to tell, because the other
// nineteen would still pass. So the property is asserted directly, per family,
// instead of being inferred from a mutation that happens to be survivable.
func TestEveryTenantFamilyIsRowLevelSecured(t *testing.T) {
	pool := columnsPool(t)
	ctx := context.Background()
	families := TenantFamilies()
	if len(families) < 15 {
		t.Fatalf("only %d tenant families; this would prove almost nothing", len(families))
	}
	for _, f := range families {
		var enabled, forced bool
		if err := pool.QueryRow(ctx, `
SELECT c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = $1`, f.Table).Scan(&enabled, &forced); err != nil {
			t.Errorf("%s: %v", f.Table, err)
			continue
		}
		if !enabled {
			t.Errorf("%s has NO row-level security. It is in a cross-family view "+
				"whose only other tenant filter is a WHERE clause in generated SQL; "+
				"one wrong column name there and this family's rows go to every "+
				"tenant.", f.Table)
		}
		if !forced {
			// Without FORCE, the table owner bypasses its own policies. Migrations
			// run as the owner, and so would any future job that reuses that role.
			t.Errorf("%s enables row-level security but does not FORCE it, so the "+
				"owning role bypasses the policy entirely", f.Table)
		}
	}
}
