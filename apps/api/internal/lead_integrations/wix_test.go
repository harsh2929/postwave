// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseWixCredentialSecret(t *testing.T) {
	creds, err := parseWixCredentialSecret(`{
		"client_id":"client_123",
		"client_secret":"secret_123",
		"instance_id":"instance_123",
		"webhook_secret":"bridge_secret",
		"webhook_public_key":"-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
		"api_base_url":"https://wixapis.example.test/"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.ClientID != "client_123" || creds.ClientSecret != "secret_123" || creds.InstanceID != "instance_123" {
		t.Fatalf("creds=%+v", creds)
	}
	if creds.WebhookSecret != "bridge_secret" || !strings.Contains(creds.WebhookPublicKey, "BEGIN PUBLIC KEY") || creds.APIBaseURL != "https://wixapis.example.test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestDecodeWixTokenAcceptsGatewayResponseShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{name: "top level snake case", body: `{"access_token":"access_123"}`},
		{name: "top level camel case", body: `{"accessToken":"access_123"}`},
		{name: "top level token", body: `{"token":"Bearer access_123"}`},
		{name: "gateway body string", body: `{"statusCode":200,"body":"{\"accessToken\":\"access_123\"}"}`},
		{name: "gateway body object", body: `{"statusCode":200,"body":{"token":"access_123"}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token, err := decodeWixToken([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if token != "access_123" {
				t.Fatalf("token=%q", token)
			}
		})
	}
}

