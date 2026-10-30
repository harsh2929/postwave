// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseGoogleLeadFormsCredentialSecret(t *testing.T) {
	jsonCreds, err := parseGoogleLeadFormsCredentialSecret(`{"access_token":"Bearer token_json","developer_token":"dev_token","login_customer_id":"123-456-7890","api_base_url":"https://googleads.example.test/v24","user_agent":"custom"}`)
	if err != nil {
		t.Fatal(err)
	}
	if jsonCreds.AccessToken != "token_json" || jsonCreds.DeveloperToken != "dev_token" || jsonCreds.LoginCustomerID != "1234567890" || jsonCreds.APIBaseURL != "https://googleads.example.test/v24" || jsonCreds.UserAgent != "custom" {
		t.Fatalf("json creds=%+v", jsonCreds)
	}

	kvCreds, err := parseGoogleLeadFormsCredentialSecret("bearer_token=Bearer token_kv\ndeveloper_token=dev_kv\nmanager_customer_id=987-654-3210")
	if err != nil {
		t.Fatal(err)
	}
	if kvCreds.AccessToken != "token_kv" || kvCreds.DeveloperToken != "dev_kv" || kvCreds.LoginCustomerID != "9876543210" {
		t.Fatalf("kv creds=%+v", kvCreds)
	}

	if _, err := parseGoogleLeadFormsCredentialSecret("Bearer token_without_developer_token"); err == nil || !strings.Contains(err.Error(), "developer_token") {
		t.Fatalf("raw token should require developer_token, err=%v", err)
	}
}

func TestGoogleLeadFormsRESTBackfillerMapsSearchRows(t *testing.T) {
	var sawPath, sawAuth, sawDeveloperToken, sawLoginCustomerID string
	var sawBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawAuth = r.Header.Get("Authorization")
		sawDeveloperToken = r.Header.Get("developer-token")
		sawLoginCustomerID = r.Header.Get("login-customer-id")
		if err := json.NewDecoder(r.Body).Decode(&sawBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"results":[{
				"leadFormSubmissionData":{
					"resourceName":"customers/1234567890/leadFormSubmissionData/lead_1",
					"id":"lead_1",
					"asset":"customers/1234567890/assets/111",
					"campaign":"customers/1234567890/campaigns/222",
					"adGroup":"customers/1234567890/adGroups/333",
					"adGroupAd":"customers/1234567890/adGroupAds/333~444",
					"gclid":"gclid_1",
					"submissionDateTime":"2026-06-28 10:15:30+05:30",
					"leadFormSubmissionFields":[
						{"fieldType":"FULL_NAME","fieldValue":"Ada Lovelace"},
						{"fieldType":"EMAIL","fieldValue":"Lead@Example.com"},
						{"fieldType":"PHONE_NUMBER","fieldValue":"+15551234567"},
						{"fieldType":"COMPANY_NAME","fieldValue":"Moosewave"}
					],
					"customLeadFormSubmissionFields":[
						{"questionText":"Budget?","fieldValue":"10000"}
					]
				}
			},{
				"leadFormSubmissionData":{
					"resourceName":"customers/1234567890/leadFormSubmissionData/lead_2",
					"id":"lead_2",
					"asset":"customers/1234567890/assets/111",
					"campaign":"customers/1234567890/campaigns/222",
					"submissionDateTime":"2026-06-28 10:16:30+05:30",
					"leadFormSubmissionFields":[
						{"fieldType":"EMAIL","fieldValue":"Second@Example.com"}
					]
				}
			}]
		}`))
	}))
	defer server.Close()

	backfiller := GoogleLeadFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeGoogleLeadFormsCredentialResolver{creds: GoogleLeadFormsCredentials{AccessToken: "token_123", DeveloperToken: "dev_123", LoginCustomerID: "999-888-7777"}},
		APIBaseURL:  server.URL,
		BatchLimit:  2,
	}
	integration := Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderGoogleLeadForms,
		Name:           "Google lead form",
		CredentialsRef: "cred_google_leads_1",
		Settings: map[string]any{
			"customer_id":        "123-456-7890",
			"lead_form_asset_id": "111",
			"campaign_id":        "222",
			"default_tags":       "paid,launch",
			"form_name":          "Search leads",
		},
	}

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeGoogleLeadFormsWatermarkCursor("2026-06-28 09:00:00+05:30", "lead_0"))
	if err != nil {
		t.Fatal(err)
	}
	if sawPath != "/customers/1234567890/googleAds:search" || sawAuth != "Bearer token_123" || sawDeveloperToken != "dev_123" || sawLoginCustomerID != "9998887777" {
		t.Fatalf("request path/headers=%q %q %q %q", sawPath, sawAuth, sawDeveloperToken, sawLoginCustomerID)
	}
	if _, ok := sawBody["pageSize"]; ok {
		t.Fatalf("request must not set deprecated pageSize: %+v", sawBody)
	}
	query, _ := sawBody["query"].(string)
	for _, want := range []string{
		"FROM lead_form_submission_data",
		"lead_form_submission_data.asset = 'customers/1234567890/assets/111'",
		"lead_form_submission_data.campaign = 'customers/1234567890/campaigns/222'",
		"lead_form_submission_data.submission_date_time > '2026-06-28 09:00:00+05:30'",
		"ORDER BY lead_form_submission_data.submission_date_time ASC, lead_form_submission_data.id ASC LIMIT 2",
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("query missing %q: %s", want, query)
		}
	}
	if req.RunMode != "backfill" || req.Cursor != encodeGoogleLeadFormsWatermarkCursor("2026-06-28 10:16:30+05:30", "lead_2") {
		t.Fatalf("request summary=%+v", req)
	}
	if len(req.Submissions) != 2 {
		t.Fatalf("submissions=%+v", req.Submissions)
	}
	got := req.Submissions[0]
	if got.SourceID != "google-lead-form-extensions://lead/lead_1" || got.Email != "lead@example.com" || got.FullName != "Ada Lovelace" || got.Phone != "+15551234567" || got.Company != "Moosewave" {
		t.Fatalf("identity=%+v", got)
	}
	if got.FormID != "111" || got.FormName != "Search leads" || !containsFold(got.Tags, "google-lead-form-extensions:111") {
		t.Fatalf("form/tags=%+v", got)
	}
	if got.Fields["google_lead_forms_gclid"] != "gclid_1" || got.Fields["google_lead_forms_field.email"] != "Lead@Example.com" || got.Fields["google_lead_forms_custom_field.budget"] != "10000" {
		t.Fatalf("fields=%+v", got.Fields)
	}
	wantSubmitted := time.Date(2026, 6, 28, 4, 45, 30, 0, time.UTC)
	if got.SubmittedAt == nil || !got.SubmittedAt.Equal(wantSubmitted) {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
}

func TestGoogleLeadFormsRESTBackfillerProviderError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "2")
		http.Error(w, `{"error":"quota"}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	backfiller := GoogleLeadFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeGoogleLeadFormsCredentialResolver{creds: GoogleLeadFormsCredentials{AccessToken: "token_123", DeveloperToken: "dev_123"}},
		APIBaseURL:  server.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGoogleLeadForms,
		CredentialsRef: "cred_google_leads_1",
		Settings:       map[string]any{"customer_id": "1234567890", "lead_form_asset_id": "111", "credentials_ref": "cred_google_leads_1"},
	}, "")
	if err == nil {
		t.Fatal("expected provider error")
	}
	providerErr, ok := err.(GoogleLeadFormsProviderError)
	if !ok || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Second {
		t.Fatalf("provider error=%T %+v", err, err)
	}
}
