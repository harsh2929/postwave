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

type fakeIntercomSecretResolver struct{ json string }

func (f fakeIntercomSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeIntercomSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*intercomCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestIntercomBackfillPageMapsConversations(t *testing.T) {
	var gotPath, gotAuth, gotStartingAfter, gotPerPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/conversations":
			gotPath = r.URL.Path
			gotStartingAfter = r.URL.Query().Get("starting_after")
			gotPerPage = r.URL.Query().Get("per_page")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type": "conversation.list",
				"conversations": []map[string]any{
					{
						"id": "c1", "state": "open", "priority": "priority", "title": "Help me", "created_at": 1718877500, "updated_at": 1718877600,
					},
				},
				"pages": map[string]any{"type": "pages", "next": map[string]any{"starting_after": ""}},
			})
		case "/conversations/c1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "c1", "state": "open", "priority": "priority", "title": "Help me", "created_at": 1718877500, "updated_at": 1718877600,
				"source": map[string]any{"body": "<p>Hello &amp; welcome</p>", "author": map[string]any{"type": "user", "email": "User@Example.com", "name": "U"}},
				"conversation_parts": map[string]any{
					"type":        "conversation_part.list",
					"total_count": 500,
					"conversation_parts": []map[string]any{
						{"id": "part-1", "part_type": "comment", "body": "<p>Agent reply</p>", "created_at": 1718877700, "author": map[string]any{"type": "admin", "id": "admin-1", "name": "Agent One"}},
						{"id": "part-2", "part_type": "note", "body": "<p>Internal note</p>", "created_at": 1718877800, "author": map[string]any{"type": "admin", "id": "admin-1", "name": "Agent One"}},
					},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"itok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    50,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "cred_ic_1"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/conversations") {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer itok" {
		t.Fatalf("auth = %q", gotAuth)
	}
	if gotStartingAfter != "" || gotPerPage != "50" {
		t.Fatalf("starting_after=%q per_page=%q", gotStartingAfter, gotPerPage)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "user@example.com" || tk.Status != "open" || tk.Subject != "Help me" {
		t.Fatalf("mapped ticket = %+v", tk)
	}
	if tk.SourceID != "intercom://conversation/c1" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if tk.Properties["intercom_conversation_parts_total_count"] != 500 || tk.Properties["intercom_conversation_parts_provider_limit"] != "intercom_returns_most_recent_500_parts" {
		t.Fatalf("conversation part count properties=%+v", tk.Properties)
	}
	if tk.UpdatedAt == nil {
		t.Fatal("updated_at (unix) not parsed")
	}
	if len(req.Messages) != 3 {
		t.Fatalf("messages=%d %+v", len(req.Messages), req.Messages)
	}
	source := req.Messages[0]
	if source.SourceID != "intercom://conversation/c1/source" || source.Direction != "inbound" || source.SenderType != "customer" || source.BodyText != "Hello & welcome" || source.BodyHTML != "<p>Hello &amp; welcome</p>" {
		t.Fatalf("source message=%+v", source)
	}
	reply := req.Messages[1]
	if reply.SourceID != "intercom://conversation_part/part-1" || reply.Direction != "outbound" || reply.SenderType != "agent" || reply.BodyText != "Agent reply" {
		t.Fatalf("reply message=%+v", reply)
	}
	if reply.Properties["intercom_part_type"] != "comment" || reply.Properties["intercom_author_id"] != "admin-1" {
		t.Fatalf("reply properties=%+v", reply.Properties)
	}
	note := req.Messages[2]
	if note.SourceID != "intercom://conversation_part/part-2" || note.Direction != "internal" || note.SenderType != "agent" || note.BodyText != "Internal note" {
		t.Fatalf("note message=%+v", note)
	}
	if req.Cursor != intercomCursorComplete {
		t.Fatalf("cursor = %q, want complete", req.Cursor)
	}
}

func TestIntercomBackfillPageMapsEmbeddedContactWhenSourceAuthorEmailMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "conversation.list",
			"conversations": []map[string]any{
				{
					"id": "c-contact", "state": "open", "title": "Where is my order?", "admin_assignee_id": "admin-1", "team_assignee_id": "team-1",
					"source": map[string]any{"author": map[string]any{"type": "user", "id": "author-1", "name": ""}},
					"contacts": map[string]any{
						"type": "contact.list",
						"contacts": []map[string]any{
							{"type": "contact", "id": "contact-1", "email": "Contact@Example.com", "name": "Casey Contact", "external_id": "shopper-44", "phone": "+15550001111"},
						},
					},
				},
			},
			"pages": map[string]any{"next": map[string]any{}},
		})
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"t"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets=%d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "contact@example.com" || tk.RequesterName != "Casey Contact" {
		t.Fatalf("ticket=%+v", tk)
	}
	for key, want := range map[string]any{
		"intercom_author_id":           "author-1",
		"intercom_contact_id":          "contact-1",
		"intercom_contact_external_id": "shopper-44",
		"intercom_contact_phone":       "+15550001111",
		"intercom_admin_assignee_id":   "admin-1",
		"intercom_team_assignee_id":    "team-1",
	} {
		if got := tk.Properties[key]; got != want {
			t.Fatalf("property %s=%v, want %v; properties=%+v", key, got, want, tk.Properties)
		}
	}
}

