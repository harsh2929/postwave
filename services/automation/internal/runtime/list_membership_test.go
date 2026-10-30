// SPDX-License-Identifier: AGPL-3.0-only

package runtime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

type recordingListMembership struct {
	mu       sync.Mutex
	tenants  []string
	requests []ListMembershipRequest
}

func (r *recordingListMembership) Emit(_ context.Context, tenantID string, req ListMembershipRequest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tenants = append(r.tenants, tenantID)
	r.requests = append(r.requests, req)
	return nil
}

func moveToListFlow(listID string) *canonical.Automation {
	return &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerTagAdded}},
		EntryID:  "move",
		Nodes: []canonical.AutomationNode{
			{ID: "move", Type: "action", Action: &canonical.AutomationAction{Kind: "move_to_list", ListID: listID}},
		},
	}
}

// LIST-F: "Move to list" put the contact on the engine's list only, which no
// campaign reads. The action now hands the membership to apps/api.
func TestMoveToListHandsTheMembershipToAPostwaveWriter(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	memberships := &recordingListMembership{}
	e.ListMembership = memberships
	r.PutAutomation(moveToListFlow(" 10 "))
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	if err := e.Trigger(WithTenant(context.Background(), "t"), "a", canonical.TriggerTagAdded, "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(memberships.requests) != 1 {
		t.Fatalf("membership requests = %d, want 1", len(memberships.requests))
	}
	got := memberships.requests[0]
	if memberships.tenants[0] != "t" || got.SubscriberEmail != "u@x.com" || got.ListID != "10" ||
		got.AutomationID != "a" || got.NodeID != "move" || got.RunID == "" {
		t.Fatalf("membership request = %+v tenant=%q", got, memberships.tenants[0])
	}
	if len(lm.addTags)+len(lm.removeTags)+len(lm.unsubs) != 0 {
		t.Fatal("move_to_list touched the engine's subscriber state")
	}
}

// Without the emitter there is no correct way to perform the action; the
// execution must fail rather than advance as if the contact had been added.
func TestMoveToListFailsClosedWithoutTheMembershipEmitter(t *testing.T) {
	e, _, _, _, r := buildEngine(t)
	auto := moveToListFlow("10")
	r.PutAutomation(auto)
	node := auto.FindNode("move")
	_, _, err := e.runNode(WithTenant(context.Background(), "t"), auto, node,
		Execution{TenantID: "t", AutomationID: "a", SubscriberEmail: "u@x.com", NodeID: "move"},
		canonical.Subscriber{Email: "u@x.com"})
	if err == nil || !strings.Contains(err.Error(), "list-membership emitter") {
		t.Fatalf("runNode error = %v, want a fail-closed wiring error", err)
	}
	e.ListMembership = &recordingListMembership{}
	auto.Nodes[0].Action.ListID = "  "
	if _, _, err := e.runNode(WithTenant(context.Background(), "t"), auto, node,
		Execution{TenantID: "t", AutomationID: "a", SubscriberEmail: "u@x.com", NodeID: "move"},
		canonical.Subscriber{Email: "u@x.com"}); err == nil || !strings.Contains(err.Error(), "missing list_id") {
		t.Fatalf("blank list id error = %v, want missing list_id", err)
	}
}

func TestPgxListMembershipEmitterPersistsUnderForcedTenantRLS(t *testing.T) {
	pool := automationStateTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var privileged bool
	if err := pool.QueryRow(ctx, `
SELECT COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), false)`).Scan(&privileged); err != nil {
		t.Fatalf("inspect role: %v", err)
	}
	if privileged {
		t.Skip("DATABASE_URL role bypasses RLS; use the postwave_app runtime role for this contract")
	}
	tenantID := seedAutomationStateTenant(t, pool)
	req := ListMembershipRequest{
		SubscriberEmail: "move-" + uuid.NewString() + "@example.test",
		ListID:          "10",
		AutomationID:    uuid.NewString(),
		NodeID:          "move",
		RunID:           "move-rls-" + uuid.NewString(),
	}
	if err := (&PgxListMembershipEmitter{Pool: pool}).Emit(ctx, tenantID, req); err != nil {
		t.Fatalf("emit list membership: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin verification: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant: %v", err)
	}
	var kind, listID, email, nodeID string
	if err := tx.QueryRow(ctx, `
SELECT kind, payload->>'list_id', payload->>'subscriber_email', payload->>'node_id'
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND payload->>'run_id' = $2`, tenantID, req.RunID).Scan(&kind, &listID, &email, &nodeID); err != nil {
		t.Fatalf("read list membership outbox row: %v", err)
	}
	if kind != "automation.list_membership" || listID != "10" || email != req.SubscriberEmail || nodeID != "move" {
		t.Fatalf("stored outbox row = kind %q list %q email %q node %q", kind, listID, email, nodeID)
	}
	if err := tx.Commit(ctx); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("commit verification: %v", err)
	}
}
