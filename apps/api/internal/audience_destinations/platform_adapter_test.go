package audience_destinations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHashEmailNormalizesAndHashes(t *testing.T) {
	got := hashEmail("  Alice@Example.COM ")
	want := sha256.Sum256([]byte("alice@example.com"))
	if got != hex.EncodeToString(want[:]) {
		t.Fatalf("hashEmail = %q", got)
	}
	if hashEmail("   ") != "" {
		t.Fatal("empty email should hash to empty string")
	}

	got = hashEmailRemovingWhitespace("  A lice@Example.COM ")
	want = sha256.Sum256([]byte("alice@example.com"))
	if got != hex.EncodeToString(want[:]) {
		t.Fatalf("hashEmailRemovingWhitespace = %q", got)
	}
}

func TestHashedMembersDropsEmpties(t *testing.T) {
	members := []MemberRow{
		{Email: "a@example.com"},
		{Email: ""},
		{Email: "  "},
		{Email: "b@example.com"},
	}
	got := hashedMembers(members)
	if len(got) != 2 {
		t.Fatalf("hashedMembers len = %d want 2", len(got))
	}
	for _, h := range got {
		if len(h) != 64 {
			t.Fatalf("not a sha256 hex digest: %q", h)
		}
	}
}

func TestDefaultAdapterRegistryCoversAllProviders(t *testing.T) {
	reg := DefaultAdapterRegistry()
	for _, p := range AllProviders {
		a, ok := reg[string(p)]
		if !ok {
			t.Fatalf("missing adapter for provider %q", p)
		}
		if a.Provider() != string(p) {
			t.Fatalf("adapter Provider() = %q want %q", a.Provider(), p)
		}
	}
}

func TestProviderCapabilitiesAdvertiseDiagnosticsOnlyWhenImplemented(t *testing.T) {
	plain := &MetaAdapter{}
	diagnostics := &fakeProviderDiagnosticsAdapter{provider: string(ProviderGoogleAds)}
	caps := providerCapabilities(AdapterRegistry{
		string(ProviderMeta):      plain,
		string(ProviderGoogleAds): diagnostics,
	})
	if !caps[string(ProviderMeta)]["configured"] || caps[string(ProviderMeta)]["diagnostics"] {
		t.Fatalf("meta capabilities = %#v", caps[string(ProviderMeta)])
	}
	if !caps[string(ProviderGoogleAds)]["configured"] || !caps[string(ProviderGoogleAds)]["diagnostics"] {
		t.Fatalf("google capabilities = %#v", caps[string(ProviderGoogleAds)])
	}
	if caps[string(ProviderTikTok)]["configured"] || caps[string(ProviderTikTok)]["diagnostics"] {
		t.Fatalf("unregistered TikTok capabilities = %#v", caps[string(ProviderTikTok)])
	}
}

func TestAdapterReadinessMissingCredentials(t *testing.T) {
	reg := DefaultAdapterRegistry()
	for _, p := range AllProviders {
		st := reg[string(p)].Readiness(map[string]any{})
		if st.Ready {
			t.Errorf("%s: expected not-ready with empty config", p)
		}
		if st.Status != "missing_credentials" {
			t.Errorf("%s: status = %q", p, st.Status)
		}
		if len(st.Missing) == 0 {
			t.Errorf("%s: expected missing keys", p)
		}
	}
}

func TestAdapterReadinessCredentialReferenceRequiresResolver(t *testing.T) {
	cases := []struct {
		name    string
		adapter PlatformAdapter
		cfg     map[string]any
		missing string
	}{
		{
			name:    "meta",
			adapter: &MetaAdapter{},
			cfg:     map[string]any{"credentials_ref": "vault://ads/meta", "audience_id": "aud"},
			missing: "META_CREDENTIAL_RESOLVER",
		},
		{
			name:    "google_ads",
			adapter: &GoogleAdsAdapter{},
			cfg: map[string]any{
				"credentials_ref":            "vault://ads/google",
				"customer_id":                "1234567890",
				"customer_match_transport":   "offline_user_data_job",
				"user_list_id":               "999",
				"offline_user_data_job":      "42",
				"ad_user_data_consent":       "granted",
				"ad_personalization_consent": "granted",
			},
			missing: "GOOGLE_ADS_CREDENTIAL_RESOLVER",
		},
		{
			name:    "linkedin",
			adapter: &LinkedInAdapter{},
			cfg: map[string]any{
				"credentials_ref":            "vault://ads/linkedin",
				"account_id":                 "urn:li:sponsoredAccount:123",
				"segment_id":                 "456",
				"audiences_program_approved": true,
			},
			missing: "LINKEDIN_CREDENTIAL_RESOLVER",
		},
		{
			name:    "snap",
			adapter: &SnapAdapter{},
			cfg: map[string]any{
				"credentials_ref": "vault://ads/snap",
				"ad_account_id":   "acc",
				"segment_id":      "seg",
			},
			missing: "SNAP_CREDENTIAL_RESOLVER",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := tc.adapter.Readiness(tc.cfg)
			if st.Ready || st.Status != "credential_resolution_required" {
				t.Fatalf("readiness = %#v", st)
			}
			if strings.Join(st.Missing, ",") != tc.missing {
				t.Fatalf("missing = %#v, want %s", st.Missing, tc.missing)
			}
		})
	}
}

func TestMetaAdapterReadyAndSync(t *testing.T) {
	a := &MetaAdapter{}
	cfg := map[string]any{"access_token": "tok", "audience_id": "123"}
	st := a.Readiness(cfg)
	if !st.Ready || st.Status != "configured" {
		t.Fatalf("readiness = %#v", st)
	}

	// Point the adapter at a fake Meta endpoint so Sync exercises its real
	// HTTP transport without touching the live Marketing API.
	var gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"num_received":2}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	members := []MemberRow{{Email: "a@x.com"}, {Email: "b@x.com"}, {Email: ""}}
	res, err := a.Sync(context.Background(), cfg, members)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != 2 {
		t.Fatalf("members sent = %d want 2", res.MembersSent)
	}
	if res.BatchesSent != 1 {
		t.Fatalf("batches sent = %d want 1", res.BatchesSent)
	}
	if res.ExternalAudienceID != "123" {
		t.Fatalf("audience id = %q", res.ExternalAudienceID)
	}
	if !strings.Contains(res.Message, "provider num_received=2") {
		t.Fatalf("provider message missing Meta response evidence: %q", res.Message)
	}
	if gotPath != "/123/users" {
		t.Errorf("POST path = %q, want /123/users", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("auth header = %q, want Bearer tok", gotAuth)
	}
	// Body must carry the EMAIL_SHA256 schema + 2 hashed rows.
	payload, _ := gotBody["payload"].(map[string]any)
	if payload == nil {
		t.Fatalf("missing payload in body: %v", gotBody)
	}
	if data, ok := payload["data"].([]any); !ok || len(data) != 2 {
		t.Errorf("payload.data = %v, want 2 hashed rows", payload["data"])
	}
}

