// SPDX-License-Identifier: AGPL-3.0-only
//
// lifecycle_harness_db_test.go — shared plumbing for the segment lifecycle DB
// tests (delete refusal, evaluate-on-save, live members, membership cache).
// Every request goes through the real chi routes and the scope middleware
// with a tenant and an owner session in context, the way the API mounts them,
// and every query runs as whatever role DATABASE_URL names (postwave_app in
// CI, so RLS is in force).

package segments

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// segmentsRouter mounts the CRUD and extended segment routes exactly as the
// API does.
func segmentsRouter(deps *Deps) http.Handler {
	r := chi.NewRouter()
	Mount(r, deps)
	MountExtended(r, deps)
	return r
}

// serveSegments sends one request as the tenant's owner and returns the
// recorder. body may be nil.
func serveSegments(t *testing.T, h http.Handler, tenantID, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return serveSegmentsWith(t, h, method, path, body, func(ctx context.Context) context.Context {
		return ownerContext(ctx, tenantID)
	})
}

// ownerContext is a dashboard session of the tenant's owner.
func ownerContext(ctx context.Context, tenantID string) context.Context {
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	return middleware.WithUser(ctx, &middleware.User{ID: uuid.NewString(), TenantID: tenantID, Role: "owner"})
}

// ifMatch sends the ETag an editor holds.
func ifMatch(etag string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("If-Match", etag) }
}

func serveSegmentsWith(t *testing.T, h http.Handler, method, path string, body any, principal func(context.Context) context.Context, options ...func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode body: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(principal(req.Context()))
	for _, option := range options {
		option(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %d response: %v; body=%s", rec.Code, err, rec.Body.String())
	}
	return out
}

// errorEnvelope is the canonical {error:{code,message}} body.
type errorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// markerAST matches every fixture subscriber whose email carries marker.
func markerAST(marker string) json.RawMessage {
	return json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"` + marker + `"}`)
}

func rawJSON(s string) json.RawMessage { return json.RawMessage(s) }

func ptrRaw(s string) *json.RawMessage {
	raw := json.RawMessage(s)
	return &raw
}

func withTenantTx(t *testing.T, pool *pgxpool.Pool, tenantID string, fn func(ctx context.Context, exec func(sql string, args ...any))) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	fn(ctx, func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec %q: %v", sql, err)
		}
	})
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// addSubscriber inserts an enabled subscriber and returns its id.
func addSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::citext, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("insert subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
	return id
}

// addCampaign inserts a campaign targeting segmentID. started marks it as
// having begun dispatch (started_at set).
func addCampaign(t *testing.T, pool *pgxpool.Pool, tenantID, segmentID, name, status string, started bool) string {
	t.Helper()
	id := uuid.NewString()
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		exec(`
INSERT INTO campaigns (id, tenant_id, name, subject, segment_id, status, started_at)
VALUES ($1::uuid, $2::uuid, $3, 'Subject', $4::uuid, $5, CASE WHEN $6 THEN now() ELSE NULL END)`,
			id, tenantID, name, segmentID, status, started)
	})
	return id
}

// segmentRow is the persisted state the lifecycle tests assert on.
type segmentRow struct {
	Exists          bool
	LastCount       *int
	LastEvaluatedAt *time.Time
	BaselineAt      *time.Time
	CachedMembers   int
	IncludeArchived bool
}

func readSegmentRow(t *testing.T, pool *pgxpool.Pool, tenantID, segmentID string) segmentRow {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var row segmentRow
	err = tx.QueryRow(ctx, `
SELECT last_count, last_evaluated_at, membership_baseline_at, include_archived
  FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, segmentID).
		Scan(&row.LastCount, &row.LastEvaluatedAt, &row.BaselineAt, &row.IncludeArchived)
	row.Exists = err == nil
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM segment_subscribers WHERE tenant_id = $1::uuid AND segment_id = $2::uuid`,
		tenantID, segmentID).Scan(&row.CachedMembers); err != nil {
		t.Fatalf("count cache: %v", err)
	}
	return row
}

// campaignSegmentID reads a campaign's segment_id (nil when cleared).
func campaignSegmentID(t *testing.T, pool *pgxpool.Pool, tenantID, campaignID string) *string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var segmentID *string
	if err := tx.QueryRow(ctx, `SELECT segment_id::text FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, campaignID).Scan(&segmentID); err != nil {
		t.Fatalf("read campaign %s: %v", campaignID, err)
	}
	return segmentID
}

func enqueueSegmentEvent(t *testing.T, pool *pgxpool.Pool, tenantID, segmentID string) {
	t.Helper()
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		exec(`
INSERT INTO segment_event_queue (tenant_id, segment_id, event_type, occurred_at)
VALUES ($1::uuid, $2::uuid, 'opened', now())`, tenantID, segmentID)
	})
}

// joinRecorder records segment_joined forwards. The worker dispatches on a
// detached goroutine, so callers wait for the count they expect.
type joinRecorder struct {
	mu     sync.Mutex
	events []SegmentJoinEvent
}

func (f *joinRecorder) ForwardSegmentJoined(_ context.Context, ev SegmentJoinEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, ev)
	return nil
}

func (f *joinRecorder) snapshot() []SegmentJoinEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SegmentJoinEvent(nil), f.events...)
}

// settle waits until at least want forwards arrived, then a short grace period
// so a surplus forward has the chance to show up, and returns them all.
func (f *joinRecorder) settle(t *testing.T, want int) []SegmentJoinEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(f.snapshot()) < want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond)
	return f.snapshot()
}

func (f *joinRecorder) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = nil
}
