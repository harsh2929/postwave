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
	highLevelDefaultAuthorizeURL  = "https://marketplace.leadconnectorhq.com/oauth/chooselocation"
	highLevelDefaultTokenURL      = "https://services.leadconnectorhq.com/oauth/token"
	highLevelDefaultScope         = "contacts.readonly locations.readonly opportunities.readonly calendars.readonly calendars/events.readonly conversations.readonly conversations/message.readonly"
	highLevelOAuthStateTTL        = 10 * time.Minute
	highLevelDefaultTokenTTL      = 24 * time.Hour
	highLevelStoredCredentialPref = "crm:highlevel:"
)

type HighLevelOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	AuthorizeURL    string
	TokenURL        string
	SuccessRedirect string
	Scope           string
}

type HighLevelOAuthToken struct {
	AccessToken  string
	RefreshToken string
	TokenType    string
	Scope        string
	LocationID   string
	ExpiresAt    time.Time
}

type HighLevelOAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type HighLevelOAuthStateStore interface {
	CreateHighLevelOAuthState(context.Context, HighLevelOAuthState) (string, error)
	ConsumeHighLevelOAuthState(context.Context, string) (HighLevelOAuthState, error)
}

type HighLevelCredentialStore interface {
	GetHighLevelCredentialSecret(context.Context, string, string) (string, error)
	PutHighLevelCredentialSecret(context.Context, string, string, HighLevelCredentials) error
}

type HighLevelCredentialDeleter interface {
	DeleteHighLevelCredentialSecret(context.Context, string, string) error
}

// HighLevelOAuthClient performs the Infusionsoft token calls. HighLevel has no standard
// refresh-token revoke endpoint, so disconnect deletes local managed creds.
type HighLevelOAuthClient struct {
	HTTPClient *http.Client
	TokenURL   string
	UserAgent  string
	Now        func() time.Time
	TokenTTL   time.Duration
}

func (c HighLevelOAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds HighLevelCredentials, code, redirectURI string) (HighLevelOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	form.Set("user_type", "Location")
	return c.doToken(ctx, creds, form)
}

func (c HighLevelOAuthClient) RefreshAccessToken(ctx context.Context, creds HighLevelCredentials) (HighLevelOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	return c.doToken(ctx, creds, form)
}

