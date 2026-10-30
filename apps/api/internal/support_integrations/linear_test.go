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

type staticLinearCredentialResolver struct {
	creds LinearCredentials
}

func (r staticLinearCredentialResolver) ResolveLinear(context.Context, string, Integration) (LinearCredentials, error) {
	return r.creds, nil
}

func TestLinearBackfillIssuesAndComments(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer linear_token" && r.Header.Get("Content-Type") == "application/json" {
			sawAuth = true
		}
		_, _ = w.Write([]byte(`{"data":{"issues":{"nodes":[{"id":"lin-1","identifier":"SUP-1","title":"Need help","description":"Customer buyer@example.com needs help","url":"https://linear.app/acme/issue/SUP-1","priority":2,"priorityLabel":"High","createdAt":"2026-06-30T10:00:00Z","updatedAt":"2026-06-30T10:01:00Z","team":{"id":"team_456","key":"SUP","name":"Support"},"state":{"id":"state_1","name":"Open","type":"started"},"creator":{"id":"user_1","name":"Buyer","email":"buyer@example.com"},"assignee":{"id":"agent_1","name":"Agent","email":"agent@example.com"},"labels":{"nodes":[{"id":"label_1","name":"vip"}]},"comments":{"nodes":[{"id":"comment_1","body":"Need help","createdAt":"2026-06-30T10:01:00Z","user":{"id":"user_1","name":"Buyer","email":"buyer@example.com"}},{"id":"comment_2","body":"We can help","createdAt":"2026-06-30T10:02:00Z","user":{"id":"agent_1","name":"Agent","email":"agent@example.com"}}],"pageInfo":{"hasNextPage":false}}}],"pageInfo":{"hasNextPage":false}}}}`))
	}))
	defer server.Close()

	backfiller := LinearGraphQLBackfiller{Credentials: staticLinearCredentialResolver{creds: LinearCredentials{
		AccessToken: "linear_token",
		GraphQLURL:  server.URL,
	}}}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderLinear,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"workspace_id": "workspace_123",
			"team_id":      "team_456",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("expected Linear bearer auth header")
	}
	if req.Cursor != linearCursorComplete || len(req.Tickets) != 1 || len(req.Messages) != 2 {
		t.Fatalf("unexpected request: cursor=%q tickets=%d messages=%d req=%+v", req.Cursor, len(req.Tickets), len(req.Messages), req)
	}
	if req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].ConversationID != "SUP-1" || req.Tickets[0].Priority != "high" {
		t.Fatalf("ticket mapping failed: %+v", req.Tickets[0])
	}
	if req.Messages[0].Direction != "inbound" || req.Messages[1].Direction != "outbound" {
		t.Fatalf("message mapping failed: %+v", req.Messages)
	}
}

func TestLinearBackfillRateLimitError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "39")
		_, _ = w.Write([]byte(`{"errors":[{"message":"rate limited","extensions":{"code":"RATELIMITED"}}]}`))
	}))
	defer server.Close()

	backfiller := LinearGraphQLBackfiller{Credentials: staticLinearCredentialResolver{creds: LinearCredentials{
		AccessToken: "linear_token",
		GraphQLURL:  server.URL,
	}}}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderLinear, CredentialsRef: "cred", Settings: map[string]any{"workspace_id": "workspace_123"}}, "")
	var restErr LinearRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 39*time.Second {
		t.Fatalf("expected retry-aware LinearRESTError, got %T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != restErr.RetryAfter {
		t.Fatalf("retry delay=%s want %s", delay, restErr.RetryAfter)
	}
}

func TestVerifyLinearWebhookSignature(t *testing.T) {
	body := []byte(`{"type":"Issue","data":{"id":"lin-1"}}`)
	signature := signLinearWebhookTest("secret", body)
	if err := VerifyLinearWebhookSignature("secret", body, signature); err != nil {
		t.Fatalf("valid signature failed: %v", err)
	}
	if err := VerifyLinearWebhookSignature("secret", body, "sha256="+signature); err != nil {
		t.Fatalf("valid prefixed signature failed: %v", err)
	}
	if err := VerifyLinearWebhookSignature("wrong", body, signature); !errors.Is(err, ErrInvalidLinearWebhookSignature) {
		t.Fatalf("invalid signature error=%v", err)
	}
	if err := VerifyLinearWebhookTimestamp(strconvFormatUnix(time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)), time.Date(2026, 7, 1, 10, 0, 30, 0, time.UTC)); err != nil {
		t.Fatalf("fresh timestamp failed: %v", err)
	}
	if err := VerifyLinearWebhookTimestamp(strconvFormatUnix(time.Date(2026, 7, 1, 9, 58, 0, 0, time.UTC)), time.Date(2026, 7, 1, 10, 0, 30, 0, time.UTC)); !errors.Is(err, ErrStaleLinearWebhookTimestamp) {
		t.Fatalf("stale timestamp error=%v", err)
	}
}

func TestLinearWebhookSignedSparseRefresh(t *testing.T) {
	now := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderLinear
	store.integration.Settings = map[string]any{
		"workspace_id":              "workspace_123",
		"linear_webhook_secret_ref": "cred_linear_webhook_1",
		"linear_webhook_id":         "webhook-1",
		"linear_workspace_id":       "workspace_123",
	}
	suite := &fakeSuiteSink{}
	backfiller := &fakeLinearBackfiller{refreshReq: SyncRequest{
		Tickets: []TicketInput{{
			SourceID:       "linear://issue/lin-1",
			ConversationID: "SUP-1",
			Email:          "buyer@example.com",
			Subject:        "Need help",
		}},
		Messages: []MessageInput{{
			SourceID:       "linear://issue/SUP-1/comment/comment-1",
			ConversationID: "SUP-1",
			Email:          "buyer@example.com",
			BodyText:       "Need help",
		}},
	}}
	deps := &Deps{
		Repo:             store,
		Suite:            suite,
		LinearBackfiller: backfiller,
		Now:              func() time.Time { return now },
		WebhookSecrets: fakeSupportSecretResolver{values: map[string]string{
			"cred_linear_webhook_1": "secret",
		}},
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"type":"Issue","data":{"id":"lin-1"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/linear/workspace_123/webhooks/webhook-1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Linear-Signature", signLinearWebhookTest("secret", body))
	req.Header.Set("Linear-Timestamp", strconvFormatUnix(now))
	req.Header.Set("Linear-Delivery", "delivery-1")
	req.Header.Set("Linear-Event", "Issue")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.refreshIssueID != "lin-1" || len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("refresh not used: issue=%q tickets=%+v messages=%+v", backfiller.refreshIssueID, suite.tickets, suite.messages)
	}
	if suite.tickets[0].Properties["linear_webhook_event"] != "Issue" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
}

func signLinearWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func strconvFormatUnix(t time.Time) string {
	return strconv.FormatInt(t.Unix(), 10)
}
