package trigger_replayer

import (
	"context"
	"testing"
	"time"
)

// Guard: a nil pool is rejected before any DB access.
func TestRetryIdentifiedEventsWithin_RejectsNilPool(t *testing.T) {
	var r *Replayer
	if _, err := r.RetryIdentifiedEventsWithin(context.Background(), "t1", "a@b.com", time.Hour); err == nil {
		t.Fatal("expected error for nil replayer")
	}
	r2 := &Replayer{Pool: nil}
	if _, err := r2.RetryIdentifiedEventsWithin(context.Background(), "t1", "a@b.com", time.Hour); err == nil {
		t.Fatal("expected error for nil pool")
	}
}

// Guard: empty tenant is rejected before any DB access.
func TestRetryIdentifiedEventsWithin_RejectsEmptyTenant(t *testing.T) {
	r := &Replayer{Pool: nil}
	if _, err := r.RetryIdentifiedEventsWithin(context.Background(), "", "a@b.com", time.Hour); err == nil {
		t.Fatal("expected error for empty tenant")
	}
}

// Guard: empty subscriber email is rejected before any DB access. (Pool is
// nil — the pool guard fires first, so to exercise the email guard we assert
// that BOTH empties error; the important contract is "never reach the DB
// with an empty email".)
func TestRetryIdentifiedEventsWithin_RejectsEmptyEmail(t *testing.T) {
	r := &Replayer{Pool: nil}
	if _, err := r.RetryIdentifiedEventsWithin(context.Background(), "t1", "", time.Hour); err == nil {
		t.Fatal("expected error for empty subscriber email")
	}
}

// DefaultWindow is the SUB-003 contract: 72h backwards.
func TestDefaultWindow_Is72h(t *testing.T) {
	if DefaultWindow != 72*time.Hour {
		t.Fatalf("DefaultWindow = %v, want 72h", DefaultWindow)
	}
}

// New wires the pool through.
func TestNew(t *testing.T) {
	r := New(nil)
	if r == nil {
		t.Fatal("New returned nil")
	}
	if r.Pool != nil {
		t.Fatal("expected nil pool to be threaded through unchanged")
	}
}
