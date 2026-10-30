package subscribers

// SUB-023 — federation HTTP handler tests. The no-tenant branch rejects before
// any repo call, so it is reachable without a database; the body-validation
// path for CreateFederatedLink reaches the repo's input gate (nil pool, no DB
// call) and surfaces as a 422.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestListFederatedLinks_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/sub-1/federated-links", nil)
	w := httptest.NewRecorder()
	d.ListFederatedLinks(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestCreateFederatedLink_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/sub-1/federated-links",
		strings.NewReader(`{"parent_tenant_id":"p","master_subscriber_id":"m"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("If-Match", `"subscriber:sub-1:v1"`)
	w := httptest.NewRecorder()
	d.CreateFederatedLink(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestFederationWritesRequireOneStrongExactRevision(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, tc := range []struct {
		name   string
		method string
		header string
	}{
		{name: "create missing", method: http.MethodPost},
		{name: "create wildcard", method: http.MethodPost, header: "*"},
		{name: "create weak", method: http.MethodPost, header: `W/"subscriber:sub-1:v1"`},
		{name: "create list", method: http.MethodPost, header: `"subscriber:sub-1:v1", "subscriber:sub-1:v2"`},
		{name: "delete missing", method: http.MethodDelete},
		{name: "delete wildcard", method: http.MethodDelete, header: "*"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "/api/v1/subscribers/sub-1/federated-links", strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			if tc.header != "" {
				r.Header.Set("If-Match", tc.header)
			}
			r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "child-tenant"}))
			w := httptest.NewRecorder()
			if tc.method == http.MethodPost {
				d.CreateFederatedLink(w, r)
			} else {
				d.DeleteFederatedLink(w, r)
			}
			if w.Code != http.StatusPreconditionRequired {
				t.Fatalf("status=%d body=%s, want 428", w.Code, w.Body.String())
			}
		})
	}
}

func TestCreateFederatedLink_RejectsMissingFields(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/sub-1/federated-links",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("If-Match", `"subscriber:sub-1:v1"`)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "child-tenant"}))
	w := httptest.NewRecorder()
	d.CreateFederatedLink(w, r)
	if w.Code != 422 && w.Code != 400 {
		t.Errorf("status = %d, want 4xx for missing required fields", w.Code)
	}
	if !strings.Contains(w.Body.String(), "validation_failed") {
		t.Errorf("body = %q, want validation_failed", w.Body.String())
	}
}

func TestDeleteFederatedLink_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("DELETE", "/api/v1/subscribers/sub-1/federated-links/master-1", nil)
	w := httptest.NewRecorder()
	d.DeleteFederatedLink(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}
