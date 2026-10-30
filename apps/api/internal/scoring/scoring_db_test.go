// SPDX-License-Identifier: AGPL-3.0-only

package scoring

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newScoringDBPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed scoring tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("create scoring test pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping scoring test database: %v", err)
	}
	return pool
}

func seedScoringTenant(t *testing.T, pool *pgxpool.Pool, label string) string {
	t.Helper()
	tenantID := uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tenant seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	slug := "scoring-" + label + "-" + strings.ReplaceAll(tenantID, "-", "")
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, tenantID, slug, "Scoring test "+label); err != nil {
		t.Fatalf("seed scoring tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit scoring tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		if _, cleanupErr = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr == nil {
			_ = cleanup.Commit(cleanupCtx)
		}
	})
	return tenantID
}

func scoringRequest(t *testing.T, deps *Deps, tenantID, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var encoded bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&encoded).Encode(body); err != nil {
			t.Fatalf("encode scoring request: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &encoded)
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	switch method {
	case http.MethodGet:
		deps.ListRules(rec, req)
	case http.MethodPut:
		deps.PutRules(rec, req)
	default:
		t.Fatalf("unsupported scoring test method %s", method)
	}
	return rec
}

func listScoringRules(t *testing.T, deps *Deps, tenantID string) (string, []Rule, string) {
	t.Helper()
	rec := scoringRequest(t, deps, tenantID, http.MethodGet, "/api/v1/scoring/rules", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list scoring rules status=%d body=%s", rec.Code, rec.Body.String())
	}
	var response struct {
		Rules        []Rule             `json:"rules"`
		Defaults     []Rule             `json:"defaults"`
		EventCatalog []EventCatalogItem `json:"event_catalog"`
		Version      string             `json:"version"`
		WindowDays   int                `json:"window_days"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode scoring rule list: %v", err)
	}
	if !validRuleSetVersion(response.Version) || response.WindowDays != scoringWindowDays || len(response.EventCatalog) != len(EventCatalog) {
		t.Fatalf("invalid scoring rule contract: %+v", response)
	}
	if len(response.Defaults) != len(DefaultRules) {
		t.Fatalf("defaults=%d, want %d", len(response.Defaults), len(DefaultRules))
	}
	if got := rec.Header().Get("ETag"); got != `"`+response.Version+`"` {
		t.Fatalf("ETag=%q, want quoted version %q", got, response.Version)
	}
	return response.Version, response.Rules, rec.Header().Get("ETag")
}

func scoringScores(t *testing.T, pool *pgxpool.Pool, tenantID string, emails ...string) map[string]int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open scoring verification transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT email::text, COALESCE(engagement_score, 0)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid AND email = ANY($2::citext[])`, tenantID, emails)
	if err != nil {
		t.Fatalf("query scoring results: %v", err)
	}
	defer rows.Close()
	out := make(map[string]int, len(emails))
	for rows.Next() {
		var email string
		var score int
		if err := rows.Scan(&email, &score); err != nil {
			t.Fatalf("scan scoring result: %v", err)
		}
		out[email] = score
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate scoring results: %v", err)
	}
	return out
}

func TestRecomputeTenantUsesRealEventsAndDoesNotChurn_DB(t *testing.T) {
	pool := newScoringDBPool(t)
	tenantID := seedScoringTenant(t, pool, "recompute")
	otherTenantID := seedScoringTenant(t, pool, "isolation")
	marker := strings.ReplaceAll(uuid.NewString(), "-", "")
	human := "human-" + marker + "@example.test"
	mpp := "mpp-" + marker + "@example.test"
	stale := "stale-" + marker + "@example.test"
	old := "old-" + marker + "@example.test"
	other := "other-" + marker + "@example.test"

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open recompute seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, engagement_score)
VALUES
  ($1::uuid, $2, 'enabled', 'api', 0),
  ($1::uuid, $3, 'enabled', 'api', 0),
  ($1::uuid, $4, 'enabled', 'api', 9),
  ($1::uuid, $5, 'enabled', 'api', 5)`, tenantID, human, mpp, stale, old); err != nil {
		t.Fatalf("seed recompute subscribers: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO bot_open_signatures (tenant_id, label, pattern, kind, enabled)
VALUES ($1::uuid, 'Scoring audit MPP', 'AuditMPPBot', 'mpp', true)`, tenantID); err != nil {
		t.Fatalf("seed bot-open signature: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, user_agent, at)
VALUES
  ($1::uuid, $2, 'opened', 'Human Mail Client', now() - interval '1 day'),
  ($1::uuid, $2, 'clicked', 'Human Mail Client', now() - interval '1 day'),
  ($1::uuid, $3, 'opened', 'AuditMPPBot/1.0', now() - interval '1 day'),
  ($1::uuid, $4, 'clicked', 'Human Mail Client', now() - interval '91 days')`, tenantID, human, mpp, old); err != nil {
		t.Fatalf("seed recompute events: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit recompute fixture: %v", err)
	}

	otherTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("open isolation seed transaction: %v", err)
	}
	defer func() { _ = otherTx.Rollback(ctx) }()
	if _, err := otherTx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, engagement_score)
VALUES ($1::uuid, $2, 'enabled', 'api', 11)`, otherTenantID, other); err != nil {
		t.Fatalf("seed isolated subscriber: %v", err)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit isolation fixture: %v", err)
	}

	updated, err := RecomputeTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("first recompute: %v", err)
	}
	if updated != 3 {
		t.Fatalf("first recompute changed %d rows, want human + stale + aged-out = 3", updated)
	}
	scores := scoringScores(t, pool, tenantID, human, mpp, stale, old)
	if scores[human] != 6 || scores[mpp] != 0 || scores[stale] != 0 || scores[old] != 0 {
		t.Fatalf("default/MMP/aged-out scoring results = %#v", scores)
	}
	if got := scoringScores(t, pool, otherTenantID, other)[other]; got != 11 {
		t.Fatalf("tenant-isolated score changed to %d, want 11", got)
	}

	updated, err = RecomputeTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("second recompute: %v", err)
	}
	if updated != 0 {
		t.Fatalf("unchanged recompute rewrote %d subscriber rows", updated)
	}
}

