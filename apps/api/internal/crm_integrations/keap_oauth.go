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
	keapDefaultAuthorizeURL  = "https://accounts.infusionsoft.com/app/oauth/authorize"
	keapDefaultTokenURL      = "https://api.infusionsoft.com/token"
	keapOAuthStateTTL        = 10 * time.Minute
	keapDefaultTokenTTL      = 24 * time.Hour
	keapStoredCredentialPref = "crm:keap:"
)

type KeapOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	AuthorizeURL    string
	TokenURL        string
	SuccessRedirect string
	Scope           string
}

type KeapOAuthToken struct {
	AccessToken  string
	RefreshToken string
	TokenType    string
	Scope        string
	ExpiresAt    time.Time
}

type KeapOAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type KeapOAuthStateStore interface {
	CreateKeapOAuthState(context.Context, KeapOAuthState) (string, error)
	ConsumeKeapOAuthState(context.Context, string) (KeapOAuthState, error)
}

type KeapCredentialStore interface {
	GetKeapCredentialSecret(context.Context, string, string) (string, error)
	PutKeapCredentialSecret(context.Context, string, string, KeapCredentials) error
}

type KeapCredentialDeleter interface {
	DeleteKeapCredentialSecret(context.Context, string, string) error
}

// KeapOAuthClient performs the Infusionsoft token calls. Keap has no standard
// refresh-token revoke endpoint, so disconnect deletes local managed creds.
type KeapOAuthClient struct {
	HTTPClient *http.Client
	TokenURL   string
	UserAgent  string
	Now        func() time.Time
	TokenTTL   time.Duration
}

func (c KeapOAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds KeapCredentials, code, redirectURI string) (KeapOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	return c.doToken(ctx, creds, form)
}

func (c KeapOAuthClient) RefreshAccessToken(ctx context.Context, creds KeapCredentials) (KeapOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	return c.doToken(ctx, creds, form)
}

func (c KeapOAuthClient) doToken(ctx context.Context, creds KeapCredentials, form url.Values) (KeapOAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return KeapOAuthToken{}, fmt.Errorf("keap OAuth client_id and client_secret are required")
	}
	form.Set("client_id", strings.TrimSpace(creds.ClientID))
	form.Set("client_secret", strings.TrimSpace(creds.ClientSecret))

	tokenURL := firstString(strings.TrimSpace(c.TokenURL), keapDefaultTokenURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return KeapOAuthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, keapDefaultUserAgent))

	client := crmEgressClient(c.HTTPClient, ProviderKeap, 15*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return KeapOAuthToken{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, keapResponseMaxBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return KeapOAuthToken{}, fmt.Errorf("keap OAuth token request failed %d: %s", resp.StatusCode, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return KeapOAuthToken{}, fmt.Errorf("decode keap OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return KeapOAuthToken{}, fmt.Errorf("keap OAuth token response missing access_token")
	}
	ttl := c.TokenTTL
	if raw.ExpiresIn > 0 {
		ttl = time.Duration(raw.ExpiresIn) * time.Second
	}
	if ttl <= 0 {
		ttl = keapDefaultTokenTTL
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	return KeapOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		Scope:        strings.TrimSpace(raw.Scope),
		ExpiresAt:    now.Add(ttl),
	}, nil
}

func keapOAuthAuthorizeURL(cfg KeapOAuthConfig, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", fmt.Errorf("keap OAuth client_id is not configured")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return "", fmt.Errorf("keap OAuth redirect_url is not configured")
	}
	u, err := url.Parse(firstString(strings.TrimSpace(cfg.AuthorizeURL), keapDefaultAuthorizeURL))
	if err != nil {
		return "", fmt.Errorf("parse keap authorize URL: %w", err)
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", strings.TrimSpace(cfg.ClientID))
	q.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	q.Set("scope", firstString(strings.TrimSpace(cfg.Scope), "full"))
	q.Set("state", strings.TrimSpace(state))
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func keapIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), keapStoredCredentialPref)
}

func randomKeapToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashKeapOAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func newKeapStoredCredentialRef() (string, error) {
	token, err := randomKeapToken(18)
	if err != nil {
		return "", err
	}
	return keapStoredCredentialPref + token, nil
}

func (d *Deps) keapOAuthConfig(r *http.Request) KeapOAuthConfig {
	cfg := d.KeapOAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.AuthorizeURL = firstString(strings.TrimSpace(cfg.AuthorizeURL), keapDefaultAuthorizeURL)
	cfg.TokenURL = firstString(strings.TrimSpace(cfg.TokenURL), keapDefaultTokenURL)
	cfg.SuccessRedirect = pipedriveOAuthRedirectTarget("", cfg.SuccessRedirect)
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/crm/keap/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) keapOAuthStateStore() KeapOAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(KeapOAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) keapCredentialStore() KeapCredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.KeapCredentials.(*KeapSecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(KeapCredentialStore); ok {
		return store
	}
	return nil
}

func keapOAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{"account_id", "api_base_url", "page_size", "tag_id", "default_tags", "list_ids"} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func (d *Deps) KeapOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.keapOAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/crm/keap/oauth/start",
	})
}

func (d *Deps) KeapOAuthStart(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.keapOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Keap OAuth state store is not configured")
		return
	}
	cfg := d.keapOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "keap_oauth_unconfigured", "Keap OAuth client ID, client secret, and redirect URL are required")
		return
	}
	settings := keapOAuthSettingsFromRequest(r)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Keap"
	}
	state, err := store.CreateKeapOAuthState(r.Context(), KeapOAuthState{
		TenantID:        tid,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      pipedriveOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		Settings:        settings,
		ExpiresAt:       d.now().Add(keapOAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	authorize, err := keapOAuthAuthorizeURL(cfg, state)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) KeapOAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.keapOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Keap OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "Keap OAuth state is required")
		return
	}
	state, err := store.ConsumeKeapOAuthState(r.Context(), stateToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "Keap OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.keapOAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{"ok": false, "error": providerError})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "Keap OAuth code is required")
		return
	}
	cfg := d.keapOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "keap_oauth_unconfigured", "Keap OAuth client ID and client secret are required")
		return
	}
	client := d.KeapOAuthClient
	if client.TokenURL == "" {
		client.TokenURL = cfg.TokenURL
	}
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	baseCreds := KeapCredentials{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, UserAgent: keapDefaultUserAgent}
	token, err := client.ExchangeAuthorizationCode(r.Context(), baseCreds, code, state.RedirectURI)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "keap_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.keapCredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "Keap credential store is not configured")
		return
	}
	creds := KeapCredentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		Scope:          token.Scope,
		TokenExpiresAt: &token.ExpiresAt,
		UserAgent:      keapDefaultUserAgent,
	}
	ref, err := newKeapStoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutKeapCredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings := copySettings(state.Settings)
	settings["credentials_ref"] = ref
	settings["keap_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["keap_oauth_managed_by_postwave"] = true
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:       ProviderKeap,
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
	d.keapOAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"token_expires_at": token.ExpiresAt,
	})
}

func (d *Deps) keapOAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
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