func TestIntercomBackfillPageLooksUpContactWhenRequesterEmailMissing(t *testing.T) {
	contactHits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/conversations":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"conversations": []map[string]any{
					{
						"id": "c-contact-lookup", "state": "open", "title": "Need help", "admin_assignee_id": "admin-1",
						"source": map[string]any{"author": map[string]any{"type": "admin", "id": "admin-author", "email": "agent@example.com", "name": "Agent Admin"}},
						"contacts": map[string]any{
							"contacts": []map[string]any{
								{"type": "contact", "id": "contact-lookup", "external_id": "local-1"},
							},
						},
					},
				},
				"pages": map[string]any{"next": map[string]any{}},
			})
		case "/conversations/c-contact-lookup":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "c-contact-lookup", "state": "open", "title": "Need help", "admin_assignee_id": "admin-1",
				"source": map[string]any{"author": map[string]any{"type": "admin", "id": "admin-author", "email": "agent@example.com", "name": "Agent Admin"}},
				"contacts": map[string]any{
					"contacts": []map[string]any{
						{"type": "contact", "id": "contact-lookup", "external_id": "local-1"},
					},
				},
			})
		case "/contacts/contact-lookup":
			contactHits++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type": "contact", "id": "contact-lookup", "email": "Lookup@Example.com", "name": "Lookup Customer", "external_id": "local-1", "phone": "+15550002222",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"t"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if contactHits != 1 {
		t.Fatalf("contactHits=%d, want 1", contactHits)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets=%d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "lookup@example.com" || tk.RequesterName != "Lookup Customer" {
		t.Fatalf("ticket=%+v", tk)
	}
	if tk.Properties["intercom_author_id"] != "admin-author" || tk.Properties["intercom_contact_id"] != "contact-lookup" || tk.Properties["intercom_contact_external_id"] != "local-1" || tk.Properties["intercom_contact_phone"] != "+15550002222" {
		t.Fatalf("properties=%+v", tk.Properties)
	}
}

func TestIntercomRefreshConversationMapsConversationAndContact(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/conversations/conv-refresh":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "conv-refresh", "state": "open", "priority": "priority", "title": "Refresh me", "created_at": 1718877500, "updated_at": 1718877600,
				"source": map[string]any{"body": "<p>Agent opened this</p>", "author": map[string]any{"type": "admin", "id": "admin-1", "email": "agent@example.com", "name": "Agent"}},
				"contacts": map[string]any{
					"contacts": []map[string]any{{"type": "contact", "id": "contact-refresh", "external_id": "shopper-1"}},
				},
				"conversation_parts": map[string]any{
					"conversation_parts": []map[string]any{
						{"id": "part-refresh", "part_type": "comment", "body": "<p>Customer reply</p>", "created_at": 1718877700, "author": map[string]any{"type": "user", "id": "user-1", "name": "Refresh Buyer"}},
					},
				},
			})
		case "/contacts/contact-refresh":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "contact-refresh", "email": "Refresh@Example.com", "name": "Refresh Buyer", "phone": "+15550003333"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"itok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshConversation(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "cred_ic_1"}, "conv-refresh")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if gotPath != "/contacts/contact-refresh" || gotAuth != "Bearer itok" {
		t.Fatalf("last path=%q auth=%q", gotPath, gotAuth)
	}
	if req.RunMode != "webhook" || req.Cursor != "intercom-webhook-conv-refresh" || len(req.Tickets) != 1 {
		t.Fatalf("req=%+v", req)
	}
	tk := req.Tickets[0]
	if tk.SourceID != "intercom://conversation/conv-refresh" || tk.Email != "refresh@example.com" || tk.RequesterName != "Refresh Buyer" {
		t.Fatalf("ticket=%+v", tk)
	}
	if tk.Properties["intercom_contact_phone"] != "+15550003333" {
		t.Fatalf("properties=%+v", tk.Properties)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages=%d %+v", len(req.Messages), req.Messages)
	}
	if req.Messages[0].SourceID != "intercom://conversation/conv-refresh/source" || req.Messages[0].Direction != "outbound" || req.Messages[0].SenderType != "agent" || req.Messages[0].BodyText != "Agent opened this" {
		t.Fatalf("source message=%+v", req.Messages[0])
	}
	if req.Messages[1].SourceID != "intercom://conversation_part/part-refresh" || req.Messages[1].Direction != "inbound" || req.Messages[1].SenderType != "customer" || req.Messages[1].BodyText != "Customer reply" {
		t.Fatalf("part message=%+v", req.Messages[1])
	}
}