func TestMetaAdapterRecordsInvalidEntryCountsWithoutSamples(t *testing.T) {
	a := &MetaAdapter{}
	cfg := map[string]any{"access_token": "tok", "audience_id": "123"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"num_received":1,
			"num_invalid_entries":1,
			"invalid_entry_samples":["hashed-member-sample"]
		}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}, {Email: "b@x.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if !strings.Contains(res.Message, "provider num_received=1") ||
		!strings.Contains(res.Message, "provider num_invalid_entries=1") ||
		!strings.Contains(res.Message, "provider invalid_entry_sample_count=1") {
		t.Fatalf("provider message missing invalid-entry evidence: %q", res.Message)
	}
	if strings.Contains(res.Message, "hashed-member-sample") {
		t.Fatalf("provider message leaked invalid entry sample: %q", res.Message)
	}
}

func TestMetaAdapterRetriesTransientRetryAfterThenSucceeds(t *testing.T) {
	a := &MetaAdapter{}
	cfg := map[string]any{"access_token": "tok", "audience_id": "123"}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "0")
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"num_received":2}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}, {Email: "b@x.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
	if res.MembersSent != 2 || res.BatchesSent != 1 || !strings.Contains(res.Message, "Retried transient provider errors 1 time") {
		t.Fatalf("result=%#v", res)
	}
}

func TestMetaAdapterDoesNotRetryAuthFailure(t *testing.T) {
	a := &MetaAdapter{}
	cfg := map[string]any{"access_token": "tok", "audience_id": "123"}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "bad token", http.StatusUnauthorized)
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401, got result=%#v err=%v", res, err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	if res.MembersSent != 0 || res.BatchesSent != 0 || strings.Contains(res.Message, "Retried transient provider errors") {
		t.Fatalf("result=%#v", res)
	}
}

