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
	dynamics365DefaultOAuthBaseURL  = "https://login.microsoftonline.com"
	dynamics365DefaultTenant        = "common"
	dynamics365OAuthStateTTL        = 10 * time.Minute
	dynamics365DefaultTokenTTL      = time.Hour
	dynamics365StoredCredentialPref = "crm:dynamics365:"
)

// Dynamics365OAuthConfig is the Microsoft Entra (Azure AD) app config.
type Dynamics365OAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	OAuthBaseURL    string
	TenantID        string
	SuccessRedirect string
}

type Dynamics365OAuthToken struct {
	AccessToken  string
	RefreshToken string
	TokenType    string
	Scope        string
	ExpiresAt    time.Time
}

type Dynamics365OAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type Dynamics365OAuthStateStore interface {
	CreateDynamics365OAuthState(context.Context, Dynamics365OAuthState) (string, error)
	ConsumeDynamics365OAuthState(context.Context, string) (Dynamics365OAuthState, error)
}

type Dynamics365CredentialStore interface {
	GetDynamics365CredentialSecret(context.Context, string, string) (string, error)
	PutDynamics365CredentialSecret(context.Context, string, string, Dynamics365Credentials) error
}

type Dynamics365CredentialDeleter interface {
	DeleteDynamics365CredentialSecret(context.Context, string, string) error
}

// Dynamics365OAuthClient performs the Entra token calls. Entra has no standard
// refresh-token revoke endpoint, so disconnect deletes local managed creds.
type Dynamics365OAuthClient struct {
	HTTPClient   *http.Client
	OAuthBaseURL string
	TenantID     string
	UserAgent    string
	Now          func() time.Time
	TokenTTL     time.Duration
}

func (c Dynamics365OAuthClient) tokenURL(creds Dynamics365Credentials) string {
	base := strings.TrimRight(firstString(c.OAuthBaseURL, dynamics365DefaultOAuthBaseURL), "/")
	tenant := firstString(strings.TrimSpace(creds.TenantID), strings.TrimSpace(c.TenantID), dynamics365DefaultTenant)
	return base + "/" + tenant + "/oauth2/v2.0/token"
}

func dynamics365Scope(environmentURL string) string {
	env := strings.TrimRight(strings.TrimSpace(environmentURL), "/")
	if env == "" {
		return "offline_access"
	}
	return env + "/.default offline_access"
}

func (c Dynamics365OAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds Dynamics365Credentials, code, redirectURI, environmentURL string) (Dynamics365OAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	form.Set("scope", dynamics365Scope(environmentURL))
	return c.doToken(ctx, creds, form)
}

func (c Dynamics365OAuthClient) RefreshAccessToken(ctx context.Context, creds Dynamics365Credentials) (Dynamics365OAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	form.Set("scope", dynamics365Scope(creds.EnvironmentURL))
	return c.doToken(ctx, creds, form)
}

func (c Dynamics365OAuthClient) doToken(ctx context.Context, creds Dynamics365Credentials, form url.Values) (Dynamics365OAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return Dynamics365OAuthToken{}, fmt.Errorf("dynamics 365 OAuth client_id and client_secret are required")
	}
	form.Set("client_id", strings.TrimSpace(creds.ClientID))
	form.Set("client_secret", strings.TrimSpace(creds.ClientSecret))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL(creds), strings.NewReader(form.Encode()))
	if err != nil {
		return Dynamics365OAuthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, dynamics365DefaultUserAgent))

	client := crmEgressClient(c.HTTPClient, ProviderDynamics365, 15*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return Dynamics365OAuthToken{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, dynamics365ResponseMaxBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Dynamics365OAuthToken{}, fmt.Errorf("dynamics 365 OAuth token request failed %d: %s", resp.StatusCode, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return Dynamics365OAuthToken{}, fmt.Errorf("decode dynamics 365 OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return Dynamics365OAuthToken{}, fmt.Errorf("dynamics 365 OAuth token response missing access_token")
	}
	ttl := c.TokenTTL
	if raw.ExpiresIn > 0 {
		ttl = time.Duration(raw.ExpiresIn) * time.Second
	}
	if ttl <= 0 {
		ttl = dynamics365DefaultTokenTTL
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	return Dynamics365OAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		Scope:        strings.TrimSpace(raw.Scope),
		ExpiresAt:    now.Add(ttl),
	}, nil
}

func dynamics365OAuthAuthorizeURL(cfg Dynamics365OAuthConfig, state, environmentURL string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", fmt.Errorf("dynamics 365 OAuth client_id is not configured")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return "", fmt.Errorf("dynamics 365 OAuth redirect_url is not configured")
	}
	base := strings.TrimRight(firstString(cfg.OAuthBaseURL, dynamics365DefaultOAuthBaseURL), "/")
	tenant := firstString(strings.TrimSpace(cfg.TenantID), dynamics365DefaultTenant)
	u, err := url.Parse(base + "/" + tenant + "/oauth2/v2.0/authorize")
	if err != nil {
		return "", fmt.Errorf("parse dynamics 365 authorize URL: %w", err)
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", strings.TrimSpace(cfg.ClientID))
	q.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	q.Set("scope", dynamics365Scope(environmentURL))
	q.Set("response_mode", "query")
	q.Set("state", strings.TrimSpace(state))
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func dynamics365IsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), dynamics365StoredCredentialPref)
}

