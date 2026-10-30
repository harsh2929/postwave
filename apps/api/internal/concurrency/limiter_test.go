// SPDX-License-Identifier: AGPL-3.0-only
package concurrency

import "testing"

func TestLimiter_ShedsWhenFull(t *testing.T) {
	l := New(2)
	r1, ok1 := l.TryAcquire()
	r2, ok2 := l.TryAcquire()
	_, ok3 := l.TryAcquire()
	if !ok1 || !ok2 || ok3 {
		t.Fatalf("capacity 2: got %v %v %v", ok1, ok2, ok3)
	}
	if l.InFlight() != 2 {
		t.Fatalf("in-flight = %d want 2", l.InFlight())
	}
	r1()
	if _, ok := l.TryAcquire(); !ok {
		t.Fatal("a released slot must be re-acquirable")
	}
	r2()
}
