// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestPublicRoutesRejectRawEmailRecipientBeforeDatabaseAccess(t *testing.T) {
	// The non-nil, unopened pool proves this rejection happens at the HTTP
	// boundary. Any attempted query would panic rather than accidentally make
	// this a database-dependent test.
	repo := &Repo{
		Pool: new(db.Pool), TokenKeyring: testTokenKeyring(time.Now().UTC()),
	}
	router := chi.NewRouter()
	if err := MountPublicRoutes(router, &Deps{Repo: repo}); err != nil {
		t.Fatalf("MountPublicRoutes: %v", err)
	}
	rawEmail := url.QueryEscape("reader@example.test")
	target := "/api/public/polls/tenant/poll/option?r=" + rawEmail + "&t=token"
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s raw-email recipient response = %d, want 404", method, recorder.Code)
		}
	}

	browserRequest := httptest.NewRequest(http.MethodGet, target, nil)
	browserRequest.Header.Set("Accept", "text/html")
	browser := httptest.NewRecorder()
	router.ServeHTTP(browser, browserRequest)
	if browser.Code != http.StatusNotFound {
		t.Fatalf("HTML raw-email response = %d, want 404", browser.Code)
	}
	if contentType := browser.Header().Get("Content-Type"); !strings.Contains(contentType, "text/html") {
		t.Fatalf("HTML raw-email Content-Type = %q", contentType)
	}
	if body := browser.Body.String(); strings.Contains(body, "reader@example.test") ||
		strings.Contains(strings.ToLower(body), "token") {
		t.Fatalf("invalid-link page exposed raw identity or token state: %s", body)
	}
	if browser.Header().Get("Cache-Control") != "no-store" ||
		browser.Header().Get("Referrer-Policy") != "no-referrer" ||
		browser.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("invalid-link response omitted bearer-page protections: %+v", browser.Header())
	}
}
