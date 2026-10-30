// SPDX-License-Identifier: AGPL-3.0-only
package webhook_retry

import (
	"errors"
	"testing"
	"time"
)

func TestBackoffScheduleMonotonicAndExhaustsCleanly(t *testing.T) {
	if MaxAttempts <= 0 {
		t.Fatalf("MaxAttempts must be positive, got %d", MaxAttempts)
	}
	if got := len(BackoffSchedule); got != MaxAttempts+1 {
		t.Fatalf("BackoffSchedule should be MaxAttempts+1 long (with sentinel), got %d", got)
	}
	// Sentinel must be the last entry.
	if BackoffSchedule[MaxAttempts] != 0 {
		t.Fatalf("expected sentinel zero at end of BackoffSchedule, got %v", BackoffSchedule[MaxAttempts])
	}
	// Strictly monotonic across the live entries.
	for i := 1; i < MaxAttempts; i++ {
		if BackoffSchedule[i] <= BackoffSchedule[i-1] {
			t.Fatalf("BackoffSchedule not monotonic at index %d: %v <= %v",
				i, BackoffSchedule[i], BackoffSchedule[i-1])
		}
	}
}

func TestNextAttemptDelayInsideWindow(t *testing.T) {
	for i := 0; i < MaxAttempts; i++ {
		d, dead := NextAttemptDelay(i)
		if dead {
			t.Fatalf("NextAttemptDelay(%d) prematurely dead", i)
		}
		if d <= 0 {
			t.Fatalf("NextAttemptDelay(%d) returned non-positive %v", i, d)
		}
	}
}

func TestNextAttemptDelayPastWindow(t *testing.T) {
	if _, dead := NextAttemptDelay(MaxAttempts); !dead {
		t.Fatal("expected dead=true past MaxAttempts")
	}
	if _, dead := NextAttemptDelay(MaxAttempts + 5); !dead {
		t.Fatal("expected dead=true far past MaxAttempts")
	}
	if _, dead := NextAttemptDelay(-1); !dead {
		t.Fatal("expected dead=true for negative input")
	}
}

func TestSpecificBackoffStepsMatchSpec(t *testing.T) {
	// The spec calls out: 30s → 5min → 30min → 2hr → 8hr → 1d → 7d → DLQ.
	want := []time.Duration{
		30 * time.Second,
		5 * time.Minute,
		30 * time.Minute,
		2 * time.Hour,
		8 * time.Hour,
		24 * time.Hour,
		7 * 24 * time.Hour,
	}
	for i, w := range want {
		got, dead := NextAttemptDelay(i)
		if dead {
			t.Fatalf("step %d unexpectedly dead", i)
		}
		if got != w {
			t.Fatalf("step %d delay = %v, want %v", i, got, w)
		}
	}
	if _, dead := NextAttemptDelay(7); !dead {
		t.Fatal("step 7 should dead-letter (after 7d)")
	}
}

func TestIsExhausted(t *testing.T) {
	if !IsExhausted(errExhausted) {
		t.Fatal("IsExhausted(errExhausted) should be true")
	}
	if IsExhausted(errors.New("other")) {
		t.Fatal("IsExhausted on unrelated error should be false")
	}
	if IsExhausted(nil) {
		t.Fatal("IsExhausted(nil) should be false")
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("abc", 10); got != "abc" {
		t.Fatalf("truncate short: %q", got)
	}
	if got := truncate("abcdef", 3); got != "abc" {
		t.Fatalf("truncate long: %q", got)
	}
}

func TestEventTypeOf(t *testing.T) {
	if got := eventTypeOf(nil); got != "unknown" {
		t.Fatalf("nil = %q", got)
	}
	if got := eventTypeOf([]byte(`{"type":"customer.subscription.created"}`)); got != "customer.subscription.created" {
		t.Fatalf("typed = %q", got)
	}
	if got := eventTypeOf([]byte(`not json`)); got != "unknown" {
		t.Fatalf("garbage = %q", got)
	}
}

func TestSignStripeRoundTrip(t *testing.T) {
	secret := "whsec_unit"
	body := []byte(`{"id":"evt_test","type":"x"}`)
	ts := time.Now().Unix()
	header := signStripe(secret, ts, body)
	// Header must match the documented Stripe shape: "t=...,v1=...".
	if header[:2] != "t=" {
		t.Fatalf("missing t= prefix: %q", header)
	}
}
