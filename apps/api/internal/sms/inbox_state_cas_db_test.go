// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func smsInboxStateRequest(
	t *testing.T,
	d *Deps,
	tenantID, phone, action string,
	body map[string]any,
) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/sms/conversations/"+phone+"/"+action,
		bytes.NewReader(raw),
	)
	req.Header.Set("Content-Type", "application/json")
	route := chi.NewRouteContext()
	route.URLParams.Add("phone", phone)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	ctx = middleware.WithActor(ctx, "system", "sms-inbox-cas-test")
	req = req.WithContext(ctx)
	recorder := httptest.NewRecorder()
	switch action {
	case "archive":
		d.ArchiveConversation(recorder, req)
	case "snooze":
		d.SnoozeConversation(recorder, req)
	default:
		t.Fatalf("unsupported test action %q", action)
	}
	return recorder
}

func smsInboxBulkStateRequest(
	t *testing.T,
	d *Deps,
	tenantID string,
	body map[string]any,
) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/sms/conversations/bulk",
		bytes.NewReader(raw),
	)
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	ctx = middleware.WithActor(ctx, "system", "sms-inbox-cas-test")
	req = req.WithContext(ctx)
	recorder := httptest.NewRecorder()
	d.BulkConversationAction(recorder, req)
	return recorder
}

func seedSMSInboxConversation(
	t *testing.T,
	pool *db.Pool,
	tenantID, phone string,
) {
	t.Helper()
	broadcastExec(t, context.Background(), pool, tenantID, `
INSERT INTO sms_messages (id, tenant_id, phone_e164, provider, direction, body, segments, status)
VALUES ($1::uuid, $2::uuid, $3, 'twilio', 'inbound', 'inbox CAS evidence', 1, 'received')`,
		broadcastUUID(t), tenantID, phone)
}

func TestSMSInboxLifecycleCASRejectsStaleWriteWithoutLeakingState(t *testing.T) {
	pool := broadcastDB(t)
	tenantID := createBroadcastTenant(t, context.Background(), pool)
	phone := "+15552340981"
	seedSMSInboxConversation(t, pool, tenantID, phone)
	d := &Deps{Store: &Store{Pool: pool}}

	first := smsInboxStateRequest(t, d, tenantID, phone, "archive", map[string]any{
		"expectedUpdatedAt": nil,
	})
	if first.Code != http.StatusOK {
		t.Fatalf("first archive status = %d: %s", first.Code, first.Body.String())
	}
	var receipt conversationStateMutationResponse
	if err := json.Unmarshal(first.Body.Bytes(), &receipt); err != nil {
		t.Fatalf("decode receipt: %v", err)
	}
	if !receipt.OK || receipt.Action != "archive" || receipt.ArchivedAt == nil ||
		receipt.StateUpdatedAt.IsZero() || receipt.TenantID != tenantID || receipt.PhoneE164 != phone {
		t.Fatalf("archive receipt = %#v", receipt)
	}

	stale := smsInboxStateRequest(t, d, tenantID, phone, "snooze", map[string]any{
		"expectedUpdatedAt": nil,
		"until":             time.Now().UTC().Add(8 * time.Hour),
	})
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale snooze status = %d, want 409: %s", stale.Code, stale.Body.String())
	}
	for _, secret := range []string{tenantID, phone, receipt.StateUpdatedAt.Format(time.RFC3339Nano)} {
		if bytes.Contains(stale.Body.Bytes(), []byte(secret)) {
			t.Fatalf("stale conflict leaked current inventory %q: %s", secret, stale.Body.String())
		}
	}

	var archivedAt, version time.Time
	var snoozeUntil *time.Time
	broadcastQueryRow(t, context.Background(), pool, tenantID, `
SELECT archived_at, snooze_until, lifecycle_updated_at
  FROM sms_conversation_state
 WHERE tenant_id=$1::uuid AND phone_e164=$2`,
		[]any{&archivedAt, &snoozeUntil, &version}, tenantID, phone)
	if snoozeUntil != nil || !version.Equal(receipt.StateUpdatedAt) || archivedAt.IsZero() {
		t.Fatalf("state changed after stale write: archived=%v snooze=%v version=%v", archivedAt, snoozeUntil, version)
	}
}

