// SPDX-License-Identifier: AGPL-3.0-only
package breaker

import (
	"testing"
	"time"
)

func TestBreaker_OpensAndProbes(t *testing.T) {
	clock := time.Unix(0, 0)
	b := New(3, 10*time.Second)
	b.now = func() time.Time { return clock }

	if !b.Allow() {
		t.Fatal("fresh breaker must allow")
	}
	b.Failure()
	b.Failure()
	if !b.Allow() {
		t.Fatal("below threshold must still allow")
	}
	b.Failure() // 3rd → open
	if b.Allow() {
		t.Fatal("at threshold the circuit must be open")
	}
	clock = clock.Add(11 * time.Second) // cooldown elapsed → half-open probe
	if !b.Allow() {
		t.Fatal("after cooldown a probe must be allowed")
	}
	b.Success() // probe ok → closed
	if !b.Allow() {
		t.Fatal("after success the circuit must be closed")
	}
}

func TestBreaker_SuccessResetsFailures(t *testing.T) {
	b := New(2, time.Second)
	b.Failure()
	b.Success()
	b.Failure()
	if !b.Allow() {
		t.Fatal("a success must reset the consecutive-failure count")
	}
}
