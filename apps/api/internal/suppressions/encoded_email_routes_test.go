// SPDX-License-Identifier: AGPL-3.0-only
package suppressions

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestEncodedEmailHistoryAndRemovalPreserveAddress(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	store := &Store{Pool: pool}
	h := &StoreHandlers{Store: store, Audit: &AuditLogger{Pool: pool}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID})))
		})
	})
	h.MountX1Routes(router)
	h.MountX1ReadRoutes(router)
	for _, local := range []string{"qa", "qa+tag", "qa%40tag"} {
		t.Run(local, func(t *testing.T) {
			email := local + "@example.invalid"
			body, _ := json.Marshal(map[string]string{"email": email})
			add := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/suppressions", strings.NewReader(string(body)))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(add, request)
			if add.Code != http.StatusCreated {
				t.Fatalf("add status=%d body=%s", add.Code, add.Body.String())
			}
			// QueryEscape encodes @ and + exactly as encodeURIComponent does
			// for these addresses; PathEscape may leave @ unescaped.
			encoded := url.QueryEscape(email)
			assertAudit := func() {
				t.Helper()
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/suppressions/"+encoded+"/audit", nil))
				var result struct {
					Items []AuditEntry `json:"items"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != http.StatusOK || len(result.Items) == 0 || result.Items[0].Email != email {
					t.Fatalf("encoded history status=%d body=%s err=%v", w.Code, w.Body.String(), err)
				}
			}
			assertAudit()
			remove := httptest.NewRecorder()
			router.ServeHTTP(remove, httptest.NewRequest(http.MethodDelete, "/api/v1/deliverability/suppressions/"+encoded, nil))
			if remove.Code != http.StatusOK && remove.Code != http.StatusNoContent {
				t.Fatalf("remove status=%d body=%s", remove.Code, remove.Body.String())
			}
			remaining, err := store.FetchByEmail(ctx, tenantID, email)
			if err != nil || remaining != nil {
				t.Fatalf("suppression still present: %+v err=%v", remaining, err)
			}
			assertAudit()
		})
	}
}
