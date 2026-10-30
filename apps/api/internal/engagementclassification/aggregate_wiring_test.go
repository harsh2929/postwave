// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"strings"
	"testing"
)

// The production runtime must build its ingest hook WITH an aggregate builder.
//
// Four of the PRD's nine named rules — R_ALL_LINKS_FETCHED, R_CLICK_WITHOUT_OPEN,
// R_BURST and R_UA_MISMATCH — are message-level: they read sibling events for the
// same message, which is what MessageAggregate carries. IngestHook only populates
// one when AggregateBuilder is non-nil (integration.go:60).
//
// BuildRuntime constructed the hook without one, so at ingest those four rules
// could never fire and every event was classified on single-event evidence alone.
// The query they need already existed on the reclassification path — the same
// package, the same signature — so the capability was present and unreachable,
// which is the failure this repository keeps meeting.
//
// This is a SOURCE check rather than a behavioural one because BuildRuntime needs
// a live pool and a seeded registry; the defect is a missing field in a struct
// literal, and that is exactly what this asserts.
func TestBuildRuntimeGivesTheIngestHookAnAggregateBuilder(t *testing.T) {
	source := readSource(t, "runtime.go")
	start := strings.Index(source, "runtime := &Runtime{")
	if start < 0 {
		t.Fatal("could not find the Runtime literal in runtime.go")
	}
	end := strings.Index(source[start:], "\n\t}")
	if end < 0 {
		t.Fatal("could not find the end of the Runtime literal")
	}
	literal := source[start : start+end]

	if !strings.Contains(literal, "AggregateBuilder") {
		t.Fatalf("BuildRuntime composes IngestHook without an AggregateBuilder, so "+
			"R_ALL_LINKS_FETCHED, R_CLICK_WITHOUT_OPEN, R_BURST and R_UA_MISMATCH "+
			"can never fire at ingest — every event is classified on single-event "+
			"evidence and the unknown band is wider than the data warrants.\n\ngot:\n%s",
			literal)
	}
}

// And the four message-level rules must still be registered, so the test above
// is guarding something that exists.
func TestTheMessageLevelRulesAreRegistered(t *testing.T) {
	source := readSource(t, "classifier.go")
	for _, rule := range []string{
		"R_ALL_LINKS_FETCHED", "R_CLICK_WITHOUT_OPEN", "R_BURST", "R_UA_MISMATCH",
	} {
		if !strings.Contains(source, rule) {
			t.Errorf("%s is not registered; the aggregate wiring would feed nothing", rule)
		}
	}
}
