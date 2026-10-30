package service_suite

import "testing"

func TestValidateConversation(t *testing.T) {
	out := ValidateConversation(Conversation{
		ChannelType:      "sms",
		SourceType:       "sms",
		ExternalThreadID: "+15551234567",
		Status:           "open",
		Priority:         "high",
	})
	if !out.Valid {
		t.Fatalf("expected valid conversation, got %#v", out.Errors)
	}

	out = ValidateConversation(Conversation{ChannelType: "pager"})
	if out.Valid {
		t.Fatalf("expected invalid channel type")
	}
}

func TestValidateMessage(t *testing.T) {
	out := ValidateMessage(Message{Direction: "outbound", SenderType: "agent", BodyText: "Hello"})
	if !out.Valid {
		t.Fatalf("expected valid message, got %#v", out.Errors)
	}

	out = ValidateMessage(Message{Direction: "outbound", SenderType: "agent"})
	if out.Valid {
		t.Fatalf("expected missing body to fail")
	}
}

func TestBuildDraftReplyIsHandoffOnly(t *testing.T) {
	run := BuildDraftReply(DraftReplyRequest{
		ConversationID: "conv_1",
		Prompt:         "Tell the customer we are checking the order.",
		Tone:           "warm",
	})
	if run.Status != "needs_handoff" {
		t.Fatalf("draft status = %q", run.Status)
	}
	if !contains(run.SafetyFlags, "operator_review_required") {
		t.Fatalf("missing operator review flag: %#v", run.SafetyFlags)
	}
	blocked, ok := run.ToolPlan["blocked"].([]string)
	if !ok || !contains(blocked, "send_message") {
		t.Fatalf("expected send_message to be blocked: %#v", run.ToolPlan)
	}
}

func TestValidateSpamAssessment(t *testing.T) {
	out := ValidateSpamAssessment(SpamAssessment{Score: 99, Verdict: "review"})
	if !out.Valid {
		t.Fatalf("expected valid spam assessment, got %#v", out.Errors)
	}
	out = ValidateSpamAssessment(SpamAssessment{Score: 120, Verdict: "ham"})
	if out.Valid {
		t.Fatalf("expected score over 100 to fail")
	}
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
