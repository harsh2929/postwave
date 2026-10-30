// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	webflowCursorPrefix       = "webflow:"
	webflowCursorComplete     = "webflow:complete"
	webflowDefaultAPIBaseURL  = "https://api.webflow.com"
	webflowResponseMaxBytes   = 8 << 20
	webflowDefaultPageSize    = 100
	webflowMaxPageSize        = 100
	webflowDefaultUserAgent   = "Moosewave Webflow Integration"
	webflowWebhookMaxBodySize = 2 << 20
	webflowSignatureTolerance = 5 * time.Minute
)

type WebflowCredentials struct {
	AccessToken   string
	WebhookSecret string
	APIBaseURL    string
	UserAgent     string
}

type WebflowCredentialResolver interface {
	ResolveWebflow(context.Context, string, Integration) (WebflowCredentials, error)
}

type WebflowBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type WebflowWebhookRegistrar interface {
	ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (WebflowWebhookReconcileSummary, error)
	CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (WebflowWebhookCleanupSummary, error)
}

type WebflowRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials WebflowCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type WebflowWebhookReconcileSummary struct {
	WebhookID         string         `json:"webhook_id"`
	Endpoint          string         `json:"endpoint"`
	TriggerType       string         `json:"trigger_type"`
	Filter            map[string]any `json:"filter,omitempty"`
	RegisteredAt      time.Time      `json:"registered_at"`
	Created           bool           `json:"created,omitempty"`
	Reused            bool           `json:"reused,omitempty"`
	Repaired          bool           `json:"repaired,omitempty"`
	RepairReason      string         `json:"repair_reason,omitempty"`
	PreviousWebhookID string         `json:"previous_webhook_id,omitempty"`
}

type WebflowWebhookCleanupSummary struct {
	WebhookID         string    `json:"webhook_id,omitempty"`
	Endpoint          string    `json:"endpoint,omitempty"`
	CleanedUpAt       time.Time `json:"cleaned_up_at"`
	Deleted           bool      `json:"deleted"`
	NotFound          bool      `json:"not_found,omitempty"`
	Skipped           bool      `json:"skipped,omitempty"`
	SkipReason        string    `json:"skip_reason,omitempty"`
	CleanupReason     string    `json:"cleanup_reason,omitempty"`
	PreviousWebhookID string    `json:"previous_webhook_id,omitempty"`
}

type WebflowRESTWebhookRegistrar struct {
	HTTPClient  *http.Client
	Credentials WebflowCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
}

type WebflowRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type WebflowSecretsCredentialResolver struct {
	Secrets WebflowRuntimeSecretResolver
}

func NewWebflowSecretsCredentialResolver(secrets WebflowRuntimeSecretResolver) *WebflowSecretsCredentialResolver {
	return &WebflowSecretsCredentialResolver{Secrets: secrets}
}

func (r *WebflowSecretsCredentialResolver) ResolveWebflow(ctx context.Context, _ string, integration Integration) (WebflowCredentials, error) {
	if r == nil || r.Secrets == nil {
		return WebflowCredentials{}, fmt.Errorf("webflow credential resolver is not configured")
	}
	ref := webflowCredentialRef(integration)
	if ref == "" {
		return WebflowCredentials{}, fmt.Errorf("webflow credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return WebflowCredentials{}, err
	}
	if webhookRef := webflowWebhookSecretRef(integration); webhookRef != "" && webhookRef != ref {
		secret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return WebflowCredentials{}, err
		}
		creds.WebhookSecret = secret
	}
	return creds, nil
}

func (r *WebflowSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (WebflowCredentials, error) {
	var payload webflowCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return WebflowCredentials{}, fmt.Errorf("resolve webflow credentials %q: %w", ref, err)
		}
		return parseWebflowCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return WebflowCredentials{}, fmt.Errorf("resolve webflow credentials %q: %w", ref, err)
	}
	return parseWebflowCredentialSecret(raw)
}

func (r *WebflowSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload webflowCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve webflow webhook secret %q: %w", ref, err)
		}
		return parseWebflowWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve webflow webhook secret %q: %w", ref, err)
	}
	return parseWebflowWebhookSecret(raw)
}

