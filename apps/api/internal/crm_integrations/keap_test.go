// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

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

type fakeKeapCredentialResolver struct {
	creds KeapCredentials
	err   error
}

func (f fakeKeapCredentialResolver) ResolveKeap(context.Context, string, Integration) (KeapCredentials, error) {
	if f.err != nil {
		return KeapCredentials{}, f.err
	}
	return f.creds, nil
}

func TestKeapSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewKeapSecretsCredentialResolver(fakeCRMSecretResolver{
		values: map[string]string{
			"raw": "Bearer pat.raw",
			"kv":  "personal_access_token=pat.kv\napi_base_url=https://api.infusionsoft.com/crm\nuser_agent=Moosewave Test",
		},
		jsons: map[string]string{
			"json": `{"service_account_key":"sak.json","base_url":"https://api.infusionsoft.com/crm"}`,
		},
	})
	for _, tc := range []struct {
		ref       string
		wantToken string
		wantBase  string
		wantAgent string
	}{
		{ref: "raw", wantToken: "pat.raw"},
		{ref: "kv", wantToken: "pat.kv", wantBase: "https://api.infusionsoft.com/crm", wantAgent: "Moosewave Test"},
		{ref: "json", wantToken: "sak.json", wantBase: "https://api.infusionsoft.com/crm"},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			creds, err := resolver.ResolveKeap(context.Background(), "tenant-1", Integration{CredentialsRef: tc.ref})
			if err != nil {
				t.Fatal(err)
			}
			if creds.AccessToken != tc.wantToken || creds.APIBaseURL != tc.wantBase || creds.UserAgent != tc.wantAgent {
				t.Fatalf("creds=%+v", creds)
			}
		})
	}
	if _, err := parseKeapCredentialSecret(`{"api_base_url":"https://api.infusionsoft.com/crm"}`); err == nil || !strings.Contains(err.Error(), "access_token") {
		t.Fatalf("expected token validation error, got %v", err)
	}
}

func TestKeapRESTBackfillerPullsContactsPage(t *testing.T) {
	var gotPath, gotAuth, gotPageSize, gotFields, gotOrder string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotPageSize = r.URL.Query().Get("page_size")
		gotFields = r.URL.Query().Get("fields")
		gotOrder = r.URL.Query().Get("order_by")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contacts": []any{
				map[string]any{
					"id":          "123",
					"given_name":  "Ada",
					"family_name": "Lovelace",
					"email_addresses": []any{
						map[string]any{"email": "Buyer@Example.com", "field": "EMAIL1"},
					},
					"phone_numbers": []any{
						map[string]any{"number_e164": "+15551234567", "field": "PHONE1"},
					},
					"company":      map[string]any{"id": "77", "company_name": "Analytical Engines"},
					"contact_type": "Prospect",
					"tag_ids":      []any{"tag-1", "tag-2"},
					"update_time":  "2026-06-18T10:11:12Z",
				},
			},
			"next_page_token": "page-token-2",
		})
	}))
	defer srv.Close()

	req, err := (KeapRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeKeapCredentialResolver{creds: KeapCredentials{
			AccessToken: "pat.token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderKeap,
		CredentialsRef: "cred_keap_1",
		Settings: map[string]any{
			"account_id":       "keap_123",
			"page_size":        "250",
			"contacts_fields":  "custom_fields",
			"default_tags":     []any{"crm", "VIP"},
			"default_list_id":  "keap-imports",
			"keap_unused_flag": "ignored",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/rest/v2/contacts" || gotAuth != "Bearer pat.token" || gotPageSize != "250" || gotOrder != "update_time asc" {
		t.Fatalf("request path/auth/page/order=%q/%q/%q/%q", gotPath, gotAuth, gotPageSize, gotOrder)
	}
	if !strings.Contains(gotFields, "email_addresses") || !strings.Contains(gotFields, "custom_fields") {
		t.Fatalf("fields=%q", gotFields)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "keap://contact/123" || contact.Email != "buyer@example.com" || contact.Company != "Analytical Engines" || contact.LifecycleStage != "Prospect" {
		t.Fatalf("contact=%+v", contact)
	}
	if !hasString(contact.Tags, "keap-contact") || !hasString(contact.Tags, "VIP") || !hasString(contact.ListIDs, "keap-imports") {
		t.Fatalf("tags/list_ids=%+v/%+v", contact.Tags, contact.ListIDs)
	}
	if contact.UpdatedAt == nil || !contact.UpdatedAt.Equal(time.Date(2026, 6, 18, 10, 11, 12, 0, time.UTC)) {
		t.Fatalf("updated_at=%v", contact.UpdatedAt)
	}
	state, err := decodeKeapCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "contacts" || state.PageToken != "page-token-2" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestKeapRESTBackfillerPullsTaggedContactsAndCompletes(t *testing.T) {
	var gotPath, gotPageToken, gotFields string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotPageToken = r.URL.Query().Get("page_token")
		gotFields = r.URL.Query().Get("fields")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contacts": []any{
				map[string]any{
					"id":           "456",
					"email":        "Tagged@Example.com",
					"given_name":   "Grace",
					"family_name":  "Hopper",
					"applied_time": "2026-06-18T10:11:12Z",
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (KeapRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeKeapCredentialResolver{creds: KeapCredentials{
			AccessToken: "sak.token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderKeap,
		CredentialsRef: "cred_keap_1",
		Settings:       map[string]any{"account_id": "keap_123", "tag_id": "tag-123"},
	}, encodeKeapCursor(keapCursorState{Object: "tagged_contacts", PageToken: "tag-page"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/rest/v2/tags/tag-123/contacts" || gotPageToken != "tag-page" || gotFields != "" {
		t.Fatalf("request path/page_token/fields=%q/%q/%q", gotPath, gotPageToken, gotFields)
	}
	if req.Cursor != keapCursorComplete || len(req.Contacts) != 1 {
		t.Fatalf("req=%+v", req)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "keap://contact/456" || contact.Email != "tagged@example.com" || contact.FirstName != "Grace" || contact.LastName != "Hopper" {
		t.Fatalf("contact=%+v", contact)
	}
	if !hasString(contact.Tags, "keap-tag-tag-123") {
		t.Fatalf("contact tags=%+v", contact.Tags)
	}
}

func TestKeapRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "13")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (KeapRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeKeapCredentialResolver{creds: KeapCredentials{
			AccessToken: "pat.token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderKeap, CredentialsRef: "cred_keap_1"}, "")
	var restErr KeapRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 13*time.Second {
		t.Fatalf("expected rate limit error, got %#v", err)
	}
}
