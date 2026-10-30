package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/runtime"
)

func TestCreateBehavioralTriggerAppendsExecutableTrigger(t *testing.T) {
	resolver := runtime.NewMemoryResolver()
	resolver.PutAutomation(&canonical.Automation{
		ID:       "auto_1",
		TenantID: "tenant_1",
		Name:     "Welcome",
		Status:   "active",
	})
	r := chi.NewRouter()
	Register(r, &Handlers{Triggers: resolver})
	req := httptest.NewRequest(http.MethodPost, "/v1/automations/auto_1/behavioral-triggers", strings.NewReader(`{
		"trigger_type": "link_clicked",
		"campaign_id": "cmp_123",
		"url_pattern": "pricing",
		"within_days": 14
	}`))
	req.Header.Set("X-Tenant-Id", "tenant_1")
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out behavioralTriggerResp
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.AutomationID != "auto_1" || out.TriggerType != "link_clicked" || out.ID == "" || out.CreatedAt == "" {
		t.Fatalf("unexpected response: %+v", out)
	}
	auto, err := resolver.LookupAutomation(runtime.WithTenant(req.Context(), "tenant_1"), "auto_1")
	if err != nil {
		t.Fatalf("lookup automation: %v", err)
	}
	if len(auto.Triggers) != 1 {
		t.Fatalf("triggers len = %d", len(auto.Triggers))
	}
	if got := auto.Triggers[0].Type; got != runtime.TriggerClickedLink {
		t.Fatalf("trigger type = %q", got)
	}
}

func TestCreateBehavioralTriggerRejectsUnsupportedNegativeTriggers(t *testing.T) {
	resolver := runtime.NewMemoryResolver()
	resolver.PutAutomation(&canonical.Automation{ID: "auto_1", TenantID: "tenant_1"})
	r := chi.NewRouter()
	Register(r, &Handlers{Triggers: resolver})
	req := httptest.NewRequest(http.MethodPost, "/v1/automations/auto_1/behavioral-triggers", strings.NewReader(`{
		"trigger_type": "no_activity"
	}`))
	req.Header.Set("X-Tenant-Id", "tenant_1")
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCreateBehavioralTriggerRejectsOversizedBody(t *testing.T) {
	r := chi.NewRouter()
	Register(r, &Handlers{Triggers: runtime.NewMemoryResolver()})
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/automations/auto_1/behavioral-triggers",
		strings.NewReader(`{"trigger_type":"link_clicked","url_pattern":"`+strings.Repeat("x", int(automationJSONMaxBodyBytes))+`"}`),
	)
	req.Header.Set("X-Tenant-Id", "tenant_1")
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestTriggerDurableRequiresMatchingIdentityAndDeduplicatesRetry(t *testing.T) {
	resolver := runtime.NewMemoryResolver()
	resolver.PutAutomation(&canonical.Automation{
		ID:       "auto_1",
		TenantID: "tenant_1",
		Name:     "Inbound",
		Status:   "active",
		EntryID:  "entry",
		Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerInboundWebhook}},
		Nodes:    []canonical.AutomationNode{{ID: "entry", Type: "wait"}},
	})
	store := runtime.NewMemoryStore()
	queue := runtime.NewMemoryQueue()
	engine := &runtime.Engine{Resolver: resolver, Store: store, Queue: queue}
	router := chi.NewRouter()
	Register(router, &Handlers{Engine: engine, Store: store, Queue: queue})

	const sourceID = "55555555-5555-4555-8555-555555555555"
	send := func(headerID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/automations/trigger", strings.NewReader(`{
			"automation_id":"auto_1",
			"trigger_type":"inbound_webhook",
			"subscriber_email":"a@example.com",
			"source_event_id":"`+sourceID+`",
			"payload":{"source":"inbound_webhook"}
		}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Tenant-Id", "tenant_1")
		req.Header.Set("Idempotency-Key", headerID)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if rec := send("different"); rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatched identity status=%d body=%s", rec.Code, rec.Body)
	}
	for i := 0; i < 2; i++ {
		if rec := send(sourceID); rec.Code != http.StatusAccepted {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body)
		}
	}
	depth, err := queue.Depth(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if depth != 1 {
		t.Fatalf("durable retry queued %d executions, want 1", depth)
	}
}