type webflowCredentialPayload struct {
	AccessToken   string `json:"access_token"`
	APIToken      string `json:"api_token"`
	Token         string `json:"token"`
	BearerToken   string `json:"bearer_token"`
	WebhookSecret string `json:"webhook_secret"`
	SigningSecret string `json:"signing_secret"`
	ClientSecret  string `json:"client_secret"`
	Secret        string `json:"secret"`
	APIBaseURL    string `json:"api_base_url"`
	UserAgent     string `json:"user_agent"`
}

func (p webflowCredentialPayload) credentials() (WebflowCredentials, error) {
	token := normalizeWebflowBearerToken(firstString(p.AccessToken, p.APIToken, p.Token, p.BearerToken))
	if token == "" {
		return WebflowCredentials{}, fmt.Errorf("webflow access_token is required")
	}
	webhook, _ := p.webhookSecret()
	return WebflowCredentials{
		AccessToken:   token,
		WebhookSecret: webhook,
		APIBaseURL:    strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:     strings.TrimSpace(p.UserAgent),
	}, nil
}

func (p webflowCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstString(p.WebhookSecret, p.SigningSecret, p.ClientSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("webflow webhook secret is required")
	}
	return secret, nil
}

func parseWebflowCredentialSecret(raw string) (WebflowCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return WebflowCredentials{}, fmt.Errorf("webflow credentials are empty")
	}
	var payload webflowCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return WebflowCredentials{}, fmt.Errorf("parse webflow credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseWebflowKeyValueSecret(raw).credentials()
	}
	return webflowCredentialPayload{AccessToken: raw}.credentials()
}

func parseWebflowWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("webflow webhook secret is empty")
	}
	var payload webflowCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse webflow webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseWebflowKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseWebflowKeyValueSecret(raw string) webflowCredentialPayload {
	var payload webflowCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "api_token":
			payload.APIToken = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "webhook_secret":
			payload.WebhookSecret = value
		case "signing_secret":
			payload.SigningSecret = value
		case "client_secret":
			payload.ClientSecret = value
		case "secret":
			payload.Secret = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeWebflowBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func webflowCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func webflowWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
		settingString(integration.Settings, "client_secret_ref"),
	))
}

type webflowWebhookRegistration struct {
	ID            string         `json:"id"`
	TriggerType   string         `json:"triggerType"`
	URL           string         `json:"url"`
	WorkspaceID   string         `json:"workspaceId"`
	SiteID        string         `json:"siteId"`
	Filter        map[string]any `json:"filter"`
	LastTriggered string         `json:"lastTriggered"`
	CreatedOn     string         `json:"createdOn"`
	SecretKey     string         `json:"secretKey"`
}

type webflowHTTPStatusError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Body       string
}

func (e webflowHTTPStatusError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("webflow REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Body)
	}
	return fmt.Sprintf("webflow REST %s failed %d: %s", e.Path, e.StatusCode, e.Body)
}

