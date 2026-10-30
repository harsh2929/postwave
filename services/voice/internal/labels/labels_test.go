package labels

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// --- in-memory fake LabelStore for the handler-level tests ---

type fakeStore struct {
	mu     sync.Mutex
	rows   []Label
	nextID int
	// failNext lets a single test simulate a store error without
	// changing the receiver to an error-returning impl.
	failNext error
}

func (f *fakeStore) Create(_ context.Context, tenantID string, l Label) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext != nil {
		err := f.failNext
		f.failNext = nil
		return "", err
	}
	if err := ValidateLabel(l.Axis, l.Value, l.SampleText); err != nil {
		return "", err
	}
	f.nextID++
	l.ID = "fake-" + itoa(f.nextID)
	l.TenantID = tenantID
	l.CreatedAt = time.Now().UTC()
	f.rows = append(f.rows, l)
	return l.ID, nil
}

func (f *fakeStore) List(_ context.Context, tenantID, axis string, limit, offset int) ([]Label, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if axis != "" {
		if _, ok := validAxes[axis]; !ok {
			return nil, 0, ErrInvalidAxis
		}
	}
	filtered := make([]Label, 0, len(f.rows))
	for _, l := range f.rows {
		if l.TenantID != tenantID {
			continue
		}
		if axis != "" && l.Axis != axis {
			continue
		}
		filtered = append(filtered, l)
	}
	total := len(filtered)
	start := offset
	if start > total {
		start = total
	}
	end := start + limit
	if end > total {
		end = total
	}
	return filtered[start:end], total, nil
}

