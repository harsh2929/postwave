// SPDX-License-Identifier: AGPL-3.0-only

package sendingsettings

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const deliverabilityOverrideSettingsTestTenantID = "00000000-0000-4000-8000-203600000001"

func TestUpsertCannotStrandActiveDeliverabilityOverride_DB(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping active override DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	var migrated bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.deliverability_repair_overrides_one_active_per_tenant_uidx') IS NOT NULL
   AND to_regclass('public.tenant_sending_cap_mutation_receipts') IS NOT NULL`).Scan(&migrated); err != nil {
		t.Fatalf("inspect migrations: %v", err)
	}
	if !migrated {
		t.Fatal("deliverability throttle and cap receipt migrations are not applied")
	}

	seed, err := db.WithTenant(ctx, pool, deliverabilityOverrideSettingsTestTenantID)
	if err != nil {
		t.Fatalf("begin seed: %v", err)
	}
	defer func() { _ = seed.Rollback(ctx) }()
	if _, err := seed.Exec(ctx, `DELETE FROM tenants WHERE id=$1::uuid`, deliverabilityOverrideSettingsTestTenantID); err != nil {
		t.Fatalf("clean fixture: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'settings-active-override-test', 'settings-active-override-test', 'studio')`,
		deliverabilityOverrideSettingsTestTenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenant_sending_settings
    (tenant_id, max_sends_per_hour, quiet_hours_per_recipient, updated_at)
VALUES ($1::uuid, 4000, true, $2)`, deliverabilityOverrideSettingsTestTenantID,
		time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO deliverability_repair_overrides
    (tenant_id, prior_max_sends_per_hour, throttled_max_sends_per_hour, reason)
VALUES ($1::uuid, 8000, 4000, 'test active repair')`, deliverabilityOverrideSettingsTestTenantID); err != nil {
		t.Fatalf("seed active override: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, deliverabilityOverrideSettingsTestTenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, deliverabilityOverrideSettingsTestTenantID)
		_ = cleanup.Commit(cleanupCtx)
	})

	repo := &Repo{Pool: pool}
	coordinator := &fakeCapCache{}
	replacement := 3000
	_, lease, err := repo.Upsert(ctx, Settings{
		TenantID:               deliverabilityOverrideSettingsTestTenantID,
		MaxSendsPerHour:        &replacement,
		QuietHoursPerRecipient: true,
	}, UpsertOptions{CapCoordinator: coordinator})
	if !errors.Is(err, ErrDeliverabilityThrottleActive) {
		t.Fatalf("cap-changing upsert error=%v, want ErrDeliverabilityThrottleActive", err)
	}
	if lease.Token != "" || len(coordinator.beginTenantIDs) != 0 {
		t.Fatalf("rejected change opened cap fence lease=%+v begin=%v", lease, coordinator.beginTenantIDs)
	}

	verifyRejected, err := db.WithTenant(ctx, pool, deliverabilityOverrideSettingsTestTenantID)
	if err != nil {
		t.Fatalf("begin rejection verification: %v", err)
	}
	var capValue, receipts int
	if err := verifyRejected.QueryRow(ctx, `
SELECT (SELECT max_sends_per_hour FROM tenant_sending_settings WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM tenant_sending_cap_mutation_receipts WHERE tenant_id=$1::uuid)`,
		deliverabilityOverrideSettingsTestTenantID).Scan(&capValue, &receipts); err != nil {
		_ = verifyRejected.Rollback(ctx)
		t.Fatalf("verify rejected mutation: %v", err)
	}
	if err := verifyRejected.Commit(ctx); err != nil {
		t.Fatalf("commit rejection verification: %v", err)
	}
	if capValue != 4000 || receipts != 0 {
		t.Fatalf("rejected mutation cap=%d receipts=%d, want 4000/0", capValue, receipts)
	}

	// A PUT that preserves the exact cap does not steal ownership from the
	// repair episode and may still update unrelated quiet-hours policy.
	installed := 4000
	out, lease, err := repo.Upsert(ctx, Settings{
		TenantID:               deliverabilityOverrideSettingsTestTenantID,
		MaxSendsPerHour:        &installed,
		QuietHoursStart:        "22:00",
		QuietHoursEnd:          "07:00",
		QuietHoursTZ:           "UTC",
		QuietHoursPerRecipient: true,
	}, UpsertOptions{CapCoordinator: coordinator})
	if err != nil {
		t.Fatalf("cap-preserving quiet-hours upsert: %v", err)
	}
	if out.MaxSendsPerHour == nil || *out.MaxSendsPerHour != installed ||
		out.QuietHoursStart != "22:00" || lease.Token == "" || len(coordinator.beginTenantIDs) != 1 {
		t.Fatalf("cap-preserving result=%+v lease=%+v begin=%v", out, lease, coordinator.beginTenantIDs)
	}
}
