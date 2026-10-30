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

type fakeKayakoSecretResolver struct{ json string }

func (f fakeKayakoSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeKayakoSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*kayakoCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestKayakoBackfillResolvesRequesterFromResources(t *testing.T) {
	var gotCasesPath, gotPostsPath, gotAuth, gotInclude, gotOffset, gotFilters string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/api/v1/cases.json":
			gotCasesPath = r.URL.Path
			gotInclude = r.URL.Query().Get("include")
			gotOffset = r.URL.Query().Get("offset")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": 301, "subject": "Help", "post_count": 2, "requester": map[string]any{"id": 55, "resource_type": "user"}},
				},
				"resources": map[string]any{
					"user": map[string]any{
						"55": map[string]any{"full_name": "Ada L", "emails": []map[string]any{{"email": "Ada@Example.com", "is_primary": true}}},
					},
				},
				"total_count": 250, "offset": 0, "limit": 1,
			})
		case "/api/v1/cases/301/posts.json":
			gotPostsPath = r.URL.Path
			gotFilters = r.URL.Query().Get("filters")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": 701, "uuid": "post-customer", "subject": "Help", "contents": "<p>Need help</p>", "creator": map[string]any{"id": 55, "resource_type": "user"}, "source_channel": "MAIL", "post_status": "SENT", "created_at": "2026-06-20T09:00:00Z", "attachments": []any{}},
					{"id": 702, "uuid": "post-agent", "subject": "Help", "contents": "<p>Checking now</p>", "creator": map[string]any{"id": 77, "resource_type": "user"}, "source_channel": "AGENT", "post_status": "SENT", "created_at": "2026-06-20T09:05:00Z", "attachments": []any{"a1"}},
				},
				"resources": map[string]any{
					"user": map[string]any{
						"77": map[string]any{"full_name": "Agent P", "emails": []map[string]any{{"email": "agent@example.com", "is_primary": true}}},
					},
				},
				"total_count": 2, "limit": 100,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := KayakoRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: KayakoSecretsCredentialResolver{Secrets: fakeKayakoSecretResolver{json: `{"email":"agent@acme.com","api_key":"secret","subdomain":"acme"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderKayako, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent@acme.com:secret"))
	if !strings.Contains(gotCasesPath, "/api/v1/cases.json") || gotAuth != wantAuth || !strings.Contains(gotInclude, "requester") || gotOffset != "0" {
		t.Fatalf("cases path=%q auth=%q include=%q offset=%q", gotCasesPath, gotAuth, gotInclude, gotOffset)
	}
	if !strings.Contains(gotPostsPath, "/api/v1/cases/301/posts.json") || gotFilters != "MESSAGES" {
		t.Fatalf("posts path=%q filters=%q", gotPostsPath, gotFilters)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Help" || tk.ConversationID != "301" || tk.RequesterName != "Ada L" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "kayako://case/301" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if tk.Properties["kayako_post_count"] != 2 {
		t.Fatalf("ticket properties = %+v", tk.Properties)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %d", len(req.Messages))
	}
	first := req.Messages[0]
	if first.SourceID != "kayako://case/301/post/701" || first.Direction != "inbound" || first.SenderType != "customer" || first.Sender != "Ada L" || first.BodyText != "Need help" || first.BodyHTML != "<p>Need help</p>" {
		t.Fatalf("first message = %+v", first)
	}
	second := req.Messages[1]
	if second.SourceID != "kayako://case/301/post/702" || second.Direction != "outbound" || second.SenderType != "agent" || second.Sender != "Agent P" || second.BodyText != "Checking now" {
		t.Fatalf("second message = %+v", second)
	}
	if second.Properties["kayako_post_attachment_count"] != 1 {
		t.Fatalf("second properties = %+v", second.Properties)
	}
	if req.Cursor != "kayako:1" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestKayakoBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "31")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := KayakoRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: KayakoSecretsCredentialResolver{Secrets: fakeKayakoSecretResolver{json: `{"email":"agent@acme.com","api_key":"secret","subdomain":"acme"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderKayako, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected rate-limit error")
	}
	var restErr KayakoRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 31*time.Second {
		t.Fatalf("restErr = %#v err=%v", restErr, err)
	}
	cfg, cfgErr := supportBackfillConfig(ProviderKayako)
	if cfgErr != nil {
		t.Fatalf("missing Kayako retry config: %v", cfgErr)
	}
	now := time.Date(2026, 7, 1, 15, 0, 0, 0, time.UTC)
	retryCursor := supportBackfillRetryCursor(cfg, kayakoCursorPrefix+"2", "BACKFILL_FAILED", err, now)
	state, ok, err := decodeSupportRetryCursor(cfg, retryCursor)
	if err != nil || !ok {
		t.Fatalf("decode retry cursor ok=%v err=%v cursor=%q", ok, err, retryCursor)
	}
	if state.NextAttemptAt != now.Add(31*time.Second).Format(time.RFC3339) {
		t.Fatalf("next attempt = %q", state.NextAttemptAt)
	}
}

func TestKayakoRefreshCaseFetchesCaseAndPosts(t *testing.T) {
	var gotCasePath, gotPostsPath, gotInclude string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/cases/301.json":
			gotCasePath = r.URL.Path
			gotInclude = r.URL.Query().Get("include")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"id": 301, "subject": "Refresh help", "post_count": 1, "requester": map[string]any{"id": 55, "resource_type": "user"}},
				"resources": map[string]any{
					"user": map[string]any{
						"55": map[string]any{"full_name": "Ada L", "emails": []map[string]any{{"email": "Ada@Example.com", "is_primary": true}}},
					},
				},
			})
		case "/api/v1/cases/301/posts.json":
			gotPostsPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": 701, "uuid": "post-customer", "contents": "<p>Need help</p>", "creator": map[string]any{"id": 55, "resource_type": "user"}, "source_channel": "MAIL", "created_at": "2026-06-20T09:00:00Z"},
				},
				"total_count": 1, "limit": 100,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := KayakoRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: KayakoSecretsCredentialResolver{Secrets: fakeKayakoSecretResolver{json: `{"email":"agent@acme.com","api_key":"secret","subdomain":"acme.kayako.com"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshCase(context.Background(), "t", Integration{Provider: ProviderKayako, CredentialsRef: "c"}, "301")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if gotCasePath != "/api/v1/cases/301.json" || gotPostsPath != "/api/v1/cases/301/posts.json" || gotInclude != "requester" {
		t.Fatalf("case path=%q posts path=%q include=%q", gotCasePath, gotPostsPath, gotInclude)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].Email != "ada@example.com" || req.Tickets[0].Subject != "Refresh help" {
		t.Fatalf("tickets=%+v", req.Tickets)
	}
	if len(req.Messages) != 1 || req.Messages[0].BodyText != "Need help" {
		t.Fatalf("messages=%+v", req.Messages)
	}
	if req.RunMode != "webhook" || req.Cursor != "kayako-webhook-301" {
		t.Fatalf("request mode=%q cursor=%q", req.RunMode, req.Cursor)
	}
}

func TestKayakoBaseURLAcceptsBareAndFullDomain(t *testing.T) {
	bare, err := kayakoBaseURL("", KayakoCredentials{Subdomain: "acme"})
	if err != nil {
		t.Fatalf("bare base url: %v", err)
	}
	full, err := kayakoBaseURL("", KayakoCredentials{Subdomain: "acme.kayako.com"})
	if err != nil {
		t.Fatalf("full base url: %v", err)
	}
	if bare != "https://acme.kayako.com" || full != "https://acme.kayako.com" {
		t.Fatalf("bare=%q full=%q", bare, full)
	}
}

func TestKayakoCredentialResolverAcceptsAccountDomainSetting(t *testing.T) {
	resolver := KayakoSecretsCredentialResolver{Secrets: fakeKayakoSecretResolver{json: `{"email":"agent@acme.com","api_key":"secret"}`}}
	creds, err := resolver.ResolveKayako(context.Background(), "t", Integration{
		CredentialsRef: "c",
		Settings:       map[string]any{"account_domain": "acme"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if creds.Subdomain != "acme" {
		t.Fatalf("subdomain = %q", creds.Subdomain)
	}
}
