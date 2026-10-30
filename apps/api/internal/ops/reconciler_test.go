package ops

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// Not knowing is failure. A probe that panics is RED, not skipped, and not
// "unknown". Every broken surface in the audit got this backwards.
func TestRunProbe_PanicIsRed(t *testing.T) {
	rc := &Reconciler{}
	c := Check{ID: "t.panic", Probe: func(context.Context, *Env) (Status, string, error) {
		panic("boom")
	}}

	st, detail := rc.runProbe(context.Background(), c)

	if st != StatusRed {
		t.Fatalf("a panicking probe must be RED, got %q", st)
	}
	if !strings.Contains(detail, "panicked") {
		t.Fatalf("the detail must say the probe panicked, got %q", detail)
	}
}

func TestRunProbe_ErrorIsRed(t *testing.T) {
	rc := &Reconciler{}
	c := Check{ID: "t.err", Probe: func(context.Context, *Env) (Status, string, error) {
		return StatusOK, "", errors.New("dns exploded")
	}}

	st, detail := rc.runProbe(context.Background(), c)

	if st != StatusRed {
		t.Fatalf("an erroring probe must be RED, got %q", st)
	}
	if !strings.Contains(detail, "dns exploded") {
		t.Fatalf("the detail must carry the error, got %q", detail)
	}
}

func TestRunProbe_TimeoutIsRed(t *testing.T) {
	rc := &Reconciler{ProbeTimeout: 50 * time.Millisecond}
	c := Check{ID: "t.slow", Probe: func(ctx context.Context, _ *Env) (Status, string, error) {
		<-ctx.Done()
		return StatusOK, "", ctx.Err()
	}}

	st, _ := rc.runProbe(context.Background(), c)

	if st != StatusRed {
		t.Fatalf("a probe that exceeds its timeout must be RED, got %q", st)
	}
}
