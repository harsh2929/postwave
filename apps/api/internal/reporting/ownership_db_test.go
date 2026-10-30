// SPDX-License-Identifier: AGPL-3.0-only
package reporting

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A saved report must record who saved it.
//
// `report_definitions.owner_user_id` existed in the schema and was referenced by
// ZERO Go code — no INSERT wrote it, no SELECT read it. So every saved report
// was anonymous: the library could not show "my reports", an audit could not say
// who created a definition that queries customer data, and when someone left
// there was no way to find what they built. This test holds the insert to it.
//
// The column was declared for exactly this and then never wired, which is the
// pattern this ledger keeps finding: the schema states an intent the code never
// carried out, and the absence looks like a missing feature rather than an
// unfinished one.

func newReportingPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedReportingTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'reporting', 'studio')`,
		tenantID, "rep-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	// A registered metric, so Validate accepts the definition. The registry is
	// per-tenant, so this seeds the tenant's own.
	if _, err := tx.Exec(ctx, `
		INSERT INTO report_metric_registry (tenant_id, key, label, product_area, source, aggregation, value_type)
		VALUES ($1::uuid, 'campaign.sent', 'Sent', 'campaign', 'campaign_events', 'count', 'number')`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed metric: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		c, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(context.Background()) }()
		for _, q := range []string{
			`DELETE FROM report_definitions WHERE tenant_id = $1::uuid`,
			`DELETE FROM report_metric_registry WHERE tenant_id = $1::uuid`,
			`DELETE FROM users WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			if _, err := c.Exec(context.Background(), q, tenantID); err != nil {
				return
			}
		}
		_ = c.Commit(context.Background())
	})
	return tenantID
}

// seedReportingUser creates a real workspace member and returns their id.
//
// Migration 1916 gave `owner_user_id` the foreign key to `users(id)` that every
// other user-attribution column in this schema already had, so the owner has to
// be a user who actually exists. That is the point of the constraint, and it
// also makes this test truthful: a fabricated uuid was never a value the API
// could produce — the session, API-key and dev-header paths all derive the id
// from a users row.
func seedReportingUser(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO users (tenant_id, email, role) VALUES ($1::uuid, $2, 'admin')
		RETURNING id::text`,
		tenantID, "reporter-"+uuid.NewString()[:8]+"@example.test").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit user: %v", err)
	}
	return userID
}

func TestASavedReportRecordsItsOwner(t *testing.T) {
	pool := newReportingPool(t)
	tenantID := seedReportingTenant(t, pool)
	userID := seedReportingUser(t, pool, tenantID)
	repo := &Repo{Pool: pool}

	out, err := repo.UpsertDefinition(context.Background(), tenantID, ReportRequest{
		Name:        "Weekly opens",
		ProductArea: "campaign",
		Metrics:     []MetricSpec{{Key: "campaign.sent"}},
		Dimensions:  []string{},
	}, userID)
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if out == nil {
		t.Fatal("no definition returned")
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner *string
	if err := tx.QueryRow(ctx, `
		SELECT owner_user_id::text FROM report_definitions WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, out.ID).Scan(&owner); err != nil {
		t.Fatalf("read owner: %v", err)
	}
	if owner == nil || *owner != userID {
		t.Fatalf("owner_user_id = %v, want %s. Without it the library cannot show "+
			"\"my reports\", an audit cannot say who built a definition that queries "+
			"customer data, and a departing colleague's work is unfindable.",
			owner, userID)
	}
}

func TestAnAnonymousSaveIsStillAllowed(t *testing.T) {
	// API-key and automation callers have no user. Requiring an owner would
	// break them, and a report saved by an integration is legitimately ownerless
	// — NULL says that honestly where a synthetic id would lie.
	pool := newReportingPool(t)
	tenantID := seedReportingTenant(t, pool)
	repo := &Repo{Pool: pool}

	out, err := repo.UpsertDefinition(context.Background(), tenantID, ReportRequest{
		Name:        "Automated digest",
		ProductArea: "campaign",
		Metrics:     []MetricSpec{{Key: "campaign.sent"}},
		Dimensions:  []string{},
	}, "")
	if err != nil {
		t.Fatalf("upsert without a user: %v", err)
	}
	if out == nil {
		t.Fatal("no definition returned")
	}
}
