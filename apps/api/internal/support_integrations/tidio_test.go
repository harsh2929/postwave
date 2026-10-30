// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type staticTidioCredentialResolver struct {
	creds TidioCredentials
}

func (r staticTidioCredentialResolver) ResolveTidio(context.Context, string, Integration) (TidioCredentials, error) {
	return r.creds, nil
}

func TestTidioBackfillHydratesTicketsContactsAndMessages(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Tidio-Openapi-Client-Id") == "ci_test" && r.Header.Get("X-Tidio-Openapi-Client-Secret") == "cs_test" && r.Header.Get("Accept") == "application/json; version=1" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/tickets":
			_, _ = w.Write([]byte(`{"tickets":[{"id":"ticket-1","subject":"Order help","contact_id":"contact-1","contact_email":"Buyer@Example.com","priority":"urgent","status":"open","custom_channel_id":"channel-1"}],"meta":{"cursor":null,"limit":100}}`))
		case "/tickets/ticket-1":
			_, _ = w.Write([]byte(`{"id":"ticket-1","subject":"Order help","contact_id":"contact-1","contact_email":"Buyer@Example.com","priority":"urgent","status":"open","custom_channel_id":"channel-1","messages":[{"message_id":"msg-1","author_type":"contact","author_id":"contact-1","message":"Need help","created_at":"2026-06-20T10:00:00Z"}]}`))
		case "/contacts":
			_, _ = w.Write([]byte(`{"contacts":[{"id":"contact-1","email":"Buyer@Example.com","first_name":"Ada","last_name":"L","phone":"+15550001"}],"meta":{"cursor":null,"limit":100}}`))
		case "/contacts/contact-1/messages":
			_, _ = w.Write([]byte(`{"conversation_url":"https://tidio.com/panel/conversations/contact-1","messages":[{"id":"chat-1","author_type":"operator","author_id":"op-1","message":"We can help","created_at":"2026-06-20T10:01:00Z"}],"meta":{"cursor":null,"limit":100}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := TidioRESTBackfiller{
		Credentials: staticTidioCredentialResolver{creds: TidioCredentials{
			ClientID:     "ci_test",
			ClientSecret: "cs_test",
			APIBaseURL:   server.URL,
		}},
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderTidio, CredentialsRef: "cred", Settings: map[string]any{"channel_id": "channel-1"}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected Tidio OpenAPI auth/version headers")
	}
	if req.Cursor != tidioCursorComplete || len(req.Tickets) != 2 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].ConversationID != "ticket-1" || req.Tickets[0].Priority != "urgent" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" {
		t.Fatalf("message directions failed: %+v", req.Messages)
	}
	if req.Tickets[1].ConversationID != "contact:contact-1" || req.Tickets[1].RequesterName != "Ada L" {
		t.Fatalf("contact conversation mapping failed: %+v", req.Tickets[1])
	}
}

func TestTidioBackfillRetryAfterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "90")
		http.Error(w, `{"errors":[{"code":"too_many_requests"}]}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := TidioRESTBackfiller{
		Credentials: staticTidioCredentialResolver{creds: TidioCredentials{
			ClientID:     "ci_test",
			ClientSecret: "cs_test",
			APIBaseURL:   server.URL,
		}},
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderTidio, CredentialsRef: "cred"}, "")
	var restErr TidioRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter == 0 {
		t.Fatalf("expected retry-aware TidioRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestTidioWebhookSignedDirectTicketIngest(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTidio
	store.integration.Settings = map[string]any{
		"project_public_key":       "pub_123",
		"tidio_webhook_secret_ref": "cred_tidio_webhook_1",
	}
	suite := &fakeSuiteSink{}
	deps := &Deps{
		Repo:  store,
		Suite: suite,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_tidio_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"created_at":1687177445,"project_public_key":"pub_123","topic":"ticket.created","version":1,"webhook_id":"wh_1","content":{"id":"ticket-1","status":"open","subject":"Where is my order?","contact_email":"Buyer@Example.com"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/tidio/pub_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-tidio-signature", signTidioWebhookTest("secret", body, "1687177446"))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(suite.tickets) != 1 || suite.tickets[0].Email != "buyer@example.com" || suite.tickets[0].ConversationID != "ticket-1" {
		t.Fatalf("ticket not ingested: %+v", suite.tickets)
	}
	if suite.tickets[0].Properties["tidio_webhook_event"] != "ticket.created" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

func TestTidioWebhookSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTidio
	store.integration.Settings = map[string]any{
		"project_public_key":       "pub_123",
		"tidio_webhook_secret_ref": "cred_tidio_webhook_1",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeTidioBackfiller{refreshTicketReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "tidio://ticket/ticket-1",
			ConversationID: "ticket-1",
			Email:          "buyer@example.com",
			Subject:        "Order help",
		}},
		Messages: []MessageInput{{
			SourceID:       "tidio://ticket/ticket-1/message/msg-1",
			ConversationID: "ticket-1",
			Email:          "buyer@example.com",
			BodyText:       "Reply",
		}},
	}}
	deps := &Deps{
		Repo:            store,
		Suite:           suite,
		TidioBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_tidio_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"created_at":1687177445,"project_public_key":"pub_123","topic":"ticket.replied","version":1,"webhook_id":"wh_1","content":{"id":"ticket-1","message_id":"msg-1"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/tidio/pub_123/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-tidio-signature", signTidioWebhookTest("secret", body, "1687177446"))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshTicketID != "ticket-1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: ticketID=%q tickets=%+v messages=%+v", backfiller.refreshTicketID, suite.tickets, suite.messages)
	}
}

type fakeTidioBackfiller struct {
	req              SyncRequest
	err              error
	refreshTicketReq SyncRequest
	refreshTicketErr error
	refreshTicketID  string
	refreshContactID string
}

func (f fakeTidioBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeTidioBackfiller) RefreshTicket(_ context.Context, _ string, _ Integration, ticketID string) (SyncRequest, error) {
	f.refreshTicketID = strings.TrimSpace(ticketID)
	return f.refreshTicketReq, f.refreshTicketErr
}

func (f *fakeTidioBackfiller) RefreshContactConversation(_ context.Context, _ string, _ Integration, contactID string) (SyncRequest, error) {
	f.refreshContactID = strings.TrimSpace(contactID)
	return f.refreshTicketReq, f.refreshTicketErr
}

func signTidioWebhookTest(secret string, body []byte, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(append(append([]byte{}, body...), append([]byte("_"), []byte(timestamp)...)...))
	return "t=" + timestamp + ",s=" + hex.EncodeToString(mac.Sum(nil))
}
