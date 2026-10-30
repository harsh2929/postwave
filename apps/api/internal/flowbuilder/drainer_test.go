package flowbuilder

import (
	"context"
	"errors"
	"testing"
	"time"
)

// flow_runs stores the producer's event name, which is NOT the trigger type the
// runtime matches on: the tag producer writes "tag.added" (dotted) while the
// flow catalog and the automation runtime both use "tag_added" (underscored).
// A drainer that forwarded the raw stored name would be rejected as a non-match
// by Engine.Trigger — swapping one silent no-op for another.
func TestRunTriggerType_NormalisesProducerNames(t *testing.T) {
	cases := map[string]string{
		"tag.added":      "tag_added",
		"tag_added":      "tag_added",
		"tag.removed":    "tag_removed",
		"tag_removed":    "tag_removed",
		"list.joined":    "list_joined",
		"list_joined":    "list_joined",
		"segment_joined": "segment_joined",
		"":               "",
	}
	for in, want := range cases {
		if got := RunTriggerType(in); got != want {
			t.Errorf("RunTriggerType(%q) = %q, want %q", in, got, want)
		}
	}
}

// track already fans product events out to the automation service over HTTP on
// the ingest path, AND writes a flow_runs row. If the drainer fired those rows
// too, every product-event flow would run TWICE — and for a flow with
// re_enrollment='always' that means two sends per event.
//
// The drainer therefore claims those rows and retires them without re-firing.
func TestRunIsAlreadyDispatched_ProductEventsAreNotDoubleFired(t *testing.T) {
	if !runIsAlreadyDispatched("product_event") {
		t.Error("product_event is dispatched inline by track; re-firing it from the queue would double-send")
	}
	if runIsAlreadyDispatched("tag_added") {
		t.Error("tag_added has NO other dispatch path — the drainer is the only thing that can fire it")
	}
	if runIsAlreadyDispatched("list_joined") {
		t.Error("list_joined has NO other dispatch path")
	}
}

func TestLegacyDrainerFailsBeforeRawPoolOrNetworkAccess(t *testing.T) {
	drainer := &Drainer{}
	if _, err := drainer.Drain(context.Background()); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("Drain error = %v, want runtime unavailable", err)
	}
	if _, err := drainer.Requeue(context.Background(), time.Minute); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("Requeue error = %v, want runtime unavailable", err)
	}
	// Run must return immediately even with no pool/context deadline.
	drainer.Run(context.Background(), 0)
}

func TestDrainerFireRequiresInternalBearer(t *testing.T) {
	err := (&Drainer{}).fire(context.Background(), claimedRun{SubscriberEmail: "person@example.com", TriggerType: "tag_added"})
	if err == nil || err.Error() != "flow_runs: internal API bearer is not configured" {
		t.Fatalf("fire error = %v", err)
	}
}
