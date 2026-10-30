// SPDX-License-Identifier: AGPL-3.0-only
package subscriber_import

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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// A failed import row must be answerable.
//
// The worker writes every per-row failure into `subscriber_import_errors` — its
// own comment at worker.go:259 says "so the UI can offer" — and none of the
// eight `/api/v1/subscriber-imports*` routes read the table. A user uploads
// 10,000 contacts, is told 42 rows failed, and has no way to learn which 42 or
// why. The data to answer them has been sitting there the whole time, and gets
// pruned after 30 days unread.
//
// PRIVACY. The worker deliberately writes `email`, `raw_row` and both sha256
// columns as NULL, keeping only the row number, an error code and a message —
// it calls this a "privacy-safe row outcome". The endpoint must expose exactly
// that and must not become the reason someone starts populating those columns.

func newImportErrorsPool(t *testing.T) *db.Pool {
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

func seedImportWithErrors(t *testing.T, pool *db.Pool, rows int) (tenantID, importID string) {
	t.Helper()
	ctx := context.Background()
	tenantID, importID = uuid.NewString(), uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'import errors', 'studio')`,
		tenantID, "imp-err-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscriber_imports (id, tenant_id, object_key, status, rows_failed)
		VALUES ($1::uuid, $2::uuid, 'imports/contacts.csv', 'ready', $3)`,
		importID, tenantID, rows); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed import: %v", err)
	}
	for i := 1; i <= rows; i++ {
		if _, err := tx.Exec(ctx, `
			INSERT INTO subscriber_import_errors
			  (tenant_id, import_id, row_number, email, error, raw_row, error_code,
			   email_sha256, raw_row_sha256, expires_at)
			VALUES ($1::uuid, $2::uuid, $3, NULL, $4, NULL, $5, NULL, NULL,
			        now() + interval '30 days')`,
			tenantID, importID, i, "row could not be parsed", "malformed_row"); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed row error: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// One tenant delete removes everything the test wrote through ON DELETE
	// CASCADE. The teardown used to delete the child rows first, in the same
	// transaction, and gave up silently on the first error. The application
	// role has no DELETE on subscriber_imports, so that statement failed and
	// aborted the transaction, the tenant delete that followed could never run,
	// and every run leaked its tenant.
	t.Cleanup(func() { deleteImportTestTenant(t, pool, tenantID) })
	return tenantID, importID
}

func importErrorsRequest(t *testing.T, tenantID, importID string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/subscriber-imports/"+importID+"/errors", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", importID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: tenantID, Slug: "acme", Tier: "studio",
	}))
}

func TestFailedImportRowsAreAnswerable(t *testing.T) {
	pool := newImportErrorsPool(t)
	tenantID, importID := seedImportWithErrors(t, pool, 3)

	rec := httptest.NewRecorder()
	(&Deps{Pool: pool}).RowErrors(rec, importErrorsRequest(t, tenantID, importID))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200. body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", rec.Header().Get("Cache-Control"))
	}
	var body struct {
		Items []struct {
			RowNumber int    `json:"row_number"`
			Code      string `json:"error_code"`
			Message   string `json:"error"`
			Email     string `json:"email"`
			RawRow    string `json:"raw_row"`
		} `json:"items"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v (%s)", err, rec.Body.String())
	}
	if len(body.Items) != 3 {
		t.Fatalf("returned %d rows, want 3 — a user told \"3 rows failed\" must be "+
			"able to see which three", len(body.Items))
	}
	for _, it := range body.Items {
		if it.RowNumber < 1 {
			t.Error("a row error with no row number cannot be acted on")
		}
		if it.Code == "" || it.Message == "" {
			t.Error("a row error must carry both a code and a message")
		}
		// The worker stores these as NULL on purpose; the endpoint must not
		// become the reason someone starts filling them in.
		if it.Email != "" || it.RawRow != "" {
			t.Errorf("the response carries raw import content (email=%q raw_row=%q). "+
				"The worker writes these as NULL and calls the result a "+
				"\"privacy-safe row outcome\".", it.Email, it.RawRow)
		}
	}
}

func TestAnotherTenantsImportErrorsAreNotReadable(t *testing.T) {
	// The table is tenant-scoped under RLS, and the query also filters on
	// tenant_id explicitly. A mutation removing that predicate still passes:
	// RLS is what enforces this, and the predicate is belt-and-braces. Asserted
	// anyway, because the property that matters is the OUTCOME — an import id
	// from another workspace must never return that workspace'''s failures — and
	// it should keep holding if the query is ever rewritten to bypass RLS.
	pool := newImportErrorsPool(t)
	_, importID := seedImportWithErrors(t, pool, 2)
	otherTenant := uuid.NewString()

	rec := httptest.NewRecorder()
	(&Deps{Pool: pool}).RowErrors(rec, importErrorsRequest(t, otherTenant, importID))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want the same 404 as a nonexistent import",
			rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "import_not_found") ||
		strings.Contains(rec.Body.String(), "malformed_row") {
		t.Fatalf("cross-tenant response is unsafe or ambiguous: %s", rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", rec.Header().Get("Cache-Control"))
	}
}

func TestMissingAndCrossTenantImportsHaveTheSameRowErrorResponse(t *testing.T) {
	pool := newImportErrorsPool(t)
	_, foreignImportID := seedImportWithErrors(t, pool, 1)
	requestingTenant, _ := seedImportWithErrors(t, pool, 1)

	cross := httptest.NewRecorder()
	(&Deps{Pool: pool}).RowErrors(cross,
		importErrorsRequest(t, requestingTenant, foreignImportID))
	missing := httptest.NewRecorder()
	(&Deps{Pool: pool}).RowErrors(missing,
		importErrorsRequest(t, requestingTenant, uuid.NewString()))

	if cross.Code != http.StatusNotFound || missing.Code != http.StatusNotFound {
		t.Fatalf("cross=%d missing=%d, want two 404 responses", cross.Code, missing.Code)
	}
	if cross.Body.String() != missing.Body.String() {
		t.Fatalf("cross-tenant and missing responses differ:\n cross=%s missing=%s",
			cross.Body.String(), missing.Body.String())
	}
}

// deleteImportTestTenant removes a tenant the test created, and everything
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
func deleteImportTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteImportTestTenantOnce(ctx, pool, tenantID)
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

func deleteImportTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
