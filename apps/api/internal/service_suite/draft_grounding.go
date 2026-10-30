// SPDX-License-Identifier: AGPL-3.0-only
//
// draft_grounding.go is Phase 1 of the Customer Agent: a deterministic,
// context-grounded draft. The agent previously emitted a fixed "Thanks for
// reaching out…" string ignoring the conversation entirely. This grounds the
// draft in the real subject + last inbound message and suggests a matching
// macro, while still requiring operator review and blocking any mutating tool.
// The live-LLM call (Phase 2) is the integration boundary and stays deferred
// behind the customer_agent_enabled flag.
package service_suite

import (
	"fmt"
	"strings"
)

// DraftContext is the conversation grounding the handler resolves from the
// support spine before drafting.
type DraftContext struct {
	Subject         string
	RequesterName   string
	LastInboundText string
}

// firstNonEmptyDraft prefers the plain-text body; when absent it strips tags
// from the HTML body so the grounded draft never quotes raw markup.
func firstNonEmptyDraft(text, html string) string {
	if strings.TrimSpace(text) != "" {
		return text
	}
	return strings.TrimSpace(spamTagRe.ReplaceAllString(html, " "))
}

// suggestMacro deterministically maps the customer's message to a canned macro
// key, so the operator gets a relevant starting point without an LLM.
func suggestMacro(text string) string {
	l := strings.ToLower(text)
	switch {
	case strings.Contains(l, "refund") || strings.Contains(l, "money back"):
		return "refund_policy"
	case strings.Contains(l, "track") || strings.Contains(l, "shipping") ||
		strings.Contains(l, "delivery") || (strings.Contains(l, "where") && strings.Contains(l, "order")):
		return "order_status"
	case strings.Contains(l, "cancel"):
		return "cancellation"
	case strings.Contains(l, "discount") || strings.Contains(l, "coupon") || strings.Contains(l, "promo"):
		return "promo_help"
	default:
		return "general_acknowledgement"
	}
}

// excerpt trims s to at most n runes, appending an ellipsis when truncated.
func excerpt(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n])) + "…"
}

// BuildGroundedDraftReply assembles a deterministic draft grounded in the
// conversation context plus a suggested macro. No LLM call — the draft is a
// safe, reviewable starting point; the run still flags operator review and
// blocks mutating tools.
func BuildGroundedDraftReply(in DraftReplyRequest, dctx DraftContext) AgentRun {
	tone := defaulted(strings.TrimSpace(in.Tone), "helpful")
	name := strings.TrimSpace(dctx.RequesterName)
	greeting := "Hi there,"
	if name != "" {
		greeting = "Hi " + name + ","
	}

	var b strings.Builder
	b.WriteString(greeting + " thanks for reaching out")
	if subj := strings.TrimSpace(dctx.Subject); subj != "" {
		b.WriteString(fmt.Sprintf(" about %q", excerpt(subj, 80)))
	}
	b.WriteString(". ")
	if last := strings.TrimSpace(dctx.LastInboundText); last != "" {
		b.WriteString(fmt.Sprintf("Regarding your message — %q — ", excerpt(last, 160)))
	}
	if p := strings.TrimSpace(in.Prompt); p != "" {
		b.WriteString(fmt.Sprintf("here is a %s draft: %s", tone, p))
	} else {
		b.WriteString("I'm looking into this and will confirm the account details before making any changes.")
	}

	macro := suggestMacro(dctx.LastInboundText + " " + dctx.Subject)
	return AgentRun{
		RunType:       "draft_reply",
		Status:        "needs_handoff",
		Model:         "deterministic-template-v1",
		Prompt:        strings.TrimSpace(in.Prompt),
		Draft:         b.String(),
		SafetyFlags:   []string{"operator_review_required", "no_order_or_refund_mutation"},
		HandoffReason: "Customer Agent foundation drafts grounded replies until service tools are explicitly approved (live model is Phase 2).",
		ToolPlan: map[string]any{
			"allowed":         []string{"read_order_context", "read_profile_context", "suggest_macro"},
			"blocked":         []string{"refund_order", "cancel_subscription", "issue_coupon", "send_message"},
			"suggested_macro": macro,
		},
		Metadata: map[string]any{
			"provider_executed": false,
			"execution_mode":    "deterministic_template",
		},
	}
}
