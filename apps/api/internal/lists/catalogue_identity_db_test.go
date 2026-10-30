package lists

// catalogue_identity_db_test.go — the list catalogue, list deletion and list
// ownership against a migrated database as the RLS-bound application role,
// through the production route table, with Listmonk replaced by a fake that
// replays response bodies recorded from Listmonk v6.1.0
// (testdata/listmonk-v6.1.0/README.md).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

func listmonkFixture(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", "listmonk-v6.1.0", name))
	if err != nil {
		t.Fatalf("read recorded Listmonk response %s: %v", name, err)
	}
	return body
}

// fakeListmonk answers the list endpoints the gateway calls with recorded
// Listmonk v6.1.0 bodies, and records every request it receives.
type fakeListmonk struct {
	t           *testing.T
	mu          sync.Mutex
	requests    []string
	catalogue   []byte // GET /api/lists?per_page=all
	defaultPage []byte // GET /api/lists without per_page (Listmonk's page of 20)
	server      *httptest.Server
}

func newFakeListmonk(t *testing.T, catalogue []byte) *fakeListmonk {
	t.Helper()
	f := &fakeListmonk{t: t, catalogue: catalogue, defaultPage: listmonkFixture(t, "lists_default_page_24.json")}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, r.Method+" "+r.URL.RequestURI())
		catalogue := f.catalogue
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists":
			if r.URL.Query().Get("per_page") == "all" {
				_, _ = w.Write(catalogue)
				return
			}
			_, _ = w.Write(f.defaultPage)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/lists/"):
			// Listmonk answers every delete — even of a list it does not have —
			// with this body (delete_missing_list.json is identical).
			_, _ = w.Write(listmonkFixture(t, "delete_list.json"))
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/api/lists/"):
			_, _ = io.Copy(io.Discard, r.Body)
			_, _ = w.Write(listmonkFixture(t, "create_list.json"))
		default:
			t.Errorf("fake Listmonk: unexpected %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeListmonk) setCatalogue(body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.catalogue = body
}

func (f *fakeListmonk) received() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

// listRoutes is the production list route table over pool, talking to engine.
func listRoutes(pool *pgxpool.Pool, engine *fakeListmonk) (http.Handler, *Deps) {
	d := New(engine.server.URL, "api", "token")
	d.Repo = &Repo{
		Pool:             pool,
		OutboundWebhooks: &outbound_webhooks.Store{Pool: pool, Cipher: reversingTestCipher{}},
	}
	router := chi.NewRouter()
	d.MountRoutes(router)
	d.MountIdempotentRoutes(router)
	return router, d
}

// callAs sends one request through router as an API key of tenantID holding
// both subscriber scopes.
func callAs(t *testing.T, router http.Handler, tenantID, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

type catalogueResponse struct {
	Data struct {
		Results []map[string]json.RawMessage `json:"results"`
		Total   int                          `json:"total"`
	} `json:"data"`
}

func decodeCatalogue(t *testing.T, w *httptest.ResponseRecorder) catalogueResponse {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("catalogue status = %d, body = %s", w.Code, w.Body.String())
	}
	var out catalogueResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode catalogue: %v (body=%s)", err, w.Body.String())
	}
	return out
}

func catalogueRow(t *testing.T, page catalogueResponse, engineID int64) map[string]json.RawMessage {
	t.Helper()
	for _, row := range page.Data.Results {
		var id int64
		if err := json.Unmarshal(row["id"], &id); err == nil && id == engineID {
			return row
		}
	}
	return nil
}

func catalogueIDs(t *testing.T, page catalogueResponse) []int64 {
	t.Helper()
	ids := make([]int64, 0, len(page.Data.Results))
	for _, row := range page.Data.Results {
		ids = append(ids, rawInt(t, row["id"]))
	}
	return ids
}

func rawString(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("decode %s as string: %v", raw, err)
	}
	return s
}

