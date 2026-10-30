package flowbuilder

import (
	"encoding/json"
	"testing"
)

// The flow canvas could not be positioned: flow-layout.ts derives coordinates
// by BFS on every render, its own header explaining that "the flow AST carries
// no coordinates (it's an engine artifact)", and flow-canvas.tsx had zero drag
// handlers. Klaviyo and Braze both ship a positioned drag-drop journey canvas;
// this was the most visible competitive gap in the product UI.
//
// The fix needs the AST to carry an OPTIONAL position per node. This test pins
// the assumption the whole feature rests on: FlowGraph.Nodes is []map[string]any,
// so an unknown "position" key must survive a save/load round-trip untouched —
// no migration, no Go type change, and the engine keeps ignoring it (position is
// presentation, not semantics).
func TestFlowGraph_PreservesNodePositionRoundTrip(t *testing.T) {
	raw := []byte(`{
	  "entry_id": "n1",
	  "nodes": [
	    {"id":"n1","type":"send_email","template_id":"7","position":{"x":120,"y":48}},
	    {"id":"n2","type":"exit"}
	  ],
	  "edges": [{"from":"n1","to":"n2"}]
	}`)

	var graph FlowGraph
	if err := json.Unmarshal(raw, &graph); err != nil {
		t.Fatal(err)
	}
	// normalizeGraph runs on every save path — it must not strip the key.
	normalizeGraph(&graph)

	out, err := json.Marshal(graph)
	if err != nil {
		t.Fatal(err)
	}
	var back FlowGraph
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}

	pos, ok := back.Nodes[0]["position"].(map[string]any)
	if !ok {
		t.Fatalf("position was dropped on round-trip; node = %#v", back.Nodes[0])
	}
	if pos["x"] != float64(120) || pos["y"] != float64(48) {
		t.Fatalf("position corrupted: %#v", pos)
	}
	// A node with no position must stay position-less — the canvas falls back to
	// auto-layout for it rather than pinning it at (0,0).
	if _, present := back.Nodes[1]["position"]; present {
		t.Fatal("an unpositioned node must not gain a position")
	}
}

// Validation must ignore position entirely: it is presentation. The graph
// remains structurally valid; end-to-end execution is independently contained.
func TestValidate_IgnoresNodePosition(t *testing.T) {
	out := ValidateFlowGraph(FlowGraph{
		EntryID: "n1",
		Nodes: []map[string]any{
			{"id": "n1", "type": "send_email", "action": map[string]any{"template_id": "7"},
				"position": map[string]any{"x": 10, "y": 20}},
		},
	})
	if !out.Valid || out.Executable {
		t.Fatalf("a positioned node must validate while runtime stays unavailable: %+v", out)
	}
}

func TestNormalizeGraph_ClampsHostileNodePositions(t *testing.T) {
	graph := FlowGraph{Nodes: []map[string]any{
		{"id": "n1", "type": "exit", "position": map[string]any{"x": -10, "y": 1e12}},
		{"id": "n2", "type": "exit", "position": map[string]any{"x": "bad", "y": 2}},
	}}

	normalizeGraph(&graph)
	position := graph.Nodes[0]["position"].(map[string]any)
	if position["x"] != float64(0) || position["y"] != float64(maxFlowCanvasCoordinate) {
		t.Fatalf("position not clamped: %#v", position)
	}
	if _, exists := graph.Nodes[1]["position"]; exists {
		t.Fatalf("malformed position must be removed: %#v", graph.Nodes[1])
	}
}

// The re-enrollment policy (migration 1705) existed as a column that the
// flowbuilder API never read or wrote — so it was settable only by hand in the
// database, and the UI could not offer it at all. These pin the contract the
// editor depends on.
func TestValidReEnrollment(t *testing.T) {
	for _, ok := range []string{"once", "always", "cooldown", "ALWAYS", " once "} {
		if !ValidReEnrollment(ok) {
			t.Errorf("ValidReEnrollment(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", "sometimes", "always-ish", "1"} {
		if ValidReEnrollment(bad) {
			t.Errorf("ValidReEnrollment(%q) = true, want false", bad)
		}
	}
}

// A PATCH that omits the policy must LEAVE IT ALONE. Without the pointer +
// COALESCE, saving a name change would silently reset a re-enrollable
// abandoned-cart flow back to fire-once — re-introducing the exact bug the
// policy exists to fix.
func TestFlowInput_OmittedPolicyIsDistinguishableFromZero(t *testing.T) {
	var in FlowInput
	if err := json.Unmarshal([]byte(`{"name":"Renamed"}`), &in); err != nil {
		t.Fatal(err)
	}
	if in.ReEnrollment != nil {
		t.Fatal("an omitted re_enrollment must decode to nil, not \"\" — otherwise a rename resets the policy")
	}

	if err := json.Unmarshal([]byte(`{"re_enrollment":"always"}`), &in); err != nil {
		t.Fatal(err)
	}
	if in.ReEnrollment == nil || *in.ReEnrollment != "always" {
		t.Fatalf("re_enrollment did not decode: %#v", in.ReEnrollment)
	}
}
