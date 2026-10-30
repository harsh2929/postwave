// SPDX-License-Identifier: AGPL-3.0-only
//
// event_worker_test.go — SUB-029: live segment recompute worker. The DB
// drain paths require Postgres; these unit tests cover the pure helpers
// (placeholder renumbering, int formatting) and the worker's nil-safety
// + default cadence, which gate the worker's correctness without a live
// connection.
package segments

import (
	"context"
	"testing"
	"time"
)

func TestSegmentEventWorkerIntervalDefault(t *testing.T) {
	w := &SegmentEventWorker{}
	if w.interval() != defaultEventWorkerInterval {
		t.Fatalf("default interval = %v, want %v", w.interval(), defaultEventWorkerInterval)
	}
	w.Interval = 250 * time.Millisecond
	if w.interval() != 250*time.Millisecond {
		t.Fatalf("override interval = %v, want 250ms", w.interval())
	}
}

// Entrant detection costs a membership diff per refresh; both cache workers run
// it only when a forward would reach an automation runtime.
func TestEntrantsAreDetectedOnlyWhenForwarding(t *testing.T) {
	cases := []struct {
		name      string
		forwarder SegmentJoinForwarder
		want      bool
	}{
		{"no forwarder", nil, false},
		{"runtime not configured", &HTTPSegmentJoinForwarder{BaseURL: "  "}, false},
		{"runtime configured", &HTTPSegmentJoinForwarder{BaseURL: "http://automation.internal"}, true},
		{"forwarder without an on/off switch", &joinRecorder{}, true},
	}
	for _, tc := range cases {
		if got := ForwardingEnabled(tc.forwarder); got != tc.want {
			t.Errorf("%s: ForwardingEnabled = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestSegmentEventWorkerRunNilSafe(t *testing.T) {
	// Nil deps must not panic and must return (0,0) from RunOnce.
	var w *SegmentEventWorker
	if n, e := w.RunOnce(context.Background()); n != 0 || e != 0 {
		t.Fatalf("nil worker RunOnce = (%d,%d), want (0,0)", n, e)
	}
	w2 := &SegmentEventWorker{} // non-nil but no Pool/Repo
	if n, e := w2.RunOnce(context.Background()); n != 0 || e != 0 {
		t.Fatalf("empty worker RunOnce = (%d,%d), want (0,0)", n, e)
	}
	// Run on a nil-deps worker should return immediately (no Pool).
	w2.Run(context.Background())
}
