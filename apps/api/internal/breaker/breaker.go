// SPDX-License-Identifier: AGPL-3.0-only

// Package breaker is a minimal in-memory circuit breaker and an http.RoundTripper
// that trips on a provider's repeated failures. It exists so outbound integrations
// — the LLM providers first — stop hammering a failing upstream (and stop making
// callers wait out the full timeout on every request) once it is clearly down,
// then probe for recovery after a cooldown. Unlike the audit sink's DB-backed
// breaker, this holds no persistent state: it is per-process and per-client.
package breaker

import (
	"errors"
	"net/http"
	"sync"
	"time"
)

// ErrOpen is returned by the RoundTripper when the circuit is open.
var ErrOpen = errors.New("breaker: circuit open (upstream failing)")

// Breaker is a consecutive-failure circuit breaker. Safe for concurrent use.
type Breaker struct {
	mu        sync.Mutex
	failures  int
	openedAt  time.Time
	threshold int
	cooldown  time.Duration
	now       func() time.Time
}

// New returns a breaker that opens after `threshold` consecutive failures and
// stays open for `cooldown` before allowing a probe. threshold<1 defaults to 5.
func New(threshold int, cooldown time.Duration) *Breaker {
	if threshold < 1 {
		threshold = 5
	}
	if cooldown <= 0 {
		cooldown = 30 * time.Second
	}
	return &Breaker{threshold: threshold, cooldown: cooldown, now: time.Now}
}

// Allow reports whether a call may proceed: true when closed, or when the
// cooldown has elapsed (a half-open probe). Concurrent probes are permitted —
// a single failure re-opens the circuit, which is acceptable for LLM calls.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openedAt.IsZero() {
		return true
	}
	return b.now().Sub(b.openedAt) >= b.cooldown
}

// Success closes the circuit and clears the failure count.
func (b *Breaker) Success() {
	b.mu.Lock()
	b.failures = 0
	b.openedAt = time.Time{}
	b.mu.Unlock()
}

// Failure records a failure and opens the circuit at the threshold.
func (b *Breaker) Failure() {
	b.mu.Lock()
	b.failures++
	if b.failures >= b.threshold {
		b.openedAt = b.now()
	}
	b.mu.Unlock()
}

type roundTripper struct {
	base http.RoundTripper
	b    *Breaker
}

// RoundTrip refuses when open; otherwise it delegates and counts transport
// errors and 5xx/429 responses as failures, everything else as success.
func (rt *roundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if !rt.b.Allow() {
		return nil, ErrOpen
	}
	resp, err := rt.base.RoundTrip(req)
	if err != nil || (resp != nil && (resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests)) {
		rt.b.Failure()
	} else {
		rt.b.Success()
	}
	return resp, err
}

// Transport wraps base (or http.DefaultTransport) with the breaker.
func Transport(base http.RoundTripper, b *Breaker) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &roundTripper{base: base, b: b}
}
