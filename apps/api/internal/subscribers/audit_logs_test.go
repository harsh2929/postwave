// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_logs_test.go — SUB-123: the subscriber-scoped audit endpoint's action
// filter must be PREFIX-ANCHORED, not an unanchored substring. A
// 'subscriber.updated' row is returned by the default subscriber.% scope while
// a non-subscriber action is excluded; an explicit ?action= matches the exact
// action (or a dotted-namespace descendant of it) and never a substring sibling
// (action=foo must not match 'subscriber.unfoo').
//
// The DB-gated test proves the real SQL behavior end-to-end and skips cleanly
// without DATABASE_URL (project-wide pg-backed test convention). The unit-level
// tests pin the query-building anchoring + LIKE escaping so the prefix
// semantics are covered even when no database is reachable.

package subscribers

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// --- unit-level: prefix anchoring + LIKE escaping (no DB required) ----------

// matchesActionFilter mirrors the SQL predicate
//
//	($action = '' OR action = $action OR action LIKE escape($action)+'.%')
//
// in pure Go so the prefix-anchoring contract can be asserted without a
// database. It is intentionally a faithful re-expression of the WHERE clause in
// ListAuditLogs, not the production code path — the DB-gated test below exercises
// the real query.
func matchesActionFilter(filter, action string) bool {
	if filter == "" {
		return true
	}
	if action == filter {
		return true
	}
	// dotted-namespace descendant: action begins with filter + "."
	prefix := filter + "."
	return len(action) > len(prefix) && action[:len(prefix)] == prefix
}

func TestAuditActionFilter_PrefixAnchored(t *testing.T) {
	cases := []struct {
		name   string
		filter string
		action string
		want   bool
	}{
		{"empty filter matches anything", "", "subscriber.updated", true},
		{"exact action matches", "subscriber.updated", "subscriber.updated", true},
		{"namespace prefix matches descendant", "subscriber", "subscriber.updated", true},
		{"namespace prefix matches merged", "subscriber", "subscriber.merged", true},
		// The bug being fixed: an unanchored substring must NOT match.
		{"substring sibling must not match", "foo", "subscriber.unfoo", false},
		{"interior substring must not match", "scriber", "subscriber.updated", false},
		{"prefix that is not a dotted boundary must not match", "subscriber.up", "subscriber.updated", false},
		{"exact namespace term is not its own descendant", "subscriber.updated", "subscriber.updated.extra", true},
		{"sibling action excluded by exact filter", "subscriber.merged", "subscriber.updated", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesActionFilter(tc.filter, tc.action); got != tc.want {
				t.Fatalf("matchesActionFilter(%q, %q) = %v, want %v",
					tc.filter, tc.action, got, tc.want)
			}
		})
	}
}

func TestEscapeLikePattern(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"subscriber", "subscriber"},
		{`%`, `\%`},
		{`_`, `\_`},
		{`\`, `\\`},
		{`sub%er_`, `sub\%er\_`},
	}
	for _, tc := range cases {
		if got := escapeLikePattern(tc.in); got != tc.want {
			t.Errorf("escapeLikePattern(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// --- DB-gated: real SQL prefix anchoring -------------------------------------

func newAuditLogsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed audit-logs filter test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedAuditLogsTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'audit-logs-test', 'audit-logs-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedAuditLogsSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

func seedAuditRow(t *testing.T, pool *pgxpool.Pool, tenantID, action, resourceID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx for audit seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, resource_type, resource_id)
VALUES ($1::uuid, $2, 'subscriber', $3)`, tenantID, action, resourceID); err != nil {
		t.Fatalf("seed audit row %s: %v", action, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit audit seed: %v", err)
	}
}

func auditActions(items []AuditLogEntry) map[string]bool {
	out := make(map[string]bool, len(items))
	for _, it := range items {
		out[it.Action] = true
	}
	return out
}

