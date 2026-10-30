// SPDX-License-Identifier: AGPL-3.0-only

package aicompose

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

type strictCapturingVoice struct {
	calls       int
	tenantID    string
	kind        ChatKind
	seenPrompt  string
	seenContext string
}

func (c *strictCapturingVoice) Generate(
	_ context.Context,
	tenantID string,
	kind ChatKind,
	prompt, contextText string,
) (GenerateResult, error) {
	c.calls++
	c.tenantID = tenantID
	c.kind = kind
	c.seenPrompt = prompt
	c.seenContext = contextText
	return GenerateResult{
		Text: "Model echo: " + prompt + " | " + contextText,
		Draft: &CampaignDraft{
			Name:        "Draft for " + prompt,
			Subject:     "Contact " + prompt,
			Body:        "<p>" + contextText + "</p>",
			PreviewText: contextText,
		},
	}, nil
}

type realStrictFactory struct {
	calls       int
	tenantID    string
	seenPrompt  string
	seenContext string
	err         error
}

func (f *realStrictFactory) SanitizerForText(
	_ context.Context,
	tenantID, salt, prompt, contextText string,
) (pii_gateway.Sanitizer, error) {
	f.calls++
	f.tenantID = tenantID
	f.seenPrompt = prompt
	f.seenContext = contextText
	if f.err != nil {
		return nil, f.err
	}
	return pii_gateway.NewStrictTextSanitizer(
		salt,
		nil,
		nil,
		prompt,
		contextText,
	)
}

func TestStrictTextGatewaySanitizesBeforeUpstreamAndRestoresOutput(t *testing.T) {
	const (
		email  = "alice@example.com"
		phone  = "+1 415-555-0199"
		secret = "sk_live_51StrictGatewaySecret"
	)
	prompt := "Draft an email for " + email
	contextText := "Call " + phone + " with api_key=" + secret
	inner := &strictCapturingVoice{}
	factory := &realStrictFactory{}
	client := NewStrictTextGatewayVoiceClient(inner, factory)

	result, err := client.Generate(
		context.Background(),
		"trusted-tenant",
		KindCampaignDraft,
		prompt,
		contextText,
	)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if factory.calls != 1 || factory.tenantID != "trusted-tenant" ||
		factory.seenPrompt != prompt || factory.seenContext != contextText {
		t.Fatalf("factory did not receive exact tenant/text: %+v", factory)
	}
	if inner.calls != 1 || inner.tenantID != "trusted-tenant" || inner.kind != KindCampaignDraft {
		t.Fatalf("unexpected upstream call: %+v", inner)
	}
	for _, raw := range []string{email, phone, secret} {
		if strings.Contains(inner.seenPrompt, raw) || strings.Contains(inner.seenContext, raw) {
			t.Errorf("upstream received raw sensitive value %q", raw)
		}
		if !strings.Contains(result.Text, raw) {
			t.Errorf("caller response did not restore %q: %q", raw, result.Text)
		}
	}
	if !strings.Contains(inner.seenPrompt, "[[PII:EMAIL:") ||
		!strings.Contains(inner.seenContext, "[[PII:PHONE:") ||
		!strings.Contains(inner.seenContext, "[[PII:SECRET:") {
		t.Fatalf("upstream did not receive opaque tokens: prompt=%q context=%q", inner.seenPrompt, inner.seenContext)
	}
	if result.Draft == nil || !strings.Contains(result.Draft.Subject, email) ||
		!strings.Contains(result.Draft.Body, phone) || !strings.Contains(result.Draft.Body, secret) {
		t.Fatalf("structured draft was not restored: %+v", result.Draft)
	}
}

func TestStrictTextGatewayFactoryFailurePreventsUpstreamCall(t *testing.T) {
	inner := &strictCapturingVoice{}
	factory := &realStrictFactory{err: errors.New("policy store unavailable")}
	client := NewStrictTextGatewayVoiceClient(inner, factory)

	_, err := client.Generate(
		context.Background(),
		"tenant-1",
		KindFreeForm,
		"email alice@example.com",
		"",
	)
	if !errors.Is(err, ErrStrictPIIGatewayUnavailable) {
		t.Fatalf("err=%v, want ErrStrictPIIGatewayUnavailable", err)
	}
	if inner.calls != 0 {
		t.Fatalf("upstream called %d times after factory failure", inner.calls)
	}
}

func TestStrictTextGatewayMissingFactoryFailsClosed(t *testing.T) {
	inner := &strictCapturingVoice{}
	client := NewStrictTextGatewayVoiceClient(inner, nil)

	_, err := client.Generate(
		context.Background(),
		"tenant-1",
		KindFreeForm,
		"hello",
		"",
	)
	if !errors.Is(err, ErrStrictPIIGatewayUnavailable) {
		t.Fatalf("err=%v, want ErrStrictPIIGatewayUnavailable", err)
	}
	if inner.calls != 0 {
		t.Fatalf("upstream called %d times without a strict factory", inner.calls)
	}
}

func TestStrictTextGatewayKeepsNonPIITextUsable(t *testing.T) {
	inner := &strictCapturingVoice{}
	client := NewStrictTextGatewayVoiceClient(inner, &realStrictFactory{})
	const prompt = "Draft a concise product announcement."

	result, err := client.Generate(
		context.Background(),
		"tenant-1",
		KindFreeForm,
		prompt,
		"Use a warm, practical tone.",
	)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if inner.seenPrompt != prompt {
		t.Fatalf("non-PII prompt changed: %q", inner.seenPrompt)
	}
	if !strings.Contains(result.Text, prompt) {
		t.Fatalf("non-PII response unusable: %q", result.Text)
	}
}
