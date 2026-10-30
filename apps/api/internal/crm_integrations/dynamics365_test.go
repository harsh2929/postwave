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

type fakeDynamics365CredentialResolver struct {
	creds Dynamics365Credentials
	err   error
}

func (f fakeDynamics365CredentialResolver) ResolveDynamics365(context.Context, string, Integration) (Dynamics365Credentials, error) {
	if f.err != nil {
		return Dynamics365Credentials{}, f.err
	}
	return f.creds, nil
}

func TestDynamics365SecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewDynamics365SecretsCredentialResolver(fakeCRMSecretResolver{
		values: map[string]string{
			"raw": "Bearer eyJ.raw",
			"kv":  "access_token=eyJ.kv\nenvironment_url=https://org.crm.dynamics.com\napi_version=v9.1",
		},
		jsons: map[string]string{
			"json": `{"access_token":"Bearer eyJ.json","resource":"https://org.crm4.dynamics.com","user_agent":"Moosewave Test"}`,
		},
	})
	for _, tc := range []struct {
		ref       string
		wantToken string
		wantURL   string
		wantVer   string
		wantAgent string
	}{
		{ref: "raw", wantToken: "eyJ.raw"},
		{ref: "kv", wantToken: "eyJ.kv", wantURL: "https://org.crm.dynamics.com", wantVer: "v9.1"},
		{ref: "json", wantToken: "eyJ.json", wantURL: "https://org.crm4.dynamics.com", wantAgent: "Moosewave Test"},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			creds, err := resolver.ResolveDynamics365(context.Background(), "tenant-1", Integration{CredentialsRef: tc.ref})
			if err != nil {
				t.Fatal(err)
			}
			if creds.AccessToken != tc.wantToken || creds.EnvironmentURL != tc.wantURL || creds.APIVersion != tc.wantVer || creds.UserAgent != tc.wantAgent {
				t.Fatalf("creds=%+v", creds)
			}
		})
	}
	if _, err := parseDynamics365CredentialSecret(`{"environment_url":"https://org.crm.dynamics.com"}`); err == nil || !strings.Contains(err.Error(), "access_token") {
		t.Fatalf("expected token validation error, got %v", err)
	}
}

func TestDynamics365RESTBackfillerPullsContactsPage(t *testing.T) {
	var gotPath, gotAuth, gotPrefer, gotSelect, gotOrder string
	var serverURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotPrefer = r.Header.Get("Prefer")
		gotSelect = r.URL.Query().Get("$select")
		gotOrder = r.URL.Query().Get("$orderby")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": []any{
				map[string]any{
					"contactid":               "00000000-0000-0000-0000-000000000123",
					"emailaddress1":           "Buyer@Example.com",
					"firstname":               "Ada",
					"lastname":                "Lovelace",
					"fullname":                "Ada Lovelace",
					"telephone1":              "+15551234567",
					"jobtitle":                "Decision Maker",
					"_parentcustomerid_value": "00000000-0000-0000-0000-000000000999",
					"_parentcustomerid_value@OData.Community.Display.V1.FormattedValue": "Analytical Engines",
					"_ownerid_value@OData.Community.Display.V1.FormattedValue":          "CRM Owner",
					"modifiedon": "2026-06-18T10:11:12Z",
				},
			},
			"@odata.nextLink": serverURL + "/api/data/v9.2/contacts?$skiptoken=abc",
		})
	}))
	defer srv.Close()
	serverURL = srv.URL

	req, err := (Dynamics365RESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeDynamics365CredentialResolver{creds: Dynamics365Credentials{
			AccessToken:    "eyJ.token",
			EnvironmentURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderDynamics365,
		CredentialsRef: "cred_dynamics_1",
		Settings: map[string]any{
			"page_size":       "250",
			"contacts_fields": "custom_contact_field",
			"default_tags":    []any{"crm", "VIP"},
			"default_list_id": "dynamics-imports",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/data/v9.2/contacts" || gotAuth != "Bearer eyJ.token" || !strings.Contains(gotPrefer, "odata.maxpagesize=250") || !strings.Contains(gotPrefer, "OData.Community.Display.V1.FormattedValue") {
		t.Fatalf("request path/auth/prefer=%q/%q/%q", gotPath, gotAuth, gotPrefer)
	}
	if !strings.Contains(gotSelect, "emailaddress1") || !strings.Contains(gotSelect, "custom_contact_field") || !strings.Contains(gotOrder, "modifiedon asc") {
		t.Fatalf("select/order=%q/%q", gotSelect, gotOrder)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "dynamics365://contact/00000000-0000-0000-0000-000000000123" || contact.Email != "buyer@example.com" || contact.Company != "Analytical Engines" || contact.LifecycleStage != "Decision Maker" {
		t.Fatalf("contact=%+v", contact)
	}
	if !hasString(contact.Tags, "dynamics365-contact") || !hasString(contact.Tags, "VIP") || !hasString(contact.ListIDs, "dynamics-imports") {
		t.Fatalf("tags/list_ids=%+v/%+v", contact.Tags, contact.ListIDs)
	}
	if contact.UpdatedAt == nil || !contact.UpdatedAt.Equal(time.Date(2026, 6, 18, 10, 11, 12, 0, time.UTC)) {
		t.Fatalf("updated_at=%v", contact.UpdatedAt)
	}
	state, err := decodeDynamics365Cursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "contacts" || !strings.Contains(state.NextLink, "$skiptoken=abc") {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestDynamics365RESTBackfillerPullsLeadsAndCompletes(t *testing.T) {
	var gotPath, gotSelect string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotSelect = r.URL.Query().Get("$select")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": []any{
				map[string]any{
					"leadid":        "00000000-0000-0000-0000-000000000456",
					"emailaddress1": "Lead@Example.com",
					"firstname":     "Grace",
					"lastname":      "Hopper",
					"companyname":   "Compiler Co",
					"statuscode@OData.Community.Display.V1.FormattedValue": "Qualified",
					"modifiedon": "2026-06-18T10:11:12Z",
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (Dynamics365RESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeDynamics365CredentialResolver{creds: Dynamics365Credentials{
			AccessToken:    "eyJ.token",
			EnvironmentURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderDynamics365,
		CredentialsRef: "cred_dynamics_1",
		Settings:       map[string]any{"leads_fields": "custom_lead_field"},
	}, encodeDynamics365Cursor(dynamics365CursorState{Object: "leads"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/data/v9.2/leads" || !strings.Contains(gotSelect, "leadid") || !strings.Contains(gotSelect, "custom_lead_field") {
		t.Fatalf("path/select=%q/%q", gotPath, gotSelect)
	}
	if req.Cursor != dynamics365CursorComplete || len(req.Contacts) != 1 {
		t.Fatalf("req=%+v", req)
	}
	lead := req.Contacts[0]
	if lead.SourceID != "dynamics365://lead/00000000-0000-0000-0000-000000000456" || lead.Email != "lead@example.com" || lead.Company != "Compiler Co" || lead.LifecycleStage != "Qualified" {
		t.Fatalf("lead=%+v", lead)
	}
	if !hasString(lead.Tags, "dynamics365-lead") {
		t.Fatalf("lead tags=%+v", lead.Tags)
	}
}

func TestDynamics365RESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "13")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (Dynamics365RESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeDynamics365CredentialResolver{creds: Dynamics365Credentials{
			AccessToken:    "eyJ.token",
			EnvironmentURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderDynamics365, CredentialsRef: "cred_dynamics_1"}, "")
	var restErr Dynamics365RESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 13*time.Second {
		t.Fatalf("expected rate limit error, got %#v", err)
	}
}