func TestIntercomBackfillPageCachesContactLookup(t *testing.T) {
	contactHits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/conversations":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"conversations": []map[string]any{
					{
						"id":       "c-cache-1",
						"source":   map[string]any{"author": map[string]any{"type": "user", "id": "author-1"}},
						"contacts": map[string]any{"contacts": []map[string]any{{"type": "contact", "id": "contact-cache"}}},
					},
					{
						"id":       "c-cache-2",
						"source":   map[string]any{"author": map[string]any{"type": "user", "id": "author-2"}},
						"contacts": map[string]any{"contacts": []map[string]any{{"type": "contact", "id": "contact-cache"}}},
					},
				},
				"pages": map[string]any{"next": map[string]any{}},
			})
		case "/conversations/c-cache-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "c-cache-1",
				"source":   map[string]any{"author": map[string]any{"type": "user", "id": "author-1"}},
				"contacts": map[string]any{"contacts": []map[string]any{{"type": "contact", "id": "contact-cache"}}},
			})
		case "/conversations/c-cache-2":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":       "c-cache-2",
				"source":   map[string]any{"author": map[string]any{"type": "user", "id": "author-2"}},
				"contacts": map[string]any{"contacts": []map[string]any{{"type": "contact", "id": "contact-cache"}}},
			})
		case "/contacts/contact-cache":
			contactHits++
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "contact", "id": "contact-cache", "email": "cache@example.com", "name": "Cached Contact"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"t"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if contactHits != 1 {
		t.Fatalf("contactHits=%d, want 1", contactHits)
	}
	if len(req.Tickets) != 2 {
		t.Fatalf("tickets=%d", len(req.Tickets))
	}
	for _, tk := range req.Tickets {
		if tk.Email != "cache@example.com" || tk.RequesterName != "Cached Contact" {
			t.Fatalf("ticket=%+v", tk)
		}
	}
}

func TestIntercomBackfillPageSkipsConversationWithoutAuthorOrContactEmail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/contacts/contact-2" {
			http.Error(w, "missing contacts.read", http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"conversations": []map[string]any{
				{
					"id": "c-anon", "state": "open",
					"source":   map[string]any{"author": map[string]any{"type": "admin", "id": "author-2", "email": "agent@example.com"}},
					"contacts": map[string]any{"contacts": []map[string]any{{"id": "contact-2", "name": "No Email"}}},
				},
			},
			"pages": map[string]any{"next": map[string]any{}},
		})
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"t"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Tickets) != 0 {
		t.Fatalf("tickets=%d, want 0: %+v", len(req.Tickets), req.Tickets)
	}
}

func TestIntercomBackfillPageAdvancesCursor(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"conversations": []map[string]any{
				{"id": "c2", "state": "closed", "source": map[string]any{"author": map[string]any{"email": "a@b.com"}}},
			},
			"pages": map[string]any{"next": map[string]any{"starting_after": "CURSOR2"}},
		})
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"t"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "c", Settings: map[string]any{"page_size": 999}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if req.Cursor != intercomCursorPrefix+"CURSOR2" {
		t.Fatalf("cursor = %q, want advance", req.Cursor)
	}
}

func TestIntercomBackfillPageUsesCursorAndCapsPageSize(t *testing.T) {
	var gotStartingAfter, gotPerPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/conversations" {
			gotStartingAfter = r.URL.Query().Get("starting_after")
			gotPerPage = r.URL.Query().Get("per_page")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"conversations": []map[string]any{
				{"id": "c3", "state": "open", "source": map[string]any{"author": map[string]any{"email": "b@example.com"}}},
			},
			"pages": map[string]any{"next": map[string]any{}},
		})
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"t"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "c", Settings: map[string]any{"page_size": 999}}, intercomCursorPrefix+"CURSOR1")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotStartingAfter != "CURSOR1" || gotPerPage != "150" {
		t.Fatalf("starting_after=%q per_page=%q", gotStartingAfter, gotPerPage)
	}
}

func TestIntercomBackfillPageReturnsTypedRetryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := IntercomRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: IntercomSecretsCredentialResolver{Secrets: fakeIntercomSecretResolver{json: `{"access_token":"t"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderIntercom, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected retry error")
	}
	var providerErr IntercomRESTError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error type=%T err=%v", err, err)
	}
	if providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Minute {
		t.Fatalf("providerErr=%+v", providerErr)
	}
}
