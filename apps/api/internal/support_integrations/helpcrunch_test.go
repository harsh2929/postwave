// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type staticHelpCrunchCredentialResolver struct {
	creds HelpCrunchCredentials
}

func (r staticHelpCrunchCredentialResolver) ResolveHelpCrunch(context.Context, string, Integration) (HelpCrunchCredentials, error) {
	return r.creds, nil
}

func TestHelpCrunchBackfillChatsAndMessages(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer helpcrunch_key" && r.Header.Get("Accept") == "application/json" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/v1/chats":
			if r.URL.Query().Get("offset") != "0" || r.URL.Query().Get("limit") != "100" || r.URL.Query().Get("sort") != "chats.createdAt" {
				t.Fatalf("unexpected chat query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"data":[{"id":1,"status":"opened","lastMessageText":"Need help","createdAt":"2026-06-30T10:00:00Z","lastMessageAt":"2026-06-30T10:01:00Z","applicationId":456,"customer":{"id":99,"name":"HC Buyer","email":"Buyer@Example.com","userId":"u-99"},"assignee":{"id":7,"name":"Agent One","email":"agent@example.com"},"tags":["vip"]}],"meta":{"total":1}}`))
		case "/v1/chats/1/messages":
			if r.URL.Query().Get("offset") != "0" || r.URL.Query().Get("limit") != "100" {
				t.Fatalf("unexpected message query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"data":[{"id":10,"text":"Need help","from":"customer","createdAt":"2026-06-30T10:01:00Z","customer":{"id":99,"name":"HC Buyer","email":"Buyer@Example.com"}},{"id":11,"text":"We can help","from":"agent","createdAt":"2026-06-30T10:02:00Z","agent":{"id":7,"name":"Agent One","email":"agent@example.com"}}],"total":2}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := HelpCrunchRESTBackfiller{Credentials: staticHelpCrunchCredentialResolver{creds: HelpCrunchCredentials{
		APIKey:     "helpcrunch_key",
		APIBaseURL: server.URL + "/v1",
	}}}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderHelpCrunch,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"organization_id": "org_123",
			"widget_id":       "456",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected HelpCrunch bearer auth header")
	}
	if req.Cursor != helpCrunchCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].RequesterName != "HC Buyer" || req.Tickets[0].ConversationID != "1" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" || req.Messages[1].SenderType != "agent" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
}

func TestHelpCrunchBackfillRetryAfterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "27")
		http.Error(w, `{"errors":[{"code":"too_many_requests"}]}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := HelpCrunchRESTBackfiller{Credentials: staticHelpCrunchCredentialResolver{creds: HelpCrunchCredentials{
		APIKey:     "helpcrunch_key",
		APIBaseURL: server.URL + "/v1",
	}}}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderHelpCrunch, CredentialsRef: "cred", Settings: map[string]any{"organization_id": "org_123"}}, "")
	var restErr HelpCrunchRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 27*time.Second {
		t.Fatalf("expected retry-aware HelpCrunchRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestVerifyHelpCrunchWebhookSignature(t *testing.T) {
	body := []byte(`{"event":"chat.new"}`)
	signature := signHelpCrunchWebhookTest("secret", body)
	if err := VerifyHelpCrunchWebhookSignature("secret", body, signature); err != nil {
		t.Fatalf("valid signature failed: %v", err)
	}
	if err := VerifyHelpCrunchWebhookSignature("secret", body, "sha1="+signature); err != nil {
		t.Fatalf("valid prefixed signature failed: %v", err)
	}
	if err := VerifyHelpCrunchWebhookSignature("wrong", body, signature); !errors.Is(err, ErrInvalidHelpCrunchWebhookSignature) {
		t.Fatalf("invalid signature error=%v", err)
	}
	if err := VerifyHelpCrunchWebhookSignature("secret", body, ""); !errors.Is(err, ErrMissingHelpCrunchWebhookSignature) {
		t.Fatalf("missing signature error=%v", err)
	}
}

func TestHelpCrunchWebhookSignedSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHelpCrunch
	store.integration.Settings = map[string]any{
		"organization_id":                    "org_123",
		"helpcrunch_webhook_signing_key_ref": "cred_helpcrunch_webhook_1",
		"helpcrunch_webhook_id":              "webhook-1",
		"helpcrunch_organization_id":         "org_123",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeHelpCrunchBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "helpcrunch://chat/1",
			ConversationID: "1",
			Email:          "buyer@example.com",
			Subject:        "Need help",
		}},
		Messages: []MessageInput{{
			SourceID:       "helpcrunch://chat/1/message/10",
			ConversationID: "1",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	deps := &Deps{
		Repo:                 store,
		Suite:                suite,
		HelpCrunchBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_helpcrunch_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt-1","event":"message.customer","eventData":{"chat":{"id":1}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/helpcrunch/org_123/webhooks/webhook-1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HelpCrunch-Signature", signHelpCrunchWebhookTest("secret", body))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshChatID != "1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: chatID=%q tickets=%+v messages=%+v", backfiller.refreshChatID, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["helpcrunch_webhook_event"] != "message.customer" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

type fakeHelpCrunchBackfiller struct {
	req           SyncRequest
	err           error
	refreshReq    SyncRequest
	refreshErr    error
	refreshChatID string
}

func (f fakeHelpCrunchBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeHelpCrunchBackfiller) RefreshChat(_ context.Context, _ string, _ Integration, chatID string) (SyncRequest, error) {
	f.refreshChatID = strings.TrimSpace(chatID)
	return f.refreshReq, f.refreshErr
}

func signHelpCrunchWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