func TestSMSInboxLifecycleCASAllowsExactlyOneConcurrentFirstWriter(t *testing.T) {
	pool := broadcastDB(t)
	tenantID := createBroadcastTenant(t, context.Background(), pool)
	phone := "+15552340982"
	seedSMSInboxConversation(t, pool, tenantID, phone)
	d := &Deps{Store: &Store{Pool: pool}}

	start := make(chan struct{})
	statuses := make(chan int, 2)
	var wait sync.WaitGroup
	for _, action := range []string{"archive", "snooze"} {
		action := action
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			body := map[string]any{"expectedUpdatedAt": nil}
			if action == "snooze" {
				body["until"] = time.Now().UTC().Add(8 * time.Hour)
			}
			statuses <- smsInboxStateRequest(t, d, tenantID, phone, action, body).Code
		}()
	}
	close(start)
	wait.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("concurrent statuses = %#v, want one 200 and one 409", counts)
	}
}

func TestSMSInboxBulkLifecycleCASRollsBackEveryRowAndAuditOnStaleTarget(t *testing.T) {
	pool := broadcastDB(t)
	tenantID := createBroadcastTenant(t, context.Background(), pool)
	stalePhone := "+15552340983"
	freshPhone := "+15552340984"
	seedSMSInboxConversation(t, pool, tenantID, stalePhone)
	seedSMSInboxConversation(t, pool, tenantID, freshPhone)
	d := &Deps{Store: &Store{Pool: pool}}

	first := smsInboxStateRequest(t, d, tenantID, stalePhone, "archive", map[string]any{
		"expectedUpdatedAt": nil,
	})
	if first.Code != http.StatusOK {
		t.Fatalf("first archive status = %d: %s", first.Code, first.Body.String())
	}
	var firstReceipt conversationStateMutationResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstReceipt); err != nil {
		t.Fatalf("decode first receipt: %v", err)
	}

	staleBulk := smsInboxBulkStateRequest(t, d, tenantID, map[string]any{
		"action": "archive",
		"conversations": []map[string]any{
			{"phoneE164": freshPhone, "expectedUpdatedAt": nil},
			{"phoneE164": stalePhone, "expectedUpdatedAt": nil},
		},
	})
	if staleBulk.Code != http.StatusConflict {
		t.Fatalf("stale bulk status = %d, want 409: %s", staleBulk.Code, staleBulk.Body.String())
	}
	var freshStateRows, bulkAudits int
	broadcastQueryRow(t, context.Background(), pool, tenantID, `
SELECT COUNT(*)::int
  FROM sms_conversation_state
 WHERE tenant_id=$1::uuid AND phone_e164=$2`, []any{&freshStateRows}, tenantID, freshPhone)
	broadcastQueryRow(t, context.Background(), pool, tenantID, `
SELECT COUNT(*)::int
  FROM audit_log
 WHERE tenant_id=$1::uuid AND action='sms.inbox.bulk.archive'`, []any{&bulkAudits}, tenantID)
	if freshStateRows != 0 || bulkAudits != 0 {
		t.Fatalf("stale bulk was not atomic: fresh state rows=%d bulk audits=%d", freshStateRows, bulkAudits)
	}

	success := smsInboxBulkStateRequest(t, d, tenantID, map[string]any{
		"action": "archive",
		"conversations": []map[string]any{
			{"phoneE164": freshPhone, "expectedUpdatedAt": nil},
			{"phoneE164": stalePhone, "expectedUpdatedAt": firstReceipt.StateUpdatedAt.Format(time.RFC3339Nano)},
		},
	})
	if success.Code != http.StatusOK {
		t.Fatalf("current bulk status = %d: %s", success.Code, success.Body.String())
	}
	broadcastQueryRow(t, context.Background(), pool, tenantID, `
SELECT COUNT(*)::int
  FROM audit_log
 WHERE tenant_id=$1::uuid AND action='sms.inbox.bulk.archive'`, []any{&bulkAudits}, tenantID)
	if bulkAudits != 1 {
		t.Fatalf("successful bulk audits = %d, want exactly one aggregate audit", bulkAudits)
	}
}

func TestParseSMSInboxLifecycleExpectedVersionRequiresExplicitNullOrTimestamp(t *testing.T) {
	if _, err := parseLifecycleExpectedUpdatedAt(nil); err == nil {
		t.Fatal("omitted expectedUpdatedAt was accepted")
	}
	if version, err := parseLifecycleExpectedUpdatedAt(json.RawMessage("null")); err != nil || version != nil {
		t.Fatalf("explicit null = %v, %v", version, err)
	}
	if _, err := parseLifecycleExpectedUpdatedAt(json.RawMessage(`"not-a-time"`)); err == nil {
		t.Fatal("invalid expectedUpdatedAt was accepted")
	}
	const exact = `"2026-08-29T10:20:30.123456Z"`
	version, err := parseLifecycleExpectedUpdatedAt(json.RawMessage(exact))
	if err != nil || version == nil || version.UTC().Format(time.RFC3339Nano) != "2026-08-29T10:20:30.123456Z" {
		t.Fatalf("exact version = %v, %v", version, err)
	}
}
