package lists

// LIST-F — a flow's "Move to list" action must put the contact on the list
// campaigns send to. services/automation enqueues the payload below
// (runtime.ListMembershipRequest, persisted by PgxListMembershipEmitter and
// asserted there against the database); this handler writes it.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func automationMembershipEvent(t *testing.T, tenantID, email, listID string) outbox.Event {
	t.Helper()
	// Field for field what the automation engine enqueues for a move_to_list
	// action whose list the flow editor picked (the engine id).
	payload, err := json.Marshal(map[string]string{
		"subscriber_email": email,
		"list_id":          listID,
		"automation_id":    "3f5b7c1e-2d4a-4b6c-8e9f-0a1b2c3d4e5f",
		"node_id":          "move",
		"run_id":           "run-" + uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return outbox.Event{ID: uuid.NewString(), TenantID: tenantID, Kind: AutomationListMembershipKind, Payload: payload}
}

func TestAutomationListMembershipKindMatchesTheAutomationEngine(t *testing.T) {
	// services/automation/internal/runtime.listMembershipKind
	if AutomationListMembershipKind != "automation.list_membership" {
		t.Fatalf("outbox kind = %q; the automation engine enqueues automation.list_membership", AutomationListMembershipKind)
	}
}

func TestAutomationMoveToListWritesTheMembershipCampaignsSendTo(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	listUUID := mapListIdentity(t, pool, tenantID, 10)
	webhooks := &recordingMembershipWebhookFanout{}
	repo := &Repo{Pool: pool, MembershipWebhooks: webhooks}
	handler := &AutomationListMembershipHandler{Repo: repo}
	ctx := context.Background()
	email := fmt.Sprintf("moved-%d@example.test", time.Now().UnixNano())
	seedAutomationContact(t, pool, tenantID, email)

	event := automationMembershipEvent(t, tenantID, email, "10")
	if err := handler.Handle(ctx, event); err != nil {
		t.Fatalf("handle move_to_list: %v", err)
	}
	members, total, err := repo.ListMembers(ctx, tenantID, listUUID, "", "", 1, 25)
	if err != nil || total != 1 || members[0].Email != email || members[0].Source != "api" {
		t.Fatalf("members after move_to_list = %+v total=%d err=%v, want the contact", members, total, err)
	}
	if count, countErr := repo.CountListAudience(ctx, tenantID, "10"); countErr != nil || count != 1 {
		t.Fatalf("campaign audience for the list = %d, %v; want 1", count, countErr)
	}
	if len(webhooks.events) != 1 || webhooks.events[0].ListID != listUUID {
		t.Fatalf("list.subscriber.added intents = %+v, want one for %s", webhooks.events, listUUID)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open owner read: %v", err)
	}
	var owner, recordedAutomation string
	if err := tx.QueryRow(ctx, `
SELECT owner_key, metadata->>'automation_id'
  FROM list_subscriber_sources
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL`, tenantID, listUUID).Scan(&owner, &recordedAutomation); err != nil {
		t.Fatalf("read membership owner: %v", err)
	}
	_ = tx.Rollback(ctx)
	if owner != "source:api" || recordedAutomation != "3f5b7c1e-2d4a-4b6c-8e9f-0a1b2c3d4e5f" {
		t.Fatalf("owner = %q automation = %q", owner, recordedAutomation)
	}

	// At-least-once delivery: the same row again changes nothing.
	if err := handler.Handle(ctx, event); err != nil {
		t.Fatalf("redeliver: %v", err)
	}
	if _, total, _ := repo.ListMembers(ctx, tenantID, listUUID, "", "", 1, 25); total != 1 || len(webhooks.events) != 1 {
		t.Fatalf("after redelivery total=%d intents=%d, want 1 and 1", total, len(webhooks.events))
	}

	// A flow that names the list by its uuid lands in the same place.
	other := fmt.Sprintf("moved-uuid-%d@example.test", time.Now().UnixNano())
	seedAutomationContact(t, pool, tenantID, other)
	if err := handler.Handle(ctx, automationMembershipEvent(t, tenantID, other, listUUID)); err != nil {
		t.Fatalf("handle uuid move_to_list: %v", err)
	}
	if _, total, _ := repo.ListMembers(ctx, tenantID, listUUID, "", "", 1, 25); total != 2 {
		t.Fatalf("members after the uuid-named move = %d, want 2", total)
	}
}

func TestAutomationMoveToListAcksWhatCanNeverSucceed(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	repo := &Repo{Pool: pool}
	handler := &AutomationListMembershipHandler{Repo: repo}
	ctx := context.Background()

	for name, event := range map[string]outbox.Event{
		"unknown list":     automationMembershipEvent(t, tenantID, "nobody@example.test", "999"),
		"malformed list":   automationMembershipEvent(t, tenantID, "nobody@example.test", "not-a-list"),
		"missing address":  automationMembershipEvent(t, tenantID, "  ", "10"),
		"unreadable event": {ID: uuid.NewString(), TenantID: tenantID, Kind: AutomationListMembershipKind, Payload: json.RawMessage(`{`)},
	} {
		if err := handler.Handle(ctx, event); err != nil {
			t.Fatalf("%s: error %v; retrying cannot make it succeed, so the row must be acked", name, err)
		}
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open check: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var rows int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid`, tenantID).Scan(&rows); err != nil {
		t.Fatalf("count subscribers: %v", err)
	}
	if rows != 0 {
		t.Fatalf("an unwritable move_to_list created %d subscriber shells", rows)
	}
}

// seedAutomationContact creates the contact a flow run was enrolled with.
func seedAutomationContact(t *testing.T, pool *db.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open contact seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, mailchimp_status, consent_source,
    custom_fields, tags, merge_fields, groups, gdpr_permissions
)
VALUES (
    $1::uuid, $2, $2, 'unconfirmed', 'non_subscribed', 'unknown',
    '{}'::jsonb, ARRAY[]::text[], '{}'::jsonb, '[]'::jsonb, '[]'::jsonb
)
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed contact: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit contact seed: %v", err)
	}
	return id
}

// tenantRowCount counts rows of a tenant-scoped query under RLS.
func tenantRowCount(t *testing.T, pool *db.Pool, tenantID, query string, args ...any) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open count: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, query, append([]any{tenantID}, args...)...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// A flow's outbox row carries only the address the run was enrolled with, and
// is handled later, with retries. By then the contact may have been deleted,
// or erased by a privacy request. The handler used to mint an identity shell
// for any address it did not find, so a Move to list brought an erased
// address back as a subscriber, announced it to list.subscriber.added
// webhooks and enrolled it in "Joined list" flows.
func TestAutomationMoveToListNeverCreatesOrRevivesAContact(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantID := seedListIdentityTenant(t, pool)
	listUUID := mapListIdentity(t, pool, tenantID, 10)
	webhooks := &recordingMembershipWebhookFanout{}
	repo := &Repo{Pool: pool, MembershipWebhooks: webhooks}
	handler := &AutomationListMembershipHandler{Repo: repo}
	ctx := context.Background()
	stamp := time.Now().UnixNano()

	// An active "Joined list" flow on any list: every membership this test
	// lets through queues a run for it.
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open seed: %v", err)
	}
	defer func() { _ = seed.Rollback(ctx) }()
	if _, err := seed.Exec(ctx, `
INSERT INTO automation_journeys (tenant_id, name, status, triggers)
VALUES ($1::uuid, 'welcome', 'active', '[{"type":"list_joined"}]'::jsonb)`, tenantID); err != nil {
		t.Fatalf("seed flow: %v", err)
	}
	// The tombstone a subscriber delete writes (subscribers/erasure).
	erasedGone := fmt.Sprintf("erased-gone-%d@example.test", stamp)
	erasedBack := fmt.Sprintf("erased-back-%d@example.test", stamp)
	for _, email := range []string{erasedGone, erasedBack} {
		if _, err := seed.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'manual', 'gdpr_delete', '{"gdpr_erasure": true}'::jsonb)`, tenantID, email); err != nil {
			t.Fatalf("seed erasure tombstone: %v", err)
		}
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	// A contact row an unguarded writer re-created after the erasure.
	seedAutomationContact(t, pool, tenantID, erasedBack)
	unknown := fmt.Sprintf("never-seen-%d@example.test", stamp)

	for _, email := range []string{erasedGone, erasedBack, unknown} {
		if err := handler.Handle(ctx, automationMembershipEvent(t, tenantID, email, "10")); err != nil {
			t.Fatalf("%s: error %v; retrying cannot make it valid, so the row must be acked", email, err)
		}
	}
	if n := tenantRowCount(t, pool, tenantID, `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid`); n != 1 {
		t.Fatalf("subscribers = %d, want only the re-created contact: an erased or unknown address was minted", n)
	}
	if n := tenantRowCount(t, pool, tenantID, `SELECT count(*) FROM list_subscribers WHERE tenant_id = $1::uuid AND list_id = $2::uuid`, listUUID); n != 0 {
		t.Fatalf("memberships = %d, want 0", n)
	}
	if n := tenantRowCount(t, pool, tenantID, `SELECT count(*) FROM list_subscriber_sources WHERE tenant_id = $1::uuid`); n != 0 {
		t.Fatalf("membership owner rows = %d, want 0", n)
	}
	if n := tenantRowCount(t, pool, tenantID, `SELECT count(*) FROM flow_runs WHERE tenant_id = $1::uuid`); n != 0 {
		t.Fatalf("flow runs = %d, want 0: a refused address was enrolled", n)
	}
	if len(webhooks.events) != 0 {
		t.Fatalf("list.subscriber.added intents = %+v, want none", webhooks.events)
	}

	// Control: a contact that exists and was not erased is moved, announced
	// and enrolled, so the zeros above are refusals and not a dead flow.
	kept := fmt.Sprintf("kept-%d@example.test", stamp)
	seedAutomationContact(t, pool, tenantID, kept)
	if err := handler.Handle(ctx, automationMembershipEvent(t, tenantID, kept, "10")); err != nil {
		t.Fatalf("move a live contact: %v", err)
	}
	if n := tenantRowCount(t, pool, tenantID, `SELECT count(*) FROM flow_runs WHERE tenant_id = $1::uuid`); n != 1 {
		t.Fatalf("flow runs after a live move = %d, want 1", n)
	}
	if len(webhooks.events) != 1 || webhooks.events[0].Email != kept {
		t.Fatalf("list.subscriber.added intents = %+v, want one for the live contact", webhooks.events)
	}
}
