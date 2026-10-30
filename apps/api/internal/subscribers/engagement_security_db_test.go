package subscribers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func sentCountSQLState(t *testing.T, err error) string {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error %v is not a PostgreSQL error", err)
	}
	return pgErr.Code
}

func callSubscriberSentCount(
	t *testing.T,
	pool *pgxpool.Pool,
	authenticatedTenant, requestedTenant, email string,
	since time.Time,
) (int64, error) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, authenticatedTenant)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int64
	err = tx.QueryRow(ctx, `
SELECT public.subscriber_contact_sent_count($1::uuid, $2, $3)`,
		requestedTenant, email, since).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, tx.Commit(ctx)
}

// TestSubscriberContactSentCountSecurity_DB proves the scalar definer is a
// tenant-authenticated aggregate boundary, not a campaign-recipient RLS bypass
// for callers. It also attests the purpose role's attributes/grants and the
// real index plan used behind the boundary.
func TestSubscriberContactSentCountSecurity_DB(t *testing.T) {
	appPool := newEngagementTestPool(t)
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL is required for definer privilege and EXPLAIN evidence")
	}
	adminPool, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	t.Cleanup(adminPool.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	otherTenantID := uuid.NewString()
	seedEngagementTenant(t, appPool, tenantID)
	seedEngagementTenant(t, appPool, otherTenantID)
	email := "sent-count-" + strings.ReplaceAll(uuid.NewString(), "-", "") + "@example.test"
	recent := time.Now().UTC().Add(-24 * time.Hour)
	old := time.Now().UTC().Add(-120 * 24 * time.Hour)
	seedEngagementRecipient(t, appPool, tenantID, email, "sent", &recent)
	seedEngagementRecipient(t, appPool, tenantID, email, "sent", &old)
	seedEngagementRecipient(t, appPool, tenantID, email, "failed", nil)
	seedEngagementRecipient(t, appPool, otherTenantID, email, "sent", &recent)

	count, err := callSubscriberSentCount(t, appPool, tenantID, tenantID, email, time.Now().UTC().Add(-90*24*time.Hour))
	if err != nil {
		t.Fatalf("authorized sent count: %v", err)
	}
	if count != 1 {
		t.Fatalf("authorized sent count = %d, want one recent successful send", count)
	}
	if _, err := callSubscriberSentCount(t, appPool, tenantID, otherTenantID, email, time.Now().UTC().Add(-90*24*time.Hour)); err == nil || sentCountSQLState(t, err) != "42501" {
		t.Fatalf("cross-tenant call error = %v, want SQLSTATE 42501", err)
	}

	// No tenant GUC means no authority, even if the caller asserts the worker
	// GUC historically used by campaign-recipient background work.
	var unscopedCount int64
	err = appPool.QueryRow(ctx, `
SELECT public.subscriber_contact_sent_count($1::uuid, $2, now() - interval '90 days')`,
		tenantID, email).Scan(&unscopedCount)
	if err == nil || sentCountSQLState(t, err) != "42501" {
		t.Fatalf("unscoped call error = %v, want SQLSTATE 42501", err)
	}
	workerTx, err := appPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin worker-GUC probe: %v", err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	if _, err := workerTx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		t.Fatalf("set worker GUC: %v", err)
	}
	err = workerTx.QueryRow(ctx, `
SELECT public.subscriber_contact_sent_count($1::uuid, $2, now() - interval '90 days')`,
		tenantID, email).Scan(&unscopedCount)
	if err == nil || sentCountSQLState(t, err) != "42501" {
		t.Fatalf("worker-only call error = %v, want SQLSTATE 42501", err)
	}
	_ = workerTx.Rollback(ctx)

	invalidInputs := []struct {
		name  string
		email string
		since time.Time
	}{
		{name: "uppercase", email: "Buyer@Example.test", since: recent},
		{name: "leading space", email: " buyer@example.test", since: recent},
		{name: "control", email: "buy\ner@example.test", since: recent},
		{name: "single-label domain", email: "buyer@localhost", since: recent},
		{name: "oversized", email: strings.Repeat("a", 245) + "@example.test", since: recent},
		{name: "too old", email: email, since: time.Now().UTC().Add(-367 * 24 * time.Hour)},
		{name: "future", email: email, since: time.Now().UTC().Add(2 * time.Minute)},
	}
	for _, tc := range invalidInputs {
		t.Run(tc.name, func(t *testing.T) {
			_, err := callSubscriberSentCount(t, appPool, tenantID, tenantID, tc.email, tc.since)
			if err == nil || sentCountSQLState(t, err) != "22023" {
				t.Fatalf("invalid input error = %v, want SQLSTATE 22023", err)
			}
		})
	}

	// Purpose-role metadata and direct privilege inventory. These checks use
	// the administrative fixture only for catalog visibility; runtime behavior
	// above uses the real postwave_app role.
	var canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS bool
	if err := adminPool.QueryRow(ctx, `
SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
       rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
 WHERE rolname = 'postwave_subscriber_metrics_definer'`).Scan(
		&canLogin, &superuser, &createDB, &createRole, &inherit, &replication, &bypassRLS,
	); err != nil {
		t.Fatalf("read definer role: %v", err)
	}
	if canLogin || superuser || createDB || createRole || inherit || replication || !bypassRLS {
		t.Fatalf("unsafe definer attributes login=%v super=%v createdb=%v createrole=%v inherit=%v replication=%v bypassrls=%v",
			canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS)
	}
	var memberships int
	if err := adminPool.QueryRow(ctx, `
SELECT count(*)::int
  FROM pg_catalog.pg_auth_members
 WHERE member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postwave_subscriber_metrics_definer')
    OR roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postwave_subscriber_metrics_definer')`).Scan(&memberships); err != nil {
		t.Fatalf("read definer memberships: %v", err)
	}
	if memberships != 0 {
		t.Fatalf("definer has %d memberships, want zero", memberships)
	}

	rows, err := adminPool.Query(ctx, `
SELECT table_name, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE grantee = 'postwave_subscriber_metrics_definer'
   AND table_schema = 'public'
 ORDER BY table_name, column_name, privilege_type`)
	if err != nil {
		t.Fatalf("read definer column grants: %v", err)
	}
	grants := []string{}
	for rows.Next() {
		var table, column, privilege string
		if err := rows.Scan(&table, &column, &privilege); err != nil {
			rows.Close()
			t.Fatalf("scan definer column grant: %v", err)
		}
		grants = append(grants, table+"."+column+":"+privilege)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate definer column grants: %v", err)
	}
	rows.Close()
	wantGrants := []string{
		"campaign_recipients.sent_at:SELECT",
		"campaign_recipients.status:SELECT",
		"campaign_recipients.subscriber_email:SELECT",
		"campaign_recipients.tenant_id:SELECT",
	}
	sort.Strings(wantGrants)
	if fmt.Sprint(grants) != fmt.Sprint(wantGrants) {
		t.Fatalf("definer column grants = %v, want exactly %v", grants, wantGrants)
	}

	var unexpectedACLs int
	if err := adminPool.QueryRow(ctx, `
WITH target AS (
  SELECT p.oid, p.proowner, p.prosecdef, p.provolatile, p.prorettype,
         p.proconfig, p.proacl, l.lanname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.subscriber_contact_sent_count(uuid,text,timestamp with time zone)'::regprocedure
), allowed AS (
  SELECT oid FROM pg_catalog.pg_roles
   WHERE rolname IN ('postwave_subscriber_metrics_definer', 'postwave_app')
)
SELECT count(*)::int
  FROM target
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(target.proacl, pg_catalog.acldefault('f', target.proowner))
  ) acl
 WHERE acl.privilege_type = 'EXECUTE'
   AND acl.grantee NOT IN (SELECT oid FROM allowed)`).Scan(&unexpectedACLs); err != nil {
		t.Fatalf("inspect function ACL: %v", err)
	}
	if unexpectedACLs != 0 {
		t.Fatalf("function has %d unexpected EXECUTE grantees", unexpectedACLs)
	}
	var owner, language, volatility, returnType string
	var securityDefiner bool
	var config []string
	if err := adminPool.QueryRow(ctx, `
SELECT owner.rolname, language.lanname, proc.provolatile::text,
       proc.prosecdef, proc.prorettype::regtype::text, proc.proconfig
  FROM pg_catalog.pg_proc proc
  JOIN pg_catalog.pg_roles owner ON owner.oid = proc.proowner
  JOIN pg_catalog.pg_language language ON language.oid = proc.prolang
 WHERE proc.oid = 'public.subscriber_contact_sent_count(uuid,text,timestamp with time zone)'::regprocedure`).Scan(
		&owner, &language, &volatility, &securityDefiner, &returnType, &config,
	); err != nil {
		t.Fatalf("read function metadata: %v", err)
	}
	if owner != "postwave_subscriber_metrics_definer" || language != "plpgsql" ||
		volatility != "s" || !securityDefiner || returnType != "bigint" ||
		// pg_temp, listed last, is part of what makes this safe rather than a
		// deviation from it. Without it PostgreSQL still searches the caller's
		// temp schema and searches it FIRST for relation and type names, so a
		// caller can shadow an unqualified type in the body and execute its own
		// SQL as this definer role — demonstrated against this schema, see
		// migration 1915. The old pin, 'search_path=pg_catalog', is the exposed
		// value. Still an exact match, so the metadata cannot drift unnoticed.
		len(config) != 1 || config[0] != "search_path=pg_catalog, pg_temp" {
		t.Fatalf("unsafe function metadata owner=%s language=%s volatility=%s security=%v return=%s config=%v",
			owner, language, volatility, securityDefiner, returnType, config)
	}

	// Seed enough unrelated tenant rows to make the contact index choice
	// observable and attest the bypass-RLS owner's internal scalar plan.
	seedTx, err := db.WithTenant(ctx, appPool, tenantID)
	if err != nil {
		t.Fatalf("open plan fixture: %v", err)
	}
	var campaignID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, 'sent-count-plan', 'sent count plan', 'sent')
RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed plan campaign: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO campaign_recipients
    (tenant_id, campaign_id, subscriber_email, status, sent_at)
SELECT $1::uuid, $2::uuid,
       ('decoy-' || n::text || '-' || $3 || '@example.test')::citext,
       'sent', now() - interval '1 day'
  FROM generate_series(1, 2000) n`, tenantID, campaignID, strings.ReplaceAll(uuid.NewString(), "-", "")); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed plan decoys: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit plan fixture: %v", err)
	}
	if _, err := adminPool.Exec(ctx, `ANALYZE public.campaign_recipients`); err != nil {
		t.Fatalf("analyze plan fixture: %v", err)
	}
	planTx, err := adminPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin plan evidence: %v", err)
	}
	defer func() { _ = planTx.Rollback(ctx) }()
	if _, err := planTx.Exec(ctx, `SET LOCAL ROLE postwave_subscriber_metrics_definer`); err != nil {
		t.Fatalf("set definer role for plan: %v", err)
	}
	if _, err := planTx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
		t.Fatalf("disable seqscan for plan proof: %v", err)
	}
	planRows, err := planTx.Query(ctx, `
EXPLAIN (COSTS OFF)
SELECT count(*)::bigint
  FROM public.campaign_recipients
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2::public.citext
   AND status = 'sent'
   AND sent_at >= $3`, tenantID, email, time.Now().UTC().Add(-90*24*time.Hour))
	if err != nil {
		t.Fatalf("explain sent-count query: %v", err)
	}
	planLines := []string{}
	for planRows.Next() {
		var line string
		if err := planRows.Scan(&line); err != nil {
			planRows.Close()
			t.Fatalf("scan sent-count plan: %v", err)
		}
		planLines = append(planLines, line)
	}
	if err := planRows.Err(); err != nil {
		planRows.Close()
		t.Fatalf("iterate sent-count plan: %v", err)
	}
	planRows.Close()
	plan := strings.Join(planLines, "\n")
	if !strings.Contains(plan, "campaign_recipients_contact_performance_sent_idx") ||
		!strings.Contains(plan, "subscriber_email") || !strings.Contains(plan, "sent_at") {
		t.Fatalf("sent-count plan does not use the full contact/time index:\n%s", plan)
	}
	if err := planTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback plan evidence: %v", err)
	}
}
