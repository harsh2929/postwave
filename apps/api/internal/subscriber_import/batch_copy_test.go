// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit coverage for the SUB-110 batched COPY → staged-MERGE import path.
// The validation/shaping (prepareBatchRows), COPY-row marshalling
// (copyFromRows) and SQL builders (createStagingSQL / stagedMergeSQL) are
// pure and table-tested with no DB. executeBatchedUpsert is exercised
// against a fake batchTx that records the COPY + Exec calls and returns a
// scripted CommandTag, so the COPY → staging → merge plumbing and the
// imported/skipped counter split are pinned without a live Postgres.

package subscriber_import

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	migratecsv "github.com/postwave/migrate/csv"
)

// --- pure: prepareBatchRows ------------------------------------------

func mappingEmailTags() migratecsv.Mapping {
	return migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "tags", Kind: migratecsv.KindTags},
		{Index: 2, Name: "Plan", Kind: migratecsv.KindCustom, CustomKey: "plan"},
	}}
}

func TestPrepareBatchRows_FiltersAndDedupes(t *testing.T) {
	m := mappingEmailTags()
	seen := map[string]struct{}{}
	rows := [][]string{
		{"Alice@Example.com", "vip,new", "pro"}, // accepted, normalised
		{"   ", "x", "y"},                       // empty email → error
		{"not-an-email", "x", "y"},              // no @ → error
		{"alice@example.com", "again", "free"},  // file-dupe (case-insensitive) → skip
		{"bob@example.com", "", ""},             // accepted, no tags/custom
	}
	got := prepareBatchRows(rows, m, importOptions{}, seen)

	if len(got.Accepted) != 2 {
		t.Fatalf("accepted: want 2 got %d (%+v)", len(got.Accepted), got.Accepted)
	}
	if len(got.Errors) != 2 {
		t.Fatalf("errors: want 2 got %d (%+v)", len(got.Errors), got.Errors)
	}
	if got.Skipped != 1 {
		t.Fatalf("skipped: want 1 got %d", got.Skipped)
	}
	// Email is lower-cased + trimmed (the conflict key).
	if got.Accepted[0].Email != "alice@example.com" {
		t.Errorf("email not normalised: %q", got.Accepted[0].Email)
	}
	// Outcomes retain only a stable source row and safe code, never raw PII.
	if got.Errors[0].RowNumber == 0 || got.Errors[0].Code == "" {
		t.Errorf("error row should carry row/code outcome: %+v", got.Errors[0])
	}
	// Custom fields are pre-marshalled JSON carrying the mapped key.
	if !strings.Contains(string(got.Accepted[0].CustomJSON), `"plan":"pro"`) {
		t.Errorf("custom json drifted: %s", got.Accepted[0].CustomJSON)
	}
}

func TestPrepareBatchRows_MergesJobTags(t *testing.T) {
	m := mappingEmailTags()
	seen := map[string]struct{}{}
	opts := importOptions{Tags: []string{"imported-2026"}}
	got := prepareBatchRows([][]string{{"a@b.com", "vip", ""}}, m, opts, seen)
	if len(got.Accepted) != 1 {
		t.Fatalf("want 1 accepted, got %d", len(got.Accepted))
	}
	tags := got.Accepted[0].Tags
	hasJob, hasRow := false, false
	for _, tg := range tags {
		if tg == "imported-2026" {
			hasJob = true
		}
		if tg == "vip" {
			hasRow = true
		}
	}
	if !hasJob || !hasRow {
		t.Fatalf("expected row+job tags merged, got %v", tags)
	}
}

func TestPrepareBatchRows_DedupeSpansChunks(t *testing.T) {
	m := mappingEmailTags()
	seen := map[string]struct{}{}
	first := prepareBatchRows([][]string{{"x@y.z", "", ""}}, m, importOptions{}, seen)
	if len(first.Accepted) != 1 {
		t.Fatalf("chunk 1: want 1 accepted got %d", len(first.Accepted))
	}
	// Same email in a later chunk must be skipped via the shared `seen`.
	second := prepareBatchRows([][]string{{"X@Y.Z", "", ""}}, m, importOptions{}, seen)
	if len(second.Accepted) != 0 || second.Skipped != 1 {
		t.Fatalf("chunk 2: want 0 accepted / 1 skipped, got %d / %d", len(second.Accepted), second.Skipped)
	}
}

// --- pure: copyFromRows ----------------------------------------------

