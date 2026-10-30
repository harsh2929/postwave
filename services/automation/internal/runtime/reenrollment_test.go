package runtime

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// The execution row's primary key was sha256(automation_id | email), and
// completed_nodes was union-merged and never cleared. So a subscriber could
// traverse any given flow exactly ONCE, ever: a second trigger re-upserted
// current_node = entry, but entry was already in completed_nodes, so the
// execution was acked immediately and the journey never ran.
//
// That is the core of marketing automation. Abandoned-cart, browse-abandon,
// win-back, birthday, back-in-stock, replenishment — every recurring flow —
// fired at most once per person per lifetime. A customer who abandoned a cart
// twice got one email, forever.
func TestReEnrollment_AlwaysLetsASubscriberReEnter(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		ReEnrollment: canonical.ReEnrollAlways,
		Triggers:     []canonical.AutomationTrigger{{Type: "cart_abandoned"}},
		EntryID:      "n1",
		Nodes:        []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})

	// Abandons a cart on Monday.
	if err := e.Trigger(context.Background(), "a", "cart_abandoned", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	// Abandons another cart on Friday. This must send again.
	if err := e.Trigger(context.Background(), "a", "cart_abandoned", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(lm.sends) != 2 {
		t.Fatalf("a re-enrollable flow must fire once per trigger; sent %d, want 2", len(lm.sends))
	}
}

// The default MUST stay fire-once. Shipping re-enrollment with an "always"
// default would make every subscriber who ever completed a flow eligible
// again the moment it deployed — a mass re-send of the entire history, which
// is both irreversible and a fast way to burn a sending domain.
func TestReEnrollment_DefaultsToOnceAndPreservesTodaysBehaviour(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		// ReEnrollment deliberately left as the zero value.
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})

	for i := 0; i < 3; i++ {
		if err := e.Trigger(context.Background(), "a", "list_join", "u@x.com", nil); err != nil {
			t.Fatal(err)
		}
		drain(t, e, q)
	}

	if len(lm.sends) != 1 {
		t.Fatalf("the default must remain fire-once; sent %d, want 1", len(lm.sends))
	}
}

// Each run must start with a clean slate. If completed_nodes leaked across
// runs the second journey would short-circuit on the entry node exactly as
// the original bug did.
func TestReEnrollment_EachRunStartsWithCleanCompletedNodes(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		ReEnrollment: canonical.ReEnrollAlways,
		Triggers:     []canonical.AutomationTrigger{{Type: "cart_abandoned"}},
		EntryID:      "n1",
		Nodes: []canonical.AutomationNode{
			{ID: "n1", Type: "send_email", TemplateID: "1"},
			{ID: "n2", Type: "send_email", TemplateID: "2"},
		},
		Edges: []canonical.AutomationEdge{{From: "n1", To: "n2"}},
	})

	for i := 0; i < 2; i++ {
		if err := e.Trigger(context.Background(), "a", "cart_abandoned", "u@x.com", nil); err != nil {
			t.Fatal(err)
		}
		drain(t, e, q)
	}

	// Two nodes x two runs.
	if len(lm.sends) != 4 {
		t.Fatalf("each run must replay every node; sent %d, want 4", len(lm.sends))
	}
}

// Cooldown is the win-back / birthday shape: re-entry is wanted, but not
// unboundedly often.
func TestReEnrollment_CooldownBlocksUntilTheWindowElapses(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		ReEnrollment:  canonical.ReEnrollAfterCooldown,
		CooldownHours: 24,
		Triggers:      []canonical.AutomationTrigger{{Type: "went_cold"}},
		EntryID:       "n1",
		Nodes:         []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})
	base := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	e.Now = func() time.Time { return base }

	if err := e.Trigger(context.Background(), "a", "went_cold", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	// 12h later — inside the cooldown. Must NOT re-enter.
	e.Now = func() time.Time { return base.Add(12 * time.Hour) }
	if err := e.Trigger(context.Background(), "a", "went_cold", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 1 {
		t.Fatalf("inside the cooldown the subscriber must not re-enter; sent %d, want 1", len(lm.sends))
	}

	// 25h later — past the cooldown. Must re-enter.
	e.Now = func() time.Time { return base.Add(25 * time.Hour) }
	if err := e.Trigger(context.Background(), "a", "went_cold", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 2 {
		t.Fatalf("past the cooldown the subscriber must re-enter; sent %d, want 2", len(lm.sends))
	}
}

// A flow set to "cooldown" with no cooldown configured would behave exactly
// like "always". Refuse rather than guess: a mis-set cooldown must never
// silently become an unbounded re-send.
func TestReEnrollment_CooldownWithoutAWindowRefusesRatherThanGuessing(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		ReEnrollment:  canonical.ReEnrollAfterCooldown,
		CooldownHours: 0, // misconfigured
		Triggers:      []canonical.AutomationTrigger{{Type: "went_cold"}},
		EntryID:       "n1",
		Nodes:         []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})
	for i := 0; i < 3; i++ {
		if err := e.Trigger(context.Background(), "a", "went_cold", "u@x.com", nil); err != nil {
			t.Fatal(err)
		}
		drain(t, e, q)
	}
	if len(lm.sends) != 1 {
		t.Fatalf("a cooldown flow with no window must not become an unbounded re-send; sent %d, want 1", len(lm.sends))
	}
}
