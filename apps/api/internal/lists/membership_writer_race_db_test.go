package lists

// A list deleted between a writer's resolution of it and its write.
//
// Every list-scoped route resolves the id up front (resolveListUUID), in a
// transaction that commits before the handler writes. The writers used to
// trust that resolution: their own transaction read the engine id from
// list_id_map without a lock and carried on when the row was gone. A delete
// that committed in between therefore left a live membership on a retired
// list, with no engine id — the blank list name in a subscriber's Lists panel
// — and fired "Joined list" flows for a list that no longer existed. A CSV
// import resolves once and then works through the whole file, so its window is
// seconds.
//
// These tests put the delete exactly in that window: a query tracer on the
// writer's pool runs the deletion, on a separate pool, just before the
// writer's second read of list_id_map.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// deleteListBeforeIdentityRead runs fire, once, just before the nth query that
// reads list_id_map on the traced pool.
type deleteListBeforeIdentityRead struct {
	nth  int
	fire func(context.Context) error

	mu    sync.Mutex
	seen  int
	fired bool
	err   error
}

func (tr *deleteListBeforeIdentityRead) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !strings.Contains(data.SQL, "list_id_map") {
		return ctx
	}
	tr.mu.Lock()
	tr.seen++
	fire := tr.seen == tr.nth
	tr.mu.Unlock()
	if fire {
		err := tr.fire(ctx)
		tr.mu.Lock()
		tr.fired, tr.err = true, err
		tr.mu.Unlock()
	}
	return ctx
}

func (*deleteListBeforeIdentityRead) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
}

func (tr *deleteListBeforeIdentityRead) requireFired(t *testing.T) {
	t.Helper()
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if !tr.fired {
		t.Fatalf("the delete never ran: the writer read list_id_map %d time(s), want at least %d", tr.seen, tr.nth)
	}
	if tr.err != nil {
		t.Fatalf("delete the list mid-request: %v", tr.err)
	}
}

// tracedListPool connects to the test database as the application role with
// tracer on every query.
func tracedListPool(t *testing.T, tracer pgx.QueryTracer) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse test database url: %v", err)
	}
	cfg.ConnConfig.Tracer = tracer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect traced pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// retireEngineList deletes the list the way DELETE /api/v1/lists/{id} does
// once Listmonk has confirmed.
func retireEngineList(ctx context.Context, pool *db.Pool, tenantID string, engineID int64) error {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	identity, mapped, err := lockEngineListIdentity(ctx, tx, tenantID, engineID)
	if err != nil {
		return err
	}
	if !mapped {
		return ErrListIDNotMapped
	}
	if _, err := retireListIdentityTx(ctx, tx, tenantID, identity); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func activeListMembers(t *testing.T, pool *db.Pool, tenantID, listUUID string) int {
	t.Helper()
	return tenantRowCount(t, pool, tenantID, `
SELECT count(*) FROM list_subscribers
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL`, listUUID)
}

func TestMembersTabAddRefusesAListDeletedAfterItWasResolved(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	listUUID := mapListIdentity(t, pool, tenantID, 41)
	subscriberID := seedAutomationContact(t, pool, tenantID, "members-tab-race@example.test")

	// Read 1 is the route's resolution, read 2 the writer's own.
	tracer := &deleteListBeforeIdentityRead{nth: 2, fire: func(ctx context.Context) error {
		return retireEngineList(ctx, pool, tenantID, 41)
	}}
	router, _ := listRoutes(tracedListPool(t, tracer), newFakeListmonk(t, nil))
	w := callAs(t, router, tenantID, http.MethodPost, "/api/v1/lists/41/subscribers",
		`{"subscriber_ids":["`+subscriberID+`"]}`)
	tracer.requireFired(t)

	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), `"list_not_found"`) {
		t.Fatalf("add to a list deleted mid-request = %d %s, want 404 list_not_found", w.Code, w.Body.String())
	}
	if n := activeListMembers(t, pool, tenantID, listUUID); n != 0 {
		t.Fatalf("active memberships on the deleted list = %d, want 0", n)
	}
}

