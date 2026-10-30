// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeZendeskSecretResolver struct{ json string }

func (f fakeZendeskSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeZendeskSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*zendeskCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestZendeskBackfillPageMapsTicketsWithSideloadedUsers(t *testing.T) {
	var gotPath, gotAuth, gotInclude string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotInclude = r.URL.Query().Get("include")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tickets": []map[string]any{
				{"id": 42, "subject": "Broken", "status": "open", "priority": "high", "requester_id": 7, "tags": []string{"vip"}, "updated_at": "2026-06-20T10:00:00Z"},
			},
			"users": []map[string]any{
				{"id": 7, "email": "Asker@Example.com", "name": "Asker"},
			},
			"meta": map[string]any{"has_more": false, "after_cursor": ""},
		})
	}))
	defer srv.Close()

	backfiller := ZendeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"email":"agent@store.com","api_token":"tok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    100,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderZendesk, CredentialsRef: "cred_zd_1"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/api/v2/tickets") {
		t.Fatalf("path = %q", gotPath)
	}
	if gotInclude != "users" {
		t.Fatalf("include = %q (want users side-load)", gotInclude)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent@store.com/token:tok"))
	if gotAuth != wantAuth {
		t.Fatalf("auth = %q, want API-token basic auth %q", gotAuth, wantAuth)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "asker@example.com" {
		t.Fatalf("email = %q (want resolved+lowercased from side-loaded user)", tk.Email)
	}
	if tk.SourceID != "zendesk://ticket/42" || tk.Status != "open" || tk.Subject != "Broken" {
		t.Fatalf("mapped ticket = %+v", tk)
	}
	if req.Cursor != zendeskCursorComplete {
		t.Fatalf("cursor = %q, want complete", req.Cursor)
	}
}

func TestZendeskRefreshTicketMapsSingleTicketWithSideloadedUser(t *testing.T) {
	var gotPath, gotAuth, gotInclude string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotInclude = r.URL.Query().Get("include")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ticket": map[string]any{
				"id":           42,
				"subject":      "Broken",
				"status":       "open",
				"priority":     "high",
				"requester_id": 7,
				"tags":         []string{"vip"},
				"updated_at":   "2026-06-20T10:00:00Z",
			},
			"users": []map[string]any{
				{"id": 7, "email": "Asker@Example.com", "name": "Asker"},
			},
		})
	}))
	defer srv.Close()

	backfiller := ZendeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"email":"agent@store.com","api_token":"tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshTicket(context.Background(), "tenant-1", Integration{Provider: ProviderZendesk, CredentialsRef: "cred_zd_1"}, "42")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if gotPath != "/api/v2/tickets/42.json" || gotInclude != "users" {
		t.Fatalf("request path=%q include=%q", gotPath, gotInclude)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent@store.com/token:tok"))
	if gotAuth != wantAuth {
		t.Fatalf("auth = %q, want %q", gotAuth, wantAuth)
	}
	if req.RunMode != "webhook" || req.Cursor != "zendesk-refresh-42" || len(req.Tickets) != 1 {
		t.Fatalf("request=%+v", req)
	}
	tk := req.Tickets[0]
	if tk.SourceID != "zendesk://ticket/42" || tk.Email != "asker@example.com" || tk.Subject != "Broken" {
		t.Fatalf("ticket=%+v", tk)
	}
}

func TestZendeskBackfillPageOAuthBearer(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{"tickets": []map[string]any{}, "users": []map[string]any{}})
	}))
	defer srv.Close()

	backfiller := ZendeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"access_token":"oauth_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	if _, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderZendesk, CredentialsRef: "c"}, ""); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotAuth != "Bearer oauth_tok" {
		t.Fatalf("auth = %q, want OAuth Bearer", gotAuth)
	}
}

