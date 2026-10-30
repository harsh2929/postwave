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

	"github.com/go-chi/chi/v5"
)

type staticGladlyCredentialResolver struct {
	creds GladlyCredentials
}

func (r staticGladlyCredentialResolver) ResolveGladly(context.Context, string, Integration) (GladlyCredentials, error) {
	return r.creds, nil
}

func TestGladlyBackfillCustomerConversationsItemsAndTasks(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if ok && username == "api@example.com" && password == "gladly_token" && r.Header.Get("Accept") == "application/json" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/api/v1/customer-profiles/cust-1":
			_, _ = w.Write([]byte(`{"id":"cust-1","name":"Gladly Buyer","emails":[{"original":"Buyer@Example.com"}]}`))
		case "/api/v1/customers/cust-1/conversations":
			_, _ = w.Write([]byte(`[{"id":"conv-1","customerId":"cust-1","subject":"Order help","status":"OPEN","updatedAt":"2026-06-30T10:00:00Z"}]`))
		case "/api/v1/conversations/conv-1/items":
			w.Header().Set("Gladly-Limited-Data", "false")
			_, _ = w.Write([]byte(`[{"id":"item-1","content":{"body":"Need help"},"initiator":{"type":"CUSTOMER","name":"Gladly Buyer"},"timestamp":"2026-06-30T10:01:00Z"},{"id":"item-2","content":{"body":"We can help"},"initiator":{"type":"AGENT","name":"Agent One"},"timestamp":"2026-06-30T10:02:00Z"}]`))
		case "/api/v1/customers/cust-1/tasks":
			switch r.URL.Query().Get("status") {
			case "OPEN":
				_, _ = w.Write([]byte(`[{"id":"task-1","customerId":"cust-1","status":"OPEN","body":"Follow up","createdAt":"2026-06-30T10:03:00Z"}]`))
			case "CLOSED":
				_, _ = w.Write([]byte(`[]`))
			default:
				t.Fatalf("unexpected task query: %s", r.URL.RawQuery)
			}
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := GladlyRESTBackfiller{Credentials: staticGladlyCredentialResolver{creds: GladlyCredentials{
		Email:      "api@example.com",
		APIToken:   "gladly_token",
		APIBaseURL: server.URL,
	}}}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGladly,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"organization_domain": "acme.gladly.com",
			"customer_ids":        "cust-1",
			"include_tasks":       "true",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected Gladly Basic auth header")
	}
	if req.Cursor != gladlyCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 || len(req.Events) != 1 {
		body, _ := json.Marshal(req)
		t.Fatalf("unexpected request cursor=%q tickets=%d messages=%d events=%d body=%s", req.Cursor, len(req.Tickets), len(req.Messages), len(req.Events), body)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].ConversationID != "conv-1" || req.Tickets[0].RequesterName != "Gladly Buyer" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" || req.Messages[1].SenderType != "agent" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
	if req.Events[0].EventName != "gladly.task.open" || req.Events[0].Email != "buyer@example.com" {
		t.Fatalf("task event mapping failed: %+v", req.Events[0])
	}
}

func TestGladlyBackfillRetryAfterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "45")
		http.Error(w, `{"error":"rate limited"}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := GladlyRESTBackfiller{Credentials: staticGladlyCredentialResolver{creds: GladlyCredentials{
		Email:      "api@example.com",
		APIToken:   "gladly_token",
		APIBaseURL: server.URL,
	}}}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderGladly, CredentialsRef: "cred", Settings: map[string]any{"organization_domain": "acme.gladly.com", "customer_ids": "cust-1"}}, "")
	var restErr GladlyRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 45*time.Second {
		t.Fatalf("expected retry-aware GladlyRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestGladlyCompleteCursorStillPollsRecentEventsWithoutCustomerIDs(t *testing.T) {
	var sawEvents bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/events" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		sawEvents = true
		if r.URL.Query().Get("startAt") != "2026-06-30T11:00:00Z" || len(r.URL.Query()["entities"]) == 0 {
			t.Fatalf("unexpected events query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/x-jsonlines")
		_, _ = w.Write([]byte(""))
	}))
	defer server.Close()

	backfiller := GladlyRESTBackfiller{
		Credentials: staticGladlyCredentialResolver{creds: GladlyCredentials{
			Email:      "api@example.com",
			APIToken:   "gladly_token",
			APIBaseURL: server.URL,
		}},
		Now: func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderGladly, CredentialsRef: "cred", Settings: map[string]any{"organization_domain": "acme.gladly.com"}}, gladlyCursorComplete)
	if err != nil {
		t.Fatal(err)
	}
	if !sawEvents || req.Cursor != gladlyCursorComplete {
		t.Fatalf("expected rolling events poll with complete cursor, sawEvents=%t req=%+v", sawEvents, req)
	}
}

func TestVerifyGladlyWebhookAuth(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("X-Gladly-Webhook-Token", "secret")
	if err := VerifyGladlyWebhookAuth("secret", req); err != nil {
		t.Fatalf("valid header token failed: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.SetBasicAuth("postwave", "secret")
	if err := VerifyGladlyWebhookAuth("secret", req); err != nil {
		t.Fatalf("valid basic token failed: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Authorization", "Bearer secret")
	if err := VerifyGladlyWebhookAuth("secret", req); err != nil {
		t.Fatalf("valid bearer token failed: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("X-Gladly-Webhook-Token", "wrong")
	if err := VerifyGladlyWebhookAuth("secret", req); !errors.Is(err, ErrInvalidGladlyWebhookAuth) {
		t.Fatalf("invalid auth error=%v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	if err := VerifyGladlyWebhookAuth("secret", req); !errors.Is(err, ErrMissingGladlyWebhookAuth) {
		t.Fatalf("missing auth error=%v", err)
	}
}

func TestGladlyWebhookAuthenticatedSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGladly
	store.integration.Settings = map[string]any{
		"organization_domain":        "acme.gladly.com",
		"gladly_webhook_token_ref":   "cred_gladly_webhook_1",
		"gladly_webhook_id":          "webhook-1",
		"gladly_customer_ids":        "cust-1",
		"gladly_organization_domain": "acme.gladly.com",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeGladlyBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "gladly://conversation/conv-1",
			ConversationID: "conv-1",
			Email:          "buyer@example.com",
			Subject:        "Gladly conversation",
		}},
		Messages: []MessageInput{{
			SourceID:       "gladly://conversation/conv-1/item/item-1",
			ConversationID: "conv-1",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	deps := &Deps{
		Repo:             store,
		Suite:            suite,
		GladlyBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_gladly_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := `{"id":"evt-1","event":"CONVERSATION","conversationId":"conv-1","customerId":"cust-1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/gladly/acme.gladly.com/webhooks/webhook-1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Gladly-Webhook-Token", "secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshConversationID != "conv-1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: conversationID=%q tickets=%+v messages=%+v", backfiller.refreshConversationID, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["gladly_webhook_event"] != "CONVERSATION" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

type fakeGladlyBackfiller struct {
	req                   SyncRequest
	err                   error
	refreshReq            SyncRequest
	refreshErr            error
	refreshConversationID string
	refreshCustomerID     string
	refreshTaskID         string
}

func (f fakeGladlyBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeGladlyBackfiller) RefreshConversation(_ context.Context, _ string, _ Integration, conversationID string) (SyncRequest, error) {
	f.refreshConversationID = strings.TrimSpace(conversationID)
	return f.refreshReq, f.refreshErr
}

func (f *fakeGladlyBackfiller) RefreshCustomer(_ context.Context, _ string, _ Integration, customerID string) (SyncRequest, error) {
	f.refreshCustomerID = strings.TrimSpace(customerID)
	return f.refreshReq, f.refreshErr
}

func (f *fakeGladlyBackfiller) RefreshTask(_ context.Context, _ string, _ Integration, taskID string) (SyncRequest, error) {
	f.refreshTaskID = strings.TrimSpace(taskID)
	return f.refreshReq, f.refreshErr
}