func rawInt(t *testing.T, raw json.RawMessage) int64 {
	t.Helper()
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil {
		t.Fatalf("decode %s as integer: %v", raw, err)
	}
	return n
}

func mapListIdentity(t *testing.T, pool *pgxpool.Pool, tenantID string, engineID int64) string {
	t.Helper()
	listUUID, err := (&Repo{Pool: pool}).ensureListIDMap(context.Background(), tenantID, uuid.NewString(), engineID)
	if err != nil {
		t.Fatalf("map engine list %d: %v", engineID, err)
	}
	return listUUID
}

func countIdentityRows(t *testing.T, pool *pgxpool.Pool, tenantID string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open identity count: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM list_id_map WHERE tenant_id = $1::uuid`, tenantID).Scan(&n); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	return n
}

// reversingTestCipher is a reversible stand-in for the KMS envelope cipher.
type reversingTestCipher struct{}

func (reversingTestCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	out := make([]byte, len(plaintext))
	for i, b := range plaintext {
		out[len(plaintext)-1-i] = b
	}
	return out, nil
}

func (c reversingTestCipher) Decrypt(ctx context.Context, blob, _ []byte) ([]byte, error) {
	return c.Encrypt(ctx, blob)
}

// TestCatalogueAttributesEngineListsToThisTenant is LIST-B1 and LIST-C1: every
// catalogue row now carries the Moosewave identity the create handler minted,
// and its subscriber_count is the Members tab's count.
func TestCatalogueAttributesEngineListsToThisTenant(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	_ = seedListIdentityTenant(t, pool) // a second tenant: the engine is shared
	engine := newFakeListmonk(t, listmonkFixture(t, "lists_all_24.json"))
	router, _ := listRoutes(pool, engine)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	list10 := mapListIdentity(t, pool, tenantID, 10)
	// 24 is the newest list: Listmonk's default page of 20 does not contain it.
	list24 := mapListIdentity(t, pool, tenantID, 24)
	stamp := time.Now().UnixNano()
	for i := 0; i < 3; i++ {
		if err := repo.AddEmailToList(ctx, tenantID, list10, fmt.Sprintf("catalogue-%d-%d@example.test", stamp, i), "api"); err != nil {
			t.Fatalf("seed membership %d: %v", i, err)
		}
	}
	members, _, err := repo.ListMembers(ctx, tenantID, list10, "", "", 1, 25)
	if err != nil || len(members) != 3 {
		t.Fatalf("seeded members = %d, %v", len(members), err)
	}
	if removed, removeErr := repo.RemoveMember(ctx, tenantID, list10, members[0].ID); removeErr != nil || !removed {
		t.Fatalf("remove one member: %v %v", removed, removeErr)
	}

	page := decodeCatalogue(t, callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists", ""))
	if got := engine.received(); len(got) != 1 || got[0] != "GET /api/lists?per_page=all" {
		t.Fatalf("engine requests = %v, want one whole-catalogue read", got)
	}
	if page.Data.Total != 2 || len(page.Data.Results) != 2 {
		t.Fatalf("catalogue rows = %d (total %d), want exactly this tenant's 2 lists", len(page.Data.Results), page.Data.Total)
	}

	row10 := catalogueRow(t, page, 10)
	if row10 == nil {
		t.Fatal("list 10 missing from the catalogue")
	}
	if got := rawString(t, row10["postwave_uuid"]); got != list10 {
		t.Fatalf("list 10 postwave_uuid = %q, want the minted identity %q", got, list10)
	}
	// Listmonk's own list uuid (recorded) is a third identity: passed through,
	// never mistaken for the Moosewave one.
	if engineUUID := rawString(t, row10["uuid"]); engineUUID != "3225c31d-5d1f-4bcf-8143-a59210b219eb" {
		t.Fatalf("list 10 uuid = %q, want Listmonk's recorded list uuid untouched", engineUUID)
	}
	if got := rawInt(t, row10["subscriber_count"]); got != 2 {
		t.Fatalf("list 10 subscriber_count = %d, want 2 (3 added, 1 removed)", got)
	}
	if got := rawInt(t, row10["engine_subscriber_count"]); got != 0 {
		t.Fatalf("list 10 engine_subscriber_count = %d, want Listmonk's own 0", got)
	}
	if _, present := row10["subscriber_statuses"]; present {
		t.Fatal("subscriber_statuses (Listmonk's breakdown) is still presented as the list's own")
	}
	if string(row10["engine_subscriber_statuses"]) != "{}" {
		t.Fatalf("engine_subscriber_statuses = %s, want Listmonk's {}", row10["engine_subscriber_statuses"])
	}
	if rawString(t, row10["name"]) != "Weekly digest 8" {
		t.Fatalf("list 10 name = %s, fields were not passed through", row10["name"])
	}

	row24 := catalogueRow(t, page, 24)
	if row24 == nil || rawString(t, row24["postwave_uuid"]) != list24 {
		t.Fatalf("list 24 (past Listmonk's default page) = %v, want it present with its identity", row24)
	}

	// The card and the Members tab now count the same thing.
	w := callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists/10/subscribers", "")
	var membersPage MembersPage
	if err = json.Unmarshal(w.Body.Bytes(), &membersPage); err != nil || w.Code != http.StatusOK {
		t.Fatalf("members page: %d %s", w.Code, w.Body.String())
	}
	if int64(membersPage.Total) != rawInt(t, row10["subscriber_count"]) {
		t.Fatalf("Members tab total %d != catalogue subscriber_count %d", membersPage.Total, rawInt(t, row10["subscriber_count"]))
	}
	audience, err := repo.CountListAudience(ctx, tenantID, "10")
	if err != nil || audience != int64(membersPage.Total) {
		t.Fatalf("campaign audience count = %d, %v; want %d", audience, err, membersPage.Total)
	}
}

func TestCatalogueForwardsSearchToTheEngine(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	_ = seedListIdentityTenant(t, pool)
	engine := newFakeListmonk(t, listmonkFixture(t, "lists_query_all.json"))
	router, _ := listRoutes(pool, engine)
	list14 := mapListIdentity(t, pool, tenantID, 14)

	page := decodeCatalogue(t, callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists?q=digest%2012", ""))
	if got := engine.received(); len(got) != 1 || got[0] != "GET /api/lists?per_page=all&query=digest+12" {
		t.Fatalf("engine requests = %v, want the search forwarded with the whole-catalogue page", got)
	}
	if len(page.Data.Results) != 1 || rawString(t, page.Data.Results[0]["postwave_uuid"]) != list14 {
		t.Fatalf("search results = %+v", page.Data.Results)
	}
}

// TestCatalogueHidesEngineListsNoTenantCanProveItOwns is LIST-B2 on a shared
// engine: Listmonk's install-time lists have no identity, and with two tenants
// neither can claim them. They are not shown, and nothing is minted for them.
func TestCatalogueHidesEngineListsNoTenantCanProveItOwns(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	otherTenant := seedListIdentityTenant(t, pool)
	engine := newFakeListmonk(t, listmonkFixture(t, "fresh_install_lists_all.json"))
	router, _ := listRoutes(pool, engine)
	// The other tenant created list 2 through this API; it is theirs.
	mapListIdentity(t, pool, otherTenant, 2)

	page := decodeCatalogue(t, callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists", ""))
	if len(page.Data.Results) != 0 || page.Data.Total != 0 {
		t.Fatalf("catalogue rows = %v, want none: list 1 is unattributable and list 2 is another tenant's",
			catalogueIDs(t, page))
	}
	if n := countIdentityRows(t, pool, tenantID); n != 0 {
		t.Fatalf("identities minted on a shared engine = %d, want 0", n)
	}
	for _, id := range []string{"1", "2"} {
		if w := callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists/"+id+"/subscribers", ""); w.Code != http.StatusNotFound {
			t.Fatalf("members of list %s = %d, want 404", id, w.Code)
		}
		if w := callAs(t, router, tenantID, http.MethodPatch, "/api/v1/lists/"+id, `{"name":"Mine now"}`); w.Code != http.StatusNotFound {
			t.Fatalf("rename of list %s = %d %s, want 404", id, w.Code, w.Body.String())
		}
		if w := callAs(t, router, tenantID, http.MethodDelete, "/api/v1/lists/"+id, ""); w.Code != http.StatusNotFound {
			t.Fatalf("delete of list %s = %d %s, want 404", id, w.Code, w.Body.String())
		}
	}
	for _, req := range engine.received() {
		if !strings.HasPrefix(req, "GET ") {
			t.Fatalf("a write for a list this tenant does not own reached the engine: %s", req)
		}
	}
}

func TestCatalogueRejectsEngineResponsesItCannotAttribute(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	engine := newFakeListmonk(t, []byte(`{"data":{"results":[{"name":"no id"}]}}`))
	router, _ := listRoutes(pool, engine)

	w := callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists", "")
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "internal_error") || strings.Contains(w.Body.String(), "no id") {
		t.Fatalf("row without an id: status %d body %s, want a sanitized 502", w.Code, w.Body.String())
	}
	engine.setCatalogue([]byte(strings.Repeat("x", int(listmonkProxyMaxBodyBytes)+1)))
	w = callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists", "")
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "internal_error") {
		t.Fatalf("oversized engine body: status %d body %.200s, want a sanitized 500", w.Code, w.Body.String())
	}
}

func TestUpdateRenamesOnlyThisTenantsLists(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	_ = seedListIdentityTenant(t, pool)
	engine := newFakeListmonk(t, listmonkFixture(t, "lists_all_24.json"))
	router, _ := listRoutes(pool, engine)
	mapListIdentity(t, pool, tenantID, 7)

	w := callAs(t, router, tenantID, http.MethodPatch, "/api/v1/lists/7", `{"name":"Renamed","type":"public","optin":"double"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("rename own list: %d %s", w.Code, w.Body.String())
	}
	if got := engine.received(); len(got) != 1 || got[0] != "PUT /api/lists/7" {
		t.Fatalf("engine requests = %v, want PUT /api/lists/7", got)
	}
}

