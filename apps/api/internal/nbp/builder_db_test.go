// SPDX-License-Identifier: AGPL-3.0-only
//
// builder_db_test.go — DB-backed test for the nbp Builder's two CF passes
// (item-item cosine similarity + recency-weighted user affinity). Skips
// without DATABASE_URL; needs a fully-migrated schema (commerce_* + nbp_*).
// Fixtures live under a throwaway tenant; cleanup is the tenant DELETE
// (commerce_*, subscribers, nbp_* all cascade on tenant_id).
//
// The canonical co-occurrence scenario (4 orders over 4 products) is the
// same one validated by hand against PG16: p1 and p2 always co-occur
// (cosine 1.0), p3+p4 co-occur once (0.707), and s1's affinity for p3 is
// half their top product (recency-normalised raw score).

package nbp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func nbpDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed nbp builder test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func nbpUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

func nbpExec(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, sql string, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func nbpProductUUID(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, sourceID string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM commerce_products WHERE tenant_id=$1::uuid AND source_id=$2`,
		tenantID, sourceID).Scan(&id); err != nil {
		t.Fatalf("product lookup %s: %v", sourceID, err)
	}
	_ = tx.Commit(ctx)
	return id
}

func nbpSubscriberUUID(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, email string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM subscribers WHERE tenant_id=$1::uuid AND lower(email)=lower($2)`,
		tenantID, email).Scan(&id); err != nil {
		t.Fatalf("subscriber lookup %s: %v", email, err)
	}
	_ = tx.Commit(ctx)
	return id
}

// TestBuilderCFPasses seeds the canonical 4-order scenario and asserts the
// builder materialises the expected item-similarity + user-affinity rows,
// read back through the same Repo methods the recommender uses.
func TestBuilderCFPasses(t *testing.T) {
	pool := nbpDB(t)
	ctx := context.Background()
	tenantID := nbpUUID(t)
	integrationID := nbpUUID(t)

	// Tenant (no GUC needed for the tenants insert; create directly).
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid,$2,$2,'studio')`,
		tenantID, "nbp-"+tenantID[:8]); err != nil {
		t.Fatalf("tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ctx2, err := db.WithTenant(c, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = ctx2.Rollback(c) }()
		_, _ = ctx2.Exec(c, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = ctx2.Commit(c)
	})

	nbpExec(t, ctx, pool, tenantID,
		`INSERT INTO commerce_integrations (id, tenant_id, provider) VALUES ($1::uuid,$2::uuid,'shopify')`,
		integrationID, tenantID)
	for _, sid := range []string{"p1", "p2", "p3", "p4"} {
		nbpExec(t, ctx, pool, tenantID, `
INSERT INTO commerce_products (id, tenant_id, integration_id, source_id, title)
VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $3)`, tenantID, integrationID, sid)
	}
	for _, em := range []string{"s1@x.com", "s2@x.com"} {
		nbpExec(t, ctx, pool, tenantID, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES (gen_random_uuid(), $1::uuid, $2, 'enabled', 'api')`, tenantID, em)
	}
	orders := []struct {
		src, email, items string
	}{
		{"o1", "s1@x.com", `[{"product_id":"p1"},{"product_id":"p2"}]`},
		{"o2", "s1@x.com", `[{"product_id":"p1"},{"product_id":"p2"},{"product_id":"p3"}]`},
		{"o3", "s2@x.com", `[{"product_id":"p1"},{"product_id":"p2"}]`},
		{"o4", "s2@x.com", `[{"product_id":"p3"},{"product_id":"p4"}]`},
	}
	for _, o := range orders {
		nbpExec(t, ctx, pool, tenantID, `
INSERT INTO commerce_orders (id, tenant_id, integration_id, source_id, customer_email, line_items, created_at)
VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::jsonb, now())`,
			tenantID, integrationID, o.src, o.email, o.items)
	}

	repo := &Repo{Pool: pool}
	if _, err := repo.UpsertSettings(ctx, tenantID, Settings{Enabled: true, RecencyExcludeDays: 730,
		TopNPerUser: 6, SimilarityFloor: 0.05, RefreshIntervalHours: 24, BloomTargetFPR: 0.01, ModelVersion: 1}); err != nil {
		t.Fatalf("upsert settings: %v", err)
	}

	if err := NewBuilder(repo).RunForTenant(ctx, tenantID); err != nil {
		t.Fatalf("RunForTenant: %v", err)
	}

	// Item similarity: p1's top neighbor is p2 at cosine 1.0 (always co-bought).
	p1 := nbpProductUUID(t, ctx, pool, tenantID, "p1")
	p2 := nbpProductUUID(t, ctx, pool, tenantID, "p2")
	neighbors, err := repo.NeighborsOf(ctx, tenantID, p1, 10, 0.05)
	if err != nil {
		t.Fatalf("NeighborsOf: %v", err)
	}
	if len(neighbors) == 0 {
		t.Fatal("expected similarity neighbors for p1, got none")
	}
	if neighbors[0].NeighborProductID != p2 {
		t.Fatalf("p1's top neighbor should be p2, got %s", neighbors[0].NeighborProductID)
	}
	if neighbors[0].Similarity < 0.999 || neighbors[0].Support != 3 {
		t.Fatalf("p1↔p2 should be sim~1.0 support 3, got sim=%v support=%d",
			neighbors[0].Similarity, neighbors[0].Support)
	}

	// User affinity: s1 bought p1/p2 twice (score 1.0) and p3 once (score 0.5).
	s1 := nbpSubscriberUUID(t, ctx, pool, tenantID, "s1@x.com")
	aff, err := repo.TopAffinities(ctx, tenantID, s1, 10)
	if err != nil {
		t.Fatalf("TopAffinities: %v", err)
	}
	byProduct := map[string]UserAffinity{}
	for _, a := range aff {
		byProduct[a.ProductID] = a
	}
	if got := byProduct[p1]; got.Score < 0.999 || got.PurchaseCount != 2 {
		t.Fatalf("s1 affinity p1 should be 1.0/count2, got %+v", got)
	}
	p3 := nbpProductUUID(t, ctx, pool, tenantID, "p3")
	if got := byProduct[p3]; got.Score < 0.49 || got.Score > 0.51 || got.PurchaseCount != 1 {
		t.Fatalf("s1 affinity p3 should be ~0.5/count1, got %+v", got)
	}
}
