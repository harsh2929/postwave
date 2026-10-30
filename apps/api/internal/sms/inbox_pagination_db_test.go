// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"testing"
	"time"
)

func TestListConversationsOldestUnreadUsesBoundaryAndStableTie(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	phoneA, phoneB, phoneC := "+15552341001", "+15552341002", "+15552341003"
	idAOld, idANew, idB, idC := broadcastUUID(t), broadcastUUID(t), broadcastUUID(t), broadcastUUID(t)
	boundary := time.Now().UTC().Add(-5 * time.Minute).Truncate(time.Microsecond)
	t1, t2, t3 := boundary.Add(-4*time.Minute), boundary.Add(-3*time.Minute), boundary.Add(-2*time.Minute)

	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_messages (id, tenant_id, phone_e164, provider, direction, body, segments, status, created_at, received_at)
VALUES
 ($1::uuid,$5::uuid,$6,'twilio','inbound','a-old',1,'received',$9,$9),
 ($2::uuid,$5::uuid,$6,'twilio','inbound','a-new',1,'received',$11,$11),
 ($3::uuid,$5::uuid,$7,'twilio','inbound','b',1,'received',$10,$10),
 ($4::uuid,$5::uuid,$8,'twilio','inbound','c',1,'received',$10,$10)`,
		idAOld, idANew, idB, idC, tenantID, phoneA, phoneB, phoneC, t1, t2, t3)

	key := []byte("route40-oldest-unread-db-key-32-bytes-minimum")
	binding := inboxCursorBinding(tenantID, "admin", string(FilterAll), string(SortOldestUnreadFirst), string(StatusActive), "")
	first, err := (&Store{Pool: pool}).ListConversations(ctx, tenantID, key,
		inboxCursorPosition{SnapshotAt: boundary}, binding, 2, FilterAll, SortOldestUnreadFirst, StatusActive, "")
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first.Conversations) != 2 || first.Conversations[0].PhoneE164 != phoneA || first.Conversations[1].PhoneE164 != phoneB {
		t.Fatalf("first order = %+v, want A(oldest), B(tie before C)", first.Conversations)
	}
	if first.Conversations[0].OldestUnreadAt == nil || !first.Conversations[0].OldestUnreadAt.Equal(t1) {
		t.Fatalf("A oldestUnreadAt = %v, want %v (not latest inbound %v)", first.Conversations[0].OldestUnreadAt, t1, t3)
	}
	if first.NextCursor == "" {
		t.Fatal("first page missing continuation")
	}

	// A receipt written after page one's boundary must not mutate the rank used
	// by an existing continuation. This is a time-bound contract, not a full
	// cross-request MVCC snapshot; late commits and mutable state remain explicit.
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_message_read_receipts (tenant_id,message_id,read_at)
VALUES ($1::uuid,$2::uuid,$3)`, tenantID, idAOld, boundary.Add(time.Minute))
	position, err := decodeInboxCursor([][]byte{key}, first.NextCursor, tenantID, "conversations", binding, time.Now().UTC())
	if err != nil {
		t.Fatalf("decode continuation: %v", err)
	}
	second, err := (&Store{Pool: pool}).ListConversations(ctx, tenantID, key,
		position, binding, 2, FilterAll, SortOldestUnreadFirst, StatusActive, "")
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second.Conversations) != 1 || second.Conversations[0].PhoneE164 != phoneC {
		t.Fatalf("second page = %+v, want C without tie repeat/skip", second.Conversations)
	}
}