func (r WebflowRESTWebhookRegistrar) ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (WebflowWebhookReconcileSummary, error) {
	if integration.Provider != ProviderWebflow {
		return WebflowWebhookReconcileSummary{}, fmt.Errorf("webflow webhook registration requires a Webflow integration")
	}
	siteID := strings.TrimSpace(settingString(integration.Settings, "site_id"))
	if siteID == "" {
		return WebflowWebhookReconcileSummary{}, fmt.Errorf("webflow site_id is required")
	}
	appBaseURL = strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if appBaseURL == "" {
		return WebflowWebhookReconcileSummary{}, fmt.Errorf("public base URL is required for Webflow webhook registration")
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return WebflowWebhookReconcileSummary{}, err
	}
	if strings.TrimSpace(creds.WebhookSecret) == "" {
		return WebflowWebhookReconcileSummary{}, fmt.Errorf("webflow webhook signing secret is required for managed webhook registration")
	}
	endpoint := webflowWebhookEndpoint(appBaseURL)
	filter := webflowWebhookFilter(integration)
	previousWebhookID := strings.TrimSpace(settingString(integration.Settings, "webflow_webhook_id"))
	repairReason := ""
	if previousWebhookID != "" {
		hook, err := r.getWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, previousWebhookID)
		if err != nil {
			var statusErr webflowHTTPStatusError
			if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusNotFound {
				return WebflowWebhookReconcileSummary{}, err
			}
			repairReason = "stored_webhook_not_found"
		} else if webflowWebhookRegistrationMatchesSite(hook, siteID) && webflowWebhookRegistrationMatches(hook, endpoint, filter) {
			return WebflowWebhookReconcileSummary{
				WebhookID:    hook.ID,
				Endpoint:     hook.URL,
				TriggerType:  hook.TriggerType,
				Filter:       nonNilMap(hook.Filter),
				RegisteredAt: r.now(),
				Reused:       true,
			}, nil
		} else {
			repairReason = "stored_webhook_drifted"
		}
	}
	hooks, err := r.listWebhooks(ctx, client, baseURL, creds.AccessToken, userAgent, siteID)
	if err != nil {
		return WebflowWebhookReconcileSummary{}, err
	}
	for _, hook := range hooks {
		if webflowWebhookRegistrationMatchesSite(hook, siteID) && webflowWebhookRegistrationMatches(hook, endpoint, filter) {
			return WebflowWebhookReconcileSummary{
				WebhookID:         hook.ID,
				Endpoint:          hook.URL,
				TriggerType:       hook.TriggerType,
				Filter:            nonNilMap(hook.Filter),
				RegisteredAt:      r.now(),
				Reused:            true,
				Repaired:          repairReason != "",
				RepairReason:      repairReason,
				PreviousWebhookID: previousWebhookID,
			}, nil
		}
	}
	hook, err := r.createWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, siteID, endpoint, filter)
	if err != nil {
		return WebflowWebhookReconcileSummary{}, err
	}
	return WebflowWebhookReconcileSummary{
		WebhookID:         firstString(hook.ID, settingString(integration.Settings, "webflow_webhook_id")),
		Endpoint:          firstString(hook.URL, endpoint),
		TriggerType:       firstString(hook.TriggerType, "form_submission"),
		Filter:            nonNilMap(hook.Filter),
		RegisteredAt:      r.now(),
		Created:           true,
		Repaired:          repairReason != "",
		RepairReason:      repairReason,
		PreviousWebhookID: previousWebhookID,
	}, nil
}

func (r WebflowRESTWebhookRegistrar) CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (WebflowWebhookCleanupSummary, error) {
	if integration.Provider != ProviderWebflow {
		return WebflowWebhookCleanupSummary{}, fmt.Errorf("webflow webhook cleanup requires a Webflow integration")
	}
	webhookID := strings.TrimSpace(settingString(integration.Settings, "webflow_webhook_id"))
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return WebflowWebhookCleanupSummary{}, err
	}
	if webhookID == "" {
		if fallback, ok, err := r.matchingWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, integration, appBaseURL); err != nil {
			return WebflowWebhookCleanupSummary{}, err
		} else if ok {
			if err := r.deleteWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, fallback.ID); err != nil {
				return WebflowWebhookCleanupSummary{}, err
			}
			return WebflowWebhookCleanupSummary{
				WebhookID:     fallback.ID,
				Endpoint:      fallback.URL,
				CleanedUpAt:   r.now(),
				Deleted:       true,
				CleanupReason: "matched_endpoint_without_stored_id",
			}, nil
		}
		return WebflowWebhookCleanupSummary{
			Endpoint:    settingString(integration.Settings, "webflow_webhook_endpoint"),
			CleanedUpAt: r.now(),
		}, nil
	}
	err = r.deleteWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, webhookID)
	if err != nil {
		var statusErr webflowHTTPStatusError
		if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusNotFound {
			return WebflowWebhookCleanupSummary{}, err
		}
		if fallback, ok, err := r.matchingWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, integration, appBaseURL); err != nil {
			return WebflowWebhookCleanupSummary{
				WebhookID:     webhookID,
				Endpoint:      settingString(integration.Settings, "webflow_webhook_endpoint"),
				CleanedUpAt:   r.now(),
				NotFound:      true,
				Skipped:       true,
				SkipReason:    "fallback_lookup_failed",
				CleanupReason: "stored_id_not_found_fallback_lookup_failed",
			}, nil
		} else if ok && fallback.ID != webhookID {
			if err := r.deleteWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, fallback.ID); err != nil {
				return WebflowWebhookCleanupSummary{}, err
			}
			return WebflowWebhookCleanupSummary{
				WebhookID:         fallback.ID,
				Endpoint:          fallback.URL,
				CleanedUpAt:       r.now(),
				Deleted:           true,
				CleanupReason:     "stored_id_not_found_matched_endpoint",
				PreviousWebhookID: webhookID,
			}, nil
		}
		return WebflowWebhookCleanupSummary{
			WebhookID:     webhookID,
			Endpoint:      settingString(integration.Settings, "webflow_webhook_endpoint"),
			CleanedUpAt:   r.now(),
			NotFound:      true,
			CleanupReason: "stored_id_not_found",
		}, nil
	}
	return WebflowWebhookCleanupSummary{
		WebhookID:   webhookID,
		Endpoint:    settingString(integration.Settings, "webflow_webhook_endpoint"),
		CleanedUpAt: r.now(),
		Deleted:     true,
	}, nil
}