func TestMetaAdapterRetryExhaustionKeepsPartialEvidence(t *testing.T) {
	a := &MetaAdapter{}
	cfg := map[string]any{"access_token": "tok", "audience_id": "123"}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"num_received":10000}`))
			return
		}
		w.Header().Set("Retry-After", "0")
		http.Error(w, "provider unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	members := make([]MemberRow, metaUsersMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("retry-exhausted-meta-%d@example.com", i)}
	}
	res, err := a.Sync(context.Background(), cfg, members)
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("want 503, got result=%#v err=%v", res, err)
	}
	if calls != 1+metaMaxChunkAttempts {
		t.Fatalf("calls = %d, want %d", calls, 1+metaMaxChunkAttempts)
	}
	if res.MembersSent != metaUsersMaxMembers ||
		res.BatchesSent != 1 ||
		!strings.Contains(res.Message, "provider num_received=10000") ||
		!strings.Contains(res.Message, "Retried transient provider errors 2 time") {
		t.Fatalf("partial result=%#v", res)
	}
}

func TestMetaAdapterChunksOversizedRequest(t *testing.T) {
	a := &MetaAdapter{}
	cfg := map[string]any{"access_token": "tok", "audience_id": "123"}
	requestSizes := []int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		payload, _ := body["payload"].(map[string]any)
		data, _ := payload["data"].([]any)
		requestSizes = append(requestSizes, len(data))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	members := make([]MemberRow, metaUsersMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("meta-%d@example.com", i)}
	}
	res, err := a.Sync(context.Background(), cfg, members)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != metaUsersMaxMembers+1 || res.BatchesSent != 2 {
		t.Fatalf("result = %#v", res)
	}
	if fmt.Sprint(requestSizes) != "[10000 1]" {
		t.Fatalf("request sizes = %v", requestSizes)
	}
}

func TestMetaAdapterPartialChunkFailureKeepsSentEvidence(t *testing.T) {
	a := &MetaAdapter{}
	cfg := map[string]any{"access_token": "tok", "audience_id": "123"}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		http.Error(w, "quota", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	members := make([]MemberRow, metaUsersMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("partial-meta-%d@example.com", i)}
	}
	res, err := a.Sync(context.Background(), cfg, members)
	if err == nil || !strings.Contains(err.Error(), "429") {
		t.Fatalf("want provider error, got result=%#v err=%v", res, err)
	}
	if res.MembersSent != metaUsersMaxMembers || res.BatchesSent != 1 || res.ExternalAudienceID != "123" {
		t.Fatalf("partial result = %#v", res)
	}
}

func TestGoogleAdsAdapterUsesAccessTokenForAPICalls(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                          "access-token",
		"ad_personalization_consent":            "granted",
		"ad_user_data_consent":                  "granted",
		"developer_token":                       "dev-token",
		"customer_id":                           "123-456-7890",
		"login_customer_id":                     "111-222-3333",
		"user_list_id":                          "999",
		"offline_user_data_job":                 "customers/1234567890/offlineUserDataJobs/42",
		"offline_user_data_job_worker_attached": true,
	}
	st := a.Readiness(cfg)
	if !st.Ready || st.Status != "configured" {
		t.Fatalf("readiness = %#v", st)
	}

	var gotAuth, gotDeveloperToken, gotLogin, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotDeveloperToken = r.Header.Get("developer-token")
		gotLogin = r.Header.Get("login-customer-id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	if _, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if gotAuth != "Bearer access-token" {
		t.Fatalf("Authorization = %q, want Bearer access-token", gotAuth)
	}
	if gotDeveloperToken != "dev-token" {
		t.Fatalf("developer-token = %q", gotDeveloperToken)
	}
	if gotLogin != "1112223333" {
		t.Fatalf("login-customer-id = %q", gotLogin)
	}
	if gotPath != "/customers/1234567890/offlineUserDataJobs/42:addOperations" {
		t.Fatalf("path = %q", gotPath)
	}
	consent, _ := gotBody["consent"].(map[string]any)
	if consent["adUserData"] != "GRANTED" || consent["adPersonalization"] != "GRANTED" {
		t.Fatalf("consent = %+v", consent)
	}
}

func TestGoogleAdsAdapterUsesDataManagerIngest(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"ad_personalization_consent":    "granted",
		"ad_user_data_consent":          "granted",
		"customer_id":                   "123-456-7890",
		"customer_match_terms_accepted": true,
		"customer_match_transport":      "data_manager",
		"destination_reference":         "dest-1",
		"user_list_id":                  "customers/1234567890/userLists/999",
	}
	st := a.Readiness(cfg)
	if !st.Ready || st.Status != "configured" {
		t.Fatalf("readiness = %#v", st)
	}

	var gotAuth, gotDeveloperToken, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotDeveloperToken = r.Header.Get("developer-token")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"requestId":"req-123"}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}, {Email: "b@x.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != 2 || res.ExternalJobID != "req-123" {
		t.Fatalf("result = %#v", res)
	}
	if gotPath != "/audienceMembers:ingest" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer access-token" {
		t.Fatalf("Authorization = %q, want Bearer access-token", gotAuth)
	}
	if gotDeveloperToken != "" {
		t.Fatalf("developer-token should not be sent to Data Manager, got %q", gotDeveloperToken)
	}
	destinations, _ := gotBody["destinations"].([]any)
	if len(destinations) != 1 {
		t.Fatalf("destinations = %#v", gotBody["destinations"])
	}
	destination, _ := destinations[0].(map[string]any)
	account, _ := destination["operatingAccount"].(map[string]any)
	if account["accountId"] != "1234567890" || account["accountType"] != "GOOGLE_ADS" {
		t.Fatalf("operatingAccount = %#v", account)
	}
	if destination["productDestinationId"] != "999" {
		t.Fatalf("productDestinationId = %#v", destination["productDestinationId"])
	}
	if gotBody["encoding"] != "HEX" {
		t.Fatalf("encoding = %#v", gotBody["encoding"])
	}
	terms, _ := gotBody["termsOfService"].(map[string]any)
	if terms["customerMatchTermsOfServiceStatus"] != "ACCEPTED" {
		t.Fatalf("termsOfService = %#v", terms)
	}
	consent, _ := gotBody["consent"].(map[string]any)
	if consent["adUserData"] != "CONSENT_GRANTED" || consent["adPersonalization"] != "CONSENT_GRANTED" {
		t.Fatalf("consent = %#v", consent)
	}
	audienceMembers, _ := gotBody["audienceMembers"].([]any)
	if len(audienceMembers) != 2 {
		t.Fatalf("audienceMembers = %#v", gotBody["audienceMembers"])
	}
	member, _ := audienceMembers[0].(map[string]any)
	composite, _ := member["compositeData"].(map[string]any)
	userData, _ := composite["userData"].(map[string]any)
	identifiers, _ := userData["userIdentifiers"].([]any)
	firstIdentifier, _ := identifiers[0].(map[string]any)
	if email, _ := firstIdentifier["emailAddress"].(string); len(email) != 64 {
		t.Fatalf("emailAddress should be SHA-256 HEX, got %#v", firstIdentifier["emailAddress"])
	}
}

func TestGoogleAdsAdapterUsesDataManagerRemove(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"ad_personalization_consent":    "granted",
		"ad_user_data_consent":          "granted",
		"customer_id":                   "123-456-7890",
		"customer_match_operation":      "remove",
		"customer_match_terms_accepted": true,
		"customer_match_transport":      "data_manager",
		"destination_reference":         "dest-1",
		"user_list_id":                  "customers/1234567890/userLists/999",
	}
	st := a.Readiness(cfg)
	if !st.Ready || st.Status != "configured" {
		t.Fatalf("readiness = %#v", st)
	}

	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"requestId":"req-remove"}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "remove@x.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if gotPath != "/audienceMembers:remove" {
		t.Fatalf("path = %q", gotPath)
	}
	if _, ok := gotBody["consent"]; ok {
		t.Fatalf("remove payload should not include upload consent block: %#v", gotBody["consent"])
	}
	if _, ok := gotBody["termsOfService"]; ok {
		t.Fatalf("remove payload should not include upload terms block: %#v", gotBody["termsOfService"])
	}
	if gotBody["encoding"] != "HEX" {
		t.Fatalf("encoding = %#v", gotBody["encoding"])
	}
	audienceMembers, _ := gotBody["audienceMembers"].([]any)
	if len(audienceMembers) != 1 {
		t.Fatalf("audienceMembers = %#v", gotBody["audienceMembers"])
	}
	if res.MembersSent != 1 || res.ExternalJobID != "req-remove" || !strings.Contains(res.Message, "Removed 1 hashed-email identifiers from Google Ads Customer Match via Data Manager API") {
		t.Fatalf("result = %#v", res)
	}
}

func TestGoogleAdsDataManagerChunksOversizedRequest(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"ad_personalization_consent":    "granted",
		"ad_user_data_consent":          "granted",
		"customer_id":                   "123-456-7890",
		"customer_match_terms_accepted": true,
		"customer_match_transport":      "data_manager",
		"user_list_id":                  "999",
	}
	requestSizes := []int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		audienceMembers, _ := body["audienceMembers"].([]any)
		requestSizes = append(requestSizes, len(audienceMembers))
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"requestId":"req-%d"}`, len(requestSizes))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	members := make([]MemberRow, googleDataManagerMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("user-%d@example.com", i)}
	}
	res, err := a.Sync(context.Background(), cfg, members)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != googleDataManagerMaxMembers+1 || res.BatchesSent != 2 {
		t.Fatalf("result = %#v", res)
	}
	if fmt.Sprint(requestSizes) != "[10000 1]" {
		t.Fatalf("request sizes = %v", requestSizes)
	}
	requestIDs, err := googleDataManagerDecodeRequestIDs(res.ExternalJobID)
	if err != nil {
		t.Fatalf("decode request IDs: %v", err)
	}
	if fmt.Sprint(requestIDs) != "[req-1 req-2]" {
		t.Fatalf("request IDs = %v from %q", requestIDs, res.ExternalJobID)
	}
}

func TestGoogleAdsDataManagerRetriesTransientRetryAfterThenSucceeds(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"ad_personalization_consent":    "granted",
		"ad_user_data_consent":          "granted",
		"customer_id":                   "123-456-7890",
		"customer_match_terms_accepted": true,
		"customer_match_transport":      "data_manager",
		"user_list_id":                  "999",
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "0")
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"requestId":"req-after-retry"}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}, {Email: "b@x.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
	if res.MembersSent != 2 ||
		res.BatchesSent != 1 ||
		res.ExternalJobID != "req-after-retry" ||
		!strings.Contains(res.Message, "Retried transient provider errors 1 time") {
		t.Fatalf("result=%#v", res)
	}
}

func TestGoogleAdsDataManagerDoesNotRetryAuthFailure(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"ad_personalization_consent":    "granted",
		"ad_user_data_consent":          "granted",
		"customer_id":                   "123-456-7890",
		"customer_match_terms_accepted": true,
		"customer_match_transport":      "data_manager",
		"user_list_id":                  "999",
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "bad token", http.StatusUnauthorized)
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401, got result=%#v err=%v", res, err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	if res.MembersSent != 0 || res.BatchesSent != 0 || strings.Contains(res.Message, "Retried transient provider errors") {
		t.Fatalf("result=%#v", res)
	}
}

