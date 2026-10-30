// SPDX-License-Identifier: AGPL-3.0-only

package audit

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// Retention may delete audit rows. Nothing else may.
//
// `postwave_app` held no DELETE on audit_log, so every trim raised "permission
// denied for table audit_log" and the log grew without bound — the retention
// window the product promises was never enforced. The trimmer had been setting
// `app.audit_trim_worker` on its transactions all along and NO policy anywhere
// read that GUC: the capability was designed and only the half that enforces it
// was missing.
//
// Granting DELETE alone would have been worse than the bug. `tenant_isolation`
// is PERMISSIVE FOR ALL, so a bare grant lets any ordinary tenant-scoped request
// delete its own audit rows. Migration 1902 pairs the grant with a RESTRICTIVE
// DELETE policy, which ANDs with tenant_isolation: retention can delete, a
// request cannot.
func TestOnlyTheRetentionTrimmerCanDeleteAuditRows(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	seedAuditTenant(t, pool, tenantID)

	seed := func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		for _, guc := range []string{"app.tenant_id", "app.audit_internal_writer"} {
			value := tenantID
			if guc == "app.audit_internal_writer" {
				value = "true"
			}
			if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, guc, value); err != nil {
				t.Fatalf("set %s: %v", guc, err)
			}
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type)
VALUES ($1::uuid, 'immutability_probe', now() - interval '90 days', '{}', 'system')`,
			tenantID); err != nil {
			t.Fatalf("seed audit row: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit: %v", err)
		}
	}
	seed()

	// An ordinary tenant-scoped request must not be able to erase its own audit
	// trail, which is the entire point of an audit log.
	plain, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin plain: %v", err)
	}
	if _, err := plain.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = plain.Rollback(ctx)
		t.Fatalf("scope: %v", err)
	}
	tag, err := plain.Exec(ctx, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	if err == nil && tag.RowsAffected() > 0 {
		_ = plain.Rollback(ctx)
		t.Fatalf("an ordinary tenant request deleted %d audit row(s). The DELETE "+
			"grant added for retention has become a way for a tenant to erase its "+
			"own audit trail.", tag.RowsAffected())
	}
	_ = plain.Rollback(ctx)

	// And the trimmer's capability must still work, or retention is broken again.
	trimmer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin trimmer: %v", err)
	}
	defer func() { _ = trimmer.Rollback(ctx) }()
	for _, kv := range [][2]string{{"app.tenant_id", tenantID}, {"app.audit_trim_worker", "true"}} {
		if _, err := trimmer.Exec(ctx, `SELECT set_config($1, $2, true)`, kv[0], kv[1]); err != nil {
			t.Fatalf("set %s: %v", kv[0], err)
		}
	}
	tag, err = trimmer.Exec(ctx, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		t.Fatalf("the retention trimmer cannot delete: %v. Audit retention is "+
			"unenforceable and the log grows without bound.", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("trimmer deleted %d rows, want 1", tag.RowsAffected())
	}
}
