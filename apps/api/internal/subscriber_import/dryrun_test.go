// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-105 dry-run coverage. dryRunValidate is pure (body + mapping +
// existing-email set + an optional validator) so the full classification
// matrix — create / update / skip / fail, in-file dedupe, on_existing
// behaviour, the detail cap — is locked here without a DB. The
// nothing-is-written guarantee is structural: dryRunValidate takes no
// pool and issues no Exec, so it CANNOT write.

package subscriber_import

import (
	"context"
	"strings"
	"testing"

	migratecsv "github.com/postwave/migrate/csv"
)

func dryRunMapping() migratecsv.Mapping {
	return migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "name", Kind: migratecsv.KindName},
		{Index: 2, Name: "plan", Kind: migratecsv.KindCustom, CustomKey: "plan"},
	}}
}

// TestDryRunValidate_ClassifiesOutcomes — the core matrix. new@ → create,
// existing@ (on_existing=skip) → skip, a malformed email → fail, an
// in-file dup → skip+file_dupe.
func TestDryRunValidate_ClassifiesOutcomes(t *testing.T) {
	csvBody := "email,name,plan\n" +
		"new@example.com,New,pro\n" +
		"old@example.com,Old,free\n" + // exists → skip
		"new@example.com,Dup,pro\n" + // in-file dup → skip
		"not-an-email,Bad,pro\n" // fail
	job := &dryRunJob{Mapping: dryRunMapping(), OnExisting: "skip"}
	existing := map[string]struct{}{"old@example.com": {}}

	res, err := dryRunValidate(context.Background(), []byte(csvBody), job, existing, nil, "tenant-1")
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if res.RowsTotal != 4 {
		t.Errorf("rows_total = %d, want 4", res.RowsTotal)
	}
	if res.WouldCreate != 1 {
		t.Errorf("would_create = %d, want 1", res.WouldCreate)
	}
	if res.WouldSkip != 2 { // existing + in-file dup
		t.Errorf("would_skip = %d, want 2", res.WouldSkip)
	}
	if res.WouldFail != 1 {
		t.Errorf("would_fail = %d, want 1", res.WouldFail)
	}
	if res.FileDupes != 1 {
		t.Errorf("file_dupes = %d, want 1", res.FileDupes)
	}
	if res.ValidatedAt == "" {
		t.Error("validated_at must be stamped")
	}
}

// TestDryRunValidate_OnExistingUpdate — an existing subscriber becomes an
// update (not a skip) when on_existing=update.
func TestDryRunValidate_OnExistingUpdate(t *testing.T) {
	csvBody := "email,name,plan\nold@example.com,Old,free\n"
	job := &dryRunJob{Mapping: dryRunMapping(), OnExisting: "update"}
	existing := map[string]struct{}{"old@example.com": {}}

	res, _ := dryRunValidate(context.Background(), []byte(csvBody), job, existing, nil, "tenant-1")
	if res.WouldUpdate != 1 || res.WouldSkip != 0 {
		t.Errorf("update strategy: update=%d skip=%d, want 1/0", res.WouldUpdate, res.WouldSkip)
	}
}

// TestDryRunValidate_OnExistingError — on_existing=error makes a collision
// a failure in the preview, mirroring the live INSERT throwing.
func TestDryRunValidate_OnExistingError(t *testing.T) {
	csvBody := "email,name,plan\nold@example.com,Old,free\n"
	job := &dryRunJob{Mapping: dryRunMapping(), OnExisting: "error"}
	existing := map[string]struct{}{"old@example.com": {}}

	res, _ := dryRunValidate(context.Background(), []byte(csvBody), job, existing, nil, "tenant-1")
	if res.WouldFail != 1 {
		t.Errorf("error strategy collision should fail: %d", res.WouldFail)
	}
	if len(res.Rows) != 1 || res.Rows[0].Outcome != outcomeFail {
		t.Errorf("detail outcome = %+v, want fail", res.Rows)
	}
}