func (r WebflowRESTWebhookRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, WebflowCredentials, string, error) {
	resolver := r.Credentials
	if resolver == nil {
		return nil, "", WebflowCredentials{}, "", fmt.Errorf("webflow credential resolver is not configured")
	}
	creds, err := resolver.ResolveWebflow(ctx, integration.TenantID, integration)
	if err != nil {
		return nil, "", WebflowCredentials{}, "", err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return nil, "", WebflowCredentials{}, "", fmt.Errorf("webflow access token is required")
	}
	client := leadEgressClient(r.HTTPClient, ProviderWebflow, 30*time.Second)
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), webflowDefaultAPIBaseURL), "/")
	userAgent := firstString(r.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), webflowDefaultUserAgent)
	return client, baseURL, creds, userAgent, nil
}

func (r WebflowRESTWebhookRegistrar) listWebhooks(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, siteID string) ([]webflowWebhookRegistration, error) {
	raw, err := webflowDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/v2/sites/"+url.PathEscape(siteID)+"/webhooks", nil, nil)
	if err != nil {
		return nil, err
	}
	return decodeWebflowWebhookList(raw)
}

func (r WebflowRESTWebhookRegistrar) getWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, webhookID string) (webflowWebhookRegistration, error) {
	raw, err := webflowDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/v2/webhooks/"+url.PathEscape(webhookID), nil, nil)
	if err != nil {
		return webflowWebhookRegistration{}, err
	}
	return decodeWebflowWebhookRegistration(raw)
}

func (r WebflowRESTWebhookRegistrar) matchingWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent string, integration Integration, appBaseURL string) (webflowWebhookRegistration, bool, error) {
	siteID := strings.TrimSpace(settingString(integration.Settings, "site_id"))
	appBaseURL = strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if siteID == "" || appBaseURL == "" {
		return webflowWebhookRegistration{}, false, nil
	}
	endpoint := webflowWebhookEndpoint(appBaseURL)
	filter := webflowWebhookFilter(integration)
	hooks, err := r.listWebhooks(ctx, client, baseURL, accessToken, userAgent, siteID)
	if err != nil {
		return webflowWebhookRegistration{}, false, err
	}
	for _, hook := range hooks {
		if webflowWebhookRegistrationMatchesSite(hook, siteID) && webflowWebhookRegistrationMatches(hook, endpoint, filter) {
			return hook, true, nil
		}
	}
	return webflowWebhookRegistration{}, false, nil
}

func (r WebflowRESTWebhookRegistrar) createWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, siteID, endpoint string, filter map[string]any) (webflowWebhookRegistration, error) {
	body := map[string]any{
		"triggerType": "form_submission",
		"url":         endpoint,
	}
	if len(filter) > 0 {
		body["filter"] = filter
	}
	raw, _ := json.Marshal(body)
	out, err := webflowDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodPost, "/v2/sites/"+url.PathEscape(siteID)+"/webhooks", nil, bytes.NewReader(raw))
	if err != nil {
		return webflowWebhookRegistration{}, err
	}
	hook, err := decodeWebflowWebhookRegistration(out)
	if err != nil {
		return webflowWebhookRegistration{}, err
	}
	return hook, nil
}

