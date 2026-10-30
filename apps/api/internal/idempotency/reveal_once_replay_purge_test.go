// SPDX-License-Identifier: AGPL-3.0-only

package idempotency

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestRevealOnceReplayPurgeMigrationIsExact(t *testing.T) {
	t.Parallel()
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"2031_purge_reveal_once_ingest_secret_replays.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 2031: %v", err)
	}
	source := string(raw)
	for _, required := range []string{
		"migration-execution: atomic",
		"SET LOCAL row_security = off",
		"DELETE FROM public.idempotency_records",
		"WHERE route = '" + revealOnceIngestSecretIssueRoute + "'",
		"legacy reveal-once ingest-secret replay rows remain",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("migration 2031 omits %q", required)
		}
	}
	if strings.Count(source, "DELETE FROM public.idempotency_records") != 1 ||
		strings.Count(source, revealOnceIngestSecretIssueRoute) != 2 ||
		strings.Count(source, "BEGIN;") != 1 ||
		strings.Count(source, "COMMIT;") != 1 {
		t.Fatalf("migration 2031 is no longer a single exact, verified purge")
	}
	for _, forbidden := range []string{
		"TRUNCATE", "DELETE FROM public.conversion", "route LIKE", "route ILIKE",
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("migration 2031 broadened cleanup via %q", forbidden)
		}
	}
}

func TestRevealOnceInspectorAndReplayHaveDefenseInDepth(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("inspector.go")
	if err != nil {
		t.Fatalf("read inspector implementation: %v", err)
	}
	source := string(raw)
	// Detail and replay each fetch one record before applying the route-level
	// withholding rule. List plus all five stats projections exclude the route in
	// SQL so neither secrets nor even their keys/counts become operator output.
	if got := strings.Count(source, "if !inspectorRouteVisible(rec.Route)"); got != 2 {
		t.Fatalf("detail/replay reveal-once guards=%d, want 2", got)
	}
	if got := strings.Count(source, "AND route <> $2"); got != 6 {
		t.Fatalf("list/stats reveal-once SQL guards=%d, want 6", got)
	}
	if !strings.Contains(source,
		`revealOnceIngestSecretIssueRoute = "POST /api/v1/conversions/ingest-secrets"`) {
		t.Fatal("inspector route exclusion drifted from the canonical stored route")
	}
}

func TestRevealOnceReplayPurgeAcrossTenantsPreservesSiblings_DB(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL is required for fleet-wide purge/RLS proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err = tx.Exec(ctx, `SET LOCAL row_security = off`); err != nil {
		t.Fatalf("require fleet-wide migration authority: %v", err)
	}

	tenantA, tenantB := uuid.NewString(), uuid.NewString()
	if _, err = tx.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier) VALUES
 ($1::uuid,'reveal-purge-a',$2,'studio'),
 ($3::uuid,'reveal-purge-b',$4,'studio')`,
		tenantA, "reveal-purge-a-"+strings.ReplaceAll(tenantA, "-", ""),
		tenantB, "reveal-purge-b-"+strings.ReplaceAll(tenantB, "-", "")); err != nil {
		t.Fatalf("seed purge tenants: %v", err)
	}
	const secretA = "reveal-once-secret-tenant-a"
	const secretB = "reveal-once-secret-tenant-b"
	if _, err = tx.Exec(ctx, `
INSERT INTO idempotency_records
       (key,tenant_id,route,request_hash,response_status,response_body,response_headers,expires_at)
VALUES ('issue-a-pending',$1::uuid,$3,'hash-a',NULL,NULL,NULL,now()+interval '24 hours'),
       ('issue-a-2xx',$1::uuid,$3,'hash-b',201,$4::bytea,'{}'::jsonb,now()+interval '24 hours'),
       ('issue-a-4xx',$1::uuid,$3,'hash-c',400,$4::bytea,'{}'::jsonb,now()+interval '24 hours'),
       ('issue-a-5xx',$1::uuid,$3,'hash-d',500,$4::bytea,'{}'::jsonb,now()+interval '24 hours'),
       ('issue-a-expired',$1::uuid,$3,'hash-e',201,$4::bytea,'{}'::jsonb,now()-interval '1 hour'),
       ('issue-b-2xx',$2::uuid,$3,'hash-f',201,$5::bytea,'{}'::jsonb,now()+interval '24 hours'),
       ('issue-b-pending',$2::uuid,$3,'hash-g',NULL,NULL,NULL,now()-interval '1 hour'),
       ('list-a',$1::uuid,'GET /api/v1/conversions/ingest-secrets','hash-h',200,'{"items":[]}'::bytea,'{}'::jsonb,now()+interval '24 hours'),
       ('slash-a',$1::uuid,'POST /api/v1/conversions/ingest-secrets/','hash-i',404,'{"error":"not_found"}'::bytea,'{}'::jsonb,now()+interval '24 hours'),
       ('revoke-a',$1::uuid,'POST /api/v1/conversions/ingest-secrets/key/revoke','hash-j',200,'{"revoked":true}'::bytea,'{}'::jsonb,now()+interval '24 hours'),
       ('other-b',$2::uuid,'POST /api/v1/campaigns','hash-k',201,'{"id":"campaign"}'::bytea,'{}'::jsonb,now()+interval '24 hours')`,
		tenantA, tenantB, revealOnceIngestSecretIssueRoute,
		`{"secret":{"secret":"`+secretA+`"}}`,
		`{"secret":{"secret":"`+secretB+`"}}`); err != nil {
		t.Fatalf("seed legacy replay fixtures: %v", err)
	}

	if _, err = tx.Exec(ctx, `
