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
	"time"

	"github.com/go-chi/chi/v5"
)

type staticAsanaSupportCredentialResolver struct {
	creds AsanaSupportCredentials
}

func (r staticAsanaSupportCredentialResolver) ResolveAsanaSupport(context.Context, string, Integration) (AsanaSupportCredentials, error) {
	return r.creds, nil
}

func TestAsanaSupportBackfillTasksAndStories(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer asana_token" && r.Header.Get("Accept") == "application/json" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/api/1.0/projects/project_456/tasks":
			if r.URL.Query().Get("limit") != "100" {
				t.Fatalf("unexpected task query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"data":[{"gid":"task_1","name":"Need help","notes":"Buyer: buyer@example.com","completed":false,"created_at":"2026-06-30T10:00:00Z","modified_at":"2026-06-30T10:01:00Z","permalink_url":"https://app.asana.com/0/project/task","created_by":{"gid":"user_1","name":"Buyer","email":"buyer@example.com"},"assignee":{"gid":"agent_1","name":"Agent","email":"agent@example.com"}}],"next_page":null}`))
		case "/api/1.0/tasks/task_1/stories":
			_, _ = w.Write([]byte(`{"data":[{"gid":"story_1","text":"Need help","type":"comment","created_at":"2026-06-30T10:01:00Z","created_by":{"gid":"user_1","name":"Buyer","email":"buyer@example.com"}},{"gid":"story_2","text":"We can help","type":"comment","created_at":"2026-06-30T10:02:00Z","created_by":{"gid":"agent_1","name":"Agent","email":"agent@example.com"}}],"next_page":null}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := AsanaSupportRESTBackfiller{Credentials: staticAsanaSupportCredentialResolver{creds: AsanaSupportCredentials{
		AccessToken: "asana_token",
		APIBaseURL:  server.URL + "/api/1.0",
	}}}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderAsanaSupport,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"workspace_id": "workspace_123",
			"project_id":   "project_456",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected Asana bearer auth header")
	}
	if req.Cursor != asanaCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].ConversationID != "task_1" || req.Tickets[0].Status != "open" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
}

func TestAsanaSupportBackfillRetryAfterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "28")
		http.Error(w, `{"errors":[{"message":"rate limited"}]}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := AsanaSupportRESTBackfiller{Credentials: staticAsanaSupportCredentialResolver{creds: AsanaSupportCredentials{
		AccessToken: "asana_token",
		APIBaseURL:  server.URL + "/api/1.0",
	}}}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderAsanaSupport, CredentialsRef: "cred", Settings: map[string]any{"workspace_id": "workspace_123"}}, "")
	var restErr AsanaSupportRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 28*time.Second {
		t.Fatalf("expected retry-aware AsanaSupportRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestAsanaSupportWebhookHandshake(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/asana-support/workspace_123/webhooks/webhook-1", nil)
	req.Header.Set("X-Hook-Secret", "hook-secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("X-Hook-Secret") != "hook-secret" {
		t.Fatalf("handshake failed: status=%d secret=%q body=%s", rec.Code, rec.Header().Get("X-Hook-Secret"), rec.Body.String())
	}
}

func TestAsanaSupportWebhookSignedSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderAsanaSupport
	store.integration.Settings = map[string]any{
		"workspace_id":             "workspace_123",
		"project_id":               "project_456",
		"asana_webhook_secret_ref": "cred_asana_webhook_1",
		"asana_webhook_id":         "webhook-1",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeAsanaSupportBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "asana-support://task/task_1",
			ConversationID: "task_1",
			Email:          "buyer@example.com",
			Subject:        "Need help",
		}},
		Messages: []MessageInput{{
			SourceID:       "asana-support://task/task_1/story/story_1",
			ConversationID: "task_1",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	deps := &Deps{
		Repo:                   store,
		Suite:                  suite,
		AsanaSupportBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_asana_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"events":[{"action":"changed","resource":{"gid":"task_1","resource_type":"task"}}]}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/asana-support/workspace_123/webhooks/webhook-1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hook-Signature", signAsanaWebhookTest("secret", body))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshTaskID != "task_1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: task=%q tickets=%+v messages=%+v", backfiller.refreshTaskID, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["asana_webhook_event"] != "task.changed" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

func signAsanaWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
