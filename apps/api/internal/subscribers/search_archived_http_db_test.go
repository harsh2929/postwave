// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// "Show archived" on the directory listed archived contacts until the
// operator typed a query; the search then answered without them. The web
// client now sends include_archived on /search as it does on the list. This
// drives GET /api/v1/subscribers/search through the mounted read routes, as
// the RLS-bound application role, and pins that the flag reaches the
// structured (SearchWithQuery) path the handler actually uses — the older
// repo-level test only covers the legacy Search.
func TestSearchEndpointHonoursIncludeArchived(t *testing.T) {
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

	token := "verify-check-" + uuid.NewString()[:8]
	active := token + "-active@example.test"
	archived := token + "-archived@example.test"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	for _, seed := range []struct {
		email    string
		archived bool
	}{{active, false}, {archived, true}} {
		archivedAt := any(nil)
		if seed.archived {
			archivedAt = time.Now().UTC()
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, archived_at)
VALUES ($1::uuid, $2, 'unconfirmed', 'unknown', $3)`, tenantID, seed.email, archivedAt); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed %s: %v", seed.email, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	deps := &Deps{Repo: &Repo{Pool: pool}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID})
			ctx = middleware.WithAPIKeyAuth(ctx)
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadSubscribers})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	MountRead(router, deps)

	search := func(extra string) (emails []string, total int) {
		t.Helper()
		target := "/api/v1/subscribers/search?page=1&per_page=50&q=" + url.QueryEscape(token) + extra
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d: %s", target, rec.Code, rec.Body.String())
		}
		var page struct {
			Items []struct {
				Email string `json:"email"`
			} `json:"items"`
			Total int `json:"total"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
		for _, item := range page.Items {
			emails = append(emails, item.Email)
		}
		return emails, page.Total
	}

	emails, total := search("")
	if !slices.Contains(emails, active) || slices.Contains(emails, archived) || total != 1 {
		t.Fatalf("default search = %v (total %d); want only the active contact %s", emails, total, active)
	}
	emails, total = search("&include_archived=true")
	if !slices.Contains(emails, active) || !slices.Contains(emails, archived) || total != 2 {
		t.Fatalf("search with include_archived=true = %v (total %d); want the active and the archived contact", emails, total)
	}
	// An operator search for the archived contact's own address finds it only
	// with the toggle on.
	archivedOnly := url.QueryEscape(archived)
	for _, tc := range []struct {
		extra string
		want  bool
	}{{"", false}, {"&include_archived=true", true}} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
			"/api/v1/subscribers/search?q="+archivedOnly+tc.extra, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("search for the archived address = %d: %s", rec.Code, rec.Body.String())
		}
		var page struct {
			Items []struct {
				Email string `json:"email"`
			} `json:"items"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatalf("decode: %v", err)
		}
		found := slices.ContainsFunc(page.Items, func(it struct {
			Email string `json:"email"`
		}) bool {
			return it.Email == archived
		})
		if found != tc.want {
			t.Fatalf("search %q%s found the archived contact = %v, want %v", archived, tc.extra, found, tc.want)
		}
	}
}
