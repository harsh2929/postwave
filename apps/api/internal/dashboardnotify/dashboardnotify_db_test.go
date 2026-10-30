// SPDX-License-Identifier: AGPL-3.0-only
package dashboardnotify

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestTickEmitsAnomaliesAndMilestones is the end-to-end proof for
// DASHBOARD#44: a persisted anomaly and an audience that has crossed a
// threshold both reach the tenant's operators through the fanout, with the
// dedupe keys that make a repeated sweep a no-op.
func TestTickEmitsAnomaliesAndMilestones(t *testing.T) {
	pool := emitterTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	ownerID := uuid.NewString()
	viewerID := uuid.NewString()
	insertEmitterFixture(t, pool, tenantID, ownerID, viewerID, 120)
	defer deleteEmitterFixture(t, pool, tenantID)

	fanout := &recordingFanout{}
	emitter := &Emitter{
		Pool:   pool,
		Fanout: fanout,
		Now:    func() time.Time { return time.Now().UTC() },
	}
	if err := emitter.Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	events, recipientSets := fanout.forTenant(tenantID)
	var anomaly, milestone int
	for index, ev := range events {
		switch ev.Type {
		case EventAnomaly:
			anomaly++
			if ev.DedupeKey == "" || ev.URL != "/app/analytics" {
				t.Fatalf("anomaly event = %#v", ev)
			}
			if ev.Payload["metric"] != "bounces" {
				t.Fatalf("anomaly payload = %#v", ev.Payload)
			}
		case EventMilestone:
			milestone++
			if ev.DedupeKey != EventMilestone+":100" {
				t.Fatalf("milestone dedupe key = %q, want the crossed threshold", ev.DedupeKey)
			}
			if ev.Payload["subscribers"] != 120 {
				t.Fatalf("milestone payload = %#v", ev.Payload)
			}
		default:
			continue
		}
		// Only owners/admins are interrupted. A viewer who cannot act on an
		// anomaly should not be woken by one.
		recipients := recipientSets[index]
		if len(recipients) != 1 || recipients[0] != ownerID {
			t.Fatalf("recipients = %v, want only the owner %s", recipients, ownerID)
		}
	}
	if anomaly != 1 {
		t.Fatalf("dispatched %d anomaly notifications, want 1", anomaly)
	}
	if milestone != 1 {
		t.Fatalf("dispatched %d milestone notifications, want 1", milestone)
	}
}

// A stale anomaly is history, not news: outside the window it must not
// interrupt anyone, however many times the sweep runs.
func TestTickIgnoresAnomaliesOutsideTheWindow(t *testing.T) {
	pool := emitterTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	ownerID := uuid.NewString()
	insertEmitterFixture(t, pool, tenantID, ownerID, uuid.NewString(), 5)
	defer deleteEmitterFixture(t, pool, tenantID)

	fanout := &recordingFanout{}
	emitter := &Emitter{
		Pool:          pool,
		Fanout:        fanout,
		AnomalyWindow: time.Minute,
		// The fixture anomaly was detected an hour ago, so a one-minute
		// window must exclude it.
		Now: func() time.Time { return time.Now().UTC() },
	}
	if err := emitter.Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	events, _ := fanout.forTenant(tenantID)
	for _, ev := range events {
		if ev.Type == EventAnomaly {
			t.Fatalf("an anomaly outside the window was dispatched: %#v", ev)
		}
		// 5 subscribers is below the first threshold, so nothing fires there
		// either.
		if ev.Type == EventMilestone {
			t.Fatalf("a milestone fired below the first threshold: %#v", ev)
		}
	}
}

// A tenant with no owner/admin must be skipped without touching its data —
// there is nobody to interrupt.
func TestTickSkipsTenantsWithNoOperators(t *testing.T) {
	pool := emitterTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	viewerID := uuid.NewString()
	insertOperatorlessFixture(t, pool, tenantID, viewerID)
	defer deleteEmitterFixture(t, pool, tenantID)

	fanout := &recordingFanout{}
	emitter := &Emitter{Pool: pool, Fanout: fanout}
	if err := emitter.Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	events, _ := fanout.forTenant(tenantID)
	if len(events) != 0 {
		t.Fatalf("a tenant with no owner/admin was notified: %#v", events)
	}
	for index, uids := range fanout.users {
		for _, uid := range uids {
			if uid == viewerID {
				t.Fatalf("a viewer was notified: %#v", fanout.events[index])
			}
		}
	}
}

// ---------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------

func emitterTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed dashboard signal emitter test")
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

func insertEmitterFixture(t *testing.T, pool *pgxpool.Pool, tenantID, ownerID, viewerID string, subscribers int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Signal emitter test', 'studio')`,
		tenantID, "signal-test-"+tenantID); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`,
		ownerID, tenantID, "signal-owner-"+ownerID, ownerID+"@example.test"); err != nil {
		t.Fatalf("insert owner: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'viewer')`,
		viewerID, tenantID, "signal-viewer-"+viewerID, viewerID+"@example.test"); err != nil {
		t.Fatalf("insert viewer: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO dashboard_anomalies (tenant_id, metric, day_bucket, value, mean, z_score, range_used, detected_at)
VALUES ($1::uuid, 'bounces', current_date, 412, 37.4, 6.1, '30d', now() - interval '1 hour')`, tenantID); err != nil {
		t.Fatalf("insert anomaly: %v", err)
	}
	for i := 0; i < subscribers; i++ {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source) VALUES ($1::uuid, $2, 'enabled', 'import')`,
			tenantID, "signal-"+uuid.NewString()+"@example.test"); err != nil {
			t.Fatalf("insert subscriber %d: %v", i, err)
		}
	}
	// A blocklisted row must not count towards a celebration.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source) VALUES ($1::uuid, $2, 'blocklisted', 'import')`,
		tenantID, "signal-blocked-"+uuid.NewString()+"@example.test"); err != nil {
		t.Fatalf("insert blocklisted subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
}

func insertOperatorlessFixture(t *testing.T, pool *pgxpool.Pool, tenantID, viewerID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Operatorless test', 'studio')`,
		tenantID, "signal-none-"+tenantID); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'viewer')`,
		viewerID, tenantID, "signal-only-viewer-"+viewerID, viewerID+"@example.test"); err != nil {
		t.Fatalf("insert viewer: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO dashboard_anomalies (tenant_id, metric, day_bucket, value, mean, z_score, range_used)
VALUES ($1::uuid, 'bounces', current_date, 99, 4.0, 5.5, '30d')`, tenantID); err != nil {
		t.Fatalf("insert anomaly: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
}

func deleteEmitterFixture(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID)
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	_ = tx.Commit(ctx)
}
