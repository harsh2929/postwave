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
	salesforceDefaultLoginURL    = "https://login.salesforce.com"
	salesforceOAuthTokenPath     = "/services/oauth2/token"
	salesforceOAuthAuthorizePath = "/services/oauth2/authorize"
	salesforceOAuthRevokePath    = "/services/oauth2/revoke"
	salesforceOAuthStateTTL      = 10 * time.Minute
	// Salesforce token responses omit expires_in; sessions default to ~2h and are
	// admin-configurable. We apply an assumed TTL for proactive refresh, and the
	// SOQL backfiller performs one reactive 401 (INVALID_SESSION_ID) refresh/retry.
	salesforceDefaultTokenTTL          = 2 * time.Hour
	salesforceStoredCredentialPrefix   = "crm:salesforce:"
	salesforceDefaultOAuthUserAgentStr = "Moosewave Salesforce Integration"
)

var salesforceDefaultOAuthScopes = []string{"api", "refresh_token"}

// SalesforceOAuthConfig is the connected-app install configuration.
type SalesforceOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	LoginURL        string
	SuccessRedirect string
	Scopes          []string
}

// SalesforceOAuthToken is the parsed token endpoint response.
type SalesforceOAuthToken struct {
	AccessToken  string
	RefreshToken string
	InstanceURL  string
	IdentityURL  string
	TokenType    string
	Scope        string
	ExpiresAt    time.Time
}

type SalesforceOAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type SalesforceOAuthStateStore interface {
	CreateSalesforceOAuthState(context.Context, SalesforceOAuthState) (string, error)
	ConsumeSalesforceOAuthState(context.Context, string) (SalesforceOAuthState, error)
}

type SalesforceCredentialStore interface {
	GetSalesforceCredentialSecret(context.Context, string, string) (string, error)
	PutSalesforceCredentialSecret(context.Context, string, string, SalesforceCredentials) error
}

type SalesforceCredentialDeleter interface {
	DeleteSalesforceCredentialSecret(context.Context, string, string) error
}

// SalesforceOAuthClient performs the Salesforce connected-app token, and revoke
// calls. Salesforce returns instance_url with the token; client credentials go
// in the form body.
type SalesforceOAuthClient struct {
	HTTPClient *http.Client
	LoginURL   string
	UserAgent  string
	Now        func() time.Time
	TokenTTL   time.Duration
}

func (c SalesforceOAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds SalesforceCredentials, code, redirectURI string) (SalesforceOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	return c.doToken(ctx, creds, form)
}

func (c SalesforceOAuthClient) RefreshAccessToken(ctx context.Context, creds SalesforceCredentials) (SalesforceOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	return c.doToken(ctx, creds, form)
}

