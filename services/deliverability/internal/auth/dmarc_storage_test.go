package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// dbForIntegration follows the suppressions/quota pattern: skip when no
// DATABASE_URL so unit + integration tests share a single test target.
//
// The pool is closed by t.Cleanup, not by the caller's defer. Cleanups run
// after the test function returns and in LIFO order, so registering the
// close here, before seedTenant registers its row cleanup, keeps the pool
// open until that cleanup has run. A deferred Close ran first and turned
// every cleanup into "begin cleanup: closed pool".
func dbForIntegration(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedTenant creates the tenants row that dmarc_aggregate_reports.tenant_id
// references (dmarc_aggregate_reports_tenant_id_fkey, migration 1730) and
// registers cleanupDMARC. Without it every Persist fails with SQLSTATE 23503.
//
// The insert runs as the application role inside a transaction scoped to the
// new tenant: the tenants insert policy admits exactly the row whose id
// matches app.tenant_id, so DATABASE_URL alone is enough and RLS stays in
// force for everything the test asserts. Each test gets its own tenant, so
// concurrent packages sharing the database cannot see or disturb its rows.
func seedTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	if _, err := execTenantFixture(t, pool, tenantID,
		`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'DMARC storage test', 'studio')`,
		tenantID, "dmarc-storage-test-"+tenantID,
	); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() { cleanupDMARC(t, pool, tenantID) })
	return tenantID
}

// makeReport produces a parsed Report fixture suitable for Persist().
// orgName + reportID together form the dedup key.
func makeReport(orgName, reportID, domain string, recordCount int) *Report {
	now := time.Now().UTC()
	r := &Report{
		ReportMeta: ReportMetadata{
			OrgName:  orgName,
			Email:    "noreply@" + orgName + ".example",
			ReportID: reportID,
			BeginAt:  now.Add(-24 * time.Hour),
			EndAt:    now,
		},
		PolicyPub: PolicyPublished{
			Domain: domain,
			ADKIM:  "r",
			ASPF:   "r",
			P:      "quarantine",
			SP:     "quarantine",
			Pct:    "100",
		},
	}
	for i := 0; i < recordCount; i++ {
		r.Records = append(r.Records, makeRecord("203.0.113."+itoa(i+1), 5+i))
	}
	return r
}

func makeRecord(ip string, count int) DMARCRecord {
	rec := DMARCRecord{}
	rec.Row.SourceIP = ip
	rec.Row.Count = count
	rec.Row.Policy.Disposition = "none"
	rec.Row.Policy.DKIM = "pass"
	rec.Row.Policy.SPF = "pass"
	rec.Identifiers.HeaderFrom = "example.com"
	rec.AuthResults.DKIM = []struct {
		Domain   string `xml:"domain"`
		Result   string `xml:"result"`
		Selector string `xml:"selector"`
	}{{Domain: "example.com", Result: "pass", Selector: "s1"}}
	rec.AuthResults.SPF = []struct {
		Domain string `xml:"domain"`
		Result string `xml:"result"`
	}{{Domain: "example.com", Result: "pass"}}
	return rec
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [20]byte
	bp := len(b)
	for i > 0 {
		bp--
		b[bp] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		bp--
		b[bp] = '-'
	}
	return string(b[bp:])
}