func TestCSVImportStopsWhenTheListIsDeletedPartWay(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	listUUID := mapListIdentity(t, pool, tenantID, 42)

	// Read 1 is the route's resolution, read 2 the first row's write, read 3
	// the second row's: the list is deleted after the first row landed.
	tracer := &deleteListBeforeIdentityRead{nth: 3, fire: func(ctx context.Context) error {
		return retireEngineList(ctx, pool, tenantID, 42)
	}}
	d := New(newFakeListmonk(t, nil).server.URL, "api", "token")
	d.Repo = &Repo{Pool: tracedListPool(t, tracer)}
	router := chi.NewRouter()
	d.MountImportExportRoutes(router)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/lists/42/import",
		strings.NewReader("email\nfirst-row@example.test\nsecond-row@example.test\nthird-row@example.test\n"))
	req.Header.Set("Content-Type", "text/csv")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeWriteSubscribers})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req.WithContext(ctx))
	tracer.requireFired(t)

	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), `"list_not_found"`) {
		t.Fatalf("import into a list deleted part-way = %d %s, want 404 list_not_found", w.Code, w.Body.String())
	}
	// The first row was written before the delete, which removed it with the
	// rest of the list; nothing was written after it.
	if n := activeListMembers(t, pool, tenantID, listUUID); n != 0 {
		t.Fatalf("active memberships on the deleted list = %d, want 0", n)
	}
	if n := tenantRowCount(t, pool, tenantID, `
SELECT count(*) FROM list_subscribers WHERE tenant_id = $1::uuid AND list_id = $2::uuid`, listUUID); n != 1 {
		t.Fatalf("membership rows = %d, want only the first row's, removed by the delete", n)
	}
}

// Every owned writer, called with an id its caller resolved before the list
// was deleted, refuses instead of writing.
func TestMembershipWritersRefuseAListDeletedAfterTheCallerResolvedIt(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	repo := &Repo{Pool: pool, MembershipWebhooks: &recordingMembershipWebhookFanout{}}
	ctx := context.Background()
	contact := "writer-race@example.test"
	subscriberID := seedAutomationContact(t, pool, tenantID, contact)
	source := mapListIdentity(t, pool, tenantID, 50)
	if added, err := repo.AddMembers(ctx, tenantID, source, []string{subscriberID}); err != nil || added != 1 {
		t.Fatalf("seed merge source = %d, %v", added, err)
	}

	writers := map[string]func(listUUID string) error{
		"members tab": func(listUUID string) error {
			_, err := repo.AddMembers(ctx, tenantID, listUUID, []string{subscriberID})
			return err
		},
		"csv import and crm sync": func(listUUID string) error {
			return repo.AddEmailToList(ctx, tenantID, listUUID, "new-row@example.test", "csv")
		},
		"flow move to list": func(listUUID string) error {
			_, err := repo.AddExistingContactToListOwned(ctx, tenantID, listUUID, contact, ListMembershipOwner{
				Source: "api", OwnerKey: "source:api",
			})
			return err
		},
		"list merge": func(listUUID string) error {
			_, err := repo.MergeListsMembers(ctx, tenantID, []string{source}, listUUID)
			return err
		},
	}
	engineID := int64(60)
	for name, write := range writers {
		engineID++
		listUUID := mapListIdentity(t, pool, tenantID, engineID)
		resolved, err := repo.resolveListUUID(ctx, tenantID, listUUID)
		if err != nil {
			t.Fatalf("%s: resolve: %v", name, err)
		}
		if err := retireEngineList(ctx, pool, tenantID, engineID); err != nil {
			t.Fatalf("%s: delete: %v", name, err)
		}
		if err := write(resolved); err != ErrListIDNotMapped {
			t.Errorf("%s: write to a deleted list = %v, want ErrListIDNotMapped", name, err)
		}
		if n := tenantRowCount(t, pool, tenantID, `
SELECT count(*) FROM list_subscribers WHERE tenant_id = $1::uuid AND list_id = $2::uuid`, resolved); n != 0 {
			t.Errorf("%s: %d membership row(s) written to the deleted list", name, n)
		}
	}
}

// Deleting a list Moosewave never keyed anything on used to hold the tenant
// transaction while the sole-tenant proof opened a second one, and across the
// upstream call: two pooled connections per request, so concurrent deletes
// could starve the pool. With a single connection that request never finished.
func TestDeleteOfAnUnmappedListNeedsOnePooledConnection(t *testing.T) {
	tenantID := seedListIdentityTenant(t, newListIdentityDBTestPool(t))
	pool, _, _ := soleTenantShadowPool(t, tenantID, func(c *pgxpool.Config) { c.MaxConns = 1 })
	engine := newFakeListmonk(t, nil)
	router, _ := listRoutes(pool, engine)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/lists/77", nil)
	reqCtx := middleware.WithAPIKeyAuth(ctx)
	reqCtx = middleware.WithTenant(reqCtx, &middleware.Tenant{ID: tenantID})
	reqCtx = apikeys.WithScopes(reqCtx, []apikeys.Scope{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req.WithContext(reqCtx))

	if w.Code != http.StatusOK {
		t.Fatalf("delete an unmapped list with one pooled connection = %d %s, want 200", w.Code, w.Body.String())
	}
	if got := engine.received(); len(got) != 1 || got[0] != "DELETE /api/lists/77" {
		t.Fatalf("Listmonk received %v, want the one delete", got)
	}
}