func (r WebflowRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, webhookID string) error {
	_, err := webflowDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodDelete, "/v2/webhooks/"+url.PathEscape(webhookID), nil, nil)
	return err
}

func (r WebflowRESTWebhookRegistrar) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func webflowWebhookEndpoint(appBaseURL string) string {
	return strings.TrimRight(strings.TrimSpace(appBaseURL), "/") + "/api/public/lead-integrations/webflow/webhooks"
}

func webflowWebhookFilter(integration Integration) map[string]any {
	formName := strings.TrimSpace(settingString(integration.Settings, "form_name"))
	if formName == "" {
		return nil
	}
	return map[string]any{"name": formName}
}

func webflowWebhookRegistrationMatches(hook webflowWebhookRegistration, endpoint string, filter map[string]any) bool {
	if !strings.EqualFold(strings.TrimSpace(hook.TriggerType), "form_submission") {
		return false
	}
	if strings.TrimSpace(hook.URL) != strings.TrimSpace(endpoint) {
		return false
	}
	return webflowWebhookFilterMatches(hook.Filter, filter)
}

func webflowWebhookRegistrationMatchesSite(hook webflowWebhookRegistration, siteID string) bool {
	hookSiteID := strings.TrimSpace(hook.SiteID)
	siteID = strings.TrimSpace(siteID)
	return hookSiteID == "" || siteID == "" || strings.EqualFold(hookSiteID, siteID)
}

func webflowWebhookFilterMatches(got, want map[string]any) bool {
	gotName := strings.TrimSpace(fmt.Sprint(got["name"]))
	if gotName == "<nil>" {
		gotName = ""
	}
	wantName := strings.TrimSpace(fmt.Sprint(want["name"]))
	if wantName == "<nil>" {
		wantName = ""
	}
	return gotName == wantName
}

