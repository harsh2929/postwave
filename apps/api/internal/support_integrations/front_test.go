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

type fakeFrontSecretResolver struct{ json string }

func (f fakeFrontSecretResolver) Get(_ context.Context, _ string) (string, error) { return f.json, nil }
func (f fakeFrontSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*frontCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestFrontBackfillMapsConversations(t *testing.T) {
	var gotPath, gotAuth, gotLimit string
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotLimit = r.URL.Query().Get("limit")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"_results": []map[string]any{
				{"id": "cnv_1", "subject": "Where is my order", "status": "archived",
					"recipient": map[string]any{"handle": "Ada@Example.com", "role": "to"},
					"tags":      []map[string]any{{"name": "shipping"}}, "created_at": 1718880000},
			},
			"_pagination": map[string]any{"next": srvURL + "/conversations?page_token=NEXT"},
		})
	}))
	defer srv.Close()
	srvURL = srv.URL

	backfiller := FrontRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FrontSecretsCredentialResolver{Secrets: fakeFrontSecretResolver{json: `{"api_token":"front.tok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderFront, CredentialsRef: "c", Settings: map[string]any{"inbox_id": "inb_123"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotPath != "/inboxes/inb_123/conversations" || gotAuth != "Bearer front.tok" || gotLimit != "1" {
		t.Fatalf("path=%q auth=%q limit=%q", gotPath, gotAuth, gotLimit)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Where is my order" || tk.Status != "archived" || tk.ConversationID != "cnv_1" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "front://conversation/cnv_1" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if !strings.HasPrefix(req.Cursor, "front:") || !strings.Contains(req.Cursor, "page_token=NEXT") {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestFrontBackfillCompleteCursorStops(t *testing.T) {
	backfiller := FrontRESTBackfiller{
		Credentials: FrontSecretsCredentialResolver{Secrets: fakeFrontSecretResolver{json: `{"api_token":"k"}`}},
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderFront, CredentialsRef: "c"}, frontCursorComplete)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Tickets) != 0 || req.Cursor != frontCursorComplete {
		t.Fatalf("complete cursor should short-circuit, got %+v", req)
	}
}

func TestFrontRefreshConversationMapsSingleConversation(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":      "cnv_1",
			"subject": "Order follow-up",
			"status":  "assigned",
			"recipient": map[string]any{
				"handle": "Ada@Example.com",
				"role":   "to",
			},
			"created_at": 1718880000,
		})
	}))
	defer srv.Close()

	backfiller := FrontRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FrontSecretsCredentialResolver{Secrets: fakeFrontSecretResolver{json: `{"api_token":"front.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshConversation(context.Background(), "t", Integration{Provider: ProviderFront, CredentialsRef: "c"}, "cnv_1")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if gotPath != "/conversations/cnv_1" || gotAuth != "Bearer front.tok" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].Email != "ada@example.com" || req.Tickets[0].SourceID != "front://conversation/cnv_1" {
		t.Fatalf("req=%+v", req)
	}
	if req.RunMode != "webhook" || req.Cursor != "front-webhook-cnv_1" {
		t.Fatalf("run mode/cursor = %q %q", req.RunMode, req.Cursor)
	}
}

func TestFrontBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "120")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := FrontRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FrontSecretsCredentialResolver{Secrets: fakeFrontSecretResolver{json: `{"api_token":"front.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderFront, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected retry-after error")
	}
	var providerErr FrontRESTError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Minute {
		t.Fatalf("err=%T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != 2*time.Minute {
		t.Fatalf("retry delay = %s", delay)
	}
}
