// SPDX-License-Identifier: AGPL-3.0-only

package agent_routines

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

type testStrictFactory struct {
	err       error
	sanitizer pii_gateway.Sanitizer
}

func (f testStrictFactory) SanitizerForText(
	_ context.Context,
	_, salt, prompt, contextText string,
) (pii_gateway.Sanitizer, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.sanitizer != nil {
		return f.sanitizer, nil
	}
	return pii_gateway.NewStrictTextSanitizer(
		salt,
		nil,
		nil,
		prompt,
		contextText,
	)
}

func TestHTTPVoiceClientAuthenticatesGenerateRequest(t *testing.T) {
	var authorization, tenant string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		tenant = r.Header.Get("X-Tenant-ID")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"draft":{"name":"Draft","subject":"Subject","body":"Body"}}`))
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(
		server.URL,
		" internal-voice-token ",
		testStrictFactory{},
	)
	draft, err := client.GenerateCampaignDraft(
		context.Background(),
		"tenant-1",
		"Write a launch email",
		"Target audience: annual customers",
	)
	if err != nil {
		t.Fatalf("GenerateCampaignDraft: %v", err)
	}
	if authorization != "Bearer internal-voice-token" {
		t.Fatalf("Authorization=%q", authorization)
	}
	if tenant != "tenant-1" {
		t.Fatalf("X-Tenant-ID=%q", tenant)
	}
	if draft.Subject != "Subject" {
		t.Fatalf("draft=%+v", draft)
	}
}

func TestHTTPVoiceClientDoesNotReflectUpstreamErrorBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("provider secret=do-not-persist"))
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(server.URL, "token", testStrictFactory{})
	_, err := client.DraftSequence(context.Background(), "tenant-1", "brief")
	if !errors.Is(err, ErrVoiceUnavailable) {
		t.Fatalf("err=%v, want ErrVoiceUnavailable", err)
	}
	if err == nil || err.Error() != "agent_routines: voice service unavailable: HTTP 401" {
		t.Fatalf("unsafe or unexpected error: %v", err)
	}
}

func TestHTTPVoiceClientDoesNotFollowRedirectWithInternalCredential(t *testing.T) {
	targetCalls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetCalls++
		_, _ = w.Write([]byte(`{"name":"unexpected","steps":[]}`))
	}))
	t.Cleanup(target.Close)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)

	client := NewHTTPVoiceClient(
		redirect.URL,
		"internal-token",
		testStrictFactory{},
	)
	// An injected client with the default redirect policy must not weaken the
	// transport's credential boundary.
	client.HTTP = &http.Client{}
	_, err := client.DraftSequence(context.Background(), "tenant-1", "brief")
	if !errors.Is(err, ErrVoiceUnavailable) {
		t.Fatalf("err=%v, want ErrVoiceUnavailable", err)
	}
	if targetCalls != 0 {
		t.Fatalf("redirect target called %d times", targetCalls)
	}
}

func TestHTTPVoiceClientSanitizesRoutineTextAndRestoresDraft(t *testing.T) {
	const (
		email = "alice@example.com"
		phone = "+1 415-555-0199"
	)
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var request struct {
			Prompt      string `json:"prompt"`
			ContextText string `json:"context_text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if strings.Contains(request.Prompt, email) || strings.Contains(request.ContextText, phone) {
			t.Fatalf("model request leaked PII: %+v", request)
		}
		if !strings.Contains(request.Prompt, "[[PII:EMAIL:") ||
			!strings.Contains(request.ContextText, "[[PII:PHONE:") {
			t.Fatalf("model request was not tokenized: %+v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"draft": map[string]string{
				"name":         "Draft " + request.Prompt,
				"subject":      request.Prompt,
				"body":         request.ContextText,
				"preview_text": request.ContextText,
				"rationale":    request.Prompt,
			},
		})
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(server.URL, "token", testStrictFactory{})
	draft, err := client.GenerateCampaignDraft(
		context.Background(),
		"tenant-1",
		"Write to "+email,
		"Call "+phone,
	)
	if err != nil {
		t.Fatalf("GenerateCampaignDraft: %v", err)
	}
	if calls != 1 {
		t.Fatalf("upstream calls=%d", calls)
	}
	for _, value := range []string{draft.Name, draft.Subject, draft.Body, draft.PreviewText, draft.Rationale} {
		if !strings.Contains(value, email) && !strings.Contains(value, phone) {
			t.Fatalf("draft field was not restored: %q", value)
		}
	}
}

