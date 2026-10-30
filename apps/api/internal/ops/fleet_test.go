// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"strings"
	"testing"
	"time"
)

func testFleet(now time.Time, specs ...WorkerSpec) *Fleet {
	f := NewFleet()
	f.now = func() time.Time { return now }
	f.bootedAt = now
	for _, s := range specs {
		f.Declare(s)
	}
	return f
}

var sendWorker = WorkerSpec{Name: "outbox-worker", Domain: "sending", Owner: "platform",
	Why: "queued mail stops leaving the building"}

// A declared worker that never started is the failure this exists to catch:
// a boot-order bug or a config gate silently skips a worker and nothing
// anywhere says so.
func TestFleet_DeclaredWorkerThatNeverStartedGoesRedAfterGrace(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)

	f.now = func() time.Time { return boot.Add(30 * time.Second) }
	if status, detail := f.Evaluate(); status != StatusOK {
		t.Fatalf("inside the boot grace window a worker may legitimately not have started yet; got %s %q", status, detail)
	}

	f.now = func() time.Time { return boot.Add(10 * time.Minute) }
	status, detail := f.Evaluate()
	if status != StatusRed {
		t.Fatalf("past the grace window a never-started worker is RED; got %s", status)
	}
	if !strings.Contains(detail, "outbox-worker") {
		t.Fatalf("the detail must name the missing worker, got %q", detail)
	}
}

func TestFleet_RunningDeclaredWorkerIsOK(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)
	f.WorkerStarted("outbox-worker")
	f.now = func() time.Time { return boot.Add(time.Hour) }

	if status, detail := f.Evaluate(); status != StatusOK {
		t.Fatalf("a running declared worker is OK; got %s %q", status, detail)
	}
}

// A panicking worker is swallowed by safego so the process survives. That is
// correct, and it is also exactly how a worker dies without anyone noticing.
func TestFleet_PanickedWorkerIsRed(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)
	f.WorkerStarted("outbox-worker")
	f.WorkerExited("outbox-worker", true)
	f.now = func() time.Time { return boot.Add(time.Hour) }

	status, detail := f.Evaluate()
	if status != StatusRed {
		t.Fatalf("a panicked worker is RED; got %s", status)
	}
	if !strings.Contains(detail, "panicked") {
		t.Fatalf("the detail must say it panicked, got %q", detail)
	}
}

// A clean exit is still an exit. Nothing is doing that work any more, and
// "it returned nil" is no comfort to the mail sitting in the queue.
func TestFleet_CleanlyExitedWorkerIsRed(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)
	f.WorkerStarted("outbox-worker")
	f.WorkerExited("outbox-worker", false)
	f.now = func() time.Time { return boot.Add(time.Hour) }

	if status, _ := f.Evaluate(); status != StatusRed {
		t.Fatalf("a cleanly exited worker is still not running; got %s", status)
	}
}

// Every worker exits during shutdown. A replica on its way out must not paint
// the shared board red for the replicas still serving.
func TestFleet_ExitsDuringShutdownAreNotRed(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)
	f.WorkerStarted("outbox-worker")
	f.BeginShutdown()
	f.WorkerExited("outbox-worker", false)
	f.now = func() time.Time { return boot.Add(time.Hour) }

	if status, detail := f.Evaluate(); status != StatusOK {
		t.Fatalf("shutdown exits are expected; got %s %q", status, detail)
	}
}

// The declaration list is the fleet's coverage denominator, and it rots the
// moment somebody adds a worker without declaring it. An undeclared worker
// running is not an outage, but it IS a hole in this check's own accounting,
// so it must say so rather than quietly ignoring what it does not recognise.
func TestFleet_UndeclaredRunningWorkerWarns(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)
	f.WorkerStarted("outbox-worker")
	f.WorkerStarted("brand-new-worker")
	f.now = func() time.Time { return boot.Add(time.Hour) }

	status, detail := f.Evaluate()
	if status != StatusWarn {
		t.Fatalf("an undeclared running worker is a WARN, not an outage; got %s", status)
	}
	if !strings.Contains(detail, "brand-new-worker") {
		t.Fatalf("the detail must name the undeclared worker, got %q", detail)
	}
}

// A real outage outranks a bookkeeping gap.
func TestFleet_RedBeatsUndeclaredWarn(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)
	f.WorkerStarted("brand-new-worker")
	f.now = func() time.Time { return boot.Add(time.Hour) }

	if status, _ := f.Evaluate(); status != StatusRed {
		t.Fatalf("a missing declared worker outranks an undeclared one; got %s", status)
	}
}

// A worker can be restarted by its supervisor after a panic. The fleet must
// track the CURRENT state, not the worst state it has ever seen, or one
// transient panic pins the board red forever and the row gets snoozed.
func TestFleet_RestartAfterPanicClearsRed(t *testing.T) {
	boot := time.Now()
	f := testFleet(boot, sendWorker)
	f.WorkerStarted("outbox-worker")
	f.WorkerExited("outbox-worker", true)
	f.WorkerStarted("outbox-worker")
	f.now = func() time.Time { return boot.Add(time.Hour) }

	if status, detail := f.Evaluate(); status != StatusOK {
		t.Fatalf("a restarted worker is running again; got %s %q", status, detail)
	}
}
