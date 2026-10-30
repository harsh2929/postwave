// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseFacebookLeadAdsCredentialSecret(t *testing.T) {
	jsonCreds, err := parseFacebookLeadAdsCredentialSecret(`{"access_token":"Bearer token_json","app_secret":"app_secret_json","api_base_url":"https://graph.facebook.com/v25.0","user_agent":"custom"}`)
	if err != nil {
		t.Fatal(err)
	}
	if jsonCreds.AccessToken != "token_json" || jsonCreds.AppSecret != "app_secret_json" || jsonCreds.APIBaseURL != "https://graph.facebook.com/v25.0" || jsonCreds.UserAgent != "custom" {
		t.Fatalf("json creds=%+v", jsonCreds)
	}

	kvCreds, err := parseFacebookLeadAdsCredentialSecret("bearer_token=Bearer token_kv\nclient_secret=app_secret_kv\napi_base_url=https://example.test/graph")
	if err != nil {
		t.Fatal(err)
	}
	if kvCreds.AccessToken != "token_kv" || kvCreds.AppSecret != "app_secret_kv" || kvCreds.APIBaseURL != "https://example.test/graph" {
		t.Fatalf("kv creds=%+v", kvCreds)
	}

	rawCreds, err := parseFacebookLeadAdsCredentialSecret("Bearer token_raw")
	if err != nil {
		t.Fatal(err)
	}
	if rawCreds.AccessToken != "token_raw" {
		t.Fatalf("raw creds=%+v", rawCreds)
	}

	webhookSecret, err := parseFacebookLeadAdsWebhookSecret(`{"webhook_secret":"app_secret_webhook"}`)
	if err != nil {
		t.Fatal(err)
	}
	if webhookSecret != "app_secret_webhook" {
		t.Fatalf("webhook secret=%q", webhookSecret)
	}
}

func TestFacebookLeadAdsRESTBackfillerMapsGraphLeads(t *testing.T) {
	var sawPath, sawAuth, sawAfter, sawLimit, sawFields string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawAuth = r.Header.Get("Authorization")
		sawAfter = r.URL.Query().Get("after")
		sawLimit = r.URL.Query().Get("limit")
		sawFields = r.URL.Query().Get("fields")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data":[{
				"id":"lead_1",
				"created_time":"2026-06-16T10:00:00+0000",
				"form_id":"form_456",
				"ad_id":"ad_1",
				"ad_name":"Launch Ad",
				"adset_id":"adset_1",
				"adset_name":"Prospects",
				"campaign_id":"camp_1",
				"campaign_name":"Summer Launch",
				"is_organic":false,
				"platform":"facebook",
				"field_data":[
					{"name":"email","values":["Lead@Example.com"]},
					{"name":"first_name","values":["Ada"]},
					{"name":"last_name","values":["Lovelace"]},
					{"name":"phone_number","values":["+15551234567"]},
					{"name":"company_name","values":["Moosewave"]},
					{"name":"newsletter_topics","values":["launch","offers"]}
				]
			}],
			"paging":{"cursors":{"after":"after_2"},"next":"https://graph.facebook.com/v25.0/form_456/leads?after=after_2"}
		}`))
	}))
	defer server.Close()

	backfiller := FacebookLeadAdsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123"}},
		APIBaseURL:  server.URL,
		PageSize:    2,
	}
	integration := Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderFacebookLeadAds,
		Name:           "Meta lead form",
		CredentialsRef: "cred_meta_leads_1",
		Settings: map[string]any{
			"page_id":       "page_123",
			"form_id":       "form_456",
			"ad_account_id": "act_123",
			"default_tags":  "paid,launch",
		},
	}

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeFacebookLeadAdsCursor("after_1"))
	if err != nil {
		t.Fatal(err)
	}
	if sawPath != "/form_456/leads" || sawAuth != "Bearer token_123" || sawAfter != "after_1" || sawLimit != "2" {
		t.Fatalf("request path/auth/after/limit=%q %q %q %q", sawPath, sawAuth, sawAfter, sawLimit)
	}
	for _, field := range []string{"id", "created_time", "field_data", "campaign_name"} {
		if !strings.Contains(sawFields, field) {
			t.Fatalf("fields query missing %q: %s", field, sawFields)
		}
	}
	if req.RunMode != "backfill" || req.Cursor != encodeFacebookLeadAdsCursor("after_2") {
		t.Fatalf("request summary=%+v", req)
	}
	if len(req.Submissions) != 1 {
		t.Fatalf("submissions=%+v", req.Submissions)
	}
	got := req.Submissions[0]
	if got.SourceID != "facebook-lead-ads://lead/lead_1" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("identity=%+v", got)
	}
	if got.FormID != "form_456" || got.Phone != "+15551234567" || !containsFold(got.Tags, "facebook-lead-ads:form_456") {
		t.Fatalf("form/tags=%+v", got)
	}
	if got.Fields["facebook_lead_ads_page_id"] != "page_123" || got.Fields["facebook_lead_ads_campaign_name"] != "Summer Launch" || got.Fields["facebook_lead_ads_field.email"] != "Lead@Example.com" {
		t.Fatalf("fields=%+v", got.Fields)
	}
	if topics, ok := got.Fields["facebook_lead_ads_field.newsletter_topics"].([]string); !ok || len(topics) != 2 || topics[1] != "offers" {
		t.Fatalf("multi-value field=%T %+v", got.Fields["facebook_lead_ads_field.newsletter_topics"], got.Fields["facebook_lead_ads_field.newsletter_topics"])
	}
	wantSubmitted := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	if got.SubmittedAt == nil || !got.SubmittedAt.Equal(wantSubmitted) {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
}

func TestFetchFacebookLeadAdsLeadMapsGraphLead(t *testing.T) {
	var sawPath, sawAuth, sawFields string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawAuth = r.Header.Get("Authorization")
		sawFields = r.URL.Query().Get("fields")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"lead_1",
			"created_time":"2026-06-16T10:00:00+0000",
			"form_id":"form_456",
			"campaign_name":"Summer Launch",
			"field_data":[{"name":"email","values":["Lead@Example.com"]}]
		}`))
	}))
	defer server.Close()

	lead, err := fetchFacebookLeadAdsLead(context.Background(), server.Client(), server.URL, "token_123", "test-agent", "lead_1", Integration{})
	if err != nil {
		t.Fatal(err)
	}
	if sawPath != "/lead_1" || sawAuth != "Bearer token_123" || !strings.Contains(sawFields, "field_data") {
		t.Fatalf("request path/auth/fields=%q %q %q", sawPath, sawAuth, sawFields)
	}
	if lead.ID != "lead_1" || lead.FormID != "form_456" || lead.FieldData[0].Values[0] != "Lead@Example.com" {
		t.Fatalf("lead=%+v", lead)
	}
}