// cleanupDMARC removes what a test wrote, under that tenant's RLS scope, and
// fails the test when any of it is left behind.
//
// The tenant's reports go first (records follow through
// dmarc_aggregate_records.report_id ON DELETE CASCADE), then the tenants row,
// which would also take any remaining reports with it
// (dmarc_aggregate_reports_tenant_id_fkey is ON DELETE CASCADE). Each step runs
// through execTenantFixture, so lock pressure from a parallel run is retried
// rather than mistaken for a leak. What remains is a real failure: an error
// that outlasts the retries, or a tenant delete that did not remove exactly
// this test's one row. Either way the test's rows stayed in a database every
// other package shares, and a silent log line would hide that.
func cleanupDMARC(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	if _, err := execTenantFixture(t, pool, tenantID,
		`DELETE FROM dmarc_aggregate_reports WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		t.Errorf("cleanup: deleting tenant %s's DMARC reports: %v", tenantID, err)
	}
	removed, err := execTenantFixture(t, pool, tenantID, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		t.Errorf("cleanup: tenant %s and its rows leaked: %v", tenantID, err)
		return
	}
	if removed != 1 {
		t.Errorf("cleanup deleted %d tenant rows for %s, want 1", removed, tenantID)
	}
}

// execTenantFixture runs one fixture statement (the tenant seed or a teardown
// step) in its own transaction scoped to tenantID, commits it, and returns
// the rows it affected. It uses its own bounded context, so it also works
// from t.Cleanup, and a lock wait cannot hold the package until the go test
// timeout.
//
// It replays the transaction while Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). Deleting a
// tenant cascades through every foreign key that references tenants(id), 735
// at migration head, and holds a lock on each of those tables and their
// indexes until commit: about 3,300 locks for one DELETE. The shared lock
// table holds roughly max_locks_per_transaction × max_connections entries for
// the whole server, every database on it included. At the image default of
// 64, which a shared local server may still run, two tenant deletes from
// other packages at the same moment can fill it. CI raises the setting to 512
// (the service container in .github/workflows/test.yml and
// infra/aws/codebuild/ci-group.sh), so there the retry is a backstop rather
// than the usual path. A tenant delete can also deadlock with another
// package's DDL on a table it cascades through. Both are contention on the
// shared test database, not a defect in DMARC storage, and both clear on
// their own. Only fixture steps retry; the Store calls under test run once.
func execTenantFixture(t *testing.T, pool *pgxpool.Pool, tenantID, statement string, args ...any) (int64, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		affected, err := execInTenantTx(ctx, pool, tenantID, statement, args...)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || (pgErr.Code != "53200" && pgErr.Code != "40P01") {
			return affected, err
		}
		t.Logf("tenant %s: transient SQLSTATE %s, retrying in %v: %v", tenantID, pgErr.Code, wait, err)
		select {
		case <-ctx.Done():
			return 0, fmt.Errorf("still failing after retrying: %w", err)
		case <-time.After(wait):
		}
	}
}

// execInTenantTx runs one statement in its own transaction scoped to
// tenantID, commits it, and returns the rows it affected.
func execInTenantTx(ctx context.Context, pool *pgxpool.Pool, tenantID, statement string, args ...any) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, statement, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}

// TestPersist_FirstWriteThenDuplicate verifies idempotency: a second
// Persist with the same (tenant, org, report_id) returns the existing
// id with isDuplicate=true and does not create a second row.
func TestPersist_FirstWriteThenDuplicate(t *testing.T) {
	pool := dbForIntegration(t)
	store, err := NewStore(pool)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	tenantID := seedTenant(t, pool)

	rep := makeReport("Google", "rpt-"+uuid.NewString(), "example.com", 3)
	ctx := context.Background()

	id1, dup1, err := store.Persist(ctx, tenantID, rep, "msg-1")
	if err != nil {
		t.Fatalf("first Persist: %v", err)
	}
	if dup1 {
		t.Fatalf("first Persist returned duplicate=true")
	}
	if id1 == "" {
		t.Fatalf("first Persist returned empty id")
	}

	id2, dup2, err := store.Persist(ctx, tenantID, rep, "msg-1")
	if err != nil {
		t.Fatalf("second Persist: %v", err)
	}
	if !dup2 {
		t.Fatalf("second Persist should have flagged duplicate")
	}
	if id2 != id1 {
		t.Fatalf("duplicate Persist returned different id: got %s want %s", id2, id1)
	}

	// Confirm exactly one parent row and N record rows (no double insert).
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin verify: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("set_config: %v", err)
	}
	var reportRows, recordRows int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM dmarc_aggregate_reports WHERE tenant_id = $1::uuid`, tenantID).Scan(&reportRows); err != nil {
		t.Fatalf("count reports: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM dmarc_aggregate_records WHERE report_id = $1::uuid`, id1).Scan(&recordRows); err != nil {
		t.Fatalf("count records: %v", err)
	}
	if reportRows != 1 {
		t.Fatalf("expected 1 report row, got %d", reportRows)
	}
	if recordRows != 3 {
		t.Fatalf("expected 3 record rows, got %d", recordRows)
	}
}

// TestListReports_Pagination validates ordering + limit/offset.
func TestListReports_Pagination(t *testing.T) {
	pool := dbForIntegration(t)
	store, err := NewStore(pool)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	tenantID := seedTenant(t, pool)

	ctx := context.Background()
	for i := 0; i < 5; i++ {
		r := makeReport("Google", "rpt-page-"+itoa(i), "example.com", 1)
		// stagger the date_range_end so ordering is deterministic.
		r.ReportMeta.EndAt = time.Now().UTC().Add(time.Duration(i) * time.Hour)
		if _, _, err = store.Persist(ctx, tenantID, r, ""); err != nil {
			t.Fatalf("persist %d: %v", i, err)
		}
	}

	page1, err := store.ListReports(ctx, tenantID, 2, 0)
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 2 {
		t.Fatalf("page 1 size: got %d want 2", len(page1))
	}
	if !page1[0].DateRangeEnd.After(page1[1].DateRangeEnd) {
		t.Fatalf("page 1 not in DESC order by date_range_end")
	}

	page2, err := store.ListReports(ctx, tenantID, 2, 2)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2) != 2 {
		t.Fatalf("page 2 size: got %d want 2", len(page2))
	}
	if page2[0].ID == page1[0].ID || page2[0].ID == page1[1].ID {
		t.Fatalf("page 2 overlaps page 1")
	}

	page3, err := store.ListReports(ctx, tenantID, 2, 4)
	if err != nil {
		t.Fatalf("page 3: %v", err)
	}
	if len(page3) != 1 {
		t.Fatalf("page 3 size: got %d want 1", len(page3))
	}
}