func TestGoogleAdsDataManagerRetryExhaustionKeepsRequestEvidence(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"ad_personalization_consent":    "granted",
		"ad_user_data_consent":          "granted",
		"customer_id":                   "123-456-7890",
		"customer_match_terms_accepted": true,
		"customer_match_transport":      "data_manager",
		"user_list_id":                  "999",
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"requestId":"req-accepted"}`))
			return
		}
		w.Header().Set("Retry-After", "0")
		http.Error(w, "provider unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	members := make([]MemberRow, googleDataManagerMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("google-retry-exhausted-%d@example.com", i)}
	}
	res, err := a.Sync(context.Background(), cfg, members)
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("want 503, got result=%#v err=%v", res, err)
	}
	if calls != 1+googleDataManagerMaxAttempts {
		t.Fatalf("calls = %d, want %d", calls, 1+googleDataManagerMaxAttempts)
	}
	if res.MembersSent != googleDataManagerMaxMembers ||
		res.BatchesSent != 1 ||
		res.ExternalJobID != "req-accepted" ||
		!strings.Contains(res.Message, "Retried transient provider errors 2 time") {
		t.Fatalf("partial result=%#v", res)
	}
}

func TestGoogleAdsDataManagerPartialChunkFailureKeepsRequestEvidence(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"ad_personalization_consent":    "granted",
		"ad_user_data_consent":          "granted",
		"customer_id":                   "123-456-7890",
		"customer_match_terms_accepted": true,
		"customer_match_transport":      "data_manager",
		"user_list_id":                  "999",
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"requestId":"req-accepted"}`))
			return
		}
		http.Error(w, "quota", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	members := make([]MemberRow, googleDataManagerMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("partial-%d@example.com", i)}
	}
	res, err := a.Sync(context.Background(), cfg, members)
	if err == nil || !strings.Contains(err.Error(), "429") {
		t.Fatalf("want provider error, got result=%#v err=%v", res, err)
	}
	if res.MembersSent != googleDataManagerMaxMembers || res.BatchesSent != 1 || res.ExternalJobID != "req-accepted" {
		t.Fatalf("partial result = %#v", res)
	}
}