func TestWixRESTBackfillerPullsSubmissionsThenContacts(t *testing.T) {
	var submissionQuerySeen bool
	var contactQuerySeen bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer access_123" {
			t.Fatalf("auth=%q", auth)
		}
		if siteID := r.Header.Get("wix-site-id"); siteID != "site_123" {
			t.Fatalf("wix-site-id=%q", siteID)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/form-submission-service/v4/submissions/namespace/query":
			submissionQuerySeen = true
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			filter := body["query"].(map[string]any)["filter"].(map[string]any)
			if filter["namespace"].(map[string]any)["$eq"] != wixDefaultFormsNamespace ||
				filter["formId"].(map[string]any)["$eq"] != "form_123" {
				t.Fatalf("filter=%+v", filter)
			}
			_, _ = w.Write([]byte(`{
				"submissions":[{
					"id":"sub_123",
					"formId":"form_123",
					"namespace":"wix.form_app.form",
					"createdDate":"2026-06-16T10:00:00Z",
					"submissions":{
						"email":{"stringValue":"Lead@Example.com"},
						"first_name":{"stringValue":"Ada"},
						"company":{"stringValue":"Analytical Engines"}
					}
				}]
			}`))
		case "/contacts/v4/contacts/query":
			contactQuerySeen = true
			_, _ = w.Write([]byte(`{
				"contacts":[{
					"id":"contact_123",
					"createdDate":"2026-06-16T10:05:00Z",
					"info":{
						"name":{"first":"Grace","last":"Hopper"},
						"emails":{"items":[{"email":"Grace@Example.com","primary":true}]},
						"phones":{"items":[{"e164Phone":"+15551234567","primary":true}]},
						"company":"Compiler Club"
					}
				}]
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := WixRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeWixCredentialResolver{creds: WixCredentials{AccessToken: "access_123"}},
	}
	integration := Integration{
		Provider:       ProviderWix,
		CredentialsRef: "cred_wix_1",
		Settings:       map[string]any{"site_id": "site_123", "instance_id": "instance_123", "form_id": "form_123", "api_base_url": srv.URL},
	}
	submissions, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if !submissionQuerySeen || len(submissions.Submissions) != 1 {
		t.Fatalf("submissionQuerySeen=%v submissions=%+v", submissionQuerySeen, submissions)
	}
	if got := submissions.Submissions[0]; got.SourceID != "wix://submission/form_123/sub_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.Company != "Analytical Engines" {
		t.Fatalf("submission=%+v", got)
	}
	contacts, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, submissions.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if !contactQuerySeen || len(contacts.Submissions) != 1 {
		t.Fatalf("contactQuerySeen=%v contacts=%+v", contactQuerySeen, contacts)
	}
	if got := contacts.Submissions[0]; got.SourceID != "wix://contact/contact_123" || got.Email != "grace@example.com" || got.FirstName != "Grace" || got.Phone != "+15551234567" {
		t.Fatalf("contact=%+v", got)
	}
	if contacts.Cursor != wixCursorComplete {
		t.Fatalf("cursor=%q", contacts.Cursor)
	}
}

func TestWixRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (WixRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeWixCredentialResolver{creds: WixCredentials{AccessToken: "access_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderWix,
		CredentialsRef: "cred_wix_1",
		Settings:       map[string]any{"site_id": "site_123", "instance_id": "instance_123", "form_id": "form_123"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var rateLimit WixRateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("err=%T %v", err, err)
	}
	if rateLimit.StatusCode != http.StatusTooManyRequests || rateLimit.RetryAfter != 42*time.Second || !strings.Contains(rateLimit.Snippet, "slow down") {
		t.Fatalf("rate limit=%+v", rateLimit)
	}
}

func TestWixWebhookVerifiesJWTFetchesSubmissionAndIngests(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	priv, publicKeyPEM := testWixRSAKey(t)
	var fetched bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/form-submission-service/v4/submissions/sub_123" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		fetched = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"submission":{
				"id":"sub_123",
				"formId":"form_123",
				"namespace":"wix.form_app.form",
				"createdDate":"2026-06-16T10:00:00Z",
				"submissions":{
					"email":{"stringValue":"Lead@Example.com"},
					"first_name":{"stringValue":"Ada"}
				}
			}
		}`))
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.CredentialsRef = "cred_wix_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_123", "form_id": "form_123", "credentials_ref": "cred_wix_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		WixCredentials: fakeWixCredentialResolver{creds: WixCredentials{
			AccessToken:      "access_123",
			WebhookPublicKey: publicKeyPEM,
			APIBaseURL:       srv.URL,
			AppID:            "client_123",
		}},
		Now: func() time.Time { return now },
	}
	body := signWixJWTTest(t, priv, map[string]any{
		"iss":        "wix.com",
		"aud":        "client_123",
		"iat":        now.Unix(),
		"exp":        now.Add(time.Hour).Unix(),
		"id":         "evt_123",
		"instanceId": "instance_123",
		"eventType":  "wix.forms.v4.submission.created",
		"entityFqdn": "wix.forms.v4.submission",
		"slug":       "created",
		"entityId":   "sub_123",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.WixWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !fetched {
		t.Fatal("expected submission fetch")
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" || profiles.submissions[0].FirstName != "Ada" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].Fields["wix_event_id"] != "evt_123" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestWixWebhookParsesOfficialDataStringJWT(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	priv, publicKeyPEM := testWixRSAKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/form-submission-service/v4/submissions/sub_123" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"submission":{
			"id":"sub_123",
			"formId":"form_123",
			"namespace":"wix.form_app.form",
			"createdDate":"2026-06-16T10:00:00Z",
			"submissions":{"email":{"stringValue":"OfficialLead@Example.com"}}
		}}`))
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.CredentialsRef = "cred_wix_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_123", "form_id": "form_123", "credentials_ref": "cred_wix_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   &fakeEventSink{},
		WixCredentials: fakeWixCredentialResolver{creds: WixCredentials{
			AccessToken:      "access_123",
			WebhookPublicKey: publicKeyPEM,
			APIBaseURL:       srv.URL,
			AppID:            "client_123",
		}},
		Now: func() time.Time { return now },
	}
	body := signWixJWTTest(t, priv, map[string]any{
		"iss":  "wix.com",
		"aud":  "client_123",
		"iat":  now.Unix(),
		"exp":  now.Add(time.Hour).Unix(),
		"data": `{"eventType":"wix.forms.v4.submission.created","instanceId":"instance_123","entityFqdn":"wix.forms.v4.submission","slug":"created","entityId":"sub_123","siteId":"site_123"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.WixWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "officiallead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
}

func TestWixWebhookDedupesRepeatedSignedDelivery(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	priv, publicKeyPEM := testWixRSAKey(t)
	fetches := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches++
		if r.URL.Path != "/form-submission-service/v4/submissions/sub_123" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"submission":{
				"id":"sub_123",
				"formId":"form_123",
				"namespace":"wix.form_app.form",
				"createdDate":"2026-06-16T10:00:00Z",
				"submissions":{"email":{"stringValue":"Lead@Example.com"}}
			}
		}`))
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.CredentialsRef = "cred_wix_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_123", "form_id": "form_123", "credentials_ref": "cred_wix_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		WixCredentials: fakeWixCredentialResolver{creds: WixCredentials{
			AccessToken:      "access_123",
			WebhookPublicKey: publicKeyPEM,
			APIBaseURL:       srv.URL,
			AppID:            "client_123",
		}},
		Now: func() time.Time { return now },
	}
	body := signWixJWTTest(t, priv, map[string]any{
		"iss":        "wix.com",
		"aud":        "client_123",
		"iat":        now.Unix(),
		"exp":        now.Add(time.Hour).Unix(),
		"id":         "evt_123",
		"instanceId": "instance_123",
		"eventType":  "wix.forms.v4.submission.created",
		"entityFqdn": "wix.forms.v4.submission",
		"slug":       "created",
		"entityId":   "sub_123",
	})

	first := httptest.NewRecorder()
	deps.WixWebhook(first, httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body)))
	if first.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	deps.WixWebhook(second, httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body)))
	if second.Code != http.StatusOK {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
	if fetches != 1 || len(profiles.submissions) != 1 || len(events.submissions) != 1 || len(store.runs) != 1 {
		t.Fatalf("fetches=%d profiles=%d events=%d runs=%d", fetches, len(profiles.submissions), len(events.submissions), len(store.runs))
	}
}

func TestWixWebhookRejectsBadJWTSignature(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	priv, publicKeyPEM := testWixRSAKey(t)
	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_123", "form_id": "form_123", "credentials_ref": "cred_wix_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		WixCredentials: fakeWixCredentialResolver{creds: WixCredentials{
			AccessToken:      "access_123",
			WebhookPublicKey: publicKeyPEM,
			AppID:            "client_123",
		}},
		Now: func() time.Time { return now },
	}
	body := signWixJWTTest(t, priv, map[string]any{
		"iss":        "wix.com",
		"aud":        "client_123",
		"iat":        now.Unix(),
		"exp":        now.Add(time.Hour).Unix(),
		"id":         "evt_123",
		"instanceId": "instance_123",
		"eventType":  "wix.forms.v4.submission.created",
		"entityId":   "sub_123",
	}) + "tampered"
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.WixWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("should not ingest bad signatures, profiles=%+v runs=%+v", profiles.submissions, store.runs)
	}
}

func TestWixWebhookAcceptsSharedSecretJSONBridge(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_123", "form_id": "form_123", "credentials_ref": "cred_wix_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   &fakeEventSink{},
		WixCredentials: fakeWixCredentialResolver{creds: WixCredentials{
			AccessToken:   "access_123",
			WebhookSecret: "bridge_secret",
		}},
		Now: func() time.Time { return now },
	}
	body := `{
		"id":"evt_json_123",
		"instanceId":"instance_123",
		"eventType":"wix.forms.v4.submission.created",
		"submission":{
			"id":"sub_json_123",
			"formId":"form_123",
			"namespace":"wix.form_app.form",
			"submissions":{
				"email":{"stringValue":"JsonLead@Example.com"},
				"first_name":{"stringValue":"Lin"}
			}
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Webhook-Secret", "bridge_secret")
	rec := httptest.NewRecorder()

	deps.WixWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "jsonlead@example.com" || profiles.submissions[0].FirstName != "Lin" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
}

func TestWixWebhookRecordsAppInstallLifecycleFromSignedJWT(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	priv, publicKeyPEM := testWixRSAKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apps/v1/instance" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer access_123" {
			t.Fatalf("auth=%q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"instance":{"instanceId":"instance_123","siteId":"site_123"},
			"site":{"id":"site_123"}
		}`))
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.Name = "Wix site"
	store.integration.CredentialsRef = "cred_wix_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_123", "credentials_ref": "cred_wix_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		WixCredentials: fakeWixCredentialResolver{creds: WixCredentials{
			AccessToken:      "access_123",
			WebhookPublicKey: publicKeyPEM,
			APIBaseURL:       srv.URL,
			AppID:            "client_123",
		}},
		Now: func() time.Time { return now },
	}
	body := signWixJWTTest(t, priv, map[string]any{
		"iss":        "wix.com",
		"aud":        "client_123",
		"iat":        now.Unix(),
		"exp":        now.Add(time.Hour).Unix(),
		"id":         "evt_wix_installed_123",
		"entityFqdn": "wix.app.v1.instance",
		"slug":       "installed",
		"eventType":  "wix.app.v1.instance.installed",
		"instanceId": "instance_123",
		"siteId":     "site_123",
		"appId":      "client_123",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.WixWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("lifecycle event should not ingest leads, profiles=%+v runs=%+v", profiles.submissions, store.runs)
	}
	if store.lastInput.Provider != ProviderWix || store.lastInput.Status != "connected" {
		t.Fatalf("lastInput=%+v", store.lastInput)
	}
	if got := settingString(store.integration.Settings, "wix_app_instance_status"); got != "installed" {
		t.Fatalf("wix_app_instance_status=%q settings=%+v", got, store.integration.Settings)
	}
	if got := settingString(store.integration.Settings, "wix_app_instance_last_event_id"); got != "evt_wix_installed_123" {
		t.Fatalf("last event=%q", got)
	}
	if got := settingString(store.integration.Settings, "site_id"); got != "site_123" {
		t.Fatalf("site_id=%q settings=%+v", got, store.integration.Settings)
	}
}

func TestWixWebhookMarksAppRemovedFromSignedJWT(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	priv, publicKeyPEM := testWixRSAKey(t)
	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.Name = "Wix site"
	store.integration.CredentialsRef = "cred_wix_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_123", "credentials_ref": "cred_wix_1"}
	deps := &Deps{
		Repo: store,
		WixCredentials: fakeWixCredentialResolver{creds: WixCredentials{
			WebhookPublicKey: publicKeyPEM,
			AppID:            "client_123",
		}},
		Now: func() time.Time { return now },
	}
	body := signWixJWTTest(t, priv, map[string]any{
		"iss":        "wix.com",
		"aud":        "client_123",
		"iat":        now.Unix(),
		"exp":        now.Add(time.Hour).Unix(),
		"id":         "evt_wix_removed_123",
		"entityFqdn": "wix.app.v1.instance",
		"slug":       "removed",
		"eventType":  "wix.app.v1.instance.removed",
		"instanceId": "instance_123",
		"siteId":     "site_123",
		"appId":      "client_123",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wix/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.WixWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderWix || store.lastInput.Status != "needs_auth" || store.integration.Status != "needs_auth" {
		t.Fatalf("lastInput=%+v integration=%+v", store.lastInput, store.integration)
	}
	if got := settingString(store.integration.Settings, "wix_app_instance_status"); got != "removed" {
		t.Fatalf("wix_app_instance_status=%q settings=%+v", got, store.integration.Settings)
	}
	if len(store.runs) != 0 {
		t.Fatalf("removed lifecycle should not create sync runs: %+v", store.runs)
	}
}

func testWixRSAKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	return priv, string(pemBytes)
}

func signWixJWTTest(t *testing.T, priv *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	enc := base64.RawURLEncoding
	header, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	signingInput := enc.EncodeToString(header) + "." + enc.EncodeToString(payload)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signingInput + "." + enc.EncodeToString(signature)
}
