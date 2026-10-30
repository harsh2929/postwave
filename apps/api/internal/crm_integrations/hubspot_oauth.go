// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const (
	hubSpotDefaultOAuthBaseURL  = "https://api.hubapi.com"
	hubSpotDefaultAuthorizeURL  = "https://app.hubspot.com/oauth/authorize"
	hubSpotOAuthTokenPath       = "/oauth/v1/token"
	hubSpotOAuthTokenInfoPath   = "/oauth/v1/access-tokens/"
	hubSpotOAuthRevokeTokenPath = "/oauth/v1/refresh-tokens/"
)

// HubSpotOAuthConfig is the public-app install configuration, sourced from env.
type HubSpotOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	OAuthBaseURL    string
	AuthorizeURL    string
	SuccessRedirect string
	Scopes          []string
	AppID           string
	DeveloperAPIKey string
}

// HubSpotOAuthToken is the parsed token endpoint response.
type HubSpotOAuthToken struct {
	AccessToken  string
	RefreshToken string
	TokenType    string
	ExpiresIn    int
	ExpiresAt    time.Time
	Scope        string
}

// HubSpotAccessTokenInfo is the parsed access-token-info response; PortalID is
// HubSpot's hub_id, used to route inbound app-level webhooks to the right tenant.
type HubSpotAccessTokenInfo struct {
	PortalID  string
	AppID     string
	UserID    string
	HubDomain string
	Scopes    []string
	ExpiresIn int
}

// HubSpotOAuthClient performs the HubSpot OAuth token, info, and revoke calls.
// Unlike Pipedrive, HubSpot expects client_id/client_secret in the form body
// rather than HTTP Basic auth.
type HubSpotOAuthClient struct {
	HTTPClient   *http.Client
	OAuthBaseURL string
	UserAgent    string
	Now          func() time.Time
}

func (c HubSpotOAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds HubSpotCredentials, code, redirectURI string) (HubSpotOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	return c.doToken(ctx, creds, form)
}

func (c HubSpotOAuthClient) RefreshAccessToken(ctx context.Context, creds HubSpotCredentials) (HubSpotOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	return c.doToken(ctx, creds, form)
}

func (c HubSpotOAuthClient) doToken(ctx context.Context, creds HubSpotCredentials, form url.Values) (HubSpotOAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return HubSpotOAuthToken{}, fmt.Errorf("hubspot OAuth client_id and client_secret are required")
	}
	if form.Get("grant_type") == "authorization_code" && strings.TrimSpace(form.Get("code")) == "" {
		return HubSpotOAuthToken{}, fmt.Errorf("hubspot OAuth authorization code is required")
	}
	if form.Get("grant_type") == "refresh_token" && strings.TrimSpace(form.Get("refresh_token")) == "" {
		return HubSpotOAuthToken{}, fmt.Errorf("hubspot OAuth refresh_token is required")
	}
	form.Set("client_id", strings.TrimSpace(creds.ClientID))
	form.Set("client_secret", strings.TrimSpace(creds.ClientSecret))

	baseURL := strings.TrimRight(firstString(c.OAuthBaseURL, creds.OAuthBaseURL, hubSpotDefaultOAuthBaseURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+hubSpotOAuthTokenPath, strings.NewReader(form.Encode()))
	if err != nil {
		return HubSpotOAuthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, hubSpotDefaultUserAgent))

	body, status, err := c.do(req)
	if err != nil {
		return HubSpotOAuthToken{}, err
	}
	if status < 200 || status >= 300 {
		return HubSpotOAuthToken{}, fmt.Errorf("hubspot OAuth token request failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return HubSpotOAuthToken{}, fmt.Errorf("decode hubspot OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return HubSpotOAuthToken{}, fmt.Errorf("hubspot OAuth token response missing access_token")
	}
	now := c.now()
	expiresAt := now
	if raw.ExpiresIn > 0 {
		expiresAt = now.Add(time.Duration(raw.ExpiresIn) * time.Second)
	}
	return HubSpotOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		TokenType:    firstString(raw.TokenType, "bearer"),
		ExpiresIn:    raw.ExpiresIn,
		ExpiresAt:    expiresAt,
		Scope:        strings.TrimSpace(raw.Scope),
	}, nil
}

