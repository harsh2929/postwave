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

type fakeSalesforceCredentialResolver struct {
	creds SalesforceCredentials
	err   error
}

func (f fakeSalesforceCredentialResolver) ResolveSalesforce(context.Context, string, Integration) (SalesforceCredentials, error) {
	if f.err != nil {
		return SalesforceCredentials{}, f.err
	}
	return f.creds, nil
}

func TestSalesforceSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewSalesforceSecretsCredentialResolver(fakeCRMSecretResolver{
		values: map[string]string{
			"raw": "Bearer sf-token",
			"kv": strings.Join([]string{
				"access_token=sf-kv",
				"refresh_token=sf-refresh",
				"client_id=cid",
				"client_secret=csecret",
				"instance_url=https://example.my.salesforce.com",
				"login_url=https://login.salesforce.com",
				"identity_url=https://login.salesforce.com/id/00D/005",
				"api_version=66.0",
				"scope=api refresh_token",
				"expires_at=2099-06-20T13:00:00Z",
			}, "\n"),
		},
		jsons: map[string]string{
			"json": `{"access_token":"sf-json","instance_url":"https://json.my.salesforce.com","user_agent":"Moosewave Test"}`,
		},
	})
	for _, tc := range []struct {
		ref       string
		settings  map[string]any
		wantToken string
		wantURL   string
		wantVer   string
		wantAgent string
	}{
		{ref: "raw", settings: map[string]any{"instance_url": "https://settings.my.salesforce.com"}, wantToken: "sf-token", wantURL: "https://settings.my.salesforce.com"},
		{ref: "kv", wantToken: "sf-kv", wantURL: "https://example.my.salesforce.com", wantVer: "66.0"},
		{ref: "json", wantToken: "sf-json", wantURL: "https://json.my.salesforce.com", wantAgent: "Moosewave Test"},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			creds, err := resolver.ResolveSalesforce(context.Background(), "tenant-1", Integration{CredentialsRef: tc.ref, Settings: tc.settings})
			if err != nil {
				t.Fatal(err)
			}
			if creds.AccessToken != tc.wantToken || creds.InstanceURL != tc.wantURL || creds.APIVersion != tc.wantVer || creds.UserAgent != tc.wantAgent {
				t.Fatalf("creds=%+v", creds)
			}
			if tc.ref == "kv" {
				if creds.RefreshToken != "sf-refresh" || creds.ClientID != "cid" || creds.ClientSecret != "csecret" || creds.LoginURL != "https://login.salesforce.com" || creds.IdentityURL != "https://login.salesforce.com/id/00D/005" || creds.Scope != "api refresh_token" {
					t.Fatalf("expanded kv creds=%+v", creds)
				}
				if creds.TokenExpiresAt == nil || creds.TokenExpiresAt.Format(time.RFC3339) != "2099-06-20T13:00:00Z" {
					t.Fatalf("expires_at=%v", creds.TokenExpiresAt)
				}
			}
		})
	}
	if _, err := parseSalesforceCredentialSecret(`{"instance_url":"https://example.my.salesforce.com"}`); err == nil || !strings.Contains(err.Error(), "access_token") {
		t.Fatalf("expected token validation error, got %v", err)
	}
}

