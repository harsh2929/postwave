package runtime

import (
	"context"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// Both "retry later" paths in Execute — automation paused, and approval pending
// — re-enqueued the CURRENTLY-EXECUTING Execution unchanged. Same exec means the
// same id, and the id is the asynq TaskID. asynq rejects a duplicate TaskID
// while the task exists, RedisQueue.Enqueue deliberately swallows
// ErrTaskIDConflict as "idempotent success", so Execute returned nil and asynq
// marked the active task COMPLETED (retained 7d).
//
// Nothing was ever rescheduled. No error, no DLQ entry — the journey row just
// looked like it was "waiting". Pausing a flow silently discarded every
// in-flight subscriber, and manual_review / requires_approval nodes were a
// permanent dead end.
//
// MemoryQueue dedups on exec.ID exactly as asynq dedups on TaskID, so these
// tests reproduce the production failure without Redis.

func TestRequeue_PausedExecutionIsNotDropped(t *testing.T) {
	e, lm, q, st, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})
	ctx := context.Background()

	if err := e.Trigger(ctx, "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	// The operator pauses the flow while the subscriber is mid-journey.
	if err := st.SetPaused(ctx, "a", true); err != nil {
		t.Fatal(err)
	}

	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected the entry execution to be queued")
	}
	if err := e.Execute(ctx, exec); err != nil {
		t.Fatal(err)
	}
	if len(lm.sends) != 0 {
		t.Fatal("a paused flow must not send")
	}

	// THE BUG: the re-queue collided with its own id and was swallowed, so the
	// queue is empty and the subscriber is stranded forever.
	if q.Len() == 0 {
		t.Fatal("paused execution was dropped — the subscriber is stranded with no error and no DLQ entry")
	}

	// Un-pausing must let the journey finish.
	if err := st.SetPaused(ctx, "a", false); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 {
		t.Fatalf("after unpause the journey must resume; sent %d, want 1", len(lm.sends))
	}
}

func TestRequeue_PendingApprovalIsNotDropped(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	gate := &fakeApprovalGate{status: "pending"}
	e.Approvals = gate
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes: []canonical.AutomationNode{
			{ID: "n1", Type: "send_email", TemplateID: "1", RequiresApproval: true},
		},
	})
	ctx := context.Background()

	if err := e.Trigger(ctx, "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected the entry execution to be queued")
	}
	if err := e.Execute(ctx, exec); err != nil {
		t.Fatal(err)
	}
	if len(lm.sends) != 0 {
		t.Fatal("a node awaiting approval must not send")
	}

	// THE BUG: approval nodes were a permanent dead end.
	if q.Len() == 0 {
		t.Fatal("execution awaiting approval was dropped — approval nodes are a permanent dead end")
	}

	// A human approves. The parked journey must resume.
	gate.status = "approved"
	drain(t, e, q)
	if len(lm.sends) != 1 {
		t.Fatalf("after approval the journey must resume; sent %d, want 1", len(lm.sends))
	}
}

// A re-queue of the SAME attempt must still be idempotent — otherwise a
// double-delivery from the queue would double-send.
func TestRequeue_SameAttemptStaysIdempotent(t *testing.T) {
	base := NewExecutionID("a", "u@x.com", "n1", "run1")
	first := RetryExecutionID(base, 1)
	second := RetryExecutionID(base, 1)
	if first != second {
		t.Fatal("the same attempt must produce the same id")
	}
	if RetryExecutionID(base, 1) == RetryExecutionID(base, 2) {
		t.Fatal("a NEW attempt must produce a NEW id, or it collides with the retained task")
	}
	if RetryExecutionID(base, 1) == base {
		t.Fatal("a retry must not reuse the original id — that is the collision being fixed")
	}
}
