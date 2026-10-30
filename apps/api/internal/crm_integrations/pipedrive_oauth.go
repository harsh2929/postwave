// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const pipedriveOAuthStateTTL = 10 * time.Minute

var pipedriveDefaultOAuthScopes = []string{"contacts:read", "deals:read", "activities:read", "webhooks:full"}

type PipedriveOAuthConfig struct {
	ClientID        string
	ClientSecret    string
	RedirectURL     string
	OAuthBaseURL    string
	SuccessRedirect string
	Scopes          []string
}

type PipedriveOAuthState struct {
	TenantID        string
	IntegrationName string
	RedirectURI     string
	RedirectTo      string
	Scopes          []string
	Settings        map[string]any
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

type PipedriveOAuthStateStore interface {
	CreatePipedriveOAuthState(context.Context, PipedriveOAuthState) (string, error)
	ConsumePipedriveOAuthState(context.Context, string) (PipedriveOAuthState, error)
}

type PipedriveOAuthInstallStore interface {
	FindPipedriveIntegrationByOAuthInstall(context.Context, string, string, string) (*Integration, error)
}

type PipedriveOAuthUninstallPayload struct {
	ClientID  string `json:"client_id"`
	CompanyID string `json:"company_id"`
	UserID    string `json:"user_id"`
	Timestamp string `json:"timestamp,omitempty"`
}

func ParsePipedriveOAuthScopes(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	out := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" || seen[field] {
			continue
		}
		seen[field] = true
		out = append(out, field)
	}
	return out
}

func (d *Deps) PipedriveOAuthAvailability(w http.ResponseWriter, r *http.Request) {
	cfg := d.pipedriveOAuthConfig(r)
	configured := cfg.ClientID != "" && cfg.ClientSecret != "" && cfg.RedirectURL != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        configured,
		"configured":       configured,
		"requires_session": true,
		"start_url":        "/api/v1/crm/pipedrive/oauth/start",
	})
}

