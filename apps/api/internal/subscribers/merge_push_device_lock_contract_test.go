// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"os"
	"strings"
	"testing"
)

func TestCanonicalMergeTakesPushAuthorityLeaseBeforeSubscriberRows(t *testing.T) {
	body, err := os.ReadFile("merge_canonical.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	leaseAt := strings.Index(source, "pushauthoritylock.Exclusive(ctx, tx, tenantID)")
	rowsAt := strings.Index(source, "loadMergeSubscribersForUpdate(ctx, tx, tenantID")
	reparentAt := strings.Index(source, "reparentSubscriberSatellites(ctx, tx, tenantID")
	if leaseAt < 0 || rowsAt < 0 || reparentAt < 0 || !(leaseAt < rowsAt && rowsAt < reparentAt) {
		t.Fatalf("canonical merge must acquire the push eligibility lease before subscriber rows and device reparenting: lease=%d rows=%d reparent=%d", leaseAt, rowsAt, reparentAt)
	}

	satellites, err := os.ReadFile("merge_satellites.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(satellites), `"push_devices"`) {
		t.Fatal("lock-order contract is stale: canonical merge no longer reparents push_devices")
	}
}

func TestSubscriberDeletesTakePushAuthorityLeaseBeforeRowLocks(t *testing.T) {
	repoSource := readContractSource(t, "repo.go")
	deleteStart := strings.Index(repoSource, "func (r *Repo) delete(")
	if deleteStart < 0 {
		t.Fatal("single-delete implementation not found")
	}
	deleteSource := repoSource[deleteStart:]
	leaseAt := strings.Index(deleteSource, "pushauthoritylock.Exclusive(ctx, tx, tenantID)")
	rowAt := strings.Index(deleteSource, "getInTxForUpdate(ctx, tx, tenantID, id)")
	if leaseAt < 0 || rowAt < 0 || leaseAt > rowAt {
		t.Fatalf("single delete must acquire push eligibility lease before subscriber row: lease=%d row=%d", leaseAt, rowAt)
	}

	bulkSource := readContractSource(t, "bulk_operations.go")
	bulkStart := strings.Index(bulkSource, "func (d *Deps) BulkDelete(")
	if bulkStart < 0 {
		t.Fatal("bulk-delete implementation not found")
	}
	bulkSource = bulkSource[bulkStart:]
	bulkLeaseAt := strings.Index(bulkSource, "pushauthoritylock.Exclusive(r.Context(), tx, t.ID)")
	bulkRowsAt := strings.Index(bulkSource, "captureBulkDeleteState(r.Context(), tx, t.ID, ids)")
	if bulkLeaseAt < 0 || bulkRowsAt < 0 || bulkLeaseAt > bulkRowsAt {
		t.Fatalf("bulk delete must acquire push eligibility lease before subscriber rows: lease=%d rows=%d", bulkLeaseAt, bulkRowsAt)
	}
}

func readContractSource(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