func TestZendeskDeleteWebhookUsesBasicAuth(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	backfiller := ZendeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"email":"agent@store.com","api_token":"tok"}`}},
		APIBaseURL:  srv.URL,
	}
	result, err := backfiller.DeleteZendeskWebhook(context.Background(), "tenant-1", Integration{Provider: ProviderZendesk, CredentialsRef: "cred_zd_1"}, "wh_123")
	if err != nil {
		t.Fatalf("delete webhook: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/v2/webhooks/wh_123" {
		t.Fatalf("request method=%q path=%q", gotMethod, gotPath)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent@store.com/token:tok"))
	if gotAuth != wantAuth {
		t.Fatalf("auth = %q, want %q", gotAuth, wantAuth)
	}
	if result.Status != "deleted" || result.WebhookID != "wh_123" {
		t.Fatalf("result=%+v", result)
	}
}

func TestZendeskDeleteWebhookTreatsNotFoundAsAlreadyAbsent(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
	}))
	defer srv.Close()

	backfiller := ZendeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"access_token":"oauth_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	result, err := backfiller.DeleteZendeskWebhook(context.Background(), "tenant-1", Integration{Provider: ProviderZendesk, CredentialsRef: "cred_zd_1"}, "wh_missing")
	if err != nil {
		t.Fatalf("delete webhook should treat 404 as clean: %v", err)
	}
	if gotAuth != "Bearer oauth_tok" {
		t.Fatalf("auth = %q, want OAuth Bearer", gotAuth)
	}
	if result.Status != "already_absent" || result.ProviderStatusCode != http.StatusNotFound {
		t.Fatalf("result=%+v", result)
	}
}

func TestZendeskBackfillPageUsesIncrementalExportStartTime(t *testing.T) {
	var gotPath, gotStartTime, gotCursor, gotInclude, gotPerPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotStartTime = r.URL.Query().Get("start_time")
		gotCursor = r.URL.Query().Get("cursor")
		gotInclude = r.URL.Query().Get("include")
		gotPerPage = r.URL.Query().Get("per_page")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tickets": []map[string]any{
				{"id": 84, "subject": "Incremental", "status": "pending", "priority": "normal", "requester_id": 9, "tags": []string{"vip"}, "updated_at": "2026-06-28T09:00:00Z"},
			},
			"users": []map[string]any{
				{"id": 9, "email": "Buyer@Example.com"},
			},
			"after_cursor":  "cursor-1",
			"end_of_stream": true,
		})
	}))
	defer srv.Close()

	backfiller := ZendeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"access_token":"oauth_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderZendesk,
		CredentialsRef: "cred_zd_1",
		Settings: map[string]any{
			"incremental_export_enabled": true,
			"incremental_start_time":     "1782000000",
			"incremental_page_size":      "2000",
		},
	}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotPath != zendeskIncrementalExportEndpoint || gotStartTime != "1782000000" || gotCursor != "" || gotInclude != "users" || gotPerPage != "1000" {
		t.Fatalf("request path=%q start=%q cursor=%q include=%q per_page=%q", gotPath, gotStartTime, gotCursor, gotInclude, gotPerPage)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].Email != "buyer@example.com" || req.Tickets[0].SourceID != "zendesk://ticket/84" {
		t.Fatalf("tickets=%+v", req.Tickets)
	}
	if !req.StopAfterPage {
		t.Fatalf("StopAfterPage = false, want true when end_of_stream is true")
	}
	state, ok, err := decodeZendeskIncrementalCursor(req.Cursor)
	if err != nil || !ok || state.Cursor != "cursor-1" {
		t.Fatalf("cursor state=%+v ok=%v err=%v raw=%q", state, ok, err, req.Cursor)
	}
	if providerCursor := decodeZendeskCursor(req.Cursor); providerCursor != "cursor-1" {
		t.Fatalf("decodeZendeskCursor = %q", providerCursor)
	}
}

func TestZendeskBackfillPageUsesIncrementalCursorContinuation(t *testing.T) {
	var gotStartTime, gotCursor string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotStartTime = r.URL.Query().Get("start_time")
		gotCursor = r.URL.Query().Get("cursor")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tickets":       []map[string]any{},
			"users":         []map[string]any{},
			"after_cursor":  "cursor-2",
			"end_of_stream": false,
		})
	}))
	defer srv.Close()

	backfiller := ZendeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"access_token":"oauth_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1",
		Integration{Provider: ProviderZendesk, CredentialsRef: "cred_zd_1"},
		encodeZendeskIncrementalCursor(zendeskIncrementalCursorState{Cursor: "cursor-1"}))
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotStartTime != "" || gotCursor != "cursor-1" {
		t.Fatalf("query start_time=%q cursor=%q", gotStartTime, gotCursor)
	}
	if req.StopAfterPage {
		t.Fatalf("StopAfterPage = true, want false until end_of_stream")
	}
	state, ok, err := decodeZendeskIncrementalCursor(req.Cursor)
	if err != nil || !ok || state.Cursor != "cursor-2" {
		t.Fatalf("cursor state=%+v ok=%v err=%v raw=%q", state, ok, err, req.Cursor)
	}
}

func TestZendeskIncrementalExportRequiresStartTime(t *testing.T) {
	backfiller := ZendeskRESTBackfiller{
		Credentials: ZendeskSecretsCredentialResolver{Secrets: fakeZendeskSecretResolver{json: `{"access_token":"oauth_tok","subdomain":"acme"}`}},
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderZendesk,
		CredentialsRef: "cred_zd_1",
		Settings:       map[string]any{"incremental_export_enabled": true},
	}, "")
	if err == nil || !strings.Contains(err.Error(), "incremental_start_time") {
		t.Fatalf("want incremental_start_time error, got %v", err)
	}
}

func TestZendeskIncrementalCursorEncodesStartTime(t *testing.T) {
	cursor := encodeZendeskIncrementalCursor(zendeskIncrementalCursorState{StartTime: 1782000000})
	if !strings.HasPrefix(cursor, zendeskIncrementalCursorPrefix) {
		t.Fatalf("cursor = %q", cursor)
	}
	if got := decodeZendeskCursor(cursor); got != "1782000000" {
		t.Fatalf("decodeZendeskCursor = %q", got)
	}
	if _, _, err := decodeZendeskIncrementalCursor(zendeskIncrementalCursorPrefix + "%%%"); err == nil || !strings.Contains(fmt.Sprint(err), "decode") {
		t.Fatalf("want decode error, got %v", err)
	}
}
