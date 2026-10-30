// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type staticFreshchatCredentialResolver struct {
	creds FreshchatCredentials
	err   error
}

func (r staticFreshchatCredentialResolver) ResolveFreshchat(context.Context, string, Integration) (FreshchatCredentials, error) {
	return r.creds, r.err
}

func TestFreshchatBackfillHydratesUserConversationsAndMessages(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok_123" {
			t.Fatalf("authorization header = %q", got)
		}
		seen = append(seen, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/v2/users":
			if r.URL.Query().Get("page") != "1" || r.URL.Query().Get("items_per_page") != "2" {
				t.Fatalf("unexpected users query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"users":[{"id":"user-1","email":"Ada@Example.com","first_name":"Ada","last_name":"L","phone":"+15550001"}],"pagination":{"total_pages":1,"current_page":1,"items_per_page":2}}`))
		case "/v2/users/user-1/conversations":
			_, _ = w.Write([]byte(`{"conversations":[{"id":"conv-1"}]}`))
		case "/v2/conversations/conv-1":
			_, _ = w.Write([]byte(`{"conversation":{"conversation_id":"conv-1","status":"assigned","channel_id":"channel-1","assigned_agent_id":"agent-1","properties":{"priority":"high"},"updated_time":"2026-07-01T10:00:00.000Z"}}`))
		case "/v2/conversations/conv-1/messages":
			if r.URL.Query().Get("items_per_page") != "50" {
				t.Fatalf("unexpected messages query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"messages":[{"id":"msg-1","conversation_id":"conv-1","actor_type":"user","actor_id":"user-1","user_id":"user-1","message_type":"normal","message_source":"web","created_time":"2026-07-01T10:01:00.000Z","message_parts":[{"text":{"content":"Customer hello"}}]},{"id":"msg-2","conversation_id":"conv-1","actor_type":"agent","actor_id":"agent-1","message_type":"normal","message_source":"web","created_time":"2026-07-01T10:02:00.000Z","message_parts":[{"text":{"content":"Agent reply","content_type":"text/html"}}]}],"pagination":{"total_pages":1,"current_page":1,"items_per_page":50}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshchatRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: staticFreshchatCredentialResolver{creds: FreshchatCredentials{
			Token:      "tok_123",
			APIBaseURL: srv.URL,
		}},
		PageSize: 2,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderFreshchat, CredentialsRef: "cred", Settings: map[string]any{"channel_id": "channel-1"}}, "")
	if err != nil {
		t.Fatalf("BackfillPage error: %v", err)
	}
	if req.Cursor != freshchatCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %+v paths=%v", req.Tickets, seen)
	}
	tk := req.Tickets[0]
	if tk.SourceID != "freshchat://conversation/conv-1" || tk.Email != "ada@example.com" || tk.Status != "open" || tk.Priority != "high" || tk.Assignee != "agent-1" {
		t.Fatalf("ticket not mapped: %+v", tk)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %+v", req.Messages)
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[0].SenderType != "customer" || req.Messages[0].BodyText != "Customer hello" {
		t.Fatalf("customer message not mapped: %+v", req.Messages[0])
	}
	if req.Messages[1].Direction != "outbound" || req.Messages[1].SenderType != "agent" || req.Messages[1].BodyHTML != "Agent reply" {
		t.Fatalf("agent message not mapped: %+v", req.Messages[1])
	}
}

