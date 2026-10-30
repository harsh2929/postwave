// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Paste emails is how an operator most often tries to bring a deleted contact
// back. The row must carry a reason the person can act on: the tombstone is
// irreversible, so the old "unblock the suppression" advice named an action
// that does not exist.
func TestBulkPasteExplainsAnErasedAddressThroughRouter_DB(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	erased := "pasted-erased-" + suffix + "@example.test"
	fresh := "pasted-fresh-" + suffix + "@example.test"
	id := seedBulkVerbsSubscriber(t, pool, tenantID, erased, StatusUnconfirmed)
	repo := &Repo{Pool: pool}
	if _, err := repo.Delete(context.Background(), tenantID, id); err != nil {
		t.Fatalf("delete contact: %v", err)
	}

	router := chi.NewRouter()
	MountWrite(router, &Deps{Repo: repo})
	body, _ := json.Marshal(BulkPasteInput{Emails: erased + "\n" + fresh})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk-paste", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: uuid.NewString(), TenantID: tenantID, Role: "owner"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("bulk paste status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp BulkPasteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Parsed != 2 || resp.Created != 1 || resp.Errored != 1 || len(resp.Rows) != 2 {
		t.Fatalf("bulk paste response=%+v", resp)
	}
	row := resp.Rows[0]
	if row.Email != erased || row.Status != "error" || row.ErrorCode != "erasure_blocked" ||
		row.Error != "This address was permanently erased by a contact deletion or privacy request and can't be re-added." {
		t.Fatalf("erased row=%+v", row)
	}
	if strings.Contains(strings.ToLower(row.Error), "unblock") {
		t.Fatalf("erased row still points to an unblock action that does not exist: %q", row.Error)
	}
}