func TestCopyFromRows_ColumnOrderAndDefaults(t *testing.T) {
	accepted := []preparedRow{
		{Email: "a@b.com", Tags: []string{"vip"}, CustomJSON: []byte(`{"plan":"pro"}`), RowFingerprint: strings.Repeat("a", 64)},
	}
	vals := copyFromRows("tenant-1", accepted, importOptions{ConsentSource: "double_optin"})
	if len(vals) != 1 || len(vals[0]) != len(copyColumns) {
		t.Fatalf("want 1 row of %d cols, got %d rows", len(copyColumns), len(vals))
	}
	row := vals[0]
	// copyColumns order: tenant_id, email, status, consent_source,
	// consent_timestamp, consent_email_marketing_at, tags, custom_fields,
	// row_fingerprint.
	if row[0] != "tenant-1" || row[1] != "a@b.com" {
		t.Errorf("identity cols drifted: %v", row[:2])
	}
	if row[2] != "unconfirmed" {
		t.Errorf("status must default to unconfirmed without complete proof, got %v", row[2])
	}
	if row[3] != "unknown" {
		t.Errorf("partial proof must not claim a consent source: %v", row[3])
	}
	if row[7] != `{"plan":"pro"}` {
		t.Errorf("custom_fields drifted: %v", row[7])
	}
}

func TestCopyFromRows_ConsentSourceNarrowed(t *testing.T) {
	// A complete free-form/csv proof collapses to 'import' on the
	// subscribers column (matches subscriberConsentSource). Source alone
	// is not permission and remains unknown/unconfirmed.
	captured := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	vals := copyFromRows("t", []preparedRow{{Email: "a@b.com", RowFingerprint: strings.Repeat("b", 64)}}, importOptions{
		ConsentSource: "signed_form", ConsentSourceURL: "https://example.test/consent/123",
		ConsentCapturedAt: &captured, ConsentLegalBasis: "consent", ConsentJurisdiction: "GB",
		ConsentReason: "Signed form covered marketing email.", ConsentPolicyVersion: "privacy-v1",
		ConsentEvidenceReference: "receipt:CONSENT-123", ConsentScope: ImportConsentScope,
		ConsentScopeAcknowledged: true, ConsentContractVersion: ImportConsentContractVersion,
	})
	if vals[0][3] != "import" {
		t.Errorf("want narrowed 'import', got %v", vals[0][3])
	}
	if vals[0][2] != "enabled" || vals[0][4] != &captured || vals[0][5] != &captured {
		t.Errorf("complete proof should enable with timestamp, got %v", vals[0])
	}
}

// --- pure: SQL builders ----------------------------------------------

func TestStagedMergeSQL_StrategyMatrix(t *testing.T) {
	cases := []struct {
		strategy   string
		mustHave   string
		mustNotHav string
	}{
		{"skip", "ON CONFLICT (tenant_id, email) DO NOTHING", ""},
		{"", "ON CONFLICT (tenant_id, email) DO NOTHING", ""},
		{"update", "ON CONFLICT (tenant_id, email) DO UPDATE", ""},
		{"error", "", "ON CONFLICT"},
	}
	for _, c := range cases {
		got := stagedMergeSQL(c.strategy)
		if !strings.Contains(got, "FROM "+stagingTableName) {
			t.Errorf("strategy %q must SELECT from staging table:\n%s", c.strategy, got)
		}
		// Defence-in-depth dedupe so ON CONFLICT only fires vs existing rows.
		if !strings.Contains(got, "DISTINCT ON (email)") {
			t.Errorf("strategy %q must DISTINCT ON (email):\n%s", c.strategy, got)
		}
		if c.mustHave != "" && !strings.Contains(got, c.mustHave) {
			t.Errorf("strategy %q missing %q:\n%s", c.strategy, c.mustHave, got)
		}
		if c.mustNotHav != "" && strings.Contains(got, c.mustNotHav) {
			t.Errorf("strategy %q must not contain %q:\n%s", c.strategy, c.mustNotHav, got)
		}
	}
	upd := stagedMergeSQL("update")
	if strings.Contains(upd, "consent_timestamp =") || strings.Contains(upd, "consent_email_marketing_at =") {
		t.Errorf("update merge must not alter existing consent state:\n%s", upd)
	}
}

func TestCreateStagingSQL_TempAndOnCommitDrop(t *testing.T) {
	ddl := createStagingSQL()
	if !strings.Contains(ddl, "CREATE TEMP TABLE "+stagingTableName) {
		t.Errorf("must create the named TEMP table:\n%s", ddl)
	}
	if !strings.Contains(ddl, "ON COMMIT DROP") {
		t.Errorf("staging table must be ON COMMIT DROP so chunks never collide:\n%s", ddl)
	}
	// Column set must match copyColumns (so COPY casts cleanly into it).
	for _, col := range copyColumns {
		if !strings.Contains(ddl, col) {
			t.Errorf("staging DDL missing copy column %q:\n%s", col, ddl)
		}
	}
}

