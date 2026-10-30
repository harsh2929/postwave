package runtime

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/listmonk"
)

// mockListmonk records calls without making HTTP requests.
type mockListmonk struct {
	mu          sync.Mutex
	sends       []listmonk.TransactionalReq
	addTags     []string
	removeTags  []string
	unsubs      []string
	propUpdates []string
	failNextErr error
}

func TestCouponAssignFailsClosedWithoutReleaseQualifiedEmitter(t *testing.T) {
	if CouponAllocationAvailable {
		t.Fatal("coupon allocation must remain release-contained")
	}
	node := &canonical.AutomationNode{
		ID:       "coupon",
		Type:     "coupon_assign",
		Metadata: map[string]any{"coupon_pool_id": "pool-1"},
	}
	auto := &canonical.Automation{ID: "automation-1", TenantID: "tenant-1", Nodes: []canonical.AutomationNode{*node}}
	_, _, err := (&Engine{}).runNode(
		context.Background(),
		auto,
		node,
		Execution{TenantID: "tenant-1", AutomationID: "automation-1", SubscriberEmail: "subscriber@example.test"},
		canonical.Subscriber{Email: "subscriber@example.test"},
	)
	if err == nil || !strings.Contains(err.Error(), "coupon allocation is release-contained") {
		t.Fatalf("runNode error = %v, want release-contained failure", err)
	}
}

func (m *mockListmonk) SendTransactional(ctx context.Context, req listmonk.TransactionalReq) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failNextErr != nil {
		err := m.failNextErr
		m.failNextErr = nil
		return err
	}
	m.sends = append(m.sends, req)
	return nil
}

func (m *mockListmonk) AddTagToSubscriber(ctx context.Context, email, tag string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.addTags = append(m.addTags, email+":"+tag)
	return nil
}
func (m *mockListmonk) RemoveTagFromSubscriber(ctx context.Context, email, tag string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.removeTags = append(m.removeTags, email+":"+tag)
	return nil
}
func (m *mockListmonk) UnsubscribeFromAll(ctx context.Context, email string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unsubs = append(m.unsubs, email)
	return nil
}
func (m *mockListmonk) UpdateSubscriberProperty(ctx context.Context, email, field string, value interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.propUpdates = append(m.propUpdates, fmt.Sprintf("%s:%s=%v", email, field, value))
	return nil
}

func ptr(s string) *string { return &s }

func buildEngine(t *testing.T) (*Engine, *mockListmonk, *MemoryQueue, *MemoryStore, *MemoryResolver) {
	t.Helper()
	lm := &mockListmonk{}
	q := NewMemoryQueue()
	st := NewMemoryStore()
	r := NewMemoryResolver()
	now := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	e := &Engine{
		Listmonk: lm,
		Store:    st,
		Queue:    q,
		Resolver: r,
		Now:      func() time.Time { return now },
	}
	q.SetClock(func() time.Time { return now })
	return e, lm, q, st, r
}

// drain runs Execute until the queue is empty, advancing the clock to honor
// wait nodes.
func drain(t *testing.T, e *Engine, q *MemoryQueue) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < 100; i++ {
		exec, ok := q.PopReady()
		if !ok {
			if q.Len() == 0 {
				return
			}
			// Advance virtual clock past the next scheduled run.
			q.mu.Lock()
			next := q.heap[0].runAt
			q.mu.Unlock()
			cur := next.Add(time.Second)
			q.SetClock(func() time.Time { return cur })
			e.Now = func() time.Time { return cur }
			continue
		}
		if err := e.Execute(ctx, exec); err != nil {
			t.Fatalf("execute %+v: %v", exec, err)
		}
	}
	t.Fatalf("drain did not terminate; queue size %d", q.Len())
}