func TestSalesforceRESTBackfillerPullsContactsPage(t *testing.T) {
	var gotPath, gotAuth, gotBatch, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotBatch = r.Header.Get("Sforce-Query-Options")
		gotQuery = r.URL.Query().Get("q")
		if !strings.Contains(gotQuery, "FROM Contact") || !strings.Contains(gotQuery, "Account.Name") {
			t.Fatalf("query=%q", gotQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize":      1,
			"done":           false,
			"nextRecordsUrl": "/services/data/v67.0/query/01g-contact-200",
			"records": []any{
				map[string]any{
					"Id":               "003xx000004TmiQAAS",
					"Email":            "Buyer@Example.com",
					"FirstName":        "Ada",
					"LastName":         "Lovelace",
					"Name":             "Ada Lovelace",
					"Phone":            "+15551234567",
					"Title":            "CTO",
					"LastModifiedDate": "2026-06-18T10:11:12.000+0000",
					"Account":          map[string]any{"Name": "Analytical Engines"},
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSalesforce,
		CredentialsRef: "cred_salesforce_1",
		Settings: map[string]any{
			"org_id":       "00Dxx0000000001",
			"batch_size":   "250",
			"campaign_id":  "701xx000000001",
			"default_tags": []any{"crm", "Enterprise"},
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/services/data/v67.0/query" || gotAuth != "Bearer sf-token" || gotBatch != "batchSize=250" {
		t.Fatalf("request path/auth/batch=%q/%q/%q", gotPath, gotAuth, gotBatch)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "salesforce://contact/003xx000004TmiQAAS" || contact.Email != "buyer@example.com" || contact.Company != "Analytical Engines" || contact.LifecycleStage != "CTO" {
		t.Fatalf("contact=%+v", contact)
	}
	if !hasString(contact.Tags, "salesforce-contact") || !hasString(contact.Tags, "Enterprise") || !hasString(contact.ListIDs, "701xx000000001") {
		t.Fatalf("tags/list_ids=%+v/%+v", contact.Tags, contact.ListIDs)
	}
	state, err := decodeSalesforceCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "contacts" || state.NextRecordsURL != "/services/data/v67.0/query/01g-contact-200" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
}

func TestSalesforceRESTBackfillerPullsLeadsThenCampaignMembers(t *testing.T) {
	var gotPath, gotRawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotRawQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize": 1,
			"done":      true,
			"records": []any{
				map[string]any{
					"Id":                 "00Qxx000004Lead",
					"Email":              "Lead@Example.com",
					"FirstName":          "Grace",
					"LastName":           "Hopper",
					"Name":               "Grace Hopper",
					"Company":            "Compiler Co",
					"Status":             "Qualified",
					"IsConverted":        false,
					"ConvertedContactId": "",
					"LastModifiedDate":   "2026-06-18T10:11:12.000+0000",
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
			APIVersion:  "66.0",
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSalesforce,
		CredentialsRef: "cred_salesforce_1",
	}, encodeSalesforceCursor(salesforceCursorState{Object: "leads", NextRecordsURL: "/services/data/v66.0/query/01g-lead-200"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/services/data/v66.0/query/01g-lead-200" || gotRawQuery != "" {
		t.Fatalf("queryMore request path/query=%q/%q", gotPath, gotRawQuery)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("req=%+v", req)
	}
	lead := req.Contacts[0]
	if lead.SourceID != "salesforce://lead/00Qxx000004Lead" || lead.Email != "lead@example.com" || lead.Company != "Compiler Co" || lead.LifecycleStage != "Qualified" {
		t.Fatalf("lead=%+v", lead)
	}
	if !hasString(lead.Tags, "salesforce-lead") {
		t.Fatalf("lead tags=%+v", lead.Tags)
	}
	state, err := decodeSalesforceCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "campaign_members" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
}

func TestSalesforceRESTBackfillerSkipsCampaignMembersWhenDisabled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize": 0,
			"done":      true,
			"records":   []any{},
		})
	}))
	defer srv.Close()

	req, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSalesforce,
		CredentialsRef: "cred_salesforce_1",
		Settings: map[string]any{
			"sync_campaign_members": false,
			"sync_tasks":            false,
		},
	}, encodeSalesforceCursor(salesforceCursorState{Object: "leads"}))
	if err != nil {
		t.Fatal(err)
	}
	if req.Cursor != salesforceCursorComplete {
		t.Fatalf("cursor=%s", req.Cursor)
	}
}

func TestSalesforceRESTBackfillerContactOnlyStillCampaignMembers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize": 0,
			"done":      true,
			"records":   []any{},
		})
	}))
	defer srv.Close()

	req, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSalesforce,
		CredentialsRef: "cred_salesforce_1",
		Settings:       map[string]any{"sync_leads": false},
	}, encodeSalesforceCursor(salesforceCursorState{Object: "contacts"}))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeSalesforceCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "campaign_members" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
}

