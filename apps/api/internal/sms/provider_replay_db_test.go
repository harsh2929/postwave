// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestRecordInboundProviderReplayIsSideEffectFreeAndContentBound(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_keyword_responses
    (tenant_id, keyword, response_body, action, enabled)
VALUES
    ($1::uuid, 'SAVE10', 'Use SAVE10 today.', 'reply_only', true)`, tenantID)

	store := &Store{Pool: pool}
	first, firstReply, duplicate, err := store.RecordInbound(
		ctx, tenantID, "", ProviderTelnyx, "+15552230001", "SAVE10", "provider-message-1",
		map[string]any{"provider_event_id": "provider-event-1"},
	)
	if err != nil {
		t.Fatalf("first inbound: %v", err)
	}
	if duplicate || !firstReply.Matched || firstReply.Body != "Use SAVE10 today." {
		t.Fatalf("first inbound = duplicate %v reply %+v", duplicate, firstReply)
	}

	second, secondReply, duplicate, err := store.RecordInbound(
		ctx, tenantID, "", ProviderTelnyx, "+15552230001", "SAVE10", "provider-message-1",
		map[string]any{"provider_event_id": "provider-event-1"},
	)
	if err != nil {
		t.Fatalf("exact replay: %v", err)
	}
	if !duplicate || second.ID != first.ID || secondReply.Matched || secondReply.Body != "" {
		t.Fatalf("exact replay = duplicate %v id %q reply %+v", duplicate, second.ID, secondReply)
	}

	if _, _, _, err := store.RecordInbound(
		ctx, tenantID, "", ProviderTelnyx, "+15552230001", "changed content", "provider-message-1", nil,
	); !errors.Is(err, ErrProviderReplayConflict) {
		t.Fatalf("identity reuse error = %v, want ErrProviderReplayConflict", err)
	}
	if _, _, _, err := store.RecordInbound(
		ctx, tenantID, "", ProviderTelnyx, "+15552230001", "SAVE10", "provider-message-1",
		map[string]any{"provider_event_id": "different-provider-event"},
	); !errors.Is(err, ErrProviderReplayConflict) {
		t.Fatalf("metadata identity reuse error = %v, want ErrProviderReplayConflict", err)
	}

	var messageCount int
	broadcastQueryRow(t, ctx, pool, tenantID, `
SELECT count(*)
FROM sms_messages
WHERE tenant_id = $1::uuid
  AND provider = 'telnyx'
  AND provider_message_id = 'provider-message-1'`, []any{&messageCount}, tenantID)
	if messageCount != 1 {
		t.Fatalf("provider replay rows = %d, want 1", messageCount)
	}
}

func TestRecordInboundConcurrentProviderRetriesRunKeywordOnce(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_keyword_responses
    (tenant_id, keyword, response_body, action, enabled)
VALUES
    ($1::uuid, 'SAVE20', 'Use SAVE20 today.', 'reply_only', true)`, tenantID)

	type outcome struct {
		id        string
		replied   bool
		duplicate bool
		err       error
	}
	const workers = 8
	outcomes := make(chan outcome, workers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	store := &Store{Pool: pool}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			message, reply, duplicate, err := store.RecordInbound(
				ctx, tenantID, "", ProviderBandwidth, "+15552230002", "SAVE20", "provider-message-concurrent", nil,
			)
			outcomes <- outcome{id: message.ID, replied: reply.Matched, duplicate: duplicate, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(outcomes)

	created, replied := 0, 0
	messageID := ""
	for result := range outcomes {
		if result.err != nil {
			t.Errorf("concurrent inbound: %v", result.err)
			continue
		}
		if !result.duplicate {
			created++
		}
		if result.replied {
			replied++
		}
		if messageID == "" {
			messageID = result.id
		} else if result.id != messageID {
			t.Errorf("concurrent retries returned different rows: %q != %q", result.id, messageID)
		}
	}
	if created != 1 || replied != 1 {
		t.Fatalf("concurrent retries created=%d keyword_replies=%d, want 1/1", created, replied)
	}
}
