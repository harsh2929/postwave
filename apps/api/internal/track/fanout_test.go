// SPDX-License-Identifier: AGPL-3.0-only
package track

// Smoke test for the source-event → flow_runs fan-out path. Mocks the
// flowbuilder.RunEnqueuer surface so we can exercise the goroutine without
// Postgres, then asserts the enqueue happened exactly once per matching
// flow and that a panic in one flow does not poison the rest.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type fakeEnqueuer struct {
	mu sync.Mutex

	matchEventName string
	matches        []flowbuilder.TriggerMatch
	matchErr       error

	enqueued     []flowbuilder.RunEnqueueRequest
	panicOnFlow  string
	failOnFlow   string
	enqueueCalls int
}

func (f *fakeEnqueuer) MatchFlowsForEvent(_ context.Context, _, eventName string) ([]flowbuilder.TriggerMatch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.matchEventName = eventName
	if f.matchErr != nil {
		return nil, f.matchErr
	}
	return f.matches, nil
}

func (f *fakeEnqueuer) EnqueueRun(_ context.Context, tenantID string, req flowbuilder.RunEnqueueRequest) (*flowbuilder.FlowRunRecord, error) {
	f.mu.Lock()
	f.enqueueCalls++
	if req.FlowID == f.panicOnFlow {
		f.mu.Unlock()
		panic("simulated flow-run enqueue panic")
	}
	f.enqueued = append(f.enqueued, req)
	failed := f.failOnFlow != "" && f.failOnFlow == req.FlowID
	f.mu.Unlock()
	if failed {
		return nil, errors.New("simulated enqueue failure")
	}
	return &flowbuilder.FlowRunRecord{
		ID:               "run-" + req.FlowID,
		TenantID:         tenantID,
		FlowID:           req.FlowID,
		SubscriberID:     req.SubscriberID,
		TriggerEventID:   req.TriggerEventID,
		TriggerEventName: req.TriggerEventName,
		Status:           "queued",
		ScheduledAt:      req.ScheduledAt,
	}, nil
}

func TestFanoutFlowRuns_EnqueuesEveryMatch(t *testing.T) {
	fake := &fakeEnqueuer{
		matches: []flowbuilder.TriggerMatch{
			{FlowID: "flow-a", FlowName: "Welcome"},
			{FlowID: "flow-b", FlowName: "Onboarding"},
		},
	}
	d := &Deps{FlowRuns: fake}
	d.fanoutFlowRuns("tenant-1", "sub-9", 42, "placed_order", time.Now())

	if got, want := fake.matchEventName, "placed_order"; got != want {
		t.Fatalf("match event = %q, want %q", got, want)
	}
	if got, want := len(fake.enqueued), 2; got != want {
		t.Fatalf("enqueued count = %d, want %d", got, want)
	}
	ids := map[string]bool{}
	for _, req := range fake.enqueued {
		ids[req.FlowID] = true
		if req.SubscriberID != "sub-9" {
			t.Errorf("subscriber = %q, want sub-9", req.SubscriberID)
		}
		if req.TriggerEventID == nil || *req.TriggerEventID != 42 {
			t.Errorf("trigger_event_id = %v, want 42", req.TriggerEventID)
		}
		if req.TriggerEventName != "placed_order" {
			t.Errorf("trigger_event_name = %q, want placed_order", req.TriggerEventName)
		}
	}
	if !ids["flow-a"] || !ids["flow-b"] {
		t.Fatalf("missing flow ids: %v", ids)
	}
}

func TestFanoutFlowRuns_RecoversFromPanic(t *testing.T) {
	fake := &fakeEnqueuer{
		panicOnFlow: "flow-bad",
		matches: []flowbuilder.TriggerMatch{
			{FlowID: "flow-bad"},
			{FlowID: "flow-good"},
		},
	}
	d := &Deps{FlowRuns: fake}
	// Should not panic — the per-flow recover must isolate flow-bad.
	d.fanoutFlowRuns("tenant-1", "sub-9", 1, "x", time.Now())

	if fake.enqueueCalls != 2 {
		t.Fatalf("enqueueCalls = %d, want 2 (the bad one panicked, the good one ran)", fake.enqueueCalls)
	}
	if len(fake.enqueued) != 1 || fake.enqueued[0].FlowID != "flow-good" {
		t.Fatalf("expected exactly flow-good to be enqueued, got %#v", fake.enqueued)
	}
}