// TestDeleteRetiresTheListIdentityAndItsFootprint is LIST-H.
func TestDeleteRetiresTheListIdentityAndItsFootprint(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	_ = seedListIdentityTenant(t, pool)
	engine := newFakeListmonk(t, listmonkFixture(t, "lists_all_24.json"))
	router, d := listRoutes(pool, engine)
	repo := d.Repo
	ctx := context.Background()

	list5 := mapListIdentity(t, pool, tenantID, 5)
	stamp := time.Now().UnixNano()
	for i := 0; i < 2; i++ {
		if err := repo.AddEmailToList(ctx, tenantID, list5, fmt.Sprintf("retire-%d-%d@example.test", stamp, i), "api"); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	hook, err := repo.OutboundWebhooks.Create(ctx, tenantID, "", outbound_webhooks.CreateInput{
		URL:    "https://hooks.example.test/list-events",
		Events: []string{outbound_webhooks.EventListSubscriberAdded},
		ListID: list5,
	}, false)
	if err != nil {
		t.Fatalf("create list-scoped webhook: %v", err)
	}

	w := callAs(t, router, tenantID, http.MethodDelete, "/api/v1/lists/5", "")
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"data":true}` {
		t.Fatalf("delete: %d %s, want Listmonk's 200 {\"data\":true}", w.Code, w.Body.String())
	}
	if got := engine.received(); len(got) != 1 || got[0] != "DELETE /api/lists/5" {
		t.Fatalf("engine requests = %v", got)
	}

	for _, id := range []string{"5", list5} {
		if w := callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists/"+id+"/subscribers", ""); w.Code != http.StatusNotFound {
			t.Fatalf("members of the deleted list via %s = %d %s, want 404", id, w.Code, w.Body.String())
		}
	}
	if _, err = repo.CountListAudience(ctx, tenantID, list5); err == nil {
		t.Fatal("a campaign aimed at the deleted list still resolves its audience")
	}

	// Memberships and owners are soft-removed, not erased.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open footprint read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var active, removed, activeOwners int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE removed_at IS NULL), count(*) FILTER (WHERE removed_at IS NOT NULL)
  FROM list_subscribers WHERE tenant_id = $1::uuid AND list_id = $2::uuid`, tenantID, list5).Scan(&active, &removed); err != nil {
		t.Fatalf("count memberships: %v", err)
	}
	if active != 0 || removed != 2 {
		t.Fatalf("memberships after delete: active=%d removed=%d, want 0 and 2", active, removed)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM list_subscriber_sources
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL`, tenantID, list5).Scan(&activeOwners); err != nil {
		t.Fatalf("count owners: %v", err)
	}
	if activeOwners != 0 {
		t.Fatalf("active membership owners after delete = %d, want 0", activeOwners)
	}
	var hookActive bool
	var hookDeleted *time.Time
	if err := tx.QueryRow(ctx, `SELECT active, deleted_at FROM outbound_webhooks WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, hook.Webhook.ID).Scan(&hookActive, &hookDeleted); err != nil {
		t.Fatalf("read list-scoped webhook: %v", err)
	}
	if hookActive || hookDeleted == nil {
		t.Fatalf("list-scoped webhook after delete: active=%v deleted_at=%v, want a tombstone", hookActive, hookDeleted)
	}
	var visible int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM list_id_map WHERE tenant_id = $1::uuid AND postwave_uuid = $2::uuid`,
		tenantID, list5).Scan(&visible); err != nil {
		t.Fatalf("read identity: %v", err)
	}
	if visible != 0 {
		t.Fatal("the deleted list's identity is still visible to the application role")
	}

	if n := countIdentityRows(t, pool, tenantID); n != 0 {
		t.Fatalf("live identities after delete = %d, want 0", n)
	}
}

// soleTenantShadowPool returns an application-role pool whose `tenants` is a
// private one-row table holding only tenantID, so the engine tenancy proof can
// be exercised deterministically on a shared test database (other tests create
// tenants concurrently). Every other table resolves to public, where tenantID
// is a real tenant. Also returns an admin connection to change the shadow.
func soleTenantShadowPool(t *testing.T, tenantID string, configure ...func(*pgxpool.Config)) (*pgxpool.Pool, *pgx.Conn, string) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and DATABASE_URL are required for the sole-tenant engine proof")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	schema := "lists_engine_tenancy_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatalf("create shadow schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE") })
	if _, err = admin.Exec(ctx, `
