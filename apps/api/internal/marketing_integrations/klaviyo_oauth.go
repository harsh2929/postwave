// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

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
	klaviyoDefaultOAuthBaseURL = "https://a.klaviyo.com"
	klaviyoDefaultAuthorizeURL = "https://www.klaviyo.com/oauth/authorize"
	klaviyoOAuthTokenPath      = "/oauth/token"
	klaviyoOAuthRevokePath     = "/oauth/revoke"
	klaviyoOAuthStateTTL       = 10 * time.Minute
	klaviyoOAuthPKCEMethod     = "S256"
)

// KlaviyoOAuthConfig is the public-app install configuration, sourced from env.
type KlaviyoOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	OAuthBaseURL    string
	AuthorizeURL    string
	SuccessRedirect string
	Scopes          []string
}

// KlaviyoOAuthToken is the parsed token endpoint response.
type KlaviyoOAuthToken struct {
	AccessToken  string
	RefreshToken string
	TokenType    string
	ExpiresIn    int
	ExpiresAt    time.Time
	Scope        string
}

// KlaviyoOAuthClient performs Klaviyo token refresh/exchange and revocation.
type KlaviyoOAuthClient struct {
	HTTPClient   *http.Client
	OAuthBaseURL string
	UserAgent    string
	Now          func() time.Time
}

func (c KlaviyoOAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds KlaviyoCredentials, code, redirectURI, codeVerifier string) (KlaviyoOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	form.Set("code_verifier", strings.TrimSpace(codeVerifier))
	return c.doToken(ctx, creds, form)
}

func (c KlaviyoOAuthClient) RefreshAccessToken(ctx context.Context, creds KlaviyoCredentials) (KlaviyoOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	return c.doToken(ctx, creds, form)
}

func (c KlaviyoOAuthClient) doToken(ctx context.Context, creds KlaviyoCredentials, form url.Values) (KlaviyoOAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return KlaviyoOAuthToken{}, fmt.Errorf("klaviyo OAuth client_id and client_secret are required")
	}
	if form.Get("grant_type") == "authorization_code" {
		if strings.TrimSpace(form.Get("code")) == "" {
			return KlaviyoOAuthToken{}, fmt.Errorf("klaviyo OAuth authorization code is required")
		}
		if strings.TrimSpace(form.Get("code_verifier")) == "" {
			return KlaviyoOAuthToken{}, fmt.Errorf("klaviyo OAuth code_verifier is required")
		}
	}
	if form.Get("grant_type") == "refresh_token" && strings.TrimSpace(form.Get("refresh_token")) == "" {
		return KlaviyoOAuthToken{}, fmt.Errorf("klaviyo OAuth refresh_token is required")
	}
	baseURL := strings.TrimRight(firstString(c.OAuthBaseURL, creds.OAuthBaseURL, klaviyoDefaultOAuthBaseURL), "/")
	tokenURL := firstString(creds.TokenURL, baseURL+klaviyoOAuthTokenPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return KlaviyoOAuthToken{}, err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.ClientID), strings.TrimSpace(creds.ClientSecret))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, klaviyoDefaultUserAgent))

	body, status, err := c.do(req)
	if err != nil {
		return KlaviyoOAuthToken{}, err
	}
	if status < 200 || status >= 300 {
		return KlaviyoOAuthToken{}, fmt.Errorf("klaviyo OAuth token request failed %d: %s", status, truncateKlaviyoOAuthBody(body))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return KlaviyoOAuthToken{}, fmt.Errorf("decode klaviyo OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return KlaviyoOAuthToken{}, fmt.Errorf("klaviyo OAuth token response missing access_token")
	}
	now := c.now()
	expiresAt := now
	if raw.ExpiresIn > 0 {
		expiresAt = now.Add(time.Duration(raw.ExpiresIn) * time.Second)
	}
	return KlaviyoOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		ExpiresIn:    raw.ExpiresIn,
		ExpiresAt:    expiresAt,
		Scope:        strings.TrimSpace(raw.Scope),
	}, nil
}