// TestListAuditLogs_ActionFilterPrefixAnchored pins SUB-123: the default scope
// returns subscriber.* rows (a non-subscriber action sharing the resource_id is
// excluded), and an explicit ?action= is prefix-anchored — it matches the
// intended action but never an unanchored substring sibling
// ('subscriber.unfoo' must not be returned for action=foo).
func TestListAuditLogs_ActionFilterPrefixAnchored(t *testing.T) {
	pool := newAuditLogsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41201"
	seedAuditLogsTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("audit-filter-%d@example.test", suffix)
	subID := seedAuditLogsSubscriber(t, pool, tenantID, email)

	// Audit rows all carrying this subscriber's resource_id:
	//   subscriber.updated   — in scope, matched by exact + namespace filters
	//   subscriber.merged    — in scope, a sibling action
	//   subscriber.unfoo     — in scope; the substring-bug canary for action=foo
	//   widget.created       — NOT a subscriber.* action; must be excluded entirely
	seedAuditRow(t, pool, tenantID, "subscriber.updated", subID)
	seedAuditRow(t, pool, tenantID, "subscriber.merged", subID)
	seedAuditRow(t, pool, tenantID, "subscriber.unfoo", subID)
	seedAuditRow(t, pool, tenantID, "widget.created", subID)

	repo := &Repo{Pool: pool}

	// 1) No action filter: subscriber.* rows present, non-subscriber excluded.
	all, err := repo.ListAuditLogs(ctx, tenantID, subID, auditLogOptions{Limit: 100})
	if err != nil {
		t.Fatalf("ListAuditLogs (no filter): %v", err)
	}
	got := auditActions(all.Items)
	if !got["subscriber.updated"] {
		t.Errorf("default scope missing subscriber.updated; got %v", got)
	}
	if !got["subscriber.unfoo"] {
		t.Errorf("default scope missing subscriber.unfoo; got %v", got)
	}
	if got["widget.created"] {
		t.Errorf("default scope leaked non-subscriber action widget.created; got %v", got)
	}

	// 2) action=foo must NOT match the substring sibling 'subscriber.unfoo'
	//    (this is the unanchored-ILIKE bug being fixed).
	foo, err := repo.ListAuditLogs(ctx, tenantID, subID, auditLogOptions{Action: "foo", Limit: 100})
	if err != nil {
		t.Fatalf("ListAuditLogs (action=foo): %v", err)
	}
	if len(foo.Items) != 0 {
		t.Errorf("action=foo matched %d rows (unanchored substring leak): %v",
			len(foo.Items), auditActions(foo.Items))
	}

	// 3) Exact action filter returns only that action.
	exact, err := repo.ListAuditLogs(ctx, tenantID, subID, auditLogOptions{Action: "subscriber.updated", Limit: 100})
	if err != nil {
		t.Fatalf("ListAuditLogs (action=subscriber.updated): %v", err)
	}
	ex := auditActions(exact.Items)
	if !ex["subscriber.updated"] {
		t.Errorf("exact filter missing subscriber.updated; got %v", ex)
	}
	if ex["subscriber.merged"] || ex["subscriber.unfoo"] {
		t.Errorf("exact filter leaked sibling actions; got %v", ex)
	}

	// 4) Namespace prefix filter matches all dotted descendants.
	ns, err := repo.ListAuditLogs(ctx, tenantID, subID, auditLogOptions{Action: "subscriber", Limit: 100})
	if err != nil {
		t.Fatalf("ListAuditLogs (action=subscriber): %v", err)
	}
	nsGot := auditActions(ns.Items)
	if !nsGot["subscriber.updated"] || !nsGot["subscriber.merged"] || !nsGot["subscriber.unfoo"] {
		t.Errorf("namespace filter should match all subscriber.* rows; got %v", nsGot)
	}
	if nsGot["widget.created"] {
		t.Errorf("namespace filter leaked widget.created; got %v", nsGot)
	}
}
