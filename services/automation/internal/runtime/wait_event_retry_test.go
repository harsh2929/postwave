package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

type rejectFirstResumeQueue struct {
	delegate Queue

	mu         sync.Mutex
	reject     bool
	enqueues   int
	rejections int
}

type rejectFirstWaitCompletionStore struct {
	StateStore

	mu       sync.Mutex
	nodeID   string
	reject   bool
	attempts int
}

func (s *rejectFirstWaitCompletionStore) MarkCompleted(
	ctx context.Context,
	automationID, email, nodeID, runID string,
) error {
	if nodeID == s.nodeID {
		s.mu.Lock()
		s.attempts++
		if s.reject {
			s.reject = false
			s.mu.Unlock()
			return errors.New("forced wait completion failure")
		}
		s.mu.Unlock()
	}
	return s.StateStore.MarkCompleted(ctx, automationID, email, nodeID, runID)
}

func (q *rejectFirstResumeQueue) Enqueue(ctx context.Context, exec Execution, runAt time.Time) error {
	q.mu.Lock()
	q.enqueues++
	if q.reject {
		q.reject = false
		q.rejections++
		q.mu.Unlock()
		return errors.New("forced successor enqueue rejection")
	}
	q.mu.Unlock()
	return q.delegate.Enqueue(ctx, exec, runAt)
}

func (q *rejectFirstResumeQueue) Pop(ctx context.Context) (Execution, error) {
	return q.delegate.Pop(ctx)
}

func (q *rejectFirstResumeQueue) Ack(ctx context.Context, exec Execution) error {
	return q.delegate.Ack(ctx, exec)
}

func (q *rejectFirstResumeQueue) Depth(ctx context.Context) (int, error) {
	return q.delegate.Depth(ctx)
}

func TestWaitEventResumeKeepsNodeRetryableUntilSuccessorIsEnqueued(t *testing.T) {
	e, mailer, memoryQueue, store, resolver := buildEngine(t)
	auto := &canonical.Automation{
		ID: "resume-retry", TenantID: "tenant-1", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "wait-for-order",
		Nodes: []canonical.AutomationNode{
			{ID: "wait-for-order", Type: "wait_until_trigger", WaitTrigger: &canonical.AutomationTrigger{
				Type: canonical.TriggerProductEvent, EventName: "order.placed",
			}},
			{ID: "follow-up", Type: "send_email", TemplateID: "8"},
		},
		Edges: []canonical.AutomationEdge{{From: "wait-for-order", To: "follow-up"}},
	}
	resolver.PutAutomation(auto)
	resolver.PutSubscriber("tenant-1", canonical.Subscriber{
		Email: "retry@example.test", Status: canonical.StatusEnabled,
	})

	if err := e.Trigger(context.Background(), auto.ID, "tag_added", "retry@example.test", nil); err != nil {
		t.Fatalf("enter flow: %v", err)
	}
	drain(t, e, memoryQueue) // execute and park the wait node

	queue := &rejectFirstResumeQueue{delegate: memoryQueue, reject: true}
	e.Queue = queue
	dispatcher := &EventDispatcher{Engine: e, Lister: resolver}
	event := EngagementEvent{
		TenantID: "tenant-1", SubscriberEmail: "retry@example.test",
		EventType: canonical.TriggerProductEvent,
		Payload:   map[string]interface{}{"event_name": "order.placed"},
		At:        time.Now().UTC(),
	}

	if err := dispatcher.HandleEvent(context.Background(), event); !errors.Is(err, ErrEventContinuationFailed) {
		t.Fatalf("first matching event error = %v, want retryable continuation failure", err)
	}
	state, err := store.LatestRun(context.Background(), auto.ID, event.SubscriberEmail)
	if err != nil || state == nil {
		t.Fatalf("latest run after rejection = %+v, %v", state, err)
	}
	if _, completed := state.CompletedNodes["wait-for-order"]; completed {
		t.Fatal("wait node was completed even though successor enqueue failed")
	}
	if memoryQueue.Len() != 0 {
		t.Fatalf("durable successor queue length = %d after rejection, want 0", memoryQueue.Len())
	}

	// The HTTP boundary must not acknowledge the same failure. It advertises a
	// retryable response while preserving the incomplete wait sentinel.
	queue.mu.Lock()
	queue.reject = true
	queue.mu.Unlock()
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	recorder := httptest.NewRecorder()
	dispatcher.HTTPHandler().ServeHTTP(recorder, httptest.NewRequest(
		http.MethodPost, "/v1/automations/event", bytes.NewReader(body),
	))
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "1" {
		t.Fatalf("HTTP status/retry-after = %d/%q, body=%s",
			recorder.Code, recorder.Header().Get("Retry-After"), recorder.Body.String())
	}
	var failureBody struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &failureBody); err != nil {
		t.Fatalf("decode continuation failure body: %v", err)
	}
	if failureBody.Error.Code != "continuation_failed" ||
		failureBody.Error.Message != "event was not fully accepted; retry the same event" {
		t.Fatalf("continuation failure body = %+v", failureBody.Error)
	}
	state, err = store.LatestRun(context.Background(), auto.ID, event.SubscriberEmail)
	if err != nil || state == nil {
		t.Fatalf("latest run after HTTP rejection = %+v, %v", state, err)
	}
	if _, completed := state.CompletedNodes["wait-for-order"]; completed {
		t.Fatal("HTTP rejection completed the wait node")
	}

	// Redelivery of the same source event must enqueue the stable successor and
	// only then complete the wait node.
	if err := dispatcher.HandleEvent(context.Background(), event); err != nil {
		t.Fatalf("retried matching event: %v", err)
	}
	state, err = store.LatestRun(context.Background(), auto.ID, event.SubscriberEmail)
	if err != nil || state == nil {
		t.Fatalf("latest run after retry = %+v, %v", state, err)
	}
	if _, completed := state.CompletedNodes["wait-for-order"]; !completed {
		t.Fatal("wait node remained incomplete after successor enqueue succeeded")
	}
	if memoryQueue.Len() != 1 {
		t.Fatalf("durable successor queue length = %d after retry, want 1", memoryQueue.Len())
	}

	drain(t, e, memoryQueue)
	if len(mailer.sends) != 1 {
		t.Fatalf("successor send count = %d, want 1", len(mailer.sends))
	}

	// A later duplicate event observes the completed wait sentinel and cannot
	// enqueue or execute the successor again.
	if err := dispatcher.HandleEvent(context.Background(), event); err != nil {
		t.Fatalf("duplicate matching event: %v", err)
	}
	drain(t, e, memoryQueue)
	if len(mailer.sends) != 1 {
		t.Fatalf("duplicate event sent successor %d times, want 1", len(mailer.sends))
	}
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if queue.rejections != 2 || queue.enqueues != 3 {
		t.Fatalf("resume enqueue attempts/rejections = %d/%d, want 3/2", queue.enqueues, queue.rejections)
	}
}

