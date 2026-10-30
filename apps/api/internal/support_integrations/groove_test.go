// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type staticGrooveCredentialResolver struct {
	creds GrooveCredentials
}

func (r staticGrooveCredentialResolver) ResolveGroove(context.Context, string, Integration) (GrooveCredentials, error) {
	return r.creds, nil
}

func TestGrooveBackfillTicketsAndMessages(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer groove_token" && r.Header.Get("Accept") == "application/json" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/v1/tickets":
			if r.URL.Query().Get("page") != "1" || r.URL.Query().Get("per_page") != "25" || r.URL.Query().Get("state") != "opened" {
				t.Fatalf("unexpected ticket query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"tickets":[{"number":42,"title":"Order help","state":"opened","priority":"urgent","updated_at":"2026-06-30T10:00:00Z","links":{"customer":{"href":"https://api.groovehq.com/v1/customers/buyer%40example.com"},"messages":{"href":"https://api.groovehq.com/v1/tickets/42/messages"},"mailbox":{"href":"https://api.groovehq.com/v1/mailboxes/mailbox_123"}}}],"meta":{"pagination":{"current_page":1,"total_pages":1}}}`))
		case "/v1/tickets/42/messages":
			if r.URL.Query().Get("page") != "1" {
				t.Fatalf("unexpected message query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"messages":[{"id":"m1","plain_text_body":"Need help","body":"<p>Need help</p>","created_at":"2026-06-30T10:01:00Z","links":{"author":{"href":"https://api.groovehq.com/v1/customers/buyer%40example.com"}}},{"id":"m2","plain_text_body":"We can help","created_at":"2026-06-30T10:02:00Z","links":{"author":{"href":"https://api.groovehq.com/v1/agents/agent-1"}}}],"meta":{"pagination":{"current_page":1,"total_pages":1}}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := GrooveRESTBackfiller{Credentials: staticGrooveCredentialResolver{creds: GrooveCredentials{
		AccessToken: "groove_token",
		APIBaseURL:  server.URL + "/v1",
	}}}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGroove,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"mailbox_id": "mailbox_123",
			"state":      "opened",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected Groove bearer auth header")
	}
	if req.Cursor != grooveCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].ConversationID != "42" || req.Tickets[0].Status != "open" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" || req.Messages[1].SenderType != "agent" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
}

func TestGrooveBackfillRetryAfterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "33")
		http.Error(w, `{"error":"rate limited"}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := GrooveRESTBackfiller{Credentials: staticGrooveCredentialResolver{creds: GrooveCredentials{
		AccessToken: "groove_token",
		APIBaseURL:  server.URL + "/v1",
	}}}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderGroove, CredentialsRef: "cred", Settings: map[string]any{"mailbox_id": "mailbox_123"}}, "")
	var restErr GrooveRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 33*time.Second {
		t.Fatalf("expected retry-aware GrooveRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestGrooveWebhookRequiresRouteToken(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/groove/mailbox_123/webhooks", strings.NewReader(`{}`)))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("route without token should not be mounted: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGrooveWebhookRouteTokenSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGroove
	store.integration.Settings = map[string]any{
		"mailbox_id":          "mailbox_123",
		"groove_webhook_id":   "route-token-1",
		"provider_mailbox_id": "mailbox_123",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeGrooveBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "groove://ticket/42",
			ConversationID: "42",
			Email:          "buyer@example.com",
			Subject:        "Order help",
		}},
		Messages: []MessageInput{{
			SourceID:       "groove://ticket/42/message/m1",
			ConversationID: "42",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	deps := &Deps{Repo: store, Suite: suite, GrooveBackfiller: backfiller}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := `{"event":"customer_replied","ticket":{"number":42}}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/groove/mailbox_123/webhooks/route-token-1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshTicketNumber != "42" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: ticket=%q tickets=%+v messages=%+v", backfiller.refreshTicketNumber, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["groove_webhook_event"] != "customer_replied" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

type fakeGrooveBackfiller struct {
	req                 SyncRequest
	err                 error
	refreshReq          SyncRequest
	refreshErr          error
	refreshTicketNumber string
}

func (f fakeGrooveBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	return f.req, f.err
}

func (f *fakeGrooveBackfiller) RefreshTicket(_ context.Context, _ string, _ Integration, ticketNumber string) (SyncRequest, error) {
	f.refreshTicketNumber = strings.TrimSpace(ticketNumber)
	return f.refreshReq, f.refreshErr
}
