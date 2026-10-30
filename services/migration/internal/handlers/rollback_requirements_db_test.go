package handlers

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

func TestDBRollbackNeedsListmonkOnlyForActiveExternalResources(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if appURL == "" {
		appURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and TEST_DATABASE_URL/DATABASE_URL are required")
	}

	ctx := context.Background()
	admin, err := sql.Open("pgx", adminURL)
	if err != nil {
		t.Fatalf("open admin database: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	app, err := sql.Open("pgx", appURL)
	if err != nil {
		t.Fatalf("open application database: %v", err)
	}
	t.Cleanup(func() { _ = app.Close() })
	if err := admin.PingContext(ctx); err != nil {
		t.Fatalf("ping admin database: %v", err)
	}
	if err := app.PingContext(ctx); err != nil {
		t.Fatalf("ping application database: %v", err)
	}
	var appRole string
	if err := app.QueryRowContext(ctx, `SELECT current_user`).Scan(&appRole); err != nil {
		t.Fatalf("read application role: %v", err)
	}
	if appRole != "postwave_app" {
		t.Skipf("application connection uses %q, want postwave_app", appRole)
	}

	tenantID := uuid.NewString()
	jobID := uuid.NewString()
	_, err = admin.ExecContext(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Rollback requirements test', 'studio')`, tenantID, "rollback-requirements-"+uuid.NewString())
	if err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	_, err = admin.ExecContext(ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status)
VALUES ($1::uuid, $2::uuid, 'mailchimp', 'completed')`, jobID, tenantID)
	if err != nil {
		t.Fatalf("create migration job: %v", err)
	}

	_, err = admin.ExecContext(ctx, `
INSERT INTO migration_imported_resources
       (tenant_id, job_id, resource_type, source_platform, source_id,
        destination_type, destination_id, destination_metadata)
VALUES ($1::uuid, $2::uuid, $3, 'mailchimp', 'segment-a',
        $4, $5, '{"operation":"created"}'::jsonb)`,
		tenantID, jobID, listmonkx.ResourceSegment, listmonkx.DestinationPostwaveSegment, uuid.NewString())
	if err != nil {
		t.Fatalf("create Postgres-only rollback ledger: %v", err)
	}

	h := &Migration{db: app}
	job := migrationJobForRollbackRequirement(jobID, tenantID)
	needsListmonk, err := h.rollbackNeedsListmonk(ctx, job)
	if err != nil {
		t.Fatalf("inspect Postgres-only rollback: %v", err)
	}
	if needsListmonk {
		t.Fatal("Postgres-only rollback unexpectedly requires Listmonk credentials")
	}

	var subscriberLedgerID string
	err = admin.QueryRowContext(ctx, `
INSERT INTO migration_imported_resources
       (tenant_id, job_id, resource_type, source_platform, source_id,
        destination_type, destination_id, destination_metadata)
VALUES ($1::uuid, $2::uuid, $3, 'mailchimp', 'subscriber-a',
        $4, '71', '{"operation":"created"}'::jsonb)
RETURNING id::text`,
		tenantID, jobID, listmonkx.ResourceSubscriber, listmonkx.DestinationListmonkSubscriber).Scan(&subscriberLedgerID)
	if err != nil {
		t.Fatalf("create external rollback ledger: %v", err)
	}
	needsListmonk, err = h.rollbackNeedsListmonk(ctx, job)
	if err != nil {
		t.Fatalf("inspect external rollback: %v", err)
	}
	if !needsListmonk {
		t.Fatal("active subscriber rollback must require Listmonk credentials")
	}

	_, err = admin.ExecContext(ctx, `
UPDATE migration_imported_resources
   SET rolled_back_at = now()
 WHERE id = $1::uuid`, subscriberLedgerID)
	if err != nil {
		t.Fatalf("mark subscriber ledger rolled back: %v", err)
	}
	needsListmonk, err = h.rollbackNeedsListmonk(ctx, job)
	if err != nil {
		t.Fatalf("inspect completed external rollback: %v", err)
	}
	if needsListmonk {
		t.Fatal("already-rolled-back subscriber ledger unexpectedly requires Listmonk credentials")
	}
}

func migrationJobForRollbackRequirement(jobID, tenantID string) *canonical.MigrationJob {
	return &canonical.MigrationJob{ID: jobID, TenantID: tenantID}
}
