// SPDX-License-Identifier: AGPL-3.0-only
//
// ingest_e2e_db_test.go — end-to-end webhook-ingest test against a REAL Postgres
// (not the fakeStore). Exercises the actual Repo SQL + handlers + the RLS
// token-lookup the way production does: provision via the authenticated handler,
// then POST a webhook to the PUBLIC ingest endpoint, which resolves the tenant
// by URL token through the FORCE-RLS lookup policy and lands the member.
//
// Skips unless DATABASE_URL points at a Postgres that has the
// loyalty_integrations / loyalty_sync_runs schema (migrations 1541, 1612, 1616)
// AND is reached as a NON-superuser role (superusers bypass RLS, which would
// make the lookup a no-op). Stand up a throwaway DB with the committed fixture:
//
//	createdb ingest_e2e
//	psql -d ingest_e2e -v ON_ERROR_STOP=1 -f apps/api/internal/loyalty_integrations/testdata/ingest_e2e_setup.sql
//	DATABASE_URL='postgres://postwave_app:postwave_app_dev@localhost:5432/ingest_e2e?sslmode=disable' \
//	  go test ./apps/api/internal/loyalty_integrations/ -run E2E -count=1
package loyalty_integrations

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func ingestE2EPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed loyalty ingest e2e test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	// Confirm the schema is present; skip (not fail) if this DB isn't set up.
	var ok bool
	if err := pool.QueryRow(context.Background(),
		"SELECT to_regclass('public.loyalty_integrations') IS NOT NULL").Scan(&ok); err != nil || !ok {
		pool.Close()
		t.Fatalf("loyalty_integrations table absent (run /tmp/ingest_e2e_setup.sql): %v", err)
	}
	return pool
}

func TestIngestE2EProvisionThenWebhookLands(t *testing.T) {
	pool := ingestE2EPool(t)
	t.Cleanup(pool.Close)
	ctx := context.Background()

	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tenantTx, tenantTxErr := db.WithTenant(ctx, pool, tenantID)
	if tenantTxErr != nil {
		t.Fatalf("begin tenant tx: %v", tenantTxErr)
	}
	defer func() { _ = tenantTx.Rollback(ctx) }()
	if _, err := tenantTx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Loyalty ingest E2E test', 'studio')`,
		tenantID, "loyalty-ingest-e2e-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tenantTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupTx, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(context.Background()) }()
		_, _ = cleanupTx.Exec(context.Background(), "DELETE FROM tenants WHERE id::text = $1", tenantID)
		_ = cleanupTx.Commit(context.Background())
	})

	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:           &Repo{Pool: pool},
		Profiles:       profiles,
		Events:         events,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		NewIngestToken: func() (string, error) { return "e2e_tok_growave", nil },
	}

	authed := chi.NewRouter()
	authed.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			requestCtx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
			requestCtx = middleware.WithUser(requestCtx, &middleware.User{
				ID: "loyalty-ingest-e2e-owner", TenantID: tenantID, Role: "owner",
			})
			next.ServeHTTP(w, req.WithContext(requestCtx))
		})
	})
	MountRoutes(authed, deps)
	public := chi.NewRouter()
	MountPublicRoutes(public, deps)

	// 1) Provision a curated push-only desk via the REAL authed handler.
	rec := httptest.NewRecorder()
	authed.ServeHTTP(rec, loyaltyIngestJSONRequest(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"growave"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("provision status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.IngestToken != "e2e_tok_growave" || ep.IngestPath == "" {
		t.Fatalf("unexpected endpoint: %+v", ep)
	}

	// 2) POST a provider webhook to the PUBLIC ingest URL — resolves the tenant
	//    by token through the FORCE-RLS lookup policy, maps, and lands the member.
	body := `{"email":"VIP@Example.com","points_balance":1200,"vip_tier":"Gold","event":"points.updated"}`
	rec = httptest.NewRecorder()
	public.ServeHTTP(rec, loyaltyIngestJSONRequest(http.MethodPost, ep.IngestPath, body))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("public ingest status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 3) The member landed in the profile sink with the tenant resolved by token.
	if len(profiles.members) != 1 || profiles.members[0].Email != "vip@example.com" {
		t.Fatalf("member did not land via the real RLS lookup: %+v", profiles.members)
	}
	if profiles.members[0].PointsBalance != 1200 || profiles.members[0].VIPTier != "Gold" {
		t.Fatalf("member fields not mapped: %+v", profiles.members[0])
	}

	// 4) A sync run was recorded against the real DB (proves RecordSyncRun SQL works).
	runs, tenantTxErr := deps.Repo.ListRuns(ctx, tenantID, ep.IntegrationID, 10)
	if tenantTxErr != nil {
		t.Fatalf("ListRuns: %v", tenantTxErr)
	}
	if len(runs) < 1 || runs[0].RunMode != "webhook" {
		t.Fatalf("expected a recorded webhook sync run, got %+v", runs)
	}

	// 5) Disconnect, then re-provision — must mint a FRESH token (Bug 1, runtime).
	if err := deps.Repo.DisconnectIntegration(ctx, tenantID, ep.IntegrationID); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	deps.NewIngestToken = func() (string, error) { return "e2e_tok_growave_v2", nil }
	rec = httptest.NewRecorder()
	authed.ServeHTTP(rec, loyaltyIngestJSONRequest(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"growave"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("re-provision status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep2 IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep2); err != nil {
		t.Fatal(err)
	}
	if ep2.IngestToken != "e2e_tok_growave_v2" {
		t.Fatalf("Bug1 regression: reconnect did not adopt the fresh token, got %q", ep2.IngestToken)
	}

	// 6) An ARBITRARY long-tail provider provisions (migration 1616 dropped the
	//    enumerated provider CHECK that would otherwise 500 the insert).
	deps.NewIngestToken = func() (string, error) { return "e2e_tok_bridge", nil }
	rec = httptest.NewRecorder()
	authed.ServeHTTP(rec, loyaltyIngestJSONRequest(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"Viral Loops"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("arbitrary-provider provision status=%d body=%s (provider CHECK not relaxed?)", rec.Code, rec.Body.String())
	}
	var ep3 IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep3); err != nil {
		t.Fatal(err)
	}
	if ep3.Provider != "viral-loops" {
		t.Fatalf("arbitrary provider not slugified+stored: %+v", ep3)
	}
}

func loyaltyIngestJSONRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}
