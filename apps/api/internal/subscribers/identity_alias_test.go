// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func TestAliasMutationsRequireOneExactStrongIfMatchBeforeDatabase(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		for _, header := range []string{"", "*", `W/"subscriber:s:v1"`, `"subscriber:s:v1", "subscriber:s:v2"`} {
			req := subscriberTenantRequest(method, "/api/v1/subscribers/s/aliases/a", `{"alias_type":"custom","alias_value":"value"}`)
			if header != "" {
				req.Header.Set("If-Match", header)
			}
			rec := httptest.NewRecorder()
			if method == http.MethodPost {
				d.UpsertAlias(rec, req)
			} else {
				d.DeleteAlias(rec, req)
			}
			if rec.Code != http.StatusPreconditionRequired || !strings.Contains(rec.Body.String(), "precondition_required") {
				t.Fatalf("%s If-Match %q status/body=%d %s, want 428", method, header, rec.Code, rec.Body.String())
			}
		}
	}
}

func TestAliasContactMethodsCannotBypassVerifiedWorkflows(t *testing.T) {
	for _, aliasType := range []string{"email", "phone"} {
		in := AliasInput{AliasType: aliasType, AliasValue: "contact-value"}
		err := normalizeAliasInput(&in)
		if !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), "workflow") {
			t.Fatalf("normalize %s error=%v, want safe workflow validation", aliasType, err)
		}
	}
}

