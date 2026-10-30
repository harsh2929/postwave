package lists

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newListIdentityDBTestPool(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping migrated Lists identity tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to migrated test database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedListIdentityTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tenant seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'lists-identity-test', 'lists-identity-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		memberTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open member cleanup: %v", cleanupErr)
			return
		}
		if _, cleanupErr = memberTx.Exec(cleanupCtx,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID); cleanupErr != nil {
			_ = memberTx.Rollback(cleanupCtx)
			t.Errorf("delete identity-test subscribers: %v", cleanupErr)
			return
		}
		if cleanupErr = memberTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit member cleanup: %v", cleanupErr)
			return
		}
		tenantTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open tenant cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = tenantTx.Rollback(cleanupCtx) }()
		if _, cleanupErr = tenantTx.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("delete identity-test tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = tenantTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit tenant cleanup: %v", cleanupErr)
		}
	})
	return tenantID
}

func TestListIdentityMappingAndAudienceCountOnMigratedDatabase(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantA := seedListIdentityTenant(t, pool)
	tenantB := seedListIdentityTenant(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	const sharedEngineID int64 = 846201

	listA := uuid.NewString()
	gotA, err := repo.ensureListIDMap(ctx, tenantA, listA, sharedEngineID)
	if err != nil || gotA != listA {
		t.Fatalf("create tenant A mapping: uuid=%q err=%v", gotA, err)
	}
	// A retry with a different preferred UUID must recover the original
	// identity rather than minting a second sidecar row.
	gotRetry, err := repo.ensureListIDMap(ctx, tenantA, uuid.NewString(), sharedEngineID)
	if err != nil || gotRetry != listA {
		t.Fatalf("retry mapping: uuid=%q err=%v, want %q", gotRetry, err, listA)
	}
	listB := uuid.NewString()
	gotB, err := repo.ensureListIDMap(ctx, tenantB, listB, sharedEngineID)
	if err != nil || gotB != listB {
		t.Fatalf("same engine id in tenant B: uuid=%q err=%v", gotB, err)
	}

	if err := repo.AddEmailToList(ctx, tenantA, listA, "member@example.test", "api"); err != nil {
		t.Fatalf("seed mapped membership: %v", err)
	}
	for _, id := range []string{listA, "846201"} {
		count, countErr := repo.CountListAudience(ctx, tenantA, id)
		if countErr != nil || count != 1 {
			t.Errorf("CountListAudience(%q)=(%d,%v), want (1,nil)", id, count, countErr)
		}
	}
	countB, err := repo.CountListAudience(ctx, tenantB, "846201")
	if err != nil || countB != 0 {
		t.Fatalf("tenant B count=(%d,%v), want isolated zero", countB, err)
	}
	if _, err := repo.CountListAudience(ctx, tenantA, "999999"); !errors.Is(err, ErrListIDNotMapped) {
		t.Fatalf("missing map error=%v, want ErrListIDNotMapped", err)
	}
}

func TestCreatePersistsExactIdentityOnMigratedDatabase(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	const engineID int64 = 846202
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/lists" {
			t.Errorf("upstream request=%s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"data":{"id":846202,"name":"Mapped"}}`))
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	d.Repo = &Repo{Pool: pool}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/lists", strings.NewReader(`{"name":"Mapped"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	w := httptest.NewRecorder()
	d.Create(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%q", w.Code, w.Body.String())
	}
	var env struct {
		Data List `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if env.Data.ID != engineID || env.Data.PostwaveUUID == "" {
		t.Fatalf("create identity=%+v", env.Data)
	}
	mapped, err := d.Repo.GetListUUIDByBigintID(context.Background(), tenantID, engineID)
	if err != nil || mapped != env.Data.PostwaveUUID {
		t.Fatalf("durable mapping=%q err=%v, response=%q", mapped, err, env.Data.PostwaveUUID)
	}
}

func TestConcurrentIdentityEnsureConvergesOnOneUUID(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	repo := &Repo{Pool: pool}
	const engineID int64 = 846203
	const workers = 8
	results := make(chan string, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := repo.ensureListIDMap(context.Background(), tenantID, uuid.NewString(), engineID)
			if err != nil {
				errs <- err
				return
			}
			results <- got
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Errorf("concurrent ensure: %v", err)
	}
	winner := ""
	count := 0
	for got := range results {
		count++
		if winner == "" {
			winner = got
		}
		if got != winner {
			t.Errorf("mapping diverged: got %q, winner %q", got, winner)
		}
	}
	if count != workers {
		t.Fatalf("successful workers=%d, want %d", count, workers)
	}
}