func (d *Deps) PipedriveOAuthStart(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store := d.pipedriveOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Pipedrive OAuth state store is not configured")
		return
	}
	cfg := d.pipedriveOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "pipedrive_oauth_unconfigured", "Pipedrive OAuth client ID, client secret, and redirect URL are required")
		return
	}
	settings := pipedriveOAuthSettingsFromRequest(r)
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Pipedrive " + firstString(settingString(settings, "company_domain"), "OAuth")
	}
	state, err := store.CreatePipedriveOAuthState(r.Context(), PipedriveOAuthState{
		TenantID:        tenantID,
		IntegrationName: name,
		RedirectURI:     cfg.RedirectURL,
		RedirectTo:      pipedriveOAuthRedirectTarget(r.URL.Query().Get("redirect_to"), cfg.SuccessRedirect),
		Scopes:          cfg.Scopes,
		Settings:        settings,
		ExpiresAt:       d.now().Add(pipedriveOAuthStateTTL),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	authorize, err := pipedriveOAuthAuthorizeURL(cfg, state)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	http.Redirect(w, r, authorize, http.StatusFound)
}

func (d *Deps) PipedriveOAuthCallback(w http.ResponseWriter, r *http.Request) {
	store := d.pipedriveOAuthStateStore()
	if store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_store_unavailable", "Pipedrive OAuth state store is not configured")
		return
	}
	stateToken := strings.TrimSpace(r.URL.Query().Get("state"))
	if stateToken == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_state", "Pipedrive OAuth state is required")
		return
	}
	state, err := store.ConsumePipedriveOAuthState(r.Context(), stateToken)
	if err != nil {
		if errorsIsNotFound(err) {
			httperror.Write(w, http.StatusBadRequest, "invalid_state", "Pipedrive OAuth state is invalid or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		d.pipedriveOAuthFinish(w, r, state.RedirectTo, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": providerError,
		})
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_code", "Pipedrive OAuth code is required")
		return
	}
	cfg := d.pipedriveOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "pipedrive_oauth_unconfigured", "Pipedrive OAuth client ID and client secret are required")
		return
	}
	client := d.PipedriveOAuthClient
	if client.Now == nil && d.Now != nil {
		client.Now = d.Now
	}
	token, err := client.ExchangeAuthorizationCode(r.Context(), PipedriveCredentials{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		OAuthBaseURL: cfg.OAuthBaseURL,
		UserAgent:    pipedriveDefaultUserAgent,
	}, code, state.RedirectURI)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "pipedrive_oauth_exchange_failed", httperror.MessageInternal)
		return
	}
	credentialStore := d.pipedriveCredentialStore()
	if credentialStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "credential_store_unavailable", "Pipedrive credential store is not configured")
		return
	}
	settings := copySettings(state.Settings)
	if token.APIBaseURL != "" {
		settings["api_base_url"] = token.APIBaseURL
	}
	if settingString(settings, "company_domain") == "" {
		if companyDomain := pipedriveCompanyDomainFromAPIBaseURL(token.APIBaseURL); companyDomain != "" {
			settings["company_domain"] = companyDomain
		}
	}
	expiresAt := token.ExpiresAt.UTC()
	creds := PipedriveCredentials{
		AccessToken:    token.AccessToken,
		RefreshToken:   token.RefreshToken,
		ClientID:       cfg.ClientID,
		ClientSecret:   cfg.ClientSecret,
		APIBaseURL:     token.APIBaseURL,
		OAuthBaseURL:   cfg.OAuthBaseURL,
		Scope:          firstString(token.Scope, strings.Join(state.Scopes, " ")),
		TokenExpiresAt: &expiresAt,
		UserAgent:      pipedriveDefaultUserAgent,
	}
	if pipedriveManageWebhooks(settings) {
		creds.WebhookUsername = "postwave"
		secret, err := randomPipedriveToken(24)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
			return
		}
		creds.WebhookPassword = secret
	}
	user, err := client.CurrentUser(r.Context(), creds)
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "pipedrive_user_lookup_failed", httperror.MessageInternal)
		return
	}
	if user.CompanyDomain != "" {
		settings["company_domain"] = user.CompanyDomain
		settings["pipedrive_company_domain"] = user.CompanyDomain
	}
	settings["pipedrive_oauth_client_id"] = cfg.ClientID
	settings["pipedrive_user_id"] = user.ID
	settings["pipedrive_company_id"] = user.CompanyID
	settings["pipedrive_user_email"] = user.Email
	settings["pipedrive_user_name"] = user.Name
	settings["pipedrive_company_name"] = user.CompanyName
	settings["pipedrive_company_country"] = user.CompanyCountry
	settings["pipedrive_company_industry"] = user.CompanyIndustry
	settings["pipedrive_user_locale"] = user.Locale
	ref, err := newPipedriveStoredCredentialRef()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	if err := credentialStore.PutPipedriveCredentialSecret(r.Context(), state.TenantID, ref, creds); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	settings["credentials_ref"] = ref
	settings["pipedrive_oauth_connected_at"] = d.now().Format(time.RFC3339)
	settings["pipedrive_oauth_managed_by_postwave"] = true
	settings["pipedrive_oauth_scopes"] = state.Scopes
	normalized, _, err := normalizeIntegrationInput(IntegrationInput{
		Provider:       ProviderPipedrive,
		Name:           state.IntegrationName,
		Status:         "connected",
		Scopes:         state.Scopes,
		CredentialsRef: ref,
		Settings:       settings,
	})
	if err != nil {
		if cleanupErr := d.cleanupPipedriveOAuthCallbackArtifacts(r.Context(), state.TenantID, ref, Integration{Provider: ProviderPipedrive, TenantID: state.TenantID, CredentialsRef: ref, Settings: settings}, d.publicBaseURL(r), false); cleanupErr != nil {
			httperror.WriteInternal(w, d.Logger, cleanupErr, httperror.WithTenantIDLog(r.Context(), state.TenantID))
			return
		}
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	rollbackIntegration := Integration{
		Provider:       ProviderPipedrive,
		TenantID:       state.TenantID,
		CredentialsRef: ref,
		Settings:       copySettings(normalized.Settings),
	}
	normalized, err = d.preparePipedriveManagedWebhooks(r.Context(), state.TenantID, normalized, d.publicBaseURL(r))
	if err != nil {
		if cleanupErr := d.cleanupPipedriveOAuthCallbackArtifacts(r.Context(), state.TenantID, ref, rollbackIntegration, d.publicBaseURL(r), pipedriveManageWebhooks(settings)); cleanupErr != nil {
			httperror.WriteInternal(w, d.Logger, cleanupErr, httperror.WithTenantIDLog(r.Context(), state.TenantID))
			return
		}
		httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
		return
	}
	rollbackIntegration.Settings = copySettings(normalized.Settings)
	integration, err := d.Repo.UpsertIntegration(r.Context(), state.TenantID, normalized)
	if err != nil {
		if cleanupErr := d.cleanupPipedriveOAuthCallbackArtifacts(r.Context(), state.TenantID, ref, rollbackIntegration, d.publicBaseURL(r), pipedriveManagedWebhooksPresent(rollbackIntegration.Settings)); cleanupErr != nil {
			httperror.WriteInternal(w, d.Logger, cleanupErr, httperror.WithTenantIDLog(r.Context(), state.TenantID))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), state.TenantID))
		return
	}
	d.pipedriveOAuthFinish(w, r, state.RedirectTo, http.StatusOK, map[string]any{
		"ok":               true,
		"integration":      integration,
		"credentials_ref":  ref,
		"token_expires_at": expiresAt,
	})
}

