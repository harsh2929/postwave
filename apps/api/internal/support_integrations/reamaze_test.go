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

	"github.com/go-chi/chi/v5"
)

type fakeReamazeSecretResolver struct{ json string }

func (f fakeReamazeSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeReamazeSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*reamazeCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestReamazeBackfillMapsConversations(t *testing.T) {
	var gotPath, gotAuth, gotPage, gotMessagePath, gotMessageInclude string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/conversations":
			gotPath = r.URL.Path
			gotAuth = r.Header.Get("Authorization")
			gotPage = r.URL.Query().Get("page")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"conversations": []map[string]any{
					{"subject": "Where is my order", "slug": "abc-123", "status": 0, "tag_list": []string{"shipping"},
						"author":                map[string]any{"name": "Ada L", "email": "Ada@Example.com"},
						"assignee":              map[string]any{"name": "Ops Agent", "email": "agent@example.com"},
						"category":              map[string]any{"name": "Support", "slug": "support", "email": "support@example.com", "channel": 1},
						"last_customer_message": map[string]any{"created_at": "2026-06-20T10:00:00Z"},
						"updated_at":            "2026-06-20T10:00:00Z"},
				},
				"page_count": 3, "total_count": 250, "page": 1,
			})
		case "/api/v1/conversations/abc-123/messages":
			gotMessagePath = r.URL.Path
			gotMessageInclude = r.URL.Query().Get("include")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"messages": []map[string]any{
					{
						"body":          "Need help with shipping",
						"original_body": "<p>Need <b>help</b> with shipping</p>",
						"visibility":    0,
						"origin":        1,
						"origin_id":     "msg_customer",
						"created_at":    "2026-06-20T10:01:00Z",
						"user":          map[string]any{"name": "Ada L", "email": "ada@example.com"},
						"conversation":  map[string]any{"subject": "Where is my order", "slug": "abc-123"},
					},
					{
						"body":         "Checking now",
						"visibility":   0,
						"origin":       16,
						"origin_id":    "msg_agent",
						"created_at":   "2026-06-20T10:02:00Z",
						"user":         map[string]any{"name": "Ops Agent", "email": "agent@example.com"},
						"conversation": map[string]any{"subject": "Where is my order", "slug": "abc-123"},
					},
				},
				"page_count": 1, "page": 1,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := ReamazeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ReamazeSecretsCredentialResolver{Secrets: fakeReamazeSecretResolver{json: `{"email":"ops@acme.com","api_token":"rk","brand":"acme"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderReamaze, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops@acme.com:rk"))
	if !strings.Contains(gotPath, "/conversations") || gotAuth != wantAuth || gotPage != "1" {
		t.Fatalf("path=%q auth=%q page=%q", gotPath, gotAuth, gotPage)
	}
	if gotMessagePath != "/api/v1/conversations/abc-123/messages" || gotMessageInclude != "original_body" {
		t.Fatalf("message path=%q include=%q", gotMessagePath, gotMessageInclude)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Where is my order" || tk.ConversationID != "abc-123" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.Status != "open" || len(tk.Tags) != 1 || tk.Tags[0] != "shipping" || tk.Assignee != "Ops Agent" {
		t.Fatalf("ticket status/tags/assignee = %+v", tk)
	}
	if tk.SourceID != "reamaze://conversation/abc-123" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %d", len(req.Messages))
	}
	first := req.Messages[0]
	if first.SourceID != "reamaze://message/msg_customer" || first.Direction != "inbound" || first.SenderType != "customer" || first.BodyHTML != "<p>Need <b>help</b> with shipping</p>" {
		t.Fatalf("first message = %+v", first)
	}
	second := req.Messages[1]
	if second.SourceID != "reamaze://message/msg_agent" || second.Direction != "outbound" || second.SenderType != "agent" || second.BodyText != "Checking now" {
		t.Fatalf("second message = %+v", second)
	}
	if req.Cursor != "reamaze:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestReamazeBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := ReamazeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ReamazeSecretsCredentialResolver{Secrets: fakeReamazeSecretResolver{json: `{"email":"ops@acme.com","api_token":"rk","brand":"acme"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderReamaze, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected rate-limit error")
	}
	var restErr ReamazeRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 42*time.Second {
		t.Fatalf("restErr = %#v err=%v", restErr, err)
	}
	cfg, cfgErr := supportBackfillConfig(ProviderReamaze)
	if cfgErr != nil {
		t.Fatalf("missing Reamaze retry config: %v", cfgErr)
	}
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	retryCursor := supportBackfillRetryCursor(cfg, reamazeCursorPrefix+"2", "BACKFILL_FAILED", err, now)
	state, ok, err := decodeSupportRetryCursor(cfg, retryCursor)
	if err != nil || !ok {
		t.Fatalf("decode retry cursor ok=%v err=%v cursor=%q", ok, err, retryCursor)
	}
	if state.NextAttemptAt != now.Add(42*time.Second).Format(time.RFC3339) {
		t.Fatalf("next attempt = %q", state.NextAttemptAt)
	}
}

func TestReamazeCredentialResolverAcceptsAccountDomainSetting(t *testing.T) {
	resolver := ReamazeSecretsCredentialResolver{Secrets: fakeReamazeSecretResolver{json: `{"email":"ops@acme.com","api_token":"rk"}`}}
	creds, err := resolver.ResolveReamaze(context.Background(), "t", Integration{
		CredentialsRef: "c",
		Settings:       map[string]any{"account_domain": "acme"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if creds.Brand != "acme" {
		t.Fatalf("brand = %q", creds.Brand)
	}
}

func TestReamazeWebhookRouteTokenSparseRefresh(t *testing.T) {
	var gotPath, gotAuth, gotInclude, gotPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotInclude = r.URL.Query().Get("include")
		gotPage = r.URL.Query().Get("page")
		if r.URL.Path != "/api/v1/conversations/abc-123/messages" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"messages": []map[string]any{
				{
					"body":          "Need help with shipping",
					"original_body": "<p>Need help with shipping</p>",
					"visibility":    0,
					"origin":        1,
					"origin_id":     "msg_customer",
					"created_at":    "2026-06-20T10:01:00Z",
					"user":          map[string]any{"name": "Ada L", "email": "ada@example.com"},
					"conversation": map[string]any{
						"subject":    "Where is my order",
						"slug":       "abc-123",
						"status":     0,
						"tag_list":   []string{"shipping"},
						"author":     map[string]any{"name": "Ada L", "email": "Ada@Example.com"},
						"category":   map[string]any{"name": "Support", "slug": "support", "email": "support@example.com", "channel": 1},
						"updated_at": "2026-06-20T10:00:00Z",
					},
				},
			},
			"page_count": 1,
			"page":       1,
		})
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderReamaze
	store.integration.CredentialsRef = "cred_reamaze_1"
	store.integration.Settings = map[string]any{
		"account_domain":     "acme.reamaze.io",
		"reamaze_webhook_id": "route-token-1",
	}
	suite := &fakeSuiteSink{}
	deps := &Deps{
		Repo:  store,
		Suite: suite,
		ReamazeBackfiller: ReamazeRESTBackfiller{
			HTTPClient:  srv.Client(),
			Credentials: ReamazeSecretsCredentialResolver{Secrets: fakeReamazeSecretResolver{json: `{"email":"ops@acme.com","api_token":"rk","brand":"acme"}`}},
			APIBaseURL:  srv.URL,
		},
		Now: func() time.Time { return time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	body := []byte(`{"id":"evt-1","event":"conversation.updated","conversation":{"slug":"abc-123"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/reamaze/acme/webhooks/route-token-1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops@acme.com:rk"))
	if gotPath != "/api/v1/conversations/abc-123/messages" || gotInclude != "original_body" || gotPage != "1" || gotAuth != wantAuth {
		t.Fatalf("refresh request path=%q include=%q page=%q auth=%q", gotPath, gotInclude, gotPage, gotAuth)
	}
	if len(suite.tickets) != 1 || len(suite.messages) != 1 {
		t.Fatalf("suite writes tickets=%+v messages=%+v", suite.tickets, suite.messages)
	}
	if suite.tickets[0].Email != "ada@example.com" || suite.tickets[0].ConversationID != "abc-123" {
		t.Fatalf("ticket = %+v", suite.tickets[0])
	}
	if suite.tickets[0].Properties["reamaze_webhook_id"] != "route-token-1" ||
		suite.tickets[0].Properties["reamaze_webhook_event"] != "conversation.updated" ||
		suite.tickets[0].Properties["reamaze_refresh_source"] != "webhook_sparse" {
		t.Fatalf("webhook metadata missing: %+v", suite.tickets[0].Properties)
	}
	if suite.messages[0].BodyHTML != "<p>Need help with shipping</p>" ||
		suite.messages[0].Properties["reamaze_webhook_id"] != "route-token-1" {
		t.Fatalf("message = %+v", suite.messages[0])
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "reamaze-conversation-abc-123" {
		t.Fatalf("runs = %+v", store.runs)
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("decode raw webhook: %v", err)
	}
	if got := store.webhooks[ProviderReamaze+":"+reamazeWebhookDeliveryID("acme", "route-token-1", raw, body)]; got != WebhookProcessed {
		t.Fatalf("webhook state=%+v", store.webhooks)
	}
}

func TestReamazeWebhookRejectsWrongRouteToken(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderReamaze
	store.integration.Settings = map[string]any{
		"account_domain":     "acme",
		"reamaze_webhook_id": "route-token-1",
	}
	deps := &Deps{Repo: store, Suite: &fakeSuiteSink{}}
	router := chi.NewRouter()
	mountArchivedPublicRoutesFixture(router, deps)

	req := httptest.NewRequest(http.MethodPost, "/api/public/support-integrations/reamaze/acme/webhooks/route-token-2", strings.NewReader(`{"conversation":{"slug":"abc-123"}}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("unexpected webhook work: runs=%+v webhooks=%+v", store.runs, store.webhooks)
	}
}
