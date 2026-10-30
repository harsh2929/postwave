// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestAssuranceProgressEvents_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := assuranceDBPool(t, ctx)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_progress_events') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatalf("inspect progress schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database does not have migration 1932")
	}

	repo := NewRepo(pool)
	fixture := seedAssuranceFixture(t, ctx, pool)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.foreignTenantID)
	})

	run, err := repo.CreateRun(ctx, fixture.tenantID, dbCreateInput(fixture))
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	claimed, err := repo.ClaimRun(ctx, fixture.tenantID, run.ID, "progress-worker", time.Minute)
	if err != nil {
		t.Fatalf("claim run: %v", err)
	}
	if claimed.Run.ClaimToken == nil {
		t.Fatal("claimed run is missing claim token")
	}
	if _, err := repo.RenewLease(
		ctx, fixture.tenantID, run.ID, *claimed.Run.ClaimToken,
		claimed.Run.AttemptCount, 2*time.Minute,
	); err != nil {
		t.Fatalf("renew run: %v", err)
	}
	if _, err := repo.CancelRun(ctx, fixture.tenantID, run.ID); err != nil {
		t.Fatalf("cancel run: %v", err)
	}

	events, err := repo.ListProgressEvents(ctx, fixture.tenantID, run.ID, 0, 100)
	if err != nil {
		t.Fatalf("list progress: %v", err)
	}
	wantTypes := []string{
		"run_created", "snapshot_frozen", "run_claimed",
		"lease_renewed", "run_cancelled",
	}
	if len(events) != len(wantTypes) {
		t.Fatalf("event count = %d, want %d: %#v", len(events), len(wantTypes), events)
	}
	for index, event := range events {
		if event.EventNo != int64(index+1) {
			t.Errorf("event[%d].event_no = %d, want %d", index, event.EventNo, index+1)
		}
		if event.EventType != wantTypes[index] {
			t.Errorf("event[%d].event_type = %q, want %q", index, event.EventType, wantTypes[index])
		}
		serialized := string(event.Metadata)
		if strings.Contains(serialized, "progress-worker") ||
			strings.Contains(serialized, *claimed.Run.ClaimToken) {
			t.Errorf("event[%d] leaked worker or fencing identity: %s", index, serialized)
		}
	}

	page, err := repo.ListProgressEvents(ctx, fixture.tenantID, run.ID, 2, 2)
	if err != nil {
		t.Fatalf("list progress page: %v", err)
	}
	if len(page) != 2 || page[0].EventNo != 3 || page[1].EventNo != 4 {
		t.Fatalf("cursor page = %#v, want event numbers 3 and 4", page)
	}
	foreign, err := repo.ListProgressEvents(ctx, fixture.foreignTenantID, run.ID, 0, 100)
	if err != nil {
		t.Fatalf("foreign-tenant list: %v", err)
	}
	if len(foreign) != 0 {
		t.Fatalf("foreign tenant read %d progress events", len(foreign))
	}

	if _, err := pool.Exec(ctx, `
UPDATE campaign_assurance_progress_events
   SET status = 'rewritten'
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND event_no = 1`,
		fixture.tenantID, run.ID); sqlState(err) != "55000" {
		t.Fatalf("progress rewrite error = %v state=%q, want 55000", err, sqlState(err))
	}

	var appRoleExists bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_app')`).Scan(&appRoleExists); err != nil {
		t.Fatalf("inspect postwave_app role: %v", err)
	}
	if appRoleExists {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin forged progress insert: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
			t.Fatalf("set postwave_app role: %v", err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
			t.Fatalf("bind forged progress tenant: %v", err)
		}
		_, err = tx.Exec(ctx, `
INSERT INTO campaign_assurance_progress_events (
    tenant_id, campaign_id, run_id, event_no, attempt_count,
    event_type, stage, status
) VALUES ($1::uuid, $2::uuid, $3::uuid, 999, 1,
          'lease_renewed', 'lifecycle', 'running')`,
			fixture.tenantID, fixture.campaignID, run.ID)
		if sqlState(err) != "42501" {
			t.Fatalf("forged progress insert error = %v state=%q, want 42501", err, sqlState(err))
		}
	}
}