func TestHTTPVoiceClientSanitizesAndRestoresSequenceDraft(t *testing.T) {
	const email = "sequence-owner@example.com"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Brief string `json:"brief"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if strings.Contains(request.Brief, email) || !strings.Contains(request.Brief, "[[PII:EMAIL:") {
			t.Fatalf("sequence brief was not tokenized: %q", request.Brief)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name":      "Sequence " + request.Brief,
			"rationale": request.Brief,
			"steps": []map[string]any{{
				"subject":     request.Brief,
				"body":        "Body " + request.Brief,
				"delay_hours": 0,
				"position":    1,
			}},
		})
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(server.URL, "token", testStrictFactory{})
	draft, err := client.DraftSequence(context.Background(), "tenant-1", "Plan for "+email)
	if err != nil {
		t.Fatalf("DraftSequence: %v", err)
	}
	if !strings.Contains(draft.Name, email) || !strings.Contains(draft.Rationale, email) ||
		len(draft.Steps) != 1 || !strings.Contains(draft.Steps[0].Subject, email) ||
		!strings.Contains(draft.Steps[0].Body, email) {
		t.Fatalf("sequence draft was not restored: %+v", draft)
	}
}

func TestHTTPVoiceClientPIIFactoryFailurePreventsModelCall(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(
		server.URL,
		"token",
		testStrictFactory{err: errors.New("policy database unavailable")},
	)
	_, err := client.DraftSequence(context.Background(), "tenant-1", "brief")
	if !errors.Is(err, ErrStrictPIIGatewayUnavailable) {
		t.Fatalf("err=%v, want ErrStrictPIIGatewayUnavailable", err)
	}
	if calls != 0 {
		t.Fatalf("upstream called %d times after policy failure", calls)
	}
}

func TestHTTPVoiceClientMissingInternalTokenPreventsRequest(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(server.URL, "  ", testStrictFactory{})
	_, err := client.CreateDraftSequence(context.Background(), "tenant-1", validSequenceDraft())
	if !errors.Is(err, ErrVoiceAuthenticationUnavailable) {
		t.Fatalf("err=%v, want ErrVoiceAuthenticationUnavailable", err)
	}
	if calls != 0 {
		t.Fatalf("upstream called %d times without an internal credential", calls)
	}
}

func TestHTTPVoiceClientTypedNilFactoryFailsClosed(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	var factory StrictTextSanitizerFactoryFunc
	client := NewHTTPVoiceClient(server.URL, "token", factory)
	_, err := client.DraftSequence(context.Background(), "tenant-1", "brief")
	if !errors.Is(err, ErrStrictPIIGatewayUnavailable) {
		t.Fatalf("err=%v, want ErrStrictPIIGatewayUnavailable", err)
	}
	if calls != 0 {
		t.Fatalf("upstream called %d times with a typed-nil privacy factory", calls)
	}
}

func TestHTTPVoiceClientRejectsOversizedAndTrailingResponses(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "oversized",
			body: `{"name":"Sequence","steps":[{"subject":"S","body":"B","delay_hours":0,"position":1}],"padding":"` +
				strings.Repeat("x", int(voiceResponseMaxBytes)) + `"}`,
		},
		{
			name: "second JSON value",
			body: `{"name":"Sequence","steps":[{"subject":"S","body":"B","delay_hours":0,"position":1}]} {}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(test.body))
			}))
			t.Cleanup(server.Close)

			client := NewHTTPVoiceClient(server.URL, "token", testStrictFactory{})
			_, err := client.DraftSequence(context.Background(), "tenant-1", "brief")
			if !errors.Is(err, ErrVoiceInvalidResponse) {
				t.Fatalf("err=%v, want ErrVoiceInvalidResponse", err)
			}
		})
	}
}

func TestHTTPVoiceClientRejectsMalformedModelDrafts(t *testing.T) {
	tests := []struct {
		name string
		body string
		call func(*HTTPVoiceClient) error
	}{
		{
			name: "campaign without body",
			body: `{"draft":{"name":"Draft","subject":"Subject","body":""}}`,
			call: func(client *HTTPVoiceClient) error {
				_, err := client.GenerateCampaignDraft(context.Background(), "tenant-1", "brief", "")
				return err
			},
		},
		{
			name: "sequence with non-dense position",
			body: `{"name":"Sequence","steps":[{"subject":"S","body":"B","delay_hours":0,"position":2}]}`,
			call: func(client *HTTPVoiceClient) error {
				_, err := client.DraftSequence(context.Background(), "tenant-1", "brief")
				return err
			},
		},
		{
			name: "sequence with delayed first step",
			body: `{"name":"Sequence","steps":[{"subject":"S","body":"B","delay_hours":24,"position":1}]}`,
			call: func(client *HTTPVoiceClient) error {
				_, err := client.DraftSequence(context.Background(), "tenant-1", "brief")
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(test.body))
			}))
			t.Cleanup(server.Close)
			client := NewHTTPVoiceClient(server.URL, "token", testStrictFactory{})
			if err := test.call(client); !errors.Is(err, ErrVoiceInvalidResponse) {
				t.Fatalf("err=%v, want ErrVoiceInvalidResponse", err)
			}
		})
	}
}

type expandingSanitizer struct{}

func (expandingSanitizer) Sanitize(value string) string { return value }
func (expandingSanitizer) Restore(string) string {
	return strings.Repeat("x", voiceRestoredDraftMaxBytes+1)
}

func TestHTTPVoiceClientRejectsOverLimitRestoredDraft(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"draft":{"name":"Draft","subject":"Subject","body":"Body"}}`))
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(server.URL, "token", testStrictFactory{sanitizer: expandingSanitizer{}})
	_, err := client.GenerateCampaignDraft(context.Background(), "tenant-1", "brief", "")
	if !errors.Is(err, ErrVoiceInvalidResponse) {
		t.Fatalf("err=%v, want ErrVoiceInvalidResponse", err)
	}
}

