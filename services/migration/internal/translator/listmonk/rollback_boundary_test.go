package listmonk

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestCampaignEventRollbackKeepsItsDefinerBoundary protects an exception that
// looks like an oversight.
//
// validateTrackedPostgresDestinationTx compares a SHA-256 fingerprint of the
// destination row against the recorded after-image and refuses the rollback if
// they differ — for every tracked resource EXCEPT ResourceCampaignEvent, which
// returns early after only checking that an after-image exists.
//
// That early return is safe for one reason: the campaign-event rollback does
// not issue a bare DELETE like its four siblings. It calls
// campaign_report_projection_rollback_delete, a purpose-scoped SECURITY
// DEFINER function that is STRICTER than the generic preflight — it locks the
// ledger row and the report rows FOR UPDATE, requires
// destination_metadata->>'operation' = 'created' so it can only remove rows the
// import itself created, rejects a request replay by parameter fingerprint,
// refuses an id ambiguous across partitions, and recomputes the same
// destination-after digest before tombstoning.
//
// The preflight cannot do that work itself, and the reason is a privilege
// boundary rather than convenience: running the generic SELECT ... FOR UPDATE
// would require granting postwave_app UPDATE on the report table, which is
// exactly what the definer function exists to avoid.
//
// So two things must stay true together, and neither is obvious from either
// side alone:
//
//   - the preflight may skip the fingerprint check for this resource ONLY
//     while the rollback routes through the definer function;
//   - if anyone "simplifies" that call to a DELETE to match the siblings, the
//     content check disappears entirely and a rollback would remove report
//     rows that changed after the import.
func TestCampaignEventRollbackKeepsItsDefinerBoundary(t *testing.T) {
	src, err := os.ReadFile("import_state.go")
	if err != nil {
		t.Fatalf("read import_state.go: %v", err)
	}
	text := string(src)

	// Scope to the function that ISSUES the rollback statement. There are two
	// `case ResourceCampaignEvent:` branches in this file — the other one is in
	// trackedPostgresDestinationSnapshotQuery — and an unscoped match finds the
	// wrong one and reports a defect that is not there.
	deleteFn := regexp.MustCompile(
		`func deleteTrackedDestinationTx\([\s\S]*?\n}`,
	).FindString(text)
	if deleteFn == "" {
		t.Fatal("deleteTrackedDestinationTx not found; the scan is broken")
	}
	branch := regexp.MustCompile(
		`case ResourceCampaignEvent:([\s\S]*?)\n\tcase `,
	).FindStringSubmatch(deleteFn)
	if branch == nil {
		t.Fatal("ResourceCampaignEvent rollback branch not found; the scan is broken")
	}
	body := branch[1]

	if !strings.Contains(body, "campaign_report_projection_rollback_delete") {
		t.Error(
			"campaign-event rollback no longer calls the SECURITY DEFINER function — " +
				"the preflight skips the destination fingerprint check for this " +
				"resource, so nothing would verify the row is unchanged",
		)
	}
	if regexp.MustCompile(`DELETE\s+FROM\s+campaign_report_events`).MatchString(body) {
		t.Error(
			"campaign-event rollback issues a bare DELETE; that bypasses the row " +
				"locks, the created-only ownership check and the after-image digest",
		)
	}

	// And the preflight's early return must still be scoped to this one
	// resource — widening it would silently drop the check for others.
	preflight := regexp.MustCompile(
		`func validateTrackedPostgresDestinationTx\([\s\S]*?\n}`,
	).FindString(text)
	if preflight == "" {
		t.Fatal("validateTrackedPostgresDestinationTx not found")
	}
	if !strings.Contains(preflight, "res.ResourceType == ResourceCampaignEvent") {
		t.Error("the preflight exception is no longer scoped to ResourceCampaignEvent")
	}
	if !strings.Contains(preflight, "actual != expected") {
		t.Error(
			"the generic preflight no longer compares the destination fingerprint; " +
				"a rollback could remove rows that changed after import",
		)
	}
}

// TestEveryTrackedRollbackRefusesOnDrift states the property the whole rollback
// rests on: it must fail closed. A rollback that proceeds over changed
// destination state deletes a tenant's real data under the label of undoing an
// import, which is worse than leaving the import in place.
func TestEveryTrackedRollbackRefusesOnDrift(t *testing.T) {
	for _, file := range []string{"import_state.go", "subscriber_store.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		text := string(src)

		refusals := strings.Count(text, "ErrRollbackConflict")
		if refusals == 0 {
			t.Errorf("%s no longer refuses any rollback on conflict", file)
		}

		// Every ErrRollbackConflict must be RETURNED, not logged and stepped
		// over. A wrapped-and-continued conflict is the same as no check.
		for _, line := range strings.Split(text, "\n") {
			if !strings.Contains(line, "ErrRollbackConflict") {
				continue
			}
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") ||
				strings.HasPrefix(trimmed, "ErrRollbackConflict") ||
				strings.Contains(trimmed, "errors.New") {
				continue
			}
			if !strings.Contains(trimmed, "return") &&
				!strings.Contains(trimmed, "fmt.Errorf") {
				t.Errorf("%s: ErrRollbackConflict is referenced without returning: %s", file, trimmed)
			}
		}
	}
}
