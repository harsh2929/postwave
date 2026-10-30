// SPDX-License-Identifier: AGPL-3.0-only

package aichat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

type fakeVoice struct {
	calls       int
	tenantID    string
	kind        aicompose.ChatKind
	prompt      string
	contextText string
	result      aicompose.GenerateResult
	err         error
}

func (f *fakeVoice) Generate(
	_ context.Context,
	tenantID string,
	kind aicompose.ChatKind,
	prompt, contextText string,
) (aicompose.GenerateResult, error) {
	f.calls++
	f.tenantID = tenantID
	f.kind = kind
	f.prompt = prompt
	f.contextText = contextText
	if f.err != nil {
		return aicompose.GenerateResult{}, f.err
	}
	if f.result.Text != "" || f.result.Draft != nil {
		return f.result, nil
	}
	return aicompose.GenerateResult{Text: "Echo: " + prompt + " | " + contextText}, nil
}

type strictFactory struct {
	err error
}

func (f strictFactory) SanitizerForText(
	_ context.Context,
	_, salt, prompt, contextText string,
) (pii_gateway.Sanitizer, error) {
	if f.err != nil {
		return nil, f.err
	}
	return pii_gateway.NewStrictTextSanitizer(salt, nil, nil, prompt, contextText)
}

type routeOptions struct {
	contentType string
	scopes      []apikeys.Scope
	tenantID    string
}

func serve(
	t *testing.T,
	deps *Deps,
	body []byte,
	options routeOptions,
) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.WithAPIKeyAuth(r.Context())
			ctx = apikeys.WithScopes(ctx, options.scopes)
			if options.tenantID != "" {
				ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: options.tenantID})
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	Mount(router, deps)
	req := httptest.NewRequest(http.MethodPost, routePath, bytes.NewReader(body))
	contentType := options.contentType
	if contentType == "" {
		contentType = "application/json"
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Tenant-ID", "attacker-controlled-tenant")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func authorizedOptions() routeOptions {
	return routeOptions{
		tenantID: "trusted-tenant",
		scopes:   []apikeys.Scope{apikeys.ScopeWriteCampaigns},
	}
}

func encodeBody(t *testing.T, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return body
}