func TestGoogleAdsAdapterRetrievesDataManagerRequestStatus(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{"access_token": "access-token", "customer_match_transport": "data_manager"}
	var gotMethod, gotPath, gotRequestID, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotRequestID = r.URL.Query().Get("requestId")
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"requestStatusPerDestination":[{"destinationReference":"dest-1","requestStatus":"SUCCESS"}]}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	res, err := a.RetrieveDiagnostics(context.Background(), cfg, ProviderRunEvidence{
		ExternalJobID:      "req-123",
		ExternalAudienceID: "999",
		ProviderMessage:    "accepted",
	})
	if err != nil {
		t.Fatalf("RetrieveDiagnostics: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/requestStatus:retrieve" || gotRequestID != "req-123" {
		t.Fatalf("request = %s %s requestId=%q", gotMethod, gotPath, gotRequestID)
	}
	if gotAuth != "Bearer access-token" {
		t.Fatalf("Authorization = %q, want Bearer access-token", gotAuth)
	}
	if res.ExternalJobID != "req-123" || res.ExternalAudienceID != "999" || res.ProviderStatus != "SUCCESS" {
		t.Fatalf("diagnostics result = %#v", res)
	}
	statuses, _ := res.ProviderResponse["requestStatusPerDestination"].([]any)
	if len(statuses) != 1 {
		t.Fatalf("provider response not preserved: %#v", res.ProviderResponse)
	}
}

func TestGoogleAdsAdapterRetrievesMultipleDataManagerRequestStatuses(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{"access_token": "access-token", "customer_match_transport": "data_manager"}
	gotRequestIDs := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.URL.Query().Get("requestId")
		gotRequestIDs = append(gotRequestIDs, requestID)
		w.WriteHeader(http.StatusOK)
		switch requestID {
		case "req-success":
			_, _ = w.Write([]byte(`{"requestStatusPerDestination":[{"destinationReference":"dest-1","requestStatus":"SUCCESS"}]}`))
		case "req-failed":
			_, _ = w.Write([]byte(`{"requestStatusPerDestination":[{"destinationReference":"dest-1","requestStatus":"FAILED"}]}`))
		default:
			t.Fatalf("unexpected requestId %q", requestID)
		}
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["data_manager_api_base"] = srv.URL

	evidenceID := googleDataManagerEncodeRequestIDs([]string{"req-success", "req-failed"})
	res, err := a.RetrieveDiagnostics(context.Background(), cfg, ProviderRunEvidence{
		ExternalJobID:      evidenceID,
		ExternalAudienceID: "999",
		ProviderMessage:    "accepted",
	})
	if err != nil {
		t.Fatalf("RetrieveDiagnostics: %v", err)
	}
	if fmt.Sprint(gotRequestIDs) != "[req-success req-failed]" {
		t.Fatalf("request IDs = %v", gotRequestIDs)
	}
	if res.ExternalJobID != evidenceID || res.ProviderStatus != "PARTIAL_SUCCESS" {
		t.Fatalf("diagnostics result = %#v", res)
	}
	requests, _ := res.ProviderResponse["requests"].([]any)
	if len(requests) != 2 {
		t.Fatalf("aggregate response = %#v", res.ProviderResponse)
	}
}

func TestGoogleAdsAdapterRejectsDiagnosticsForLegacyTransport(t *testing.T) {
	a := &GoogleAdsAdapter{}
	_, err := a.RetrieveDiagnostics(context.Background(), map[string]any{
		"access_token":             "access-token",
		"customer_match_transport": "offline_user_data_job",
	}, ProviderRunEvidence{
		ExternalJobID:      "customers/123/offlineUserDataJobs/42",
		ExternalAudienceID: "999",
	})
	if err == nil || !errors.Is(err, ErrAdapterNotConfigured) || !strings.Contains(err.Error(), "data_manager") {
		t.Fatalf("err=%v", err)
	}
}

func TestGoogleDataManagerProviderStatusRollsUpPerDestination(t *testing.T) {
	resp := map[string]any{
		"requestStatusPerDestination": []any{
			map[string]any{"destinationReference": "dest-1", "requestStatus": "SUCCESS"},
			map[string]any{"destinationReference": "dest-2", "requestStatus": "FAILED"},
		},
	}
	if got := googleDataManagerProviderStatus(resp); got != "PARTIAL_SUCCESS" {
		t.Fatalf("rollup = %q, want PARTIAL_SUCCESS", got)
	}

	resp = map[string]any{
		"requestStatusPerDestination": []any{
			map[string]any{"destinationReference": "dest-1", "requestStatus": "SUCCESS"},
			map[string]any{"destinationReference": "dest-2", "requestStatus": "PROCESSING"},
		},
	}
	if got := googleDataManagerProviderStatus(resp); got != "PROCESSING" {
		t.Fatalf("rollup = %q, want PROCESSING", got)
	}
}

func TestGoogleAdsAdapterRequiresOfflineUserDataJob(t *testing.T) {
	a := &GoogleAdsAdapter{}
	st := a.Readiness(map[string]any{
		"access_token":               "access-token",
		"customer_match_transport":   "offline_user_data_job",
		"developer_token":            "dev-token",
		"customer_id":                "123-456-7890",
		"user_list_id":               "999",
		"ad_user_data_consent":       "granted",
		"ad_personalization_consent": "granted",
	})
	if st.Ready {
		t.Fatalf("expected missing offline_user_data_job, got %#v", st)
	}
	if !strings.Contains(strings.Join(st.Missing, ","), "GOOGLE_ADS_OFFLINE_USER_DATA_JOB") {
		t.Fatalf("missing list = %#v", st.Missing)
	}
	if !strings.Contains(st.Detail, "Data Manager API") {
		t.Fatalf("detail should mention Data Manager API transition: %q", st.Detail)
	}
}

func TestGoogleAdsAdapterRequiresCompleteJobWorker(t *testing.T) {
	a := &GoogleAdsAdapter{}
	st := a.Readiness(map[string]any{
		"access_token":               "access-token",
		"developer_token":            "dev-token",
		"customer_id":                "123-456-7890",
		"user_list_id":               "999",
		"offline_user_data_job":      "customers/1234567890/offlineUserDataJobs/42",
		"ad_user_data_consent":       "granted",
		"ad_personalization_consent": "granted",
	})
	if st.Ready || st.Status != "driver_unattached" {
		t.Fatalf("expected driver_unattached without complete job worker, got %#v", st)
	}
}

func TestGoogleAdsAdapterDefaultsToDataManagerTransport(t *testing.T) {
	a := &GoogleAdsAdapter{}
	cfg := map[string]any{
		"access_token":                  "access-token",
		"customer_id":                   "123-456-7890",
		"customer_match_terms_accepted": true,
		"user_list_id":                  "999",
		"ad_user_data_consent":          "granted",
		"ad_personalization_consent":    "granted",
	}
	if got := googleAdsCustomerMatchTransport(cfg); got != googleAdsTransportDataMgr {
		t.Fatalf("transport = %q, want %q", got, googleAdsTransportDataMgr)
	}
	if st := a.Readiness(cfg); !st.Ready || st.Status != "configured" {
		t.Fatalf("default Data Manager readiness = %#v", st)
	}
}

func TestGoogleAdsDataManagerRequiresTermsAcknowledgement(t *testing.T) {
	a := &GoogleAdsAdapter{}
	st := a.Readiness(map[string]any{
		"access_token":               "access-token",
		"customer_id":                "123-456-7890",
		"user_list_id":               "999",
		"ad_user_data_consent":       "granted",
		"ad_personalization_consent": "granted",
	})
	if st.Ready || st.Status != "terms_acknowledgement_required" {
		t.Fatalf("expected terms_acknowledgement_required, got %#v", st)
	}
	if !strings.Contains(strings.Join(st.Missing, ","), "GOOGLE_ADS_CUSTOMER_MATCH_TERMS_ACCEPTED") {
		t.Fatalf("missing list = %#v", st.Missing)
	}
}

func TestSnapAdapterUsesNestedCustomerListRows(t *testing.T) {
	a := &SnapAdapter{}
	cfg := map[string]any{
		"access_token":  "token",
		"ad_account_id": "acc",
		"segment_id":    "seg",
	}
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/segments/seg/users" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"request_id":"snap-req-1"}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}, {Email: "b@example.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != 2 || res.BatchesSent != 1 || res.ExternalJobID != "snap-req-1" || res.ExternalAudienceID != "seg" {
		t.Fatalf("result = %#v", res)
	}
	users, _ := gotBody["users"].([]any)
	first, _ := users[0].(map[string]any)
	data, _ := first["data"].([]any)
	if len(data) != 2 {
		t.Fatalf("snap data = %+v", first["data"])
	}
	row, ok := data[0].([]any)
	if !ok || len(row) != 1 {
		t.Fatalf("snap data rows must be nested one-value arrays: %+v", data[0])
	}
}

func TestSnapAdapterChunksOversizedRequest(t *testing.T) {
	a := &SnapAdapter{}
	cfg := map[string]any{
		"access_token":  "token",
		"ad_account_id": "acc",
		"segment_id":    "seg",
	}
	members := make([]MemberRow, snapSegmentUsersMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("snap-%d@example.com", i)}
	}
	var sizes []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		users, _ := body["users"].([]any)
		first, _ := users[0].(map[string]any)
		data, _ := first["data"].([]any)
		sizes = append(sizes, len(data))
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"request_id":"snap-req-%d"}`, len(sizes))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, members)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != len(members) || res.BatchesSent != 2 || res.ExternalAudienceID != "seg" {
		t.Fatalf("result = %#v", res)
	}
	if res.ExternalJobID != "snap-req-1,snap-req-2" {
		t.Fatalf("external job id = %q", res.ExternalJobID)
	}
	if fmt.Sprint(sizes) != fmt.Sprintf("[%d 1]", snapSegmentUsersMaxMembers) {
		t.Fatalf("chunk sizes = %v", sizes)
	}
	if !strings.Contains(res.Message, "across 2 request") {
		t.Fatalf("message = %q", res.Message)
	}
}

func TestSnapAdapterRetriesTransientChunkFailure(t *testing.T) {
	a := &SnapAdapter{}
	cfg := map[string]any{
		"access_token":  "token",
		"ad_account_id": "acc",
		"segment_id":    "seg",
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "0")
			http.Error(w, `{"message":"rate limited"}`, http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"request_id":"snap-req-1"}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want retry once", calls)
	}
	if res.MembersSent != 1 || res.ExternalJobID != "snap-req-1" {
		t.Fatalf("result = %#v", res)
	}
}

func TestSnapAdapterPartialChunkFailureKeepsSentEvidence(t *testing.T) {
	a := &SnapAdapter{}
	cfg := map[string]any{
		"access_token":  "token",
		"ad_account_id": "acc",
		"segment_id":    "seg",
	}
	members := make([]MemberRow, snapSegmentUsersMaxMembers+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("partial-snap-%d@example.com", i)}
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls >= 2 {
			http.Error(w, `{"message":"rate limited"}`, http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"request_id":"snap-req-1"}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, members)
	if err == nil || !strings.Contains(err.Error(), "429") {
		t.Fatalf("want provider error, got result=%#v err=%v", res, err)
	}
	if res.MembersSent != snapSegmentUsersMaxMembers || res.BatchesSent != 1 {
		t.Fatalf("partial result = %#v", res)
	}
	if res.ExternalJobID != "snap-req-1" || res.ExternalAudienceID != "seg" {
		t.Fatalf("partial evidence = %#v", res)
	}
	if !strings.Contains(res.Message, "1/2") {
		t.Fatalf("message = %q", res.Message)
	}
}

func TestSnapAdapterRemoveAndReplaceActionsUseDocumentedEndpoints(t *testing.T) {
	for _, tc := range []struct {
		name      string
		action    string
		wantCalls []string
	}{
		{name: "remove", action: "REMOVE", wantCalls: []string{"DELETE /segments/seg/users"}},
		{name: "replace", action: "REPLACE", wantCalls: []string{"DELETE /segments/seg/all_users", "POST /segments/seg/users"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &SnapAdapter{}
			cfg := map[string]any{
				"access_token":  "token",
				"ad_account_id": "acc",
				"segment_id":    "seg",
				"action":        tc.action,
			}
			var calls []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.Method+" "+r.URL.Path)
				if r.URL.Path == "/segments/seg/users" {
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatalf("decode body: %v", err)
					}
					users, _ := body["users"].([]any)
					if len(users) != 1 {
						t.Fatalf("users payload = %#v", body["users"])
					}
				}
				w.WriteHeader(http.StatusOK)
				_, _ = fmt.Fprintf(w, `{"request_id":"snap-req-%d"}`, len(calls))
			}))
			defer srv.Close()
			a.HTTPClient = srv.Client()
			cfg["api_base"] = srv.URL

			res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}})
			if err != nil {
				t.Fatalf("sync: %v", err)
			}
			if fmt.Sprint(calls) != fmt.Sprint(tc.wantCalls) {
				t.Fatalf("calls = %v, want %v", calls, tc.wantCalls)
			}
			if res.MembersSent != 1 || res.ExternalAudienceID != "seg" {
				t.Fatalf("result = %#v", res)
			}
		})
	}
}

func TestSnapAdapterRetrievesSegmentDiagnostics(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"request_status": "SUCCESS",
			"request_id": "snap-diag-req",
			"segments": [{
				"sub_request_status": "SUCCESS",
				"segment": {
					"id": "seg",
					"status": "ACTIVE",
					"targetable_status": "READY",
					"upload_status": "COMPLETE",
					"approximate_number_users": 42
				}
			}]
		}`))
	}))
	defer srv.Close()
	a := &SnapAdapter{HTTPClient: srv.Client()}
	res, err := a.RetrieveDiagnostics(context.Background(), map[string]any{
		"access_token": "token",
		"segment_id":   "seg",
		"api_base":     srv.URL,
	}, ProviderRunEvidence{
		ExternalJobID:      "snap-req",
		ExternalAudienceID: "seg",
		ProviderMessage:    "accepted",
	})
	if err != nil {
		t.Fatalf("RetrieveDiagnostics: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/segments/seg" || gotAuth != "Bearer token" {
		t.Fatalf("request = %s %s auth=%q", gotMethod, gotPath, gotAuth)
	}
	if res.ExternalJobID != "snap-req" || res.ExternalAudienceID != "seg" || res.ProviderStatus != "SUCCESS" {
		t.Fatalf("diagnostics result = %#v", res)
	}
	segments, _ := res.ProviderResponse["segments"].([]any)
	if len(segments) != 1 {
		t.Fatalf("provider response not preserved: %#v", res.ProviderResponse)
	}
}

func TestLinkedInReadinessRequiresAudienceProgramApproval(t *testing.T) {
	a := &LinkedInAdapter{}
	cfg := map[string]any{
		"access_token": "token",
		"account_id":   "urn:li:sponsoredAccount:123",
		"segment_id":   "456",
	}
	st := a.Readiness(cfg)
	if st.Ready || st.Status != "access_review_required" {
		t.Fatalf("expected access review requirement, got %#v", st)
	}
	cfg["audiences_program_approved"] = true
	if st = a.Readiness(cfg); !st.Ready {
		t.Fatalf("expected LinkedIn readiness after approval flag, got %#v", st)
	}
}

func TestLinkedInAdapterChunksOversizedBatch(t *testing.T) {
	a := &LinkedInAdapter{}
	cfg := map[string]any{
		"access_token":               "token",
		"account_id":                 "urn:li:sponsoredAccount:123",
		"segment_id":                 "456",
		"audiences_program_approved": true,
	}
	members := make([]MemberRow, linkedInSegmentUsersMaxBatch+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("person-%d@example.com", i)}
	}
	var sizes []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dmpSegments/456/users" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("X-RestLi-Method"); got != "BATCH_CREATE" {
			t.Fatalf("X-RestLi-Method = %q", got)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		elements, _ := body["elements"].([]any)
		sizes = append(sizes, len(elements))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, members)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != len(members) || res.BatchesSent != 2 || res.ExternalAudienceID != "456" {
		t.Fatalf("result = %#v", res)
	}
	if res.ExternalJobID != "dmpSegment:456" {
		t.Fatalf("external job evidence = %q", res.ExternalJobID)
	}
	if fmt.Sprint(sizes) != fmt.Sprintf("[%d 1]", linkedInSegmentUsersMaxBatch) {
		t.Fatalf("chunk sizes = %v", sizes)
	}
	if !strings.Contains(res.Message, "across 2 request") {
		t.Fatalf("message = %q", res.Message)
	}
}