func TestSalesforceRESTBackfillerPullsCampaignMemberEventsAndAdvancesToTasks(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("q")
		if !strings.Contains(gotQuery, "FROM CampaignMember") || !strings.Contains(gotQuery, "Campaign.Name") || !strings.Contains(gotQuery, "Contact.Email") || !strings.Contains(gotQuery, "Lead.Email") || !strings.Contains(gotQuery, "IsDeleted") {
			t.Fatalf("query=%q", gotQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize": 3,
			"done":      true,
			"records": []any{
				map[string]any{
					"Id":               "00vxx000001",
					"CampaignId":       "701xx000000001",
					"Campaign":         map[string]any{"Name": "Launch Webinar"},
					"ContactId":        "003xx000004TmiQAAS",
					"Contact":          map[string]any{"Email": "Buyer@Example.com"},
					"Status":           "Responded",
					"HasResponded":     true,
					"LastModifiedDate": "2026-06-18T10:11:12.000+0000",
				},
				map[string]any{
					"Id":               "00vxx000002",
					"CampaignId":       "701xx000000002",
					"Campaign":         map[string]any{"Name": "Lead Nurture"},
					"LeadId":           "00Qxx000004Lead",
					"Lead":             map[string]any{"Email": "Lead@Example.com"},
					"Status":           "Sent",
					"HasResponded":     false,
					"LastModifiedDate": "2026-06-19T10:11:12.000+0000",
				},
				map[string]any{
					"Id":               "00vxx000003",
					"CampaignId":       "701xx000000001",
					"Campaign":         map[string]any{"Name": "Launch Webinar"},
					"ContactId":        "003xx000004Removed",
					"Contact":          map[string]any{"Email": "Removed@Example.com"},
					"Status":           "Removed",
					"HasResponded":     false,
					"IsDeleted":        true,
					"LastModifiedDate": "2026-06-20T10:11:12.000+0000",
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSalesforce,
		CredentialsRef: "cred_salesforce_1",
		Settings: map[string]any{
			"campaign_id":            "701-default",
			"campaign_member_fields": "Campaign.Type",
			"campaign_membership_map": map[string]any{
				"701xx000000001": "00000000-0000-0000-0000-000000070101",
				"701xx000000002": "00000000-0000-0000-0000-000000070102",
			},
		},
	}, encodeSalesforceCursor(salesforceCursorState{Object: "campaign_members"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Events) != 3 || len(req.Contacts) != 0 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeSalesforceCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "tasks" {
		t.Fatalf("cursor=%+v raw=%s", state, req.Cursor)
	}
	event := req.Events[0]
	if event.SourceID != "salesforce://campaign-member/00vxx000001" || event.Email != "buyer@example.com" || event.EventName != "crm.campaign_member.updated" {
		t.Fatalf("event=%+v", event)
	}
	if event.Properties["salesforce_campaign_id"] != "701xx000000001" || event.Properties["salesforce_campaign_name"] != "Launch Webinar" || event.Properties["salesforce_campaign_member_status"] != "Responded" || event.Properties["salesforce_has_responded"] != true {
		t.Fatalf("event properties=%+v", event.Properties)
	}
	if event.Properties["crm_provider_list_id"] != "701xx000000001" {
		t.Fatalf("campaign list evidence missing: %+v", event.Properties)
	}
	if event.Properties["crm_provider_segment_type"] != "salesforce_campaign" || event.Properties["crm_provider_segment_id"] != "701xx000000001" || event.Properties["crm_provider_segment_member_id"] != "00vxx000001" || event.Properties["crm_provider_segment_status"] != "Responded" || event.Properties["crm_provider_segment_removed"] != false {
		t.Fatalf("campaign provider segment evidence missing: %+v", event.Properties)
	}
	report, ok := event.Properties["salesforce_campaign_member_report"].(map[string]any)
	if !ok {
		t.Fatalf("campaign member report missing: %+v", event.Properties)
	}
	if report["provider"] != ProviderSalesforce || report["provider_object"] != "CampaignMember" || report["segment_type"] != "Campaign" || report["segment_id"] != "701xx000000001" || report["membership_id"] != "00vxx000001" || report["membership_status"] != "Responded" || report["removed"] != false || report["has_responded"] != true {
		t.Fatalf("campaign member report=%+v", report)
	}
	if req.Events[1].Email != "lead@example.com" {
		t.Fatalf("lead campaign member email not mapped: %+v", req.Events[1])
	}
	removed := req.Events[2]
	if removed.SourceID != "salesforce://campaign-member/00vxx000003" || removed.Email != "removed@example.com" || removed.EventName != "crm.campaign_member.removed" {
		t.Fatalf("removed campaign member event=%+v", removed)
	}
	if removed.Properties["crm_provider_list_removed"] != true || removed.Properties["salesforce_campaign_member_removed"] != true || removed.Properties["salesforce_is_deleted"] != true {
		t.Fatalf("removed campaign member evidence=%+v", removed.Properties)
	}
	if removed.Properties["crm_provider_segment_removed"] != true {
		t.Fatalf("removed provider segment evidence=%+v", removed.Properties)
	}
	removedReport, ok := removed.Properties["salesforce_campaign_member_report"].(map[string]any)
	if !ok || removedReport["removed"] != true || removedReport["is_deleted"] != true {
		t.Fatalf("removed campaign member report=%+v", removedReport)
	}
	if !req.nativeListMembershipManaged || len(req.nativeListMembershipScans) != 2 {
		t.Fatalf("campaign member scans=%+v managed=%v", req.nativeListMembershipScans, req.nativeListMembershipManaged)
	}
	found := map[string]CRMNativeListMembershipScan{}
	for _, scan := range req.nativeListMembershipScans {
		found[scan.ProviderListID] = scan
	}
	for providerID, nativeID := range map[string]string{
		"701xx000000001": "00000000-0000-0000-0000-000000070101",
		"701xx000000002": "00000000-0000-0000-0000-000000070102",
	} {
		scan, ok := found[providerID]
		if !ok || scan.Provider != ProviderSalesforce || scan.ProviderSegmentType != "salesforce_campaign" || scan.NativeListID != nativeID || !scan.Start || !scan.Complete {
			t.Fatalf("scan for %s=%+v found=%v", providerID, scan, ok)
		}
	}
}

func TestSalesforceRESTBackfillerCompletesMappedCampaignScanWithNoMembers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Query().Get("q"), "FROM CampaignMember") {
			t.Fatalf("query=%q", r.URL.Query().Get("q"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize": 0,
			"done":      true,
			"records":   []any{},
		})
	}))
	defer srv.Close()

	req, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSalesforce,
		CredentialsRef: "cred_salesforce_1",
		Settings: map[string]any{
			"sync_tasks": false,
			"campaign_membership_map": map[string]any{
				"701xx000000099": "00000000-0000-0000-0000-000000070199",
			},
		},
	}, encodeSalesforceCursor(salesforceCursorState{Object: "campaign_members"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Events) != 0 || req.Cursor != salesforceCursorComplete {
		t.Fatalf("req=%+v", req)
	}
	if !req.nativeListMembershipManaged || len(req.nativeListMembershipScans) != 1 {
		t.Fatalf("campaign member scans=%+v managed=%v", req.nativeListMembershipScans, req.nativeListMembershipManaged)
	}
	scan := req.nativeListMembershipScans[0]
	if scan.Provider != ProviderSalesforce || scan.ProviderSegmentType != "salesforce_campaign" || scan.ProviderListID != "701xx000000099" || scan.NativeListID != "00000000-0000-0000-0000-000000070199" || !scan.Start || !scan.Complete {
		t.Fatalf("scan=%+v", scan)
	}
}

