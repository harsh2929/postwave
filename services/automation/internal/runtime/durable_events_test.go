package runtime

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

func TestDurableEventHTTPRetryQueuesOneAutomationRun(t *testing.T) {
	resolver := NewMemoryResolver()
	resolver.PutAutomation(&canonical.Automation{
		ID:       "auto_1",
		TenantID: "tenant_1",
		Status:   "active",
		EntryID:  "entry",
		Triggers: []canonical.AutomationTrigger{{
			Type:      canonical.TriggerInboundWebhook,
			EventName: "order.paid",
		}},
		Nodes: []canonical.AutomationNode{{ID: "entry", Type: "wait"}},
	})
	store := NewMemoryStore()
	queue := NewMemoryQueue()
	engine := &Engine{Resolver: resolver, Store: store, Queue: queue}
	dispatcher := &EventDispatcher{Engine: engine, Lister: resolver}
	handler := dispatcher.HTTPHandler()
	const sourceID = "66666666-6666-4666-8666-666666666666"
	body := `{
		"tenant_id":"tenant_1",
		"subscriber_email":"a@example.com",
		"event_type":"inbound_webhook",
		"source_event_id":"` + sourceID + `",
		"payload":{"event_name":"order.paid"}
	}`
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/v1/automations/event", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", sourceID)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body)
		}
	}
	depth, err := queue.Depth(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if depth != 1 {
		t.Fatalf("durable event retry queued %d executions, want 1", depth)
	}
}

func TestDurableEventHTTPRequiresExactIdempotencyKey(t *testing.T) {
	dispatcher := &EventDispatcher{}
	req := httptest.NewRequest(http.MethodPost, "/v1/automations/event", strings.NewReader(`{
		"tenant_id":"tenant_1",
		"subscriber_email":"a@example.com",
		"event_type":"inbound_webhook",
		"source_event_id":"source-1"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "source-2")
	rec := httptest.NewRecorder()
	dispatcher.HTTPHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "idempotency_mismatch") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body)
	}
}

func TestTriggerDurableOldRetryDoesNotRewindAfterNewerRun(t *testing.T) {
	resolver := NewMemoryResolver()
	resolver.PutAutomation(&canonical.Automation{
		ID:           "auto_1",
		TenantID:     "tenant_1",
		Status:       "active",
		EntryID:      "entry",
		ReEnrollment: canonical.ReEnrollAlways,
		Triggers:     []canonical.AutomationTrigger{{Type: canonical.TriggerInboundWebhook}},
		Nodes:        []canonical.AutomationNode{{ID: "entry", Type: "wait"}},
	})
	store := NewMemoryStore()
	queue := NewMemoryQueue()
	engine := &Engine{Resolver: resolver, Store: store, Queue: queue}
	ctx := WithTenant(t.Context(), "tenant_1")

	if _, err := engine.TriggerDurable(ctx, "auto_1", canonical.TriggerInboundWebhook,
		"a@example.com", nil, "source-old"); err != nil {
		t.Fatal(err)
	}
	oldRunID := durableRunID("auto_1", "source-old")
	if err := store.MarkCompleted(ctx, "auto_1", "a@example.com", "entry", oldRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.TriggerDurable(ctx, "auto_1", canonical.TriggerInboundWebhook,
		"a@example.com", nil, "source-new"); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.TriggerDurable(ctx, "auto_1", canonical.TriggerInboundWebhook,
		"a@example.com", nil, "source-old"); err != nil {
		t.Fatal(err)
	}
	oldRun, err := store.Get(ctx, "auto_1", "a@example.com", oldRunID)
	if err != nil {
		t.Fatal(err)
	}
	if oldRun == nil {
		t.Fatal("old durable run disappeared")
	}
	if _, completed := oldRun.CompletedNodes["entry"]; !completed {
		t.Fatal("retrying an older source event rewound its completed run")
	}
}
