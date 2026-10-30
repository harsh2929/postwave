package runtime

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/hibiken/asynq"
)

// TestExecutionIDDistinguishesRuns pins the fix for the re-enrollment failure,
// which is silent in the worst possible way.
//
// asynq rejects a duplicate TaskID while the task still exists, and it RETAINS
// completed tasks for seven days. RedisQueue.Enqueue deliberately treats
// asynq.ErrTaskIDConflict as idempotent success — that is what makes a
// duplicate delivery safe. The consequence is that any two executions sharing
// an id are indistinguishable from a redelivery, and the second one is
// dropped with no error, no log, and no DLQ entry.
//
// So if NewExecutionID did not include the run, a subscriber's SECOND
// traversal of a flow would collide with the first run's retained task inside
// that seven-day window and never execute. The automation would look healthy;
// the subscriber would simply never be re-enrolled.
//
// RetryExecutionID's attempt component is already covered by requeue_test.go.
// The run component is the half that was not, and it is the one that carries
// the documented P0.
func TestExecutionIDDistinguishesRuns(t *testing.T) {
	const (
		automation = "auto-1"
		subscriber = "reader@example.com"
		node       = "send-welcome"
	)

	first := NewExecutionID(automation, subscriber, node, "run-1")
	second := NewExecutionID(automation, subscriber, node, "run-2")

	if first == second {
		t.Fatal(
			"a second traversal produces the same execution id as the first — " +
				"asynq will treat the re-enrollment as a duplicate and drop it silently",
		)
	}

	// Idempotent WITHIN a run: a redelivery of the same step must collide, or
	// a double delivery becomes a double send.
	if NewExecutionID(automation, subscriber, node, "run-1") != first {
		t.Error("the same (automation, subscriber, node, run) no longer yields a stable id")
	}
}

// TestEveryExecutionIDComponentIsLoadBearing checks that no component has
// become decorative. Dropping any one of them merges executions that must stay
// distinct — a shared id between two subscribers, two nodes, or two
// automations has the same silent-drop consequence as the run collision above.
func TestEveryExecutionIDComponentIsLoadBearing(t *testing.T) {
	base := NewExecutionID("auto-1", "a@example.com", "node-1", "run-1")

	for _, tc := range []struct {
		name string
		id   string
	}{
		{"automation", NewExecutionID("auto-2", "a@example.com", "node-1", "run-1")},
		{"subscriber", NewExecutionID("auto-1", "b@example.com", "node-1", "run-1")},
		{"node", NewExecutionID("auto-1", "a@example.com", "node-2", "run-1")},
		{"run", NewExecutionID("auto-1", "a@example.com", "node-1", "run-2")},
	} {
		if tc.id == base {
			t.Errorf("changing the %s does not change the execution id", tc.name)
		}
	}
}

// TestRetryIDsStayDistinctFromTheirBase re-states the requeue property from the
// composition side: a parked retry must not reuse the executing task's id, or
// asynq marks the ACTIVE task completed and the execution is never rescheduled.
func TestRetryIDsStayDistinctFromTheirBase(t *testing.T) {
	base := NewExecutionID("auto-1", "a@example.com", "node-1", "run-1")

	if RetryExecutionID(base, 1) == base {
		t.Error("a parked retry reuses the executing task's id; the task would be marked completed and never rescheduled")
	}
	if RetryExecutionID(base, 1) == RetryExecutionID(base, 2) {
		t.Error("two attempts share an id; the later attempt would be dropped as a duplicate")
	}
	// Two separate derivations on purpose: a redelivery recomputes the id.
	firstAttempt, redelivered := RetryExecutionID(base, 1), RetryExecutionID(base, 1)
	if firstAttempt != redelivered {
		t.Error("the same attempt is not stable; a redelivery would double-send")
	}
	// A retry of one run must not collide with a retry of another.
	other := NewExecutionID("auto-1", "a@example.com", "node-1", "run-2")
	if RetryExecutionID(base, 1) == RetryExecutionID(other, 1) {
		t.Error("retries of different runs collide")
	}
}

// TestConflictIsStillSwallowed guards the guard.
//
// Every assertion above matters only because Enqueue converts a duplicate id
// into silent success. If that ever changed — if a conflict surfaced as an
// error instead — collisions would become loud, and these tests would be
// protecting a property whose consequence had moved. Keeping the two facts in
// one file means the reasoning cannot quietly go stale.
func TestConflictIsStillSwallowed(t *testing.T) {
	src, err := os.ReadFile("queue.go")
	if err != nil {
		t.Fatalf("read queue.go: %v", err)
	}
	text := string(src)

	if !strings.Contains(text, "asynq.ErrTaskIDConflict") {
		t.Fatal("Enqueue no longer references ErrTaskIDConflict; re-check what a duplicate id now does")
	}
	if !strings.Contains(text, "errors.Is(err, asynq.ErrTaskIDConflict)") {
		t.Error("the conflict check is no longer an errors.Is comparison")
	}
	// The sentinel must still exist in the dependency, or the check above is
	// comparing against something that can never match.
	if errors.Is(nil, asynq.ErrTaskIDConflict) {
		t.Error("asynq.ErrTaskIDConflict compares equal to nil")
	}
}
