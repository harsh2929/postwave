package subscribers

// SUB-121 — consent-sync ledger tests. The DB-backed RecordEvent / RunRetrySweep
// / ListForSubscriber paths need a live pool (covered separately by db tests);
// here we lock the pure backoff schedule, the cap constant, error truncation,
// and the fail-closed adapter contract.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestConsentSyncBackoff_MonotonicAndBounded(t *testing.T) {
	// Attempts 1..3 are fixed short windows; later attempts grow but are capped.
	got := []time.Duration{
		consentSyncBackoff(1),
		consentSyncBackoff(2),
		consentSyncBackoff(3),
		consentSyncBackoff(4),
		consentSyncBackoff(5),
	}
	if got[0] != time.Minute {
		t.Errorf("attempt 1 = %v, want 1m", got[0])
	}
	if got[1] != 5*time.Minute {
		t.Errorf("attempt 2 = %v, want 5m", got[1])
	}
	if got[2] != 30*time.Minute {
		t.Errorf("attempt 3 = %v, want 30m", got[2])
	}
	// Non-decreasing.
	for i := 1; i < len(got); i++ {
		if got[i] < got[i-1] {
			t.Errorf("backoff decreased at attempt %d: %v < %v", i+1, got[i], got[i-1])
		}
	}
	// Bounded at 12h.
	if consentSyncBackoff(99) > 12*time.Hour {
		t.Errorf("backoff must be capped at 12h, got %v", consentSyncBackoff(99))
	}
}

func TestConsentSyncMaxAttempts(t *testing.T) {
	if consentSyncMaxAttempts != 5 {
		t.Errorf("max attempts = %d, want 5", consentSyncMaxAttempts)
	}
}

func TestTruncErr(t *testing.T) {
	long := strings.Repeat("x", 2000)
	if got := truncErr(long); len(got) != 1000 {
		t.Errorf("truncErr len = %d, want 1000", len(got))
	}
	if got := truncErr("short"); got != "short" {
		t.Errorf("truncErr should not change short strings, got %q", got)
	}
}

func TestConsentSyncEventConstants(t *testing.T) {
	if ConsentSyncEventUnsubscribe != "unsubscribe" {
		t.Errorf("unexpected unsubscribe event constant %q", ConsentSyncEventUnsubscribe)
	}
	if ConsentSyncStatusPending != "pending" || ConsentSyncStatusFailed != "failed" {
		t.Errorf("unexpected status constants")
	}
}

func TestRunRetrySweep_NilDelivererFailsClosed(t *testing.T) {
	l := &ConsentSyncLedger{} // no Deliverer, no Pool
	n, err := l.RunRetrySweep(context.Background(), "t1", 10)
	if !errors.Is(err, ErrConsentSyncUnavailable) {
		t.Fatalf("nil-deliverer sweep error = %v, want ErrConsentSyncUnavailable", err)
	}
	if n != 0 {
		t.Errorf("nil-deliverer sweep should process 0 rows, got %d", n)
	}
}
