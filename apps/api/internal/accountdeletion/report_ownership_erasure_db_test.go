// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A fulfilled account deletion must not leave the deleted user's id behind.
//
// The worker states its own contract in a comment above the scrub list:
//
//	These tables intentionally lack user FKs or retain human-readable author
//	labels. Delete personal state and scrub direct attribution BEFORE the
//	users-row cascade removes ... FK-owned state.
//
// So there are exactly two ways a column holding a user id is covered: a
// foreign key to users(id) that CASCADEs or SET NULLs, or an explicit statement
// in that list. `report_definitions.owner_user_id` has neither — `\d
// report_definitions` shows one foreign key, to tenants — and it is not named
// in the worker.
//
// That was harmless while nothing wrote the column. It is not harmless now:
// the column is written from the request's user on every save, so a user who
// exercises their right to erasure has their identifier retained in
// report_definitions indefinitely, while the worker writes
// `account.self_deletion_fulfilled` to the audit log and the certificate says
// the deletion completed. The claim outruns the deletion.
//
// Every sibling column in this schema already does the right thing —
// `campaign_ai_summaries.generated_by_user_id`, `saved_segments.created_by_user_id`,
// `approval_escalation_policies.updated_by_user_id` are all
// `REFERENCES users(id) ON DELETE SET NULL`. This asserts report ownership
// behaves the same, and it drives the real worker rather than a hand-rolled
// DELETE so that the path a regulator would ask about is the path under test.

func newDeletionPool(t *testing.T) *db.Pool {
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

func TestAccountDeletionClearsSavedReportOwnership(t *testing.T) {
	pool := newDeletionPool(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	remainingOwnerID := uuid.NewString()
	subjectUserID := uuid.NewString()
	definitionID := uuid.NewString()
	requestID := "pr-" + uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1::uuid, $2, 'report ownership erasure', 'studio')`,
		tenantID, "rpo-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	// A second owner so the interlock does not block the deletion — this test is
	// about residue after a deletion that succeeds, not about refusing one.
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, tenant_id, email, role)
		VALUES ($1::uuid, $3::uuid, $4, 'owner'), ($2::uuid, $3::uuid, $5, 'admin')`,
		remainingOwnerID, subjectUserID, tenantID,
		"owner-"+tenantID[:8]+"@example.test", "leaver-"+tenantID[:8]+"@example.test"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed users: %v", err)
	}
	// The report the leaver saved. Written exactly as UpsertDefinition writes it.
	if _, err := tx.Exec(ctx, `
		INSERT INTO report_definitions (id, tenant_id, name, product_area, owner_user_id)
		VALUES ($1::uuid, $2::uuid, 'Weekly opens', 'campaign', $3::uuid)`,
		definitionID, tenantID, subjectUserID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed report definition: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO privacy_requests
			(id, tenant_id, request_type, region, status, subject_type, subject_user_id,
			 requested_at, due_at)
		VALUES ($1, $2::uuid, 'account_deletion', 'GDPR', 'queued', 'account_user', $3::uuid,
			now() - interval '1 hour', now() + interval '30 days')`,
		requestID, tenantID, subjectUserID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed privacy request: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		c, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(context.Background()) }()
		for _, q := range []string{
			`DELETE FROM privacy_requests WHERE tenant_id = $1::uuid`,
			`DELETE FROM report_definitions WHERE tenant_id = $1::uuid`,
			`DELETE FROM users WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			if _, err := c.Exec(context.Background(), q, tenantID); err != nil {
				return
			}
		}
		_ = c.Commit(context.Background())
	})

	worker := &Worker{Pool: pool, Batch: 10, Now: func() time.Time { return time.Now().UTC() }}
	if err := worker.Tick(ctx); err != nil {
		t.Fatalf("worker tick: %v", err)
	}

	check, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = check.Rollback(ctx) }()

	var status string
	if err := check.QueryRow(ctx, `
		SELECT status FROM privacy_requests WHERE id = $1 AND tenant_id = $2::uuid`,
		requestID, tenantID).Scan(&status); err != nil {
		t.Fatalf("read request status: %v", err)
	}
	if status != "fulfilled" {
		t.Fatalf("privacy request status = %q, want %q — the deletion did not run, so "+
			"this test proves nothing about residue", status, "fulfilled")
	}

	var usersLeft int
	if err := check.QueryRow(ctx, `
		SELECT count(*) FROM users WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, subjectUserID).Scan(&usersLeft); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if usersLeft != 0 {
		t.Fatalf("deleted user row still present (%d) — the worker did not delete the subject", usersLeft)
	}

	var owner *string
	if err := check.QueryRow(ctx, `
		SELECT owner_user_id::text FROM report_definitions
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, definitionID).Scan(&owner); err != nil {
		t.Fatalf("read report owner: %v", err)
	}
	if owner != nil {
		t.Fatalf("report_definitions.owner_user_id = %q after the account deletion was "+
			"marked fulfilled, want NULL. The deleted user's identifier survives in a "+
			"table the erasure path neither cascades through nor scrubs, so the "+
			"certificate claims a completeness the database does not have.", *owner)
	}

	// The report itself is workspace content and must survive: erasure removes
	// the person, not the team's saved work.
	var definitionsLeft int
	if err := check.QueryRow(ctx, `
		SELECT count(*) FROM report_definitions WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, definitionID).Scan(&definitionsLeft); err != nil {
		t.Fatalf("count definitions: %v", err)
	}
	if definitionsLeft != 1 {
		t.Fatalf("report definition rows = %d, want 1 — clearing ownership must not "+
			"delete the workspace's saved report", definitionsLeft)
	}
}
