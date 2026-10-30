// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// User offboarding must remove nullable operator attribution without deleting
// the tenant's SMS evidence or attempting to null the composite tenant key.
func TestSMSTenantUserReferencesSetOnlyActorColumnNull(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	userID := broadcastUUID(t)
	messageID := broadcastUUID(t)
	quickReplyID := broadcastUUID(t)
	phone := "+15552340987"

	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO users (id, tenant_id, email, role, status)
VALUES ($1::uuid, $2::uuid, $3, 'admin', 'active')`,
		userID, tenantID, "sms-actor-"+userID[:8]+"@example.test")
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_messages (id, tenant_id, phone_e164, provider, direction, body, segments, status)
VALUES ($1::uuid, $2::uuid, $3, 'twilio', 'inbound', 'evidence survives actor deletion', 1, 'received')`,
		messageID, tenantID, phone)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_conversation_state
       (tenant_id, phone_e164, assignee_user_id, notes, lifecycle_updated_at)
VALUES ($1::uuid, $2, $3::uuid, 'state survives', clock_timestamp())`, tenantID, phone, userID)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_conversation_tags (tenant_id, phone_e164, tag, created_by)
VALUES ($1::uuid, $2, 'priority', $3::uuid)`, tenantID, phone, userID)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_quick_replies (id, tenant_id, label, body, created_by)
VALUES ($1::uuid, $2::uuid, 'Greeting', 'Hello', $3::uuid)`, quickReplyID, tenantID, userID)

	broadcastExec(t, ctx, pool, tenantID, `DELETE FROM users WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, userID)

	var messageCount, stateCount, tagCount, quickCount int
	var assigneeCleared, tagCreatorCleared, quickCreatorCleared bool
	broadcastQueryRow(t, ctx, pool, tenantID, `
SELECT
  (SELECT count(*) FROM sms_messages WHERE tenant_id=$1::uuid AND id=$2::uuid),
  (SELECT count(*) FROM sms_conversation_state WHERE tenant_id=$1::uuid AND phone_e164=$3),
  (SELECT count(*) FROM sms_conversation_tags WHERE tenant_id=$1::uuid AND phone_e164=$3),
  (SELECT count(*) FROM sms_quick_replies WHERE tenant_id=$1::uuid AND id=$4::uuid),
  (SELECT assignee_user_id IS NULL FROM sms_conversation_state WHERE tenant_id=$1::uuid AND phone_e164=$3),
  (SELECT created_by IS NULL FROM sms_conversation_tags WHERE tenant_id=$1::uuid AND phone_e164=$3),
  (SELECT created_by IS NULL FROM sms_quick_replies WHERE tenant_id=$1::uuid AND id=$4::uuid)`,
		[]any{&messageCount, &stateCount, &tagCount, &quickCount, &assigneeCleared, &tagCreatorCleared, &quickCreatorCleared},
		tenantID, messageID, phone, quickReplyID)
	if messageCount != 1 || stateCount != 1 || tagCount != 1 || quickCount != 1 {
		t.Fatalf("SMS evidence was deleted with actor: messages=%d state=%d tags=%d quick=%d", messageCount, stateCount, tagCount, quickCount)
	}
	if !assigneeCleared || !tagCreatorCleared || !quickCreatorCleared {
		t.Fatalf("actor attribution not cleared: assignee=%v tag=%v quick=%v", assigneeCleared, tagCreatorCleared, quickCreatorCleared)
	}
}

func TestSMSTenantSocialCaptureReferencesRejectCrossTenantIDs(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantA := createBroadcastTenant(t, ctx, pool)
	tenantB := createBroadcastTenant(t, ctx, pool)
	foreignList := createSMSList(t, ctx, pool, tenantB, "foreign-list")
	foreignSender := createSMSSender(t, ctx, pool, tenantB)

	assertFK := func(name, statement string, args ...any) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantA)
		if err != nil {
			t.Fatalf("%s WithTenant: %v", name, err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, err = tx.Exec(ctx, statement, args...)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
			t.Fatalf("%s error = %v, want foreign_key_violation", name, err)
		}
	}

	assertFK("social rule", `
INSERT INTO social_auto_reply_rules (tenant_id, name, sms_list_id, sender_profile_id)
VALUES ($1::uuid, 'cross-tenant poison', $2::uuid, $3::uuid)`, tenantA, foreignList, foreignSender)
	assertFK("tap link", `
INSERT INTO tap_to_text_links (tenant_id, slug, name, sms_list_id, sender_profile_id)
VALUES ($1::uuid, $2, 'cross-tenant poison', $3::uuid, $4::uuid)`,
		tenantA, "cross-tenant-"+broadcastUUID(t)[:8], foreignList, foreignSender)
}
