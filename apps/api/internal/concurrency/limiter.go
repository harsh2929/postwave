// SPDX-License-Identifier: AGPL-3.0-only

// Package concurrency provides a tiny bounded in-flight limiter. It exists so a
// burst of expensive AI-inference requests can't run unbounded — starving the
// upstream Voice/LLM service and the process's memory — while the send path
// needs the same box (G-35). It is a counting semaphore with non-blocking
// TryAcquire so a saturated handler sheds load with backpressure instead of
// queueing without limit.
package concurrency

// Limiter is a fixed-capacity semaphore. The zero value is unusable — call New.
type Limiter struct {
	slots chan struct{}
}

// New returns a limiter allowing at most n concurrent holders. n<1 defaults to 1.
func New(n int) *Limiter {
	if n < 1 {
		n = 1
	}
	return &Limiter{slots: make(chan struct{}, n)}
}

// TryAcquire takes a slot without blocking. It returns a release func and true
// on success, or (nil, false) when the limiter is saturated — the caller then
// sheds the request (e.g. 429/503). release is idempotent-safe to call once.
func (l *Limiter) TryAcquire() (release func(), ok bool) {
	select {
	case l.slots <- struct{}{}:
		return func() { <-l.slots }, true
	default:
		return nil, false
	}
}

// InFlight reports the current number of held slots (for metrics/tests).
func (l *Limiter) InFlight() int { return len(l.slots) }
