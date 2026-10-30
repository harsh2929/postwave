// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the engagement-score read surface. Two tiers:
//
//   * pure helpers + handler validation — no database, always run;
//   * DB-backed read paths — skip without DATABASE_URL (the
//     established pg-backed test pattern), fixtures under a
//     throwaway tenant that cleanup deletes (subscribers cascade
//     on tenant_id).

package subscriberscore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---------- pure helpers ----------

func TestScoreRangeLabel(t *testing.T) {
	for _, tc := range []struct {
		lo, hi int
		want   string
	}{
		{0, 0, "0..0"},
		{12, 40, "12..40"},
		{100, 100, "100..100"},
	} {
		if got := scoreRangeLabel(tc.lo, tc.hi); got != tc.want {
			t.Errorf("scoreRangeLabel(%d, %d) = %q, want %q", tc.lo, tc.hi, got, tc.want)
		}
	}
}

func TestClampPerPage(t *testing.T) {
	for _, tc := range []struct{ in, want int }{
		{-5, defaultScorePageSize},
		{0, defaultScorePageSize},
		{1, 1},
		{defaultScorePageSize, defaultScorePageSize},
		{maxScorePageSize, maxScorePageSize},
		{maxScorePageSize + 1, maxScorePageSize},
		{10_000, maxScorePageSize},
	} {
		if got := clampPerPage(tc.in); got != tc.want {
			t.Errorf("clampPerPage(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestClampPage(t *testing.T) {
	for _, tc := range []struct{ in, want int }{
		{-1, 1}, {0, 1}, {1, 1}, {7, 7},
	} {
		if got := clampPage(tc.in); got != tc.want {
			t.Errorf("clampPage(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestOptionalInt(t *testing.T) {
	if v, err := optionalInt(""); err != nil || v != nil {
		t.Errorf("optionalInt(\"\") = %v, %v; want nil, nil", v, err)
	}
	if v, err := optionalInt("  "); err != nil || v != nil {
		t.Errorf("optionalInt(blank) = %v, %v; want nil, nil", v, err)
	}
	if v, err := optionalInt(" 42 "); err != nil || v == nil || *v != 42 {
		t.Errorf("optionalInt(\" 42 \") = %v, %v; want 42, nil", v, err)
	}
	if v, err := optionalInt("-7"); err != nil || v == nil || *v != -7 {
		t.Errorf("optionalInt(\"-7\") = %v, %v; want -7, nil", v, err)
	}
	if _, err := optionalInt("abc"); err == nil {
		t.Error("optionalInt(\"abc\") error = nil, want parse error")
	}
	if _, err := optionalInt("1.5"); err == nil {
		t.Error("optionalInt(\"1.5\") error = nil, want parse error")
	}
}

// ---------- handler validation (no DB) ----------

func withTenant(r *http.Request, id string) *http.Request {
	return r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: id}))
}

func TestHandlers_RequireTenant(t *testing.T) {
	d := &HTTPDeps{}
	for name, fn := range map[string]http.HandlerFunc{
		"GetEngagementScore": d.GetEngagementScore,
		"Distribution":       d.Distribution,
		"ListByScore":        d.ListByScore,
	} {
		r := httptest.NewRequest(http.MethodGet, "/x", nil)
		w := httptest.NewRecorder()
		fn(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s without tenant: status = %d, want 401", name, w.Code)
		}
	}
}

func TestListByScore_Validation(t *testing.T) {
	d := &HTTPDeps{}
	for name, tc := range map[string]struct {
		query    string
		wantCode string
	}{
		"non-integer min":  {"min=abc", "bad_min"},
		"non-integer max":  {"max=1.5", "bad_max"},
		"min above max":    {"min=80&max=20", "bad_range"},
		"non-integer page": {"page=x", "bad_page"},
		"non-integer pp":   {"per_page=x", "bad_per_page"},
	} {
		r := withTenant(httptest.NewRequest(http.MethodGet,
			"/api/v1/engagement-scores/subscribers?"+tc.query, nil), "t1")
		w := httptest.NewRecorder()
		d.ListByScore(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400; body=%s", name, w.Code, w.Body.String())
			continue
		}
		if !strings.Contains(w.Body.String(), tc.wantCode) {
			t.Errorf("%s: body = %s, want code %q", name, w.Body.String(), tc.wantCode)
		}
	}
}

// TestMountRoutes proves the three routes register (an unregistered
// path 404s; a registered one reaches the handler's tenant check and
// 401s) and that a nil-deps mount is a safe no-op.
func TestMountRoutes(t *testing.T) {
	r := chi.NewRouter()
	MountRoutes(r, &HTTPDeps{Pool: new(db.Pool)})
	for _, path := range []string{
		"/api/v1/subscribers/abc/engagement-score",
		"/api/v1/engagement-scores/distribution",
		"/api/v1/engagement-scores/subscribers",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401 (route registered, tenant missing)", path, w.Code)
		}
	}

	empty := chi.NewRouter()
	MountRoutes(empty, nil)         // must not panic
	MountRoutes(empty, &HTTPDeps{}) // nil pool — must not register
	req := httptest.NewRequest(http.MethodGet, "/api/v1/engagement-scores/distribution", nil)
	w := httptest.NewRecorder()
	empty.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("nil-deps mount registered routes: status = %d, want 404", w.Code)
	}
}

// ---------- DB-backed (skip without DATABASE_URL) ----------

func scoreTestDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed subscriberscore tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func randUUIDScore(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// createScoreTenant inserts a throwaway tenant; cleanup deletes it
// (subscribers cascade on tenant_id).
func createScoreTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
	t.Helper()
	tenantID := randUUIDScore(t)
	slug := "subscore-" + tenantID[:8]
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx2, err := db.WithTenant(ctx2, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx2.Rollback(ctx2) }()
		_, _ = tx2.Exec(ctx2, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx2.Commit(ctx2)
	})
	return tenantID
}

