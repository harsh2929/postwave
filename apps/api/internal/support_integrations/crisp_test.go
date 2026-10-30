// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeCrispSecretResolver struct{ json string }

func (f fakeCrispSecretResolver) Get(_ context.Context, _ string) (string, error) { return f.json, nil }
func (f fakeCrispSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*crispCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestCrispBackfillMapsConversations(t *testing.T) {
	var gotPath, gotAuth, gotTier string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotTier = r.Header.Get("X-Crisp-Tier")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": false,
			"data": []map[string]any{
				{"session_id": "sess_1", "state": "unresolved", "updated_at": 1718880000000,
					"meta": map[string]any{"email": "Ada@Example.com", "nickname": "Ada", "segments": []any{"vip"}, "subject": "Order help"}},
			},
		})
	}))
	defer srv.Close()

	backfiller := CrispRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: CrispSecretsCredentialResolver{Secrets: fakeCrispSecretResolver{json: `{"identifier":"id","key":"k","website_id":"WS"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderCrisp, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("id:k"))
	if !strings.Contains(gotPath, "/website/WS/conversations/1") || gotAuth != wantAuth || gotTier != "plugin" {
		t.Fatalf("path=%q auth=%q tier=%q", gotPath, gotAuth, gotTier)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Status != "unresolved" || tk.ConversationID != "sess_1" || tk.RequesterName != "Ada" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "crisp://conversation/sess_1" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if req.Cursor != "crisp:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestCrispRefreshConversationMapsMeta(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": false,
			"data": map[string]any{
				"email":    "Ada@Example.com",
				"nickname": "Ada",
				"subject":  "Order help",
				"segments": []any{"vip"},
			},
		})
	}))
	defer srv.Close()

	backfiller := CrispRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: CrispSecretsCredentialResolver{Secrets: fakeCrispSecretResolver{json: `{"identifier":"id","key":"k","website_id":"WS"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshConversation(context.Background(), "t", Integration{Provider: ProviderCrisp, CredentialsRef: "c"}, "sess_1")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("id:k"))
	if !strings.Contains(gotPath, "/website/WS/conversation/sess_1/meta") || gotAuth != wantAuth {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].Email != "ada@example.com" || req.Tickets[0].SourceID != "crisp://conversation/sess_1" {
		t.Fatalf("req=%+v", req)
	}
	if req.RunMode != "webhook" || req.Cursor != "crisp-webhook-sess_1" {
		t.Fatalf("run mode/cursor = %q %q", req.RunMode, req.Cursor)
	}
}

func TestCrispBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "120")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := CrispRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: CrispSecretsCredentialResolver{Secrets: fakeCrispSecretResolver{json: `{"identifier":"id","key":"k","website_id":"WS"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderCrisp, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected retry-after error")
	}
	var providerErr CrispRESTError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Minute {
		t.Fatalf("err=%T %v", err, err)
	}
	if delay := supportRetryDelay(1, err); delay != 2*time.Minute {
		t.Fatalf("retry delay = %s", delay)
	}
}