func TestWaitEventResumeDedupesSuccessorWhenCompletionWriteIsRetried(t *testing.T) {
	e, mailer, queue, memoryStore, resolver := buildEngine(t)
	auto := &canonical.Automation{
		ID: "resume-mark-retry", TenantID: "tenant-1", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "wait-for-order",
		Nodes: []canonical.AutomationNode{
			{ID: "wait-for-order", Type: "wait_until_trigger", WaitTrigger: &canonical.AutomationTrigger{
				Type: canonical.TriggerProductEvent, EventName: "order.placed",
			}},
			{ID: "follow-up", Type: "send_email", TemplateID: "8"},
		},
		Edges: []canonical.AutomationEdge{{From: "wait-for-order", To: "follow-up"}},
	}
	resolver.PutAutomation(auto)
	resolver.PutSubscriber("tenant-1", canonical.Subscriber{
		Email: "mark-retry@example.test", Status: canonical.StatusEnabled,
	})
	if err := e.Trigger(context.Background(), auto.ID, "tag_added", "mark-retry@example.test", nil); err != nil {
		t.Fatalf("enter flow: %v", err)
	}
	drain(t, e, queue)

	store := &rejectFirstWaitCompletionStore{
		StateStore: memoryStore,
		nodeID:     "wait-for-order",
		reject:     true,
	}
	e.Store = store
	dispatcher := &EventDispatcher{Engine: e, Lister: resolver}
	event := EngagementEvent{
		TenantID: "tenant-1", SubscriberEmail: "mark-retry@example.test",
		EventType: canonical.TriggerProductEvent,
		Payload:   map[string]interface{}{"event_name": "order.placed"},
		At:        time.Now().UTC(),
	}

	if err := dispatcher.HandleEvent(context.Background(), event); !errors.Is(err, ErrEventContinuationFailed) {
		t.Fatalf("first matching event error = %v, want retryable continuation failure", err)
	}
	if queue.Len() != 1 {
		t.Fatalf("successor queue length after accepted enqueue = %d, want 1", queue.Len())
	}
	state, err := memoryStore.LatestRun(context.Background(), auto.ID, event.SubscriberEmail)
	if err != nil || state == nil {
		t.Fatalf("latest run after completion failure = %+v, %v", state, err)
	}
	if _, completed := state.CompletedNodes["wait-for-order"]; completed {
		t.Fatal("failed completion write unexpectedly completed wait node")
	}

	// Replaying the identical event offers the exact same successor execution
	// ID. MemoryQueue models the durable queue's idempotent TaskID conflict, so
	// the queue stays at one item while the completion write succeeds.
	if err := dispatcher.HandleEvent(context.Background(), event); err != nil {
		t.Fatalf("retried matching event: %v", err)
	}
	if queue.Len() != 1 {
		t.Fatalf("successor queue length after deduped retry = %d, want 1", queue.Len())
	}
	state, err = memoryStore.LatestRun(context.Background(), auto.ID, event.SubscriberEmail)
	if err != nil || state == nil {
		t.Fatalf("latest run after completion retry = %+v, %v", state, err)
	}
	if _, completed := state.CompletedNodes["wait-for-order"]; !completed {
		t.Fatal("retry did not complete wait node after queue dedupe")
	}

	drain(t, e, queue)
	if len(mailer.sends) != 1 {
		t.Fatalf("successor send count = %d, want 1", len(mailer.sends))
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.attempts != 2 {
		t.Fatalf("wait completion attempts = %d, want 2", store.attempts)
	}
}
