package pii_gateway

// Integration-style test for the SUB-072 sanitization seam: it exercises the
// full path an llmactions.Executor / ai_agent campaign-generation flow takes —
// resolve a subscriber's sensitive values from a tenant config, build a
// request-scoped sanitizer, wrap the model call, and assert the model never
// sees cleartext PII while the final, user-visible response is detokenized.
//
// It lives in pii_gateway (not llmactions) so it is hermetic: the wrapper is
// generic over the model-call signature, so we drive it with a fake "model"
// rather than the real voice service. This locks the contract the llmactions
// executor relies on without coupling the test to that package's internals.

import (
	"context"
	"strings"
	"testing"
)

func TestSanitizationSeam_LLMActionsStylePrompt(t *testing.T) {
	// A tenant marks "loyalty_id" PII-sensitive in addition to the always-on
	// email/phone identifiers.
	cfg := []FieldSensitivity{{FieldName: "loyalty_id", Sensitive: true}}
	set := NewSensitiveFieldSet(cfg)

	// A subscriber the campaign generator is personalising for.
	email := "jamie.rivera@shop.example"
	phone := "+447700900123"
	custom := map[string]any{"loyalty_id": "LY-99887766", "fav_color": "teal"}
	merge := map[string]any{"FNAME": "Jamie"}

	values := BuildSensitiveValues(set, email, phone, custom, merge)
	san := NewSanitizerFromKindValues("req-campaign-42", values)

	// The rendered prompt an llmactions template would produce, interpolating
	// the subscriber's real values.
	prompt := strings.Join([]string{
		"Draft a re-engagement email.",
		"Recipient email: " + email,
		"SMS fallback: " + phone,
		"Loyalty number to reference: LY-99887766.",
		"First name: Jamie. Favorite color: teal.",
	}, "\n")

	var promptSentToModel string
	model := func(_ context.Context, p string) (string, error) {
		promptSentToModel = p
		// The model produces copy that happens to echo the placeholders it was
		// given (a realistic worst case for leakage if detokenization failed).
		return "Hi! We saved your number " + extractFirstToken(p, "PHONE") +
			" and loyalty " + extractFirstToken(p, "LOYALTY_ID") + ".", nil
	}

	wrapped := WrapVoiceClient(san, model)
	out, err := wrapped(context.Background(), prompt)
	if err != nil {
		t.Fatalf("wrapped generate: %v", err)
	}

	// 1. The model must not have seen ANY cleartext PII.
	for _, leak := range []string{email, phone, "LY-99887766"} {
		if strings.Contains(promptSentToModel, leak) {
			t.Errorf("model prompt leaked %q:\n%s", leak, promptSentToModel)
		}
	}
	// Non-PII (first name, color) is fine to pass through.
	if !strings.Contains(promptSentToModel, "Jamie") || !strings.Contains(promptSentToModel, "teal") {
		t.Errorf("non-PII values should NOT be tokenized:\n%s", promptSentToModel)
	}

	// 2. The final response handed back to the operator must be detokenized.
	if !strings.Contains(out, phone) || !strings.Contains(out, "LY-99887766") {
		t.Errorf("final response not detokenized: %q", out)
	}

	// 3. The ephemeral mappings can be persisted for async detokenization.
	if got := san.Registry().Mappings(); len(got) < 3 {
		t.Errorf("expected >=3 token mappings (email, phone, loyalty_id), got %d", len(got))
	}
}

// extractFirstToken returns the first [[PII:<KIND>:...]] token of the given kind
// found in s, or "" if none. Used to simulate a model echoing placeholders.
func extractFirstToken(s, kind string) string {
	marker := "[[PII:" + kind + ":"
	i := strings.Index(s, marker)
	if i < 0 {
		return ""
	}
	end := strings.Index(s[i:], "]]")
	if end < 0 {
		return ""
	}
	return s[i : i+end+2]
}
