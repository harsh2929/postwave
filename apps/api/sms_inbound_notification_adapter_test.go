// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"testing"
	"time"
)

// The collapsing window is the whole safety property of COMMERCE#2: a reply
// storm to one SMS campaign must produce one notification per window, not one
// per reply. Assert the bucket is stable inside a window, moves across it, and
// does not depend on the local zone (replicas may run anywhere).
func TestInboundSMSDedupeKeyCollapsesAWindow(t *testing.T) {
	t.Parallel()

	// Bucketing is a fixed UTC grid (Truncate), not a sliding window anchored
	// on the first message: two replicas must agree without sharing state.
	// Start on a grid boundary so the intent of each offset is unambiguous.
	base := time.Date(2026, 7, 27, 10, 0, 0, 0, time.UTC)
	first := inboundSMSDedupeKey(base)
	for _, offset := range []time.Duration{
		0, time.Second, 90 * time.Second, 14*time.Minute + 59*time.Second,
	} {
		if got := inboundSMSDedupeKey(base.Add(offset)); got != first {
			t.Fatalf("offset %s produced %q, want the same bucket %q", offset, got, first)
		}
	}
	if got := inboundSMSDedupeKey(base.Add(15 * time.Minute)); got == first {
		t.Fatalf("the next window reused bucket %q", got)
	}

	// Same instant, different wall-clock zone → same bucket.
	zone := time.FixedZone("UTC-7", -7*3600)
	if got := inboundSMSDedupeKey(base.In(zone)); got != first {
		t.Fatalf("zone-shifted instant produced %q, want %q", got, first)
	}
}

func TestInboundSMSDedupeKeyIsUsableWithoutAReceiveTimestamp(t *testing.T) {
	t.Parallel()

	if got := inboundSMSDedupeKey(time.Time{}); got == "sms.received:" || len(got) < len("sms.received:")+8 {
		t.Fatalf("zero timestamp produced an unusable key %q", got)
	}
}
