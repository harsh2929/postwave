// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testInboundTrigger() Trigger {
	expected := "paid"
	return Trigger{
		ID:             "11111111-1111-4111-8111-111111111111",
		TenantID:       "22222222-2222-4222-8222-222222222222",
		WebhookID:      "33333333-3333-4333-8333-333333333333",
		Name:           "Paid order",
		Active:         true,
		MatchJSONPath:  "$.status",
		MatchOperator:  OpEquals,
		MatchValue:     &expected,
		EmailJSONPath:  "$.customer.email",
		ActionType:     ActionAddTag,
		ActionTargetID: "customer",
	}
}

func TestPlanOneTriggerFreezesExecutableSnapshot(t *testing.T) {
	trigger := testInboundTrigger()
	payload := map[string]any{
		"status": "paid",
		"customer": map[string]any{
			"email": " CUSTOMER@Example.COM ",
		},
	}
	plan, matched := planOneTrigger(trigger, payload)
	if !matched {
		t.Fatal("matching trigger was skipped")
	}
	if plan.initialState != ActionIntentPending || plan.subscriberEmail == nil ||
		*plan.subscriberEmail != "customer@example.com" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if !plan.match.Queued || plan.match.Executed {
		t.Fatalf("match queue semantics = %+v", plan.match)
	}

	// Mutating the live config after planning cannot rewrite the snapshot.
	trigger.ActionTargetID = "changed-later"
	if got := *plan.actionTargetID; got != "customer" {
		t.Fatalf("snapshotted target changed to %q", got)
	}
}

func TestPlanOneTriggerPersistsSafeTerminalMisconfiguration(t *testing.T) {
	trigger := testInboundTrigger()
	trigger.EmailJSONPath = "$.missing"
	plan, matched := planOneTrigger(trigger, map[string]any{"status": "paid"})
	if !matched {
		t.Fatal("condition match should remain observable when email resolution fails")
	}
	if plan.initialState != ActionIntentFailed ||
		plan.errorCode != "trigger_email_path_missing" ||
		plan.subscriberEmail != nil {
		t.Fatalf("unexpected failed plan: %+v", plan)
	}
	if strings.Contains(plan.match.Error, "@") {
		t.Fatalf("error unexpectedly retained an email: %q", plan.match.Error)
	}
}

func TestPlanOneTriggerBoundsSnapshotFields(t *testing.T) {
	trigger := testInboundTrigger()
	trigger.Name = strings.Repeat("é", 300)
	trigger.ActionTargetID = strings.Repeat("x", maxActionTargetBytes+1)
	plan, matched := planOneTrigger(trigger, map[string]any{
		"status":   "paid",
		"customer": map[string]any{"email": "a@example.com"},
	})
	if !matched || plan.initialState != ActionIntentFailed ||
		plan.errorCode != "trigger_target_invalid" {
		t.Fatalf("unexpected oversized-target plan: %+v matched=%v", plan, matched)
	}
	if plan.triggerName == nil || len(*plan.triggerName) > maxTriggerNameBytes {
		t.Fatalf("trigger name was not bounded: %q", valueOrEmpty(plan.triggerName))
	}
	if !json.Valid([]byte(`"` + *plan.triggerName + `"`)) {
		t.Fatalf("bounded trigger name is not valid UTF-8/JSON: %q", *plan.triggerName)
	}
}

func TestActionWorkerAutomationEventUsesStableIdentity(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/automations/event" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "44444444-4444-4444-8444-444444444444" {
			t.Errorf("Idempotency-Key = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if body["source_event_id"] != r.Header.Get("Idempotency-Key") {
			t.Errorf("source_event_id/header mismatch: %#v", body)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(server.Close)

	worker := &ActionWorker{AutomationServiceURL: server.URL}
	action := ActionIntent{
		ID:              "44444444-4444-4444-8444-444444444444",
		TenantID:        "22222222-2222-4222-8222-222222222222",
		EndpointID:      "33333333-3333-4333-8333-333333333333",
		IntentKind:      ActionIntentAutomationEvent,
		SubscriberEmail: stringPointer("a@example.com"),
		Body:            []byte(`{"event":"order.created","email":"a@example.com"}`),
		OccurredAt:      time.Unix(1_800_000_000, 0).UTC(),
	}
	if err := worker.execute(t.Context(), action); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestActionWorkerHTTPFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		status    int
		permanent bool
	}{
		{status: http.StatusBadRequest, permanent: true},
		{status: http.StatusTooManyRequests, permanent: false},
		{status: http.StatusServiceUnavailable, permanent: false},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "do not persist this body", tc.status)
			}))
			defer server.Close()
			worker := &ActionWorker{AutomationServiceURL: server.URL}
			err := worker.execute(t.Context(), ActionIntent{
				ID:              "44444444-4444-4444-8444-444444444444",
				TenantID:        "22222222-2222-4222-8222-222222222222",
				EndpointID:      "33333333-3333-4333-8333-333333333333",
				IntentKind:      ActionIntentAutomationEvent,
				SubscriberEmail: stringPointer("a@example.com"),
				Body:            []byte(`{"email":"a@example.com"}`),
				OccurredAt:      time.Now().UTC(),
			})
			code, status, permanent := classifyActionError(err)
			if status != tc.status || permanent != tc.permanent ||
				code != "automation_http_"+httpStatusString(tc.status) {
				t.Fatalf("classification = %q/%d/%v, want status=%d permanent=%v",
					code, status, permanent, tc.status, tc.permanent)
			}
		})
	}
}

func TestProductActionExecutorPropagatesStableAutomationIdentity(t *testing.T) {
	const actionID = "55555555-5555-4555-8555-555555555555"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Idempotency-Key"); got != actionID {
			t.Errorf("Idempotency-Key = %q", got)
		}
		if got := r.Header.Get("X-Tenant-Id"); got != "tenant-1" {
			t.Errorf("X-Tenant-Id = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		if body["source_event_id"] != actionID || body["automation_id"] != "automation-1" {
			t.Errorf("unexpected body: %#v", body)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(server.Close)
	executor := &ProductActionExecutor{AutomationServiceURL: server.URL}
	if err := executor.ExecuteDurableAction(
		t.Context(),
		actionID,
		"tenant-1",
		ActionStartAutomation,
		"automation-1",
		"a@example.com",
	); err != nil {
		t.Fatalf("ExecuteDurableAction: %v", err)
	}
}

func TestActionRetryDelayIsBounded(t *testing.T) {
	if got := actionRetryDelay(1); got != 5*time.Second {
		t.Fatalf("first delay = %v", got)
	}
	if got := actionRetryDelay(1000); got != time.Hour {
		t.Fatalf("capped delay = %v", got)
	}
	if maxActionAttempts < 2 || shouldExhaustActionRetry(maxActionAttempts-1) ||
		!shouldExhaustActionRetry(maxActionAttempts) {
		t.Fatalf("retry exhaustion boundary is not finite at %d attempts", maxActionAttempts)
	}
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func httpStatusString(status int) string {
	return strconv.Itoa(status)
}