func (c SalesforceOAuthClient) doToken(ctx context.Context, creds SalesforceCredentials, form url.Values) (SalesforceOAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return SalesforceOAuthToken{}, fmt.Errorf("salesforce OAuth client_id and client_secret are required")
	}
	if form.Get("grant_type") == "authorization_code" && strings.TrimSpace(form.Get("code")) == "" {
		return SalesforceOAuthToken{}, fmt.Errorf("salesforce OAuth authorization code is required")
	}
	if form.Get("grant_type") == "refresh_token" && strings.TrimSpace(form.Get("refresh_token")) == "" {
		return SalesforceOAuthToken{}, fmt.Errorf("salesforce OAuth refresh_token is required")
	}
	form.Set("client_id", strings.TrimSpace(creds.ClientID))
	form.Set("client_secret", strings.TrimSpace(creds.ClientSecret))

	baseURL := strings.TrimRight(firstString(c.LoginURL, creds.LoginURL, salesforceDefaultLoginURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+salesforceOAuthTokenPath, strings.NewReader(form.Encode()))
	if err != nil {
		return SalesforceOAuthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, salesforceDefaultUserAgent))

	body, status, err := c.do(req)
	if err != nil {
		return SalesforceOAuthToken{}, err
	}
	if status < 200 || status >= 300 {
		return SalesforceOAuthToken{}, fmt.Errorf("salesforce OAuth token request failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		InstanceURL  string `json:"instance_url"`
		ID           string `json:"id"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return SalesforceOAuthToken{}, fmt.Errorf("decode salesforce OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return SalesforceOAuthToken{}, fmt.Errorf("salesforce OAuth token response missing access_token")
	}
	ttl := c.TokenTTL
	if ttl <= 0 {
		ttl = salesforceDefaultTokenTTL
	}
	return SalesforceOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		InstanceURL:  strings.TrimRight(strings.TrimSpace(raw.InstanceURL), "/"),
		IdentityURL:  strings.TrimSpace(raw.ID),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		Scope:        strings.TrimSpace(raw.Scope),
		ExpiresAt:    c.now().Add(ttl),
	}, nil
}

func (c SalesforceOAuthClient) RevokeRefreshToken(ctx context.Context, creds SalesforceCredentials) error {
	token := strings.TrimSpace(creds.RefreshToken)
	if token == "" {
		return fmt.Errorf("salesforce OAuth refresh_token is required")
	}
	form := url.Values{}
	form.Set("token", token)
	baseURL := strings.TrimRight(firstString(c.LoginURL, creds.LoginURL, salesforceDefaultLoginURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+salesforceOAuthRevokePath, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, salesforceDefaultUserAgent))
	body, status, err := c.do(req)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		return nil
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("salesforce OAuth revocation failed %d: %s", status, truncateHubSpotString(string(body), 500))
	}
	return nil
}

func (c SalesforceOAuthClient) do(req *http.Request) ([]byte, int, error) {
	client := crmEgressClient(c.HTTPClient, ProviderSalesforce, 15*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, salesforceResponseMaxBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func (c SalesforceOAuthClient) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func salesforceOAuthAuthorizeURL(cfg SalesforceOAuthConfig, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", fmt.Errorf("salesforce OAuth client_id is not configured")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return "", fmt.Errorf("salesforce OAuth redirect_url is not configured")
	}
	base := strings.TrimRight(firstString(cfg.LoginURL, salesforceDefaultLoginURL), "/")
	u, err := url.Parse(base + salesforceOAuthAuthorizePath)
	if err != nil {
		return "", fmt.Errorf("parse salesforce authorize URL: %w", err)
	}
	query := url.Values{}
	query.Set("response_type", "code")
	query.Set("client_id", strings.TrimSpace(cfg.ClientID))
	query.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	query.Set("scope", strings.Join(cfg.Scopes, " "))
	query.Set("state", strings.TrimSpace(state))
	u.RawQuery = query.Encode()
	return u.String(), nil
}

// ParseSalesforceOAuthScopes splits a space/comma separated scope string.
func ParseSalesforceOAuthScopes(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ' ' || r == ',' || r == '\n' || r == '\t'
	})
	return uniqueCRMStrings(fields)
}

func salesforceIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), salesforceStoredCredentialPrefix)
}

func randomSalesforceToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashSalesforceOAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func newSalesforceStoredCredentialRef() (string, error) {
	token, err := randomSalesforceToken(18)
	if err != nil {
		return "", err
	}
	return salesforceStoredCredentialPrefix + token, nil
}

func (d *Deps) salesforceOAuthConfig(r *http.Request) SalesforceOAuthConfig {
	cfg := d.SalesforceOAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.LoginURL = strings.TrimRight(strings.TrimSpace(firstString(cfg.LoginURL, salesforceDefaultLoginURL)), "/")
	cfg.SuccessRedirect = pipedriveOAuthRedirectTarget("", cfg.SuccessRedirect)
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = append([]string(nil), salesforceDefaultOAuthScopes...)
	} else {
		cfg.Scopes = uniqueCRMStrings(cfg.Scopes)
	}
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/crm/salesforce/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) salesforceOAuthStateStore() SalesforceOAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(SalesforceOAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) salesforceCredentialStore() SalesforceCredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.SalesforceCredentials.(*SalesforceSecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(SalesforceCredentialStore); ok {
		return store
	}
	return nil
}

func (d *Deps) salesforceCredentialDeleter() SalesforceCredentialDeleter {
	if d == nil {
		return nil
	}
	if resolver, ok := d.SalesforceCredentials.(*SalesforceSecretsCredentialResolver); ok && resolver.Store != nil {
		if deleter, ok := resolver.Store.(SalesforceCredentialDeleter); ok {
			return deleter
		}
	}
	if deleter, ok := d.Repo.(SalesforceCredentialDeleter); ok {
		return deleter
	}
	return nil
}

func salesforceOAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{
		"instance_url", "api_version", "org_id", "batch_size", "campaign_id",
		"sync_leads", "sync_campaign_members", "sync_tasks", "default_tags", "list_ids",
		"contact_fields", "lead_fields", "campaign_member_fields", "task_fields",
	} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func (d *Deps) SalesforceOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.salesforceOAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/crm/salesforce/oauth/start",
	})
}

func (d *Deps) SalesforceOAuthStart(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.salesforceOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Salesforce OAuth state store is not configured")
		return
	}
	cfg := d.salesforceOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "salesforce_oauth_unconfigured", "Salesforce OAuth client ID, client secret, and redirect URL are required")
		return
	}
	settings := salesforceOAuthSettingsFromRequest(r)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Salesforce"
	}
	state, err := store.CreateSalesforceOAuthState(r.Context(), SalesforceOAuthState{
		TenantID:        tid,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      pipedriveOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		Scopes:          cfg.Scopes,
		Settings:        settings,
		ExpiresAt:       d.now().Add(salesforceOAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	authorize, err := salesforceOAuthAuthorizeURL(cfg, state)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) SalesforceOAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.salesforceOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Salesforce OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "Salesforce OAuth state is required")
		return
	}
	state, err := store.ConsumeSalesforceOAuthState(r.Context(), stateToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "Salesforce OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.salesforceOAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{"ok": false, "error": providerError})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "Salesforce OAuth code is required")
		return
	}
	cfg := d.salesforceOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "salesforce_oauth_unconfigured", "Salesforce OAuth client ID and client secret are required")
		return
	}
	client := d.SalesforceOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	baseCreds := SalesforceCredentials{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, LoginURL: cfg.LoginURL, UserAgent: salesforceDefaultUserAgent}
	token, err := client.ExchangeAuthorizationCode(r.Context(), baseCreds, code, state.RedirectURI)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "salesforce_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.salesforceCredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "Salesforce credential store is not configured")
		return
	}
	creds := SalesforceCredentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		InstanceURL:    token.InstanceURL,
		LoginURL:       cfg.LoginURL,
		IdentityURL:    token.IdentityURL,
		Scope:          firstString(token.Scope, strings.Join(state.Scopes, " ")),
		TokenExpiresAt: &token.ExpiresAt,
		UserAgent:      salesforceDefaultUserAgent,
	}
	ref, err := newSalesforceStoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutSalesforceCredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings := copySettings(state.Settings)
	settings["credentials_ref"] = ref
	if token.InstanceURL != "" {
		settings["instance_url"] = token.InstanceURL
	}
	settings["salesforce_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["salesforce_oauth_managed_by_postwave"] = true
	settings["salesforce_oauth_scopes"] = state.Scopes
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:       ProviderSalesforce,
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
	d.salesforceOAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"instance_url":     token.InstanceURL,
		"token_expires_at": token.ExpiresAt,
	})
}

func (d *Deps) salesforceOAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
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
