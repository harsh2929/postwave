// SPDX-License-Identifier: AGPL-3.0-only
//
// federation_hydrate_db_test.go — pg-backed test for SUB-023: the detail GET
// hydrates Subscriber.FederatedMasterID from federated_subscriber_map, and the
// repo helper GetFederatedMasterID returns "" for a non-federated subscriber.
// Skips cleanly without DATABASE_URL, matching the project-wide pg-backed test
// convention.

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newFedHydrateTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed federation hydrate test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedFedHydrateTenant(t *testing.T, pool *pgxpool.Pool, tenantID, slug string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $2, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedFedHydrateSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

// TestGet_HydratesFederatedMasterID pins SUB-023: with a federation link in
// place, the detail GET surfaces federated_master_id; without one it is
// omitted. We insert the link row directly (tenant-scoped) rather than via
// CreateFederationLink so the test does not depend on the agency-parent
// verification path — the hydration read is what's under test.
func TestGet_HydratesFederatedMasterID(t *testing.T) {
	pool := newFedHydrateTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	const childTenant = "00000000-0000-4000-8000-0099a2c41300"
	const parentTenant = "00000000-0000-4000-8000-0099a2c41301"
	seedFedHydrateTenant(t, pool, parentTenant, "fed-hydrate-parent")
	seedFedHydrateTenant(t, pool, childTenant, "fed-hydrate-child")

	suffix := time.Now().UnixNano()
	childID := seedFedHydrateSubscriber(t, pool, childTenant, fmt.Sprintf("fed-child-%d@example.test", suffix))
	masterID := seedFedHydrateSubscriber(t, pool, parentTenant, fmt.Sprintf("fed-master-%d@example.test", suffix))

	// Insert the federation link directly under the child tenant scope.
	tx, err := db.WithTenant(ctx, pool, childTenant)
	if err != nil {
		t.Fatalf("link tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO federated_subscriber_map
    (tenant_id, child_subscriber_id, parent_tenant_id, master_subscriber_id, match_type, match_key)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'manual', '')`,
		childTenant, childID, parentTenant, masterID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert federation link: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit federation link: %v", err)
	}

	d := &Deps{Repo: &Repo{Pool: pool}}

	// Detail GET hydrates federated_master_id.
	r := httptest.NewRequest("GET", "/api/v1/subscribers/"+childID, nil)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", childID)
	r = r.WithContext(middleware.WithTenant(context.WithValue(ctx, chi.RouteCtxKey, rc), &middleware.Tenant{ID: childTenant}))
	w := httptest.NewRecorder()
	d.Get(w, r)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var got Subscriber
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode subscriber: %v", err)
	}
	if got.FederatedMasterID == nil || *got.FederatedMasterID != masterID {
		t.Fatalf("FederatedMasterID = %v, want %q", got.FederatedMasterID, masterID)
	}

	// A non-federated subscriber yields "" from the repo helper and an omitted
	// field on the GET.
	otherID := seedFedHydrateSubscriber(t, pool, childTenant, fmt.Sprintf("fed-plain-%d@example.test", suffix))
	master, err := d.Repo.GetFederatedMasterID(ctx, childTenant, otherID)
	if err != nil {
		t.Fatalf("GetFederatedMasterID (non-federated): %v", err)
	}
	if master != "" {
		t.Fatalf("non-federated master id = %q, want empty", master)
	}
}
