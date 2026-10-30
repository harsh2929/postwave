// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestRoute42ReadIndexesSupportProductionQueryShapes(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	// This fixture intentionally creates active system suppressions, whose
	// direct deletion is guarded. Delete the parent tenant first during cleanup
	// so the reviewed FK-cascade exception runs; the generic SMS fixture cleanup
	// otherwise stops on the protected child rows and leaves thousands of rows
	// that distort later planner tests on the same disposable database.
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(cleanupCtx, pool, f.tenantID)
		if err != nil {
			t.Errorf("open Route42 scale cleanup: %v", err)
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		if _, err := cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, f.tenantID); err != nil {
			t.Errorf("cascade Route42 scale fixture cleanup: %v", err)
			return
		}
		if err := cleanupTx.Commit(cleanupCtx); err != nil {
			t.Errorf("commit Route42 scale fixture cleanup: %v", err)
		}
	})

	for _, name := range []string{
		"sms_suppressions_tenant_created_id_idx",
		"sms_suppressions_tenant_reason_created_id_idx",
		"sms_consent_events_tenant_granted_keyword_idx",
	} {
		var valid, ready bool
		if err := pool.QueryRow(ctx, `
			SELECT i.indisvalid, i.indisready
			  FROM pg_index i
			  JOIN pg_class c ON c.oid=i.indexrelid
			 WHERE c.oid=$1::regclass`, name).Scan(&valid, &ready); err != nil {
			t.Fatalf("read Route42 index %s: %v", name, err)
		}
		if !valid || !ready {
			t.Fatalf("Route42 index %s valid=%v ready=%v", name, valid, ready)
		}
	}

	// Give the planner a production-shaped tenant instead of asking it to pick
	// among equally cheap indexes on an empty fixture table.
	seedTx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seedTx.Exec(ctx, `
		INSERT INTO sms_suppressions
			(tenant_id,phone_e164,phone,reason,source,metadata,manual_overlay_state,created_at)
		SELECT $1::uuid,
		       '+1415555' || lpad(g::text,4,'0'),
		       '+1415555' || lpad(g::text,4,'0'),
		       CASE WHEN g % 4000 = 0 THEN 'manual' ELSE 'stop_keyword' END,
		       CASE WHEN g % 4000 = 0 THEN 'manual' ELSE 'twilio' END,
		       '{}'::jsonb,'none',clock_timestamp()-make_interval(secs=>g)
		  FROM generate_series(0,3999) AS g
		ON CONFLICT (tenant_id,phone_e164) DO NOTHING`, f.tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed production-shaped suppression registry: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
		INSERT INTO sms_suppressions
			(tenant_id,phone_e164,phone,reason,source,metadata,manual_overlay_state)
		VALUES ($1::uuid,$2,$2,'manual','manual','{}'::jsonb,'none')
		ON CONFLICT (tenant_id,phone_e164) DO NOTHING`, f.tenantID, f.phone); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed exact suppression lookup row: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit Route42 plan fixture: %v", err)
	}
	// ANALYZE issued by the restricted app role only emits a warning and leaves
	// stale global statistics in place. Use the test-admin connection so this
	// planner proof is based on the production-shaped fixture just committed,
	// not on whichever package happened to touch the shared QA database first.
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" {
		t.Fatal("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required for deterministic Route42 planner statistics")
	}
	adminConfig, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse Route42 planner admin URL: %v", err)
	}
	adminConfig.Database = pool.Config().ConnConfig.Database
	admin, err := pgx.ConnectConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("connect Route42 planner admin: %v", err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	if _, err := admin.Exec(ctx, `ANALYZE sms_suppressions`); err != nil {
		t.Fatalf("analyze Route42 plan fixture: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatalf("assume production DB role for Route42 plans: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, f.tenantID); err != nil {
		t.Fatalf("restore tenant GUC after SET ROLE: %v", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off`); err != nil {
		t.Fatalf("force index-eligibility plans: %v", err)
	}
	snapshot := time.Now().UTC()

	assertRoute42PlanUsesIndex(t, ctx, tx, "sms_suppressions_tenant_created_id_idx", `
		EXPLAIN (COSTS OFF)
		SELECT id, phone_e164, reason, source, created_at
		  FROM sms_suppressions
		 WHERE tenant_id=$1::uuid
		   AND (expires_at IS NULL OR expires_at>$2)
		   AND created_at<=$2
		 ORDER BY created_at DESC,id DESC
		 LIMIT 201`, f.tenantID, snapshot)

	assertRoute42PlanUsesIndex(t, ctx, tx, "sms_suppressions_tenant_reason_created_id_idx", `
		EXPLAIN (COSTS OFF)
		SELECT id, phone_e164, reason, source, created_at
		  FROM sms_suppressions
		 WHERE tenant_id=$1::uuid
		   AND reason=$2
		   AND (expires_at IS NULL OR expires_at>$3)
		   AND created_at<=$3
		 ORDER BY created_at DESC,id DESC
		 LIMIT 201`, f.tenantID, "manual", snapshot)

	// The sensitive exact-phone POST route reuses the pre-existing unique key;
	// 1995 intentionally does not build a duplicate recipient-identity index.
	assertRoute42PlanUsesIndex(t, ctx, tx, "sms_suppressions_tenant_id_phone_e164_key", `
		EXPLAIN (COSTS OFF)
		SELECT id, phone_e164, reason, source, created_at
		  FROM sms_suppressions
		 WHERE tenant_id=$1::uuid
		   AND phone_e164=$2
		   AND (expires_at IS NULL OR expires_at>$3)
		   AND created_at<=$3
		 LIMIT 2`, f.tenantID, f.phone, snapshot)

	assertRoute42PlanUsesIndex(t, ctx, tx, "sms_consent_events_tenant_granted_keyword_idx", `
		EXPLAIN (COSTS OFF)
		SELECT metadata->>'keyword',count(*)::bigint
		  FROM sms_consent_events
		 WHERE tenant_id=$1::uuid
		   AND action='granted'
		   AND metadata ? 'keyword'
		 GROUP BY metadata->>'keyword'`, f.tenantID)
}

func assertRoute42PlanUsesIndex(t *testing.T, ctx context.Context, tx pgx.Tx, indexName, query string, args ...any) {
	t.Helper()
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		t.Fatalf("EXPLAIN Route42 query for %s: %v", indexName, err)
	}
	defer rows.Close()
	var plan strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan Route42 plan for %s: %v", indexName, err)
		}
		plan.WriteString(line)
		plan.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read Route42 plan for %s: %v", indexName, err)
	}
	t.Logf("Route42 plan for %s:\n%s", indexName, plan.String())
	if !strings.Contains(plan.String(), indexName) {
		t.Fatalf("Route42 plan does not use %s:\n%s", indexName, plan.String())
	}
}
