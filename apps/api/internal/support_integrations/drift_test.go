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

type fakeDriftSecretResolver struct{ json string }

func (f fakeDriftSecretResolver) Get(_ context.Context, _ string) (string, error) { return f.json, nil }
func (f fakeDriftSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*driftCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestDriftBackfillSideloadsContactEmail(t *testing.T) {
	var gotConvPath, gotAuth, gotContactPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch {
		case strings.Contains(r.URL.Path, "/contacts/"):
			gotContactPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"id": 55, "attributes": map[string]any{"email": "Ada@Example.com", "name": "Ada L"}},
			})
		case strings.Contains(r.URL.Path, "/conversations/list"):
			gotConvPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": 101, "status": "open", "contactId": 55, "updatedAt": 1718880000000},
				},
				"pagination": map[string]any{"more": true, "next": "CUR2"},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := DriftRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: DriftSecretsCredentialResolver{Secrets: fakeDriftSecretResolver{json: `{"access_token":"drift.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderDrift, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotConvPath, "/conversations/list") || gotAuth != "Bearer drift.tok" || !strings.Contains(gotContactPath, "/contacts/55") {
		t.Fatalf("convPath=%q auth=%q contactPath=%q", gotConvPath, gotAuth, gotContactPath)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Status != "open" || tk.ConversationID != "101" || tk.RequesterName != "Ada L" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "drift://conversation/101" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if req.Cursor != "drift:CUR2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

// Drift's current /conversations/list returns a top-level links.next full URL
// (page_token paging), and contacts carry first_name/last_name rather than a
// single name. The puller must follow links.next (not stop after page 1) and
// join the name.
func TestDriftFollowsLinksPaginationAndJoinsContactName(t *testing.T) {
	var srvURL, gotSecondToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/contacts/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"id": 55, "attributes": map[string]any{"email": "Ada@Example.com", "first_name": "Ada", "last_name": "Lovelace"}},
			})
		case strings.Contains(r.URL.Path, "/conversations/list"):
			if r.URL.Query().Get("page_token") == "TOK2" {
				gotSecondToken = "TOK2"
				_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": 101, "status": "open", "contactId": 55, "updatedAt": 1718880000000},
				},
				"links": map[string]any{"next": srvURL + "/conversations/list?page_token=TOK2"},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL
	wantCursor := "drift:" + srvURL + "/conversations/list?page_token=TOK2"

	backfiller := DriftRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: DriftSecretsCredentialResolver{Secrets: fakeDriftSecretResolver{json: `{"access_token":"drift.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderDrift, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].RequesterName != "Ada Lovelace" {
		t.Fatalf("tickets=%d name=%q (want first+last join)", len(req.Tickets), reqFirstName(req.Tickets))
	}
	if req.Cursor != wantCursor {
		t.Fatalf("cursor = %q, want links.next full URL %q", req.Cursor, wantCursor)
	}
	req2, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderDrift, CredentialsRef: "c"}, req.Cursor)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if gotSecondToken != "TOK2" {
		t.Fatalf("second request did not follow links.next page_token")
	}
	if req2.Cursor != driftCursorComplete {
		t.Fatalf("page 2 cursor = %q, want complete", req2.Cursor)
	}
}

func TestDriftRefreshConversationMapsContactEmail(t *testing.T) {
	var gotConversationPath, gotContactPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/contacts/55"):
			gotContactPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"id": 55, "attributes": map[string]any{"email": "Ada@Example.com", "first_name": "Ada", "last_name": "Refresh"}},
			})
		case strings.Contains(r.URL.Path, "/conversations/456"):
			gotConversationPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"id": 456, "status": "open", "contactId": 55, "updatedAt": 1718880000000},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := DriftRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: DriftSecretsCredentialResolver{Secrets: fakeDriftSecretResolver{json: `{"access_token":"drift.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshConversation(context.Background(), "t", Integration{Provider: ProviderDrift, CredentialsRef: "c"}, "456")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if !strings.Contains(gotConversationPath, "/conversations/456") || !strings.Contains(gotContactPath, "/contacts/55") {
		t.Fatalf("conversationPath=%q contactPath=%q", gotConversationPath, gotContactPath)
	}
	if req.RunMode != "webhook" || req.Cursor != "drift-webhook-456" {
		t.Fatalf("req=%+v", req)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets=%d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.RequesterName != "Ada Refresh" || tk.Status != "open" || tk.ConversationID != "456" {
		t.Fatalf("ticket=%+v", tk)
	}
}

func TestDriftBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "31")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"message":"rate limited"}`))
	}))
	defer srv.Close()

	backfiller := DriftRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: DriftSecretsCredentialResolver{Secrets: fakeDriftSecretResolver{json: `{"access_token":"drift.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderDrift, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected error")
	}
	var restErr DriftRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 31*time.Second {
		t.Fatalf("err=%T %[1]v rest=%+v", err, restErr)
	}
}

func reqFirstName(tickets []TicketInput) string {
	if len(tickets) == 0 {
		return ""
	}
	return tickets[0].RequesterName
}