func (c KlaviyoOAuthClient) RevokeToken(ctx context.Context, creds KlaviyoCredentials, token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("klaviyo OAuth token is required")
	}
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return fmt.Errorf("klaviyo OAuth client_id and client_secret are required")
	}
	baseURL := strings.TrimRight(firstString(c.OAuthBaseURL, creds.OAuthBaseURL, klaviyoDefaultOAuthBaseURL), "/")
	revokeURL := firstString(creds.RevokeURL, baseURL+klaviyoOAuthRevokePath)
	form := url.Values{}
	form.Set("token", token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, revokeURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.ClientID), strings.TrimSpace(creds.ClientSecret))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, klaviyoDefaultUserAgent))
	body, status, err := c.do(req)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound || status == http.StatusBadRequest {
		return nil
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("klaviyo OAuth token revocation failed %d: %s", status, truncateKlaviyoOAuthBody(body))
	}
	return nil
}

func (c KlaviyoOAuthClient) do(req *http.Request) ([]byte, int, error) {
	client := marketingEgressClient(c.HTTPClient, ProviderKlaviyo, 15*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, klaviyoWebhookRegistrationBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func (c KlaviyoOAuthClient) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

type KlaviyoOAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	CodeVerifier    string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type KlaviyoOAuthStateStore interface {
	CreateKlaviyoOAuthState(context.Context, KlaviyoOAuthState) (string, error)
	ConsumeKlaviyoOAuthState(context.Context, string) (KlaviyoOAuthState, error)
}

func ParseKlaviyoOAuthScopes(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ' ' || r == ',' || r == '\n' || r == '\t'
	})
	return uniqueMarketingStrings(fields)
}

var klaviyoDefaultOAuthScopes = []string{
	"accounts:read",
	"profiles:read",
	"profiles:write",
	"lists:read",
	"lists:write",
	"segments:read",
	"events:read",
	"events:write",
	"webhooks:read",
	"webhooks:write",
}

func randomKlaviyoOAuthToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashKlaviyoOAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func newKlaviyoStoredCredentialRef() (string, error) {
	token, err := randomKlaviyoOAuthToken(18)
	if err != nil {
		return "", err
	}
	return klaviyoStoredCredentialPrefix + token, nil
}

func newKlaviyoCodeVerifier() (string, error) {
	return randomKlaviyoOAuthToken(64)
}

func klaviyoCodeChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(verifier)))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func klaviyoOAuthAuthorizeURL(cfg KlaviyoOAuthConfig, state string, scopes []string, codeVerifier string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", fmt.Errorf("klaviyo OAuth client_id is not configured")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		return "", fmt.Errorf("klaviyo OAuth redirect_url is not configured")
	}
	if strings.TrimSpace(codeVerifier) == "" {
		return "", fmt.Errorf("klaviyo OAuth code_verifier is required")
	}
	base := firstString(strings.TrimSpace(cfg.AuthorizeURL), klaviyoDefaultAuthorizeURL)
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("parse klaviyo authorize URL: %w", err)
	}
	query := url.Values{}
	query.Set("response_type", "code")
	query.Set("client_id", strings.TrimSpace(cfg.ClientID))
	query.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	query.Set("scope", strings.Join(scopes, " "))
	query.Set("state", strings.TrimSpace(state))
	query.Set("code_challenge", klaviyoCodeChallenge(codeVerifier))
	query.Set("code_challenge_method", klaviyoOAuthPKCEMethod)
	u.RawQuery = query.Encode()
	return u.String(), nil
}

func (d *Deps) klaviyoOAuthConfig(r *http.Request) KlaviyoOAuthConfig {
	cfg := d.KlaviyoOAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.OAuthBaseURL = strings.TrimRight(strings.TrimSpace(firstString(cfg.OAuthBaseURL, klaviyoDefaultOAuthBaseURL)), "/")
	cfg.AuthorizeURL = strings.TrimSpace(firstString(cfg.AuthorizeURL, klaviyoDefaultAuthorizeURL))
	cfg.SuccessRedirect = marketingOAuthRedirectTarget("", cfg.SuccessRedirect)
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = append([]string(nil), klaviyoDefaultOAuthScopes...)
	} else {
		cfg.Scopes = uniqueMarketingStrings(cfg.Scopes)
	}
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/marketing-integrations/klaviyo/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) klaviyoOAuthStateStore() KlaviyoOAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(KlaviyoOAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) klaviyoCredentialStore() KlaviyoCredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.KlaviyoCredentials.(*KlaviyoSecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(KlaviyoCredentialStore); ok {
		return store
	}
	return nil
}

