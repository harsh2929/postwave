// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeHelpScoutSecretResolver struct{ json string }

func (f fakeHelpScoutSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeHelpScoutSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*helpScoutCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestHelpScoutBackfillExchangesTokenThenMapsConversations(t *testing.T) {
	var tokenCalled bool
	var gotAuth, gotMailbox, gotStatus, gotPage, gotEmbed string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth2/token"):
			tokenCalled = true
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "hs.tok", "token_type": "bearer", "expires_in": 7200})
		case r.URL.Path == "/v2/conversations":
			gotAuth = r.Header.Get("Authorization")
			gotMailbox = r.URL.Query().Get("mailbox")
			gotStatus = r.URL.Query().Get("status")
			gotPage = r.URL.Query().Get("page")
			gotEmbed = r.URL.Query().Get("embed")
			if gotAuth != "Bearer hs.tok" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"_embedded": map[string]any{
					"conversations": []map[string]any{
						{"id": 88, "number": 1201, "subject": "Refund?", "status": "active",
							"primaryCustomer": map[string]any{"id": 5, "email": "Ada@Example.com", "first": "Ada", "last": "L"},
							"tags":            []map[string]any{{"tag": "refund"}}, "userUpdatedAt": "2026-06-20T10:00:00Z"},
					},
				},
				"page": map[string]any{"number": 1, "totalPages": 2},
			})
		case strings.Contains(r.URL.Path, "/threads"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"_embedded": map[string]any{"threads": []map[string]any{}},
				"page":      map[string]any{"number": 1, "totalPages": 1},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HelpScoutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HelpScoutSecretsCredentialResolver{Secrets: fakeHelpScoutSecretResolver{json: `{"client_id":"cid","client_secret":"csec"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHelpScout, CredentialsRef: "c", Settings: map[string]any{"mailbox_id": "mailbox_123", "status": "active"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !tokenCalled {
		t.Fatal("help scout did not exchange client credentials for a token")
	}
	if gotMailbox != "mailbox_123" || gotStatus != "active" || gotPage != "1" || gotEmbed != "threads" {
		t.Fatalf("mailbox=%q status=%q page=%q embed=%q", gotMailbox, gotStatus, gotPage, gotEmbed)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Refund?" || tk.Status != "active" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "help-scout://conversation/88" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if req.Cursor != "help-scout:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestHelpScoutBackfillMapsThreadsAndCustomerFallback(t *testing.T) {
	var gotEmbed string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth2/token"):
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "hs.tok", "token_type": "bearer"})
		case r.URL.Path == "/v2/conversations":
			gotEmbed = r.URL.Query().Get("embed")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"_embedded": map[string]any{
					"conversations": []map[string]any{
						{
							"id": 91, "number": 1209, "mailboxId": 7, "subject": "Where is it?", "status": "active", "preview": "Customer question", "createdAt": "2026-06-20T09:59:00Z",
							"primaryCustomer": map[string]any{},
							"tags":            []map[string]any{{"tag": "shipping"}},
							"_embedded": map[string]any{
								"threads": []map[string]any{
									{
										"id": 1001, "type": "customer", "body": "Customer question", "createdAt": "2026-06-20T10:00:00Z",
										"customer":  map[string]any{"id": 501, "type": "customer", "email": "Thread@Example.com", "first": "Thread", "last": "Customer"},
										"createdBy": map[string]any{"id": 501, "type": "customer", "email": "Thread@Example.com", "first": "Thread", "last": "Customer"},
										"source":    map[string]any{"type": "email", "via": "customer"},
									},
									{
										"id": 1002, "type": "message", "body": "Agent answer", "createdAt": "2026-06-20T10:05:00Z",
										"createdBy":  map[string]any{"id": 44, "type": "user", "first": "Help", "last": "Agent"},
										"assignedTo": map[string]any{"id": 44, "type": "user", "first": "Help", "last": "Agent"},
										"source":     map[string]any{"type": "email", "via": "user"},
									},
									{
										"id": 1003, "type": "note", "body": "Internal context", "createdAt": "2026-06-20T10:10:00Z",
										"createdBy": map[string]any{"id": 44, "type": "user", "first": "Help", "last": "Agent"},
										"source":    map[string]any{"type": "email", "via": "user"},
									},
								},
							},
						},
					},
				},
				"page": map[string]any{"number": 1, "totalPages": 1},
			})
		case strings.Contains(r.URL.Path, "/threads"):
			t.Errorf("embedded thread response should not call thread endpoint: %s", r.URL.Path)
			http.Error(w, "unexpected thread fallback", http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HelpScoutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HelpScoutSecretsCredentialResolver{Secrets: fakeHelpScoutSecretResolver{json: `{"client_id":"cid","client_secret":"csec"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHelpScout, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotEmbed != "threads" {
		t.Fatalf("embed=%q, want threads", gotEmbed)
	}
	if len(req.Tickets) != 1 || len(req.Messages) != 3 {
		t.Fatalf("tickets=%d messages=%d req=%+v", len(req.Tickets), len(req.Messages), req)
	}
	tk := req.Tickets[0]
	if tk.Email != "thread@example.com" || tk.RequesterName != "Thread Customer" || tk.Properties["help_scout_customer_id"] != "501" || tk.Properties["help_scout_conversation_number"] != "1209" || tk.Properties["help_scout_mailbox_id"] != "7" {
		t.Fatalf("ticket=%+v", tk)
	}
	assertHelpScoutMessage := func(i int, sourceID, direction, senderType, sender, body string) {
		t.Helper()
		msg := req.Messages[i]
		if msg.SourceID != sourceID || msg.Direction != direction || msg.SenderType != senderType || msg.Sender != sender || msg.BodyText != body || msg.Email != "thread@example.com" {
			t.Fatalf("message[%d]=%+v", i, msg)
		}
	}
	assertHelpScoutMessage(0, "help-scout://thread/1001", "inbound", "customer", "Thread Customer", "Customer question")
	assertHelpScoutMessage(1, "help-scout://thread/1002", "outbound", "agent", "Help Agent", "Agent answer")
	assertHelpScoutMessage(2, "help-scout://thread/1003", "internal", "agent", "Help Agent", "Internal context")
	if req.Messages[1].Properties["help_scout_assigned_to_id"] != "44" {
		t.Fatalf("message properties=%+v", req.Messages[1].Properties)
	}
}

func TestHelpScoutRefreshConversationMapsEmbeddedThreads(t *testing.T) {
	var gotPath, gotEmbed string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth2/token"):
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "hs.tok", "token_type": "bearer"})
		case r.URL.Path == "/v2/conversations/91":
			gotPath = r.URL.Path
			gotEmbed = r.URL.Query().Get("embed")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 91, "number": 1209, "mailboxId": 7, "subject": "Where is it?", "status": "active",
				"primaryCustomer": map[string]any{"id": 501, "email": "Thread@Example.com", "first": "Thread", "last": "Customer"},
				"_embedded": map[string]any{
					"threads": []map[string]any{
						{
							"id": 1001, "type": "customer", "body": "Customer question", "createdAt": "2026-06-20T10:00:00Z",
							"customer":  map[string]any{"id": 501, "type": "customer", "email": "Thread@Example.com", "first": "Thread", "last": "Customer"},
							"createdBy": map[string]any{"id": 501, "type": "customer", "email": "Thread@Example.com", "first": "Thread", "last": "Customer"},
							"source":    map[string]any{"type": "email", "via": "customer"},
						},
					},
				},
			})
		case strings.Contains(r.URL.Path, "/threads"):
			t.Errorf("embedded conversation response should not call thread endpoint: %s", r.URL.Path)
			http.Error(w, "unexpected thread fallback", http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HelpScoutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HelpScoutSecretsCredentialResolver{Secrets: fakeHelpScoutSecretResolver{json: `{"client_id":"cid","client_secret":"csec"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshConversation(context.Background(), "t", Integration{Provider: ProviderHelpScout, CredentialsRef: "c"}, "91")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if gotPath != "/v2/conversations/91" || gotEmbed != "threads" {
		t.Fatalf("path=%q embed=%q", gotPath, gotEmbed)
	}
	if req.RunMode != "webhook" || req.Cursor != "help-scout-webhook-91" || len(req.Tickets) != 1 || len(req.Messages) != 1 {
		t.Fatalf("req=%+v", req)
	}
	if req.Tickets[0].Email != "thread@example.com" || req.Messages[0].SourceID != "help-scout://thread/1001" {
		t.Fatalf("ticket=%+v messages=%+v", req.Tickets, req.Messages)
	}
}

func TestHelpScoutBackfillReturnsThreadRetryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth2/token"):
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "hs.tok"})
		case r.URL.Path == "/v2/conversations":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"_embedded": map[string]any{"conversations": []map[string]any{{"id": 92, "subject": "Slow", "primaryCustomer": map[string]any{"email": "slow@example.com"}}}},
				"page":      map[string]any{"number": 1, "totalPages": 1},
			})
		case r.URL.Path == "/v2/conversations/92/threads":
			w.Header().Set("X-RateLimit-Retry-After", "120")
			http.Error(w, "slow down", http.StatusTooManyRequests)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HelpScoutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HelpScoutSecretsCredentialResolver{Secrets: fakeHelpScoutSecretResolver{json: `{"client_id":"cid","client_secret":"csec"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHelpScout, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected thread provider error")
	}
	var providerErr HelpScoutRESTError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error type=%T err=%v", err, err)
	}
	if providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Minute || providerErr.Path != "/v2/conversations/92/threads" {
		t.Fatalf("providerErr=%+v", providerErr)
	}
}

func TestHelpScoutBackfillReturnsTypedRetryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth2/token"):
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "hs.tok"})
		case strings.Contains(r.URL.Path, "/conversations"):
			w.Header().Set("X-RateLimit-Retry-After", "180")
			w.Header().Set("Retry-After", "60")
			http.Error(w, "slow down", http.StatusTooManyRequests)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HelpScoutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HelpScoutSecretsCredentialResolver{Secrets: fakeHelpScoutSecretResolver{json: `{"client_id":"cid","client_secret":"csec"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHelpScout, CredentialsRef: "c"}, helpScoutCursorPrefix+"2")
	if err == nil {
		t.Fatal("expected provider error")
	}
	var providerErr HelpScoutRESTError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error type=%T err=%v", err, err)
	}
	if providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 3*time.Minute || providerErr.Path != "/v2/conversations" {
		t.Fatalf("providerErr=%+v", providerErr)
	}
}

func TestHelpScoutTokenExchangeReturnsTypedRetryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := HelpScoutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HelpScoutSecretsCredentialResolver{Secrets: fakeHelpScoutSecretResolver{json: `{"client_id":"cid","client_secret":"csec"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHelpScout, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected token provider error")
	}
	var providerErr HelpScoutRESTError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error type=%T err=%v", err, err)
	}
	if providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != time.Minute || providerErr.Path != "" {
		t.Fatalf("providerErr=%+v", providerErr)
	}
}