func TestRouteFlags(t *testing.T) {
	// Today every strategy goes through the staged merge (COPY can't
	// express ON CONFLICT), so direct-copy is always off.
	for _, s := range []string{"skip", "update", "error", ""} {
		if usesDirectCopy(s) {
			t.Errorf("usesDirectCopy(%q) should be false", s)
		}
	}
	// mergeTouchesEveryRow: only DO-NOTHING (skip/default) can drop rows.
	if mergeTouchesEveryRow("skip") || mergeTouchesEveryRow("") {
		t.Errorf("skip/default must allow silent conflict drops")
	}
	for _, s := range []string{"update", "error"} {
		if !mergeTouchesEveryRow(s) {
			t.Errorf("strategy %q must touch every accepted row", s)
		}
	}
}

// --- executeBatchedUpsert against a fake tx --------------------------

// fakeBatchTx records COPY + Exec calls and returns a scripted CommandTag
// for the merge Exec so the counter split can be asserted offline.
type fakeBatchTx struct {
	execSQL    []string
	querySQL   []string
	copyCalls  []fakeCopyCall
	copiedRows [][]any
	mergeTag   string // returned by the merge Exec (e.g. "INSERT 0 3")
	execErr    error  // returned by every Exec when set
	copyErr    error  // returned by every CopyFrom when set
}

type fakeCopyCall struct {
	table string
	cols  []string
	rows  int
}

func (f *fakeBatchTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execSQL = append(f.execSQL, sql)
	if f.execErr != nil {
		return pgconn.CommandTag{}, f.execErr
	}
	// The merge is the only Exec that SELECTs from the staging table.
	if strings.Contains(sql, "FROM "+stagingTableName) {
		return pgconn.NewCommandTag(f.mergeTag), nil
	}
	return pgconn.NewCommandTag("CREATE TABLE"), nil
}

func (f *fakeBatchTx) CopyFrom(ctx context.Context, table pgx.Identifier, cols []string, src pgx.CopyFromSource) (int64, error) {
	n := 0
	for src.Next() {
		values, err := src.Values()
		if err != nil {
			return 0, err
		}
		f.copiedRows = append(f.copiedRows, values)
		n++
	}
	f.copyCalls = append(f.copyCalls, fakeCopyCall{table: strings.Join(table, "."), cols: cols, rows: n})
	if f.copyErr != nil {
		return 0, f.copyErr
	}
	return int64(n), nil
}

func (f *fakeBatchTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	f.querySQL = append(f.querySQL, sql)
	if f.execErr != nil {
		return nil, f.execErr
	}
	if strings.Contains(sql, "FOR UPDATE OF s") {
		return &fakeBatchRows{}, nil
	}
	count := int(pgconn.NewCommandTag(f.mergeTag).RowsAffected())
	if count > len(f.copiedRows) {
		count = len(f.copiedRows)
	}
	rows := make([][]any, 0, count)
	for i := 0; i < count; i++ {
		values := f.copiedRows[i]
		email, _ := values[1].(string)
		fingerprint, _ := values[8].(string)
		rows = append(rows, []any{
			fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1), email,
			fingerprint, "created", "", values[2].(string), false, false,
		})
	}
	return &fakeBatchRows{rows: rows}, nil
}

type fakeBatchRows struct {
	rows   [][]any
	index  int
	closed bool
}

func (r *fakeBatchRows) Close()                                       { r.closed = true }
func (r *fakeBatchRows) Err() error                                   { return nil }
func (r *fakeBatchRows) CommandTag() pgconn.CommandTag                { return pgconn.NewCommandTag("SELECT") }
func (r *fakeBatchRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeBatchRows) Next() bool {
	if r.index >= len(r.rows) {
		r.closed = true
		return false
	}
	r.index++
	return true
}
func (r *fakeBatchRows) Scan(dest ...any) error {
	row := r.rows[r.index-1]
	for i := range dest {
		switch target := dest[i].(type) {
		case *string:
			*target = row[i].(string)
		case *bool:
			*target = row[i].(bool)
		default:
			return fmt.Errorf("unsupported scan target %T", dest[i])
		}
	}
	return nil
}
func (r *fakeBatchRows) Values() ([]any, error) { return r.rows[r.index-1], nil }
func (r *fakeBatchRows) RawValues() [][]byte    { return nil }
func (r *fakeBatchRows) Conn() *pgx.Conn        { return nil }

