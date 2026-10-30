package runtime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// The Postgres store, through RLS as postwave_app, against the real schema.
//
// Three things a stub cannot prove: that the INSERT satisfies the table's
// constraints (re_enrollment CHECK, NOT NULL jsonb columns), that Update finds
// a row in automation_journeys when it is not in automations, and that the
// row written by Create reads back through scanAutomation unchanged -- the
// same scan the runtime resolves against.

func draftGraph(name string) canonical.Automation {
	tpl := "tpl-1"
	return canonical.Automation{
		Name:     name,
		Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerListJoined, ListID: "l1"}},
		Nodes: []canonical.AutomationNode{
			{ID: "n1", Type: "send_email", TemplateID: tpl},
			{ID: "n2", Type: "wait", DurationSeconds: 60},
		},
		Edges: []canonical.AutomationEdge{{From: "n1", To: "n2"}},
	}
}

func TestPostgresStoreCreateReadsBackThroughTheRuntimeScan(t *testing.T) {
	pool := automationStateTestPool(t)
	tenant := seedAutomationStateTenant(t, pool)
	store := &PostgresResolver{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	created, err := store.Create(ctx, tenant, draftGraph("db create"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == "" || created.Status != "draft" || created.TenantID != tenant {
		t.Fatalf("unexpected row: %+v", created)
	}
	if created.Nodes[0].TemplateID != "tpl-1" || created.Nodes[1].DurationSeconds != 60 {
		t.Fatalf("graph did not round-trip: %+v", created.Nodes)
	}
	if created.EntryID != "n1" {
		t.Fatalf("entry must be derived on read, got %q", created.EntryID)
	}

	// It is listed -- as a draft, which ListActiveByTenant would hide.
	page, err := store.ListByTenant(ctx, tenant, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page) != 1 || page[0].ID != created.ID {
		t.Fatalf("created row must be listable: %+v", page)
	}
	if active, _ := store.ListActiveByTenant(ctx, tenant); len(active) != 0 {
		t.Fatalf("the runtime view must still exclude drafts: %+v", active)
	}
	if filtered, _ := store.ListByTenant(ctx, tenant, "paused"); len(filtered) != 0 {
		t.Fatalf("status filter must apply: %+v", filtered)
	}
}

func TestPostgresStoreUpdateOnBothTables(t *testing.T) {
	pool := automationStateTestPool(t)
	tenant := seedAutomationStateTenant(t, pool)
	store := &PostgresResolver{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	created, err := store.Create(ctx, tenant, draftGraph("db update"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	active := "active"
	updated, err := store.Update(ctx, tenant, created.ID, AutomationPatch{Status: &active})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Status != "active" || updated.Nodes[0].TemplateID != "tpl-1" {
		t.Fatalf("partial patch went wrong: %+v", updated)
	}
	if now, _ := store.ListActiveByTenant(ctx, tenant); len(now) != 1 {
		t.Fatalf("after activation the runtime must see it: %+v", now)
	}

	// A journey row -- what the web builder writes -- is found on the fallback.
	tx, err := store.beginTenant(ctx, tenant)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var journeyID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO automation_journeys (tenant_id, name, status, triggers, nodes, edges)
		VALUES ($1::uuid, 'gui journey', 'draft',
		        '[{"type":"list_joined"}]', '[{"id":"n1","type":"send_email"}]', '[]')
		RETURNING id::text`, tenant).Scan(&journeyID); err != nil {
		t.Fatalf("seed journey: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	name := "gui journey v2"
	j, err := store.Update(ctx, tenant, journeyID, AutomationPatch{Name: &name})
	if err != nil {
		t.Fatalf("update journey: %v", err)
	}
	if j.Name != name {
		t.Fatalf("journey patch not applied: %+v", j)
	}

	// Not found, and not another tenant's.
	other := seedAutomationStateTenant(t, pool)
	if _, err := store.Update(ctx, other, created.ID, AutomationPatch{Name: &name}); !errors.Is(err, ErrAutomationNotFound) {
		t.Fatalf("cross-tenant update must be not-found, got %v", err)
	}

	// A rejected patch leaves the row untouched.
	empty := []canonical.AutomationNode{}
	if _, err := store.Update(ctx, tenant, created.ID, AutomationPatch{Nodes: &empty}); !errors.Is(err, ErrInvalidAutomation) {
		t.Fatalf("an emptied graph must be invalid, got %v", err)
	}
	after, _ := store.lookupAutomationForTenant(ctx, tenant, created.ID)
	if len(after.Nodes) != 2 {
		t.Fatalf("a rejected patch must not persist: %+v", after.Nodes)
	}
}