func (d *Deps) PipedriveOAuthUninstallCallback(w http.ResponseWriter, r *http.Request) {
	cfg := d.pipedriveOAuthConfig(r)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "pipedrive_oauth_unconfigured", "Pipedrive OAuth client ID and client secret are required")
		return
	}
	if err := verifyPipedriveOAuthBasicAuth(cfg, r); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_oauth_uninstall_auth", "request authentication failed")
		return
	}
	payload, err := decodePipedriveOAuthUninstallPayload(r)
	if err != nil {
		if status := httpbody.StatusCode(err); status != http.StatusBadRequest {
			httpbody.WriteError(w, err)
			return
		}
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if payload.ClientID != "" && payload.ClientID != cfg.ClientID {
		httperror.Write(w, http.StatusUnauthorized, "invalid_oauth_uninstall_client", "Pipedrive OAuth uninstall client_id does not match this app")
		return
	}
	if payload.CompanyID == "" || payload.UserID == "" {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "Pipedrive OAuth uninstall requires company_id and user_id")
		return
	}
	store, ok := d.Repo.(PipedriveOAuthInstallStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "oauth_install_store_unavailable", "Pipedrive OAuth install lookup is not configured")
		return
	}
	integration, err := store.FindPipedriveIntegrationByOAuthInstall(r.Context(), cfg.ClientID, payload.CompanyID, payload.UserID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var pipedriveWebhookCleanup PipedriveWebhookCleanupSummary
	pipedriveWebhookCleanupAttempted := false
	if pipedriveManagedWebhooksPresent(integration.Settings) && (d.pipedriveCredentialResolver() != nil || d.PipedriveWebhooks != nil) {
		pipedriveWebhookCleanup, err = d.cleanupPipedriveWebhooks(r.Context(), *integration, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_cleanup_failed", httperror.MessageInternal)
			return
		}
		pipedriveWebhookCleanupAttempted = true
	}
	revocation := PipedriveOAuthRevocationSummary{
		Skipped:   true,
		Reason:    "provider_uninstall_callback",
		TokenType: "refresh_token",
	}
	if err := d.deletePipedriveManagedCredentialSecret(r.Context(), integration.TenantID, *integration); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	cleanup := crmDisconnectCleanupEvidence(integration, d.now(), crmDisconnectCleanupInput{
		pipedriveWebhookCleanup:          pipedriveWebhookCleanup,
		pipedriveWebhookCleanupAttempted: pipedriveWebhookCleanupAttempted,
		pipedriveOAuthRevocation:         revocation,
	})
	if err := d.Repo.DisconnectIntegrationWithProviderCleanup(r.Context(), integration.TenantID, integration.ID, cleanup); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                         true,
		"integration_id":             integration.ID,
		"company_id":                 payload.CompanyID,
		"user_id":                    payload.UserID,
		"provider_cleanup":           cleanup,
		"pipedrive_oauth_revocation": revocation,
	})
}