func accepted(emails ...string) []preparedRow {
	out := make([]preparedRow, 0, len(emails))
	for _, e := range emails {
		out = append(out, preparedRow{Email: e, CustomJSON: []byte(`{}`), RowFingerprint: strings.Repeat("a", 64)})
	}
	return out
}

func TestExecuteBatchedUpsert_StagedFlow(t *testing.T) {
	tx := &fakeBatchTx{mergeTag: "INSERT 0 3"}
	res, err := executeBatchedUpsert(context.Background(), tx, "tenant-1", "skip", accepted("a@x", "b@x", "c@x"), importOptions{})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	// One COPY into the staging table (not subscribers) for the staged path.
	if len(tx.copyCalls) != 1 {
		t.Fatalf("want exactly one COPY, got %d", len(tx.copyCalls))
	}
	if tx.copyCalls[0].table != stagingTableName {
		t.Errorf("staged path must COPY into %q, got %q", stagingTableName, tx.copyCalls[0].table)
	}
	if tx.copyCalls[0].rows != 3 {
		t.Errorf("COPY should carry all 3 accepted rows, got %d", tx.copyCalls[0].rows)
	}
	// One Exec creates the temp table; the merge is a result-returning query.
	if len(tx.execSQL) != 1 || len(tx.querySQL) != 2 {
		t.Fatalf("want CREATE Exec + lock/merge Queries, got exec=%d query=%d", len(tx.execSQL), len(tx.querySQL))
	}
	if res.Imported != 3 || res.Skipped != 0 {
		t.Fatalf("all 3 inserted: want 3/0, got %d/%d", res.Imported, res.Skipped)
	}
}

func TestExecuteBatchedUpsert_SkipCounterSplit(t *testing.T) {
	// 3 accepted, merge reports only 1 inserted → 2 were existing-email
	// conflicts the DO-NOTHING merge dropped (skip strategy).
	tx := &fakeBatchTx{mergeTag: "INSERT 0 1"}
	res, err := executeBatchedUpsert(context.Background(), tx, "t", "skip", accepted("a@x", "b@x", "c@x"), importOptions{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Imported != 1 || res.Skipped != 2 {
		t.Fatalf("skip split drifted: want 1 imported / 2 skipped, got %d / %d", res.Imported, res.Skipped)
	}
}

func TestExecuteBatchedUpsert_UpdateNoSkips(t *testing.T) {
	// update strategy touches every accepted row, so a merge count below
	// the accepted size must NOT be reported as skips (DO UPDATE counts
	// every row it sees).
	tx := &fakeBatchTx{mergeTag: "INSERT 0 2"}
	res, err := executeBatchedUpsert(context.Background(), tx, "t", "update", accepted("a@x", "b@x", "c@x"), importOptions{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Skipped != 0 {
		t.Fatalf("update strategy must report 0 skips, got %d", res.Skipped)
	}
	if res.Imported != 2 {
		t.Fatalf("imported should mirror the merge tag, got %d", res.Imported)
	}
}

func TestExecuteBatchedUpsert_Empty(t *testing.T) {
	tx := &fakeBatchTx{}
	res, err := executeBatchedUpsert(context.Background(), tx, "t", "skip", nil, importOptions{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Imported != 0 || res.Skipped != 0 {
		t.Fatalf("empty batch must be a no-op: %+v", res)
	}
	if len(tx.copyCalls) != 0 || len(tx.execSQL) != 0 {
		t.Fatalf("empty batch must not touch the tx: copies=%d execs=%d", len(tx.copyCalls), len(tx.execSQL))
	}
}

func TestExecuteBatchedUpsert_CopyErrorSurfaces(t *testing.T) {
	tx := &fakeBatchTx{copyErr: errFake}
	_, err := executeBatchedUpsert(context.Background(), tx, "t", "skip", accepted("a@x"), importOptions{})
	if err == nil || !strings.Contains(err.Error(), "copy staging") {
		t.Fatalf("COPY error must surface wrapped, got %v", err)
	}
}

func TestExecuteBatchedUpsert_MergeErrorSurfaces(t *testing.T) {
	tx := &fakeBatchTx{execErr: errFake}
	_, err := executeBatchedUpsert(context.Background(), tx, "t", "error", accepted("a@x"), importOptions{})
	if err == nil {
		t.Fatalf("a failing Exec must surface as an error")
	}
}

// errFake is a sentinel for the failure-path tests.
var errFake = stubErr("boom")

type stubErr string

func (e stubErr) Error() string { return string(e) }
