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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type staticClickUpSupportCredentialResolver struct {
	creds ClickUpSupportCredentials
}

func (r staticClickUpSupportCredentialResolver) ResolveClickUpSupport(context.Context, string, Integration) (ClickUpSupportCredentials, error) {
	return r.creds, nil
}

func TestClickUpSupportBackfillTasksAndComments(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "click_token" && r.Header.Get("Accept") == "application/json" {
			sawAuth = true
		}
		switch r.URL.Path {
		case "/api/v2/list/list_456/task":
			if r.URL.Query().Get("page") != "0" || r.URL.Query().Get("include_closed") != "true" {
				t.Fatalf("unexpected task query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"tasks":[{"id":"task_1","name":"Need help","text_content":"Buyer buyer@example.com needs help","url":"https://app.clickup.com/t/task_1","date_created":"1782813600000","date_updated":"1782813660000","status":{"status":"open","type":"open"},"priority":{"id":"2","priority":"high"},"creator":{"id":1,"username":"Buyer","email":"buyer@example.com"},"assignees":[{"id":2,"username":"Agent","email":"agent@example.com"}]}],"last_page":true}`))
		case "/api/v2/task/task_1/comment":
			_, _ = w.Write([]byte(`{"comments":[{"id":"comment_1","comment_text":"Need help","date":"1782813660000","user":{"id":1,"username":"Buyer","email":"buyer@example.com"}},{"id":"comment_2","comment_text":"We can help","date":"1782813720000","user":{"id":2,"username":"Agent","email":"agent@example.com"}}]}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	backfiller := ClickUpSupportRESTBackfiller{Credentials: staticClickUpSupportCredentialResolver{creds: ClickUpSupportCredentials{
		Token:      "click_token",
		APIBaseURL: server.URL + "/api/v2",
	}}}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderClickUpSupport,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"workspace_id": "workspace_123",
			"list_id":      "list_456",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected ClickUp auth header")
	}
	if req.Cursor != clickUpCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].ConversationID != "task_1" || req.Tickets[0].Priority != "high" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
}

func TestClickUpSupportBackfillRateLimitResetError(t *testing.T) {
	resetAt := time.Now().Add(32 * time.Second).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(resetAt, 10))
		http.Error(w, `{"err":"rate limited"}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := ClickUpSupportRESTBackfiller{Credentials: staticClickUpSupportCredentialResolver{creds: ClickUpSupportCredentials{
		Token:      "click_token",
		APIBaseURL: server.URL + "/api/v2",
	}}}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderClickUpSupport, CredentialsRef: "cred", Settings: map[string]any{"workspace_id": "workspace_123"}}, "")
	var restErr ClickUpSupportRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter <= 0 {
		t.Fatalf("expected retry-aware ClickUpSupportRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestVerifyClickUpWebhookSignature(t *testing.T) {
	body := []byte(`{"event":"taskUpdated","task_id":"task_1"}`)
	signature := signClickUpWebhookTest("secret", body)
	if err := VerifyClickUpWebhookSignature("secret", body, signature); err != nil {
		t.Fatalf("valid signature failed: %v", err)
	}
	if err := VerifyClickUpWebhookSignature("secret", body, "sha256="+signature); err != nil {
		t.Fatalf("valid prefixed signature failed: %v", err)
	}
	if err := VerifyClickUpWebhookSignature("wrong", body, signature); !errors.Is(err, ErrInvalidClickUpWebhookSignature) {
		t.Fatalf("invalid signature error=%v", err)
	}
}

func TestClickUpSupportWebhookSignedSparseRefresh(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderClickUpSupport
	store.integration.Settings = map[string]any{
		"workspace_id":               "workspace_123",
		"list_id":                    "list_456",
		"clickup_webhook_secret_ref": "cred_clickup_webhook_1",
		"clickup_webhook_id":         "webhook-1",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeClickUpSupportBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "clickup-support://task/task_1",
			ConversationID: "task_1",
			Email:          "buyer@example.com",
			Subject:        "Need help",
		}},
		Messages: []MessageInput{{
			SourceID:       "clickup-support://task/task_1/comment/comment_1",
			ConversationID: "task_1",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	deps := &Deps{
		Repo:                     store,
		Suite:                    suite,
		ClickUpSupportBackfiller: backfiller,
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_clickup_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"event":"taskUpdated","task_id":"task_1","webhook_id":"webhook-1"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/clickup-support/workspace_123/webhooks/webhook-1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", signClickUpWebhookTest("secret", body))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshTaskID != "task_1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: task=%q tickets=%+v messages=%+v", backfiller.refreshTaskID, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["clickup_webhook_event"] != "taskUpdated" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

func signClickUpWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