func TestAliasMutationIsRevisionBoundCollisionSafeAuditedAndDurable(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	ctx := context.Background()
	first, err := repo.Upsert(ctx, tenantID, writePathCreate("alias-first-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed first subscriber: %v", err)
	}
	second, err := repo.Upsert(ctx, tenantID, writePathCreate("alias-second-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed second subscriber: %v", err)
	}
	webhooks := &recordingSubscriberWebhook{}
	repo.Webhooks = webhooks
	meta := db.AuditMeta{ActorType: "human", ActorLabel: "identity-alias-db-test"}
	input := AliasInput{
		AliasType:  "external_id",
		AliasValue: "crm-" + uuid.NewString(),
		Source:     "desktop",
		Provenance: map[string]any{"surface": "test"},
	}

	saved, err := repo.UpsertAlias(ctx, tenantID, first.ID, input, first.Version, meta)
	if err != nil {
		t.Fatalf("save alias: %v", err)
	}
	if saved.SubscriberID != first.ID || saved.SubscriberVersion == "" || saved.SubscriberVersion == first.Version || saved.ExternalID == nil || *saved.ExternalID != input.AliasValue {
		t.Fatalf("saved alias did not return one fresh parent state: %#v", saved)
	}
	if _, err := repo.UpsertAlias(ctx, tenantID, first.ID, AliasInput{AliasType: "custom", AliasValue: "stale-write"}, first.Version, meta); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale alias write error=%v, want ErrPreconditionFailed", err)
	}
	if _, err := repo.UpsertAlias(ctx, tenantID, second.ID, input, second.Version, meta); !errors.Is(err, ErrAliasOwnedByAnotherProfile) {
		t.Fatalf("cross-profile alias claim error=%v, want ErrAliasOwnedByAnotherProfile", err)
	}
	secondAfterCollision, err := repo.Get(ctx, tenantID, second.ID)
	if err != nil {
		t.Fatalf("read collision loser: %v", err)
	}
	if secondAfterCollision.Version != second.Version || secondAfterCollision.ExternalID != nil {
		t.Fatalf("collision mutated losing profile: before=%#v after=%#v", second, secondAfterCollision)
	}

	deleted, err := repo.DeleteAlias(ctx, tenantID, first.ID, saved.ID, saved.SubscriberVersion, meta)
	if err != nil {
		t.Fatalf("delete alias: %v", err)
	}
	if !deleted.Deleted || deleted.SubscriberVersion == saved.SubscriberVersion || deleted.ExternalID != nil {
		t.Fatalf("alias deletion did not advance/clear canonical external id: %#v", deleted)
	}
	if _, err := repo.DeleteAlias(ctx, tenantID, first.ID, saved.ID, saved.SubscriberVersion, meta); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale alias deletion error=%v, want ErrPreconditionFailed", err)
	}
	if len(webhooks.events) != 2 || webhooks.events[0] != EventSubscriberUpdated || webhooks.events[1] != EventSubscriberUpdated {
		t.Fatalf("alias webhooks=%v, want two subscriber.updated events", webhooks.events)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify scope: %v", err)
	}
	var changes, deletions int
	if err := verify.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE action = 'subscriber.alias_changed'),
       count(*) FILTER (WHERE action = 'subscriber.alias_deleted')
  FROM audit_log
 WHERE tenant_id = $1::uuid AND metadata ->> 'subscriber_id' = $2`, tenantID, first.ID).Scan(&changes, &deletions); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read alias audits: %v", err)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit audit verification: %v", err)
	}
	if changes != 1 || deletions != 1 {
		t.Fatalf("alias audit counts changed/deleted=%d/%d, want 1/1", changes, deletions)
	}

	// The alias row, parent revision, webhook, and audit are one atomic unit.
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{err: errors.New("forced alias outbox failure")}
	rollbackInput := AliasInput{AliasType: "custom", AliasValue: "rollback-" + uuid.NewString(), Source: "desktop"}
	if _, err := repo.UpsertAlias(ctx, tenantID, first.ID, rollbackInput, deleted.SubscriberVersion, meta); err == nil || !strings.Contains(err.Error(), "engine sync intent") {
		t.Fatalf("alias outbox failure=%v", err)
	}
	unchanged, err := repo.Get(ctx, tenantID, first.ID)
	if err != nil {
		t.Fatalf("read rollback state: %v", err)
	}
	if unchanged.Version != deleted.SubscriberVersion || unchanged.ExternalID != nil {
		t.Fatalf("failed alias write escaped rollback: before=%#v after=%#v", deleted, unchanged)
	}
	items, version, err := repo.ListAliases(ctx, tenantID, first.ID)
	if err != nil {
		t.Fatalf("list aliases after rollback: %v", err)
	}
	if version != deleted.SubscriberVersion || len(items) != 0 {
		t.Fatalf("rollback alias leaked: version=%q items=%#v", version, items)
	}
}

func TestConcurrentAliasClaimHasExactlyOneOwner(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	first, err := repo.Upsert(ctx, tenantID, writePathCreate("alias-race-first-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed first subscriber: %v", err)
	}
	second, err := repo.Upsert(ctx, tenantID, writePathCreate("alias-race-second-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed second subscriber: %v", err)
	}
	value := "shared-" + uuid.NewString()
	meta := db.AuditMeta{ActorType: "human", ActorLabel: "alias-race-test"}
	type result struct {
		owner string
		err   error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, sub := range []*Subscriber{first, second} {
		sub := sub
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := repo.UpsertAlias(ctx, tenantID, sub.ID, AliasInput{AliasType: "custom", AliasValue: value, Source: "desktop"}, sub.Version, meta)
			results <- result{owner: sub.ID, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	winners, conflicts := 0, 0
	winningID := ""
	for got := range results {
		switch {
		case got.err == nil:
			winners++
			winningID = got.owner
		case errors.Is(got.err, ErrAliasOwnedByAnotherProfile):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent alias claim error: %v", got.err)
		}
	}
	if winners != 1 || conflicts != 1 {
		t.Fatalf("concurrent alias outcome winners/conflicts=%d/%d, want 1/1", winners, conflicts)
	}
	items, _, err := repo.ListAliases(ctx, tenantID, winningID)
	if err != nil {
		t.Fatalf("list winning aliases: %v", err)
	}
	if len(items) != 1 || items[0].AliasValue != value || items[0].SubscriberID != winningID {
		t.Fatalf("winning alias ownership=%#v, want exactly %s", items, winningID)
	}
}
