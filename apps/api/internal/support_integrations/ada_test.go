// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type staticAdaCredentialResolver struct {
	creds AdaCredentials
}

func (r staticAdaCredentialResolver) ResolveAda(context.Context, string, Integration) (AdaCredentials, error) {
	return r.creds, nil
}

func TestAdaBackfillExportsConversationsEndUsersAndMessages(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer ada_token" && r.Header.Get("Accept") == "application/json" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/api/v2/export/conversations":
			if r.URL.Query().Get("created_since") != "2026-05-01T00:00:00Z" || r.URL.Query().Get("created_to") != "2026-05-08T00:00:00Z" {
				t.Fatalf("unexpected export window: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"items":[{"conversation_id":"conv-1","end_user_id":"user-1","status":"open","channel":"email","handoff_integration":"postwave","created_at":"2026-05-02T10:00:00Z"}],"meta":{"next_page_uri":null}}`))
		case "/api/v2/end-users/user-1":
			_, _ = w.Write([]byte(`{"id":"user-1","email":"Buyer@Example.com","name":"Ada Buyer"}`))
		case "/api/v2/export/messages":
			if r.URL.Query().Get("conversation_id") != "conv-1" {
				t.Fatalf("unexpected messages query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"items":[{"message_id":"msg-1","conversation_id":"conv-1","author":{"role":"end_user","name":"Ada Buyer"},"content":"Need help","created_at":"2026-05-02T10:01:00Z"},{"message_id":"msg-2","conversation_id":"conv-1","author":{"role":"ai_agent","name":"Ada"},"content":{"text":"We can help"},"created_at":"2026-05-02T10:02:00Z"}],"meta":{"next_page_uri":null}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := AdaRESTBackfiller{
		Credentials: staticAdaCredentialResolver{creds: AdaCredentials{
			AccessToken: "ada_token",
			APIBaseURL:  server.URL + "/api",
		}},
		Now: func() time.Time { return time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC) },
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderAda,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"ai_agent_domain":     "example.ada.support",
			"created_since":       "2026-05-01T00:00:00Z",
			"created_to":          "2026-05-08T00:00:00Z",
			"handoff_integration": "postwave",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected Ada bearer auth header")
	}
	if req.Cursor != adaCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].RequesterName != "Ada Buyer" || req.Tickets[0].ConversationID != "conv-1" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" || req.Messages[1].SenderType != "ai" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
}

func TestAdaBackfillRetryAfterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		http.Error(w, `{"errors":[{"message":"rate limited"}]}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := AdaRESTBackfiller{
		Credentials: staticAdaCredentialResolver{creds: AdaCredentials{
			AccessToken: "ada_token",
			APIBaseURL:  server.URL + "/api",
		}},
		Now: func() time.Time { return time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC) },
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderAda, CredentialsRef: "cred", Settings: map[string]any{"ai_agent_domain": "example.ada.support"}}, "")
	var restErr AdaRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter == 0 {
		t.Fatalf("expected retry-aware AdaRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestAdaWebhookSignedSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderAda
	store.integration.Settings = map[string]any{
		"ai_agent_domain":        "example.ada.support",
		"ada_webhook_secret_ref": "cred_ada_webhook_1",
		"ada_webhook_id":         "wh_endpoint_1",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeAdaBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "ada://conversation/conv-1",
			ConversationID: "conv-1",
			Email:          "buyer@example.com",
			Subject:        "Ada conversation",
		}},
		Messages: []MessageInput{{
			SourceID:       "ada://conversation/conv-1/message/msg-1",
			ConversationID: "conv-1",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	secret := "whsec_" + base64.StdEncoding.EncodeToString([]byte("secret"))
	deps := &Deps{
		Repo:          store,
		Suite:         suite,
		AdaBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_ada_webhook_1": secret,
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"type":"v1.conversation.message","data":{"ai_agent_domain":"example.ada.support","conversation_id":"conv-1","message_id":"msg-1","end_user_id":"user-1","author":{"role":"end_user"},"content":"Need help"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/ada/example.ada.support/webhooks/wh_endpoint_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	signAdaWebhookTest(req, secret, body, "msg_delivery_1", "1782889000")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshConversationID != "conv-1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: conversationID=%q tickets=%+v messages=%+v", backfiller.refreshConversationID, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["ada_webhook_event"] != "v1.conversation.message" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

type fakeAdaBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
}

func (f fakeAdaBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeAdaBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID string) (SyncRequest, error) {
	f.refreshConversationID = strings.TrimSpace(conversationID)
	return f.refreshReq, f.refreshErr
}

func signAdaWebhookTest(req *http.Request, secret string, body []byte, messageID, timestamp string) {
	key := adaWebhookSigningKey(secret)
	payload := []byte(messageID + "." + timestamp + ".")
	payload = append(payload, body...)
	mac := hmac.New(sha256.New, key)
	mac.Write(payload)
	req.Header.Set("webhook-id", messageID)
	req.Header.Set("webhook-timestamp", timestamp)
	req.Header.Set("webhook-signature", "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
}
