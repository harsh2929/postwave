// SPDX-License-Identifier: AGPL-3.0-only

package lists_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// List membership creates an identity shell for an address it has not seen.
// For a contact that was deleted, that shell is the deleted person coming back,
// so the list CSV import (and every other AddEmailToListOwned caller) must
// refuse an address an erasure tombstone protects.
func TestListCSVImportNeverRecreatesADeletedContact(t *testing.T) {
	pool := lists.NewListMembershipConsentTestPool(t)
	tenantID := lists.SeedListMembershipConsentTenant(t, pool)
	listID := uuid.NewString()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	deleted := "deleted-" + suffix + "@example.test"
	fresh := "fresh-" + suffix + "@example.test"
	ctx := context.Background()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var subscriberID string
	if err = tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'api')
RETURNING id::text`, tenantID, deleted).Scan(&subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed contact: %v", err)
	}
	// Lists resolve through list_id_map: give the test list a real identity,
	// as every list created through the product has.
	if _, err = tx.Exec(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES ($1::uuid, $2, $3::uuid)`, listID, erasureImportEngineListID(suffix), tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed list identity: %v", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// The dashboard's Delete: removes the contact and leaves its tombstones.
	if _, err = (&subscribers.Repo{Pool: pool}).Delete(ctx, tenantID, subscriberID); err != nil {
		t.Fatalf("delete contact: %v", err)
	}

	router := chi.NewRouter()
	(&lists.Deps{Repo: &lists.Repo{Pool: pool}}).MountImportExportRoutes(router)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/lists/"+listID+"/import",
		strings.NewReader("email\n"+strings.ToUpper(deleted)+"\n"+fresh+"\n"))
	req.Header.Set("Content-Type", "text/csv")
	reqCtx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	reqCtx = middleware.WithUser(reqCtx, &middleware.User{ID: uuid.NewString(), TenantID: tenantID, Role: "owner"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(reqCtx))
	if rec.Code != http.StatusOK {
		t.Fatalf("list import status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp lists.ListImportResponse
	if err = json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Rows != 2 || resp.Imported != 1 || len(resp.Errors) != 1 {
		t.Fatalf("list import response=%+v, want 2 rows, 1 imported, 1 error", resp)
	}
	if rowErr := resp.Errors[0]; rowErr.Row != 2 || rowErr.Code != "erasure_blocked" || rowErr.Error != lists.ListImportErasureBlockedMessage {
		t.Fatalf("list import row error=%+v", rowErr)
	}

	counts, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = counts.Rollback(ctx) }()
	var deletedRows, freshRows, deletedMemberships int
	if err = counts.QueryRow(ctx, `
SELECT (SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = $2),
       (SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = $3),
       (SELECT count(*) FROM list_subscribers WHERE tenant_id = $1::uuid AND list_id = $4::uuid AND lower(email::text) = $2)`,
		tenantID, deleted, fresh, listID).Scan(&deletedRows, &freshRows, &deletedMemberships); err != nil {
		t.Fatal(err)
	}
	if deletedRows != 0 || deletedMemberships != 0 {
		t.Fatalf("the list import recreated a deleted contact: subscribers=%d memberships=%d", deletedRows, deletedMemberships)
	}
	if freshRows != 1 {
		t.Fatalf("fresh address subscribers=%d, want 1", freshRows)
	}
}

// erasureImportEngineListID derives a unique engine list id from a test's random hex suffix.
func erasureImportEngineListID(suffix string) int64 {
	id, err := strconv.ParseInt(suffix, 16, 64)
	if err != nil {
		panic(err)
	}
	return id + 1_000_000
}