func TestEngine_SendThenWaitThenSend(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)

	auto := &canonical.Automation{
		ID: "a1", TenantID: "t1", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join", ListID: "5"}},
		EntryID:  "n1",
		Nodes: []canonical.AutomationNode{
			{ID: "n1", Type: "send_email", TemplateID: "10"},
			{ID: "n2", Type: "wait", DurationSeconds: 3600},
			{ID: "n3", Type: "send_email", TemplateID: "11"},
		},
		Edges: []canonical.AutomationEdge{
			{From: "n1", To: "n2"}, {From: "n2", To: "n3"},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t1", canonical.Subscriber{Email: "u@x.com", Status: canonical.StatusEnabled})

	if err := e.Trigger(context.Background(), "a1", "list_join",
		"u@x.com", map[string]interface{}{"list_id": "5"}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if got := len(lm.sends); got != 2 {
		t.Fatalf("want 2 sends, got %d", got)
	}
	if lm.sends[0].TemplateID != 10 || lm.sends[1].TemplateID != 11 {
		t.Fatalf("send order/template wrong: %+v", lm.sends)
	}
}

func TestEngine_BranchTrueLeg(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "b1",
		Nodes: []canonical.AutomationNode{
			{ID: "b1", Type: "branch",
				Condition: &canonical.SegmentCondition{Field: "tags", Comparator: "contains", Value: "vip"},
				TrueNext:  ptr("yes"), FalseNext: ptr("no")},
			{ID: "yes", Type: "send_email", TemplateID: "100"},
			{ID: "no", Type: "send_email", TemplateID: "200"},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Tags: []string{"vip"}})

	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 100 {
		t.Fatalf("want template 100, got %+v", lm.sends)
	}
}

func TestEngine_WaitUntilThenGoalExit(t *testing.T) {
	e, lm, q, st, r := buildEngine(t)
	runAt := time.Date(2026, 4, 29, 12, 30, 0, 0, time.UTC)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "purchase"}},
		EntryID:  "wait",
		Nodes: []canonical.AutomationNode{
			{ID: "wait", Type: "wait_until", WaitUntil: &runAt},
			{ID: "goal", Type: "goal", Goal: &canonical.SegmentCondition{Field: "custom.plan", Comparator: "eq", Value: "paid"}},
			{ID: "send", Type: "send_email", TemplateID: "44"},
		},
		Edges: []canonical.AutomationEdge{{From: "wait", To: "goal"}, {From: "goal", To: "send"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{
		Email:        "paid@x.com",
		CustomFields: map[string]interface{}{"plan": "paid"},
	})

	if err := e.Trigger(context.Background(), "a", "purchase", "paid@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(lm.sends) != 0 {
		t.Fatalf("goal-met execution should exit before send; got %+v", lm.sends)
	}
	events, err := st.ListEvents(context.Background(), "t", "a", 50)
	if err != nil {
		t.Fatal(err)
	}
	seenGoal := false
	for _, ev := range events {
		if ev.EventType == "goal_met" {
			seenGoal = true
		}
	}
	if !seenGoal {
		t.Fatalf("expected goal_met event in %+v", events)
	}
}

func TestEngine_GoalMissContinues(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "purchase"}},
		EntryID:  "goal",
		Nodes: []canonical.AutomationNode{
			{ID: "goal", Type: "goal", Goal: &canonical.SegmentCondition{Field: "custom.plan", Comparator: "eq", Value: "paid"}},
			{ID: "send", Type: "send_email", TemplateID: "44"},
		},
		Edges: []canonical.AutomationEdge{{From: "goal", To: "send"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{
		Email:        "trial@x.com",
		CustomFields: map[string]interface{}{"plan": "trial"},
	})

	if err := e.Trigger(context.Background(), "a", "purchase", "trial@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 44 {
		t.Fatalf("goal miss should continue to send 44; got %+v", lm.sends)
	}
}

