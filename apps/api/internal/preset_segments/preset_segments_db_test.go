// SPDX-License-Identifier: AGPL-3.0-only

package preset_segments

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// On staging the "New (joined in last 7 days)" recipe showed three members,
// all archived, and none of the contacts added that day, while saved segments
// said "Active subscribers only · excludes archived". The recipes ignored
// archived_at and required status = 'enabled', which a contact added through
// the dialog, paste or import (unconfirmed until it confirms) never has.
//
// This drives both preset endpoints through the mounted routes as the
// RLS-bound application role and checks the recipes against the saved-segment
// population itself: the count and the members of "New (7 days)" must equal
// what segments.CompilePopulation returns for the builder's "joined in the
// last 7 days" rule under DefinitionPopulation(false).
func TestPresetRecipesUseTheSavedSegmentAudience(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping the preset recipe audience test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect as the RLS-bound application role: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'preset-recipes-test', 'preset-recipes-' || $1::text, 'studio')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	type seed struct {
		email     string
		status    string
		consent   string
		createdAt time.Time
		archived  bool
	}
	now := time.Now().UTC()
	token := uuid.NewString()[:8]
	addr := func(name string) string { return name + "-" + token + "@example.test" }
	seeds := []seed{
		// Added today through the dialog / paste / import: unconfirmed.
		{addr("today-unconfirmed"), "unconfirmed", "unknown", now.Add(-time.Hour), false},
		{addr("today-subscribed"), "enabled", "api", now.Add(-2 * time.Hour), false},
		// Joined 10 days ago: in the 30-day recipe only.
		{addr("ten-days"), "enabled", "api", now.Add(-10 * 24 * time.Hour), false},
		// Archived this week. Each matches the rule of every recipe that has
		// no engagement condition (new_7d, new_30d, cold_90d, never_opened,
		// double_optin_verified) and must count in none of them.
		{addr("archived-subscribed"), "enabled", "double_optin", now.Add(-3 * time.Hour), true},
		{addr("archived-unconfirmed"), "unconfirmed", "unknown", now.Add(-4 * time.Hour), true},
	}
	for _, s := range seeds {
		var archivedAt any
		if s.archived {
			archivedAt = now
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, created_at, archived_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6)`, tenantID, s.email, s.status, s.consent, s.createdAt, archivedAt); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed %s: %v", s.email, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer ccancel()
		if tx, err := db.WithTenant(cctx, pool, tenantID); err == nil {
			_, _ = tx.Exec(cctx, `DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID)
			_, _ = tx.Exec(cctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = tx.Commit(cctx)
		}
	})

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID})
			rctx = middleware.WithAPIKeyAuth(rctx)
			rctx = apikeys.WithScopes(rctx, []apikeys.Scope{apikeys.ScopeReadReports})
			next.ServeHTTP(w, r.WithContext(rctx))
		})
	})
	MountRoutes(router, &Deps{Pool: pool, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	get := func(target string, out any) {
		t.Helper()
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d: %s", target, rec.Code, rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("decode %s: %v (%s)", target, err, rec.Body.String())
		}
	}

	var listed struct {
		Presets []Preset `json:"presets"`
	}
	get("/api/v1/preset-segments", &listed)
	counts := map[string]int64{}
	for _, p := range listed.Presets {
		counts[p.Key] = p.Count
	}
	members := func(key string) []string {
		t.Helper()
		var page struct {
			Subscribers []struct {
				Email string `json:"email"`
			} `json:"subscribers"`
		}
		get("/api/v1/preset-segments/"+key+"/list?limit=1000", &page)
		out := make([]string, 0, len(page.Subscribers))
		for _, s := range page.Subscribers {
			out = append(out, s.Email)
		}
		slices.Sort(out)
		return out
	}
	sorted := func(in ...string) []string {
		out := slices.Clone(in)
		slices.Sort(out)
		return out
	}

	want7 := sorted(addr("today-unconfirmed"), addr("today-subscribed"))
	if got := members("new_7d"); !slices.Equal(got, want7) || counts["new_7d"] != int64(len(want7)) {
		t.Fatalf("New (7 days) = %v (card count %d); want the contacts added this week %v",
			got, counts["new_7d"], want7)
	}
	want30 := sorted(addr("today-unconfirmed"), addr("today-subscribed"), addr("ten-days"))
	if got := members("new_30d"); !slices.Equal(got, want30) || counts["new_30d"] != int64(len(want30)) {
		t.Fatalf("New (30 days) = %v (card count %d); want %v", got, counts["new_30d"], want30)
	}

	// No recipe lists or counts an archived contact.
	archived := []string{addr("archived-subscribed"), addr("archived-unconfirmed")}
	for _, p := range listed.Presets {
		got := members(p.Key)
		for _, email := range archived {
			if slices.Contains(got, email) {
				t.Fatalf("recipe %s lists the archived contact %s: %v", p.Key, email, got)
			}
		}
		if p.Count != int64(len(got)) {
			t.Fatalf("recipe %s card count %d disagrees with its %d listed members %v", p.Key, p.Count, len(got), got)
		}
	}

	// The same audience a saved segment built from the recipe would have.
	for _, tc := range []struct {
		key string
		ast string
	}{
		{"new_7d", `{"op":"condition","field":"created_at","comparator":"gte","value":"now-7d"}`},
		{"new_30d", `{"op":"condition","field":"created_at","comparator":"gte","value":"now-30d"}`},
	} {
		predicate, err := segments.CompilePopulation(ctx, json.RawMessage(tc.ast), tenantID,
			segments.SegmentResolverFunc(func(context.Context, string, string) (json.RawMessage, error) {
				return nil, segments.ErrNotFound
			}), segments.DefinitionPopulation(false))
		if err != nil {
			t.Fatalf("compile %s: %v", tc.key, err)
		}
		rtx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("tenant tx: %v", err)
		}
		args := append([]any{tenantID}, predicate.Args...)
		sql := `SELECT email::text FROM subscribers WHERE tenant_id = $1::uuid AND (` +
			renumber(predicate.SQL, 1) + `)`
		rows, err := rtx.Query(ctx, sql, args...)
		if err != nil {
			_ = rtx.Rollback(ctx)
			t.Fatalf("saved-segment population %s: %v", tc.key, err)
		}
		var segment []string
		for rows.Next() {
			var email string
			if err := rows.Scan(&email); err != nil {
				t.Fatalf("scan: %v", err)
			}
			segment = append(segment, email)
		}
		rows.Close()
		_ = rtx.Rollback(ctx)
		slices.Sort(segment)
		if got := members(tc.key); !slices.Equal(got, segment) {
			t.Fatalf("recipe %s members %v differ from the saved-segment audience %v", tc.key, got, segment)
		}
	}
}

// renumber shifts $N placeholders in a compiled fragment by offset so the
// fragment can follow the tenant id bound as $1.
func renumber(sql string, offset int) string {
	var b strings.Builder
	for i := 0; i < len(sql); i++ {
		if sql[i] != '$' {
			b.WriteByte(sql[i])
			continue
		}
		j := i + 1
		n := 0
		for j < len(sql) && sql[j] >= '0' && sql[j] <= '9' {
			n = n*10 + int(sql[j]-'0')
			j++
		}
		if j == i+1 {
			b.WriteByte('$')
			continue
		}
		b.WriteString("$")
		b.WriteString(strconv.Itoa(n + offset))
		i = j - 1
	}
	return b.String()
}
