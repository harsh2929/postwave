// SPDX-License-Identifier: AGPL-3.0-only

package resend_unopened

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The resend clone must not inherit the source campaign's dispatch timestamps.
//
// This is the second copy of the same rule: resend_unopened keeps its own
// exclusion map, entirely separate from campaign_clone's, and both were missing
// started_at. The resend case is the worse of the two, because a resend is by
// definition made from a campaign that HAS sent — so the inherited timestamp was
// not an edge case here, it was every single resend.
//
// campaigns.Repo.Update freezes delivered content on started_at, so without the
// exclusion every resend draft would refuse the fresh subject line the operator
// is required to supply.

func resendTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping resend SQL test")
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

func TestResendCloneDoesNotInheritSourceDispatchTimestamps(t *testing.T) {
	pool := resendTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	slug := "resend-ts-" + tenantID[:8]
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	var srcID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, started_at, finished_at)
VALUES ($1::uuid, 'shipped', 'Original subject', 'sent', '<p>hi</p>',
        now() - interval '3 days', now() - interval '3 days')
RETURNING id::text`, tenantID).Scan(&srcID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed source campaign: %v", err)
	}
	// One delivered-but-never-opened recipient, so the resend has an audience.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, 'unopened@example.test', 'delivered', now() - interval '3 days')`,
		tenantID, srcID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	// One tenant delete removes everything the test wrote through ON DELETE
	// CASCADE. The teardown used to delete the child rows first, in the same
	// transaction, and discarded every error. The application role has no
	// DELETE on subscriber_events, so that statement failed and aborted the
	// transaction, the tenant delete that followed could never run, and every
	// run leaked its tenant.
	t.Cleanup(func() { deleteResendTestTenant(t, pool, tenantID) })

	router := chi.NewRouter()
	MountRoutes(router, &Deps{
		Pool:         pool,
		LiveDispatch: dispatchcontrol.StaticGate{Enabled: true},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/"+srcID+"/resend-unopened",
		strings.NewReader(`{"subject":"Fresh subject for the resend"}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := middleware.WithAPIKeyAuth(req.Context())
	rctx = apikeys.WithScopes(rctx, []apikeys.Scope{
		apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional,
	})
	rctx = middleware.WithTenant(rctx, &middleware.Tenant{ID: tenantID})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(rctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("resend status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.ID == "" {
		t.Fatalf("resend response=%s err=%v", rec.Body.String(), err)
	}

	rtx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = rtx.Rollback(ctx) }()
	var startedAt, finishedAt *time.Time
	if err := rtx.QueryRow(ctx, `
SELECT started_at, finished_at FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, out.ID).Scan(&startedAt, &finishedAt); err != nil {
		t.Fatalf("read resend clone: %v", err)
	}
	if startedAt != nil {
		t.Errorf("the resend draft carries started_at=%v from the campaign it "+
			"resends; content is frozen on that column, so the operator could "+
			"not edit the draft they were just told to create", startedAt)
	}
	if finishedAt != nil {
		t.Errorf("the resend draft carries finished_at=%v from its source", finishedAt)
	}
}

// deleteResendTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteResendTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteResendTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteResendTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
