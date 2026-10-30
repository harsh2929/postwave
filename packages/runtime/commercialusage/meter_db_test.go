package commercialusage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestMeterDatabaseContract proves the migrated function through the restricted
// application role. It is opt-in because the test needs both a migrated fixture
// and an administrative connection for isolated fixture setup/cleanup.
func TestMeterDatabaseContract(t *testing.T) {
	appURL := os.Getenv("POSTWAVE_COMMERCIAL_USAGE_TEST_DATABASE_URL")
	adminURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if appURL == "" || adminURL == "" {
		t.Skip("POSTWAVE_COMMERCIAL_USAGE_TEST_DATABASE_URL and POSTWAVE_TEST_ADMIN_DATABASE_URL are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	appPool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	adminPool, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}

	tenantID := randomTestUUID(t)
	slug := "commercial-usage-" + tenantID[24:]
	if _, err := adminPool.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Commercial usage contract', 'launch')`, tenantID, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		defer adminPool.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if _, err := adminPool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
			t.Errorf("cleanup tenant: %v", err)
		}
	})

	meter := &Meter{
		Pool: appPool,
		Now:  func() time.Time { return time.Date(2026, time.September, 23, 0, 0, 0, 0, time.UTC) },
	}
	receipt, err := meter.Reserve(ctx, tenantID, ResourceAPIOperations, 7, "request-1", "db-contract")
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if receipt.Used != 7 || receipt.Replay || receipt.Tier != "launch" {
		t.Fatalf("unexpected first receipt: %+v", receipt)
	}
	replay, err := meter.Reserve(ctx, tenantID, ResourceAPIOperations, 7, "request-1", "db-contract")
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.Replay || replay.Used != 7 {
		t.Fatalf("unexpected replay receipt: %+v", replay)
	}
	if _, err := meter.Reserve(ctx, tenantID, ResourceAPIOperations, 8, "request-1", "db-contract"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("same key with different units: got %v, want ErrIdempotencyConflict", err)
	}

	limit := LimitForTier("launch", ResourceAPIOperations)
	if _, err := adminPool.Exec(ctx, `
UPDATE commercial_usage_buckets
   SET used_units = $1
 WHERE tenant_id = $2::uuid AND period_start = DATE '2026-09-01'
   AND resource = 'api_operations'`, limit-1, tenantID); err != nil {
		t.Fatalf("move fixture to limit edge: %v", err)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, reserveErr := meter.Reserve(ctx, tenantID, ResourceAPIOperations, 1, "", "db-contract-race")
			results <- reserveErr
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	accepted, exceeded := 0, 0
	for reserveErr := range results {
		switch {
		case reserveErr == nil:
			accepted++
		case errors.Is(reserveErr, ErrExceeded):
			exceeded++
		default:
			t.Fatalf("concurrent reserve returned unexpected error: %v", reserveErr)
		}
	}
	if accepted != 1 || exceeded != 1 {
		t.Fatalf("concurrent edge: accepted=%d exceeded=%d, want 1/1", accepted, exceeded)
	}
	var used int64
	if err := adminPool.QueryRow(ctx, `
SELECT used_units FROM commercial_usage_buckets
 WHERE tenant_id = $1::uuid AND period_start = DATE '2026-09-01'
   AND resource = 'api_operations'`, tenantID).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used != limit {
		t.Fatalf("final used=%d want exact limit=%d", used, limit)
	}

	// A workspace can be downgraded after consuming more than the new tier's
	// allowance. The bucket CHECK must remain valid and the next admission must
	// return the domain error instead of surfacing a PostgreSQL constraint error.
	if _, err := adminPool.Exec(ctx, `
UPDATE tenants SET tier = 'sandbox' WHERE id = $1::uuid`, tenantID); err != nil {
		t.Fatalf("downgrade fixture: %v", err)
	}
	if _, err := meter.Reserve(ctx, tenantID, ResourceAPIOperations, 1, "after-downgrade", "db-contract"); !errors.Is(err, ErrExceeded) {
		t.Fatalf("post-downgrade reserve: got %v, want ErrExceeded", err)
	}
	var storedLimit int64
	if err := adminPool.QueryRow(ctx, `
SELECT limit_units FROM commercial_usage_buckets
 WHERE tenant_id = $1::uuid AND period_start = DATE '2026-09-01'
   AND resource = 'api_operations'`, tenantID).Scan(&storedLimit); err != nil {
		t.Fatal(err)
	}
	if storedLimit != limit {
		t.Fatalf("post-downgrade stored limit=%d want invariant-safe %d", storedLimit, limit)
	}

	// No tenant binding means the restricted role sees no rows, proving the
	// function did not weaken the forced RLS contract.
	var visible int
	if err := appPool.QueryRow(ctx, `SELECT count(*) FROM commercial_usage_buckets WHERE tenant_id = $1::uuid`, tenantID).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 0 {
		t.Fatalf("unbound app role saw %d tenant rows", visible)
	}
}

func BenchmarkMeterReserve(b *testing.B) {
	appURL := os.Getenv("POSTWAVE_COMMERCIAL_USAGE_TEST_DATABASE_URL")
	adminURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if appURL == "" || adminURL == "" {
		b.Skip("POSTWAVE_COMMERCIAL_USAGE_TEST_DATABASE_URL and POSTWAVE_TEST_ADMIN_DATABASE_URL are required")
	}
	ctx := context.Background()
	appPool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		b.Fatal(err)
	}
	adminPool, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		appPool.Close()
		b.Fatal(err)
	}
	tenantID := randomTestUUID(b)
	if _, err := adminPool.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Commercial usage benchmark', 'scale')`,
		tenantID, "commercial-bench-"+tenantID[24:]); err != nil {
		appPool.Close()
		adminPool.Close()
		b.Fatal(err)
	}
	b.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := adminPool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
			b.Errorf("cleanup tenant: %v", err)
		}
		appPool.Close()
		adminPool.Close()
	})
	meter := &Meter{Pool: appPool}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := meter.Reserve(ctx, tenantID, ResourceAPIOperations, 1, "", "benchmark"); err != nil {
			b.Fatal(err)
		}
	}
}

func randomTestUUID(t testing.TB) string {
	t.Helper()
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	s := hex.EncodeToString(raw[:])
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}
