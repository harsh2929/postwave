package runtime

import (
	"context"
	"fmt"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// TestEngine_RecordsStepMetricsApplied drives two subscribers through a single
// add_tag action node and asserts the engine rolls both completions into ONE
// per-node counter row (applied=2) — proving the rollup stays thin regardless
// of subscriber volume, the whole point of 1627_flow_step_metrics_rollup_unique.
func TestEngine_RecordsStepMetricsApplied(t *testing.T) {
	e, _, q, st, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes: []canonical.AutomationNode{
			{ID: "n1", Type: "action", Action: &canonical.AutomationAction{Kind: "add_tag", Tag: "welcomed"}},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "a@x.com", Status: canonical.StatusEnabled})
	r.PutSubscriber("t", canonical.Subscriber{Email: "b@x.com", Status: canonical.StatusEnabled})

	for _, email := range []string{"a@x.com", "b@x.com"} {
		if err := e.Trigger(context.Background(), "a", "list_join", email, nil); err != nil {
			t.Fatalf("trigger %s: %v", email, err)
		}
	}
	drain(t, e, q)

	rows, err := st.ListStepMetrics(context.Background(), "t", "a")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 rolled-up row, got %d: %+v", len(rows), rows)
	}
	got := rows[0]
	if got.NodeID != "n1" || got.ActionKind != "add_tag" {
		t.Fatalf("wrong identity: %+v", got)
	}
	if got.Applied != 2 || got.Failed != 0 || got.Skipped != 0 {
		t.Fatalf("want applied=2 failed=0 skipped=0, got %+v", got)
	}
}

// TestEngine_RecordsStepMetricFailed asserts a node error is recorded as a
// failed counter carrying the granular action_kind + the error message.
func TestEngine_RecordsStepMetricFailed(t *testing.T) {
	e, lm, q, st, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes: []canonical.AutomationNode{
			{ID: "n1", Type: "send_email", TemplateID: "10"},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "a@x.com", Status: canonical.StatusEnabled})
	lm.failNextErr = fmt.Errorf("listmonk down")

	if err := e.Trigger(context.Background(), "a", "list_join", "a@x.com", nil); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected a ready execution")
	}
	if err := e.Execute(context.Background(), exec); err == nil {
		t.Fatal("expected Execute to error on send failure")
	}

	rows, err := st.ListStepMetrics(context.Background(), "t", "a")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d: %+v", len(rows), rows)
	}
	got := rows[0]
	if got.NodeID != "n1" || got.ActionKind != "send_email" {
		t.Fatalf("wrong identity: %+v", got)
	}
	if got.Failed != 1 || got.Applied != 0 {
		t.Fatalf("want failed=1 applied=0, got %+v", got)
	}
	if got.Error == "" {
		t.Fatalf("want error message captured, got empty: %+v", got)
	}
}

// TestMemoryStore_StepMetricRollup exercises the store contract directly:
// accumulation across calls, deterministic ordering, and input validation.
func TestMemoryStore_StepMetricRollup(t *testing.T) {
	st := NewMemoryStore()
	ctx := context.Background()
	base := StepMetric{TenantID: "t", AutomationID: "a", NodeID: "n1", ActionKind: "add_tag"}

	for i := 0; i < 3; i++ {
		m := base
		m.Outcome = "applied"
		if err := st.RecordStepMetric(ctx, m); err != nil {
			t.Fatalf("applied %d: %v", i, err)
		}
	}
	fail := base
	fail.Outcome = "failed"
	fail.Error = "boom"
	if err := st.RecordStepMetric(ctx, fail); err != nil {
		t.Fatalf("failed: %v", err)
	}
	// A different, alphabetically-earlier node so we can assert ordering.
	other := StepMetric{TenantID: "t", AutomationID: "a", NodeID: "n0", ActionKind: "wait", Outcome: "skipped"}
	if err := st.RecordStepMetric(ctx, other); err != nil {
		t.Fatalf("skipped: %v", err)
	}

	rows, err := st.ListStepMetrics(ctx, "t", "a")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d: %+v", len(rows), rows)
	}
	if rows[0].NodeID != "n0" || rows[1].NodeID != "n1" {
		t.Fatalf("rows not sorted by node_id: %+v", rows)
	}
	n1 := rows[1]
	if n1.Applied != 3 || n1.Failed != 1 || n1.Error != "boom" {
		t.Fatalf("n1 rollup wrong: %+v", n1)
	}

	// Tenant isolation: a different tenant sees nothing.
	if rows, _ := st.ListStepMetrics(ctx, "other", "a"); len(rows) != 0 {
		t.Fatalf("tenant leak: %+v", rows)
	}

	// Validation: unknown outcome + missing keys are rejected.
	bad := base
	bad.Outcome = "bogus"
	if err := st.RecordStepMetric(ctx, bad); err == nil {
		t.Fatal("expected error for unknown outcome")
	}
	if err := st.RecordStepMetric(ctx, StepMetric{TenantID: "t", Outcome: "applied"}); err == nil {
		t.Fatal("expected error for missing identity keys")
	}
}
