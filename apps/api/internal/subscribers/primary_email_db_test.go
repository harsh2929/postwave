// SPDX-License-Identifier: AGPL-3.0-only
//
// primary_email_db_test.go — pg-backed test for SUB-016: subscribers.primary_email
// round-trips through the SELECT/scan path (Subscriber.PrimaryEmail) and is
// maintained by the canonical subscriber-email update path. Skips cleanly without
// DATABASE_URL, matching the project-wide pg-backed test convention.

package subscribers

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newPrimaryEmailTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed primary_email test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedPrimaryEmailTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'primary-email-test', 'primary-email-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestPrimaryEmail_RoundTrips pins SUB-016 end-to-end:
//  1. A subscriber created via Upsert carries primary_email == email
//     (the migration-0452 backfill convention applied on insert), and that
//     value survives the SELECT/scan into Subscriber.PrimaryEmail.
//  2. Get hydrates PrimaryEmail too.
//  3. Adding a secondary address does not change delivery identity.
//  4. Rotating the canonical subscriber email to that reviewed address
//     re-points subscribers.email + primary_email and the junction truth.
func TestPrimaryEmail_RoundTrips(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41160"
	seedPrimaryEmailTenant(t, pool, tenantID)

	r := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	primary := fmt.Sprintf("primary-%d@example.test", suffix)

	created, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: primary,
	})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if created.PrimaryEmail != primary {
		t.Fatalf("after Upsert PrimaryEmail = %q, want %q", created.PrimaryEmail, primary)
	}

	got, err := r.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.PrimaryEmail != primary {
		t.Fatalf("after Get PrimaryEmail = %q, want %q", got.PrimaryEmail, primary)
	}

	// A secondary-address mutation is never allowed to impersonate the
	// canonical delivery-identity editor.
	second := fmt.Sprintf("second-%d@example.test", suffix)
	added, err := r.AddEmail(ctx, tenantID, created.ID, AddEmailInput{
		Email: second,
	}, db.AuditMeta{TenantID: tenantID, ActorType: "system", ActorLabel: "primary-email-test"})
	if err != nil {
		t.Fatalf("AddEmail: %v", err)
	}
	if added.IsPrimary {
		t.Fatalf("secondary address IsPrimary = true, want false")
	}
	beforeRotation, err := r.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("Get before canonical rotation: %v", err)
	}
	if beforeRotation.Email != primary || beforeRotation.PrimaryEmail != primary {
		t.Fatalf("secondary add changed delivery identity: email=%q primary_email=%q", beforeRotation.Email, beforeRotation.PrimaryEmail)
	}

	rotated, err := r.Update(ctx, tenantID, created.ID, UpdateInput{Email: &second})
	if err != nil {
		t.Fatalf("Update canonical email: %v", err)
	}
	if rotated.Email != second || rotated.PrimaryEmail != second {
		t.Fatalf("rotated identity = email %q primary_email %q, want %q", rotated.Email, rotated.PrimaryEmail, second)
	}

	reGot, err := r.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("Get after set-primary: %v", err)
	}
	if reGot.Email != second || reGot.PrimaryEmail != second {
		t.Fatalf("after canonical rotation email=%q PrimaryEmail=%q, want %q", reGot.Email, reGot.PrimaryEmail, second)
	}
	emails, err := r.ListEmails(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("ListEmails after canonical rotation: %v", err)
	}
	if len(emails) != 2 || !emails[0].IsPrimary || emails[0].Email != second {
		t.Fatalf("junction primary truth = %#v, want %q first and primary", emails, second)
	}
}