func TestLinkedInAdapterRetriesTransientBatchFailure(t *testing.T) {
	a := &LinkedInAdapter{}
	cfg := map[string]any{
		"access_token":               "token",
		"account_id":                 "urn:li:sponsoredAccount:123",
		"segment_id":                 "456",
		"audiences_program_approved": true,
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "0")
			http.Error(w, `{"message":"rate limited"}`, http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"elements":[{"status":201}]}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want retry once", calls)
	}
	if res.MembersSent != 1 || res.ExternalJobID != "dmpSegment:456" {
		t.Fatalf("result = %#v", res)
	}
}

func TestLinkedInAdapterPreservesPartialChunkEvidence(t *testing.T) {
	a := &LinkedInAdapter{}
	cfg := map[string]any{
		"access_token":               "token",
		"account_id":                 "urn:li:sponsoredAccount:123",
		"segment_id":                 "456",
		"audiences_program_approved": true,
	}
	members := make([]MemberRow, linkedInSegmentUsersMaxBatch+1)
	for i := range members {
		members[i] = MemberRow{Email: fmt.Sprintf("person-%d@example.com", i)}
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls >= 2 {
			http.Error(w, `{"message":"rate limited"}`, http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, members)
	if err == nil {
		t.Fatal("expected provider error")
	}
	if res.MembersSent != linkedInSegmentUsersMaxBatch || res.BatchesSent != 1 {
		t.Fatalf("partial result = %#v", res)
	}
	if res.ExternalJobID != "dmpSegment:456" || res.ExternalAudienceID != "456" {
		t.Fatalf("partial evidence = %#v", res)
	}
	if !strings.Contains(res.Message, "1/2") {
		t.Fatalf("message = %q", res.Message)
	}
}

func TestLinkedInAdapterRemoveActionUsesBatchRemove(t *testing.T) {
	a := &LinkedInAdapter{}
	cfg := map[string]any{
		"access_token":               "token",
		"account_id":                 "urn:li:sponsoredAccount:123",
		"segment_id":                 "456",
		"audiences_program_approved": true,
		"action":                     "REMOVE",
	}
	var gotAction string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dmpSegments/456/users" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		elements, _ := body["elements"].([]any)
		first, _ := elements[0].(map[string]any)
		gotAction, _ = first["action"].(string)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"elements":[{"status":201}]}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if gotAction != "REMOVE" {
		t.Fatalf("action = %q", gotAction)
	}
	if res.MembersSent != 1 || !strings.Contains(res.Message, "Removed") {
		t.Fatalf("result = %#v", res)
	}
}

func TestLinkedInAdapterTreatsBatchElementFailureAsProviderError(t *testing.T) {
	a := &LinkedInAdapter{}
	cfg := map[string]any{
		"access_token":               "token",
		"account_id":                 "urn:li:sponsoredAccount:123",
		"segment_id":                 "456",
		"audiences_program_approved": true,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"elements":[{"error":{"status":400,"message":"bad id"},"status":400}]}`))
	}))
	defer srv.Close()
	a.HTTPClient = srv.Client()
	cfg["api_base"] = srv.URL

	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}})
	if err == nil || !strings.Contains(err.Error(), "batch response") {
		t.Fatalf("want batch response error, got result=%#v err=%v", res, err)
	}
	if res.MembersSent != 0 || res.ExternalJobID != "" {
		t.Fatalf("result = %#v", res)
	}
}

func TestLinkedInAdapterRetrievesSegmentDiagnostics(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotVersion = r.Header.Get("LinkedIn-Version")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"id": 456,
			"type": "USER",
			"account": "urn:li:sponsoredAccount:123",
			"destinations": [{
				"destinationSegmentId": "urn:li:adSegment:999",
				"status": "READY"
			}]
		}`))
	}))
	defer srv.Close()
	a := &LinkedInAdapter{HTTPClient: srv.Client()}
	res, err := a.RetrieveDiagnostics(context.Background(), map[string]any{
		"access_token":     "token",
		"segment_id":       "456",
		"api_base":         srv.URL,
		"linkedin_version": "202607",
	}, ProviderRunEvidence{
		ExternalJobID:      "dmpSegment:456",
		ExternalAudienceID: "456",
		ProviderMessage:    "accepted",
	})
	if err != nil {
		t.Fatalf("RetrieveDiagnostics: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/dmpSegments/456" || gotAuth != "Bearer token" || gotVersion != "202607" {
		t.Fatalf("request = %s %s auth=%q version=%q", gotMethod, gotPath, gotAuth, gotVersion)
	}
	if res.ExternalJobID != "dmpSegment:456" || res.ExternalAudienceID != "456" || res.ProviderStatus != "SUCCESS" {
		t.Fatalf("diagnostics result = %#v", res)
	}
	destinations, _ := res.ProviderResponse["destinations"].([]any)
	if len(destinations) != 1 {
		t.Fatalf("provider response not preserved: %#v", res.ProviderResponse)
	}
}

func TestTikTokCredentialReferenceHydratesBeforeUploadFlow(t *testing.T) {
	a := &TikTokAdapter{}
	cfg := map[string]any{
		"credentials_ref": "vault://ads/tiktok",
		"advertiser_id":   "adv",
		"audience_id":     "aud",
	}
	st := a.Readiness(cfg)
	if st.Ready || st.Status != "credential_resolution_required" {
		t.Fatalf("expected credential resolver gate before token hydration, got %#v", st)
	}
	cfg["access_token"] = "resolved-token"
	st = a.Readiness(cfg)
	if !st.Ready || st.Status != "configured" {
		t.Fatalf("expected TikTok configured after resolved credentials, got %#v", st)
	}
}

func TestTikTokAdapterUploadsCustomerFileAndUpdatesAudience(t *testing.T) {
	var calls []string
	var uploadAuth, updateAuth, gotCalculate, gotSignature, gotFile string
	var gotUpdate map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		switch r.URL.Path {
		case "/dmp/custom_audience/file/upload/":
			uploadAuth = r.Header.Get("Access-Token")
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data;") {
				t.Fatalf("upload content-type = %q", r.Header.Get("Content-Type"))
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatalf("ParseMultipartForm: %v", err)
			}
			gotCalculate = r.FormValue("calculate_type")
			gotSignature = r.FormValue("file_signature")
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Fatalf("file part: %v", err)
			}
			defer func() { _ = file.Close() }()
			raw, _ := io.ReadAll(file)
			gotFile = string(raw)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"code":0,"request_id":"upload-req","data":{"file_path":"tmp/postwave.txt"}}`))
		case "/dmp/custom_audience/update/":
			updateAuth = r.Header.Get("Access-Token")
			if err := json.NewDecoder(r.Body).Decode(&gotUpdate); err != nil {
				t.Fatalf("decode update: %v", err)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"code":0,"request_id":"update-req","data":{}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	a := &TikTokAdapter{HTTPClient: srv.Client()}
	cfg := map[string]any{
		"access_token":  "token",
		"advertiser_id": "adv",
		"audience_id":   "aud",
		"api_base":      srv.URL,
	}
	st := a.Readiness(cfg)
	if !st.Ready || st.Status != "configured" {
		t.Fatalf("expected TikTok configured, got %#v", st)
	}
	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}, {Email: "b@example.com"}})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if strings.Join(calls, ",") != "/dmp/custom_audience/file/upload/,/dmp/custom_audience/update/" {
		t.Fatalf("calls = %v", calls)
	}
	if uploadAuth != "token" || updateAuth != "token" {
		t.Fatalf("Access-Token headers = upload %q update %q", uploadAuth, updateAuth)
	}
	if gotCalculate != "FIRST_SHA256" {
		t.Fatalf("calculate_type = %q", gotCalculate)
	}
	if gotSignature == "" || len(gotSignature) != 32 {
		t.Fatalf("file_signature = %q", gotSignature)
	}
	if lines := strings.Split(strings.TrimSpace(gotFile), "\n"); len(lines) != 2 || len(lines[0]) != 64 {
		t.Fatalf("uploaded file should contain SHA-256 rows, got %q", gotFile)
	}
	if gotUpdate["advertiser_id"] != "adv" || gotUpdate["custom_audience_id"] != "aud" || gotUpdate["action"] != "APPEND" {
		t.Fatalf("update body = %#v", gotUpdate)
	}
	paths, _ := gotUpdate["file_paths"].([]any)
	if len(paths) != 1 || paths[0] != "tmp/postwave.txt" {
		t.Fatalf("file_paths = %#v", gotUpdate["file_paths"])
	}
	if res.MembersSent != 2 || res.ExternalAudienceID != "aud" || res.ExternalJobID != "update-req" {
		t.Fatalf("result = %#v", res)
	}
}

func TestTikTokAdapterCreatesAudienceWhenNoAudienceID(t *testing.T) {
	var gotCreate map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dmp/custom_audience/file/upload/":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"code":0,"request_id":"upload-req","data":{"file_path":"tmp/new.txt"}}`))
		case "/dmp/custom_audience/create/":
			if err := json.NewDecoder(r.Body).Decode(&gotCreate); err != nil {
				t.Fatalf("decode create: %v", err)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"code":0,"request_id":"create-req","data":{"custom_audience_id":"new-aud"}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	a := &TikTokAdapter{HTTPClient: srv.Client()}
	cfg := map[string]any{
		"access_token":         "token",
		"advertiser_id":        "adv",
		"custom_audience_name": "Moosewave audience",
		"retention_in_days":    "30",
		"api_base":             srv.URL,
		"action":               "REPLACE", // ignored by create.
	}
	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if gotCreate["custom_audience_name"] != "Moosewave audience" || gotCreate["calculate_type"] != "FIRST_SHA256" {
		t.Fatalf("create body = %#v", gotCreate)
	}
	if gotCreate["retention_in_days"] != float64(30) {
		t.Fatalf("retention_in_days should be sent as a JSON number, got %#v", gotCreate["retention_in_days"])
	}
	paths, _ := gotCreate["file_paths"].([]any)
	if len(paths) != 1 || paths[0] != "tmp/new.txt" {
		t.Fatalf("file_paths = %#v", gotCreate["file_paths"])
	}
	if res.ExternalAudienceID != "new-aud" || res.ExternalJobID != "create-req" || res.MembersSent != 1 {
		t.Fatalf("result = %#v", res)
	}
}