func TestFanoutFlowRuns_NoMatchesIsNoop(t *testing.T) {
	fake := &fakeEnqueuer{}
	d := &Deps{FlowRuns: fake}
	d.fanoutFlowRuns("tenant-1", "sub-9", 1, "obscure_event", time.Now())
	if fake.enqueueCalls != 0 {
		t.Fatalf("enqueueCalls = %d, want 0", fake.enqueueCalls)
	}
}

func TestFanoutFlowRuns_MatchErrorIsLoggedNotPanicked(t *testing.T) {
	fake := &fakeEnqueuer{matchErr: errors.New("boom")}
	d := &Deps{FlowRuns: fake}
	d.fanoutFlowRuns("tenant-1", "sub-9", 1, "x", time.Now())
	if fake.enqueueCalls != 0 {
		t.Fatalf("enqueueCalls = %d, want 0 (match failed)", fake.enqueueCalls)
	}
}

func TestFanoutFlowRuns_LogsEnqueueFailure(t *testing.T) {
	fake := &fakeEnqueuer{
		failOnFlow: "flow-a",
		matches: []flowbuilder.TriggerMatch{
			{FlowID: "flow-a"},
			{FlowID: "flow-b"},
		},
	}
	d := &Deps{FlowRuns: fake}
	d.fanoutFlowRuns("tenant-1", "sub-9", 1, "x", time.Now())
	// Even though flow-a returned an error, flow-b should still have been
	// attempted — verifies the loop does not short-circuit on a single bad
	// enqueue.
	if fake.enqueueCalls != 2 {
		t.Fatalf("enqueueCalls = %d, want 2", fake.enqueueCalls)
	}
}

func TestAutomationFanoutRecoversFromTransportPanic(t *testing.T) {
	var logs bytes.Buffer
	deps := &Deps{
		AutomationServiceURL: "https://automation.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			panic("simulated automation transport panic")
		})},
		Logger: log.New(&logs, "", 0),
	}

	deps.fanout(
		"tenant-1",
		"subscriber@example.com",
		"checkout.completed",
		map[string]interface{}{"order_id": "order-1"},
		time.Now().UTC(),
	)

	if !bytes.Contains(logs.Bytes(), []byte("automation fanout panic")) {
		t.Fatalf("log = %q, want recovered automation fanout panic", logs.String())
	}
}

func TestAutomationFanoutReportsRejectedResponse(t *testing.T) {
	var logs bytes.Buffer
	deps := &Deps{
		AutomationServiceURL: "https://automation.example.test",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusServiceUnavailable,
				Body:       io.NopCloser(bytes.NewBufferString("private upstream detail")),
				Header:     make(http.Header),
			}, nil
		})},
		Logger: log.New(&logs, "", 0),
	}

	deps.fanout(
		"tenant-1",
		"subscriber@example.com",
		"checkout.completed",
		map[string]interface{}{},
		time.Now().UTC(),
	)

	if !bytes.Contains(logs.Bytes(), []byte("status=503")) {
		t.Fatalf("log = %q, want rejected status", logs.String())
	}
	if bytes.Contains(logs.Bytes(), []byte("private upstream detail")) {
		t.Fatalf("log leaked upstream response body: %q", logs.String())
	}
}

// Repo.fanoutEvent is the SAME enrollment, reached from the integration ingest
// sinks (Repo.Insert) rather than the HTTP /track handler — so a commerce order
// / support ticket / loyalty event recorded by a connector now drives flows too.
func TestRepoFanoutEvent_EnrollsMatchingFlows(t *testing.T) {
	fake := &fakeEnqueuer{matches: []flowbuilder.TriggerMatch{{FlowID: "flow-a"}, {FlowID: "flow-b"}}}
	r := &Repo{FlowRuns: fake}
	r.fanoutEvent("tenant-1", "sub-1", 99, "order.completed", time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC))
	if fake.matchEventName != "order.completed" {
		t.Fatalf("match keyed by wrong event: %q", fake.matchEventName)
	}
	if len(fake.enqueued) != 2 {
		t.Fatalf("expected one enrollment per matching flow, got %+v", fake.enqueued)
	}
	got := fake.enqueued[0]
	if got.SubscriberID != "sub-1" || got.TriggerEventName != "order.completed" ||
		got.TriggerEventID == nil || *got.TriggerEventID != 99 {
		t.Fatalf("enrollment request wrong: %+v", got)
	}
}
