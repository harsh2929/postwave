// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseFormidableFormsCredentialSecret(t *testing.T) {
	creds, err := parseFormidableFormsCredentialSecret(`{
		"username": "editor",
		"application_password": "app pass",
		"site_url": "https://forms.example.com/",
		"user_agent": "Custom UA"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.Username != "editor" || creds.Password != "app pass" || creds.SiteURL != "https://forms.example.com" || creds.UserAgent != "Custom UA" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseFormidableFormsCredentialSecret("api_key=api-secret\nsite_url=https://forms.example.com/")
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != "api-secret" || creds.SiteURL != "https://forms.example.com" {
		t.Fatalf("api-key creds=%+v", creds)
	}
}

func TestFormidableFormsRESTBackfillerFetchesEntriesAndMapsSubmission(t *testing.T) {
	var sawForm, sawFields, sawEntries bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("editor:app pass")) {
			t.Fatalf("bad auth header %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("User-Agent") != formidableFormsDefaultUserAgent {
			t.Fatalf("bad user-agent %q", r.Header.Get("User-Agent"))
		}
		switch r.URL.Path {
		case "/wp-json/frm/v2/forms/40":
			sawForm = true
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"id":"40","form_key":"contact","name":"Contact Us"}`))
		case "/wp-json/frm/v2/forms/40/fields":
			sawFields = true
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{
				"686":{"id":"686","field_key":"email","name":"Email","type":"email"},
				"685":{"id":"685","field_key":"full_name","name":"Full Name","type":"text"},
				"688":{"id":"688","field_key":"phone","name":"Phone","type":"phone"}
			}`))
		case "/wp-json/frm/v2/forms/40/entries":
			sawEntries = true
			q := r.URL.Query()
			if q.Get("page") != "1" || q.Get("page_size") != "1" || q.Get("order_by") != "id" || q.Get("order") != "ASC" || q.Get("search") != "vip" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			w.Header().Set("X-WP-Total", "2")
			w.Header().Set("X-WP-TotalPages", "2")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[{
				"id":"900",
				"item_key":"entry-key",
				"form_id":"40",
				"created_at":"2026-07-03 12:34:56",
				"updated_at":"2026-07-03 12:35:00",
				"ip":"203.0.113.10",
				"metas":{
					"686":"Lead@Example.COM",
					"685":"Ada Lovelace",
					"688":{"field_id":"688","value":"+15555550123"}
				}
			}]`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	req, err := (FormidableFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeFormidableFormsCredentialResolver{creds: FormidableFormsCredentials{Username: "editor", Password: "app pass"}},
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		ID:             "lead_1",
		Provider:       ProviderFormidableForms,
		CredentialsRef: "cred_1",
		Settings:       map[string]any{"site_url": server.URL, "form_id": "40", "search": "vip", "default_tags": "wordpress, high-intent"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawForm || !sawFields || !sawEntries {
		t.Fatalf("saw form=%v fields=%v entries=%v", sawForm, sawFields, sawEntries)
	}
	if len(req.Submissions) != 1 {
		t.Fatalf("submissions=%+v", req.Submissions)
	}
	sub := req.Submissions[0]
	if sub.SourceID != "formidable-forms://entry/"+server.Listener.Addr().String()+"/40/900" {
		t.Fatalf("source id=%q", sub.SourceID)
	}
	if sub.Email != "lead@example.com" || sub.FullName != "Ada Lovelace" || sub.Phone != "+15555550123" {
		t.Fatalf("identity mapping failed: %+v", sub)
	}
	if sub.FormID != "40" || sub.FormName != "Contact Us" || sub.EventName != "lead.submitted" {
		t.Fatalf("form/event mapping failed: %+v", sub)
	}
	if sub.SubmittedAt == nil || !sub.SubmittedAt.Equal(time.Date(2026, 7, 3, 12, 34, 56, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", sub.SubmittedAt)
	}
	if !containsFold(sub.Tags, "formidable-forms") || !containsFold(sub.Tags, "formidable-forms:40") || !containsFold(sub.Tags, "high-intent") {
		t.Fatalf("tags=%+v", sub.Tags)
	}
	state, err := decodeFormidableFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 2 || state.TotalPages != 2 || state.TotalCount != 2 {
		t.Fatalf("cursor state=%+v cursor=%q", state, req.Cursor)
	}
}

func TestFormidableFormsRESTBackfillerUsesPageCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/wp-json/frm/v2/forms/40" {
			_, _ = w.Write([]byte(`{"id":"40","name":"Contact Us"}`))
			return
		}
		if r.URL.Path == "/wp-json/frm/v2/forms/40/fields" {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		if r.URL.Path != "/wp-json/frm/v2/forms/40/entries" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("page"); got != "2" {
			t.Fatalf("page=%q", got)
		}
		w.Header().Set("X-WP-Total", "1")
		w.Header().Set("X-WP-TotalPages", "1")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	req, err := (FormidableFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeFormidableFormsCredentialResolver{creds: FormidableFormsCredentials{Username: "editor", Password: "app pass"}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormidableForms,
		CredentialsRef: "cred_1",
		Settings:       map[string]any{"site_url": server.URL, "form_id": "40"},
	}, encodeFormidableFormsCursor(formidableFormsCursorState{Page: 2, TotalPages: 1, TotalCount: 1}))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeFormidableFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 2 || len(req.Submissions) != 0 {
		t.Fatalf("state=%+v submissions=%+v", state, req.Submissions)
	}
}

func TestFormidableFormsRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer server.Close()

	_, err := (FormidableFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeFormidableFormsCredentialResolver{creds: FormidableFormsCredentials{Username: "editor", Password: "app pass"}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormidableForms,
		CredentialsRef: "cred_1",
		Settings:       map[string]any{"site_url": server.URL, "form_id": "40"},
	}, "")
	var providerErr FormidableFormsProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Minute {
		t.Fatalf("err=%T %[1]v", err)
	}
}

type fakeFormidableFormsCredentialResolver struct {
	creds FormidableFormsCredentials
	err   error
}

func (f fakeFormidableFormsCredentialResolver) ResolveFormidableForms(context.Context, string, Integration) (FormidableFormsCredentials, error) {
	if f.err != nil {
		return FormidableFormsCredentials{}, f.err
	}
	return f.creds, nil
}