func TestTikTokAdapterRetriesTransientUploadAndUpdatesAudience(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dmp/custom_audience/file/upload/":
			calls++
			if calls == 1 {
				w.Header().Set("Retry-After", "0")
				http.Error(w, `{"message":"rate limited"}`, http.StatusTooManyRequests)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"code":0,"request_id":"upload-req","data":{"file_path":"tmp/postwave.txt"}}`))
		case "/dmp/custom_audience/update/":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"code":0,"request_id":"update-req","data":{}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	a := &TikTokAdapter{HTTPClient: srv.Client()}
	cfg := map[string]any{
		"access_token":  "token",
		"advertiser_id": "adv",
		"audience_id":   "aud",
		"api_base":      srv.URL,
	}
	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@example.com"}})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if calls != 2 {
		t.Fatalf("upload calls = %d, want retry once", calls)
	}
	if res.ExternalJobID != "update-req" || res.MembersSent != 1 {
		t.Fatalf("result = %#v", res)
	}
}

func TestTikTokAdapterRetrievesCustomAudienceDiagnostics(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotAdvertiser string
	var gotAudienceIDs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Access-Token")
		gotAdvertiser = r.URL.Query().Get("advertiser_id")
		gotAudienceIDs = r.URL.Query()["custom_audience_ids"]
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"code": 0,
			"request_id": "diag-req",
			"data": {
				"custom_audience": [{
					"custom_audience_id": "aud",
					"operation_status": "READY",
					"audience_size": 42
				}]
			}
		}`))
	}))
	defer srv.Close()
	a := &TikTokAdapter{HTTPClient: srv.Client()}
	res, err := a.RetrieveDiagnostics(context.Background(), map[string]any{
		"access_token":  "token",
		"advertiser_id": "adv",
		"audience_id":   "aud",
		"api_base":      srv.URL,
	}, ProviderRunEvidence{
		ExternalJobID:      "update-req",
		ExternalAudienceID: "aud",
		ProviderMessage:    "accepted",
	})
	if err != nil {
		t.Fatalf("RetrieveDiagnostics: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/dmp/custom_audience/get/" {
		t.Fatalf("request = %s %s", gotMethod, gotPath)
	}
	if gotAuth != "token" || gotAdvertiser != "adv" || len(gotAudienceIDs) != 1 || gotAudienceIDs[0] != "aud" {
		t.Fatalf("headers/query auth=%q advertiser=%q audience_ids=%v", gotAuth, gotAdvertiser, gotAudienceIDs)
	}
	if res.ExternalJobID != "update-req" || res.ExternalAudienceID != "aud" || res.ProviderStatus != "SUCCESS" {
		t.Fatalf("diagnostics result = %#v", res)
	}
	data, _ := res.ProviderResponse["data"].(map[string]any)
	if len(data) == 0 {
		t.Fatalf("provider response not preserved: %#v", res.ProviderResponse)
	}
}

func TestTikTokAdapterDiagnosticsRequiresAudienceID(t *testing.T) {
	a := &TikTokAdapter{}
	_, err := a.RetrieveDiagnostics(context.Background(), map[string]any{
		"access_token":  "token",
		"advertiser_id": "adv",
	}, ProviderRunEvidence{ExternalJobID: "req-123"})
	if err == nil || !errors.Is(err, ErrAdapterNotConfigured) || !strings.Contains(err.Error(), "custom audience id") {
		t.Fatalf("err=%v", err)
	}
}

// TestMetaAdapterSyncSurfacesHTTPError pins that a non-2xx from the
// platform becomes a real Go error (NOT a silent success).
func TestMetaAdapterSyncSurfacesHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"bad token"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	a := &MetaAdapter{HTTPClient: srv.Client()}
	cfg := map[string]any{"access_token": "bad", "audience_id": "9", "api_base": srv.URL}
	_, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: "a@x.com"}})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want HTTP 401 error, got %v", err)
	}
}