func (d *Deps) cleanupPipedriveOAuthCallbackArtifacts(ctx context.Context, tenantID, credentialRef string, integration Integration, appBaseURL string, cleanupWebhooks bool) error {
	var cleanupErr error
	if cleanupWebhooks && (d.pipedriveCredentialResolver() != nil || d.PipedriveWebhooks != nil) {
		if _, err := d.cleanupPipedriveWebhooks(ctx, integration, appBaseURL); err != nil {
			cleanupErr = err
		}
	}
	if pipedriveIsStoredCredentialRef(credentialRef) {
		if deleter := d.pipedriveCredentialDeleter(); deleter != nil {
			if err := deleter.DeletePipedriveCredentialSecret(ctx, tenantID, credentialRef); err != nil && cleanupErr == nil {
				cleanupErr = err
			}
		}
	}
	if cleanupErr != nil {
		return fmt.Errorf("cleanup Pipedrive OAuth callback artifacts: %w", cleanupErr)
	}
	return nil
}

func (d *Deps) pipedriveOAuthFinish(w http.ResponseWriter, r *http.Request, redirectTo string, status int, body map[string]any) {
	if redirectTo != "" {
		u, err := url.Parse(redirectTo)
		if err == nil {
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

func verifyPipedriveOAuthBasicAuth(cfg PipedriveOAuthConfig, r *http.Request) error {
	gotUser, gotPass, ok := r.BasicAuth()
	if !ok {
		return fmt.Errorf("Pipedrive OAuth uninstall Basic Auth is required")
	}
	wantUser := strings.TrimSpace(cfg.ClientID)
	wantPass := strings.TrimSpace(cfg.ClientSecret)
	if subtle.ConstantTimeCompare([]byte(gotUser), []byte(wantUser)) != 1 ||
		subtle.ConstantTimeCompare([]byte(gotPass), []byte(wantPass)) != 1 {
		return fmt.Errorf("Pipedrive OAuth uninstall Basic Auth is invalid")
	}
	return nil
}

func decodePipedriveOAuthUninstallPayload(r *http.Request) (PipedriveOAuthUninstallPayload, error) {
	var raw map[string]any
	if err := httpbody.DecodeJSONWith(nil, r, crmJSONMaxBodyBytes, &raw, httpbody.Options{
		AllowUnknownFields: true,
		UseNumber:          true,
	}); err != nil {
		return PipedriveOAuthUninstallPayload{}, fmt.Errorf("decode Pipedrive OAuth uninstall body: %w", err)
	}
	return PipedriveOAuthUninstallPayload{
		ClientID:  strings.TrimSpace(pipedriveAnyString(raw["client_id"])),
		CompanyID: strings.TrimSpace(pipedriveAnyString(raw["company_id"])),
		UserID:    strings.TrimSpace(pipedriveAnyString(raw["user_id"])),
		Timestamp: strings.TrimSpace(pipedriveAnyString(raw["timestamp"])),
	}, nil
}

func (d *Deps) pipedriveOAuthConfig(r *http.Request) PipedriveOAuthConfig {
	cfg := d.PipedriveOAuth
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.ClientSecret = strings.TrimSpace(cfg.ClientSecret)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.OAuthBaseURL = strings.TrimRight(strings.TrimSpace(firstString(cfg.OAuthBaseURL, pipedriveDefaultOAuthBaseURL)), "/")
	cfg.SuccessRedirect = pipedriveOAuthRedirectTarget("", cfg.SuccessRedirect)
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = append([]string(nil), pipedriveDefaultOAuthScopes...)
	} else {
		cfg.Scopes = uniqueCRMStrings(cfg.Scopes)
	}
	if cfg.RedirectURL == "" {
		if baseURL := d.publicBaseURL(r); baseURL != "" {
			cfg.RedirectURL = baseURL + "/api/v1/crm/pipedrive/oauth/callback"
		}
	}
	return cfg
}

func (d *Deps) pipedriveOAuthStateStore() PipedriveOAuthStateStore {
	if d == nil || d.Repo == nil {
		return nil
	}
	store, ok := d.Repo.(PipedriveOAuthStateStore)
	if !ok {
		return nil
	}
	return store
}

func (d *Deps) pipedriveCredentialStore() PipedriveCredentialStore {
	if d == nil {
		return nil
	}
	if resolver, ok := d.pipedriveCredentialResolver().(*PipedriveSecretsCredentialResolver); ok && resolver.Store != nil {
		return resolver.Store
	}
	if store, ok := d.Repo.(PipedriveCredentialStore); ok {
		return store
	}
	return nil
}

func pipedriveOAuthSettingsFromRequest(r *http.Request) map[string]any {
	query := r.URL.Query()
	settings := map[string]any{}
	for _, key := range []string{
		"company_domain",
		"api_base_url",
		"limit",
		"sync_deals",
		"deal_status",
		"deal_filter_id",
		"deal_updated_since",
		"sync_organizations",
		"organization_filter_id",
		"organization_updated_since",
		"sync_activities",
		"activity_filter_id",
		"activity_updated_since",
		"activity_done",
		"default_tags",
		"list_ids",
		"pipeline_id",
		"manage_webhooks",
		"webhook_events",
	} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			settings[key] = value
		}
	}
	return settings
}

