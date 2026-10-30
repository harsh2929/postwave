package flowbuilder

import "testing"

func TestCatalogIncludesKlaviyoParityNodes(t *testing.T) {
	cat := Catalog()
	if cat.Runtime.ExecutionEnabled || cat.Runtime.RuntimeStatus != "unavailable" {
		t.Fatalf("flow runtime = %+v, want unavailable", cat.Runtime)
	}
	nodes := map[string]CatalogItem{}
	for _, node := range cat.Nodes {
		nodes[node.Key] = node
	}
	for _, key := range []string{"send_email", "branch", "percentage_split", "webhook", "action", "manual_review"} {
		if _, ok := nodes[key]; !ok {
			t.Fatalf("missing node %s", key)
		}
	}
	if !nodes["send_email"].RequiresReview {
		t.Fatalf("send_email should carry review metadata")
	}
	for key, node := range nodes {
		if node.RuntimeStatus != "unavailable" {
			t.Fatalf("node %s runtime = %q, want unavailable", key, node.RuntimeStatus)
		}
	}
}

func TestValidateRejectsBrokenGraph(t *testing.T) {
	out := Validate(GraphValidateRequest{
		EntryID: "missing",
		Nodes: []NodeSpec{
			{ID: "n1", Type: "send_email"},
			{ID: "n1", Type: "mystery"},
		},
		Edges: []EdgeSpec{{From: "n1", To: "n2"}},
	})
	if out.Valid {
		t.Fatalf("expected invalid graph")
	}
	if len(out.Errors) < 3 {
		t.Fatalf("errors = %#v", out.Errors)
	}
}

func TestValidateAllowsSupportedGraphWithWarnings(t *testing.T) {
	out := Validate(GraphValidateRequest{
		EntryID: "entry",
		Nodes: []NodeSpec{
			{ID: "entry", Type: "wait"},
			{ID: "split", Type: "branch"},
			{ID: "end", Type: "exit"},
		},
		Edges: []EdgeSpec{{From: "entry", To: "split"}, {From: "split", To: "end"}},
	})
	if !out.Valid {
		t.Fatalf("expected valid graph: %#v", out.Errors)
	}
	if len(out.Warnings) == 0 {
		t.Fatalf("expected branch warning")
	}
}
