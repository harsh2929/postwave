// SPDX-License-Identifier: AGPL-3.0-only
//
// FLOW-008 — DB-backed proof of the draft/publish invariant: editing an ACTIVE
// flow writes a draft and leaves the live journey graph untouched; only Publish
// swaps the live graph. Guarded by DATABASE_URL. Activation is contained via
// the API, so the test forces status='active' with direct SQL for setup only.
package flowbuilder

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func flowPublishDB(t *testing.T) (*db.Pool, context.Context) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping FLOW-008 publish DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, ctx
}

func seedFlowTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	slug := "flow008-" + hex.EncodeToString(buf)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var id string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	_, _ = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, id)
	if _, err := conn.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid,$2,$2,'studio')`, id, slug); err != nil {
		t.Fatalf("seed tenant (role needs INSERT on tenants): %v", err)
	}
	t.Cleanup(func() {
		c, e := pool.Acquire(context.Background())
		if e != nil {
			return
		}
		defer c.Release()
		_, _ = c.Exec(context.Background(), `SELECT set_config('app.tenant_id', $1, false)`, id)
		_, _ = c.Exec(context.Background(), `DELETE FROM automation_flow_versions WHERE tenant_id=$1::uuid`, id)
		_, _ = c.Exec(context.Background(), `DELETE FROM automation_journeys WHERE tenant_id=$1::uuid`, id)
		_, _ = c.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, id)
	})
	return id
}

// forceActive flips a journey to 'active' in a tenant-scoped tx (activation is
// contained via the API; this is setup only). Tenant-scoped so it works under
// the non-privileged postwave_app role (RLS enforced) as well as a superuser.
func forceActive(t *testing.T, ctx context.Context, pool *db.Pool, tenant, flowID string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE automation_journeys SET status='active' WHERE id=$1::uuid`, flowID); err != nil {
		t.Fatalf("force active: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit active: %v", err)
	}
}

// liveJourneyNodes reads a journey's live node column in a tenant-scoped tx.
func liveJourneyNodes(t *testing.T, ctx context.Context, pool *db.Pool, tenant, flowID string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var nodes string
	if err := tx.QueryRow(ctx, `SELECT nodes::text FROM automation_journeys WHERE id=$1::uuid`, flowID).Scan(&nodes); err != nil {
		t.Fatalf("read live nodes: %v", err)
	}
	_ = tx.Commit(ctx)
	return nodes
}

func graphWith(exitID string) FlowGraph {
	return FlowGraph{
		EntryID: "n1",
		Nodes: []map[string]any{
			{"id": "n1", "type": "wait"},
			{"id": exitID, "type": "exit"},
		},
		Edges: []map[string]any{{"from": "n1", "to": exitID}},
	}
}

func TestPublishFlowDraftInvariantDB(t *testing.T) {
	pool, ctx := flowPublishDB(t)
	tenant := seedFlowTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}

	// Seed a flow, then force it ACTIVE (activation is contained via the API).
	flow, err := repo.CreateFlow(ctx, tenant, FlowInput{
		Name:    "live flow",
		EntryID: "n1",
		Nodes:   graphWith("n2").Nodes,
		Edges:   graphWith("n2").Edges,
	})
	if err != nil {
		t.Fatalf("create flow: %v", err)
	}
	forceActive(t, ctx, pool, tenant, flow.ID)

	active, err := repo.GetFlow(ctx, tenant, flow.ID)
	if err != nil || active.Status != "active" {
		t.Fatalf("get active: %v status=%v", err, active.Status)
	}

	before := liveJourneyNodes(t, ctx, pool, tenant, flow.ID)

	// Editing the ACTIVE flow writes a DRAFT; the live journey is untouched.
	if _, err := repo.CreateVersion(ctx, tenant, active, VersionInput{GeneratedBy: "human"}, graphWith("n3")); err != nil {
		t.Fatalf("draft version: %v", err)
	}
	if after := liveJourneyNodes(t, ctx, pool, tenant, flow.ID); after != before {
		t.Fatalf("live journey graph changed on active-flow edit:\n before=%s\n after=%s", before, after)
	}
	reloaded, err := repo.GetFlow(ctx, tenant, flow.ID)
	if err != nil || reloaded.LatestVersion == nil || reloaded.LatestVersion.Status != "draft" {
		t.Fatalf("expected a draft latest_version, got %+v (err %v)", reloaded.LatestVersion, err)
	}

	// Publish promotes the draft into the live journey (status stays active).
	published, err := repo.PublishFlow(ctx, tenant, flow.ID, "", reloaded.UpdatedAt)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if published.Status != "active" {
		t.Fatalf("post-publish status = %s, want active", published.Status)
	}
	after := liveJourneyNodes(t, ctx, pool, tenant, flow.ID)
	if after == before {
		t.Fatalf("publish did not change the live graph")
	}
	if published.LatestVersion == nil || published.LatestVersion.Status != "published" {
		t.Fatalf("latest_version not published: %+v", published.LatestVersion)
	}

	// Publish on a NON-active flow is rejected (can never start execution).
	draftFlow, err := repo.CreateFlow(ctx, tenant, FlowInput{
		Name: "draft flow", EntryID: "n1",
		Nodes: graphWith("n2").Nodes, Edges: graphWith("n2").Edges,
	})
	if err != nil {
		t.Fatalf("create draft flow: %v", err)
	}
	if _, err := repo.PublishFlow(ctx, tenant, draftFlow.ID, "", draftFlow.UpdatedAt); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("publish on a draft flow err = %v, want ErrInvalidInput", err)
	}
}

// Handler-level: PATCH on an active flow (no status) writes a draft and returns
// 200 — NOT the 503 it used to. Explicit status:active stays contained (503).
func TestUpdateFlowOnActiveWritesDraftHandlerDB(t *testing.T) {
	pool, ctx := flowPublishDB(t)
	tenant := seedFlowTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	d := &Deps{Repo: repo}

	flow, err := repo.CreateFlow(ctx, tenant, FlowInput{
		Name: "handler flow", EntryID: "n1",
		Nodes: graphWith("n2").Nodes, Edges: graphWith("n2").Edges,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	forceActive(t, ctx, pool, tenant, flow.ID)
	flow, err = repo.GetFlow(ctx, tenant, flow.ID)
	if err != nil {
		t.Fatalf("reload active flow: %v", err)
	}

	newReq := func(body string) *http.Request {
		r := httptest.NewRequest(http.MethodPatch, "/x", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("If-Match", flowETag(flow))
		c := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenant})
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", flow.ID)
		c = context.WithValue(c, chi.RouteCtxKey, rctx)
		return r.WithContext(c)
	}

	// Active flow, graph only, no status → 200 (draft written).
	rec := httptest.NewRecorder()
	d.UpdateFlow(rec, newReq(`{"entry_id":"n1","nodes":[{"id":"n1","type":"wait"},{"id":"n9","type":"exit"}],"edges":[{"from":"n1","to":"n9"}]}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("active edit: status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	// Explicit status:active is still contained.
	rec = httptest.NewRecorder()
	d.UpdateFlow(rec, newReq(`{"status":"active"}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status:active: status = %d, want 503", rec.Code)
	}
}