func (d *Deps) klaviyoCredentialDeleter() KlaviyoCredentialDeleter {
	if d == nil {
		return nil
	}
	if deleter, ok := d.Repo.(KlaviyoCredentialDeleter); ok {
		return deleter
	}
	return nil
}

func klaviyoOAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{
		"api_base_url",
		"revision",
		"api_revision",
		"account_id",
		"klaviyo_account_id",
		"klaviyo_webhook_secret_ref",
		"webhook_secret_ref",
		"klaviyo_webhook_topics",
		"klaviyo_webhook_managed_by_postwave",
		"klaviyo_webhook_provision",
		"page_size",
		"list_id",
		"segment_id",
		"event_name",
		"tags_property",
		"event_properties",
	} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func (d *Deps) KlaviyoOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.klaviyoOAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/marketing-integrations/klaviyo/oauth/start",
		"callback_url":     cfg.RedirectURL,
		"pkce":             true,
	})
}

func (d *Deps) KlaviyoOAuthStart(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.klaviyoOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Klaviyo OAuth state store is not configured")
		return
	}
	cfg := d.klaviyoOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "klaviyo_oauth_unconfigured", "Klaviyo OAuth client ID, client secret, and redirect URL are required")
		return
	}
	codeVerifier, err := newKlaviyoCodeVerifier()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	settings := klaviyoOAuthSettingsFromRequest(r)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Klaviyo"
	}
	state, err := store.CreateKlaviyoOAuthState(r.Context(), KlaviyoOAuthState{
		TenantID:        tid,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      marketingOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		CodeVerifier:    codeVerifier,
		Scopes:          cfg.Scopes,
		Settings:        settings,
		ExpiresAt:       d.now().Add(klaviyoOAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	authorize, err := klaviyoOAuthAuthorizeURL(cfg, state, cfg.Scopes, codeVerifier)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) KlaviyoOAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.klaviyoOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Klaviyo OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "Klaviyo OAuth state is required")
		return
	}
	state, err := store.ConsumeKlaviyoOAuthState(r.Context(), stateToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "Klaviyo OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.klaviyoOAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{"ok": false, "error": providerError})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "Klaviyo OAuth code is required")
		return
	}
	cfg := d.klaviyoOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "klaviyo_oauth_unconfigured", "Klaviyo OAuth client ID and client secret are required")
		return
	}
	client := d.KlaviyoOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	baseCreds := KlaviyoCredentials{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		OAuthBaseURL: cfg.OAuthBaseURL,
		UserAgent:    klaviyoDefaultUserAgent,
	}
	token, err := client.ExchangeAuthorizationCode(r.Context(), baseCreds, code, state.RedirectURI, state.CodeVerifier)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "klaviyo_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.klaviyoCredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "Klaviyo credential store is not configured")
		return
	}
	expiresAt := token.ExpiresAt.UTC()
	creds := KlaviyoCredentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		OAuthBaseURL:   cfg.OAuthBaseURL,
		Scope:          firstString(token.Scope, strings.Join(state.Scopes, " ")),
		AccountID:      firstString(anyString(state.Settings["account_id"]), anyString(state.Settings["klaviyo_account_id"])),
		TokenExpiresAt: &expiresAt,
		UserAgent:      klaviyoDefaultUserAgent,
	}
	ref, err := newKlaviyoStoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutKlaviyoCredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings := cloneMap(state.Settings)
	settings["credentials_ref"] = ref
	if creds.AccountID != "" {
		settings["account_id"] = creds.AccountID
		settings["klaviyo_account_id"] = creds.AccountID
	}
	settings["klaviyo_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["klaviyo_oauth_managed_by_postwave"] = true
	settings["klaviyo_oauth_scopes"] = state.Scopes
	settings["klaviyo_auth_mode"] = "oauth_public_app"
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:       ProviderKlaviyo,
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
	d.klaviyoOAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"token_expires_at": expiresAt,
	})
}

