// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeLiveChatSecretResolver struct{ json string }

func (f fakeLiveChatSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeLiveChatSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*liveChatCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestLiveChatBackfillMapsArchivedChats(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"chats": []map[string]any{
				{"id": "chat1", "users": []map[string]any{
					{"type": "agent", "email": "agent@acme.com", "name": "Agent"},
					{"type": "customer", "email": "Ada@Example.com", "name": "Ada L"},
				}, "thread": map[string]any{"id": "th1"}},
			},
			"next_page_id": "NP2",
		})
	}))
	defer srv.Close()

	backfiller := LiveChatRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: LiveChatSecretsCredentialResolver{Secrets: fakeLiveChatSecretResolver{json: `{"access_token":"lc.pat"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderLiveChat, CredentialsRef: "c", Settings: map[string]any{"group_id": "4, 4, 7, bad"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotMethod != http.MethodPost || !strings.Contains(gotPath, "/agent/action/list_archives") || gotAuth != "Bearer lc.pat" || !strings.Contains(gotBody, "limit") {
		t.Fatalf("method=%q path=%q auth=%q body=%q", gotMethod, gotPath, gotAuth, gotBody)
	}
	var posted struct {
		Limit   int `json:"limit"`
		Filters struct {
			GroupIDs []int `json:"group_ids"`
		} `json:"filters"`
	}
	if err := json.Unmarshal([]byte(gotBody), &posted); err != nil {
		t.Fatalf("decode body %q: %v", gotBody, err)
	}
	if posted.Limit != 1 || len(posted.Filters.GroupIDs) != 2 || posted.Filters.GroupIDs[0] != 4 || posted.Filters.GroupIDs[1] != 7 {
		t.Fatalf("posted body = %+v", posted)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.ConversationID != "chat1" || tk.RequesterName != "Ada L" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "livechat://chat/chat1" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if req.Cursor != "livechat:NP2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestLiveChatRegisterWebhookUsesConfigurationAPI(t *testing.T) {
	var gotPath, gotAuth string
	var posted map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "provider_wh_1"})
	}))
	defer srv.Close()

	manager := LiveChatRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: LiveChatSecretsCredentialResolver{Secrets: fakeLiveChatSecretResolver{json: `{"access_token":"lc.pat"}`}},
		APIBaseURL:  srv.URL,
	}
	out, err := manager.RegisterLiveChatWebhook(context.Background(), "tenant_1", Integration{Provider: ProviderLiveChat, CredentialsRef: "cred_livechat_1"}, LiveChatWebhookRegistrationInput{
		URL:           "https://app.postwave.test/api/public/support-integrations/livechat/acct_1/webhooks?webhook_id=route_1",
		Action:        "incoming_event",
		SecretKey:     "secret-value",
		OwnerClientID: "owner_client_1",
		Description:   "Moosewave LiveChat incoming_event webhook",
	})
	if err != nil {
		t.Fatalf("register webhook: %v", err)
	}
	if gotPath != "/v3.3/configuration/action/register_webhook" || gotAuth != "Bearer lc.pat" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if out.ProviderWebhookID != "provider_wh_1" || out.Action != "incoming_event" {
		t.Fatalf("out=%+v", out)
	}
	if posted["url"] != "https://app.postwave.test/api/public/support-integrations/livechat/acct_1/webhooks?webhook_id=route_1" ||
		posted["action"] != "incoming_event" ||
		posted["secret_key"] != "secret-value" ||
		posted["owner_client_id"] != "owner_client_1" ||
		posted["type"] != "license" ||
		posted["description"] == "" {
		t.Fatalf("posted=%+v", posted)
	}
}

func TestLiveChatUnregisterWebhookTreatsNotFoundAsAlreadyAbsent(t *testing.T) {
	var gotPath string
	var posted map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
	}))
	defer srv.Close()

	manager := LiveChatRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: LiveChatSecretsCredentialResolver{Secrets: fakeLiveChatSecretResolver{json: `{"access_token":"lc.pat"}`}},
		APIBaseURL:  srv.URL,
	}
	out, err := manager.UnregisterLiveChatWebhook(context.Background(), "tenant_1", Integration{Provider: ProviderLiveChat, CredentialsRef: "cred_livechat_1"}, "provider_wh_1", "owner_client_1")
	if err != nil {
		t.Fatalf("unregister webhook should treat 404 as clean: %v", err)
	}
	if gotPath != "/v3.3/configuration/action/unregister_webhook" {
		t.Fatalf("path=%q", gotPath)
	}
	if posted["id"] != "provider_wh_1" || posted["owner_client_id"] != "owner_client_1" {
		t.Fatalf("posted=%+v", posted)
	}
	if out.ProviderWebhookID != "provider_wh_1" || out.Status != "already_absent" || out.ProviderStatusCode != http.StatusNotFound {
		t.Fatalf("out=%+v", out)
	}
}

func TestLiveChatBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "21")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer srv.Close()

	backfiller := LiveChatRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: LiveChatSecretsCredentialResolver{Secrets: fakeLiveChatSecretResolver{json: `{"access_token":"lc.pat"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderLiveChat, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected error")
	}
	var restErr LiveChatRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 21*time.Second {
		t.Fatalf("err=%T %[1]v rest=%+v", err, restErr)
	}
	if delay := supportRetryDelay(1, err); delay != 21*time.Second {
		t.Fatalf("retry delay=%s", delay)
	}
}