func TestFacebookLeadAdsRESTPageSubscriptionRegistrarReconcilesLeadgen(t *testing.T) {
	var sawPath, sawMethod, sawAuth, sawContentType, sawField string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawMethod = r.Method
		sawAuth = r.Header.Get("Authorization")
		sawContentType = r.Header.Get("Content-Type")
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		sawField = r.Form.Get("subscribed_fields")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	registrar := FacebookLeadAdsRESTPageSubscriptionRegistrar{
		HTTPClient:  server.Client(),
		Credentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123"}},
		APIBaseURL:  server.URL,
		Now:         func() time.Time { return now },
	}

	summary, err := registrar.ReconcilePageSubscription(context.Background(), Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderFacebookLeadAds,
		CredentialsRef: "cred_meta_leads_1",
		Settings:       map[string]any{"page_id": "page_123", "form_id": "form_456"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if sawMethod != http.MethodPost || sawPath != "/page_123/subscribed_apps" || sawAuth != "Bearer token_123" || sawField != "leadgen" {
		t.Fatalf("request method/path/auth/field=%q %q %q %q", sawMethod, sawPath, sawAuth, sawField)
	}
	if !strings.Contains(sawContentType, "application/x-www-form-urlencoded") {
		t.Fatalf("content type=%q", sawContentType)
	}
	if summary.PageID != "page_123" || !summary.Subscribed || summary.Endpoint != "https://app.postwave.test/api/public/lead-integrations/facebook-lead-ads/webhooks" || !summary.ReconciledAt.Equal(now) {
		t.Fatalf("summary=%+v", summary)
	}
}

func TestFacebookLeadAdsRESTPageSubscriptionRegistrarCleansLeadgen(t *testing.T) {
	var sawPath, sawMethod, sawAuth, sawQuery, sawBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawMethod = r.Method
		sawAuth = r.Header.Get("Authorization")
		sawQuery = r.URL.Query().Get("subscribed_fields")
		raw, _ := io.ReadAll(r.Body)
		sawBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	registrar := FacebookLeadAdsRESTPageSubscriptionRegistrar{
		HTTPClient:  server.Client(),
		Credentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123"}},
		APIBaseURL:  server.URL,
		Now:         func() time.Time { return now },
	}

	summary, err := registrar.CleanupPageSubscription(context.Background(), Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderFacebookLeadAds,
		CredentialsRef: "cred_meta_leads_1",
		Settings: map[string]any{
			"page_id": "page_123",
			"form_id": "form_456",
			"facebook_lead_ads_page_subscription_page_id": "page_123",
		},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if sawMethod != http.MethodDelete || sawPath != "/page_123/subscribed_apps" || sawAuth != "Bearer token_123" || sawQuery != "leadgen" || sawBody != "" {
		t.Fatalf("request method/path/auth/query/body=%q %q %q %q %q", sawMethod, sawPath, sawAuth, sawQuery, sawBody)
	}
	if summary.PageID != "page_123" || !summary.Deleted || summary.Endpoint != "https://app.postwave.test/api/public/lead-integrations/facebook-lead-ads/webhooks" || !summary.CleanedUpAt.Equal(now) {
		t.Fatalf("summary=%+v", summary)
	}
}