func TestSalesforceRESTBackfillerPullsTaskEventsAndCompletes(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("q")
		if !strings.Contains(gotQuery, "FROM Task") || !strings.Contains(gotQuery, "TYPEOF Who") || !strings.Contains(gotQuery, "WHEN Contact") || !strings.Contains(gotQuery, "WHEN Lead") {
			t.Fatalf("query=%q", gotQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"totalSize": 3,
			"done":      true,
			"records": []any{
				map[string]any{
					"Id":                "00Txx000001",
					"WhoId":             "003xx000004TmiQAAS",
					"Who":               map[string]any{"Id": "003xx000004TmiQAAS", "Email": "Buyer@Example.com", "Name": "Ada Lovelace"},
					"Subject":           "Follow up",
					"Status":            "Completed",
					"Priority":          "High",
					"Type":              "Call",
					"TaskSubtype":       "Call",
					"ActivityDate":      "2026-06-18",
					"CompletedDateTime": "2026-06-18T10:11:12.000+0000",
					"OwnerId":           "005xx000001",
				},
				map[string]any{
					"Id":               "00Txx000002",
					"WhoId":            "00Qxx000004Lead",
					"Who":              map[string]any{"Id": "00Qxx000004Lead", "Email": "Lead@Example.com", "Name": "Grace Hopper"},
					"Subject":          "Demo prep",
					"Status":           "Open",
					"Priority":         "Normal",
					"LastModifiedDate": "2026-06-19T10:11:12.000+0000",
				},
				map[string]any{
					"Id":      "00Txx000003",
					"WhoId":   "001xx000Account",
					"Who":     map[string]any{"Id": "001xx000Account", "Name": "No Email Account"},
					"Subject": "Account-only task",
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSalesforce,
		CredentialsRef: "cred_salesforce_1",
		Settings: map[string]any{
			"task_fields": "CallDisposition",
			"campaign_id": "701-default",
		},
	}, encodeSalesforceCursor(salesforceCursorState{Object: "tasks"}))
	if err != nil {
		t.Fatal(err)
	}
	if req.Cursor != salesforceCursorComplete || len(req.Events) != 2 || len(req.Contacts) != 0 {
		t.Fatalf("req=%+v", req)
	}
	event := req.Events[0]
	if event.SourceID != "salesforce://task/00Txx000001" || event.Email != "buyer@example.com" || event.EventName != "crm.task.updated" {
		t.Fatalf("event=%+v", event)
	}
	if event.Properties["salesforce_subject"] != "Follow up" || event.Properties["salesforce_status"] != "Completed" || event.Properties["salesforce_task_subtype"] != "Call" || event.Properties["salesforce_who_name"] != "Ada Lovelace" {
		t.Fatalf("event properties=%+v", event.Properties)
	}
	if event.OccurredAt == nil || event.OccurredAt.Format(time.RFC3339) != "2026-06-18T10:11:12Z" {
		t.Fatalf("occurred_at=%v", event.OccurredAt)
	}
	if req.Events[1].Email != "lead@example.com" {
		t.Fatalf("lead task email not mapped: %+v", req.Events[1])
	}
}

func TestSalesforceCursorRejectsUnsupportedBareObject(t *testing.T) {
	if _, err := decodeSalesforceCursor("opportunities"); err == nil || !strings.Contains(err.Error(), "unsupported salesforce cursor object") {
		t.Fatalf("expected unsupported cursor object error, got %v", err)
	}
}

func TestSalesforceRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "9")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (SalesforceRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{
			AccessToken: "sf-token",
			InstanceURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSalesforce, CredentialsRef: "cred_salesforce_1"}, "")
	var restErr SalesforceRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 9*time.Second {
		t.Fatalf("expected rate limit error, got %#v", err)
	}
}

