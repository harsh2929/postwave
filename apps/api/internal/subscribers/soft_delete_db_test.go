// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func TestArchiveStateIsRevisionBoundAuditedAndEngineDurable(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	ctx := context.Background()
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate("archive-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	webhooks := &recordingSubscriberWebhook{}
	repo.Webhooks = webhooks
	auditMeta := db.AuditMeta{ActorType: "human", ActorLabel: "archive-db-test"}

	archived, err := repo.Archive(ctx, tenantID, sub.ID, sub.Version, auditMeta)
	if err != nil {
		t.Fatalf("archive: %v", err)
	}
	if archived.ArchivedAt == nil || archived.Version == "" || archived.Version == sub.Version {
		t.Fatalf("archive did not advance exact state: before=%#v after=%#v", sub, archived)
	}
	if _, err := repo.Unarchive(ctx, tenantID, sub.ID, sub.Version, auditMeta); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale unarchive error = %v, want ErrPreconditionFailed", err)
	}
	restored, err := repo.Unarchive(ctx, tenantID, sub.ID, archived.Version, auditMeta)
	if err != nil {
		t.Fatalf("unarchive: %v", err)
	}
	if restored.ArchivedAt != nil || restored.Version == archived.Version {
		t.Fatalf("unarchive did not advance exact state: before=%#v after=%#v", archived, restored)
	}
	if len(webhooks.events) != 2 || webhooks.events[0] != EventSubscriberUpdated || webhooks.events[1] != EventSubscriberUpdated {
		t.Fatalf("archive webhook events = %v, want two subscriber.updated intents", webhooks.events)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify scope: %v", err)
	}
	var audits, intents int
	if err := verify.QueryRow(ctx, `
SELECT count(*)
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND resource_id = $2
   AND action IN ('subscriber.archived', 'subscriber.unarchived')`, tenantID, sub.ID).Scan(&audits); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read archive audits: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT count(*)
  FROM outbox_events
 WHERE tenant_id = $1::uuid
   AND kind = $2
   AND payload ->> 'subscriber_id' = $3`, tenantID, OutboxKindListmonkSync, sub.ID).Scan(&intents); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read engine intents: %v", err)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit verification: %v", err)
	}
	if audits != 2 || intents != 3 {
		t.Fatalf("archive side effects audits=%d intents=%d, want 2/3 including create sync", audits, intents)
	}

	// A mandatory outbox failure must roll back the archive marker, version,
	// webhook, and audit rather than leaving local and delivery state split.
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{err: errors.New("forced archive outbox failure")}
	if _, err := repo.Archive(ctx, tenantID, sub.ID, restored.Version, auditMeta); err == nil || !strings.Contains(err.Error(), "engine sync intent") {
		t.Fatalf("archive outbox failure = %v", err)
	}
	unchanged, err := repo.Get(ctx, tenantID, sub.ID)
	if err != nil {
		t.Fatalf("read rollback state: %v", err)
	}
	if unchanged.ArchivedAt != nil || unchanged.Version != restored.Version {
		t.Fatalf("failed archive escaped rollback: restored=%#v after=%#v", restored, unchanged)
	}
	if len(webhooks.events) != 2 {
		t.Fatalf("failed archive emitted webhook: %v", webhooks.events)
	}
}