DELETE FROM public.idempotency_records
 WHERE route = 'POST /api/v1/conversions/ingest-secrets'`); err != nil {
		t.Fatalf("execute exact migration purge: %v", err)
	}
	var legacyRows, siblingRows, leakedBodies int
	if err = tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE route=$1),
       count(*) FILTER (WHERE route<>$1),
       count(*) FILTER (
         WHERE position('reveal-once-secret-'::bytea in COALESCE(response_body,''::bytea)) > 0
       )
  FROM idempotency_records
 WHERE tenant_id IN ($2::uuid,$3::uuid)`,
		revealOnceIngestSecretIssueRoute, tenantA, tenantB).
		Scan(&legacyRows, &siblingRows, &leakedBodies); err != nil {
		t.Fatalf("inspect admin purge result: %v", err)
	}
	if legacyRows != 0 || siblingRows != 4 || leakedBodies != 0 {
		t.Fatalf("purge result legacy=%d siblings=%d leaked_bodies=%d, want 0/4/0",
			legacyRows, siblingRows, leakedBodies)
	}

	// Prove the same view available to the restricted inspector role: tenant A
	// retains its unrelated revoke receipt, cannot see tenant B, and has no
	// reveal-once route/body left to preview or replay.
	if _, err = tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatalf("enter restricted application role: %v", err)
	}
	if _, err = tx.Exec(ctx, `SET LOCAL row_security = on`); err != nil {
		t.Fatalf("restore restricted RLS enforcement: %v", err)
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenantA); err != nil {
		t.Fatalf("set restricted tenant: %v", err)
	}
	var visible, issueVisible, crossTenantVisible int
	if err = tx.QueryRow(ctx, `
SELECT count(*),
       count(*) FILTER (WHERE route=$2),
       count(*) FILTER (WHERE tenant_id=$3::uuid)
  FROM idempotency_records
 WHERE tenant_id IN ($1::uuid,$3::uuid)`,
		tenantA, revealOnceIngestSecretIssueRoute, tenantB).
		Scan(&visible, &issueVisible, &crossTenantVisible); err != nil {
		t.Fatalf("restricted inspector-equivalent query: %v", err)
	}
	var visibleBody []byte
	if err = tx.QueryRow(ctx, `
SELECT response_body
  FROM idempotency_records
 WHERE tenant_id=$1::uuid AND key='revoke-a'`, tenantA).Scan(&visibleBody); err != nil {
		t.Fatalf("read preserved restricted sibling: %v", err)
	}
	if visible != 3 || issueVisible != 0 || crossTenantVisible != 0 ||
		!strings.Contains(string(visibleBody), "revoked") {
		t.Fatalf("restricted visibility total=%d issue=%d cross_tenant=%d body=%q",
			visible, issueVisible, crossTenantVisible, visibleBody)
	}
}

func TestRevealOnceInspectorHandlersWithholdARegressedSecretRow_DB(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and DATABASE_URL are required for restricted inspector proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	tenantID := uuid.NewString()
	key := "regressed-reveal-once-" + uuid.NewString()
	secret := "sk_regressed_reveal_once_" + uuid.NewString()
	slug := "reveal-inspector-" + strings.ReplaceAll(tenantID, "-", "")
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier)
VALUES ($1::uuid,'reveal inspector regression',$2,'studio')`, tenantID, slug); err != nil {
		t.Fatalf("seed reveal-once inspector tenant: %v", err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO idempotency_records
       (key,tenant_id,route,request_hash,response_status,response_body,response_headers,expires_at)
VALUES ($2,$1::uuid,$3,'regressed-secret-hash',201,$4::bytea,
        '{"Content-Type":["application/json"]}'::jsonb,now()+interval '24 hours')`,
		tenantID, key, revealOnceIngestSecretIssueRoute,
		[]byte(`{"secret":"`+secret+`"}`)); err != nil {
		t.Fatalf("seed regressed reveal-once row: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
	})

	pool, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect restricted app pool: %v", err)
	}
	t.Cleanup(pool.Close)
	deps := &InspectorDeps{Pool: pool}
	request := func(path string, withKey bool) *http.Request {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		requestCtx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		if withKey {
			routeCtx := chi.NewRouteContext()
			routeCtx.URLParams.Add("key", key)
			requestCtx = context.WithValue(requestCtx, chi.RouteCtxKey, routeCtx)
		}
		return req.WithContext(requestCtx)
	}
	assertWithheld := func(surface string, recorder *httptest.ResponseRecorder, wantStatus int) {
		t.Helper()
		if recorder.Code != wantStatus {
			t.Fatalf("%s status=%d body=%s, want %d", surface, recorder.Code,
				recorder.Body.String(), wantStatus)
		}
		body := recorder.Body.String()
		for _, forbidden := range []string{secret, key, revealOnceIngestSecretIssueRoute} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("%s exposed reveal-once material %q in %s", surface, forbidden, body)
			}
		}
		if recorder.Header().Get("X-Postwave-Idempotency-Replay") != "" {
			t.Fatalf("%s marked a withheld secret as replayed", surface)
		}
	}

	detail := httptest.NewRecorder()
	deps.Get(detail, request("/api/v1/idempotency/keys/"+key, true))
	assertWithheld("detail", detail, http.StatusNotFound)

	replay := httptest.NewRecorder()
	deps.Replay(replay, request("/api/v1/idempotency/keys/"+key+"/replay", true))
	assertWithheld("replay", replay, http.StatusNotFound)

	list := httptest.NewRecorder()
	deps.List(list, request("/api/v1/idempotency/keys", false))
	assertWithheld("list", list, http.StatusOK)

	stats := httptest.NewRecorder()
	deps.Stats(stats, request("/api/v1/idempotency/stats", false))
	assertWithheld("stats", stats, http.StatusOK)
}
