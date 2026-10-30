// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type fakeHubSpotCredentialResolver struct {
	creds HubSpotCredentials
	err   error
}

func (f fakeHubSpotCredentialResolver) ResolveHubSpot(context.Context, string, Integration) (HubSpotCredentials, error) {
	if f.err != nil {
		return HubSpotCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeCRMSecretResolver struct {
	values map[string]string
	jsons  map[string]string
}

func (f fakeCRMSecretResolver) Get(_ context.Context, ref string) (string, error) {
	if value, ok := f.values[ref]; ok {
		return value, nil
	}
	return "", pwsecrets.ErrNotFound
}

func (f fakeCRMSecretResolver) GetJSON(_ context.Context, ref string, out any) error {
	if value, ok := f.jsons[ref]; ok {
		return json.Unmarshal([]byte(value), out)
	}
	return pwsecrets.ErrNotFound
}

func TestHubSpotSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewHubSpotSecretsCredentialResolver(fakeCRMSecretResolver{
		values: map[string]string{
			"raw": "Bearer pat-na1-abc",
			"kv":  "private_app_token=pat-na1-def\napi_version=v3",
		},
		jsons: map[string]string{
			"json": `{"access_token":"pat-na1-json","api_base_url":"https://example.test","user_agent":"Moosewave Test"}`,
		},
	})
	for _, tc := range []struct {
		ref       string
		wantToken string
		wantVer   string
		wantBase  string
		wantAgent string
	}{
		{ref: "raw", wantToken: "pat-na1-abc"},
		{ref: "kv", wantToken: "pat-na1-def", wantVer: "v3"},
		{ref: "json", wantToken: "pat-na1-json", wantBase: "https://example.test", wantAgent: "Moosewave Test"},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			creds, err := resolver.ResolveHubSpot(context.Background(), "tenant-1", Integration{CredentialsRef: tc.ref})
			if err != nil {
				t.Fatal(err)
			}
			if creds.AccessToken != tc.wantToken || creds.APIVersion != tc.wantVer || creds.APIBaseURL != tc.wantBase || creds.UserAgent != tc.wantAgent {
				t.Fatalf("creds=%+v", creds)
			}
		})
	}
	if _, err := parseHubSpotCredentialSecret(`{"api_base_url":"https://example.test"}`); err == nil || !strings.Contains(err.Error(), "access_token") {
		t.Fatalf("expected token validation error, got %v", err)
	}
}

func TestHubSpotRESTBackfillerPullsLatestContactsPage(t *testing.T) {
	var gotPath, gotAuth, gotProps, gotAfter string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotProps = r.URL.Query().Get("properties")
		gotAfter = r.URL.Query().Get("after")
		if r.URL.Query().Get("limit") != "50" || r.URL.Query().Get("archived") != "false" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []any{
				map[string]any{
					"id":        "101",
					"updatedAt": "2026-06-18T10:11:12.000Z",
					"properties": map[string]any{
						"email":          "Buyer@Example.com",
						"firstname":      "Ada",
						"lastname":       "Lovelace",
						"phone":          "+15551234567",
						"company":        "Analytical Engines",
						"lifecyclestage": "customer",
					},
				},
			},
			"paging": map[string]any{"next": map[string]any{"after": "102"}},
		})
	}))
	defer srv.Close()

	req, err := (HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderHubSpot,
		CredentialsRef: "cred_hubspot_1",
		Settings: map[string]any{
			"portal_id":    "123",
			"page_size":    "50",
			"properties":   "favorite_color",
			"default_tags": []any{"crm", "VIP"},
			"list_id":      "456",
		},
	}, encodeHubSpotCursor(hubSpotCursorState{Object: "contacts", After: "100"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/crm/objects/2026-03/contacts" || gotAuth != "Bearer pat-na1-token" || gotAfter != "100" {
		t.Fatalf("request path/auth/after=%q/%q/%q", gotPath, gotAuth, gotAfter)
	}
	if !strings.Contains(gotProps, "email") || !strings.Contains(gotProps, "favorite_color") {
		t.Fatalf("properties=%q", gotProps)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "hubspot://contact/101" || contact.Email != "buyer@example.com" || contact.FirstName != "Ada" || contact.Company != "Analytical Engines" {
		t.Fatalf("contact=%+v", contact)
	}
	if !hasString(contact.Tags, "hubspot") || !hasString(contact.Tags, "VIP") || !hasString(contact.ListIDs, "456") {
		t.Fatalf("tags/list_ids=%+v/%+v", contact.Tags, contact.ListIDs)
	}
	if contact.UpdatedAt == nil || !contact.UpdatedAt.Equal(time.Date(2026, 6, 18, 10, 11, 12, 0, time.UTC)) {
		t.Fatalf("updated_at=%v", contact.UpdatedAt)
	}
	state, err := decodeHubSpotCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "contacts" || state.After != "102" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestHubSpotCursorRoundTripsListMemberships(t *testing.T) {
	raw := encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: "456", After: "abc"})
	state, err := decodeHubSpotCursor(raw)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "list_memberships" || state.ListID != "456" || state.After != "abc" {
		t.Fatalf("state=%+v raw=%s", state, raw)
	}
}

