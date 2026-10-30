// SPDX-License-Identifier: AGPL-3.0-only
//
// LIST-E — a "Joined list" trigger built in the flow editor must enrol the
// people who join that list. The editor's list picker is filled from the list
// catalogue, whose rows are keyed on the ENGINE id, so the trigger is saved as
// {"type":"list_joined","list_id":"10"}; list_subscribers is keyed on the
// Moosewave uuid. The enrolment trigger (migration 1707) compared the two and
// never matched. Guarded by DATABASE_URL; activation is contained via the API,
// so the flows are forced active with direct SQL for setup only.
package flowbuilder

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func seedFlowListIdentity(t *testing.T, ctx context.Context, pool *db.Pool, tenant string, engineID int64) string {
	t.Helper()
	listUUID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("open list identity seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES ($1::uuid, $2, $3::uuid)`, listUUID, engineID, tenant); err != nil {
		t.Fatalf("seed list identity: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit list identity: %v", err)
	}
	return listUUID
}

func seedFlowSubscriber(t *testing.T, ctx context.Context, pool *db.Pool, tenant string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("open subscriber seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		tenant, fmt.Sprintf("list-joined-%d@example.test", time.Now().UnixNano())).Scan(&id); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
	return id
}

// createFlowLikeTheEditor POSTs the body the web flow editor sends and
// returns the created flow.
func createFlowLikeTheEditor(t *testing.T, router http.Handler, tenant, name string, trigger map[string]any) *Flow {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"name":     name,
		"status":   "draft",
		"entry_id": "n1",
		"triggers": []map[string]any{trigger},
		"nodes":    []map[string]any{{"id": "n1", "type": "wait", "duration_seconds": 60}, {"id": "n2", "type": "exit"}},
		"edges":    []map[string]any{{"from": "n1", "to": "n2"}},
	})
	if err != nil {
		t.Fatalf("marshal flow: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/flow-builder/flows", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenant})
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeWriteCampaigns, apikeys.ScopeReadCampaigns})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req.WithContext(ctx))
	if w.Code != http.StatusCreated {
		t.Fatalf("create flow %q: %d %s", name, w.Code, w.Body.String())
	}
	var flow Flow
	if err := json.Unmarshal(w.Body.Bytes(), &flow); err != nil {
		t.Fatalf("decode flow: %v", err)
	}
	return &flow
}

type queuedListJoin struct {
	FlowID  string
	Payload map[string]any
}

func queuedListJoins(t *testing.T, ctx context.Context, pool *db.Pool, tenant, subscriberID string) map[string]queuedListJoin {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("open flow_runs read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT flow_id::text, trigger_payload
  FROM flow_runs
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND trigger_event_name = 'list_joined' AND status = 'queued'`, tenant, subscriberID)
	if err != nil {
		t.Fatalf("read flow_runs: %v", err)
	}
	defer rows.Close()
	out := map[string]queuedListJoin{}
	for rows.Next() {
		var run queuedListJoin
		var raw []byte
		if err := rows.Scan(&run.FlowID, &raw); err != nil {
			t.Fatalf("scan flow_run: %v", err)
		}
		if err := json.Unmarshal(raw, &run.Payload); err != nil {
			t.Fatalf("decode trigger payload %s: %v", raw, err)
		}
		out[run.FlowID] = run
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate flow_runs: %v", err)
	}
	return out
}

func TestListJoinedTriggerBuiltInTheEditorEnrolsWhoJoins(t *testing.T) {
	pool, ctx := flowPublishDB(t)
	tenant := seedFlowTenant(t, ctx, pool)
	joined := seedFlowListIdentity(t, ctx, pool, tenant, 10)
	seedFlowListIdentity(t, ctx, pool, tenant, 11)
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Repo: &Repo{Pool: pool}})

	byEngineID := createFlowLikeTheEditor(t, router, tenant, "welcome (picked in the editor)",
		map[string]any{"type": "list_joined", "list_id": "10"})
	byUUID := createFlowLikeTheEditor(t, router, tenant, "welcome (API, uuid)",
		map[string]any{"type": "list_joined", "list_id": strings.ToUpper(joined)})
	anyList := createFlowLikeTheEditor(t, router, tenant, "any list",
		map[string]any{"type": "list_joined"})
	otherList := createFlowLikeTheEditor(t, router, tenant, "another list",
		map[string]any{"type": "list_joined", "list_id": "11"})
	// The flow keeps what the editor saved, so its picker still finds the list.
	if got := byEngineID.Graph.Triggers[0]["list_id"]; got != "10" {
		t.Fatalf("saved trigger list_id = %v, want the engine id the editor picked", got)
	}
	for _, flow := range []*Flow{byEngineID, byUUID, anyList, otherList} {
		forceActive(t, ctx, pool, tenant, flow.ID)
	}

	subscriber := seedFlowSubscriber(t, ctx, pool, tenant)
	added, err := (&lists.Repo{Pool: pool}).AddMembers(ctx, tenant, joined, []string{subscriber})
	if err != nil || added != 1 {
		t.Fatalf("join the list through the Members-tab writer: added=%d err=%v", added, err)
	}

	runs := queuedListJoins(t, ctx, pool, tenant, subscriber)
	for _, flow := range []*Flow{byEngineID, byUUID, anyList} {
		if _, ok := runs[flow.ID]; !ok {
			t.Errorf("flow %q did not enrol the subscriber who joined its list", flow.Name)
		}
	}
	if _, ok := runs[otherList.ID]; ok {
		t.Errorf("flow %q enrolled a subscriber who joined a different list", otherList.Name)
	}
	if len(runs) != 3 {
		t.Fatalf("queued list_joined runs = %d, want 3", len(runs))
	}
	// The payload the automation runtime re-checks: the canonical uuid (which
	// the bulk add-to-list undo cancels by) plus the engine id, both strings.
	payload := runs[byEngineID.ID].Payload
	if len(payload) != 2 || payload["list_id"] != joined || payload["listmonk_list_id"] != "10" {
		t.Fatalf("trigger payload = %v, want exactly {list_id: %s, listmonk_list_id: \"10\"}", payload, joined)
	}
}

func TestListJoinedTriggerSkipsAMalformedJourneyInsteadOfFailingTheJoin(t *testing.T) {
	pool, ctx := flowPublishDB(t)
	tenant := seedFlowTenant(t, ctx, pool)
	joined := seedFlowListIdentity(t, ctx, pool, tenant, 12)
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("open journey seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `
INSERT INTO automation_journeys (tenant_id, name, status, triggers)
VALUES ($1::uuid, 'malformed', 'active', '{"type":"list_joined"}'::jsonb)`, tenant); err != nil {
		t.Fatalf("seed malformed journey: %v", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatalf("commit journey: %v", err)
	}

	subscriber := seedFlowSubscriber(t, ctx, pool, tenant)
	added, err := (&lists.Repo{Pool: pool}).AddMembers(ctx, tenant, joined, []string{subscriber})
	if err != nil || added != 1 {
		t.Fatalf("a malformed journey broke the list join: added=%d err=%v", added, err)
	}
}
