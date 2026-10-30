package migrationrunner

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A migration that turns on FORCE ROW LEVEL SECURITY and then INSERTs into the
// same table requires the MIGRATOR to bypass RLS, because FORCE subjects the
// table owner too. That is a superuser dependency bought for the price of one
// seed row, and it is invisible locally: replays are normally run by a
// superuser, which bypasses RLS including FORCE.
//
// 0348_archive_activitypub_federation had exactly this shape. Reproduced as a
// non-superuser owner:
//
//	ERROR: new row violates row-level security policy
//	       for table "activitypub_delivery_worker_state"
//
// The fix is to seed BEFORE enabling RLS -- identical end state, no privilege
// needed. This test keeps the ordering from drifting back and catches new
// migrations that adopt the same shape.
func TestForcedRLSTablesAreSeededBeforeRLSIsEnabled(t *testing.T) {
	dir := migrationsDirForTest(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}

	// Pre-existing sites, all ALREADY APPLIED everywhere. Each would need its
	// own reviewed entry in checksum-supersessions.json (whose `review.owner`
	// is release-engineering-and-database-owner), and none is reachable in
	// practice today because migration 1738 independently requires a superuser
	// migrator -- which bypasses RLS including FORCE. They are listed, not
	// silently skipped, so the outstanding set is visible and this guard still
	// protects NEW migrations. Removing an entry after fixing its file is the
	// intended workflow.
	knownPreExisting := map[string]bool{
		"0048_campaign_templates.sql":                   true,
		"0247_subscription_types.sql":                   true,
		"1757_subscriber_dedupe_discovery_contract.sql": true,
		"1761_subscriber_import_consent_contract.sql":   true,
		"1762_subscriber_pii_durable_coverage.sql":      true,
		"1966_canonical_inbound_reply_convergence.sql":  true,
	}

	forceRE := regexp.MustCompile(`(?i)ALTER\s+TABLE\s+(\w+)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY`)
	checked := 0
	knownHit := map[string]bool{}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		sql := stripCommentsForSeedScan(string(raw))
		for _, m := range forceRE.FindAllStringSubmatchIndex(sql, -1) {
			table := sql[m[2]:m[3]]
			checked++
			// Any INSERT into that table AFTER the FORCE statement runs with
			// the owner already subject to RLS.
			after := sql[m[1]:]
			insertRE := regexp.MustCompile(`(?is)INSERT\s+INTO\s+` + regexp.QuoteMeta(table) + `\b`)
			if insertRE.MatchString(after) {
				if knownPreExisting[e.Name()] {
					knownHit[e.Name()] = true
					continue
				}
				t.Errorf(
					"%s: INSERT INTO %s appears AFTER `FORCE ROW LEVEL SECURITY`; "+
						"move the seed before ENABLE/FORCE so the migrator needs no RLS bypass",
					e.Name(), table,
				)
			}
		}
	}

	// Vacuity floor: if the regex stops matching, the scan above proves nothing.
	if checked == 0 {
		t.Fatal("found no FORCE ROW LEVEL SECURITY statements; the scan matched nothing")
	}
	// Second floor: a stale allowlist quietly widens what this guard permits.
	for name := range knownPreExisting {
		if !knownHit[name] {
			t.Errorf(
				"%s is on the known pre-existing list but no longer matches; "+
					"delete its entry so the allowlist cannot drift", name)
		}
	}
	t.Logf("checked %d FORCE ROW LEVEL SECURITY statements; %d known pre-existing files",
		checked, len(knownHit))
}

func stripCommentsForSeedScan(s string) string {
	s = regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(s, "")
	return regexp.MustCompile(`--[^\n]*`).ReplaceAllString(s, "")
}

func migrationsDirForTest(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{
		filepath.Join("..", "..", "..", "..", "infra", "migrations"),
		filepath.Join("..", "..", "..", "infra", "migrations"),
	} {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	t.Fatal("could not locate infra/migrations")
	return ""
}