func TestGenerateUsesStrictPIIGatewayAndTrustedTenant(t *testing.T) {
	const (
		email         = "alice@example.com"
		promptSecret  = "sk_live_51PromptSecretValue"
		phone         = "+1 415-555-0199"
		contextSecret = "ghp_ContextSecretValue123456"
	)
	inner := &fakeVoice{}
	// Echo the sanitized model inputs in both response surfaces. The strict
	// wrapper must restore them before the handler returns the receipt.
	inner.result = aicompose.GenerateResult{}
	wrapped := aicompose.NewStrictTextGatewayVoiceClient(inner, strictFactory{})
	deps := &Deps{Voice: wrapped}
	body := encodeBody(t, map[string]any{
		"prompt": "Write to " + email + " with api_key=" + promptSecret,
		"kind":   "campaign_draft",
		"context_refs": []map[string]string{
			{"kind": "campaign", "id": "campaign-1"},
			{"kind": "voice_profile", "id": "active"},
		},
		"context_text": "Call " + phone + " and use token=" + contextSecret,
		"stream":       true,
	})

	recorder := serve(t, deps, body, authorizedOptions())
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if inner.calls != 1 || inner.tenantID != "trusted-tenant" || inner.kind != aicompose.KindCampaignDraft {
		t.Fatalf("unexpected upstream identity/call: %+v", inner)
	}
	for _, raw := range []string{email, promptSecret, phone, contextSecret} {
		if strings.Contains(inner.prompt, raw) || strings.Contains(inner.contextText, raw) {
			t.Errorf("upstream received raw sensitive value %q", raw)
		}
	}
	if !strings.Contains(inner.prompt, "[[PII:EMAIL:") ||
		!strings.Contains(inner.contextText, "[[PII:PHONE:") ||
		!strings.Contains(inner.prompt, "[[PII:SECRET:") ||
		!strings.Contains(inner.contextText, "[[PII:SECRET:") {
		t.Fatalf("upstream did not receive expected tokens: prompt=%q context=%q", inner.prompt, inner.contextText)
	}

	var output response
	if err := json.Unmarshal(recorder.Body.Bytes(), &output); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for _, restored := range []string{email, promptSecret, phone, contextSecret} {
		if !strings.Contains(output.Text, restored) {
			t.Errorf("response did not restore %q: %q", restored, output.Text)
		}
	}
	if got := recorder.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("Content-Type=%q", got)
	}
	if got := recorder.Header().Get(aidisclosure.HeaderName); got != "true" {
		t.Fatalf("%s=%q", aidisclosure.HeaderName, got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
}

func TestGenerateRestoresAndMarksStructuredDraft(t *testing.T) {
	const email = "draft-owner@example.com"
	inner := &fakeVoice{}
	// The fake sees the token only after the strict wrapper sanitizes input, so
	// it constructs the model response from the exact model-facing value.
	inner.result = aicompose.GenerateResult{}
	model := &echoDraftVoice{fakeVoice: inner}
	wrapped := aicompose.NewStrictTextGatewayVoiceClient(model, strictFactory{})
	body := encodeBody(t, map[string]any{
		"prompt": "Draft for " + email,
		"kind":   "campaign_draft",
	})

	recorder := serve(t, &Deps{Voice: wrapped}, body, authorizedOptions())
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var output response
	if err := json.Unmarshal(recorder.Body.Bytes(), &output); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if output.Draft == nil || !strings.Contains(output.Draft.Subject, email) ||
		!strings.Contains(output.Draft.Body, email) {
		t.Fatalf("draft was not detokenized: %+v", output.Draft)
	}
	if !strings.Contains(output.Draft.Body, aidisclosure.Marker) {
		t.Fatalf("draft body missing AI disclosure marker: %q", output.Draft.Body)
	}
}

type echoDraftVoice struct {
	*fakeVoice
}

func (e *echoDraftVoice) Generate(
	ctx context.Context,
	tenantID string,
	kind aicompose.ChatKind,
	prompt, contextText string,
) (aicompose.GenerateResult, error) {
	_, _ = e.fakeVoice.Generate(ctx, tenantID, kind, prompt, contextText)
	return aicompose.GenerateResult{
		Text: prompt,
		Draft: &aicompose.CampaignDraft{
			Name:        "AI draft",
			Subject:     prompt,
			Body:        "<p>" + prompt + "</p>",
			PreviewText: prompt,
		},
	}, nil
}

func TestGenerateFactoryFailurePreventsUpstreamCallAndHidesDetail(t *testing.T) {
	inner := &fakeVoice{}
	wrapped := aicompose.NewStrictTextGatewayVoiceClient(
		inner,
		strictFactory{err: errors.New("private policy database DSN")},
	)
	body := encodeBody(t, map[string]any{
		"prompt": "Email alice@example.com",
		"kind":   "free_form",
	})

	recorder := serve(t, &Deps{Voice: wrapped}, body, authorizedOptions())
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if inner.calls != 0 {
		t.Fatalf("upstream called %d times after sanitizer failure", inner.calls)
	}
	if strings.Contains(recorder.Body.String(), "database DSN") ||
		strings.Contains(recorder.Body.String(), "alice@example.com") {
		t.Fatalf("private detail leaked: %s", recorder.Body.String())
	}
}

func TestGenerateKeepsEmptyNonPIIContextUsableAndDefaultsKind(t *testing.T) {
	inner := &fakeVoice{}
	wrapped := aicompose.NewStrictTextGatewayVoiceClient(inner, strictFactory{})
	body := encodeBody(t, map[string]any{
		"prompt":       "  Draft a concise product update.  ",
		"context_text": "",
		"stream":       true,
	})

	recorder := serve(t, &Deps{Voice: wrapped}, body, authorizedOptions())
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if inner.kind != aicompose.KindFreeForm || inner.prompt != "Draft a concise product update." {
		t.Fatalf("kind=%q prompt=%q", inner.kind, inner.prompt)
	}
}

func TestGenerateRejectsUnsafeTenantFieldsAndInvalidBounds(t *testing.T) {
	validRef := map[string]string{"kind": "campaign", "id": "campaign-1"}
	manyRefs := make([]map[string]string, maxContextRefs+1)
	for index := range manyRefs {
		manyRefs[index] = map[string]string{"kind": "campaign", "id": string(rune('a' + index))}
	}
	tests := []struct {
		name       string
		body       []byte
		wantStatus int
	}{
		{name: "empty prompt", body: encodeBody(t, map[string]any{"prompt": ""}), wantStatus: http.StatusBadRequest},
		{name: "unsupported kind", body: encodeBody(t, map[string]any{"prompt": "hello", "kind": "admin"}), wantStatus: http.StatusBadRequest},
		{name: "prompt too large", body: encodeBody(t, map[string]any{"prompt": strings.Repeat("p", maxPromptBytes+1)}), wantStatus: http.StatusRequestEntityTooLarge},
		{name: "context too large", body: encodeBody(t, map[string]any{"prompt": "hello", "context_text": strings.Repeat("c", maxContextTextBytes+1)}), wantStatus: http.StatusRequestEntityTooLarge},
		{name: "too many refs", body: encodeBody(t, map[string]any{"prompt": "hello", "context_refs": manyRefs}), wantStatus: http.StatusBadRequest},
		{name: "unsupported ref", body: encodeBody(t, map[string]any{"prompt": "hello", "context_refs": []map[string]string{{"kind": "tenant", "id": "x"}}}), wantStatus: http.StatusBadRequest},
		{name: "conflicting ref", body: encodeBody(t, map[string]any{"prompt": "hello", "context_refs": []map[string]string{{"kind": "campaign", "type": "subscriber", "id": "x"}}}), wantStatus: http.StatusBadRequest},
		{name: "duplicate ref", body: encodeBody(t, map[string]any{"prompt": "hello", "context_refs": []map[string]string{validRef, validRef}}), wantStatus: http.StatusBadRequest},
		{name: "bad ref id", body: encodeBody(t, map[string]any{"prompt": "hello", "context_refs": []map[string]string{{"kind": "campaign", "id": "bad\nvalue"}}}), wantStatus: http.StatusBadRequest},
		{name: "top-level tenant injection", body: encodeBody(t, map[string]any{"prompt": "hello", "tenant_id": "attacker"}), wantStatus: http.StatusBadRequest},
		{name: "nested tenant injection", body: encodeBody(t, map[string]any{"prompt": "hello", "context_refs": []map[string]string{{"kind": "campaign", "id": "x", "tenant_id": "attacker"}}}), wantStatus: http.StatusBadRequest},
		{name: "body too large", body: encodeBody(t, map[string]any{"prompt": "hello", "context_text": strings.Repeat("x", chatJSONMaxBodyBytes)}), wantStatus: http.StatusRequestEntityTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			inner := &fakeVoice{}
			recorder := serve(t, &Deps{Voice: inner}, test.body, authorizedOptions())
			if recorder.Code != test.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			if inner.calls != 0 {
				t.Fatalf("upstream called %d times for invalid request", inner.calls)
			}
		})
	}
}