func (d *Deps) klaviyoOAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
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

type KlaviyoOAuthRevocationSummary struct {
	RevokedAccess  bool   `json:"revoked_access,omitempty"`
	RevokedRefresh bool   `json:"revoked_refresh,omitempty"`
	Skipped        bool   `json:"skipped,omitempty"`
	Reason         string `json:"reason,omitempty"`
	RevokedAt      string `json:"revoked_at,omitempty"`
}

func (d *Deps) revokeKlaviyoOAuthOnDisconnect(ctx context.Context, tenantID string, integration Integration) (KlaviyoOAuthRevocationSummary, error) {
	if integration.Provider != ProviderKlaviyo || !klaviyoIsStoredCredentialRef(klaviyoCredentialRef(integration)) {
		return KlaviyoOAuthRevocationSummary{}, nil
	}
	creds, ok, reason, err := d.klaviyoOAuthRevocationCredentials(ctx, tenantID, integration)
	if err != nil {
		return KlaviyoOAuthRevocationSummary{}, err
	}
	if !ok {
		return KlaviyoOAuthRevocationSummary{Skipped: true, Reason: reason}, nil
	}
	client := d.KlaviyoOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	cfg := d.KlaviyoOAuth
	creds.ClientID = firstString(creds.ClientID, cfg.ClientID)
	creds.ClientSecret = firstString(creds.ClientSecret, cfg.ClientSecret)
	creds.OAuthBaseURL = firstString(creds.OAuthBaseURL, cfg.OAuthBaseURL, klaviyoDefaultOAuthBaseURL)
	revokedAccess := false
	revokedRefresh := false
	if strings.TrimSpace(creds.AccessToken) != "" {
		if err := client.RevokeToken(ctx, creds, creds.AccessToken); err != nil {
			return KlaviyoOAuthRevocationSummary{}, err
		}
		revokedAccess = true
	}
	if strings.TrimSpace(creds.RefreshToken) != "" {
		if err := client.RevokeToken(ctx, creds, creds.RefreshToken); err != nil {
			return KlaviyoOAuthRevocationSummary{}, err
		}
		revokedRefresh = true
	}
	return KlaviyoOAuthRevocationSummary{
		RevokedAccess:  revokedAccess,
		RevokedRefresh: revokedRefresh,
		RevokedAt:      d.now().Format(time.RFC3339),
	}, nil
}

func (d *Deps) klaviyoOAuthRevocationCredentials(ctx context.Context, tenantID string, integration Integration) (KlaviyoCredentials, bool, string, error) {
	ref := klaviyoCredentialRef(integration)
	if ref == "" {
		return KlaviyoCredentials{}, false, "missing_credentials_ref", nil
	}
	if store := d.klaviyoCredentialStore(); store != nil && klaviyoIsStoredCredentialRef(ref) {
		raw, err := store.GetKlaviyoCredentialSecret(ctx, tenantID, ref)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return KlaviyoCredentials{}, false, "stored_credentials_missing", nil
			}
			return KlaviyoCredentials{}, false, "", err
		}
		creds, err := parseKlaviyoCredentialSecret(raw)
		if err != nil {
			return KlaviyoCredentials{}, false, "", err
		}
		return creds, true, "", nil
	}
	return KlaviyoCredentials{}, false, "credential_ref_not_managed_oauth", nil
}

func marketingOAuthRedirectTarget(raw, fallback string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = strings.TrimSpace(fallback)
	}
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() {
		return ""
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return ""
	}
	return u.String()
}

func truncateKlaviyoOAuthBody(raw []byte) string {
	value := strings.TrimSpace(string(raw))
	if len(value) > 500 {
		return value[:500]
	}
	return value
}