func TestEngine_ActionAddTag(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "act",
		Nodes: []canonical.AutomationNode{
			{ID: "act", Type: "action",
				Action: &canonical.AutomationAction{Kind: "add_tag", Tag: "welcomed"}},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	if err := e.Trigger(context.Background(), "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(lm.addTags) != 1 || lm.addTags[0] != "u@x.com:welcomed" {
		t.Fatalf("want add tag, got %+v", lm.addTags)
	}
}

func TestEngine_Idempotent(t *testing.T) {
	e, lm, q, st, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "x"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "5"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	if err := e.Trigger(context.Background(), "a", "x", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	// Replay the same node WITHIN the same run: must be a no-op.
	//
	// The run matters. Idempotency is scoped to a run, deliberately — a replay
	// of run N must not re-send, but a legitimate re-enrollment (a NEW run)
	// must. So the replayed Execution has to carry the run the trigger
	// actually created, not a fabricated one.
	latest, err := st.LatestRun(context.Background(), "a", "u@x.com")
	if err != nil || latest == nil {
		t.Fatalf("expected a run to exist after trigger: %v", err)
	}
	exec := Execution{
		ID:           NewExecutionID("a", "u@x.com", "n1", latest.RunID),
		AutomationID: "a", TenantID: "t",
		SubscriberEmail: "u@x.com", NodeID: "n1",
		RunID: latest.RunID,
	}
	if err := e.Execute(context.Background(), exec); err != nil {
		t.Fatal(err)
	}
	if len(lm.sends) != 1 {
		t.Fatalf("idempotency broken; sends=%d", len(lm.sends))
	}
}

func TestEngine_RecordsExecutionEvents(t *testing.T) {
	e, _, q, st, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "x"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "5"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	if err := e.Trigger(context.Background(), "a", "x", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	events, err := st.ListEvents(context.Background(), "t", "a", 20)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, ev := range events {
		seen[ev.EventType] = true
		if ev.AutomationID != "a" || ev.TenantID != "t" {
			t.Fatalf("bad event scope: %+v", ev)
		}
	}
	for _, want := range []string{"triggered", "node_started", "node_completed", "completed"} {
		if !seen[want] {
			t.Fatalf("missing event %q in %+v", want, events)
		}
	}
}

func TestEngine_TriggerStatusInactive(t *testing.T) {
	e, _, _, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{ID: "a", TenantID: "t", Status: "paused",
		Nodes: []canonical.AutomationNode{{ID: "n", Type: "send_email", TemplateID: "1"}}})
	err := e.Trigger(context.Background(), "a", "x", "u@x.com", nil)
	if err == nil {
		t.Fatal("expected error for paused automation")
	}
}

func TestEngine_OpenedEmailTrigger(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{
			Type: TriggerOpenedEmail, CampaignID: "c1", WithinDays: 7,
		}},
		EntryID: "n1",
		Nodes:   []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	d := &EventDispatcher{Engine: e, Lister: r}
	if err := d.HandleEvent(context.Background(), EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com",
		EventType: "opened", CampaignID: "c1", At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 {
		t.Fatalf("opened-email trigger should have sent 1; got %d", len(lm.sends))
	}

	// Mismatched campaign id — must NOT trigger.
	lm.sends = nil
	if err := d.HandleEvent(context.Background(), EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com",
		EventType: "opened", CampaignID: "OTHER", At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 0 {
		t.Fatalf("mismatched campaign should not trigger; got %d", len(lm.sends))
	}
}

func TestEngine_ClickedLinkTrigger(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{
			Type: TriggerClickedLink, URLPattern: "/pricing",
		}},
		EntryID: "n1",
		Nodes:   []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "9"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com"})

	d := &EventDispatcher{Engine: e, Lister: r}
	if err := d.HandleEvent(context.Background(), EngagementEvent{
		TenantID: "t", SubscriberEmail: "v@x.com",
		EventType: "clicked", LinkURL: "https://example.com/pricing?x=1",
		At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 9 {
		t.Fatalf("clicked-link trigger should have sent template 9; got %+v", lm.sends)
	}

	// Pattern mismatch — must NOT trigger.
	lm.sends = nil
	if err := d.HandleEvent(context.Background(), EngagementEvent{
		TenantID: "t", SubscriberEmail: "v@x.com",
		EventType: "clicked", LinkURL: "https://example.com/blog/post",
		At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 0 {
		t.Fatalf("link pattern miss should not trigger; got %d", len(lm.sends))
	}
}

func TestEngine_ProductEventDispatcherPreservesPayload(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{
			Type:            canonical.TriggerProductEvent,
			EventName:       "billing.subscription.created",
			PropertyFilters: map[string]interface{}{"tier": "pro"},
		}},
		EntryID: "n1",
		Nodes:   []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "77"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "buyer@example.com"})

	d := &EventDispatcher{Engine: e, Lister: r}
	if err := d.HandleEvent(context.Background(), EngagementEvent{
		TenantID:        "t",
		SubscriberEmail: "buyer@example.com",
		EventType:       canonical.TriggerProductEvent,
		Payload: map[string]interface{}{
			"event_name": "billing.subscription.created",
			"tier":       "pro",
		},
		At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 77 {
		t.Fatalf("product-event trigger should send template 77; got %+v", lm.sends)
	}
}

func TestEventDispatcherHTTPHandlerRejectsOversizedBody(t *testing.T) {
	d := &EventDispatcher{}
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/automations/event",
		strings.NewReader(`{"tenant_id":"t","subscriber_email":"a@example.com","event_type":"product_event","payload":{"x":"`+strings.Repeat("x", int(eventJSONMaxBodyBytes))+`"}}`),
	)
	rec := httptest.NewRecorder()

	d.HTTPHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestEngine_DidNotOpenTrigger(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{
			Type: TriggerDidNotOpen, CampaignID: "c1", AfterDays: 3,
		}},
		EntryID: "n1",
		Nodes:   []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "55"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "lazy@x.com"})

	// Stub OpenLookup: pretends nobody has opened.
	d := &EventDispatcher{
		Engine: e, Lister: r,
		OpenLookup: func(ctx context.Context, tenantID, email, campaignID string, since time.Time) (bool, error) {
			return false, nil
		},
	}
	if err := d.EvaluateDidNotOpen(context.Background(),
		"t", "lazy@x.com", "c1",
		time.Now().Add(-4*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 55 {
		t.Fatalf("did_not_open should trigger and send template 55; got %+v", lm.sends)
	}

	// Now flip OpenLookup to "opened" — evaluator must NOT fire.
	lm.sends = nil
	// Fresh subscriber to dodge the per-(automation,subscriber,node) idempotency
	// guard, which would suppress a re-trigger for the same recipient.
	r.PutSubscriber("t", canonical.Subscriber{Email: "active@x.com"})
	d.OpenLookup = func(ctx context.Context, tenantID, email, campaignID string, since time.Time) (bool, error) {
		return true, nil
	}
	if err := d.EvaluateDidNotOpen(context.Background(),
		"t", "active@x.com", "c1",
		time.Now().Add(-4*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 0 {
		t.Fatalf("subscriber who opened should not be triggered; got %d", len(lm.sends))
	}
}

func TestEngine_PauseResume(t *testing.T) {
	e, lm, q, st, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "x"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	if err := st.SetPaused(context.Background(), "a", true); err != nil {
		t.Fatal(err)
	}
	if err := e.Trigger(context.Background(), "a", "x", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	// Pop once — should re-enqueue not send.
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected ready exec")
	}
	if err := e.Execute(context.Background(), exec); err != nil {
		t.Fatal(err)
	}
	if len(lm.sends) != 0 {
		t.Fatalf("should not have sent while paused; sends=%d", len(lm.sends))
	}
}

// fakeSMSEmitter records the requests a send_sms node enqueues.
type fakeSMSEmitter struct {
	calls   []SMSSendRequest
	tenants []string
	emitErr error
}

func (f *fakeSMSEmitter) Emit(_ context.Context, tenantID string, req SMSSendRequest) error {
	if f.emitErr != nil {
		return f.emitErr
	}
	f.tenants = append(f.tenants, tenantID)
	f.calls = append(f.calls, req)
	return nil
}

// TestEngine_SendSMSNode verifies a send_sms node enqueues exactly one request
// (carrying tenant, email, phone, body, and node identity) and then advances to
// its successor.
func TestEngine_SendSMSNode(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	sms := &fakeSMSEmitter{}
	e.SMS = sms

	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "s1",
		Nodes: []canonical.AutomationNode{
			{ID: "s1", Type: "send_sms", SMSBody: "  Your order shipped  "},
			{ID: "e1", Type: "send_email", TemplateID: "7"},
		},
		Edges: []canonical.AutomationEdge{{From: "s1", To: "e1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{
		Email: "v@x.com", Phone: "+15551234567", Status: canonical.StatusEnabled,
	})

	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(sms.calls) != 1 {
		t.Fatalf("want 1 sms enqueue, got %d", len(sms.calls))
	}
	got := sms.calls[0]
	if got.SubscriberEmail != "v@x.com" || got.Phone != "+15551234567" {
		t.Fatalf("wrong recipient: %+v", got)
	}
	if got.Body != "Your order shipped" { // trimmed
		t.Fatalf("body not trimmed: %q", got.Body)
	}
	if got.AutomationID != "a" || got.NodeID != "s1" {
		t.Fatalf("wrong node identity: %+v", got)
	}
	if len(sms.tenants) != 1 || sms.tenants[0] != "t" {
		t.Fatalf("wrong tenant: %+v", sms.tenants)
	}
	// Flow advanced past the SMS node to the email.
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 7 {
		t.Fatalf("send_sms did not advance to email; sends=%+v", lm.sends)
	}
}

// TestEngine_SendSMSNilEmitterAdvances verifies a graph with an SMS node still
// runs (as a no-op) when no emitter is wired — the dev/test default.
func TestEngine_SendSMSNilEmitterAdvances(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	e.SMS = nil // explicit: no emitter

	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "s1",
		Nodes: []canonical.AutomationNode{
			{ID: "s1", Type: "send_sms", SMSBody: "hi"},
			{ID: "e1", Type: "send_email", TemplateID: "7"},
		},
		Edges: []canonical.AutomationEdge{{From: "s1", To: "e1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})

	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 7 {
		t.Fatalf("nil-emitter SMS node did not advance; sends=%+v", lm.sends)
	}
}

// TestEngine_SendSMSMissingBody verifies a send_sms node with no body errors
// (so a misconfigured graph fails loudly rather than silently skipping SMS).
func TestEngine_SendSMSMissingBody(t *testing.T) {
	e, _, q, _, r := buildEngine(t)
	e.SMS = &fakeSMSEmitter{}

	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "s1",
		Nodes:    []canonical.AutomationNode{{ID: "s1", Type: "send_sms", SMSBody: "   "}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})

	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected ready exec")
	}
	if err := e.Execute(context.Background(), exec); err == nil {
		t.Fatal("expected error for missing sms_body, got nil")
	}
}

// fakeWebhookEmitter records the outbound calls a webhook node / flow_webhook
// action would make.
type fakeWebhookEmitter struct {
	calls []WebhookRequest
	err   error
}

func (f *fakeWebhookEmitter) Send(_ context.Context, req WebhookRequest) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, req)
	return nil
}

// fakeApprovalGate forces gating and returns a fixed status.
type fakeApprovalGate struct{ status string }

func (g *fakeApprovalGate) RequiresApproval(_ context.Context, _, _, _ string) bool { return true }
func (g *fakeApprovalGate) RequestOrCheck(_ context.Context, _, _, _, _ string) (string, string, error) {
	return g.status, "appr-1", nil
}

// TestEngine_PercentageSplitRoutes verifies a 100/0 split deterministically
// routes every subscriber down the 100% leg and advances there.
func TestEngine_PercentageSplitRoutes(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "split",
		Nodes: []canonical.AutomationNode{
			{ID: "split", Type: "percentage_split", Variants: []canonical.AutomationSplitVariant{
				{ID: "v1", Percentage: 100, Next: "e1"},
				{ID: "v2", Percentage: 0, Next: "e2"},
			}},
			{ID: "e1", Type: "send_email", TemplateID: "1"},
			{ID: "e2", Type: "send_email", TemplateID: "2"},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 1 {
		t.Fatalf("100%% leg should route to e1 (tpl 1); got %+v", lm.sends)
	}
}

// TestEngine_WebhookNode verifies a webhook node calls the emitter with the
// node's URL and advances to its successor.
func TestEngine_WebhookNode(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	wh := &fakeWebhookEmitter{}
	e.Webhook = wh
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "w",
		Nodes: []canonical.AutomationNode{
			{ID: "w", Type: "webhook", WebhookURL: "https://hooks.example/x", WebhookMethod: "POST"},
			{ID: "e1", Type: "send_email", TemplateID: "5"},
		},
		Edges: []canonical.AutomationEdge{{From: "w", To: "e1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(wh.calls) != 1 || wh.calls[0].URL != "https://hooks.example/x" {
		t.Fatalf("webhook not called with node url: %+v", wh.calls)
	}
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 5 {
		t.Fatalf("webhook node did not advance to email; sends=%+v", lm.sends)
	}
}

// TestEngine_WebhookNilEmitterAdvances verifies a webhook node is a no-op skip
// when no emitter is wired (dev/test).
func TestEngine_WebhookNilEmitterAdvances(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	e.Webhook = nil
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "w",
		Nodes: []canonical.AutomationNode{
			{ID: "w", Type: "webhook", WebhookURL: "https://hooks.example/x"},
			{ID: "e1", Type: "send_email", TemplateID: "5"},
		},
		Edges: []canonical.AutomationEdge{{From: "w", To: "e1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 {
		t.Fatalf("nil-emitter webhook node did not advance; sends=%+v", lm.sends)
	}
}

// TestEngine_UpdateProfilePropertyAction verifies the action writes the
// property through the listmonk client and advances.
func TestEngine_UpdateProfilePropertyAction(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "act",
		Nodes: []canonical.AutomationNode{
			{ID: "act", Type: "action", Action: &canonical.AutomationAction{
				Kind: "update_profile_property", Field: "plan", Value: "paid"}},
			{ID: "e1", Type: "send_email", TemplateID: "9"},
		},
		Edges: []canonical.AutomationEdge{{From: "act", To: "e1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.propUpdates) != 1 || lm.propUpdates[0] != "v@x.com:plan=paid" {
		t.Fatalf("profile property not updated: %+v", lm.propUpdates)
	}
	if len(lm.sends) != 1 {
		t.Fatalf("update_profile_property did not advance; sends=%+v", lm.sends)
	}
}

// TestEngine_FlowWebhookAction verifies the flow_webhook action calls the emitter.
func TestEngine_FlowWebhookAction(t *testing.T) {
	e, _, q, _, r := buildEngine(t)
	wh := &fakeWebhookEmitter{}
	e.Webhook = wh
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "act",
		Nodes: []canonical.AutomationNode{
			{ID: "act", Type: "action", Action: &canonical.AutomationAction{
				Kind: "flow_webhook", URL: "https://hooks.example/f"}},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(wh.calls) != 1 || wh.calls[0].URL != "https://hooks.example/f" {
		t.Fatalf("flow_webhook action did not call emitter: %+v", wh.calls)
	}
}

// TestEngine_ManualReviewNilApprovalsAdvances verifies a manual_review node is a
// pass-through when no ApprovalGate is wired (studio/dev).
func TestEngine_ManualReviewNilApprovalsAdvances(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	e.Approvals = nil
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "mr",
		Nodes: []canonical.AutomationNode{
			{ID: "mr", Type: "manual_review"},
			{ID: "e1", Type: "send_email", TemplateID: "3"},
		},
		Edges: []canonical.AutomationEdge{{From: "mr", To: "e1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 {
		t.Fatalf("manual_review (no gate) did not advance; sends=%+v", lm.sends)
	}
}

func manualReviewAuto() *canonical.Automation {
	return &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "mr",
		Nodes: []canonical.AutomationNode{
			{ID: "mr", Type: "manual_review"},
			{ID: "e1", Type: "send_email", TemplateID: "3"},
		},
		Edges: []canonical.AutomationEdge{{From: "mr", To: "e1"}},
	}
}

// TestEngine_ManualReviewPendingHalts verifies a manual_review node sends
// nothing and does not advance while its approval is pending.
func TestEngine_ManualReviewPendingHalts(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	e.Approvals = &fakeApprovalGate{status: "pending"}
	r.PutAutomation(manualReviewAuto())
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected ready exec")
	}
	if err := e.Execute(context.Background(), exec); err != nil {
		t.Fatal(err)
	}
	if len(lm.sends) != 0 {
		t.Fatalf("pending review must not advance/send; sends=%+v", lm.sends)
	}
}

// TestEngine_WaitUntilTriggerParkAndResume verifies a wait_until_trigger node
// parks the execution until a matching event arrives, ignores non-matching and
// duplicate events, then resumes to its successor.
func TestEngine_WaitUntilTriggerParkAndResume(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "w",
		Nodes: []canonical.AutomationNode{
			{ID: "w", Type: "wait_until_trigger", WaitTrigger: &canonical.AutomationTrigger{
				Type: canonical.TriggerProductEvent, EventName: "order.placed"}},
			{ID: "e1", Type: "send_email", TemplateID: "8"},
		},
		Edges: []canonical.AutomationEdge{{From: "w", To: "e1"}},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})

	// Enter the flow → it parks at the wait node (no send).
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 0 {
		t.Fatalf("flow should park, not send; sends=%+v", lm.sends)
	}

	d := &EventDispatcher{Engine: e, Lister: r}
	fire := func(eventName string) {
		if err := d.HandleEvent(context.Background(), EngagementEvent{
			TenantID: "t", SubscriberEmail: "v@x.com", EventType: canonical.TriggerProductEvent,
			Payload: map[string]interface{}{"event_name": eventName}, At: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
		drain(t, e, q)
	}

	// Non-matching event must not resume.
	fire("other.event")
	if len(lm.sends) != 0 {
		t.Fatalf("non-matching event must not resume; sends=%+v", lm.sends)
	}

	// Matching event resumes → successor email sends.
	fire("order.placed")
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 8 {
		t.Fatalf("matching event should resume to tpl 8; got %+v", lm.sends)
	}

	// A second matching event must not double-resume.
	fire("order.placed")
	if len(lm.sends) != 1 {
		t.Fatalf("second matching event must not double-resume; sends=%+v", lm.sends)
	}
}

func continuousGoalAuto() *canonical.Automation {
	return &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "tag_added"}},
		EntryID:  "wait",
		Nodes: []canonical.AutomationNode{
			{ID: "wait", Type: "wait", DurationSeconds: 3600},
			{ID: "send", Type: "send_email", TemplateID: "9"},
			{ID: "g", Type: "goal", Goal: &canonical.SegmentCondition{
				Field: "custom.converted", Comparator: "eq", Value: "yes"}},
		},
		Edges: []canonical.AutomationEdge{{From: "wait", To: "send"}},
	}
}

// TestEngine_ContinuousGoalExit verifies a subscriber who meets a goal mid-wait
// is exited from the journey — the downstream send never fires.
func TestEngine_ContinuousGoalExit(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(continuousGoalAuto())
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled,
		CustomFields: map[string]interface{}{"converted": "no"}})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	// Run the wait node once → schedules the send at +1h.
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected ready entry exec")
	}
	if err := e.Execute(context.Background(), exec); err != nil {
		t.Fatal(err)
	}
	// Subscriber converts; an event triggers the in-flight goal scan.
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled,
		CustomFields: map[string]interface{}{"converted": "yes"}})
	d := &EventDispatcher{Engine: e, Lister: r}
	if err := d.HandleEvent(context.Background(), EngagementEvent{
		TenantID: "t", SubscriberEmail: "v@x.com", EventType: canonical.TriggerProductEvent,
		Payload: map[string]interface{}{"event_name": "order.placed"}, At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 0 {
		t.Fatalf("converted subscriber should have exited before the send; sends=%+v", lm.sends)
	}
}

// TestEngine_ContinuousGoalNotMetContinues is the control: a subscriber who
// never meets the goal still gets the downstream send.
func TestEngine_ContinuousGoalNotMetContinues(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(continuousGoalAuto())
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled,
		CustomFields: map[string]interface{}{"converted": "no"}})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected ready entry exec")
	}
	if err := e.Execute(context.Background(), exec); err != nil {
		t.Fatal(err)
	}
	// An event arrives but the goal is still unmet → no exit.
	d := &EventDispatcher{Engine: e, Lister: r}
	if err := d.HandleEvent(context.Background(), EngagementEvent{
		TenantID: "t", SubscriberEmail: "v@x.com", EventType: canonical.TriggerProductEvent,
		Payload: map[string]interface{}{"event_name": "order.placed"}, At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 9 {
		t.Fatalf("unmet-goal subscriber should still receive the send (tpl 9); got %+v", lm.sends)
	}
}

// TestEngine_ManualReviewApprovedAdvances verifies an approved manual_review
// node advances to its successor.
func TestEngine_ManualReviewApprovedAdvances(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	e.Approvals = &fakeApprovalGate{status: "approved"}
	r.PutAutomation(manualReviewAuto())
	r.PutSubscriber("t", canonical.Subscriber{Email: "v@x.com", Status: canonical.StatusEnabled})
	if err := e.Trigger(context.Background(), "a", "tag_added", "v@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 || lm.sends[0].TemplateID != 3 {
		t.Fatalf("approved review did not advance to email; sends=%+v", lm.sends)
	}
}

func TestTriggerDurableRetryDoesNotRewindAnAlreadyAdvancedRun(t *testing.T) {
	resolver := NewMemoryResolver()
	resolver.PutAutomation(&canonical.Automation{
		ID:           "a",
		TenantID:     "t",
		Status:       "active",
		ReEnrollment: canonical.ReEnrollAlways,
		Triggers: []canonical.AutomationTrigger{{
			Type:      canonical.TriggerLifecycleStageChanged,
			FromStage: "subscriber",
			ToStage:   "lead",
		}},
		Nodes: []canonical.AutomationNode{
			{ID: "entry", Type: "wait"},
			{ID: "next", Type: "wait"},
		},
		EntryID: "entry",
	})
	store := NewMemoryStore()
	queue := newLifecycleRecordingQueue()
	queue.acceptThenFailRemaining["a"] = 1
	engine := &Engine{Resolver: resolver, Store: store, Queue: queue}
	payload := map[string]interface{}{
		"from_stage": "subscriber",
		"to_stage":   "lead",
		"score":      float64(4),
	}
	const email = "durable-run@example.test"
	const durableKey = "tenant\x00lifecycle-outbox:event"

	if _, err := engine.TriggerDurable(context.Background(), "a",
		canonical.TriggerLifecycleStageChanged, email, payload, durableKey); err == nil {
		t.Fatal("first durable trigger should surface the simulated timeout")
	}
	runID := durableRunID("a", durableKey)
	latest, err := store.LatestRun(context.Background(), "a", email)
	if err != nil || latest == nil {
		t.Fatalf("read durable run after queue timeout: state=%#v err=%v", latest, err)
	}
	// Simulate the task having advanced before the producer learns that the
	// queue accepted it. Retrying the producer must not overwrite this cursor.
	if err := store.Upsert(context.Background(), &ExecutionState{
		TenantID:        "t",
		AutomationID:    "a",
		SubscriberEmail: email,
		RunID:           runID,
		CurrentNodeID:   "next",
		CompletedNodes:  map[string]time.Time{"entry": time.Now().UTC()},
		StartedAt:       latest.StartedAt,
	}); err != nil {
		t.Fatalf("advance durable run state: %v", err)
	}
	if disposition, err := engine.TriggerDurable(context.Background(), "a",
		canonical.TriggerLifecycleStageChanged, email, payload, durableKey); err != nil || disposition != TriggerDispositionQueued {
		t.Fatalf("retry durable trigger disposition/error=%q/%v", disposition, err)
	}
	state, err := store.Get(context.Background(), "a", email, runID)
	if err != nil || state == nil || state.CurrentNodeID != "next" {
		t.Fatalf("durable retry rewound state: %#v err=%v", state, err)
	}
	if got := len(queue.snapshot()); got != 1 {
		t.Fatalf("durable retry enqueued %d physical tasks, want one", got)
	}
}
