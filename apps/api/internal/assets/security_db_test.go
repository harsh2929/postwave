package assets

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func assetSecurityPools(
	t *testing.T,
	ctx context.Context,
) (*db.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("DATABASE_URL and POSTWAVE_TEST_ADMIN_DATABASE_URL are required for the Assets least-privileged database proof")
	}
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect application database: %v", err)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		app.Close()
		t.Fatalf("connect administrative fixture database: %v", err)
	}
	t.Cleanup(app.Close)
	t.Cleanup(admin.Close)
	return app, admin
}

func assetSecurityTenant(t *testing.T, ctx context.Context, admin *pgxpool.Pool, label string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, id, "asset-security-"+label+"-"+id[:8], "Asset security "+label); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
	})
	return id
}

func TestAssetIdentityBlobHeadersAndTenantNondisclosureDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, admin := assetSecurityPools(t, ctx)

	owner := assetSecurityTenant(t, ctx, admin, "owner")
	foreign := assetSecurityTenant(t, ctx, admin, "foreign")
	repo := &Repo{Pool: pool}
	storage := &FSStorage{Root: t.TempDir()}
	id := uuid.NewString()
	key := id + "/proof.png"
	body := minimalAssetPNG()
	url, err := storage.Put(ctx, key, "image/png", body)
	if err != nil {
		t.Fatalf("put blob: %v", err)
	}
	saved, err := repo.Insert(ctx, owner, Asset{
		ID: id, Filename: "proof.png", Mime: "image/png", Bytes: int64(len(body)),
		Width: 10, Height: 20, StorageKey: key, URL: url,
	})
	if err != nil {
		t.Fatalf("insert asset: %v", err)
	}
	if saved.ID != id || !strings.HasPrefix(saved.StorageKey, saved.ID+"/") || saved.URL != "/api/v1/assets/"+saved.ID+"/blob" {
		t.Fatalf("identity mismatch: %+v", saved)
	}
	if _, err := repo.Get(ctx, foreign, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign Get error=%v, want ErrNotFound", err)
	}
	if _, _, err := repo.ListTagsForAsset(ctx, foreign, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign ListTags error=%v, want ErrNotFound", err)
	}
	if _, err := repo.RemoveTagFromAsset(ctx, foreign, id, "hero", saved.Version); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign RemoveTag error=%v, want ErrNotFound", err)
	}

	deps := &Deps{Repo: repo, Storage: storage}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/assets/"+id+"/blob", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: owner}))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	deps.Blob(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() != len(body) {
		t.Fatalf("blob status=%d bytes=%d body=%s", rec.Code, rec.Body.Len(), rec.Body.String())
	}
	for header, want := range map[string]string{
		"Content-Type":           "image/png",
		"Content-Length":         itoa(len(body)),
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "private, max-age=3600",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Fatalf("%s=%q, want %q", header, got, want)
		}
	}
}

func TestAssetPaginationNoDuplicateOrSkipAcrossTiesAndSortsDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, admin := assetSecurityPools(t, ctx)

	tenantID := assetSecurityTenant(t, ctx, admin, "pagination")
	repo := &Repo{Pool: pool}
	baseTime := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	ids := make([]string, 0, 7)
	for i := 0; i < 7; i++ {
		id := uuid.NewString()
		ids = append(ids, id)
		if _, err := repo.Insert(ctx, tenantID, Asset{
			ID: id, Filename: "pagination-tie.png", Mime: "image/png", Bytes: 100,
			StorageKey: id + "/pagination-tie.png", URL: "https://assets.example.test/assets/" + id + "/pagination-tie.png",
		}); err != nil {
			t.Fatalf("seed asset %d: %v", i, err)
		}
	}
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin pagination seed update: %v", err)
	}
	defer func() { _ = seedTx.Rollback(ctx) }()
	for i, id := range ids {
		// Every sortable value has ties; several tuples differ as well. This
		// forces each order to rely on its UUID tie-breaker without reducing the
		// test to one completely uniform data set.
		_, err := seedTx.Exec(ctx, `
UPDATE assets
SET created_at = $2, bytes = $3, filename = $4, references_count = $5
WHERE id = $1::uuid`, id, baseTime.Add(time.Duration(i/2)*time.Minute), 100+(i/2)*100,
			[]string{"Pagination-Alpha.png", "pagination-alpha.png", "Pagination-Beta.png"}[i%3], i/2)
		if err != nil {
			t.Fatalf("shape pagination asset %d: %v", i, err)
		}
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit pagination seed: %v", err)
	}
	if _, _, err := repo.ListWithCounts(ctx, tenantID, ListParams{Before: uuid.NewString()}); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("unknown canonical cursor error=%v, want ErrInvalidCursor", err)
	}

	for _, sortName := range []string{"newest", "oldest", "largest", "name", "most-used"} {
		t.Run(sortName, func(t *testing.T) {
			seen := map[string]bool{}
			before := ""
			for page := 0; page < 10; page++ {
				items, _, nextCursor, err := repo.ListPageWithCounts(ctx, tenantID, ListParams{
					Limit: 2, Before: before, Sort: sortName, Query: "pagination-",
				})
				if err != nil {
					t.Fatalf("page %d: %v", page, err)
				}
				if len(items) == 0 {
					break
				}
				for _, item := range items {
					if seen[item.ID] {
						t.Fatalf("duplicate asset %s on page %d", item.ID, page)
					}
					seen[item.ID] = true
				}
				if len(seen) < len(ids) {
					if nextCursor != items[len(items)-1].ID {
						t.Fatalf("page %d nextCursor=%q, want final returned ID %q", page, nextCursor, items[len(items)-1].ID)
					}
					before = nextCursor
				} else {
					if nextCursor != "" {
						t.Fatalf("terminal page nextCursor=%q, want empty", nextCursor)
					}
					break
				}
			}
			if len(seen) != len(ids) {
				t.Fatalf("saw %d/%d assets across tied %s pages: %v", len(seen), len(ids), sortName, seen)
			}
		})
	}
}
