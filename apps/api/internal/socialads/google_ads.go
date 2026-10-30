package socialads

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

var googleAdsDocs = []string{
	"https://developers.google.com/google-ads/api/docs/oauth/overview",
	"https://developers.google.com/google-ads/api/rest/auth",
}

type GoogleAdsConfig struct {
	APIBaseURL      string
	APIVersion      string
	DeveloperToken  string
	ClientID        string
	ClientSecret    string
	RefreshToken    string
	LoginCustomerID string
	CustomerID      string
	OAuthTokenURL   string
}

type GoogleAdsProvider struct {
	cfg    GoogleAdsConfig
	client *http.Client

	mu          sync.Mutex
	accessToken string
	expiresAt   time.Time
}

func GoogleAdsConfigFromConfig(cfg Config) GoogleAdsConfig {
	return GoogleAdsConfig{
		APIBaseURL:      cfg.GoogleAdsAPIBaseURL,
		APIVersion:      cfg.GoogleAdsAPIVersion,
		DeveloperToken:  cfg.GoogleAdsDeveloperToken,
		ClientID:        cfg.GoogleAdsClientID,
		ClientSecret:    cfg.GoogleAdsClientSecret,
		RefreshToken:    cfg.GoogleAdsRefreshToken,
		LoginCustomerID: cfg.GoogleAdsLoginCustomerID,
		CustomerID:      cfg.GoogleAdsCustomerID,
		OAuthTokenURL:   cfg.GoogleOAuthTokenURL,
	}
}

func NewGoogleAdsProvider(cfg GoogleAdsConfig, client *http.Client) *GoogleAdsProvider {
	if client == nil {
		client = http.DefaultClient
	}
	cfg.APIBaseURL = strings.TrimRight(trim(cfg.APIBaseURL), "/")
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = DefaultGoogleAdsAPIBase
	}
	if trim(cfg.APIVersion) == "" {
		cfg.APIVersion = DefaultGoogleAdsVersion
	}
	if trim(cfg.OAuthTokenURL) == "" {
		cfg.OAuthTokenURL = DefaultGoogleOAuthTokenURL
	}
	return &GoogleAdsProvider{cfg: cfg, client: client}
}

func (p *GoogleAdsProvider) Readiness() ProviderStatus {
	missing := missingFields(map[string]string{
		"GOOGLE_ADS_DEVELOPER_TOKEN": p.cfg.DeveloperToken,
		"GOOGLE_ADS_CLIENT_ID":       p.cfg.ClientID,
		"GOOGLE_ADS_CLIENT_SECRET":   p.cfg.ClientSecret,
		"GOOGLE_ADS_REFRESH_TOKEN":   p.cfg.RefreshToken,
	})
	if len(missing) > 0 {
		st := notConfiguredStatus("google_ads", missing, "Google Ads requires OAuth credentials plus a developer token before remarketing/ad sync can run.")
		st.Docs = googleAdsDocs
		st.Version = p.cfg.APIVersion
		return st
	}
	return configuredStatus("google_ads", "Google Ads OAuth and developer-token configuration is present; validation calls can list accessible customers.", p.cfg.APIVersion, googleAdsDocs)
}

func (p *GoogleAdsProvider) ValidateCredentials(ctx context.Context) (ProviderResult, error) {
	if len(p.Readiness().Missing) > 0 {
		return ProviderResult{Provider: "google_ads", Status: "requires_provider"}, fmt.Errorf("%w: missing %s", ErrNotConfigured, strings.Join(p.Readiness().Missing, ", "))
	}
	token, err := p.accessTokenFor(ctx)
	if err != nil {
		return ProviderResult{Provider: "google_ads", Status: "error"}, err
	}
	u := fmt.Sprintf("%s/%s/customers:listAccessibleCustomers", p.cfg.APIBaseURL, strings.Trim(p.cfg.APIVersion, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return ProviderResult{Provider: "google_ads", Status: "error"}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("developer-token", p.cfg.DeveloperToken)
	if strings.TrimSpace(p.cfg.LoginCustomerID) != "" {
		req.Header.Set("login-customer-id", customerIDNoHyphens(p.cfg.LoginCustomerID))
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return ProviderResult{Provider: "google_ads", Status: "error"}, err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := decodeProviderResponse(resp)
	if err != nil {
		return ProviderResult{Provider: "google_ads", Status: "error", Raw: payload}, err
	}
	rawNames, _ := payload["resourceNames"].([]any)
	count := len(rawNames)
	return ProviderResult{
		Provider: "google_ads",
		Status:   "credentials_validated",
		Message:  fmt.Sprintf("Google Ads credentials validated; %d accessible customer account(s) visible.", count),
		Raw:      payload,
	}, nil
}

func (p *GoogleAdsProvider) accessTokenFor(ctx context.Context) (string, error) {
	p.mu.Lock()
	if p.accessToken != "" && time.Now().Before(p.expiresAt.Add(-30*time.Second)) {
		token := p.accessToken
		p.mu.Unlock()
		return token, nil
	}
	p.mu.Unlock()

	values := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {p.cfg.ClientID},
		"client_secret": {p.cfg.ClientSecret},
		"refresh_token": {p.cfg.RefreshToken},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.cfg.OAuthTokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	payload := map[string]any{}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &payload)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", providerHTTPError(resp.StatusCode, payload, string(body))
	}
	token, _ := payload["access_token"].(string)
	if strings.TrimSpace(token) == "" {
		return "", fmt.Errorf("google oauth token response did not include access_token")
	}
	expiresIn := 3600.0
	if v, ok := payload["expires_in"].(float64); ok && v > 0 {
		expiresIn = v
	}
	p.mu.Lock()
	p.accessToken = token
	p.expiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second)
	p.mu.Unlock()
	return token, nil
}

func customerIDNoHyphens(v string) string {
	return strings.ReplaceAll(strings.TrimSpace(v), "-", "")
}
