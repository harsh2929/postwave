// SPDX-License-Identifier: AGPL-3.0-only

package sendallowance

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

func TestManagedPlanClassification(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		tier    string
		managed bool
		cap     int
	}{
		{tier: "launch", managed: true, cap: 25_000},
		{tier: "growth", managed: true, cap: 100_000},
		{tier: "scale", managed: true, cap: 500_000},
		{tier: "sending", managed: true, cap: 25_000},
		{tier: "pro", managed: true, cap: 500_000},
		{tier: "studio", managed: false},
		{tier: "unknown", managed: true},
	} {
		managed, cap := limits.ManagedMonthlySendAllowance(tc.tier)
		if managed != tc.managed || cap != tc.cap {
			t.Fatalf("tier %q = managed %v cap %d, want %v/%d", tc.tier, managed, cap, tc.managed, tc.cap)
		}
	}
}

func TestNormalizeRequestRejectsMissingDurableIdentity(t *testing.T) {
	t.Parallel()
	_, err := normalizeRequest(Request{TenantID: uuid.NewString(), Source: "campaign", RecipientIDs: []string{"a@example.test"}})
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing key error = %v, want ErrUnavailable", err)
	}
}

func TestMigrationContainsImmutableTenantScopedLedger(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/2065_managed_send_allowance.sql")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, required := range []string{
		"CHECK (reserved_units + committed_units <= allowance_units)",
		"UNIQUE (tenant_id, period_start, reservation_key)",
		"FOREIGN KEY (reservation_id, tenant_id)",
		"state = 'committed' AND committed_at IS NOT NULL",
		"managed_send_allowance_recipients_immutable",
		"managed_send_allowance_events_immutable",
		"FORCE ROW LEVEL SECURITY",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("migration missing %q", required)
		}
	}
}

// TestConcurrentReservationsNeverCrossCap_DB proves the database row lock, not
// a process mutex, is the serialization authority. Run against a migration-head
// database with TEST_DATABASE_URL or DATABASE_URL.
func TestConcurrentReservationsNeverCrossCap_DB(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("no database URL; skipping managed allowance concurrency proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('managed_send_allowance_buckets') IS NOT NULL`).Scan(&ready); err != nil || !ready {
		if err != nil {
			t.Fatalf("inspect managed allowance migration: %v", err)
		}
		t.Fatal("configured database has not applied migration 2065")
	}

	tenantID := uuid.NewString()
	suffix := strings.ReplaceAll(tenantID, "-", "")[:12]
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id,slug,name,tier) VALUES ($1::uuid,$2,$2,'sending')`, tenantID, "allowance-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO billing_state (tenant_id,tier) VALUES ($1::uuid,'sending')`, tenantID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cleanupErr := db.WithTenant(context.Background(), pool, tenantID)
		if cleanupErr == nil {
			_, cleanupErr = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
			if cleanupErr == nil {
				cleanupErr = cleanup.Commit(context.Background())
			} else {
				_ = cleanup.Rollback(context.Background())
			}
		}
		if cleanupErr != nil {
			t.Errorf("cleanup: %v", cleanupErr)
		}
	})

	service := &Service{Pool: pool, Resolve: func(string) (bool, int) { return true, 2 }}
	start := make(chan struct{})
	results := make(chan error, 3)
	reservations := make(chan Reservation, 3)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			reservation, reserveErr := service.Reserve(ctx, Request{
				TenantID: tenantID, Key: "concurrent:" + string(rune('a'+index)),
				Source: "test", SourceRef: "row", RecipientIDs: []string{"recipient@example.test"},
			})
			if reserveErr == nil {
				reservations <- reservation
			}
			results <- reserveErr
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	close(reservations)
	accepted, exhausted := 0, 0
	var acceptedReservations []Reservation
	for result := range results {
		switch {
		case result == nil:
			accepted++
		case errors.Is(result, ErrExhausted):
			exhausted++
		default:
			t.Fatalf("unexpected reserve error: %v", result)
		}
	}
	for reservation := range reservations {
		acceptedReservations = append(acceptedReservations, reservation)
	}
	if accepted != 2 || exhausted != 1 {
		t.Fatalf("accepted/exhausted = %d/%d, want 2/1", accepted, exhausted)
	}
	for _, reservation := range acceptedReservations {
		if err := service.Commit(ctx, reservation); err != nil {
			t.Fatalf("commit: %v", err)
		}
	}

	replayed, err := service.Reserve(ctx, Request{
		TenantID: tenantID, Key: acceptedReservations[0].ID, Source: "test",
		SourceRef: "wrong-key-check", RecipientIDs: []string{"recipient@example.test"},
	})
	if err == nil || replayed.Managed {
		// A distinct key is still exhausted; this assertion also protects the
		// test from accidentally treating reservation IDs as idempotency keys.
		t.Fatalf("distinct key at cap = %+v, %v; want exhausted", replayed, err)
	}
	if !errors.Is(err, ErrExhausted) {
		t.Fatalf("distinct key error = %v, want exhausted", err)
	}

	if err := service.Release(ctx, acceptedReservations[0], "definitely_not_sent"); err != nil {
		t.Fatalf("release: %v", err)
	}
	third, err := service.Reserve(ctx, Request{
		TenantID: tenantID, Key: "after-release", Source: "test", SourceRef: "row-4",
		RecipientIDs: []string{"recipient-4@example.test"},
	})
	if err != nil || !third.Managed {
		t.Fatalf("reserve after release = %+v, %v", third, err)
	}
	replay, err := service.Reserve(ctx, Request{
		TenantID: tenantID, Key: "after-release", Source: "test", SourceRef: "row-4",
		RecipientIDs: []string{"recipient-4@example.test"},
	})
	if err != nil || !replay.Replayed || replay.ID != third.ID || replay.State != "reserved" {
		t.Fatalf("idempotent replay = %+v, %v; want same reserved identity", replay, err)
	}
	collision, err := service.Reserve(ctx, Request{
		TenantID: tenantID, Key: "after-release", Source: "test", SourceRef: "row-4",
		RecipientIDs: []string{"different-recipient@example.test"},
	})
	if !errors.Is(err, ErrUnavailable) || collision.Managed {
		t.Fatalf("changed recipient replay = %+v, %v; want unavailable", collision, err)
	}
	if err := service.Release(ctx, third, "definitely_not_sent"); err != nil {
		t.Fatalf("release second reservation: %v", err)
	}
	if err := service.Commit(ctx, third); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("commit stale released reservation = %v, want unavailable", err)
	}
}
