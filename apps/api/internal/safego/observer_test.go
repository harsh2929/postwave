package safego

import (
	"sync"
	"testing"
	"time"
)

type recordingObserver struct {
	mu      sync.Mutex
	started []string
	exited  []struct {
		name     string
		panicked bool
	}
}

func (o *recordingObserver) WorkerStarted(name string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.started = append(o.started, name)
}

func (o *recordingObserver) WorkerExited(name string, panicked bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.exited = append(o.exited, struct {
		name     string
		panicked bool
	}{name, panicked})
}

func (o *recordingObserver) snapshot() ([]string, []struct {
	name     string
	panicked bool
}) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.started...), append([]struct {
		name     string
		panicked bool
	}(nil), o.exited...)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition not met within 2s")
}

// Every worker in the API is spawned through this one function, so an observer
// here is the only way to learn the fleet's shape without editing 81 call
// sites -- and without any of them being able to forget.
func TestGo_ReportsStartAndCleanExit(t *testing.T) {
	obs := &recordingObserver{}
	SetObserver(obs)
	t.Cleanup(func() { SetObserver(nil) })

	done := make(chan struct{})
	Go(nil, "test-clean", func() { close(done) })
	<-done

	waitFor(t, func() bool {
		_, exited := obs.snapshot()
		return len(exited) == 1
	})
	started, exited := obs.snapshot()
	if len(started) != 1 || started[0] != "test-clean" {
		t.Fatalf("start must be reported once with the worker name, got %v", started)
	}
	if exited[0].name != "test-clean" || exited[0].panicked {
		t.Fatalf("a clean return must report exited-without-panic, got %+v", exited[0])
	}
}

// A panicking worker is already swallowed so it cannot take down the process.
// That is correct and it is also exactly how a worker dies silently, so the
// exit must reach the observer flagged as a panic.
func TestGo_ReportsPanickingExit(t *testing.T) {
	obs := &recordingObserver{}
	SetObserver(obs)
	t.Cleanup(func() { SetObserver(nil) })

	Go(nil, "test-panic", func() { panic("boom") })

	waitFor(t, func() bool {
		_, exited := obs.snapshot()
		return len(exited) == 1
	})
	_, exited := obs.snapshot()
	if exited[0].name != "test-panic" || !exited[0].panicked {
		t.Fatalf("a panicking worker must report panicked=true, got %+v", exited[0])
	}
}

// The observer is optional and installed at boot. A nil observer must not
// change any existing behaviour -- including the panic recovery, which is the
// whole reason this package exists.
func TestGo_NilObserverStillRecoversPanics(t *testing.T) {
	SetObserver(nil)
	finished := make(chan struct{})
	Go(nil, "test-nil-observer", func() {
		defer close(finished)
		panic("boom")
	})
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not run with a nil observer")
	}
}

// An observer that panics must not escalate into the worker's goroutine: a
// monitoring bug taking down the thing it monitors is the worst possible
// failure mode for this seam.
func TestGo_PanickingObserverCannotKillTheWorker(t *testing.T) {
	SetObserver(panickingObserver{})
	t.Cleanup(func() { SetObserver(nil) })

	ran := make(chan struct{})
	Go(nil, "test-bad-observer", func() { close(ran) })

	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("a panicking observer must not stop the worker from running")
	}
	// Give the deferred exit report a chance to panic too; the test process
	// surviving is the assertion.
	time.Sleep(50 * time.Millisecond)
}

type panickingObserver struct{}

func (panickingObserver) WorkerStarted(string)      { panic("observer start boom") }
func (panickingObserver) WorkerExited(string, bool) { panic("observer exit boom") }