// TestGetReport_JoinsRecords confirms detail returns the joined records.
func TestGetReport_JoinsRecords(t *testing.T) {
	pool := dbForIntegration(t)
	store, err := NewStore(pool)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	tenantID := seedTenant(t, pool)

	rep := makeReport("Yahoo", "rpt-detail-"+uuid.NewString(), "example.com", 4)
	ctx := context.Background()
	id, _, err := store.Persist(ctx, tenantID, rep, "msg-detail")
	if err != nil {
		t.Fatalf("persist: %v", err)
	}

	got, err := store.GetReport(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if got == nil {
		t.Fatalf("GetReport returned nil")
	}
	if got.Report.ID != id {
		t.Fatalf("GetReport id mismatch: got %s want %s", got.Report.ID, id)
	}
	if got.Report.OrgName != "Yahoo" {
		t.Fatalf("OrgName: got %q want %q", got.Report.OrgName, "Yahoo")
	}
	if len(got.Records) != 4 {
		t.Fatalf("records: got %d want 4", len(got.Records))
	}
	for _, r := range got.Records {
		if !strings.HasPrefix(r.SourceIP, "203.0.113.") {
			t.Fatalf("unexpected source_ip: %q", r.SourceIP)
		}
		if r.Count == 0 {
			t.Fatalf("count zero on record")
		}
		if r.DKIMResult != "pass" {
			t.Fatalf("DKIMResult: got %q want pass", r.DKIMResult)
		}
		if r.SPFResult != "pass" {
			t.Fatalf("SPFResult: got %q want pass", r.SPFResult)
		}
	}
}

// TestStats_AggregatesCounters checks the dashboard rollup.
func TestStats_AggregatesCounters(t *testing.T) {
	pool := dbForIntegration(t)
	store, err := NewStore(pool)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	tenantID := seedTenant(t, pool)

	rep := makeReport("Google", "rpt-stats-"+uuid.NewString(), "example.com", 3)
	ctx := context.Background()
	if _, _, err = store.Persist(ctx, tenantID, rep, ""); err != nil {
		t.Fatalf("persist: %v", err)
	}

	stats, err := store.Stats(ctx, tenantID, time.Now().UTC().Add(-30*24*time.Hour))
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.TotalReports != 1 {
		t.Fatalf("TotalReports: got %d want 1", stats.TotalReports)
	}
	if stats.TotalRecords != 3 {
		t.Fatalf("TotalRecords: got %d want 3", stats.TotalRecords)
	}
	// Counts are 5, 6, 7 = 18.
	if stats.TotalCount != 18 {
		t.Fatalf("TotalCount: got %d want 18", stats.TotalCount)
	}
	if stats.PassCount != 18 {
		t.Fatalf("PassCount: got %d want 18", stats.PassCount)
	}
}
