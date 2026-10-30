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
	zohoDefaultAccountsURL     = "https://accounts.zoho.com"
	zohoOAuthTokenPath         = "/oauth/v2/token"
	zohoOAuthAuthorizePath     = "/oauth/v2/auth"
	zohoOAuthRevokePath        = "/oauth/v2/token/revoke"
	zohoOAuthStateTTL          = 10 * time.Minute
	zohoDefaultTokenTTL        = time.Hour
	zohoStoredCredentialPrefix = "crm:zoho:"
)

var zohoDefaultOAuthScopes = []string{"ZohoCRM.modules.ALL", "ZohoCRM.users.READ"}

// ZohoOAuthConfig is the Zoho self-client/connected-app install configuration.
type ZohoOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	AccountsURL     string
	SuccessRedirect string
	Scopes          []string
}

type ZohoOAuthToken struct {
	AccessToken  string
	RefreshToken string
	APIBaseURL   string
	TokenType    string
	Scope        string
	ExpiresAt    time.Time
}

type ZohoOAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type ZohoOAuthStateStore interface {
	CreateZohoOAuthState(context.Context, ZohoOAuthState) (string, error)
	ConsumeZohoOAuthState(context.Context, string) (ZohoOAuthState, error)
}

type ZohoCredentialStore interface {
	GetZohoCredentialSecret(context.Context, string, string) (string, error)
	PutZohoCredentialSecret(context.Context, string, string, ZohoCredentials) error
}

type ZohoCredentialDeleter interface {
	DeleteZohoCredentialSecret(context.Context, string, string) error
}

// ZohoOAuthClient performs the Zoho accounts-server token + revoke calls.
// Client credentials go in the form body; the token response carries api_domain.
type ZohoOAuthClient struct {
	HTTPClient  *http.Client
	AccountsURL string
	UserAgent   string
	Now         func() time.Time
	TokenTTL    time.Duration
}

func (c ZohoOAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds ZohoCredentials, code, redirectURI string) (ZohoOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	return c.doToken(ctx, creds, form)
}

func (c ZohoOAuthClient) RefreshAccessToken(ctx context.Context, creds ZohoCredentials) (ZohoOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	return c.doToken(ctx, creds, form)
}

func (c ZohoOAuthClient) doToken(ctx context.Context, creds ZohoCredentials, form url.Values) (ZohoOAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return ZohoOAuthToken{}, fmt.Errorf("zoho OAuth client_id and client_secret are required")
	}
	if form.Get("grant_type") == "authorization_code" && strings.TrimSpace(form.Get("code")) == "" {
		return ZohoOAuthToken{}, fmt.Errorf("zoho OAuth authorization code is required")
	}
	if form.Get("grant_type") == "refresh_token" && strings.TrimSpace(form.Get("refresh_token")) == "" {
		return ZohoOAuthToken{}, fmt.Errorf("zoho OAuth refresh_token is required")
	}
	form.Set("client_id", strings.TrimSpace(creds.ClientID))
	form.Set("client_secret", strings.TrimSpace(creds.ClientSecret))

	baseURL := strings.TrimRight(firstString(c.AccountsURL, creds.AccountsURL, zohoDefaultAccountsURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+zohoOAuthTokenPath, strings.NewReader(form.Encode()))
	if err != nil {
		return ZohoOAuthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, zohoDefaultUserAgent))

	body, status, err := c.do(req)
	if err != nil {
		return ZohoOAuthToken{}, err
	}
	if status < 200 || status >= 300 {
		return ZohoOAuthToken{}, fmt.Errorf("zoho OAuth token request failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		APIDomain    string `json:"api_domain"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ZohoOAuthToken{}, fmt.Errorf("decode zoho OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.Error) != "" {
		return ZohoOAuthToken{}, fmt.Errorf("zoho OAuth token error: %s", raw.Error)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return ZohoOAuthToken{}, fmt.Errorf("zoho OAuth token response missing access_token")
	}
	ttl := c.TokenTTL
	if raw.ExpiresIn > 0 {
		ttl = time.Duration(raw.ExpiresIn) * time.Second
	}
	if ttl <= 0 {
		ttl = zohoDefaultTokenTTL
	}
	return ZohoOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(raw.APIDomain), "/"),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		Scope:        strings.TrimSpace(raw.Scope),
		ExpiresAt:    c.now().Add(ttl),
	}, nil
}

func (c ZohoOAuthClient) RevokeRefreshToken(ctx context.Context, creds ZohoCredentials) error {
	token := strings.TrimSpace(creds.RefreshToken)
	if token == "" {
		return fmt.Errorf("zoho OAuth refresh_token is required")
	}
	baseURL := strings.TrimRight(firstString(c.AccountsURL, creds.AccountsURL, zohoDefaultAccountsURL), "/")
	u, err := url.Parse(baseURL + zohoOAuthRevokePath)
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, zohoDefaultUserAgent))
	body, status, err := c.do(req)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		return nil
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("zoho OAuth revocation failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	return nil
}