// TestDryRunValidate_AllNewCreate — a clean file of brand-new emails is
// all creates.
func TestDryRunValidate_AllNewCreate(t *testing.T) {
	csvBody := "email,name,plan\na@x.com,A,pro\nb@x.com,B,free\nc@x.com,C,pro\n"
	job := &dryRunJob{Mapping: dryRunMapping(), OnExisting: "skip"}
	res, _ := dryRunValidate(context.Background(), []byte(csvBody), job, map[string]struct{}{}, nil, "tenant-1")
	if res.WouldCreate != 3 || res.RowsTotal != 3 {
		t.Errorf("all-new: create=%d total=%d", res.WouldCreate, res.RowsTotal)
	}
}

// TestDryRunValidate_DetailRows — each detail carries the row number,
// email, and outcome so the wizard can render a table.
func TestDryRunValidate_DetailRows(t *testing.T) {
	csvBody := "email,name,plan\na@x.com,A,pro\nbad,B,pro\n"
	job := &dryRunJob{Mapping: dryRunMapping(), OnExisting: "skip"}
	res, _ := dryRunValidate(context.Background(), []byte(csvBody), job, map[string]struct{}{}, nil, "tenant-1")
	if len(res.Rows) != 2 {
		t.Fatalf("want 2 detail rows, got %d", len(res.Rows))
	}
	if res.Rows[0].RowNumber != 1 || res.Rows[0].Outcome != outcomeCreate {
		t.Errorf("row 1 detail: %+v", res.Rows[0])
	}
	if res.Rows[1].RowNumber != 2 || res.Rows[1].Outcome != outcomeFail || res.Rows[1].Error == "" {
		t.Errorf("row 2 detail should be a fail with an error: %+v", res.Rows[1])
	}
}

// TestDryRunValidate_DetailCapPrioritisesFailures — past the detail cap,
// failing rows evict successes so the operator always sees the errors.
func TestDryRunValidate_DetailCapPrioritisesFailures(t *testing.T) {
	var b strings.Builder
	b.WriteString("email,name,plan\n")
	// maxDryRunRowDetails successes, then one failure.
	for i := 0; i < maxDryRunRowDetails; i++ {
		b.WriteString("ok")
		b.WriteString(itoaTest(i))
		b.WriteString("@x.com,Name,pro\n")
	}
	b.WriteString("bad-email,Name,pro\n")
	job := &dryRunJob{Mapping: dryRunMapping(), OnExisting: "skip"}
	res, _ := dryRunValidate(context.Background(), []byte(b.String()), job, map[string]struct{}{}, nil, "tenant-1")

	if !res.DetailCapped {
		t.Fatal("expected detail_capped=true past the cap")
	}
	if len(res.Rows) != maxDryRunRowDetails {
		t.Fatalf("detail list should stay capped at %d, got %d", maxDryRunRowDetails, len(res.Rows))
	}
	// The failure must have evicted a success into the detail list.
	failSeen := false
	for _, row := range res.Rows {
		if row.Outcome == outcomeFail {
			failSeen = true
			break
		}
	}
	if !failSeen {
		t.Error("a failing row must be retained in the capped detail list")
	}
	// Tallies still cover every row.
	if res.RowsTotal != int64(maxDryRunRowDetails+1) {
		t.Errorf("rows_total = %d, want %d", res.RowsTotal, maxDryRunRowDetails+1)
	}
	if res.WouldFail != 1 {
		t.Errorf("would_fail = %d, want 1", res.WouldFail)
	}
}

// TestDryRunUniqueEmails — header skipped, dups removed, cap honoured.
func TestDryRunUniqueEmails(t *testing.T) {
	csvBody := "email,name\nA@x.com,A\nb@x.com,B\na@x.com,Dup\n,Empty\n"
	got := dryRunUniqueEmails([]byte(csvBody), 0, 100)
	if len(got) != 2 {
		t.Fatalf("unique emails = %v, want 2", got)
	}
	// Lowercased.
	if got[0] != "a@x.com" || got[1] != "b@x.com" {
		t.Errorf("emails = %v", got)
	}
	// Cap honoured.
	capped := dryRunUniqueEmails([]byte(csvBody), 0, 1)
	if len(capped) != 1 {
		t.Errorf("cap=1 → %v", capped)
	}
}

// itoaTest avoids pulling strconv just for the cap test.
func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