func TestSalesforceRESTBackfillerRefreshesAndRetriesInvalidSession(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	ref := salesforceStoredCredentialPrefix + "reactive-refresh"
	store := &fakeSalesforceManagedStore{secrets: map[string]string{}}
	var serverURL string
	var tokenCalls, queryCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case salesforceOAuthTokenPath:
			tokenCalls++
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "rt_old" {
				t.Fatalf("refresh form=%v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "at_fresh",
				"refresh_token": "rt_new",
				"instance_url":  serverURL,
				"scope":         "api refresh_token",
			})
		case "/services/data/v67.0/query":
			queryCalls++
			if got := r.Header.Get("Authorization"); got == "Bearer at_old" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode([]map[string]string{{
					"message":   "Session expired or invalid",
					"errorCode": "INVALID_SESSION_ID",
				}})
				return
			} else if got != "Bearer at_fresh" {
				t.Fatalf("Authorization=%q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"totalSize": 1,
				"done":      true,
				"records": []any{map[string]any{
					"Id":        "003xx000004TmiQAAS",
					"Email":     "buyer@example.com",
					"FirstName": "Ada",
				}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	serverURL = srv.URL
	store.secrets[ref] = salesforceStoredCredentialJSON(SalesforceCredentials{
		AccessToken:    "at_old",
		RefreshToken:   "rt_old",
		ClientID:       "cid",
		ClientSecret:   "csec",
		InstanceURL:    serverURL,
		LoginURL:       serverURL,
		TokenExpiresAt: ptrTime(now.Add(time.Hour)),
	})

	resolver := &SalesforceSecretsCredentialResolver{
		Store:       store,
		OAuthClient: SalesforceOAuthClient{HTTPClient: srv.Client(), LoginURL: serverURL, Now: func() time.Time { return now }},
		Now:         func() time.Time { return now },
	}
	req, err := (SalesforceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: resolver,
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSalesforce, CredentialsRef: ref}, "")
	if err != nil {
		t.Fatal(err)
	}
	if tokenCalls != 1 || queryCalls != 2 {
		t.Fatalf("tokenCalls=%d queryCalls=%d", tokenCalls, queryCalls)
	}
	if len(req.Contacts) != 1 || req.Contacts[0].Email != "buyer@example.com" {
		t.Fatalf("req=%+v", req)
	}
	if got := store.secrets[ref]; !strings.Contains(got, "at_fresh") || !strings.Contains(got, "rt_new") {
		t.Fatalf("refreshed credential was not persisted: %s", got)
	}
}

func ptrTime(t time.Time) *time.Time {
	return &t
}
