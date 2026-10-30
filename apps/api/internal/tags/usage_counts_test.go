// SPDX-License-Identifier: AGPL-3.0-only
//
// MAP#58 — per-tag subscriber counts.
//
// The registry list was readable but scale-blind: a client could not tell a
// 40k-subscriber tag from one nobody carries. ListFilteredWithCounts adds an
// opt-in subscriber_count sourced from the canonical subscriber_tags join.
//
// The handler guard test runs anywhere. The round-trip + RLS test needs a
// real migrated Postgres and skips without DATABASE_URL, following
// TestRepoList_QFilter in tags_test.go.
package tags

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestList_RejectsMalformedWithCounts pins the parse guard. A bad value must
// produce the typed 400 envelope, not a silent false and not a 500 — the
// exact failure mode the audit kept finding. Repo.Pool is nil, so if the
// guard ever regresses to run past this point the nil-pointer panic in
// db.WithTenant fails the test loudly.
func TestList_RejectsMalformedWithCounts(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/tags?with_counts=yes-please", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()

	d.List(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", w.Code, w.Body.String())
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode error envelope: %v (body %s)", err, w.Body.String())
	}
	if env.Error.Code != "invalid_with_counts" {
		t.Fatalf("error.code = %q, want invalid_with_counts (body %s)", env.Error.Code, w.Body.String())
	}
}

// TestRepoListWithCounts_RoundTripAndTenantIsolation is the real thing: two
// tenants each own a tag with the same name; tenant A applies it to two
// subscribers, tenant B to none. The count must be 2 for A and 0 for B —
// i.e. the aggregate must not bleed across the tenant boundary — and the
// no-counts path must leave SubscriberCount nil rather than reporting 0.
func TestRepoListWithCounts_RoundTripAndTenantIsolation(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantA := seedTagsTenant(t, ctx, pool)
	tenantB := seedTagsTenant(t, ctx, pool)
	prefix := "uc_" + randHex(t, 4) + "_"
	repo := &Repo{Pool: pool}
	subTags := &SubscriberTagsRepo{Pool: pool}
	t.Cleanup(func() {
		cleanupTags(pool, tenantA, prefix)
		cleanupTags(pool, tenantB, prefix)
	})

	hot, err := repo.Create(ctx, tenantA, CreateInput{Name: prefix + "hot"})
	if err != nil {
		t.Fatalf("create hot tag: %v", err)
	}
	cold, err := repo.Create(ctx, tenantA, CreateInput{Name: prefix + "cold"})
	if err != nil {
		t.Fatalf("create cold tag: %v", err)
	}
	// Same label under tenant B. Its count must stay 0 even though tenant A
	// has two applications of an identically named tag.
	if _, err := repo.Create(ctx, tenantB, CreateInput{Name: prefix + "hot"}); err != nil {
		t.Fatalf("create tenant-B hot tag: %v", err)
	}

	for _, email := range []string{"a1@example.test", "a2@example.test"} {
		sub := seedUsageSubscriber(t, ctx, pool, tenantA, email)
		if err := subTags.Apply(ctx, tenantA, sub, hot.ID, "", "manual"); err != nil {
			t.Fatalf("apply hot to %s: %v", email, err)
		}
	}

	counted := listByPrefix(t, ctx, repo, tenantA, prefix, true)
	if len(counted) != 2 {
		t.Fatalf("tenant A tags = %d, want 2", len(counted))
	}
	if got := counted[prefix+"hot"]; got == nil || *got != 2 {
		t.Fatalf("hot subscriber_count = %v, want 2", derefCount(got))
	}
	if got := counted[prefix+"cold"]; got == nil || *got != 0 {
		t.Fatalf("cold subscriber_count = %v, want 0 (a tag nobody carries must report zero, not null)", derefCount(got))
	}
	_ = cold

	// Tenant B's identically named tag must report zero.
	bCounted := listByPrefix(t, ctx, repo, tenantB, prefix, true)
	if got := bCounted[prefix+"hot"]; got == nil || *got != 0 {
		t.Fatalf("tenant B hot subscriber_count = %v, want 0 — the aggregate leaked across tenants", derefCount(got))
	}

	// Default path stays untouched: no count requested, no count reported.
	plain := listByPrefix(t, ctx, repo, tenantA, prefix, false)
	if got := plain[prefix+"hot"]; got != nil {
		t.Fatalf("subscriber_count = %d without with_counts, want nil (field must stay omitted)", *got)
	}
}

func derefCount(p *int64) any {
	if p == nil {
		return "nil"
	}
	return *p
}

// listByPrefix returns name -> SubscriberCount for the tenant's tags whose
// name matches the test prefix.
func listByPrefix(t *testing.T, ctx context.Context, repo *Repo, tenantID, prefix string, withCounts bool) map[string]*int64 {
	t.Helper()
	rows, err := repo.ListFilteredWithCounts(ctx, tenantID, prefix, "", false, withCounts)
	if err != nil {
		t.Fatalf("ListFilteredWithCounts(withCounts=%v): %v", withCounts, err)
	}
	out := make(map[string]*int64, len(rows))
	for _, row := range rows {
		out[row.Name] = row.SubscriberCount
	}
	return out
}

// seedUsageSubscriber inserts one subscriber under the tenant and returns its
// id. Runs through db.WithTenant so RLS applies exactly as it does in
// production — the count assertions above are meaningless if the seed bypasses
// the policy the query relies on.
func seedUsageSubscriber(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, email string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber %s: %v", email, err)
	}
	return id
}