CREATE TABLE `+quoted+`.tenants (id uuid PRIMARY KEY);
GRANT USAGE ON SCHEMA `+quoted+` TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON `+quoted+`.tenants TO postwave_app;
ALTER TABLE `+quoted+`.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE `+quoted+`.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_worker_select ON `+quoted+`.tenants
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');`); err != nil {
		t.Fatalf("create shadow tenants: %v", err)
	}
	if _, err = admin.Exec(ctx, `INSERT INTO `+quoted+`.tenants (id) VALUES ($1::uuid)`, tenantID); err != nil {
		t.Fatalf("seed shadow tenant: %v", err)
	}
	config, err := pgxpool.ParseConfig(appURL)
	if err != nil {
		t.Fatalf("parse app URL: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	for _, apply := range configure {
		apply(config)
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("connect shadow app pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, admin, quoted
}

// TestSoleTenantProofHoldsTenantCreationOffUntilTheAdoptionCommits pins the
// check-then-act window: between proving there is one tenant and writing that
// tenant's identities, a second tenant must not be able to appear.
func TestSoleTenantProofHoldsTenantCreationOffUntilTheAdoptionCommits(t *testing.T) {
	appPool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, appPool)
	pool, admin, shadow := soleTenantShadowPool(t, tenantID)
	ctx := context.Background()

	tx, err := db.WithTenantWorker(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open proof tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sole, err := proveSoleTenantTx(ctx, tx, tenantID)
	if err != nil || !sole {
		t.Fatalf("sole-tenant proof = %v, %v; want true", sole, err)
	}
	inserted := make(chan error, 1)
	go func() {
		_, insertErr := admin.Exec(context.Background(), `INSERT INTO `+shadow+`.tenants (id) VALUES ($1::uuid)`, uuid.NewString())
		inserted <- insertErr
	}()
	select {
	case insertErr := <-inserted:
		t.Fatalf("a tenant was created inside the proof window: %v", insertErr)
	case <-time.After(200 * time.Millisecond):
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatalf("end proof tx: %v", err)
	}
	select {
	case insertErr := <-inserted:
		if insertErr != nil {
			t.Fatalf("tenant creation after the proof: %v", insertErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("tenant creation still blocked after the proof ended")
	}
	proof, err := db.WithTenantWorker(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open second proof tx: %v", err)
	}
	defer func() { _ = proof.Rollback(ctx) }()
	if sole, err = proveSoleTenantTx(ctx, proof, tenantID); err != nil || sole {
		t.Fatalf("proof with two tenants = %v, %v; want false", sole, err)
	}
}

// TestCatalogueAdoptsEngineListsForTheSoleTenant is LIST-B2 where it can be
// resolved: with one tenant, every engine list is that tenant's, so Listmonk's
// install-time lists get an identity and become usable — once, not per read.
func TestCatalogueAdoptsEngineListsForTheSoleTenant(t *testing.T) {
	appPool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, appPool)
	pool, admin, shadow := soleTenantShadowPool(t, tenantID)
	engine := newFakeListmonk(t, listmonkFixture(t, "fresh_install_lists_all.json"))
	router, _ := listRoutes(pool, engine)

	first := decodeCatalogue(t, callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists", ""))
	if len(first.Data.Results) != 2 {
		t.Fatalf("sole-tenant catalogue rows = %d, want Listmonk's two install lists", len(first.Data.Results))
	}
	adopted := map[int64]string{}
	for _, engineID := range []int64{1, 2} {
		row := catalogueRow(t, first, engineID)
		if row == nil {
			t.Fatalf("list %d missing", engineID)
		}
		adopted[engineID] = rawString(t, row["postwave_uuid"])
		if _, err := uuid.Parse(adopted[engineID]); err != nil {
			t.Fatalf("list %d postwave_uuid = %q, want a minted uuid", engineID, adopted[engineID])
		}
		if got := rawInt(t, row["subscriber_count"]); got != 0 {
			t.Fatalf("list %d subscriber_count = %d, want 0 Moosewave members", engineID, got)
		}
		if got := rawInt(t, row["engine_subscriber_count"]); got != 1 {
			t.Fatalf("list %d engine_subscriber_count = %d, want Listmonk's recorded 1", engineID, got)
		}
	}
	if n := countIdentityRows(t, appPool, tenantID); n != 2 {
		t.Fatalf("identities after adoption = %d, want exactly 2", n)
	}

	second := decodeCatalogue(t, callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists", ""))
	for engineID, want := range adopted {
		if got := rawString(t, catalogueRow(t, second, engineID)["postwave_uuid"]); got != want {
			t.Fatalf("list %d re-read as %q, want the adopted %q (adoption must not re-mint)", engineID, got, want)
		}
	}
	if n := countIdentityRows(t, appPool, tenantID); n != 2 {
		t.Fatalf("identities after a second read = %d, want still 2", n)
	}
	w := callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists/1/subscribers", "")
	var members MembersPage
	if err := json.Unmarshal(w.Body.Bytes(), &members); err != nil || w.Code != http.StatusOK || members.ListID != adopted[1] {
		t.Fatalf("members of the adopted Default list: %d %s", w.Code, w.Body.String())
	}

	// A second tenant arrives: the engine is shared from now on. Lists that
	// already have an identity keep it; new unattributed ones stay hidden.
	if _, err := admin.Exec(context.Background(), `INSERT INTO `+shadow+`.tenants (id) VALUES ($1::uuid)`, uuid.NewString()); err != nil {
		t.Fatalf("add second shadow tenant: %v", err)
	}
	engine.setCatalogue(listmonkFixture(t, "lists_all_24.json"))
	third := decodeCatalogue(t, callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists", ""))
	if len(third.Data.Results) != 2 || catalogueRow(t, third, 1) == nil || catalogueRow(t, third, 2) == nil {
		t.Fatalf("shared-engine catalogue = %d rows, want only the two lists this tenant already owns", len(third.Data.Results))
	}
	if n := countIdentityRows(t, appPool, tenantID); n != 2 {
		t.Fatalf("identities after the engine became shared = %d, want still 2", n)
	}
}

// TestRetireListIdentityIsConfinedToTheCallersTenant pins the SECURITY
// DEFINER from migration 2051: it bypasses RLS to write retired_at, so the
// session tenant is its only authority. Another tenant's identity is out of
// reach, and a session with no tenant is refused outright.
func TestRetireListIdentityIsConfinedToTheCallersTenant(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantA := seedListIdentityTenant(t, pool)
	tenantB := seedListIdentityTenant(t, pool)
	listB := mapListIdentity(t, pool, tenantB, 41)
	ctx := context.Background()

	tx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open tenant A tx: %v", err)
	}
	var retired bool
	if err = tx.QueryRow(ctx, `SELECT retire_list_identity($1::uuid)`, listB).Scan(&retired); err != nil {
		t.Fatalf("retire from another tenant: %v", err)
	}
	_ = tx.Rollback(ctx)
	if retired {
		t.Fatal("tenant A retired tenant B's list identity")
	}
	if _, err = (&Repo{Pool: pool}).GetListBigintIDByUUID(ctx, tenantB, listB); err != nil {
		t.Fatalf("tenant B's identity after tenant A's attempt: %v, want still live", err)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SELECT retire_list_identity($1::uuid)`, listB); err == nil ||
		!strings.Contains(err.Error(), "requires a tenant-scoped transaction") {
		t.Fatalf("retire without a tenant: err=%v, want refusal", err)
	}
}

// TestDeletedListIdentityCannotBeWrittenToByAWriterThatRacedTheDelete pins
// the lock pairing: a membership writer that resolved the list FOR KEY SHARE
// while the delete held it FOR UPDATE must, once the delete commits, find no
// list — not add members to the deleted one.
func TestDeletedListIdentityCannotBeWrittenToByAWriterThatRacedTheDelete(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	listUUID := mapListIdentity(t, pool, tenantID, 31)
	ctx := context.Background()

	deleter, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open deleting tx: %v", err)
	}
	defer func() { _ = deleter.Rollback(ctx) }()
	identity, mapped, err := lockEngineListIdentity(ctx, deleter, tenantID, 31)
	if err != nil || !mapped || identity.UUID != listUUID {
		t.Fatalf("lock identity: %+v mapped=%v err=%v", identity, mapped, err)
	}

	resolved := make(chan error, 1)
	go func() {
		writer, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			resolved <- err
			return
		}
		defer func() { _ = writer.Rollback(ctx) }()
		_, err = ResolveListIdentityTx(ctx, writer, tenantID, "31")
		resolved <- err
	}()
	select {
	case err := <-resolved:
		t.Fatalf("the writer did not wait for the delete holding the identity: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	if _, err := retireListIdentityTx(ctx, deleter, tenantID, identity); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if err := deleter.Commit(ctx); err != nil {
		t.Fatalf("commit delete: %v", err)
	}
	select {
	case err := <-resolved:
		if err != ErrListIDNotMapped {
			t.Fatalf("writer queued behind the delete resolved the list: err=%v, want ErrListIDNotMapped", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("writer still blocked after the delete committed")
	}
}

func TestListScopedRoutesRefuseUnknownAndDeletedLists(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	engine := newFakeListmonk(t, listmonkFixture(t, "lists_all_24.json"))
	router, d := listRoutes(pool, engine)
	listUUID := mapListIdentity(t, pool, tenantID, 12)
	ctx := context.Background()

	// Both forms of a live list resolve, and a uuid is canonicalised.
	for _, id := range []string{"12", strings.ToUpper(listUUID)} {
		got, err := d.Repo.resolveListUUID(ctx, tenantID, id)
		if err != nil || got != listUUID {
			t.Fatalf("resolve %q = %q, %v; want %q", id, got, err, listUUID)
		}
	}
	subscriber := uuid.NewString()
	for _, tc := range []struct {
		method, path, body string
		want               int
	}{
		{http.MethodGet, "/api/v1/lists/" + uuid.NewString() + "/subscribers", "", http.StatusNotFound},
		{http.MethodPost, "/api/v1/lists/" + uuid.NewString() + "/subscribers", `{"subscriber_ids":["` + subscriber + `"]}`, http.StatusNotFound},
		{http.MethodDelete, "/api/v1/lists/" + uuid.NewString() + "/subscribers/" + subscriber, "", http.StatusNotFound},
		{http.MethodGet, "/api/v1/lists/" + uuid.NewString() + "/suppressions", "", http.StatusNotFound},
		{http.MethodPost, "/api/v1/lists/abc/subscribers", `{"subscriber_ids":["` + subscriber + `"]}`, http.StatusBadRequest},
		{http.MethodGet, "/api/v1/lists/abc/suppressions", "", http.StatusBadRequest},
	} {
		if w := callAs(t, router, tenantID, tc.method, tc.path, tc.body); w.Code != tc.want {
			t.Fatalf("%s %s = %d %s, want %d", tc.method, tc.path, w.Code, w.Body.String(), tc.want)
		}
	}
	var orphanRows int
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open orphan check: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM list_subscribers WHERE tenant_id = $1::uuid`, tenantID).Scan(&orphanRows); err != nil {
		t.Fatalf("count memberships: %v", err)
	}
	if orphanRows != 0 {
		t.Fatalf("memberships written for lists that do not exist = %d", orphanRows)
	}
	if err := tx.Commit(ctx); err != nil && err != pgx.ErrTxClosed {
		t.Fatalf("commit orphan check: %v", err)
	}
}

// TestListsForSubscriberNamesListsWhoseMembershipLacksTheEngineID is LIST-G.
func TestListsForSubscriberNamesListsWhoseMembershipLacksTheEngineID(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	engine := newFakeListmonk(t, listmonkFixture(t, "lists_all_24.json"))
	router, _ := listRoutes(pool, engine)
	listUUID := mapListIdentity(t, pool, tenantID, 9)
	ctx := context.Background()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open seed: %v", err)
	}
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		tenantID, fmt.Sprintf("lists-panel-%d@example.test", time.Now().UnixNano())).Scan(&subscriberID); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	// Exactly the row the old bulk verb wrote: no engine id, no address.
	if _, err := tx.Exec(ctx, `
INSERT INTO list_subscribers (tenant_id, list_id, subscriber_id)
VALUES ($1::uuid, $2::uuid, $3::uuid)`, tenantID, listUUID, subscriberID); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	w := callAs(t, router, tenantID, http.MethodGet, "/api/v1/lists/for-subscriber/"+subscriberID, "")
	if w.Code != http.StatusOK {
		t.Fatalf("lists for subscriber: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Items []SubscriberListRef `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Items) != 1 || out.Items[0].ID != listUUID || out.Items[0].Name != "Weekly digest 7" {
		t.Fatalf("lists panel = %+v, want list %s named from the engine (Weekly digest 7)", out.Items, listUUID)
	}
}