func (c ZohoOAuthClient) do(req *http.Request) ([]byte, int, error) {
	client := crmEgressClient(c.HTTPClient, ProviderZohoCRM, 15*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, zohoResponseMaxBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func (c ZohoOAuthClient) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func zohoOAuthAuthorizeURL(cfg ZohoOAuthConfig, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", fmt.Errorf("zoho OAuth client_id is not configured")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return "", fmt.Errorf("zoho OAuth redirect_url is not configured")
	}
	base := strings.TrimRight(firstString(cfg.AccountsURL, zohoDefaultAccountsURL), "/")
	u, err := url.Parse(base + zohoOAuthAuthorizePath)
	if err != nil {
		return "", fmt.Errorf("parse zoho authorize URL: %w", err)
	}
	query := url.Values{}
	query.Set("response_type", "code")
	query.Set("client_id", strings.TrimSpace(cfg.ClientID))
	query.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	query.Set("scope", strings.Join(cfg.Scopes, ","))
	query.Set("access_type", "offline")
	query.Set("prompt", "consent")
	query.Set("state", strings.TrimSpace(state))
	u.RawQuery = query.Encode()
	return u.String(), nil
}

// ParseZohoOAuthScopes splits a comma/space separated scope string.
func ParseZohoOAuthScopes(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ' ' || r == ',' || r == '\n' || r == '\t'
	})
	return uniqueCRMStrings(fields)
}

func zohoIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), zohoStoredCredentialPrefix)
}

func randomZohoToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashZohoOAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func newZohoStoredCredentialRef() (string, error) {
	token, err := randomZohoToken(18)
	if err != nil {
		return "", err
	}
	return zohoStoredCredentialPrefix + token, nil
}

func (d *Deps) zohoOAuthConfig(r *http.Request) ZohoOAuthConfig {
	cfg := d.ZohoOAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.AccountsURL = strings.TrimRight(strings.TrimSpace(firstString(cfg.AccountsURL, zohoDefaultAccountsURL)), "/")
	cfg.SuccessRedirect = pipedriveOAuthRedirectTarget("", cfg.SuccessRedirect)
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = append([]string(nil), zohoDefaultOAuthScopes...)
	} else {
		cfg.Scopes = uniqueCRMStrings(cfg.Scopes)
	}
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/crm/zoho/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) zohoOAuthStateStore() ZohoOAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(ZohoOAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) zohoCredentialStore() ZohoCredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.ZohoCredentials.(*ZohoSecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(ZohoCredentialStore); ok {
		return store
	}
	return nil
}

func zohoOAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{
		"organization_id", "api_base_url", "data_center", "api_version",
		"per_page", "sync_leads", "default_tags", "list_ids",
	} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func (d *Deps) ZohoOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.zohoOAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/crm/zoho/oauth/start",
	})
}

func (d *Deps) ZohoOAuthStart(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.zohoOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Zoho OAuth state store is not configured")
		return
	}
	cfg := d.zohoOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "zoho_oauth_unconfigured", "Zoho OAuth client ID, client secret, and redirect URL are required")
		return
	}
	settings := zohoOAuthSettingsFromRequest(r)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Zoho CRM"
	}
	state, err := store.CreateZohoOAuthState(r.Context(), ZohoOAuthState{
		TenantID:        tid,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      pipedriveOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		Scopes:          cfg.Scopes,
		Settings:        settings,
		ExpiresAt:       d.now().Add(zohoOAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	authorize, err := zohoOAuthAuthorizeURL(cfg, state)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) ZohoOAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.zohoOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Zoho OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "Zoho OAuth state is required")
		return
	}
	state, err := store.ConsumeZohoOAuthState(r.Context(), stateToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "Zoho OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.zohoOAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{"ok": false, "error": providerError})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "Zoho OAuth code is required")
		return
	}
	cfg := d.zohoOAuthConfig(r)
	accountsURL := cfg.AccountsURL
	if loc := strings.TrimSpace(r.URL.Query().Get("location")); loc != "" {
		// Zoho appends the data-center accounts server as ?location= (e.g. eu).
		if mapped := zohoAccountsURLForLocation(loc); mapped != "" {
			accountsURL = mapped
		}
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "zoho_oauth_unconfigured", "Zoho OAuth client ID and client secret are required")
		return
	}
	client := d.ZohoOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	client.AccountsURL = accountsURL
	baseCreds := ZohoCredentials{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, AccountsURL: accountsURL, UserAgent: zohoDefaultUserAgent}
	token, err := client.ExchangeAuthorizationCode(r.Context(), baseCreds, code, state.RedirectURI)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "zoho_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.zohoCredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "Zoho credential store is not configured")
		return
	}
	creds := ZohoCredentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		APIBaseURL:     token.APIBaseURL,
		AccountsURL:    accountsURL,
		Scope:          firstString(token.Scope, strings.Join(state.Scopes, ",")),
		TokenExpiresAt: &token.ExpiresAt,
		UserAgent:      zohoDefaultUserAgent,
	}
	ref, err := newZohoStoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutZohoCredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings := copySettings(state.Settings)
	settings["credentials_ref"] = ref
	if token.APIBaseURL != "" {
		settings["api_base_url"] = token.APIBaseURL
	}
	settings["zoho_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["zoho_oauth_managed_by_postwave"] = true
	settings["zoho_oauth_scopes"] = state.Scopes
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:       ProviderZohoCRM,
		Name:           state.IntegrationName,
		Status:         "connected",
		Scopes:         state.Scopes,
		CredentialsRef: ref,
		Settings:       settings,
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
	d.zohoOAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"api_domain":       token.APIBaseURL,
		"token_expires_at": token.ExpiresAt,
	})
}

func (d *Deps) zohoOAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
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

func zohoAccountsURLForLocation(location string) string {
	switch strings.ToLower(strings.TrimSpace(location)) {
	case "us":
		return "https://accounts.zoho.com"
	case "eu":
		return "https://accounts.zoho.eu"
	case "in":
		return "https://accounts.zoho.in"
	case "au", "com.au":
		return "https://accounts.zoho.com.au"
	case "jp":
		return "https://accounts.zoho.jp"
	case "ca":
		return "https://accounts.zohocloud.ca"
	default:
		return ""
	}
}
