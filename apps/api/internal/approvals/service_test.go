// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the per-Request opt-out plumbing added to Service.Request. The
// historical bug these tests pin down is documented in handlers.go: the
// previous implementation of RequestApprovalHandler silenced the Notifier
// by mutating d.Service.Notifier across a request boundary, which raced
// against concurrent Request calls on the same shared Service. The fix
// is the WithSilencedNotifier() functional opt; these tests assert (a)
// the opt actually skips the Notifier, (b) the absence of the opt fires
// it, and (c) running both flavours concurrently produces the exact
// expected Notifier call count with no leakage between goroutines.
package approvals

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// recordingNotifier is a Notifier that increments a counter and records
// each NotifyRequested call. It is goroutine-safe so the concurrent test
// can hammer it from many goroutines.
type recordingNotifier struct {
	mu    sync.Mutex
	calls int32
	seen  []string // approval IDs observed
}

func (n *recordingNotifier) NotifyRequested(_ context.Context, _ string, a *Approval) error {
	atomic.AddInt32(&n.calls, 1)
	n.mu.Lock()
	n.seen = append(n.seen, a.ID)
	n.mu.Unlock()
	return nil
}

func (n *recordingNotifier) count() int { return int(atomic.LoadInt32(&n.calls)) }

// newTestService wires a Service whose insert path is bypassed by the
// passed insertFn. Avoids the real Repo (and hence pgx) so the unit
// tests stay hermetic. The insertFn assigns a deterministic id to each
// row so the recordingNotifier can de-dupe / count by id.
func newTestService(notifier Notifier, idFn func() string) *Service {
	s := &Service{
		Notifier: notifier,
		Now:      func() time.Time { return time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC) },
		TTL:      time.Hour,
	}
	s.insertFn = func(_ context.Context, a *Approval) error {
		a.ID = idFn()
		return nil
	}
	return s
}

// TestRequest_FiresNotifierWithoutOpts is the baseline: a Request with no
// opts must invoke the configured Notifier. We wait on a synced channel
// rather than time.Sleep so the test is robust on slow CI workers.
func TestRequest_FiresNotifierWithoutOpts(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 1)
	notifier := &chanNotifier{done: done}
	svc := newTestService(notifier, idGen("a"))

	a, err := svc.Request(context.Background(), "tenant-1",
		Resource{Type: ResourceCampaign, ID: "camp-1"},
		Actor{Type: "user", Label: "user-1"})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if a == nil || a.ID == "" {
		t.Fatalf("expected approval row, got %#v", a)
	}
	select {
	case <-done:
		// good — notifier fired
	case <-time.After(2 * time.Second):
		t.Fatalf("Notifier was not called within 2s; expected exactly one call")
	}
}

// TestRequest_SilencedNotifier asserts the opt actually skips the hook.
// We give the goroutine a small grace window before declaring "no
// notifier fired"; the chanNotifier would push to `done` if it fired.
func TestRequest_SilencedNotifier(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 1)
	notifier := &chanNotifier{done: done}
	svc := newTestService(notifier, idGen("a"))

	if _, err := svc.Request(context.Background(), "tenant-1",
		Resource{Type: ResourceCampaign, ID: "camp-1"},
		Actor{Type: "user", Label: "user-1"},
		WithSilencedNotifier()); err != nil {
		t.Fatalf("Request: %v", err)
	}
	select {
	case <-done:
		t.Fatalf("Notifier fired despite WithSilencedNotifier() opt")
	case <-time.After(150 * time.Millisecond):
		// good — silence held
	}
}

// TestRequest_NilNotifierAndNoOpts asserts the no-Notifier path is a
// no-op (was already the case; pinned here so a regression in the new
// dispatch logic doesn't accidentally panic on s.Notifier = nil).
func TestRequest_NilNotifierAndNoOpts(t *testing.T) {
	t.Parallel()
	svc := newTestService(nil, idGen("a"))
	if _, err := svc.Request(context.Background(), "tenant-1",
		Resource{Type: ResourceCampaign, ID: "camp-1"},
		Actor{Type: "user", Label: "user-1"}); err != nil {
		t.Fatalf("Request: %v", err)
	}
}

