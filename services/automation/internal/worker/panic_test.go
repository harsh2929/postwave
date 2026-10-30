package worker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

func TestScannersRecoverTickPanics(t *testing.T) {
	ctx := context.Background()

	if err := (&DateTriggerScanner{}).tick(ctx); err == nil || !strings.Contains(err.Error(), "date_trigger scan panic") {
		t.Fatalf("date trigger tick err = %v; want recovered panic", err)
	}
	if err := (&BestSendHourScanner{}).tick(ctx); err == nil || !strings.Contains(err.Error(), "best_send_hour scan panic") {
		t.Fatalf("best send hour tick err = %v; want recovered panic", err)
	}
	if err := (&RecurrenceScanner{RuntimeEnabled: true}).tick(ctx); !errors.Is(err, campaigndispatch.ErrSchedulingUnqualified) {
		t.Fatalf("recurrence tick err = %v; want compile-time scheduling lock", err)
	}
}

func TestRecurrenceMutationEntrypointsFailBeforeDatabaseAccess(t *testing.T) {
	scanner := &RecurrenceScanner{RuntimeEnabled: true}
	processed, err := scanner.Trigger(context.Background())
	if processed != 0 {
		t.Fatalf("processed = %d; want 0 while scheduling is unqualified", processed)
	}
	if !errors.Is(err, campaigndispatch.ErrSchedulingUnqualified) {
		t.Fatalf("trigger err = %v; want compile-time scheduling lock", err)
	}
	if err := scanner.spawn(context.Background(), RecurrenceCandidate{}, time.Now()); !errors.Is(err, campaigndispatch.ErrSchedulingUnqualified) {
		t.Fatalf("spawn err = %v; want compile-time scheduling lock before DB access", err)
	}
}