func TestHubSpotCursorRoundTripsDeals(t *testing.T) {
	raw := encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: "deal-after"})
	state, err := decodeHubSpotCursor(raw)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "deals" || state.After != "deal-after" {
		t.Fatalf("state=%+v raw=%s", state, raw)
	}
}

func TestHubSpotRESTBackfillerAdvancesContactsToConfiguredListMemberships(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/crm/objects/2026-03/contacts" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []any{},
		})
	}))
	defer srv.Close()

	req, err := (HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderHubSpot,
		CredentialsRef: "cred_hubspot_1",
		Settings: map[string]any{
			"sync_list_memberships": true,
			"membership_list_ids":   []any{"456", "789"},
		},
	}, encodeHubSpotCursor(hubSpotCursorState{Object: "contacts"}))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeHubSpotCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "list_memberships" || state.ListID != "456" || state.After != "" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
}

func TestHubSpotRESTBackfillerAdvancesContactsToDealsWhenEnabled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/crm/objects/2026-03/contacts" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []any{}})
	}))
	defer srv.Close()

	req, err := (HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderHubSpot,
		CredentialsRef: "cred_hubspot_1",
		Settings:       map[string]any{"sync_deals": true},
	}, encodeHubSpotCursor(hubSpotCursorState{Object: "contacts"}))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeHubSpotCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "deals" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
}