// TestRequest_ConcurrentSilenceIsRaceFree spawns 10 goroutines, half with
// WithSilencedNotifier and half without, and asserts the Notifier count
// is exactly 5. Under the old shared-state mutation hack this number
// could be anywhere in [0, 10] depending on goroutine interleaving;
// with the per-call requestState struct it must be deterministic.
//
// The "exactly 5" check is the regression guard for the documented
// race in apps/api/internal/approvals/handlers.go.
func TestRequest_ConcurrentSilenceIsRaceFree(t *testing.T) {
	t.Parallel()
	const n = 10
	const expectedFires = 5

	notifier := &recordingNotifier{}
	svc := newTestService(notifier, idGen("c"))

	// Buffered so a slow Notifier dispatch doesn't deadlock.
	wg := &sync.WaitGroup{}
	wg.Add(n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		i := i
		go func() {
			defer wg.Done()
			<-start // align goroutines on the same starting line
			var opts []RequestOpt
			if i%2 == 0 {
				opts = append(opts, WithSilencedNotifier())
			}
			if _, err := svc.Request(context.Background(), "tenant-1",
				Resource{Type: ResourceCampaign, ID: "camp-1"},
				Actor{Type: "user", Label: "user-1"}, opts...); err != nil {
				t.Errorf("Request[%d]: %v", i, err)
			}
		}()
	}
	close(start)
	wg.Wait()

	// Notifier dispatches in a goroutine. Wait for the count to settle:
	// poll up to 2s, then assert the final value is exactly 5.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if notifier.count() >= expectedFires {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Give a 50ms grace so any straggler fires (which would push count
	// over the expected number) gets observed before we assert equality.
	time.Sleep(50 * time.Millisecond)
	if got := notifier.count(); got != expectedFires {
		t.Errorf("notifier call count: want %d, got %d (race regression suspected)", expectedFires, got)
	}
}

// chanNotifier signals on a channel each time NotifyRequested fires.
// Distinct from recordingNotifier so the simple "did it fire / didn't
// it fire" tests don't have to poll a counter.
type chanNotifier struct {
	done chan<- struct{}
}

func (c *chanNotifier) NotifyRequested(_ context.Context, _ string, _ *Approval) error {
	select {
	case c.done <- struct{}{}:
	default:
	}
	return nil
}

type deadlineNotifier struct {
	done chan<- bool
}

func (d deadlineNotifier) NotifyRequested(ctx context.Context, _ string, _ *Approval) error {
	_, ok := ctx.Deadline()
	select {
	case d.done <- ok:
	default:
	}
	return nil
}

func TestRequest_NotifiesWithBoundedContext(t *testing.T) {
	t.Parallel()
	done := make(chan bool, 1)
	svc := newTestService(deadlineNotifier{done: done}, idGen("bounded"))

	if _, err := svc.Request(context.Background(), "tenant-1",
		Resource{Type: ResourceCampaign, ID: "camp-1"},
		Actor{Type: "user", Label: "user-1"}); err != nil {
		t.Fatalf("Request: %v", err)
	}

	select {
	case hasDeadline := <-done:
		if !hasDeadline {
			t.Fatal("notifier context has no deadline")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Notifier was not called within 2s")
	}
}

type panicNotifier struct {
	done chan<- struct{}
}

func (p panicNotifier) NotifyRequested(_ context.Context, _ string, _ *Approval) error {
	select {
	case p.done <- struct{}{}:
	default:
	}
	panic("notifier exploded")
}

func TestNotifyRequestedBestEffortRecoversPanic(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 1)
	notifyRequestedBestEffort(context.Background(), panicNotifier{done: done}, "tenant-1", &Approval{ID: "approval-1"})
	select {
	case <-done:
		// good — the notifier ran and its panic was recovered.
	default:
		t.Fatal("panic notifier was not invoked")
	}
}

func TestSweepExpiredFailsCleanlyWhenRepoMissing(t *testing.T) {
	t.Parallel()
	if _, err := (*Service)(nil).SweepExpired(context.Background()); err == nil {
		t.Fatal("expected nil service sweep to return an error")
	}
	if _, err := (&Service{}).SweepExpired(context.Background()); err == nil {
		t.Fatal("expected nil repo sweep to return an error")
	}
}

func TestSweepExpiredRecoversRepoPanic(t *testing.T) {
	t.Parallel()
	_, err := (&Service{Repo: &Repo{}}).SweepExpired(context.Background())
	if err == nil || !strings.Contains(err.Error(), "approvals sweep panic") {
		t.Fatalf("err = %v; want recovered sweep panic", err)
	}
}

// idGen returns a closure that hands out monotonically-numbered ids
// (`prefix-1`, `prefix-2`, …). The test inserter assigns these to
// Approval.ID so other layers (e.g. the recordingNotifier) can reason
// about which call corresponds to which goroutine.
func idGen(prefix string) func() string {
	var n int64
	return func() string {
		i := atomic.AddInt64(&n, 1)
		return prefix + "-" + itoa(i)
	}
}

// itoa is a tiny strconv-free int → string for the id helper. Avoids
// the `strconv` import for a single use site.
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
