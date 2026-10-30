// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func TestSetAccountRequiresExactIfMatchBeforeDatabase(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, header := range []string{"", "*", `W/"subscriber:s:v1"`, `"subscriber:s:v1", "subscriber:s:v2"`} {
		req := subscriberTenantRequest(http.MethodPatch, "/api/v1/subscribers/s/account", `{"account_id":null}`)
		if header != "" {
			req.Header.Set("If-Match", header)
		}
		rec := httptest.NewRecorder()
		d.SetAccount(rec, req)
		if rec.Code != http.StatusPreconditionRequired {
			t.Fatalf("If-Match %q status=%d body=%s, want 428", header, rec.Code, rec.Body.String())
		}
	}
}

func TestAccountLinkIsRevisionBoundAuditedAndEngineDurable(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	ctx := context.Background()
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate("account-link-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("account seed scope: %v", err)
	}
	var accountID string
	if err := seed.QueryRow(ctx, `
INSERT INTO accounts (tenant_id, name)
VALUES ($1::uuid, 'Exact revision account')
RETURNING id::text`, tenantID).Scan(&accountID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed account: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit account seed: %v", err)
	}
	webhooks := &recordingSubscriberWebhook{}
	repo.Webhooks = webhooks
	meta := db.AuditMeta{ActorType: "human", ActorLabel: "account-link-db-test"}

	linked, err := repo.SetAccount(ctx, tenantID, sub.ID, &accountID, sub.Version, meta)
	if err != nil {
		t.Fatalf("link account: %v", err)
	}
	if linked.AccountID == nil || *linked.AccountID != accountID || linked.Version == sub.Version {
		t.Fatalf("link did not advance exact state: before=%#v after=%#v", sub, linked)
	}
	if _, err := repo.SetAccount(ctx, tenantID, sub.ID, nil, sub.Version, meta); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale unlink error=%v, want ErrPreconditionFailed", err)
	}
	unlinked, err := repo.SetAccount(ctx, tenantID, sub.ID, nil, linked.Version, meta)
	if err != nil {
		t.Fatalf("unlink account: %v", err)
	}
	if unlinked.AccountID != nil || unlinked.Version == linked.Version {
		t.Fatalf("unlink did not advance exact state: before=%#v after=%#v", linked, unlinked)
	}
	if len(webhooks.events) != 2 {
		t.Fatalf("account-link webhook events=%v, want two", webhooks.events)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify scope: %v", err)
	}
	var audits, intents int
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND resource_id = $2
   AND action = 'subscriber.account_link_changed'`, tenantID, sub.ID).Scan(&audits); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read account-link audits: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2
   AND payload ->> 'subscriber_id' = $3`, tenantID, OutboxKindListmonkSync, sub.ID).Scan(&intents); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read account-link intents: %v", err)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit verification: %v", err)
	}
	if audits != 2 || intents != 3 {
		t.Fatalf("account-link side effects audits=%d intents=%d, want 2/3 including create", audits, intents)
	}

	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{err: errors.New("forced account-link outbox failure")}
	if _, err := repo.SetAccount(ctx, tenantID, sub.ID, &accountID, unlinked.Version, meta); err == nil || !strings.Contains(err.Error(), "engine sync intent") {
		t.Fatalf("account-link outbox failure=%v", err)
	}
	unchanged, err := repo.Get(ctx, tenantID, sub.ID)
	if err != nil {
		t.Fatalf("read rollback state: %v", err)
	}
	if unchanged.AccountID != nil || unchanged.Version != unlinked.Version {
		t.Fatalf("failed account link escaped rollback: before=%#v after=%#v", unlinked, unchanged)
	}
}