func TestFreshchatRefreshConversationFetchesUserAndThread(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/users/user-1":
			_, _ = w.Write([]byte(`{"id":"user-1","email":"Refresh@Example.com","first_name":"Refresh","last_name":"Buyer"}`))
		case "/v2/conversations/conv-1":
			_, _ = w.Write([]byte(`{"conversation":{"conversation_id":"conv-1","status":"new","updated_time":"2026-07-01T10:00:00.000Z"}}`))
		case "/v2/conversations/conv-1/messages":
			_, _ = w.Write([]byte(`{"messages":[{"id":"msg-1","conversation_id":"conv-1","actor_type":"user","actor_id":"user-1","created_time":"2026-07-01T10:01:00.000Z","message_parts":[{"text":{"content":"Refresh body"}}]}],"pagination":{"total_pages":1,"current_page":1,"items_per_page":50}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshchatRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: staticFreshchatCredentialResolver{creds: FreshchatCredentials{
			Token:      "tok_123",
			APIBaseURL: srv.URL,
		}},
	}
	req, err := backfiller.RefreshConversation(context.Background(), "tenant-1", Integration{Provider: ProviderFreshchat, CredentialsRef: "cred"}, "conv-1", "user-1")
	if err != nil {
		t.Fatalf("RefreshConversation error: %v", err)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].Email != "refresh@example.com" || req.Tickets[0].RequesterName != "Refresh Buyer" {
		t.Fatalf("ticket not refreshed: %+v", req.Tickets)
	}
	if len(req.Messages) != 1 || req.Messages[0].BodyText != "Refresh body" {
		t.Fatalf("message not refreshed: %+v", req.Messages)
	}
}

func TestFreshchatBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := FreshchatRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: staticFreshchatCredentialResolver{creds: FreshchatCredentials{
			Token:      "tok_123",
			APIBaseURL: srv.URL,
		}},
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderFreshchat, CredentialsRef: "cred"}, "")
	var restErr FreshchatRESTError
	if !errors.As(err, &restErr) || restErr.RetryAfter == 0 {
		t.Fatalf("expected retry-aware FreshchatRESTError, got %T %v", err, err)
	}
	cfg, cfgErr := supportBackfillConfig(ProviderFreshchat)
	if cfgErr != nil {
		t.Fatalf("supportBackfillConfig error: %v", cfgErr)
	}
	now := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	retryCursor := supportBackfillRetryCursor(cfg, freshchatCursorPrefix+"1", "BACKFILL_FAILED", err, now)
	state, ok, decodeErr := decodeSupportRetryCursor(cfg, retryCursor)
	if decodeErr != nil || !ok {
		t.Fatalf("decode retry cursor error=%v ok=%v cursor=%q", decodeErr, ok, retryCursor)
	}
	if state.NextAttemptAt != "2026-07-01T10:00:42Z" {
		t.Fatalf("retry cursor did not preserve Retry-After: %+v", state)
	}
}

func TestFreshchatWebhookSignedSparseRefresh(t *testing.T) {
	body := []byte(`{"action":"message_create","data":{"message":{"conversation_id":"conv-1","user_id":"user-1","message_parts":[{"text":{"content":"hello"}}]}}}`)
	publicKey, signature := freshchatTestSignature(t, body)
	store := &fakeStore{integration: Integration{
		ID:             "int-1",
		TenantID:       "tenant-1",
		Provider:       ProviderFreshchat,
		Status:         "connected",
		CredentialsRef: "cred",
		Settings: map[string]any{
			"account_domain":               "acme.freshchat.com",
			"freshchat_webhook_id":         "wh_123",
			"freshchat_webhook_public_key": publicKey,
		},
	}}
	suite := &fakeSuiteSink{}
	backfiller := &fakeFreshchatBackfiller{refreshReq: SyncRequest{
		RunMode: "webhook",
		Cursor:  "freshchat-webhook-conv-1",
		Tickets: []TicketInput{{
			SourceID:       "freshchat://conversation/conv-1",
			ConversationID: "conv-1",
			Email:          "buyer@example.com",
			Properties:     map[string]any{},
		}},
		Messages: []MessageInput{{
			SourceID:       "freshchat://message/msg-1",
			ConversationID: "conv-1",
			Email:          "buyer@example.com",
			BodyText:       "hello",
			Properties:     map[string]any{},
		}},
	}}
	deps := &Deps{Repo: store, Suite: suite, FreshchatBackfiller: backfiller}
	r := chi.NewRouter()
	mountArchivedPublicRoutesFixture(r, deps)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/freshchat/acme.freshchat.com/webhooks/wh_123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Freshchat-Signature", signature)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshConversationID != "conv-1" || backfiller.refreshUserID != "user-1" {
		t.Fatalf("refresh not called with sparse ids: %+v", backfiller)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].SourceID != "freshchat://conversation/conv-1" {
		t.Fatalf("ticket not written: %+v", suite.tickets)
	}
	if suite.tickets[0].Properties["freshchat_webhook_event"] != "message_create" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

type fakeFreshchatBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
	refreshUserID         string
}

func (f fakeFreshchatBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeFreshchatBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID, userID string) (SyncRequest, error) {
	f.refreshConversationID = strings.TrimSpace(conversationID)
	f.refreshUserID = strings.TrimSpace(userID)
	return f.refreshReq, f.refreshErr
}

func freshchatTestSignature(t *testing.T, body []byte) (string, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}
	sum := sha256.Sum256(body)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("sign body: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	return string(pemBytes), base64.StdEncoding.EncodeToString(sig)
}