func (c HubSpotOAuthClient) AccessTokenInfo(ctx context.Context, creds HubSpotCredentials) (HubSpotAccessTokenInfo, error) {
	token := strings.TrimSpace(creds.AccessToken)
	if token == "" {
		return HubSpotAccessTokenInfo{}, fmt.Errorf("hubspot OAuth access_token is required")
	}
	baseURL := strings.TrimRight(firstString(c.OAuthBaseURL, creds.OAuthBaseURL, hubSpotDefaultOAuthBaseURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+hubSpotOAuthTokenInfoPath+url.PathEscape(token), nil)
	if err != nil {
		return HubSpotAccessTokenInfo{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, hubSpotDefaultUserAgent))

	body, status, err := c.do(req)
	if err != nil {
		return HubSpotAccessTokenInfo{}, err
	}
	if status < 200 || status >= 300 {
		return HubSpotAccessTokenInfo{}, fmt.Errorf("hubspot OAuth access-token-info failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		HubID     json.Number `json:"hub_id"`
		AppID     json.Number `json:"app_id"`
		UserID    json.Number `json:"user_id"`
		HubDomain string      `json:"hub_domain"`
		Scopes    []string    `json:"scopes"`
		ExpiresIn int         `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return HubSpotAccessTokenInfo{}, fmt.Errorf("decode hubspot access-token-info response: %w", err)
	}
	info := HubSpotAccessTokenInfo{
		PortalID:  strings.TrimSpace(raw.HubID.String()),
		AppID:     strings.TrimSpace(raw.AppID.String()),
		UserID:    strings.TrimSpace(raw.UserID.String()),
		HubDomain: strings.TrimSpace(raw.HubDomain),
		Scopes:    raw.Scopes,
		ExpiresIn: raw.ExpiresIn,
	}
	if info.PortalID == "" {
		return HubSpotAccessTokenInfo{}, fmt.Errorf("hubspot access-token-info response missing hub_id")
	}
	return info, nil
}

func (c HubSpotOAuthClient) RevokeRefreshToken(ctx context.Context, creds HubSpotCredentials) error {
	token := strings.TrimSpace(creds.RefreshToken)
	if token == "" {
		return fmt.Errorf("hubspot OAuth refresh_token is required")
	}
	baseURL := strings.TrimRight(firstString(c.OAuthBaseURL, creds.OAuthBaseURL, hubSpotDefaultOAuthBaseURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, baseURL+hubSpotOAuthRevokeTokenPath+url.PathEscape(token), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, hubSpotDefaultUserAgent))

	body, status, err := c.do(req)
	if err != nil {
		return err
	}
	// A 404 means the refresh token is already gone; treat it as revoked.
	if status == http.StatusNotFound {
		return nil
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("hubspot OAuth refresh-token revocation failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	return nil
}

func (c HubSpotOAuthClient) do(req *http.Request) ([]byte, int, error) {
	client := crmEgressClient(c.HTTPClient, ProviderHubSpot, 15*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, hubSpotResponseMaxBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func (c HubSpotOAuthClient) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

// hubSpotOAuthAuthorizeURL builds the HubSpot install authorize redirect.
func hubSpotOAuthAuthorizeURL(cfg HubSpotOAuthConfig, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", fmt.Errorf("hubspot OAuth client_id is not configured")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return "", fmt.Errorf("hubspot OAuth redirect_url is not configured")
	}
	base := firstString(strings.TrimSpace(cfg.AuthorizeURL), hubSpotDefaultAuthorizeURL)
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("parse hubspot authorize URL: %w", err)
	}
	query := url.Values{}
	query.Set("client_id", strings.TrimSpace(cfg.ClientID))
	query.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	query.Set("scope", strings.Join(cfg.Scopes, " "))
	query.Set("state", strings.TrimSpace(state))
	u.RawQuery = query.Encode()
	return u.String(), nil
}

// ParseHubSpotOAuthScopes splits a space/comma separated scope string.
func ParseHubSpotOAuthScopes(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ' ' || r == ',' || r == '\n' || r == '\t'
	})
	return uniqueCRMStrings(fields)
}

const hubSpotOAuthStateTTL = 10 * time.Minute

var hubSpotDefaultOAuthScopes = []string{
	"crm.objects.contacts.read",
	"crm.objects.deals.read",
	"crm.objects.companies.read",
	"crm.lists.read",
	"oauth",
}

// HubSpotOAuthState is a single-use install state row (crm_oauth_states).
type HubSpotOAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type HubSpotOAuthStateStore interface {
	CreateHubSpotOAuthState(context.Context, HubSpotOAuthState) (string, error)
	ConsumeHubSpotOAuthState(context.Context, string) (HubSpotOAuthState, error)
}

func randomHubSpotToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashHubSpotOAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func newHubSpotStoredCredentialRef() (string, error) {
	token, err := randomHubSpotToken(18)
	if err != nil {
		return "", err
	}
	return hubSpotStoredCredentialPrefix + token, nil
}

func (d *Deps) hubSpotOAuthConfig(r *http.Request) HubSpotOAuthConfig {
	cfg := d.HubSpotOAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.OAuthBaseURL = strings.TrimRight(strings.TrimSpace(firstString(cfg.OAuthBaseURL, hubSpotDefaultOAuthBaseURL)), "/")
	cfg.AuthorizeURL = strings.TrimSpace(firstString(cfg.AuthorizeURL, hubSpotDefaultAuthorizeURL))
	cfg.SuccessRedirect = pipedriveOAuthRedirectTarget("", cfg.SuccessRedirect)
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = append([]string(nil), hubSpotDefaultOAuthScopes...)
	} else {
		cfg.Scopes = uniqueCRMStrings(cfg.Scopes)
	}
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/crm/hubspot/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) hubSpotOAuthStateStore() HubSpotOAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(HubSpotOAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) hubSpotCredentialStore() HubSpotCredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.HubSpotCredentials.(*HubSpotSecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(HubSpotCredentialStore); ok {
		return store
	}
	return nil
}

func (d *Deps) hubSpotCredentialDeleter() HubSpotCredentialDeleter {
	if d == nil {
		return nil
	}
	if deleter, ok := d.Repo.(HubSpotCredentialDeleter); ok {
		return deleter
	}
	return nil
}

func hubSpotOAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{
		"api_base_url",
		"api_version",
		"page_size",
		"properties",
		"list_id",
		"sync_list_memberships",
		"membership_list_ids",
		"membership_page_size",
		"sync_deals",
		"deal_page_size",
		"deal_properties",
		"company_properties",
		"list_ids",
		"default_list_id",
		"default_tags",
		"portal_id",
	} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func (d *Deps) HubSpotOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.hubSpotOAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/crm/hubspot/oauth/start",
	})
}

func (d *Deps) HubSpotOAuthStart(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.hubSpotOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "HubSpot OAuth state store is not configured")
		return
	}
	cfg := d.hubSpotOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "hubspot_oauth_unconfigured", "HubSpot OAuth client ID, client secret, and redirect URL are required")
		return
	}
	settings := hubSpotOAuthSettingsFromRequest(r)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "HubSpot"
	}
	state, err := store.CreateHubSpotOAuthState(r.Context(), HubSpotOAuthState{
		TenantID:        tid,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      pipedriveOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		Scopes:          cfg.Scopes,
		Settings:        settings,
		ExpiresAt:       d.now().Add(hubSpotOAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	authorize, err := hubSpotOAuthAuthorizeURL(cfg, state)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) HubSpotOAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.hubSpotOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "HubSpot OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "HubSpot OAuth state is required")
		return
	}
	state, err := store.ConsumeHubSpotOAuthState(r.Context(), stateToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "HubSpot OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.hubSpotOAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{"ok": false, "error": providerError})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "HubSpot OAuth code is required")
		return
	}
	cfg := d.hubSpotOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "hubspot_oauth_unconfigured", "HubSpot OAuth client ID and client secret are required")
		return
	}
	client := d.HubSpotOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	baseCreds := HubSpotCredentials{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, OAuthBaseURL: cfg.OAuthBaseURL, UserAgent: hubSpotDefaultUserAgent}
	token, err := client.ExchangeAuthorizationCode(r.Context(), baseCreds, code, state.RedirectURI)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "hubspot_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.hubSpotCredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "HubSpot credential store is not configured")
		return
	}
	infoCreds := baseCreds
	infoCreds.AccessToken = token.AccessToken
	info, err := client.AccessTokenInfo(r.Context(), infoCreds)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "hubspot_token_info_failed", httperror.MessageInternal)
		return
	}
	if cfg.AppID != "" && info.AppID != cfg.AppID {
		httperror.Write(w, http.StatusBadGateway, "hubspot_app_mismatch", httperror.MessageInternal)
		return
	}
	expiresAt := token.ExpiresAt.UTC()
	creds := HubSpotCredentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		OAuthBaseURL:   cfg.OAuthBaseURL,
		Scope:          firstString(token.Scope, strings.Join(state.Scopes, " ")),
		PortalID:       info.PortalID,
		TokenExpiresAt: &expiresAt,
		UserAgent:      hubSpotDefaultUserAgent,
	}
	ref, err := newHubSpotStoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutHubSpotCredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings := copySettings(state.Settings)
	settings["credentials_ref"] = ref
	settings["portal_id"] = info.PortalID
	settings["hubspot_portal_id"] = info.PortalID
	if info.AppID != "" {
		settings["hubspot_app_id"] = info.AppID
	}
	if info.HubDomain != "" {
		settings["hubspot_hub_domain"] = info.HubDomain
	}
	settings["hubspot_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["hubspot_oauth_managed_by_postwave"] = true
	settings["hubspot_oauth_scopes"] = state.Scopes
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:               ProviderHubSpot,
		Name:                   state.IntegrationName,
		Status:                 "connected",
		Scopes:                 state.Scopes,
		CredentialsRef:         ref,
		Settings:               settings,
		TrustedRuntimeMetadata: true,
	})
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	integration, err := d.Repo.UpsertIntegration(r.Context(), state.TenantID, normalized)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	d.hubSpotOAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"portal_id":        info.PortalID,
		"token_expires_at": expiresAt,
	})
}

func (d *Deps) hubSpotOAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
	if redirectTo != "" {
		if u, err := url.Parse(redirectTo); err == nil {
			q := u.Query()
			for key, value := range body {
				switch typed := value.(type) {
				case string:
					q.Set(key, typed)
				case bool:
					if typed {
						q.Set(key, "true")
					} else {
						q.Set(key, "false")
					}
				}
			}
			if integration, ok := body["integration"].(*Integration); ok && integration != nil {
				q.Set("integration_id", integration.ID)
			}
			u.RawQuery = q.Encode()
			http.Redirect(w, r, u.String(), http.StatusFound)
			return
		}
	}
	writeJSON(w, status, body)
}