func decodeWebflowWebhookList(raw []byte) ([]webflowWebhookRegistration, error) {
	var env struct {
		Webhooks []webflowWebhookRegistration `json:"webhooks"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&env); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode webflow webhooks response: %w", err)
	}
	return env.Webhooks, nil
}

func decodeWebflowWebhookRegistration(raw []byte) (webflowWebhookRegistration, error) {
	var out webflowWebhookRegistration
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return webflowWebhookRegistration{}, fmt.Errorf("decode webflow webhook response: %w", err)
	}
	return out, nil
}

func (b WebflowRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderWebflow {
		return SyncRequest{}, fmt.Errorf("webflow backfill requires a Webflow integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("webflow credential resolver is not configured")
	}
	siteID := strings.TrimSpace(settingString(integration.Settings, "site_id"))
	if siteID == "" {
		return SyncRequest{}, fmt.Errorf("webflow site_id is required")
	}
	creds, err := b.Credentials.ResolveWebflow(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("webflow access token is required")
	}
	state, err := decodeWebflowCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: webflowCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderWebflow, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), webflowDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), webflowDefaultUserAgent)
	pageSize := webflowPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	items, pagination, err := fetchWebflowSubmissions(ctx, client, baseURL, creds.AccessToken, userAgent, siteID, integration, state.Offset, pageSize)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	for _, item := range items {
		submission := mapWebflowSubmission(item, integration)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	nextOffset := state.Offset + len(items)
	total := pagination.Total
	if len(items) < pageSize || (total > 0 && nextOffset >= total) {
		req.Cursor = webflowCursorComplete
	} else {
		req.Cursor = encodeWebflowCursor(webflowCursorState{Offset: nextOffset})
	}
	return req, nil
}

type webflowCursorState struct {
	Offset   int  `json:"offset,omitempty"`
	Complete bool `json:"complete,omitempty"`
}

func decodeWebflowCursor(cursor string) (webflowCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return webflowCursorState{}, nil
	}
	if cursor == webflowCursorComplete {
		return webflowCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, webflowCursorPrefix) {
		return webflowCursorState{}, fmt.Errorf("invalid Webflow cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, webflowCursorPrefix))
	if raw == "" {
		return webflowCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return webflowCursorState{}, fmt.Errorf("invalid Webflow cursor")
	}
	var out webflowCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return webflowCursorState{}, fmt.Errorf("invalid Webflow cursor")
	}
	if out.Offset < 0 {
		out.Offset = 0
	}
	return out, nil
}

func encodeWebflowCursor(state webflowCursorState) string {
	if state.Complete {
		return webflowCursorComplete
	}
	if state.Offset < 0 {
		state.Offset = 0
	}
	raw, _ := json.Marshal(state)
	return webflowCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type webflowSubmissionsResponse struct {
	FormSubmissions []webflowSubmission `json:"formSubmissions"`
	Pagination      webflowPagination   `json:"pagination"`
}

type webflowPagination struct {
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
	Total  int `json:"total"`
}

type webflowSubmission struct {
	ID            string         `json:"id"`
	DisplayName   string         `json:"displayName"`
	SiteID        string         `json:"siteId"`
	WorkspaceID   string         `json:"workspaceId"`
	DateSubmitted string         `json:"dateSubmitted"`
	SubmittedAt   string         `json:"submittedAt"`
	FormResponse  map[string]any `json:"formResponse"`
	Data          map[string]any `json:"data"`
	LocaleID      string         `json:"localeId"`
	FormID        string         `json:"formId"`
	FormElementID string         `json:"formElementId"`
	Name          string         `json:"name"`
	Schema        []webflowField `json:"schema"`
	Raw           map[string]any `json:"-"`
}

type webflowField struct {
	FieldName      string `json:"fieldName"`
	FieldType      string `json:"fieldType"`
	FieldElementID string `json:"fieldElementId"`
}

func fetchWebflowSubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, siteID string, integration Integration, offset, limit int) ([]webflowSubmission, webflowPagination, error) {
	query := url.Values{}
	query.Set("offset", strconv.Itoa(offset))
	query.Set("limit", strconv.Itoa(webflowPageSize(limit)))
	if elementID := firstString(settingString(integration.Settings, "form_element_id"), settingString(integration.Settings, "element_id")); elementID != "" {
		query.Set("elementId", elementID)
	}
	path := "/v2/sites/" + url.PathEscape(siteID) + "/form_submissions"
	if formID := strings.TrimSpace(settingString(integration.Settings, "form_id")); formID != "" {
		path = "/v2/sites/" + url.PathEscape(siteID) + "/forms/" + url.PathEscape(formID) + "/submissions"
	}
	raw, err := webflowDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, path, query, nil)
	if err != nil {
		return nil, webflowPagination{}, err
	}
	var env webflowSubmissionsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&env); err != nil && err != io.EOF {
		return nil, webflowPagination{}, fmt.Errorf("decode webflow submissions response: %w", err)
	}
	for i := range env.FormSubmissions {
		var rawItem map[string]any
		_ = json.Unmarshal(rawWebflowSubmissionJSON(env.FormSubmissions[i]), &rawItem)
		env.FormSubmissions[i].Raw = nonNilMap(rawItem)
	}
	return env.FormSubmissions, env.Pagination, nil
}

func webflowDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, webflowDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, webflowResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, webflowHTTPStatusError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Body: strings.TrimSpace(string(raw))}
	}
	return raw, nil
}

func mapWebflowSubmission(item webflowSubmission, integration Integration) SubmissionInput {
	siteID := firstString(item.SiteID, settingString(integration.Settings, "site_id"))
	formID := firstString(item.FormID, settingString(integration.Settings, "form_id"), item.FormElementID)
	data := item.FormResponse
	if len(data) == 0 {
		data = item.Data
	}
	fields := map[string]any{
		"webflow_submission_id":    item.ID,
		"webflow_site_id":          siteID,
		"webflow_workspace_id":     item.WorkspaceID,
		"webflow_form_id":          formID,
		"webflow_form_element_id":  item.FormElementID,
		"webflow_locale_id":        item.LocaleID,
		"webflow_display_name":     firstString(item.DisplayName, item.Name),
		"webflow_provider_raw":     item.Raw,
		"webflow_form_schema_size": len(item.Schema),
	}
	identity := typeformIdentity{}
	for key, value := range data {
		normalizedValue := normalizeWebflowValue(value)
		fields["webflow_field."+normalizeTypeformIdentityKey(key)] = normalizedValue
		identity.apply(key, strings.TrimSpace(fmt.Sprint(normalizedValue)))
	}
	for _, field := range item.Schema {
		if field.FieldName == "" {
			continue
		}
		fields["webflow_schema."+normalizeTypeformIdentityKey(field.FieldName)] = map[string]any{
			"type":       field.FieldType,
			"element_id": field.FieldElementID,
		}
	}
	submittedAt := parseWebflowTime(firstString(item.DateSubmitted, item.SubmittedAt))
	return SubmissionInput{
		SourceID:    webflowSourceID(siteID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(item.DisplayName, item.Name, settingString(integration.Settings, "form_name")),
		EventName:   "lead.submitted",
		Tags:        webflowTags(integration, siteID, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func normalizeWebflowValue(value any) any {
	switch typed := value.(type) {
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return i
		}
		if f, err := typed.Float64(); err == nil {
			return f
		}
		return typed.String()
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, normalizeWebflowValue(item))
		}
		return out
	default:
		return typed
	}
}

func (d *Deps) WebflowWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, webflowWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Webflow webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeWebflowWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	siteID := strings.TrimSpace(payload.Payload.SiteID)
	if siteID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_site_id", "Webflow webhook payload.siteId is required")
		return
	}
	formID := strings.TrimSpace(payload.Payload.FormID)
	formElementID := strings.TrimSpace(payload.Payload.FormElementID)
	integration, err := d.Repo.FindIntegrationByProviderSiteAndForm(r.Context(), ProviderWebflow, siteID, formID, formElementID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Webflow integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if formID := strings.TrimSpace(settingString(integration.Settings, "form_id")); formID != "" && !strings.EqualFold(formID, payload.Payload.FormID) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Webflow form integration not found")
		return
	}
	if elementID := firstString(settingString(integration.Settings, "form_element_id"), settingString(integration.Settings, "element_id")); elementID != "" && !strings.EqualFold(elementID, payload.Payload.FormElementID) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Webflow form element integration not found")
		return
	}
	resolver := d.webflowCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Webflow credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveWebflow(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyWebflowWebhookSignature(creds.WebhookSecret, body, r.Header.Get("x-webflow-timestamp"), r.Header.Get("x-webflow-signature"), d.now()); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	deliveryID := webflowWebhookDeliveryID(payload)
	webhookID := webflowWebhookID(payload, deliveryID)
	topic := webflowWebhookTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderWebflow, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	submission := mapWebflowSubmission(payload.Payload, *integration)
	submission.Fields["webflow_webhook_raw"] = payload.Raw
	req := normalizeSyncRequest(SyncRequest{RunMode: "webhook", Submissions: []SubmissionInput{submission}, Cursor: "webflow-webhook-" + deliveryID})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWebflow, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "webflow webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWebflow, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWebflow, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

type webflowWebhookPayload struct {
	TriggerType string            `json:"triggerType"`
	Payload     webflowSubmission `json:"payload"`
	Raw         map[string]any    `json:"-"`
}

func decodeWebflowWebhookPayload(body []byte) (webflowWebhookPayload, error) {
	var out webflowWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return webflowWebhookPayload{}, fmt.Errorf("decode webflow JSON webhook: %w", err)
	}
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	out.Raw = nonNilMap(raw)
	if out.Payload.FormResponse == nil && out.Payload.Data == nil {
		out.Payload.FormResponse = out.Payload.Data
	}
	return out, nil
}

func webflowWebhookID(payload webflowWebhookPayload, deliveryID string) string {
	siteID := strings.TrimSpace(payload.Payload.SiteID)
	scope := strings.TrimSpace(firstString(payload.Payload.FormID, payload.Payload.FormElementID))
	deliveryID = strings.TrimSpace(deliveryID)
	if siteID == "" {
		return "delivery:" + deliveryID
	}
	if scope == "" {
		return "site:" + siteID + ":delivery:" + deliveryID
	}
	return "site:" + siteID + ":form:" + scope + ":submission:" + deliveryID
}

func webflowWebhookDeliveryID(payload webflowWebhookPayload) string {
	if id := strings.TrimSpace(payload.Payload.ID); id != "" {
		return id
	}
	if id, ok := stableLocalWebflowWebhookID(payload); ok {
		return id
	}
	return rawLocalWebflowWebhookID(payload.Raw)
}

func webflowWebhookTopic(payload webflowWebhookPayload) string {
	return firstString(strings.TrimSpace(payload.TriggerType), "form_submission")
}

func VerifyWebflowWebhookSignature(secret string, body []byte, timestampHeader, signatureHeader string, now time.Time) error {
	secret = strings.TrimSpace(secret)
	timestampHeader = strings.TrimSpace(timestampHeader)
	signatureHeader = strings.TrimSpace(signatureHeader)
	if secret == "" {
		return ErrMissingWebhookSecret
	}
	if timestampHeader == "" || signatureHeader == "" {
		return ErrMissingWebhookSignature
	}
	if !webflowTimestampFresh(timestampHeader, now) {
		return ErrInvalidWebhookSignature
	}
	payload := []byte(timestampHeader + ":")
	payload = append(payload, body...)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expectedHex := hex.EncodeToString(mac.Sum(nil))
	expectedBase64 := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	signature := strings.TrimPrefix(strings.TrimPrefix(signatureHeader, "sha256="), "v1=")
	if subtle.ConstantTimeCompare([]byte(expectedHex), []byte(signature)) == 1 ||
		subtle.ConstantTimeCompare([]byte(expectedBase64), []byte(signature)) == 1 {
		return nil
	}
	return ErrInvalidWebhookSignature
}

func webflowTimestampFresh(raw string, now time.Time) bool {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return false
	}
	var at time.Time
	if value > 1_000_000_000_000 {
		at = time.UnixMilli(value)
	} else {
		at = time.Unix(value, 0)
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	delta := now.UTC().Sub(at.UTC())
	if delta < 0 {
		delta = -delta
	}
	return delta <= webflowSignatureTolerance
}

func webflowPageSize(size int) int {
	if size <= 0 {
		return webflowDefaultPageSize
	}
	if size > webflowMaxPageSize {
		return webflowMaxPageSize
	}
	return size
}

func webflowSourceID(siteID, id string) string {
	siteID = strings.TrimSpace(siteID)
	id = strings.TrimSpace(id)
	if siteID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "webflow://submission/" + siteID + "/" + id
}

func webflowTags(integration Integration, siteID, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"webflow", "webflow:" + siteID, "webflow:form:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func parseWebflowTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.Parse(layout, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func rawWebflowSubmissionJSON(item webflowSubmission) []byte {
	type alias webflowSubmission
	raw, _ := json.Marshal(alias(item))
	return raw
}

func stableLocalWebflowWebhookID(payload webflowWebhookPayload) (string, bool) {
	item := payload.Payload
	data := item.FormResponse
	if len(data) == 0 {
		data = item.Data
	}
	if len(data) == 0 {
		return "", false
	}
	stable := map[string]any{
		"site_id":         strings.TrimSpace(item.SiteID),
		"form_id":         strings.TrimSpace(item.FormID),
		"form_element_id": strings.TrimSpace(item.FormElementID),
		"submitted_at":    strings.TrimSpace(firstString(item.SubmittedAt, item.DateSubmitted)),
		"display_name":    strings.TrimSpace(firstString(item.DisplayName, item.Name)),
		"data":            stableWebflowValue(data),
	}
	if stable["site_id"] == "" && stable["form_id"] == "" && stable["form_element_id"] == "" && stable["submitted_at"] == "" {
		return "", false
	}
	body, _ := json.Marshal(stable)
	sum := sha256.Sum256(body)
	return "webflow_local_" + base64.RawURLEncoding.EncodeToString(sum[:]), true
}

func stableWebflowValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[strings.TrimSpace(key)] = stableWebflowValue(item)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, stableWebflowValue(item))
		}
		return out
	default:
		return normalizeWebflowValue(value)
	}
}

func rawLocalWebflowWebhookID(raw map[string]any) string {
	body, _ := json.Marshal(raw)
	sum := sha256.Sum256(body)
	return "webflow_local_" + base64.RawURLEncoding.EncodeToString(sum[:])
}
