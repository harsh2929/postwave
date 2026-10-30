// SPDX-License-Identifier: AGPL-3.0-only

package flowbuilder

import "testing"

// A run has to say which graph it is executing.
//
// A flow is a program, and `automation_flow_versions` already stores every
// published version of it. What no run recorded is which one it enrolled under:
//
//   - An operator edits a live flow while runs are mid-journey. Did those runs
//     finish the graph they started or switch at their next step? The rows
//     could not say, and the two answers send different emails to the same
//     person.
//   - A run misbehaves and someone asks what the flow looked like at the time.
//     The flow's CURRENT graph is the wrong answer whenever it has been edited
//     since — which, for an active flow, is most of the time.
//   - A/B results and step metrics aggregate across runs that may have followed
//     structurally different graphs, with nothing to group or exclude by.
//
// The version is resolved at ENROLLMENT and stamped, so a later edit cannot
// change what an in-flight run is understood to have followed.

func TestTheEnqueueRequestCarriesAGraphVersion(t *testing.T) {
	// The field has to exist on the request for a caller to bind a run to the
	// version it resolved — otherwise the repo would have to re-resolve it and
	// could pick up an edit that landed in between.
	req := RunEnqueueRequest{
		FlowID:         "flow-1",
		SubscriberID:   "sub-1",
		GraphVersionID: "ver-1",
	}
	if req.GraphVersionID != "ver-1" {
		t.Fatal("RunEnqueueRequest cannot carry a graph version")
	}
}

func TestAnUnknownVersionIsNullNotGuessed(t *testing.T) {
	// A caller that cannot resolve a version must produce NULL, never the
	// flow's current one. Guessing is exactly the failure this column exists to
	// remove: it would assert that a run followed a graph it may never have
	// seen.
	if got := graphVersionArg(""); got != nil {
		t.Fatalf("an empty version became %v, want NULL", got)
	}
	if got := graphVersionArg("   "); got != nil {
		t.Fatalf("a blank version became %v, want NULL", got)
	}
	if got := graphVersionArg("ver-1"); got != "ver-1" {
		t.Fatalf("a real version became %v", got)
	}
}
