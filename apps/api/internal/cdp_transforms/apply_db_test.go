// SPDX-License-Identifier: AGPL-3.0-only
//
// apply_db_test.go — DB-backed tests for the bulk transform apply. Skip without
// DATABASE_URL (needs a fully-migrated schema incl. cdp_transform_runs). The
// SQL plumbing was also hand-verified on PG16; this is the CI regression guard.

package cdp_transforms

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

func applyDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed cdp_transforms test")
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

func applyUUID(t *testing.T) string {
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

func applyExec(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, sql string, args ...any) {
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

func customFieldName(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, id string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var name string
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(custom_fields->>'name','') FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`,
		tenantID, id).Scan(&name); err != nil {
		t.Fatalf("read name: %v", err)
	}
	_ = tx.Commit(ctx)
	return name
}

func seedTenantAndSub(t *testing.T, ctx context.Context, pool *db.Pool, name string) (tenantID, subID string) {
	t.Helper()
	tenantID = applyUUID(t)
	subID = applyUUID(t)
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid,$2,$2,'studio')`,
		tenantID, "cdp-"+tenantID[:8]); err != nil {
		t.Fatalf("tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx2, err := db.WithTenant(c, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx2.Rollback(c) }()
		_, _ = tx2.Exec(c, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = tx2.Commit(c)
	})
	applyExec(t, ctx, pool, tenantID, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source, custom_fields)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api', $4::jsonb)`,
		subID, tenantID, subID[:8]+"@x.com", `{"name":"  `+name+`  "}`)
	return tenantID, subID
}

// TestRunApply_WritesBackAndAudits applies a trim op and asserts the property is
// trimmed in the DB and a non-dry-run audit row is recorded.
func TestRunApply_WritesBackAndAudits(t *testing.T) {
	pool := applyDB(t)
	ctx := context.Background()
	tenantID, subID := seedTenantAndSub(t, ctx, pool, "Jo")

	d := &Deps{Pool: pool}
	resp, err := d.runApply(ctx, tenantID, applyRequest{
		Ops:           []Op{{Type: "trim", Field: "name"}},
		SubscriberIDs: []string{subID},
		DryRun:        false,
	})
	if err != nil {
		t.Fatalf("runApply: %v", err)
	}
	if resp.Total != 1 || resp.Changed != 1 || resp.DryRun {
		t.Fatalf("unexpected summary: %+v", resp)
	}
	if got := customFieldName(t, ctx, pool, tenantID, subID); got != "Jo" {
		t.Fatalf("expected trimmed name 'Jo', got %q", got)
	}
	// Audit run recorded.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var runs int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM cdp_transform_runs WHERE tenant_id=$1::uuid`, tenantID).Scan(&runs); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	_ = tx.Commit(ctx)
	if runs != 1 {
		t.Fatalf("expected 1 audit run, got %d", runs)
	}
}

// TestRunApply_DryRunDoesNotWrite verifies dry_run computes the change + audits
// it but leaves the subscriber untouched.
func TestRunApply_DryRunDoesNotWrite(t *testing.T) {
	pool := applyDB(t)
	ctx := context.Background()
	tenantID, subID := seedTenantAndSub(t, ctx, pool, "Al")

	d := &Deps{Pool: pool}
	resp, err := d.runApply(ctx, tenantID, applyRequest{
		Ops:           []Op{{Type: "trim", Field: "name"}},
		SubscriberIDs: []string{subID},
		DryRun:        true,
	})
	if err != nil {
		t.Fatalf("runApply: %v", err)
	}
	if !resp.DryRun || resp.Changed != 1 {
		t.Fatalf("dry-run summary wrong: %+v", resp)
	}
	// The stored value is still the untrimmed original.
	if got := customFieldName(t, ctx, pool, tenantID, subID); got != "  Al  " {
		t.Fatalf("dry-run must not write; got %q", got)
	}
}
