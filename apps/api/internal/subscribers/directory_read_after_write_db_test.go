// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httpcache/httpcachetest"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// The directory page refetches GET /api/v1/subscribers straight after each of
// its writes. On staging that refetch never reached the API: the response's
// `private, max-age=10, stale-while-revalidate=60` let the browser answer it
// from disk, so a contact added through "New subscriber" or "Paste emails" did
// not appear (LIST-D), and bulk-deleted rows stayed on screen through a reload
// (IMP-D). The writes themselves were synchronous and correct.
//
// This drives the real read, write and bulk handlers against the database as
// the RLS-bound role, under the cache middleware in the order main.go mounts
// it on the authenticated group, through a cache that reuses responses the way
// the browser did. The page's own query URL is used verbatim — the write
// targets never equal it, so no browser invalidation can rescue the read.
func TestDirectoryRefetchAfterEachWriteReachesTheServerAndShowsTheWrite(t *testing.T) {
	pool := newDirectoryFreshnessPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if tx, err := db.WithTenant(ctx, pool, tenantID); err == nil {
			_, _ = tx.Exec(ctx, `DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID)
			_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = tx.Commit(ctx)
		}
	})

	deps := &Deps{
		Repo: &Repo{
			Pool:             pool,
			EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
		},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	router := chi.NewRouter()
	// Stand-in for the authenticated route stack: an API key of this tenant
	// holding the scopes the directory's verbs require.
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID})
			ctx = middleware.WithAPIKeyAuth(ctx)
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{
				apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers, apikeys.ScopeAdmin,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	router.Use(httpcache.Conditional())
	router.Use(httpcache.WithPolicy(httpcache.AuthRead()))
	MountRead(router, deps)
	MountWrite(router, deps)
	MountBulkRoutes(router, deps)
	browser := httpcachetest.NewBrowser(router)

	// The subscribers page's first-page query, as the web client sends it.
	const directory = "/api/v1/subscribers?page=1&per_page=50&sort=updated_at&order=desc"
	read := func(when string) (emails []string, ids map[string]string) {
		t.Helper()
		res := browser.Do(directoryRequest(http.MethodGet, directory, ""))
		if res.Status != http.StatusOK {
			t.Fatalf("%s: directory read = %d: %s", when, res.Status, res.Body)
		}
		var page struct {
			Items []struct {
				ID    string `json:"id"`
				Email string `json:"email"`
			} `json:"items"`
		}
		if err := json.Unmarshal(res.Body, &page); err != nil {
			t.Fatalf("%s: decode directory: %v (%s)", when, err, res.Body)
		}
		ids = map[string]string{}
		for _, item := range page.Items {
			emails = append(emails, item.Email)
			ids[item.Email] = item.ID
		}
		if when != "" && res.Source == httpcachetest.FromCache {
			t.Fatalf("%s: the directory refetch was %s (Cache-Control %q)",
				when, res.Source, res.Header.Get("Cache-Control"))
		}
		return emails, ids
	}

	if emails, _ := read(""); len(emails) != 0 {
		t.Fatalf("fresh tenant directory = %v", emails)
	}

	created := "dialog-" + uuid.NewString() + "@example.test"
	directoryWrite(t, browser, http.MethodPost, "/api/v1/subscribers",
		fmt.Sprintf(`{"email":%q,"status":"unconfirmed"}`, created), http.StatusCreated)
	if emails, _ := read("after New subscriber"); !slices.Contains(emails, created) {
		t.Fatalf("after New subscriber the directory lists %v, without %s", emails, created)
	}

	pastedB := "paste-b-" + uuid.NewString() + "@example.test"
	pastedC := "paste-c-" + uuid.NewString() + "@example.test"
	directoryWrite(t, browser, http.MethodPost, "/api/v1/subscribers/bulk-paste",
		fmt.Sprintf(`{"emails":%q}`, pastedB+"\n"+pastedC), http.StatusOK)
	emails, ids := read("after Paste emails")
	if !slices.Contains(emails, pastedB) || !slices.Contains(emails, pastedC) {
		t.Fatalf("after Paste emails the directory lists %v, without the pasted %s and %s", emails, pastedB, pastedC)
	}

	directoryWrite(t, browser, http.MethodPost, "/api/v1/subscribers/bulk/delete",
		fmt.Sprintf(`{"subscriber_ids":[%q,%q]}`, ids[pastedB], ids[pastedC]), http.StatusOK)
	if emails, _ := read("after bulk delete"); slices.Contains(emails, pastedB) || slices.Contains(emails, pastedC) {
		t.Fatalf("after bulk delete the directory still lists the deleted contacts: %v", emails)
	}

	// Revalidating every read keeps the 304 path: an unchanged directory is
	// confirmed without its body.
	if again := browser.Do(directoryRequest(http.MethodGet, directory, "")); again.Source != httpcachetest.Revalidated {
		t.Fatalf("an unchanged directory read was %s, want a 304 revalidation", again.Source)
	}
}

func directoryWrite(t *testing.T, browser *httpcachetest.Browser, method, target, body string, want int) {
	t.Helper()
	if res := browser.Do(directoryRequest(method, target, body)); res.Status != want {
		t.Fatalf("%s %s = %d, want %d: %s", method, target, res.Status, want, res.Body)
	}
}

func directoryRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Cookie", "pw_session=operator")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

// newDirectoryFreshnessPool connects through db.New, which refuses a role that
// bypasses row-level security: the directory must be proven as the API sees
// it, not as a superuser does.
func newDirectoryFreshnessPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping the directory read-after-write test")
	}
	pool, err := db.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect as the RLS-bound application role: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
