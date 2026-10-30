// SPDX-License-Identifier: MIT

package adapter

import (
	"context"
	"sync"
	"time"
)

// TokenBucket is a minimal, dependency-free token-bucket limiter. Each adapter
// constructs one with the source platform's documented quota:
//
//	Mailchimp uses a separate simultaneous-connection semaphore; its documented
//	10-request limit is not a per-second quota.
//	ConvertKit:  120 req/min  → NewTokenBucket(120, time.Minute, 120)
//
// Wait blocks until a token is available or ctx is canceled. Safe for
// concurrent use.
type TokenBucket struct {
	mu         sync.Mutex
	capacity   int
	tokens     float64
	refillRate float64 // tokens per second
	lastRefill time.Time
}

// NewTokenBucket returns a bucket that refills `count` tokens per `per`
// duration, up to `capacity` outstanding. Pass capacity == count for a strict
// per-window limit.
func NewTokenBucket(count int, per time.Duration, capacity int) *TokenBucket {
	if capacity <= 0 {
		capacity = count
	}
	return &TokenBucket{
		capacity:   capacity,
		tokens:     float64(capacity),
		refillRate: float64(count) / per.Seconds(),
		lastRefill: time.Now(),
	}
}

// Wait blocks until exactly one token is available. Returns ctx.Err() if the
// caller cancels.
func (b *TokenBucket) Wait(ctx context.Context) error {
	for {
		b.mu.Lock()
		b.refill()
		if b.tokens >= 1 {
			b.tokens--
			b.mu.Unlock()
			return nil
		}
		// Compute time until next token.
		needed := 1 - b.tokens
		wait := time.Duration(needed / b.refillRate * float64(time.Second))
		b.mu.Unlock()
		if wait <= 0 {
			wait = time.Millisecond
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// Debit records one request that has already been issued. Unlike Wait, Debit
// never blocks and may take the bucket balance below zero. Subsequent Wait
// calls repay that debt before admitting another request. This is useful when
// the rate-limit identity is learned only from the completed provider request:
// caller cancellation must not erase provider quota that was already spent.
func (b *TokenBucket) Debit() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	b.tokens--
}

func (b *TokenBucket) refill() {
	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens += elapsed * b.refillRate
	if b.tokens > float64(b.capacity) {
		b.tokens = float64(b.capacity)
	}
	b.lastRefill = now
}
