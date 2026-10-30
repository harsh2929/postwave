package safego

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestGoWithoutWaitGroup confirms safego.Go still works when no
// process-wide WaitGroup is installed (the default zero state).
func TestGoWithoutWaitGroup(t *testing.T) {
	SetWaitGroup(nil)

	done := make(chan struct{})
	Go(nil, "test-no-wg", func() {
		close(done)
	})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("worker did not run within 1s")
	}
}

// TestGoWithWaitGroupTracks confirms that once SetWaitGroup installs a
// shared WG, subsequent Go calls Add(1) before the goroutine starts
// and Done() after it exits, so a wg.Wait() blocks until every worker
// has returned. This is the contract main.go's shutdown depends on.
func TestGoWithWaitGroupTracks(t *testing.T) {
	var wg sync.WaitGroup
	SetWaitGroup(&wg)
	t.Cleanup(func() { SetWaitGroup(nil) })

	const N = 25
	var exited int32
	gate := make(chan struct{})

	for i := 0; i < N; i++ {
		Go(nil, "test-tracked", func() {
			<-gate
			atomic.AddInt32(&exited, 1)
		})
	}

	// Workers are blocked on `gate`. Wait should not return yet.
	select {
	case <-waitCh(&wg):
		t.Fatalf("Wait returned before workers exited")
	case <-time.After(20 * time.Millisecond):
	}

	close(gate)

	// Now workers can exit; wg.Wait must return.
	select {
	case <-waitCh(&wg):
	case <-time.After(2 * time.Second):
		t.Fatalf("wg.Wait did not return after workers were unblocked")
	}

	if got := atomic.LoadInt32(&exited); got != N {
		t.Fatalf("expected %d exited, got %d", N, got)
	}
}

// TestGoWithWaitGroupRecoversAndDones confirms Done() still fires even
// when the worker panics — otherwise a single misbehaving worker could
// hang the shutdown drain forever.
func TestGoWithWaitGroupRecoversAndDones(t *testing.T) {
	var wg sync.WaitGroup
	SetWaitGroup(&wg)
	t.Cleanup(func() { SetWaitGroup(nil) })

	Go(nil, "test-panic", func() {
		panic("boom")
	})

	select {
	case <-waitCh(&wg):
	case <-time.After(time.Second):
		t.Fatalf("wg.Wait did not return after panicking worker — Done was not called")
	}
}

// TestWaitReturnsTrueOnNilWG covers the no-op fast path used when
// SetWaitGroup was never called.
func TestWaitReturnsTrueOnNilWG(t *testing.T) {
	SetWaitGroup(nil)
	if !Wait(10 * time.Millisecond) {
		t.Fatalf("Wait should return true when no WG is installed")
	}
}

// TestWaitTimesOutWhenWorkerStuck covers the timeout branch — main.go
// caps the shutdown drain at 15s so a hung worker can't pin the
// process forever.
func TestWaitTimesOutWhenWorkerStuck(t *testing.T) {
	var wg sync.WaitGroup
	SetWaitGroup(&wg)
	t.Cleanup(func() { SetWaitGroup(nil) })

	unblock := make(chan struct{})
	Go(nil, "test-stuck", func() {
		<-unblock
	})

	if Wait(20 * time.Millisecond) {
		t.Fatalf("Wait should have timed out while the worker is blocked")
	}

	// Release the stuck worker so the test goroutine exits cleanly.
	close(unblock)
	if !Wait(time.Second) {
		t.Fatalf("Wait should return true once the worker exits")
	}
}

// waitCh adapts a WaitGroup to a select-friendly channel so the tests
// above can race Wait against a timeout.
func waitCh(wg *sync.WaitGroup) <-chan struct{} {
	ch := make(chan struct{})
	go func() {
		wg.Wait()
		close(ch)
	}()
	return ch
}