// TestAdapterSyncNoDeliverableMembers pins that an adapter with credentials
// but zero deliverable members (all consent-filtered) does NOT fire a
// request and reports 0 sent.
func TestAdapterSyncNoDeliverableMembers(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	a := &SnapAdapter{HTTPClient: srv.Client()}
	cfg := map[string]any{
		"access_token": "t", "ad_account_id": "acc", "segment_id": "seg", "api_base": srv.URL,
	}
	res, err := a.Sync(context.Background(), cfg, []MemberRow{{Email: ""}, {Email: "   "}})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.MembersSent != 0 {
		t.Errorf("members sent = %d, want 0", res.MembersSent)
	}
	if called {
		t.Error("adapter POSTed with no deliverable members")
	}
}

func TestAdapterSyncWithoutConfigErrors(t *testing.T) {
	a := &GoogleAdsAdapter{}
	_, err := a.Sync(context.Background(), map[string]any{}, []MemberRow{{Email: "a@x.com"}})
	if !errors.Is(err, ErrAdapterNotConfigured) {
		t.Fatalf("err = %v want ErrAdapterNotConfigured", err)
	}
}

func TestMissingConfigSorted(t *testing.T) {
	got := missingConfig(map[string]any{}, map[string]string{
		"Z_KEY": "z",
		"A_KEY": "a",
		"M_KEY": "m",
	})
	if strings.Join(got, ",") != "A_KEY,M_KEY,Z_KEY" {
		t.Fatalf("missingConfig not sorted: %v", got)
	}
}
