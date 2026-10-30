// SPDX-License-Identifier: AGPL-3.0-only
//
// pii_gateway_test.go — SUB-072: proves the production AI composer path is
// wrapped by the PII gateway. The GatewayVoiceClient must tokenize a tenant's
// sensitive values out of the prompt/context before the inner (model) client
// sees them, and restore them in the response — exactly the seam main.go wires.

package aicompose

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

// capturingVoice records the prompt + context it was handed and echoes the
// prompt back as the response text so the test can assert on both the
// model-facing input (must be tokenized) and the caller-facing output (must be
// detokenized).
type capturingVoice struct {
	seenPrompt  string
	seenContext string
	draft       *CampaignDraft
}

func (c *capturingVoice) Generate(_ context.Context, _ string, _ ChatKind, prompt, contextText string) (GenerateResult, error) {
	c.seenPrompt = prompt
	c.seenContext = contextText
	// Echo the (tokenized) prompt back so the wrapper's Restore re-expands it,
	// proving the round-trip detokenization works end-to-end.
	return GenerateResult{Text: "Generated: " + prompt, Draft: c.draft}, nil
}

// sensitiveFactory builds a sanitizer that knows one tenant's sensitive values,
// standing in for the production pii_gateway.Repo.SanitizeForTenant factory.
func sensitiveFactory(values []pii_gateway.KindValue) SanitizerFactory {
	return SanitizerFactoryFunc(func(_ context.Context, _ string, salt string) (pii_gateway.Sanitizer, error) {
		return pii_gateway.NewSanitizerFromKindValues(salt, values), nil
	})
}

func TestGatewayVoiceClient_TokenizesPromptAndRestoresResponse(t *testing.T) {
	const (
		tenantID = "tenant-1"
		email    = "alice@example.com"
		phone    = "+15551234567"
	)
	inner := &capturingVoice{}
	gw := NewGatewayVoiceClient(inner, sensitiveFactory([]pii_gateway.KindValue{
		{Kind: "EMAIL", Value: email},
		{Kind: "PHONE", Value: phone},
	}))

	prompt := "Write to " + email + " about their account."
	contextText := "Backup contact: " + phone

	out, err := gw.Generate(context.Background(), tenantID, KindCampaignDraft, prompt, contextText)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	// 1. The inner (model) client must NOT have seen cleartext PII in EITHER
	//    the prompt or the context_text.
	if strings.Contains(inner.seenPrompt, email) || strings.Contains(inner.seenPrompt, phone) {
		t.Errorf("model prompt leaked PII: %q", inner.seenPrompt)
	}
	if strings.Contains(inner.seenContext, phone) || strings.Contains(inner.seenContext, email) {
		t.Errorf("model context leaked PII: %q", inner.seenContext)
	}
	// Sanity: the prompt actually went through tokenization (a token marker
	// is present), confirming WrapVoiceClient ran rather than a no-op pass.
	if !strings.Contains(inner.seenPrompt, "[[PII:") {
		t.Errorf("expected a PII token in the model prompt, got %q", inner.seenPrompt)
	}

	// 2. The response handed back to the caller must be detokenized.
	if !strings.Contains(out.Text, email) {
		t.Errorf("response not detokenized; want %q in %q", email, out.Text)
	}
}

func TestGatewayVoiceClient_RestoresStructuredDraft(t *testing.T) {
	const email = "bob@example.com"
	// Build the sanitizer and mint the real token for email by sanitizing it;
	// the returned string IS the opaque [[PII:EMAIL:<hex>]] placeholder.
	san := pii_gateway.NewSanitizerFromKindValues("seed", []pii_gateway.KindValue{{Kind: "EMAIL", Value: email}})
	emailToken := san.Sanitize(email)
	if emailToken == email {
		t.Fatal("setup: expected email to tokenize to an opaque placeholder")
	}
	// The model echoes that token back inside a structured draft field.
	inner := &capturingVoice{
		draft: &CampaignDraft{Subject: "Hello " + emailToken},
	}
	gw := &GatewayVoiceClient{
		inner: inner,
		factory: SanitizerFactoryFunc(func(_ context.Context, _ string, _ string) (pii_gateway.Sanitizer, error) {
			return san, nil
		}),
	}

	out, err := gw.Generate(context.Background(), "t", KindCampaignDraft, "draft for "+email, "")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if out.Draft == nil {
		t.Fatal("expected a draft in the response")
	}
	if !strings.Contains(out.Draft.Subject, email) {
		t.Errorf("draft subject not detokenized: %q", out.Draft.Subject)
	}
}

func TestNewGatewayVoiceClient_NilFactoryPassesThrough(t *testing.T) {
	inner := &capturingVoice{}
	got := NewGatewayVoiceClient(inner, nil)
	if got != VoiceClient(inner) {
		t.Errorf("nil factory should return the inner client unchanged")
	}
	if NewGatewayVoiceClient(nil, sensitiveFactory(nil)) != nil {
		t.Errorf("nil inner should return nil")
	}
}