func TestHTTPVoiceClientCreateDraftSequenceAuthenticatesAndValidatesID(t *testing.T) {
	const sequenceID = "7d20fb0d-0765-45b1-9602-bbfed4067f37"
	var authorization, status string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		var request struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		status = request.Status
		_, _ = w.Write([]byte(`{"id":"` + sequenceID + `"}`))
	}))
	t.Cleanup(server.Close)

	client := NewHTTPVoiceClient(server.URL, "token", testStrictFactory{})
	got, err := client.CreateDraftSequence(context.Background(), "tenant-1", validSequenceDraft())
	if err != nil {
		t.Fatalf("CreateDraftSequence: %v", err)
	}
	if got != sequenceID || authorization != "Bearer token" || status != "draft" {
		t.Fatalf("id=%q authorization=%q status=%q", got, authorization, status)
	}
}

func TestHTTPVoiceClientProductionPIIRepository_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	const email = "routine-owner@example.com"
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer internal-token" {
			t.Fatalf("Authorization=%q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Tenant-ID") != fixture.tenantID {
			t.Fatalf("X-Tenant-ID=%q", r.Header.Get("X-Tenant-ID"))
		}
		var request struct {
			Prompt string `json:"prompt"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if strings.Contains(request.Prompt, email) || !strings.Contains(request.Prompt, "[[PII:EMAIL:") {
			t.Fatalf("production policy did not tokenize model prompt: %q", request.Prompt)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"draft": map[string]string{
				"name": "Draft", "subject": "Subject", "body": "Hello " + request.Prompt,
			},
		})
	}))
	t.Cleanup(server.Close)

	privacyRepo := &pii_gateway.Repo{Pool: fixture.pool}
	client := NewHTTPVoiceClient(
		server.URL,
		"internal-token",
		StrictTextSanitizerFactoryFunc(func(
			ctx context.Context,
			tenantID, salt, prompt, contextText string,
		) (pii_gateway.Sanitizer, error) {
			return privacyRepo.StrictTextSanitizerForTenant(
				ctx, tenantID, salt, prompt, contextText,
			)
		}),
	)
	draft, err := client.GenerateCampaignDraft(
		fixture.context,
		fixture.tenantID,
		"Write to "+email,
		"",
	)
	if err != nil {
		t.Fatalf("GenerateCampaignDraft: %v", err)
	}
	if calls != 1 || !strings.Contains(draft.Body, email) {
		t.Fatalf("calls=%d restored draft=%+v", calls, draft)
	}
}

func validSequenceDraft() SequenceDraft {
	return SequenceDraft{
		Name: "Sequence",
		Steps: []SequenceDraftStep{{
			Subject: "Subject", Body: "Body", DelayHours: 0, Position: 1,
		}},
	}
}