func TestGenerateRequiresWriteScopeAndTrustedTenantContext(t *testing.T) {
	body := encodeBody(t, map[string]any{"prompt": "hello"})
	inner := &fakeVoice{}

	noScope := authorizedOptions()
	noScope.scopes = []apikeys.Scope{apikeys.ScopeReadCampaigns}
	recorder := serve(t, &Deps{Voice: inner}, body, noScope)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("missing write scope status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	noTenant := authorizedOptions()
	noTenant.tenantID = ""
	recorder = serve(t, &Deps{Voice: inner}, body, noTenant)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing tenant status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if inner.calls != 0 {
		t.Fatalf("upstream called %d times without authorization", inner.calls)
	}
}

func TestGenerateContainsUpstreamErrorsAndOversizedResponses(t *testing.T) {
	body := encodeBody(t, map[string]any{"prompt": "hello"})
	tests := []struct {
		name       string
		voice      *fakeVoice
		wantStatus int
		private    string
	}{
		{
			name:       "provider error",
			voice:      &fakeVoice{err: errors.New("provider body contains secret 123")},
			wantStatus: http.StatusBadGateway,
			private:    "provider body",
		},
		{
			name:       "voice unavailable",
			voice:      &fakeVoice{err: aicompose.ErrVoiceUnavailable},
			wantStatus: http.StatusServiceUnavailable,
			private:    "voice unavailable",
		},
		{
			name: "oversized output",
			voice: &fakeVoice{result: aicompose.GenerateResult{
				Text: strings.Repeat("x", maxResponseTextBytes+1),
			}},
			wantStatus: http.StatusBadGateway,
			private:    strings.Repeat("x", 64),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := serve(t, &Deps{Voice: test.voice}, body, authorizedOptions())
			if recorder.Code != test.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			if strings.Contains(recorder.Body.String(), test.private) {
				t.Fatalf("private upstream detail leaked: %s", recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), "internal_error") {
				t.Fatalf("generic error envelope missing: %s", recorder.Body.String())
			}
		})
	}
}

// With VOICE_SERVICE_URL=disabled the environment runs no voice service. Chat
// used to fail every request as a sanitized 503 internal_error, which the
// copilot showed as "an internal error occurred".
func TestGenerateSaysNotDeployedWhenTheEnvironmentRunsNoVoiceService(t *testing.T) {
	inner := &fakeVoice{}
	body := encodeBody(t, map[string]any{"prompt": "Draft a welcome email", "kind": "free_form"})

	recorder := serve(t, &Deps{Voice: inner, VoiceNotDeployed: true}, body, authorizedOptions())

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable *bool  `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if envelope.Error.Code != "service_not_deployed" ||
		envelope.Error.Message != "AI chat isn't available in this environment." ||
		envelope.Error.Retryable == nil || *envelope.Error.Retryable {
		t.Fatalf("error envelope = %+v", envelope.Error)
	}
	if inner.calls != 0 {
		t.Fatalf("voice called %d times on an environment without it", inner.calls)
	}

	// The scope gate still runs first: no answer about the deployment to a
	// caller who may not use the route.
	noScope := authorizedOptions()
	noScope.scopes = nil
	if recorder := serve(t, &Deps{Voice: inner, VoiceNotDeployed: true}, body, noScope); recorder.Code != http.StatusForbidden {
		t.Fatalf("unscoped status=%d, want 403", recorder.Code)
	}
}