func TestHubSpotRESTBackfillerPullsConfiguredListMemberships(t *testing.T) {
	var gotMembershipAfter, gotBatchAuth string
	var gotBatchBody struct {
		Properties []string            `json:"properties"`
		Inputs     []map[string]string `json:"inputs"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/crm/v3/lists/456/memberships":
			gotMembershipAfter = r.URL.Query().Get("after")
			if r.URL.Query().Get("limit") != "25" {
				t.Fatalf("membership query=%s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []any{
					map[string]any{"recordId": "101"},
					map[string]any{"recordId": "202"},
				},
				"paging": map[string]any{"next": map[string]any{"after": "next-members"}},
			})
		case "/crm/v3/objects/contacts/batch/read":
			gotBatchAuth = r.Header.Get("Authorization")
			if r.Method != http.MethodPost || !strings.Contains(r.Header.Get("Content-Type"), "application/json") {
				t.Fatalf("batch method/content-type=%s/%s", r.Method, r.Header.Get("Content-Type"))
			}
			if err := json.NewDecoder(r.Body).Decode(&gotBatchBody); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []any{
					map[string]any{
						"id":        "101",
						"updatedAt": "2026-06-18T10:11:12.000Z",
						"properties": map[string]any{
							"email":     "Member@Example.com",
							"firstname": "List",
							"lastname":  "Member",
						},
					},
					map[string]any{
						"id":         "202",
						"properties": map[string]any{"firstname": "No Email"},
					},
				},
			})
		default:
			t.Fatalf("unexpected path=%s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderHubSpot,
		CredentialsRef: "cred_hubspot_1",
		Settings: map[string]any{
			"sync_list_memberships": true,
			"membership_page_size":  "25",
			"membership_list_ids":   []any{"456"},
			"list_membership_map":   map[string]any{"456": "00000000-0000-0000-0000-000000000456"},
			"properties":            "favorite_color",
		},
	}, encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: "456", After: "abc"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotMembershipAfter != "abc" || gotBatchAuth != "Bearer pat-na1-token" {
		t.Fatalf("membership after/batch auth=%q/%q", gotMembershipAfter, gotBatchAuth)
	}
	if len(gotBatchBody.Inputs) != 2 || gotBatchBody.Inputs[0]["id"] != "101" || !hasString(gotBatchBody.Properties, "email") || !hasString(gotBatchBody.Properties, "favorite_color") {
		t.Fatalf("batch body=%+v", gotBatchBody)
	}
	if len(req.Contacts) != 1 || req.Contacts[0].Email != "member@example.com" || !hasString(req.Contacts[0].ListIDs, "456") {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	if !hasString(crmStringListValue(req.Contacts[0].Properties["hubspot_proven_list_ids"]), "456") {
		t.Fatalf("proven list ids missing from contact properties: %+v", req.Contacts[0].Properties)
	}
	if req.Contacts[0].Properties["crm_provider_segment_type"] != "hubspot_list" ||
		req.Contacts[0].Properties["crm_provider_segment_id"] != "456" ||
		req.Contacts[0].Properties["crm_provider_segment_removed"] != false {
		t.Fatalf("provider segment evidence missing from contact properties: %+v", req.Contacts[0].Properties)
	}
	if !hasString(crmStringListValue(req.Contacts[0].Properties["crm_provider_segment_ids"]), "456") ||
		!hasString(crmStringListValue(req.Contacts[0].Properties["crm_provider_list_ids"]), "456") {
		t.Fatalf("provider list/segment ids missing from contact properties: %+v", req.Contacts[0].Properties)
	}
	report, ok := req.Contacts[0].Properties["hubspot_list_membership_report"].([]map[string]any)
	if !ok || len(report) != 1 {
		t.Fatalf("membership report missing from contact properties: %+v", req.Contacts[0].Properties)
	}
	if report[0]["provider"] != ProviderHubSpot || report[0]["provider_object"] != "ListMembership" || report[0]["segment_id"] != "456" || report[0]["contact_id"] != "101" || report[0]["removed"] != false {
		t.Fatalf("membership report=%+v", report[0])
	}
	state, err := decodeHubSpotCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "list_memberships" || state.ListID != "456" || state.After != "next-members" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
	if !req.nativeListMembershipManaged || len(req.nativeListMembershipScans) != 1 {
		t.Fatalf("native list membership scans=%+v managed=%v", req.nativeListMembershipScans, req.nativeListMembershipManaged)
	}
	scan := req.nativeListMembershipScans[0]
	if scan.Provider != ProviderHubSpot || scan.ProviderSegmentType != "hubspot_list" || scan.ProviderListID != "456" || scan.NativeListID != "00000000-0000-0000-0000-000000000456" || scan.Start || scan.Complete {
		t.Fatalf("scan=%+v", scan)
	}
}

func TestHubSpotRESTBackfillerAdvancesAcrossConfiguredLists(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []any{},
		})
	}))
	defer srv.Close()

	backfiller := HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
		}},
	}
	integration := Integration{
		Provider:       ProviderHubSpot,
		CredentialsRef: "cred_hubspot_1",
		Settings: map[string]any{
			"sync_list_memberships": true,
			"membership_list_ids":   []any{"456", "789"},
			"list_membership_map": map[string]any{
				"456": "00000000-0000-0000-0000-000000000456",
				"789": "00000000-0000-0000-0000-000000000789",
			},
		},
	}

	first, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: "456"}))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeHubSpotCursor(first.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "list_memberships" || state.ListID != "789" {
		t.Fatalf("first cursor=%+v raw=%s", state, first.Cursor)
	}
	if !first.nativeListMembershipManaged || len(first.nativeListMembershipScans) != 1 || !first.nativeListMembershipScans[0].Start || !first.nativeListMembershipScans[0].Complete || first.nativeListMembershipScans[0].ProviderListID != "456" {
		t.Fatalf("first scans=%+v managed=%v", first.nativeListMembershipScans, first.nativeListMembershipManaged)
	}
	second, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, first.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if second.Cursor != hubSpotCursorComplete {
		t.Fatalf("second cursor=%s", second.Cursor)
	}
	if !second.nativeListMembershipManaged || len(second.nativeListMembershipScans) != 1 || !second.nativeListMembershipScans[0].Start || !second.nativeListMembershipScans[0].Complete || second.nativeListMembershipScans[0].ProviderListID != "789" {
		t.Fatalf("second scans=%+v managed=%v", second.nativeListMembershipScans, second.nativeListMembershipManaged)
	}
	if len(seen) != 2 || seen[0] != "/crm/v3/lists/456/memberships" || seen[1] != "/crm/v3/lists/789/memberships" {
		t.Fatalf("seen=%+v", seen)
	}
}

func TestHubSpotRESTBackfillerAdvancesFinalListMembershipToDeals(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/crm/v3/lists/456/memberships" {
			t.Fatalf("unexpected path=%s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []any{}})
	}))
	defer srv.Close()

	req, err := (HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderHubSpot,
		CredentialsRef: "cred_hubspot_1",
		Settings: map[string]any{
			"sync_list_memberships": true,
			"membership_list_ids":   []any{"456"},
			"sync_deals":            true,
		},
	}, encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: "456"}))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeHubSpotCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "deals" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
}

func TestHubSpotRESTBackfillerPullsDealAssociationEvents(t *testing.T) {
	var gotDealsQuery url.Values
	var gotContactBatchBody struct {
		Inputs []map[string]string `json:"inputs"`
	}
	var gotCompanyBatchBody struct {
		Properties []string            `json:"properties"`
		Inputs     []map[string]string `json:"inputs"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/crm/objects/2026-03/deals":
			gotDealsQuery = r.URL.Query()
			if gotDealsQuery.Get("associations") != "contacts,companies" || gotDealsQuery.Get("after") != "deal-cursor" || gotDealsQuery.Get("limit") != "40" {
				t.Fatalf("deal query=%s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []any{
					map[string]any{
						"id":        "301",
						"updatedAt": "2026-06-18T10:11:12.000Z",
						"properties": map[string]any{
							"dealname":  "Expansion",
							"dealstage": "appointmentscheduled",
							"pipeline":  "default",
							"amount":    "1234.50",
						},
						"associations": map[string]any{
							"contacts":  map[string]any{"results": []any{map[string]any{"id": "101"}, map[string]any{"id": "202"}}},
							"companies": map[string]any{"results": []any{map[string]any{"id": "501"}}},
						},
					},
				},
				"paging": map[string]any{"next": map[string]any{"after": "next-deal"}},
			})
		case "/crm/v3/objects/contacts/batch/read":
			if err := json.NewDecoder(r.Body).Decode(&gotContactBatchBody); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []any{
					map[string]any{"id": "101", "properties": map[string]any{"email": "Buyer@Example.com", "firstname": "Ada"}},
					map[string]any{"id": "202", "properties": map[string]any{"firstname": "No Email"}},
				},
			})
		case "/crm/v3/objects/companies/batch/read":
			if err := json.NewDecoder(r.Body).Decode(&gotCompanyBatchBody); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []any{
					map[string]any{"id": "501", "properties": map[string]any{"name": "Analytical Engines", "domain": "example.com"}},
				},
			})
		default:
			t.Fatalf("unexpected path=%s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderHubSpot,
		CredentialsRef: "cred_hubspot_1",
		Settings: map[string]any{
			"sync_deals":         true,
			"deal_page_size":     "40",
			"deal_properties":    "dealtype",
			"company_properties": "industry",
			"list_id":            "456",
		},
	}, encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: "deal-cursor"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(gotContactBatchBody.Inputs) != 2 || gotContactBatchBody.Inputs[0]["id"] != "101" {
		t.Fatalf("contact batch=%+v", gotContactBatchBody)
	}
	if len(gotCompanyBatchBody.Inputs) != 1 || gotCompanyBatchBody.Inputs[0]["id"] != "501" || !hasString(gotCompanyBatchBody.Properties, "industry") {
		t.Fatalf("company batch=%+v", gotCompanyBatchBody)
	}
	if !strings.Contains(gotDealsQuery.Get("properties"), "dealtype") {
		t.Fatalf("deal properties=%q", gotDealsQuery.Get("properties"))
	}
	if len(req.Events) != 1 {
		t.Fatalf("events=%+v", req.Events)
	}
	event := req.Events[0]
	if event.SourceID != "hubspot://deal/301/contact/101" || event.Email != "buyer@example.com" || event.EventName != "crm.deal.updated" {
		t.Fatalf("event=%+v", event)
	}
	if event.Properties["hubspot_deal_name"] != "Expansion" || event.Properties["hubspot_deal_stage"] != "appointmentscheduled" || event.Properties["hubspot_contact_id"] != "101" {
		t.Fatalf("event properties=%+v", event.Properties)
	}
	companies, ok := event.Properties["hubspot_companies"].([]map[string]any)
	if !ok || len(companies) != 1 || companies[0]["name"] != "Analytical Engines" || companies[0]["domain"] != "example.com" {
		t.Fatalf("companies=%+v", event.Properties["hubspot_companies"])
	}
	if event.OccurredAt == nil || event.OccurredAt.Format(time.RFC3339) != "2026-06-18T10:11:12Z" {
		t.Fatalf("occurred_at=%v", event.OccurredAt)
	}
	listIDs, ok := event.Properties["crm_list_ids"].([]string)
	if !ok || !hasString(listIDs, "456") {
		t.Fatalf("crm_list_ids=%+v", event.Properties["crm_list_ids"])
	}
	state, err := decodeHubSpotCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "deals" || state.After != "next-deal" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
}

func TestHubSpotRESTBackfillerSupportsLegacyV3PathAndRateLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/crm/v3/objects/contacts" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		w.Header().Set("Retry-After", "7")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (HubSpotRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{
			AccessToken: "pat-na1-token",
			APIBaseURL:  srv.URL,
			APIVersion:  "v3",
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderHubSpot, CredentialsRef: "cred_hubspot_1"}, "")
	var rateErr HubSpotRateLimitError
	if !errors.As(err, &rateErr) || rateErr.StatusCode != http.StatusTooManyRequests || rateErr.RetryAfter != 7*time.Second {
		t.Fatalf("expected rate limit error, got %#v", err)
	}
}
