package views

import (
	"context"
	"strings"
	"testing"
)

// TestOpsRoleBoundary codifies the invariant the whole views package depends on:
// the ops pool connects as postwave_ops, which reads the fleet ONLY through the
// SECURITY DEFINER functions and has NO SELECT on any base table. Under that
// role the view functions must succeed and a direct base-table SELECT must be
// permission denied. If a future change reintroduces a direct base-table read,
// this test fails as postwave_ops even though it would pass as a dev superuser
// — the exact gap that hid this bug the first time.
//
// postwave_ops is NOLOGIN, so the test connects as the DB owner and SET ROLEs to
// it on a dedicated connection (never a pooled one — the role would leak).
func TestOpsRoleBoundary(t *testing.T) {
	pool := readerDB(t)
	ctx := context.Background()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()

	var hasRole bool
	if err := conn.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_ops')`).Scan(&hasRole); err != nil {
		t.Fatalf("probe role: %v", err)
	}
	if !hasRole {
		t.Fatalf("postwave_ops role absent (migrations not applied); skipping boundary test")
	}

	if _, err := conn.Exec(ctx, "SET ROLE postwave_ops"); err != nil {
		t.Fatalf("set role postwave_ops: %v", err)
	}
	// Restore the connection's role before it returns to the pool.
	defer func() { _, _ = conn.Exec(ctx, "RESET ROLE") }()

	// Every view function must be EXECUTE-able under postwave_ops.
	fns := []string{
		"SELECT 1 FROM ops_tenant_directory('', 1)",
		"SELECT 1 FROM ops_send_queue_depth(1)",
		"SELECT 1 FROM ops_send_dead_letters(1)",
		"SELECT 1 FROM ops_deliverability_by_tenant(1)",
		"SELECT 1 FROM ops_billing_by_tenant(1)",
		"SELECT 1 FROM ops_campaign_assurance_runs(NULL, NULL, NULL, NULL, 1)",
		"SELECT 1 FROM ops_campaign_assurance_run_detail('71000000-0000-4000-8000-000000000001'::uuid)",
		"SELECT 1 FROM ops_campaign_assurance_run_timeline('71000000-0000-4000-8000-000000000001'::uuid, 0, 1)",
		"SELECT 1 FROM ops_campaign_assurance_slo_health()",
	}
	for _, q := range fns {
		rows, err := conn.Query(ctx, q)
		if err != nil {
			t.Fatalf("postwave_ops must execute view function %q: %v", q, err)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatalf("view function %q errored during read: %v", q, err)
		}
	}

	// Direct base-table reads must be denied — the boundary is a GRANT, not a
	// convention. A view that reverts to a base-table SELECT breaks here.
	for _, table := range []string{
		"tenants", "campaign_recipients", "billing_state", "outbox_events",
		"subscriber_events", "tenant_usage_snapshots",
		"campaign_assurance_runs", "campaign_assurance_commands",
		"campaign_assurance_run_targets", "campaign_assurance_extractions",
		"campaign_assurance_model_invocation_reservations",
		"campaign_assurance_model_invocation_results",
		"seed_message_observations", "campaign_assurance_progress_events",
	} {
		_, err := conn.Exec(ctx, "SELECT 1 FROM "+table+" LIMIT 1")
		if err == nil {
			t.Fatalf("postwave_ops must NOT read base table %q directly — the ops boundary has been weakened", table)
		}
		if !strings.Contains(strings.ToLower(err.Error()), "permission denied") {
			t.Fatalf("expected permission-denied reading %q as postwave_ops, got: %v", table, err)
		}
	}
}