func (c HighLevelOAuthClient) doToken(ctx context.Context, creds HighLevelCredentials, form url.Values) (HighLevelOAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return HighLevelOAuthToken{}, fmt.Errorf("highLevel OAuth client_id and client_secret are required")
	}
	form.Set("client_id", strings.TrimSpace(creds.ClientID))
	form.Set("client_secret", strings.TrimSpace(creds.ClientSecret))

	tokenURL := firstString(strings.TrimSpace(c.TokenURL), highLevelDefaultTokenURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return HighLevelOAuthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, highLevelDefaultUserAgent))

	client := crmEgressClient(c.HTTPClient, ProviderHighLevel, 15*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return HighLevelOAuthToken{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, highLevelResponseMaxBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return HighLevelOAuthToken{}, fmt.Errorf("highLevel OAuth token request failed %d: %s", resp.StatusCode, truncateHubSpotString(string(body), 500))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
		ExpiresIn    int    `json:"expires_in"`
		LocationID   string `json:"locationId"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return HighLevelOAuthToken{}, fmt.Errorf("decode highLevel OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return HighLevelOAuthToken{}, fmt.Errorf("highLevel OAuth token response missing access_token")
	}
	ttl := c.TokenTTL
	if raw.ExpiresIn > 0 {
		ttl = time.Duration(raw.ExpiresIn) * time.Second
	}
	if ttl <= 0 {
		ttl = highLevelDefaultTokenTTL
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	return HighLevelOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		Scope:        strings.TrimSpace(raw.Scope),
		LocationID:   strings.TrimSpace(raw.LocationID),
		ExpiresAt:    now.Add(ttl),
	}, nil
}

func highLevelOAuthAuthorizeURL(cfg HighLevelOAuthConfig, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", fmt.Errorf("highLevel OAuth client_id is not configured")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return "", fmt.Errorf("highLevel OAuth redirect_url is not configured")
	}
	u, err := url.Parse(firstString(strings.TrimSpace(cfg.AuthorizeURL), highLevelDefaultAuthorizeURL))
	if err != nil {
		return "", fmt.Errorf("parse highLevel authorize URL: %w", err)
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", strings.TrimSpace(cfg.ClientID))
	q.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	q.Set("scope", firstString(strings.TrimSpace(cfg.Scope), highLevelDefaultScope))
	q.Set("state", strings.TrimSpace(state))
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func highLevelIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), highLevelStoredCredentialPref)
}

func randomHighLevelToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashHighLevelOAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func newHighLevelStoredCredentialRef() (string, error) {
	token, err := randomHighLevelToken(18)
	if err != nil {
		return "", err
	}
	return highLevelStoredCredentialPref + token, nil
}

func (d *Deps) highLevelOAuthConfig(r *http.Request) HighLevelOAuthConfig {
	cfg := d.HighLevelOAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.AuthorizeURL = firstString(strings.TrimSpace(cfg.AuthorizeURL), highLevelDefaultAuthorizeURL)
	cfg.TokenURL = firstString(strings.TrimSpace(cfg.TokenURL), highLevelDefaultTokenURL)
	cfg.SuccessRedirect = pipedriveOAuthRedirectTarget("", cfg.SuccessRedirect)
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/crm/gohighlevel/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) highLevelOAuthStateStore() HighLevelOAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(HighLevelOAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) highLevelCredentialStore() HighLevelCredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.HighLevelCredentials.(*HighLevelSecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(HighLevelCredentialStore); ok {
		return store
	}
	return nil
}

func highLevelOAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{"location_id", "api_base_url", "page_size", "default_tags", "list_ids"} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func (d *Deps) HighLevelOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.highLevelOAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/crm/gohighlevel/oauth/start",
	})
}

func (d *Deps) HighLevelOAuthStart(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.highLevelOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "HighLevel OAuth state store is not configured")
		return
	}
	cfg := d.highLevelOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "highLevel_oauth_unconfigured", "HighLevel OAuth client ID, client secret, and redirect URL are required")
		return
	}
	settings := highLevelOAuthSettingsFromRequest(r)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "HighLevel"
	}
	state, err := store.CreateHighLevelOAuthState(r.Context(), HighLevelOAuthState{
		TenantID:        tid,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      pipedriveOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		Settings:        settings,
		ExpiresAt:       d.now().Add(highLevelOAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	authorize, err := highLevelOAuthAuthorizeURL(cfg, state)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) HighLevelOAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.highLevelOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "HighLevel OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "HighLevel OAuth state is required")
		return
	}
	state, err := store.ConsumeHighLevelOAuthState(r.Context(), stateToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "HighLevel OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.highLevelOAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{"ok": false, "error": providerError})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "HighLevel OAuth code is required")
		return
	}
	cfg := d.highLevelOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "highLevel_oauth_unconfigured", "HighLevel OAuth client ID and client secret are required")
		return
	}
	client := d.HighLevelOAuthClient
	if client.TokenURL == "" {
		client.TokenURL = cfg.TokenURL
	}
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	baseCreds := HighLevelCredentials{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, UserAgent: highLevelDefaultUserAgent}
	token, err := client.ExchangeAuthorizationCode(r.Context(), baseCreds, code, state.RedirectURI)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "highLevel_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.highLevelCredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "HighLevel credential store is not configured")
		return
	}
	creds := HighLevelCredentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		LocationID:     token.LocationID,
		Scope:          token.Scope,
		TokenExpiresAt: &token.ExpiresAt,
		UserAgent:      highLevelDefaultUserAgent,
	}
	ref, err := newHighLevelStoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutHighLevelCredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings := copySettings(state.Settings)
	settings["credentials_ref"] = ref
	if strings.TrimSpace(token.LocationID) != "" {
		settings["location_id"] = token.LocationID
	}
	settings["highlevel_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["highlevel_oauth_managed_by_postwave"] = true
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:       ProviderHighLevel,
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
	d.highLevelOAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"token_expires_at": token.ExpiresAt,
	})
}

func (d *Deps) highLevelOAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
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