func (f *fakeStore) Delete(_ context.Context, tenantID, labelID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, l := range f.rows {
		if l.TenantID == tenantID && l.ID == labelID {
			f.rows = append(f.rows[:i], f.rows[i+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

func (f *fakeStore) Export(_ context.Context, tenantID string) ([]Label, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Label, 0, len(f.rows))
	for _, l := range f.rows {
		if l.TenantID == tenantID {
			out = append(out, l)
		}
	}
	return out, nil
}

func itoa(n int) string {
	// tiny non-fmt-importing itoa to keep fake-store deps minimal
	if n == 0 {
		return "0"
	}
	var b []byte
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

// --- handler-level tests ---

func newTestRouter(store LabelStore) chi.Router {
	d := NewDeps(store)
	r := chi.NewRouter()
	r.Mount("/v1/voice/labels", d.Routes())
	return r
}

func doReq(t *testing.T, r chi.Router, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reqBody *strings.Reader
	if body == "" {
		reqBody = strings.NewReader("")
	} else {
		reqBody = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reqBody)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestValidateLabel(t *testing.T) {
	cases := []struct {
		name string
		axis string
		val  float64
		text string
		want error
	}{
		{"ok", "humor", 0.5, "the text", nil},
		{"ok-lower", "humor", 0.0, "the text", nil},
		{"ok-upper", "humor", 1.0, "the text", nil},
		{"bad-axis", "boldness", 0.5, "x", ErrInvalidAxis},
		{"low", "humor", -0.01, "x", ErrInvalidValue},
		{"high", "humor", 1.01, "x", ErrInvalidValue},
		{"empty", "humor", 0.5, "  ", ErrEmptySampleText},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ValidateLabel(c.axis, c.val, c.text)
			if got != c.want {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}

func TestCreate_MissingTenant(t *testing.T) {
	r := newTestRouter(&fakeStore{})
	rec := doReq(t, r, "POST", "/v1/voice/labels/", `{"sample_text":"x","axis":"humor","value":0.5}`, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestCreate_BadJSON(t *testing.T) {
	r := newTestRouter(&fakeStore{})
	rec := doReq(t, r, "POST", "/v1/voice/labels/", `not-json`, map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestCreate_OversizedBody(t *testing.T) {
	r := newTestRouter(&fakeStore{})
	body := `{"sample_text":"` + strings.Repeat("x", int(labelJSONMaxBodyBytes)) + `","axis":"humor","value":0.5}`
	rec := doReq(t, r, "POST", "/v1/voice/labels/", body, map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestCreate_InvalidAxis(t *testing.T) {
	r := newTestRouter(&fakeStore{})
	rec := doReq(t, r, "POST", "/v1/voice/labels/", `{"sample_text":"hi","axis":"meanness","value":0.5}`, map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestCreate_OutOfRangeValue(t *testing.T) {
	r := newTestRouter(&fakeStore{})
	rec := doReq(t, r, "POST", "/v1/voice/labels/", `{"sample_text":"hi","axis":"humor","value":1.5}`, map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestCreate_Happy(t *testing.T) {
	fs := &fakeStore{}
	r := newTestRouter(fs)
	rec := doReq(t, r, "POST", "/v1/voice/labels/",
		`{"sample_text":"hello world","axis":"humor","value":0.42,"notes":"chuckle"}`,
		map[string]string{"X-Tenant-ID": "t1", "X-User-ID": "u-1"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%q", rec.Code, rec.Body.String())
	}
	var resp createResp
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID == "" {
		t.Fatalf("expected id, got empty")
	}
	if len(fs.rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(fs.rows))
	}
	if fs.rows[0].LabeledBy != "u-1" {
		t.Fatalf("expected labeled_by=u-1, got %q", fs.rows[0].LabeledBy)
	}
}

func TestList_Pagination(t *testing.T) {
	fs := &fakeStore{}
	for i := 0; i < 5; i++ {
		_, _ = fs.Create(context.Background(), "t1", Label{SampleText: "s" + itoa(i), Axis: "humor", Value: 0.3})
	}
	r := newTestRouter(fs)
	rec := doReq(t, r, "GET", "/v1/voice/labels/?page=1&size=2", "", map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var resp listResp
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 5 {
		t.Fatalf("want total=5, got %d", resp.Total)
	}
	if len(resp.Items) != 2 {
		t.Fatalf("want 2 items, got %d", len(resp.Items))
	}
}

func TestList_FilterByAxis(t *testing.T) {
	fs := &fakeStore{}
	_, _ = fs.Create(context.Background(), "t1", Label{SampleText: "a", Axis: "humor", Value: 0.4})
	_, _ = fs.Create(context.Background(), "t1", Label{SampleText: "b", Axis: "formality", Value: 0.8})
	r := newTestRouter(fs)
	rec := doReq(t, r, "GET", "/v1/voice/labels/?axis=formality", "", map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var resp listResp
	_ = json.NewDecoder(rec.Body).Decode(&resp)
	if len(resp.Items) != 1 || resp.Items[0].Axis != "formality" {
		t.Fatalf("filter failed: %+v", resp.Items)
	}
}

func TestList_BadAxis(t *testing.T) {
	r := newTestRouter(&fakeStore{})
	rec := doReq(t, r, "GET", "/v1/voice/labels/?axis=nope", "", map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestDelete_RequiresAdmin(t *testing.T) {
	fs := &fakeStore{}
	id, _ := fs.Create(context.Background(), "t1", Label{SampleText: "x", Axis: "humor", Value: 0.5})
	r := newTestRouter(fs)
	// no role header → 403
	rec := doReq(t, r, "DELETE", "/v1/voice/labels/"+id, "", map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", rec.Code)
	}
	if len(fs.rows) != 1 {
		t.Fatalf("row should still exist")
	}
}

func TestDelete_AdminOK(t *testing.T) {
	fs := &fakeStore{}
	id, _ := fs.Create(context.Background(), "t1", Label{SampleText: "x", Axis: "humor", Value: 0.5})
	r := newTestRouter(fs)
	rec := doReq(t, r, "DELETE", "/v1/voice/labels/"+id, "",
		map[string]string{"X-Tenant-ID": "t1", "X-Postwave-Role": "admin"})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d body=%q", rec.Code, rec.Body.String())
	}
	if len(fs.rows) != 0 {
		t.Fatalf("expected row removed")
	}
}

func TestDelete_NotFound(t *testing.T) {
	fs := &fakeStore{}
	r := newTestRouter(fs)
	rec := doReq(t, r, "DELETE", "/v1/voice/labels/does-not-exist", "",
		map[string]string{"X-Tenant-ID": "t1", "X-Postwave-Role": "owner"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}

func TestExport_RequiresAdmin(t *testing.T) {
	fs := &fakeStore{}
	_, _ = fs.Create(context.Background(), "t1", Label{SampleText: "x", Axis: "humor", Value: 0.5})
	r := newTestRouter(fs)
	rec := doReq(t, r, "GET", "/v1/voice/labels/export.json", "", map[string]string{"X-Tenant-ID": "t1"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", rec.Code)
	}
}

func TestExport_AdminReturnsAll(t *testing.T) {
	fs := &fakeStore{}
	for i := 0; i < 3; i++ {
		_, _ = fs.Create(context.Background(), "t1", Label{SampleText: "s" + itoa(i), Axis: "humor", Value: 0.5})
	}
	r := newTestRouter(fs)
	rec := doReq(t, r, "GET", "/v1/voice/labels/export.json", "",
		map[string]string{"X-Tenant-ID": "t1", "X-Postwave-Role": "admin"})
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var rows []labelJSON
	if err := json.NewDecoder(rec.Body).Decode(&rows); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("want 3 rows, got %d", len(rows))
	}
}

func TestExport_TenantIsolation(t *testing.T) {
	fs := &fakeStore{}
	_, _ = fs.Create(context.Background(), "t1", Label{SampleText: "a", Axis: "humor", Value: 0.5})
	_, _ = fs.Create(context.Background(), "t2", Label{SampleText: "b", Axis: "humor", Value: 0.5})
	r := newTestRouter(fs)
	rec := doReq(t, r, "GET", "/v1/voice/labels/export.json", "",
		map[string]string{"X-Tenant-ID": "t1", "X-Postwave-Role": "admin"})
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var rows []labelJSON
	_ = json.NewDecoder(rec.Body).Decode(&rows)
	if len(rows) != 1 {
		t.Fatalf("expected only tenant t1 rows; got %d", len(rows))
	}
	if rows[0].SampleText != "a" {
		t.Fatalf("expected sample 'a', got %q", rows[0].SampleText)
	}
}

// --- DB-backed integration test (skipped without DATABASE_URL) ---

// seedTenant creates a tenant that belongs to the calling test alone and
// removes it when the test ends.
//
// voice_profile_labels.tenant_id references tenants(id) (migration 1730), and a
// freshly migrated database — which is what CI runs against — holds no tenants
// at all. This test used to borrow the fixed id ...beef, which nothing ever
// created, so on a clean database Create failed the foreign key. (Its pre-clean
// was a no-op too: a DELETE with no app.tenant_id bound sees no rows under
// FORCE ROW LEVEL SECURITY.) A fresh id per test also means no label can
// survive from an earlier run, so there is nothing to pre-clean.
//
// The insert runs under the new tenant's own app.tenant_id, the only shape the
// tenants INSERT policy admits for the application role, and the same shape
// signup uses (auth.Repo.CreateTenantWithOwner). The delete runs under the same
// scope and cascades to voice_profile_labels. A teardown that removes nothing
// is reported, because it means the tenant and its labels leaked.
//
// Callers must register pool.Close with t.Cleanup BEFORE calling this, so the
// pool outlives the teardown: cleanups run last-registered-first, and all of
// them run after the test body's defers.
func seedTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	inTenantTx(t, pool, tenantID, "seed tenant", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'voice labels test', 'studio')`, tenantID, "voice-labels-"+tenantID)
		return err
	})
	t.Cleanup(func() {
		var removed int64
		inTenantTx(t, pool, tenantID, "delete tenant", func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			removed = tag.RowsAffected()
			return err
		})
		if removed != 1 {
			t.Errorf("tenant teardown removed %d tenant rows, want 1; tenant %s leaked", removed, tenantID)
		}
	})
	return tenantID
}

// inTenantTx runs a fixture step (seed, read-back, teardown) in one transaction
// scoped to tenantID and commits it. It builds its own bounded context so it
// also works from t.Cleanup, after the test body's contexts are gone.
//
// It retries while Postgres reports its shared lock table full (SQLSTATE 53200,
// "out of shared memory"). Deleting a tenant cascades through every table that
// references tenants(id) — 735 foreign keys at migration head — and holds a
// lock on each of those tables and their indexes until commit: about 3,300
// locks for a single DELETE. The shared lock table holds roughly
// max_locks_per_transaction × max_connections entries (64 × 100 on the stock
// postgres:16 image CI runs), so two tenant deletes from other packages
// running at the same moment can fill it, and any statement that needs a new
// lock fails until one of them commits. That is contention on the shared test
// database, not a defect in the code under test, and it clears on its own; the
// whole transaction is rolled back and replayed. Only fixture steps retry: the
// calls under test run once.
func inTenantTx(t *testing.T, pool *pgxpool.Pool, tenantID, what string, fn func(context.Context, pgx.Tx) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	backoff := 50 * time.Millisecond
	for {
		err := runTenantTx(ctx, pool, tenantID, fn)
		if err == nil {
			return
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "53200" {
			t.Fatalf("%s: %v", what, err)
		}
		t.Logf("%s: shared lock table full, retrying in %v: %v", what, backoff, err)
		select {
		case <-ctx.Done():
			t.Fatalf("%s: lock table still full after retrying: %v", what, err)
		case <-time.After(backoff):
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}
}

func runTenantTx(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(context.Context, pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("set_config: %w", err)
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func TestStore_CRUD_Postgres(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set; skipping postgres-backed store test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("pgxpool init failed: %v", err)
	}
	// t.Cleanup, not defer: the tenant teardown seedTenant registers below
	// must still find the pool open.
	t.Cleanup(pool.Close)
	if perr := pool.Ping(ctx); perr != nil {
		t.Fatalf("postgres ping failed: %v", perr)
	}
	store, err := NewStore(pool)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	tenantID := seedTenant(t, pool)

	id, err := store.Create(ctx, tenantID, Label{
		SampleText: "the quick brown fox",
		Axis:       "humor",
		Value:      0.7,
		Notes:      "test",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if id == "" {
		t.Fatal("Create returned empty id")
	}

	// The tenant is this test's own, so the label just created is the only row
	// it can hold.
	items, total, err := store.List(ctx, tenantID, "", 50, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 1 || len(items) != 1 || items[0].ID != id {
		t.Fatalf("List = %d item(s), total %d; want exactly the created label %s", len(items), total, id)
	}

	exp, err := store.Export(ctx, tenantID)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if len(exp) != 1 || exp[0].ID != id {
		t.Fatalf("Export = %d row(s); want exactly the created label %s", len(exp), id)
	}

	if err := store.Delete(ctx, tenantID, id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, total, err := store.List(ctx, tenantID, "", 50, 0); err != nil || total != 0 {
		t.Fatalf("List after Delete = total %d, err %v; want 0 rows", total, err)
	}
}
