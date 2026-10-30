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

type staticJiraServiceCredentialResolver struct {
	creds JiraServiceManagementCredentials
}

func (r staticJiraServiceCredentialResolver) ResolveJiraServiceManagement(context.Context, string, Integration) (JiraServiceManagementCredentials, error) {
	return r.creds, nil
}

func TestJiraServiceManagementBackfillRequestsAndComments(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer jira_token" && r.Header.Get("Accept") == "application/json" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/rest/servicedeskapi/request":
			if r.URL.Query().Get("serviceDeskId") != "desk_456" || r.URL.Query().Get("start") != "0" || r.URL.Query().Get("limit") != "50" {
				t.Fatalf("unexpected request query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"start":0,"limit":50,"size":1,"isLastPage":true,"values":[{"issueId":"10001","issueKey":"SUP-1","serviceDeskId":"desk_456","requestTypeId":"rt_1","summary":"Need help","requestFieldValues":[{"fieldId":"email","label":"Email","value":"Buyer@Example.com"}],"reporter":{"displayName":"Jira Buyer"},"currentStatus":{"status":"Waiting for support","statusDate":{"iso8601":"2026-06-30T10:01:00Z"}}}]}`))
		case "/rest/servicedeskapi/request/SUP-1/comment":
			if r.URL.Query().Get("public") != "false" {
				t.Fatalf("expected public=false comments query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"start":0,"limit":100,"size":2,"isLastPage":true,"values":[{"id":"c1","body":"Need help","public":true,"author":{"displayName":"Jira Buyer","emailAddress":"buyer@example.com"},"created":{"iso8601":"2026-06-30T10:01:00Z"}},{"id":"c2","body":"We can help","public":true,"author":{"displayName":"Agent One","emailAddress":"agent@example.com"},"created":{"iso8601":"2026-06-30T10:02:00Z"}}]}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := JiraServiceManagementRESTBackfiller{Credentials: staticJiraServiceCredentialResolver{creds: JiraServiceManagementCredentials{
		AccessToken: "jira_token",
		APIBaseURL:  server.URL,
	}}}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderJiraServiceManagement,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"site_id":         "site_123",
			"service_desk_id": "desk_456",
			"project_key":     "SUP",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected Jira Service Management bearer auth header")
	}
	if req.Cursor != jiraServiceCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].ConversationID != "SUP-1" || req.Tickets[0].Status != "open" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
}

func TestJiraServiceManagementBackfillRetryAfterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "41")
		http.Error(w, `{"errorMessages":["slow down"]}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := JiraServiceManagementRESTBackfiller{Credentials: staticJiraServiceCredentialResolver{creds: JiraServiceManagementCredentials{
		AccessToken: "jira_token",
		APIBaseURL:  server.URL,
	}}}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderJiraServiceManagement, CredentialsRef: "cred", Settings: map[string]any{"site_id": "site_123", "service_desk_id": "desk_456"}}, "")
	var restErr JiraServiceManagementRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 41*time.Second {
		t.Fatalf("expected retry-aware JiraServiceManagementRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestJiraServiceManagementWebhookRouteTokenSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJiraServiceManagement
	store.integration.Settings = map[string]any{
		"site_id":                            "site_123",
		"service_desk_id":                    "desk_456",
		"jira_service_management_webhook_id": "webhook-1",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeJiraServiceManagementBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "jira-service-management://request/SUP-1",
			ConversationID: "SUP-1",
			Email:          "buyer@example.com",
			Subject:        "Need help",
		}},
		Messages: []MessageInput{{
			SourceID:       "jira-service-management://request/SUP-1/comment/c1",
			ConversationID: "SUP-1",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	deps := &Deps{Repo: store, Suite: suite, JiraServiceManagementBackfiller: backfiller}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"webhookEvent":"jira:issue_updated","issue":{"id":"10001","key":"SUP-1"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/jira-service-management/site_123/webhooks/webhook-1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Atlassian-Webhook-Identifier", "delivery-1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshIssueID != "SUP-1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: issue=%q tickets=%+v messages=%+v", backfiller.refreshIssueID, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["jira_service_management_webhook_event"] != "jira:issue_updated" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}
