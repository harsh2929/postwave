// SPDX-License-Identifier: AGPL-3.0-only
package service_suite

import (
	"strings"
	"testing"
)

func TestSuggestMacro(t *testing.T) {
	cases := map[string]string{
		"I'd like a refund please":      "refund_policy",
		"where is my order??":           "order_status",
		"track my shipment":             "order_status",
		"please cancel my subscription": "cancellation",
		"do you have a coupon code":     "promo_help",
		"just saying hello":             "general_acknowledgement",
	}
	for body, want := range cases {
		if got := suggestMacro(body); got != want {
			t.Errorf("suggestMacro(%q) = %q, want %q", body, got, want)
		}
	}
}

func TestBuildGroundedDraftReply_GroundsAndStaysSafe(t *testing.T) {
	run := BuildGroundedDraftReply(
		DraftReplyRequest{ConversationID: "c1", Tone: "warm"},
		DraftContext{Subject: "Order #5 late", RequesterName: "Sam", LastInboundText: "where is my order, it is very late"},
	)
	if !strings.Contains(run.Draft, "Sam") {
		t.Errorf("draft should greet the requester by name: %q", run.Draft)
	}
	if !strings.Contains(run.Draft, "Order #5 late") {
		t.Errorf("draft should reference the subject: %q", run.Draft)
	}
	if !strings.Contains(strings.ToLower(run.Draft), "where is my order") {
		t.Errorf("draft should quote the last inbound message: %q", run.Draft)
	}
	if run.ToolPlan["suggested_macro"] != "order_status" {
		t.Errorf("suggested_macro = %v, want order_status", run.ToolPlan["suggested_macro"])
	}
	// Safety invariants must hold: still needs handoff, no mutating tool allowed.
	if run.Status != "needs_handoff" {
		t.Errorf("status = %q, want needs_handoff", run.Status)
	}
	blocked, _ := run.ToolPlan["blocked"].([]string)
	if len(blocked) == 0 {
		t.Error("blocked tool list must not be empty")
	}
}

func TestBuildGroundedDraftReply_NoContextIsSafe(t *testing.T) {
	// Ungrounded (empty context) must still produce a safe, non-empty draft.
	run := BuildGroundedDraftReply(DraftReplyRequest{ConversationID: "c1"}, DraftContext{})
	if strings.TrimSpace(run.Draft) == "" {
		t.Error("ungrounded draft must not be empty")
	}
	if run.Status != "needs_handoff" {
		t.Errorf("status = %q, want needs_handoff", run.Status)
	}
}