func TestRuleVersionCASAndSmallintSaturation_DB(t *testing.T) {
	pool := newScoringDBPool(t)
	tenantID := seedScoringTenant(t, pool, "cas-saturation")
	deps := &Deps{Pool: pool, Logger: slog.Default()}
	version, rules, _ := listScoringRules(t, deps, tenantID)
	if len(rules) != 0 {
		t.Fatalf("new tenant has persisted scoring rules: %+v", rules)
	}
	custom := []Rule{
		{EventType: "clicked", Weight: 1000, Note: "positive saturation"},
		{EventType: "complained", Weight: -1000, Note: "negative saturation"},
	}
	put := scoringRequest(t, deps, tenantID, http.MethodPut, "/api/v1/scoring/rules", PutInput{
		Rules: custom, ExpectedVersion: version,
	})
	if put.Code != http.StatusOK {
		t.Fatalf("version-bound rule save status=%d body=%s", put.Code, put.Body.String())
	}
	var saved struct {
		Saved   int    `json:"saved"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(put.Body.Bytes(), &saved); err != nil {
		t.Fatalf("decode rule save: %v", err)
	}
	if saved.Saved != len(custom) || !validRuleSetVersion(saved.Version) || saved.Version == version {
		t.Fatalf("invalid save receipt: %+v", saved)
	}
	if got := put.Header().Get("ETag"); got != `"`+saved.Version+`"` {
		t.Fatalf("save ETag=%q, want version %q", got, saved.Version)
	}
	stale := scoringRequest(t, deps, tenantID, http.MethodPut, "/api/v1/scoring/rules", PutInput{
		Rules: []Rule{{EventType: "clicked", Weight: 3}}, ExpectedVersion: version,
	})
	if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), "scoring_rules_conflict") {
		t.Fatalf("stale rule save status=%d body=%s", stale.Code, stale.Body.String())
	}
	currentVersion, currentRules, _ := listScoringRules(t, deps, tenantID)
	if currentVersion != saved.Version || len(currentRules) != len(custom) {
		t.Fatalf("stale save mutated rules: version=%q rules=%+v", currentVersion, currentRules)
	}

	marker := strings.ReplaceAll(uuid.NewString(), "-", "")
	high := "high-" + marker + "@example.test"
	low := "low-" + marker + "@example.test"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open saturation seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, engagement_score)
VALUES
  ($1::uuid, $2, 'enabled', 'api', 0),
  ($1::uuid, $3, 'enabled', 'api', 0)`, tenantID, high, low); err != nil {
		t.Fatalf("seed saturation subscribers: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
SELECT $1::uuid, $2, 'clicked', now() - interval '1 day'
  FROM generate_series(1, 40)
UNION ALL
SELECT $1::uuid, $3, 'complained', now() - interval '1 day'
  FROM generate_series(1, 40)`, tenantID, high, low); err != nil {
		t.Fatalf("seed saturation events: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit saturation fixture: %v", err)
	}
	if _, err := RecomputeTenant(ctx, pool, tenantID); err != nil {
		t.Fatalf("saturation recompute: %v", err)
	}
	scores := scoringScores(t, pool, tenantID, high, low)
	if scores[high] != 32767 || scores[low] != -32768 {
		t.Fatalf("smallint saturation results = %#v", scores)
	}
	if updated, err := RecomputeTenant(ctx, pool, tenantID); err != nil || updated != 0 {
		t.Fatalf("unchanged saturation recompute updated=%d err=%v", updated, err)
	}
}

func TestWorkerDiscoversAgedOutNonzeroScoreWithoutRecentEvents_DB(t *testing.T) {
	pool := newScoringDBPool(t)
	tenantID := seedScoringTenant(t, pool, "worker-aged-out")
	idleTenantID := seedScoringTenant(t, pool, "worker-idle")
	email := "aged-out-" + strings.ReplaceAll(uuid.NewString(), "-", "") + "@example.test"
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open worker fixture transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, engagement_score)
VALUES ($1::uuid, $2, 'enabled', 'api', 17)`, tenantID, email); err != nil {
		t.Fatalf("seed aged-out worker subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit aged-out worker fixture: %v", err)
	}

	// The application role has no unscoped subscriber-row visibility. Discovery
	// returns one aggregate column only and excludes an idle tenant.
	var directRows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*)::int FROM subscribers WHERE email = $1`, email,
	).Scan(&directRows); err != nil {
		t.Fatalf("unscoped subscriber boundary query: %v", err)
	}
	if directRows != 0 {
		t.Fatalf("postwave_app read %d unscoped subscriber rows", directRows)
	}
	rows, err := pool.Query(ctx,
		`SELECT tenant_id::text FROM scoring_discovery_tenants($1)`,
		scoringWindowDays)
	if err != nil {
		t.Fatalf("call scoring discovery function: %v", err)
	}
	if len(rows.FieldDescriptions()) != 1 || rows.FieldDescriptions()[0].Name != "tenant_id" {
		rows.Close()
		t.Fatalf("scoring discovery exposed fields other than tenant_id: %+v", rows.FieldDescriptions())
	}
	candidates := map[string]bool{}
	for rows.Next() {
		var candidate string
		if err := rows.Scan(&candidate); err != nil {
			rows.Close()
			t.Fatalf("scan scoring discovery candidate: %v", err)
		}
		candidates[candidate] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate scoring discovery candidates: %v", err)
	}
	rows.Close()
	if !candidates[tenantID] || candidates[idleTenantID] {
		t.Fatalf("discovery candidates stale=%t idle=%t", candidates[tenantID], candidates[idleTenantID])
	}
	if _, err := pool.Exec(ctx, `SELECT * FROM scoring_discovery_tenants(0)`); err == nil {
		t.Fatal("scoring discovery accepted an invalid window")
	}

	worker := &Worker{Pool: pool}
	if err := worker.tick(ctx); err != nil {
		t.Fatalf("worker tick: %v", err)
	}
	if got := scoringScores(t, pool, tenantID, email)[email]; got != 0 {
		t.Fatalf("worker left eventless stale score at %d, want 0", got)
	}
}

func TestPutRulesSerializesConcurrentSameVersion_DB(t *testing.T) {
	pool := newScoringDBPool(t)
	tenantID := seedScoringTenant(t, pool, "concurrent-cas")
	deps := &Deps{Pool: pool, Logger: slog.Default()}
	version, _, _ := listScoringRules(t, deps, tenantID)

	start := make(chan struct{})
	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for _, rule := range []Rule{
		{EventType: "clicked", Weight: 4, Note: "writer one"},
		{EventType: "replied", Weight: 9, Note: "writer two"},
	} {
		rule := rule
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec := scoringRequest(t, deps, tenantID, http.MethodPut, "/api/v1/scoring/rules", PutInput{
				Rules: []Rule{rule}, ExpectedVersion: version,
			})
			statuses <- rec.Code
		}()
	}
	close(start)
	wg.Wait()
	close(statuses)
	got := make([]int, 0, 2)
	for status := range statuses {
		got = append(got, status)
	}
	sort.Ints(got)
	want := []int{http.StatusOK, http.StatusConflict}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("concurrent same-version statuses=%v, want one success and one conflict", got)
	}
	_, current, _ := listScoringRules(t, deps, tenantID)
	if len(current) != 1 || (current[0].EventType != "clicked" && current[0].EventType != "replied") {
		t.Fatalf("concurrent rule set is not one complete winner: %+v", current)
	}
	if current[0].Note != "writer one" && current[0].Note != "writer two" {
		t.Fatalf("concurrent winner was partially written: %+v", current[0])
	}
}
