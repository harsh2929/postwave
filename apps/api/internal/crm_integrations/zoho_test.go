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

type fakeZohoCredentialResolver struct {
	creds ZohoCredentials
	err   error
}

func (f fakeZohoCredentialResolver) ResolveZoho(context.Context, string, Integration) (ZohoCredentials, error) {
	if f.err != nil {
		return ZohoCredentials{}, f.err
	}
	return f.creds, nil
}

func TestZohoSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewZohoSecretsCredentialResolver(fakeCRMSecretResolver{
		values: map[string]string{
			"raw": "Zoho-oauthtoken 1000.raw",
			"kv":  "access_token=1000.kv\napi_base_url=https://www.zohoapis.eu\ndata_center=eu",
		},
		jsons: map[string]string{
			"json": `{"access_token":"Bearer 1000.json","api_domain":"https://www.zohoapis.in","user_agent":"Moosewave Test"}`,
		},
	})
	for _, tc := range []struct {
		ref       string
		wantToken string
		wantBase  string
		wantDC    string
		wantAgent string
	}{
		{ref: "raw", wantToken: "1000.raw"},
		{ref: "kv", wantToken: "1000.kv", wantBase: "https://www.zohoapis.eu", wantDC: "eu"},
		{ref: "json", wantToken: "1000.json", wantBase: "https://www.zohoapis.in", wantAgent: "Moosewave Test"},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			creds, err := resolver.ResolveZoho(context.Background(), "tenant-1", Integration{CredentialsRef: tc.ref})
			if err != nil {
				t.Fatal(err)
			}
			if creds.AccessToken != tc.wantToken || creds.APIBaseURL != tc.wantBase || creds.DataCenter != tc.wantDC || creds.UserAgent != tc.wantAgent {
				t.Fatalf("creds=%+v", creds)
			}
		})
	}
	if _, err := parseZohoCredentialSecret(`{"api_base_url":"https://www.zohoapis.com"}`); err == nil || !strings.Contains(err.Error(), "access_token") {
		t.Fatalf("expected token validation error, got %v", err)
	}
}

func TestZohoRESTBackfillerPullsContactsPage(t *testing.T) {
	var gotPath, gotAuth, gotPerPage, gotPage, gotFields, gotCVID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotPerPage = r.URL.Query().Get("per_page")
		gotPage = r.URL.Query().Get("page")
		gotFields = r.URL.Query().Get("fields")
		gotCVID = r.URL.Query().Get("cvid")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{
				map[string]any{
					"id":            "554023000000310003",
					"Email":         "Buyer@Example.com",
					"First_Name":    "Ada",
					"Last_Name":     "Lovelace",
					"Full_Name":     "Ada Lovelace",
					"Phone":         "+15551234567",
					"Account_Name":  map[string]any{"id": "554023000000310001", "name": "Analytical Engines"},
					"Lead_Source":   "Trade Show",
					"Modified_Time": "2026-06-18T10:11:12+00:00",
					"Owner":         map[string]any{"name": "CRM Owner"},
				},
			},
			"info": map[string]any{
				"per_page":        50,
				"count":           1,
				"page":            1,
				"more_records":    true,
				"next_page_token": "page-token-2001",
			},
		})
	}))
	defer srv.Close()

	req, err := (ZohoRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeZohoCredentialResolver{creds: ZohoCredentials{
			AccessToken: "1000.token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderZohoCRM,
		CredentialsRef: "cred_zoho_1",
		Settings: map[string]any{
			"organization_id":  "zoho-org-1",
			"per_page":         "50",
			"contacts_fields":  "Email,First_Name,Last_Name,Account_Name",
			"list_view_id":     "cvid-123",
			"default_tags":     []any{"crm", "VIP"},
			"default_list_id":  "zoho-imports",
			"zoho_unused_flag": "ignored",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/crm/v8/Contacts" || gotAuth != "Zoho-oauthtoken 1000.token" || gotPerPage != "50" || gotPage != "1" || gotCVID != "cvid-123" {
		t.Fatalf("request path/auth/per_page/page/cvid=%q/%q/%q/%q/%q", gotPath, gotAuth, gotPerPage, gotPage, gotCVID)
	}
	if !strings.Contains(gotFields, "Email") || !strings.Contains(gotFields, "Account_Name") {
		t.Fatalf("fields=%q", gotFields)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "zoho://contact/554023000000310003" || contact.Email != "buyer@example.com" || contact.Company != "Analytical Engines" || contact.LifecycleStage != "Trade Show" {
		t.Fatalf("contact=%+v", contact)
	}
	if !hasString(contact.Tags, "zoho-contact") || !hasString(contact.Tags, "VIP") || !hasString(contact.ListIDs, "zoho-imports") || !hasString(contact.ListIDs, "cvid-123") {
		t.Fatalf("tags/list_ids=%+v/%+v", contact.Tags, contact.ListIDs)
	}
	if contact.UpdatedAt == nil || !contact.UpdatedAt.Equal(time.Date(2026, 6, 18, 10, 11, 12, 0, time.UTC)) {
		t.Fatalf("updated_at=%v", contact.UpdatedAt)
	}
	state, err := decodeZohoCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "contacts" || state.PageToken != "page-token-2001" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestZohoRESTBackfillerPullsLeadsAndCompletes(t *testing.T) {
	var gotPath, gotPageToken, gotConverted string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotPageToken = r.URL.Query().Get("page_token")
		gotConverted = r.URL.Query().Get("converted")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{
				map[string]any{
					"id":            "554023000000410003",
					"Email":         "Lead@Example.com",
					"First_Name":    "Grace",
					"Last_Name":     "Hopper",
					"Company":       "Compiler Co",
					"Lead_Status":   "Qualified",
					"Modified_Time": "2026-06-18T10:11:12+00:00",
				},
			},
			"info": map[string]any{
				"per_page":     200,
				"count":        1,
				"more_records": false,
			},
		})
	}))
	defer srv.Close()

	req, err := (ZohoRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeZohoCredentialResolver{creds: ZohoCredentials{
			AccessToken: "1000.token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderZohoCRM,
		CredentialsRef: "cred_zoho_1",
		Settings:       map[string]any{"converted": "both"},
	}, encodeZohoCursor(zohoCursorState{Object: "leads", PageToken: "lead-token"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/crm/v8/Leads" || gotPageToken != "lead-token" || gotConverted != "both" {
		t.Fatalf("request path/page_token/converted=%q/%q/%q", gotPath, gotPageToken, gotConverted)
	}
	if req.Cursor != zohoCursorComplete || len(req.Contacts) != 1 {
		t.Fatalf("req=%+v", req)
	}
	lead := req.Contacts[0]
	if lead.SourceID != "zoho://lead/554023000000410003" || lead.Email != "lead@example.com" || lead.Company != "Compiler Co" || lead.LifecycleStage != "Qualified" {
		t.Fatalf("lead=%+v", lead)
	}
	if !hasString(lead.Tags, "zoho-lead") {
		t.Fatalf("lead tags=%+v", lead.Tags)
	}
}

func TestZohoRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "13")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (ZohoRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeZohoCredentialResolver{creds: ZohoCredentials{
			AccessToken: "1000.token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderZohoCRM, CredentialsRef: "cred_zoho_1"}, "")
	var restErr ZohoRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 13*time.Second {
		t.Fatalf("expected rate limit error, got %#v", err)
	}
}