// seedScoredSubscriber inserts one subscriber; score nil leaves
// engagement_score NULL (never visited by the worker).
func seedScoredSubscriber(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, email string, score *int) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, engagement_score, engagement_score_at)
VALUES ($1::uuid, $2, 'enabled', 'api', $3::int,
        CASE WHEN $3::int IS NULL THEN NULL ELSE now() END)
RETURNING id::text`, tenantID, email, score).Scan(&id); err != nil {
		t.Fatalf("insert subscriber %q: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
	return id
}

func intp(n int) *int { return &n }

func TestFetchScoreDB(t *testing.T) {
	pool := scoreTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createScoreTenant(t, pool, ctx)

	email := "scored-" + tenantID[:8] + "@example.com"
	id := seedScoredSubscriber(t, pool, ctx, tenantID, email, intp(73))
	unscoredEmail := "unscored-" + tenantID[:8] + "@example.com"
	seedScoredSubscriber(t, pool, ctx, tenantID, unscoredEmail, nil)

	// By UUID.
	got, err := FetchScore(ctx, pool, tenantID, id)
	if err != nil {
		t.Fatalf("FetchScore(by id): %v", err)
	}
	if got.Score == nil || *got.Score != 73 {
		t.Errorf("score = %v, want 73", got.Score)
	}
	if got.ComputedAt == nil {
		t.Error("computed_at = nil, want timestamp")
	}

	// By email, case-insensitive.
	got, err = FetchScore(ctx, pool, tenantID, strings.ToUpper(email))
	if err != nil {
		t.Fatalf("FetchScore(by email): %v", err)
	}
	if got.Score == nil || *got.Score != 73 {
		t.Errorf("score by email = %v, want 73", got.Score)
	}

	// Unscored subscriber: present, NULL score, no computed_at.
	got, err = FetchScore(ctx, pool, tenantID, unscoredEmail)
	if err != nil {
		t.Fatalf("FetchScore(unscored): %v", err)
	}
	if got.Score != nil || got.ComputedAt != nil {
		t.Errorf("unscored = {%v %v}, want both nil", got.Score, got.ComputedAt)
	}

	// Unknown subscriber: typed sentinel.
	if _, err := FetchScore(ctx, pool, tenantID, "missing@example.com"); !errors.Is(err, errSubscriberNotFound) {
		t.Errorf("FetchScore(missing) err = %v, want errSubscriberNotFound", err)
	}
}

func TestScoreDistributionAndListDB(t *testing.T) {
	pool := scoreTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createScoreTenant(t, pool, ctx)

	// 12 scored subscribers 5,10,...,60 plus one unscored (excluded).
	scores := make([]int, 0, 12)
	for i := 1; i <= 12; i++ {
		s := i * 5
		scores = append(scores, s)
		seedScoredSubscriber(t, pool, ctx, tenantID,
			"d-"+tenantID[:8]+"-"+hex.EncodeToString([]byte{byte(i)})+"@example.com", intp(s))
	}
	seedScoredSubscriber(t, pool, ctx, tenantID, "null-"+tenantID[:8]+"@example.com", nil)

	buckets, err := ScoreDistribution(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("ScoreDistribution: %v", err)
	}
	if len(buckets) != 10 {
		t.Fatalf("buckets = %d, want 10 (NTILE over 12 rows)", len(buckets))
	}
	total := 0
	for i, b := range buckets {
		total += b.Count
		if b.Min > b.Max {
			t.Errorf("bucket %d: min %d > max %d", i, b.Min, b.Max)
		}
		if b.Range != scoreRangeLabel(b.Min, b.Max) {
			t.Errorf("bucket %d: range %q != label(%d,%d)", i, b.Range, b.Min, b.Max)
		}
		if i > 0 && b.Min < buckets[i-1].Max {
			t.Errorf("bucket %d: min %d < previous max %d (deciles must ascend)", i, b.Min, buckets[i-1].Max)
		}
	}
	if total != len(scores) {
		t.Errorf("sum(count) = %d, want %d (unscored excluded)", total, len(scores))
	}

	// Banded list: [20, 40] → scores 20,25,30,35,40 DESC.
	items, listTotal, err := SubscribersByScore(ctx, pool, tenantID, intp(20), intp(40), 1, 50)
	if err != nil {
		t.Fatalf("SubscribersByScore: %v", err)
	}
	if listTotal != 5 || len(items) != 5 {
		t.Fatalf("total = %d, len = %d, want 5, 5", listTotal, len(items))
	}
	for i, it := range items {
		if it.Score < 20 || it.Score > 40 {
			t.Errorf("item %d: score %d outside [20,40]", i, it.Score)
		}
		if i > 0 && it.Score > items[i-1].Score {
			t.Errorf("item %d: score %d > previous %d (want DESC)", i, it.Score, items[i-1].Score)
		}
		if it.ID == "" || it.Email == "" {
			t.Errorf("item %d: empty id/email", i)
		}
	}

	// Paging: page 2 of per_page 2 over the same band → 2 rows, the
	// 3rd and 4th by score DESC (30, 25).
	page2, pTotal, err := SubscribersByScore(ctx, pool, tenantID, intp(20), intp(40), 2, 2)
	if err != nil {
		t.Fatalf("SubscribersByScore(page 2): %v", err)
	}
	if pTotal != 5 || len(page2) != 2 {
		t.Fatalf("page 2: total = %d, len = %d, want 5, 2", pTotal, len(page2))
	}
	if page2[0].Score != 30 || page2[1].Score != 25 {
		t.Errorf("page 2 scores = %d, %d, want 30, 25", page2[0].Score, page2[1].Score)
	}

	// Unbounded: everything scored.
	_, allTotal, err := SubscribersByScore(ctx, pool, tenantID, nil, nil, 1, 200)
	if err != nil {
		t.Fatalf("SubscribersByScore(unbounded): %v", err)
	}
	if allTotal != len(scores) {
		t.Errorf("unbounded total = %d, want %d", allTotal, len(scores))
	}
}

// TestListByScoreEnvelopeDB exercises the full handler so the spec'd
// {items, total, page, per_page} envelope is pinned.
func TestListByScoreEnvelopeDB(t *testing.T) {
	pool := scoreTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createScoreTenant(t, pool, ctx)
	seedScoredSubscriber(t, pool, ctx, tenantID, "env-"+tenantID[:8]+"@example.com", intp(55))

	d := &HTTPDeps{Pool: pool}
	r := httptest.NewRequest(http.MethodGet,
		"/api/v1/engagement-scores/subscribers?min=50&max=60", nil)
	r = r.WithContext(middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}))
	w := httptest.NewRecorder()
	d.ListByScore(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var env struct {
		Items   []ScoredSubscriber `json:"items"`
		Total   int                `json:"total"`
		Page    int                `json:"page"`
		PerPage int                `json:"per_page"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal: %v; body = %s", err, w.Body.String())
	}
	if env.Total != 1 || len(env.Items) != 1 || env.Items[0].Score != 55 {
		t.Errorf("envelope = %+v, want 1 item with score 55", env)
	}
	if env.Page != 1 || env.PerPage != defaultScorePageSize {
		t.Errorf("page/per_page = %d/%d, want 1/%d", env.Page, env.PerPage, defaultScorePageSize)
	}
}