func pipedriveOAuthAuthorizeURL(cfg PipedriveOAuthConfig, state string) (string, error) {
	baseURL := strings.TrimRight(firstString(cfg.OAuthBaseURL, pipedriveDefaultOAuthBaseURL), "/")
	u, err := url.Parse(baseURL + "/oauth/authorize")
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("client_id", strings.TrimSpace(cfg.ClientID))
	q.Set("redirect_uri", strings.TrimSpace(cfg.RedirectURL))
	q.Set("state", state)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func pipedriveOAuthRedirectTarget(raw, fallback string) string {
	raw = strings.TrimSpace(raw)
	if raw != "" && strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		return raw
	}
	fallback = strings.TrimSpace(fallback)
	if fallback == "" {
		return ""
	}
	if strings.HasPrefix(fallback, "/") && !strings.HasPrefix(fallback, "//") {
		return fallback
	}
	u, err := url.Parse(fallback)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return ""
	}
	return u.String()
}

func newPipedriveStoredCredentialRef() (string, error) {
	token, err := randomPipedriveToken(18)
	if err != nil {
		return "", err
	}
	return pipedriveStoredCredentialRefPrefix + token, nil
}

func randomPipedriveToken(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashPipedriveOAuthState(state string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(state)))
	return hex.EncodeToString(sum[:])
}

func pipedriveCompanyDomainFromAPIBaseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return ""
	}
	host := strings.ToLower(strings.TrimSpace(u.Host))
	host = strings.TrimSuffix(host, ".")
	if strings.HasSuffix(host, ".pipedrive.com") {
		return strings.TrimSuffix(host, ".pipedrive.com")
	}
	return host
}

func errorsIsNotFound(err error) bool {
	return errors.Is(err, ErrNotFound)
}
