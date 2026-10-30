// SPDX-License-Identifier: AGPL-3.0-only
//
// opsdemo — a LOCAL-ONLY harness that mounts the REAL ops-console view handlers
// (internal/ops/views) against the dev DB, with no platform-operator gate and no
// monolith startup guards. It exists so the apps/ops UI can be exercised locally
// against real data without booting the full API. NOT for any non-dev use.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/ops/views"
	"github.com/postwave/postwave/apps/api/internal/tenantcontrols"
)

func ok200(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// board serves a minimal valid check board so the console landing page renders.
// The real board comes from the check registry in the full API; this demo stub
// carries a single illustrative card and otherwise reads all-green.
func board(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"generated_at":"` + time.Now().UTC().Format(time.RFC3339) + `","lanes":[` +
		`{"name":"ON FIRE","count":0},` +
		`{"name":"NEEDS YOU","count":1,"cards":[{"id":"demo.sample","why":"Demo board stub — start the full API for the real check registry","kind":"manual","severity":"routine","status":"warn","remediation":"Run the full apps/api to see live checks"}]},` +
		`{"name":"CLOCKS","count":0},` +
		`{"name":"AUTOMATIONS","count":0,"alive":0,"stale":0,"stale_ids":[]},` +
		`{"name":"SNOOZED","count":0},` +
		`{"name":"GREEN","count":0,"ids":[]}` +
		`]}`))
}

func main() {
	// log.Fatal inside run would skip its deferred pool.Close; exit from here
	// instead so the pool is released on every path.
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	dsn := os.Getenv("DEMO_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://postgres:public-local-demo-only@localhost:55432/postwave?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		return fmt.Errorf("db: %w", err)
	}
	defer pool.Close()

	reader := &views.Reader{Pool: pool}
	incidents := &views.IncidentRepo{Pool: pool}
	operator := views.OperatorResolver(func(context.Context) string { return "dev-operator@postwave.local" })
	audit := views.ActionAudit(func(_ context.Context, event string, fields map[string]any) error {
		log.Printf("audit: %s %v", event, fields)
		return nil
	})
	killSwitch := views.KillSwitchFunc(func(ctx context.Context, tenantID string, paused bool, reason, actor string) error {
		_, e := (&tenantcontrols.Repo{Pool: pool}).SetEmailSendingPaused(ctx, tenantID, paused, reason, actor)
		return e
	})

	r := chi.NewRouter()
	r.Get("/api/health", ok200)
	r.Get("/api/ready", ok200)
	r.Get("/api/internal/ops/board", board)
	r.Route("/api/internal/ops/views", func(r chi.Router) {
		r.Get("/tenants", views.TenantsHandler(reader))
		r.Get("/send/queue-depth", views.QueueDepthHandler(reader))
		r.Get("/send/dead-letters", views.DeadLettersHandler(reader))
		r.Get("/deliverability/by-tenant", views.DeliverabilityHandler(reader))
		r.Get("/billing/by-tenant", views.BillingHandler(reader))
		r.Get("/incidents", views.IncidentsHandler(reader))
		r.Get("/incidents/{id}", views.IncidentTimelineHandler(reader))
		r.Post("/incidents", views.OpenIncidentHandler(incidents, audit, operator))
		r.Post("/incidents/{id}/updates", views.AppendUpdateHandler(incidents, audit, operator))
		r.Post("/tenants/{id}/kill-switch", views.KillSwitchHandler(killSwitch, audit, operator))
	})

	addr := ":8080"
	log.Printf("opsdemo listening on %s", addr)
	return http.ListenAndServe(addr, r)
}