func randomDynamics365Token(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashDynamics365OAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func newDynamics365StoredCredentialRef() (string, error) {
	token, err := randomDynamics365Token(18)
	if err != nil {
		return "", err
	}
	return dynamics365StoredCredentialPref + token, nil
}

func (d *Deps) dynamics365OAuthConfig(r *http.Request) Dynamics365OAuthConfig {
	cfg := d.Dynamics365OAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.OAuthBaseURL = strings.TrimRight(strings.TrimSpace(firstString(cfg.OAuthBaseURL, dynamics365DefaultOAuthBaseURL)), "/")
	cfg.TenantID = firstString(strings.TrimSpace(cfg.TenantID), dynamics365DefaultTenant)
	cfg.SuccessRedirect = pipedriveOAuthRedirectTarget("", cfg.SuccessRedirect)
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/crm/dynamics365/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) dynamics365OAuthStateStore() Dynamics365OAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(Dynamics365OAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) dynamics365CredentialStore() Dynamics365CredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.Dynamics365Credentials.(*Dynamics365SecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(Dynamics365CredentialStore); ok {
		return store
	}
	return nil
}

func dynamics365OAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{"environment_url", "tenant_id", "api_version", "page_size", "sync_leads", "default_tags", "list_ids"} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func (d *Deps) Dynamics365OAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.dynamics365OAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/crm/dynamics365/oauth/start",
	})
}

func (d *Deps) Dynamics365OAuthStart(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.dynamics365OAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Dynamics 365 OAuth state store is not configured")
		return
	}
	cfg := d.dynamics365OAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "dynamics365_oauth_unconfigured", "Dynamics 365 OAuth client ID, client secret, and redirect URL are required")
		return
	}
	settings := dynamics365OAuthSettingsFromRequest(r)
	environmentURL := strings.TrimSpace(settingString(settings, "environment_url"))
	if environmentURL == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "environment_url_required", "Dynamics 365 install requires an environment_url (your Dataverse org URL)")
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Microsoft Dynamics 365"
	}
	state, err := store.CreateDynamics365OAuthState(r.Context(), Dynamics365OAuthState{
		TenantID:        tid,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      pipedriveOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		Settings:        settings,
		ExpiresAt:       d.now().Add(dynamics365OAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	authorize, err := dynamics365OAuthAuthorizeURL(cfg, state, environmentURL)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) Dynamics365OAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.dynamics365OAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Dynamics 365 OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "Dynamics 365 OAuth state is required")
		return
	}
	state, err := store.ConsumeDynamics365OAuthState(r.Context(), stateToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "Dynamics 365 OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.dynamics365OAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{"ok": false, "error": providerError})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "Dynamics 365 OAuth code is required")
		return
	}
	cfg := d.dynamics365OAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "dynamics365_oauth_unconfigured", "Dynamics 365 OAuth client ID and client secret are required")
		return
	}
	environmentURL := strings.TrimRight(strings.TrimSpace(settingString(state.Settings, "environment_url")), "/")
	client := d.Dynamics365OAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	baseCreds := Dynamics365Credentials{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, TenantID: firstString(settingString(state.Settings, "tenant_id"), cfg.TenantID), EnvironmentURL: environmentURL, UserAgent: dynamics365DefaultUserAgent}
	token, err := client.ExchangeAuthorizationCode(r.Context(), baseCreds, code, state.RedirectURI, environmentURL)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "dynamics365_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.dynamics365CredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "Dynamics 365 credential store is not configured")
		return
	}
	creds := Dynamics365Credentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		TenantID:       baseCreds.TenantID,
		EnvironmentURL: environmentURL,
		Scope:          token.Scope,
		TokenExpiresAt: &token.ExpiresAt,
		UserAgent:      dynamics365DefaultUserAgent,
	}
	ref, err := newDynamics365StoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutDynamics365CredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings := copySettings(state.Settings)
	settings["credentials_ref"] = ref
	settings["environment_url"] = environmentURL
	settings["dynamics365_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["dynamics365_oauth_managed_by_postwave"] = true
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:       ProviderDynamics365,
		Name:           state.IntegrationName,
		Status:         "connected",
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
	d.dynamics365OAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"environment_url":  environmentURL,
		"token_expires_at": token.ExpiresAt,
	})
}

func (d *Deps) dynamics365OAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
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
