package sms

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTwilioSubmitBrandRegistration(t *testing.T) {
	var gotPath string
	var gotBrandType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		user, pass, ok := r.BasicAuth()
		if !ok || user != "AC123" || pass != "token" {
			t.Fatalf("missing basic auth")
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotBrandType = r.Form.Get("BrandType")
		if r.Form.Get("CustomerProfileBundleSid") != "BUcustomer" {
			t.Fatalf("CustomerProfileBundleSid = %q", r.Form.Get("CustomerProfileBundleSid"))
		}
		if r.Form.Get("A2PProfileBundleSid") != "BUa2p" {
			t.Fatalf("A2PProfileBundleSid = %q", r.Form.Get("A2PProfileBundleSid"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sid": "BN123", "status": "PENDING"})
	}))
	defer server.Close()

	provider := &TwilioProvider{
		AccountSID:       "AC123",
		AuthToken:        "token",
		MessagingBaseURL: server.URL + "/messaging",
		HTTPClient:       server.Client(),
	}
	out, err := provider.SubmitBrandRegistration(context.Background(), TwilioBrandRegistrationInput{
		CustomerProfileBundleSID: "BUcustomer",
		A2PProfileBundleSID:      "BUa2p",
		BrandType:                "STANDARD",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/messaging/v1/a2p/BrandRegistrations" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotBrandType != "STANDARD" {
		t.Fatalf("BrandType = %q", gotBrandType)
	}
	if out.SID != "BN123" || out.Status != "PENDING" {
		t.Fatalf("unexpected resource: %#v", out)
	}
}

func TestTwilioSubmitA2PCampaign(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/messaging/v1/Services/MG123/Compliance/Usa2p" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("BrandRegistrationSid") != "BN123" {
			t.Fatalf("BrandRegistrationSid = %q", r.Form.Get("BrandRegistrationSid"))
		}
		if r.Form.Get("UsAppToPersonUsecase") != "MARKETING" {
			t.Fatalf("usecase = %q", r.Form.Get("UsAppToPersonUsecase"))
		}
		if got := r.Form["MessageSamples"]; len(got) != 2 {
			t.Fatalf("message samples = %#v", got)
		}
		if r.Form.Get("SubscriberOptIn") != "true" {
			t.Fatalf("SubscriberOptIn = %q", r.Form.Get("SubscriberOptIn"))
		}
		if r.Form.Get("PrivacyPolicyUrl") != "https://example.com/privacy" {
			t.Fatalf("PrivacyPolicyUrl = %q", r.Form.Get("PrivacyPolicyUrl"))
		}
		if r.Form.Get("TermsAndConditionsUrl") != "https://example.com/terms" {
			t.Fatalf("TermsAndConditionsUrl = %q", r.Form.Get("TermsAndConditionsUrl"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sid": "QE123", "status": "IN_REVIEW"})
	}))
	defer server.Close()

	provider := &TwilioProvider{
		AccountSID:       "AC123",
		AuthToken:        "token",
		MessagingBaseURL: server.URL + "/messaging",
		HTTPClient:       server.Client(),
	}
	out, err := provider.SubmitA2PCampaign(context.Background(), "MG123", A2PCampaignRegistrationInput{
		TwilioCampaignRegistrationInput: TwilioCampaignRegistrationInput{
			BrandRegistrationSID: "BN123",
			Usecase:              "MARKETING",
			Description:          "Marketing reminders",
			MessageFlow:          "Users opt in on a web form.",
			MessageSamples:       []string{"Hi {{name}}", "Reply STOP to opt out"},
			SubscriberOptIn:      true,
		},
		PrivacyPolicyLink:      "https://example.com/privacy",
		TermsAndConditionsLink: "https://example.com/terms",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.SID != "QE123" || out.Status != "IN_REVIEW" {
		t.Fatalf("unexpected resource: %#v", out)
	}
}

func TestTwilioSubmitA2PCampaignRequiresPolicyURLs(t *testing.T) {
	provider := &TwilioProvider{
		AccountSID:        "AC123",
		AuthToken:         "token",
		DefaultServiceSID: "MG123",
	}
	_, err := provider.SubmitA2PCampaign(context.Background(), "MG123", A2PCampaignRegistrationInput{
		TwilioCampaignRegistrationInput: TwilioCampaignRegistrationInput{
			BrandRegistrationSID: "BN123",
			Usecase:              "MARKETING",
			Description:          "Marketing reminders",
			MessageFlow:          "Users opt in on a web form.",
			MessageSamples:       []string{"Hi {{name}}"},
			SubscriberOptIn:      true,
		},
	})
	if err == nil || !strings.Contains(err.Error(), "privacy_policy_link") {
		t.Fatalf("err = %v, want local policy URL validation", err)
	}
}

func TestTelnyxSubmitBrandAndA2PCampaign(t *testing.T) {
	var gotAuth string
	var gotBrandPath string
	var gotCampaignPath string
	var gotCampaignBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/telnyx/v2/10dlc/brand":
			gotBrandPath = r.URL.Path
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["companyName"] != "Acme Inc" {
				t.Fatalf("companyName = %#v", body["companyName"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"brandId": "TEL-BRAND", "identityStatus": "VERIFIED"},
			})
		case "/telnyx/v2/10dlc/campaignBuilder":
			gotCampaignPath = r.URL.Path
			if err := json.NewDecoder(r.Body).Decode(&gotCampaignBody); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"campaignId": "TEL-CAMP", "status": "ACTIVE"},
			})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	provider := &TelnyxProvider{
		APIKey:     "key",
		BaseURL:    server.URL + "/telnyx/",
		HTTPClient: server.Client(),
	}
	brand, err := provider.SubmitBrandRegistration(context.Background(), A2PBrandRegistrationInput{
		CompanyName: "Acme Inc",
		EIN:         "12-3456789",
		Country:     "US",
	})
	if err != nil {
		t.Fatal(err)
	}
	campaign, err := provider.SubmitA2PCampaign(context.Background(), A2PCampaignRegistrationInput{
		TwilioCampaignRegistrationInput: TwilioCampaignRegistrationInput{
			BrandRegistrationSID: "TEL-BRAND",
			Usecase:              "MARKETING",
			Description:          "Product updates",
			MessageFlow:          "Contacts opt in on a checkout form.",
			MessageSamples:       []string{"Hi there", "Reply STOP to opt out"},
			SubscriberOptIn:      true,
			HasEmbeddedLinks:     true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer key" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotBrandPath != "/telnyx/v2/10dlc/brand" || gotCampaignPath != "/telnyx/v2/10dlc/campaignBuilder" {
		t.Fatalf("paths = %q %q", gotBrandPath, gotCampaignPath)
	}
	if gotCampaignBody["brandId"] != "TEL-BRAND" || gotCampaignBody["sample1"] != "Hi there" {
		t.Fatalf("campaign body = %#v", gotCampaignBody)
	}
	if brand.SID != "TEL-BRAND" || brand.Status != "VERIFIED" {
		t.Fatalf("brand = %#v", brand)
	}
	if campaign.SID != "TEL-CAMP" || campaign.Status != "ACTIVE" {
		t.Fatalf("campaign = %#v", campaign)
	}
}

func TestBandwidthSubmitBrandAndA2PCampaign(t *testing.T) {
	var gotPaths []string
	var gotBodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "user" || pass != "pass" {
			t.Fatalf("missing basic auth")
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			t.Fatal(err)
		}
		gotPaths = append(gotPaths, r.URL.Path)
		gotBodies = append(gotBodies, string(raw))
		w.Header().Set("Content-Type", "application/xml")
		switch r.URL.Path {
		case "/bandwidth/api/accounts/acc/campaignManagement/10dlc/brands":
			_, _ = w.Write([]byte(`<Response><Brand><BrandId>BW-BRAND</BrandId><IdentityStatus>VERIFIED</IdentityStatus></Brand></Response>`))
		case "/bandwidth/api/accounts/acc/campaignManagement/10dlc/campaigns":
			_, _ = w.Write([]byte(`<Response><Campaign><CampaignId>BW-CAMP</CampaignId><Status>ACTIVE</Status></Campaign></Response>`))
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	provider := &BandwidthProvider{
		AccountID:       "acc",
		Username:        "user",
		Password:        "pass",
		CampaignBaseURL: server.URL + "/bandwidth",
		HTTPClient:      server.Client(),
	}
	brand, err := provider.SubmitBrandRegistration(context.Background(), A2PBrandRegistrationInput{
		CompanyName: "Acme Inc",
		EIN:         "12-3456789",
		Country:     "US",
	})
	if err != nil {
		t.Fatal(err)
	}
	campaign, err := provider.SubmitA2PCampaign(context.Background(), A2PCampaignRegistrationInput{
		TwilioCampaignRegistrationInput: TwilioCampaignRegistrationInput{
			BrandRegistrationSID: "BW-BRAND",
			Usecase:              "MARKETING",
			Description:          "Product updates",
			MessageFlow:          "Contacts opt in on a checkout form.",
			MessageSamples:       []string{"Hi there", "Reply STOP to opt out"},
			SubscriberOptIn:      true,
			HasEmbeddedLinks:     true,
		},
		Vertical:               "RETAIL",
		TermsAndConditionsLink: "https://example.com/terms",
		PrivacyPolicyLink:      "https://example.com/privacy",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(gotPaths) != 2 {
		t.Fatalf("paths = %#v", gotPaths)
	}
	if !strings.Contains(gotBodies[0], "<CompanyName>Acme Inc</CompanyName>") {
		t.Fatalf("brand body = %s", gotBodies[0])
	}
	if !strings.Contains(gotBodies[1], "<BrandId>BW-BRAND</BrandId>") ||
		!strings.Contains(gotBodies[1], "<TermsAndConditionsLink>https://example.com/terms</TermsAndConditionsLink>") {
		t.Fatalf("campaign body = %s", gotBodies[1])
	}
	if brand.SID != "BW-BRAND" || brand.Status != "VERIFIED" {
		t.Fatalf("brand = %#v", brand)
	}
	if campaign.SID != "BW-CAMP" || campaign.Status != "ACTIVE" {
		t.Fatalf("campaign = %#v", campaign)
	}
}

func TestSenderRegistrationStatusMapping(t *testing.T) {
	tests := []struct {
		name     string
		brand    SmsRegistrationResource
		campaign SmsRegistrationResource
		want     string
	}{
		{name: "empty", want: RegistrationDraft},
		{name: "brand pending", brand: SmsRegistrationResource{SID: "BN", Status: "IN_REVIEW"}, want: RegistrationPending},
		{name: "campaign approved", brand: SmsRegistrationResource{SID: "BN", Status: "APPROVED"}, campaign: SmsRegistrationResource{SID: "QE", Status: "VERIFIED"}, want: RegistrationApproved},
		{name: "campaign rejected", brand: SmsRegistrationResource{SID: "BN", Status: "APPROVED"}, campaign: SmsRegistrationResource{SID: "QE", Status: "FAILED"}, want: RegistrationRejected},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := senderRegistrationStatus(tt.brand, tt.campaign); got != tt.want {
				t.Fatalf("senderRegistrationStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCarrierRegistrationStatusMapping(t *testing.T) {
	tests := []struct {
		name     string
		brand    SmsRegistrationResource
		campaign SmsRegistrationResource
		want     string
	}{
		{name: "empty", want: RegistrationDraft},
		{name: "brand verified", brand: SmsRegistrationResource{SID: "B", Status: "VERIFIED"}, want: RegistrationPending},
		{name: "campaign active without assignment proof", brand: SmsRegistrationResource{SID: "B", Status: "VERIFIED"}, campaign: SmsRegistrationResource{SID: "C", Status: "ACTIVE"}, want: RegistrationPending},
		{name: "campaign active with assignment proof", brand: SmsRegistrationResource{SID: "B", Status: "VERIFIED"}, campaign: SmsRegistrationResource{SID: "C", Status: "ACTIVE", Raw: map[string]any{"assignment_verified": true}}, want: RegistrationApproved},
		{name: "campaign declined", brand: SmsRegistrationResource{SID: "B", Status: "VERIFIED"}, campaign: SmsRegistrationResource{SID: "C", Status: "DECLINED"}, want: RegistrationRejected},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := carrierRegistrationStatus(tt.brand, tt.campaign); got != tt.want {
				t.Fatalf("carrierRegistrationStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}
