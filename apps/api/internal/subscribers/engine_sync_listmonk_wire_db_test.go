// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/testsupport/listmonkv6"
)

// The canonical sync reconciles a Moosewave subscriber into Listmonk with the
// real client against Listmonk v6.1.0's wire shapes and subscription
// semantics. Two defects met here: looking the subscriber up by address
// failed to decode as soon as it was on a list (lists are objects), so the
// sync retried into the DLQ; and the update was a PUT, which on v6.1.0 drops
// every subscription and resets attribs, so every profile edit removed the
// contact from its lists.
func TestListmonkSyncKeepsTheSubscribersListmonkSubscriptionsAndAttribs(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	requireApplicationRole(t, repo.Pool)
	ctx := context.Background()
	email := "engine-lists-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	engine := listmonkv6.NewServer(t)
	engine.AddList(3, "Launch", "single")
	engine.AddList(4, "Updates", "single")
	wantLists := map[int64]string{3: listmonkv6.SubscriptionConfirmed, 4: listmonkv6.SubscriptionUnconfirmed}
	listmonkID := engine.SeedSubscriber(email, "", listmonkv6.StatusDisabled, map[string]any{"city": "Oslo"}, wantLists)

	handler := tenantScopedTestSyncHandler(repo, tenantID, listmonk.New(listmonk.Config{BaseURL: engine.URL}))
	if err = handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, "")); err != nil {
		t.Fatalf("first sync of a subscriber Listmonk holds on two lists: %v", err)
	}
	marked, err := repo.Get(ctx, tenantID, sub.ID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := listmonkIDFromCustomFields(marked.CustomFields); got != listmonkID {
		t.Fatalf("adopted Listmonk id = %d, want %d", got, listmonkID)
	}

	// A later canonical change syncs again through the persisted marker.
	name := "Grace Hopper"
	if _, err := repo.Update(ctx, tenantID, sub.ID, UpdateInput{FullName: &name, DisplayName: &name}); err != nil {
		t.Fatalf("profile change: %v", err)
	}
	if err := handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, "")); err != nil {
		t.Fatalf("second sync: %v", err)
	}
	got, _ := engine.Subscriber(email)
	if !reflect.DeepEqual(got.Lists, wantLists) {
		t.Fatalf("Listmonk subscriptions after two syncs = %v, want %v unchanged", got.Lists, wantLists)
	}
	if got.Attribs["city"] != "Oslo" {
		t.Fatalf("Listmonk attribs after sync = %v, want city kept", got.Attribs)
	}
	if got.Name != name || got.Status != listmonkv6.StatusDisabled {
		t.Fatalf("Listmonk name %q status %q, want the canonical %q and disabled (unconfirmed)", got.Name, got.Status, name)
	}
	if n := len(engine.RequestsTo(http.MethodPut, "/api/subscribers/"+strconv.FormatInt(listmonkID, 10))); n != 0 {
		t.Fatalf("%d PUT requests reached Listmonk; PUT wipes subscriptions", n)
	}
}

// A privacy erasure of an address Listmonk holds on a list must remove it
// from Listmonk: the delete handler finds it by address when no marker was
// ever persisted, and that lookup is the same decode.
func TestErasureRemovesAListmonkSubscriberThatIsOnLists(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	requireApplicationRole(t, pool)
	ctx := context.Background()
	email := "engine-erase-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	if _, err = repo.DeleteWithAudit(ctx, tenantID, sub.ID, sub.Version, db.AuditMeta{
		TenantID: tenantID, ActorType: "human", ActorLabel: "erasure-test",
	}); err != nil {
		t.Fatalf("erase: %v", err)
	}
	var payload []byte
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("read tx: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT payload FROM outbox_events WHERE tenant_id = $1::uuid AND kind = $2`,
		tenantID, OutboxKindListmonkDelete).Scan(&payload); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read delete intent: %v", err)
	}
	_ = tx.Rollback(ctx)

	engine := listmonkv6.NewServer(t)
	engine.AddList(3, "Launch", "single")
	engine.SeedSubscriber(email, "", listmonkv6.StatusEnabled, nil, map[int64]string{3: listmonkv6.SubscriptionConfirmed})
	handler := &ListmonkDeleteHandler{
		Repo:     repo,
		Resolver: tenantScopedTestResolver{tenantID: tenantID, engine: listmonk.New(listmonk.Config{BaseURL: engine.URL})},
	}
	if err := handler.Handle(ctx, outbox.Event{TenantID: tenantID, Kind: OutboxKindListmonkDelete, Payload: payload}); err != nil {
		t.Fatalf("erasure reconciliation: %v", err)
	}
	if _, stillThere := engine.Subscriber(email); stillThere {
		t.Fatal("the erased address is still in Listmonk")
	}
}
