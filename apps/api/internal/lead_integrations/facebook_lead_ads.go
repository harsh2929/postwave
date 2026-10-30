// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
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
	facebookLeadAdsCursorPrefix       = "facebook-lead-ads:"
	facebookLeadAdsCursorComplete     = "facebook-lead-ads:complete"
	facebookLeadAdsDefaultGraphAPIURL = "https://graph.facebook.com/v25.0"
	facebookLeadAdsResponseMaxBytes   = 8 << 20
	facebookLeadAdsDefaultPageSize    = 100
	facebookLeadAdsMaxPageSize        = 100
	facebookLeadAdsDefaultUserAgent   = "Moosewave Facebook Lead Ads Integration"
	facebookLeadAdsWebhookMaxBodySize = 1 << 20
)

type FacebookLeadAdsCredentials struct {
	AccessToken string
	AppSecret   string
	APIBaseURL  string
	UserAgent   string
}

type FacebookLeadAdsCredentialResolver interface {
	ResolveFacebookLeadAds(context.Context, string, Integration) (FacebookLeadAdsCredentials, error)
}

type FacebookLeadAdsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FacebookLeadAdsPageSubscriptionRegistrar interface {
	ReconcilePageSubscription(ctx context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionSummary, error)
	CleanupPageSubscription(ctx context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionCleanupSummary, error)
}

type FacebookLeadAdsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FacebookLeadAdsCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type FacebookLeadAdsRESTPageSubscriptionRegistrar struct {
	HTTPClient  *http.Client
	Credentials FacebookLeadAdsCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
}

type FacebookLeadAdsPageSubscriptionSummary struct {
	PageID       string    `json:"page_id"`
	Fields       []string  `json:"fields"`
	Endpoint     string    `json:"endpoint,omitempty"`
	Subscribed   bool      `json:"subscribed"`
	ReconciledAt time.Time `json:"reconciled_at"`
}

type FacebookLeadAdsPageSubscriptionCleanupSummary struct {
	PageID      string    `json:"page_id"`
	Fields      []string  `json:"fields"`
	Endpoint    string    `json:"endpoint,omitempty"`
	Deleted     bool      `json:"deleted"`
	CleanedUpAt time.Time `json:"cleaned_up_at"`
}

type FacebookLeadAdsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FacebookLeadAdsSecretsCredentialResolver struct {
	Secrets FacebookLeadAdsRuntimeSecretResolver
}

func NewFacebookLeadAdsSecretsCredentialResolver(secrets FacebookLeadAdsRuntimeSecretResolver) *FacebookLeadAdsSecretsCredentialResolver {
	return &FacebookLeadAdsSecretsCredentialResolver{Secrets: secrets}
}

func (r *FacebookLeadAdsSecretsCredentialResolver) ResolveFacebookLeadAds(ctx context.Context, _ string, integration Integration) (FacebookLeadAdsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FacebookLeadAdsCredentials{}, fmt.Errorf("facebook lead ads credential resolver is not configured")
	}
	ref := facebookLeadAdsCredentialRef(integration)
	if ref == "" {
		return FacebookLeadAdsCredentials{}, fmt.Errorf("facebook lead ads credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return FacebookLeadAdsCredentials{}, err
	}
	if webhookRef := facebookLeadAdsWebhookSecretRef(integration); webhookRef != "" && webhookRef != ref {
		secret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return FacebookLeadAdsCredentials{}, err
		}
		creds.AppSecret = secret
	}
	return creds, nil
}

func (r *FacebookLeadAdsSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (FacebookLeadAdsCredentials, error) {
	var payload facebookLeadAdsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FacebookLeadAdsCredentials{}, fmt.Errorf("resolve facebook lead ads credentials %q: %w", ref, getErr)
		}
		return parseFacebookLeadAdsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FacebookLeadAdsCredentials{}, fmt.Errorf("resolve facebook lead ads credentials %q: %w", ref, err)
	}
	return parseFacebookLeadAdsCredentialSecret(raw)
}

func (r *FacebookLeadAdsSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload facebookLeadAdsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.appSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve facebook lead ads webhook secret %q: %w", ref, getErr)
		}
		return parseFacebookLeadAdsWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve facebook lead ads webhook secret %q: %w", ref, err)
	}
	return parseFacebookLeadAdsWebhookSecret(raw)
}

type facebookLeadAdsCredentialPayload struct {
	AccessToken   string `json:"access_token"`
	Token         string `json:"token"`
	BearerToken   string `json:"bearer_token"`
	AppSecret     string `json:"app_secret"`
	ClientSecret  string `json:"client_secret"`
	WebhookSecret string `json:"webhook_secret"`
	Secret        string `json:"secret"`
	APIBaseURL    string `json:"api_base_url"`
	UserAgent     string `json:"user_agent"`
}

func (p facebookLeadAdsCredentialPayload) credentials() (FacebookLeadAdsCredentials, error) {
	token := normalizeFacebookLeadAdsBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	if token == "" {
		return FacebookLeadAdsCredentials{}, fmt.Errorf("facebook lead ads access_token is required")
	}
	return FacebookLeadAdsCredentials{
		AccessToken: token,
		AppSecret:   strings.TrimSpace(firstString(p.AppSecret, p.WebhookSecret, p.ClientSecret)),
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func (p facebookLeadAdsCredentialPayload) appSecret() (string, error) {
	secret := strings.TrimSpace(firstString(p.AppSecret, p.WebhookSecret, p.ClientSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("facebook lead ads app_secret is required")
	}
	return secret, nil
}

func parseFacebookLeadAdsCredentialSecret(raw string) (FacebookLeadAdsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FacebookLeadAdsCredentials{}, fmt.Errorf("facebook lead ads credentials are empty")
	}
	var payload facebookLeadAdsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FacebookLeadAdsCredentials{}, fmt.Errorf("parse facebook lead ads credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFacebookLeadAdsKeyValueSecret(raw).credentials()
	}
	return facebookLeadAdsCredentialPayload{AccessToken: normalizeFacebookLeadAdsBearerToken(raw)}.credentials()
}

func parseFacebookLeadAdsWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("facebook lead ads webhook secret is empty")
	}
	if strings.HasPrefix(raw, "{") {
		var payload facebookLeadAdsCredentialPayload
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse facebook lead ads webhook secret JSON: %w", err)
		}
		return payload.appSecret()
	}
	if strings.Contains(raw, "=") {
		return parseFacebookLeadAdsKeyValueSecret(raw).appSecret()
	}
	return raw, nil
}

func parseFacebookLeadAdsKeyValueSecret(raw string) facebookLeadAdsCredentialPayload {
	var payload facebookLeadAdsCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "app_secret":
			payload.AppSecret = value
		case "client_secret":
			payload.ClientSecret = value
		case "webhook_secret":
			payload.WebhookSecret = value
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

func normalizeFacebookLeadAdsBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		return strings.TrimSpace(raw[len("bearer "):])
	}
	return raw
}

func facebookLeadAdsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func facebookLeadAdsWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "app_secret_ref"),
		settingString(integration.Settings, "meta_app_secret_ref"),
	))
}

func (b FacebookLeadAdsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFacebookLeadAds {
		return SyncRequest{}, fmt.Errorf("facebook lead ads backfill requires a Facebook Lead Ads integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("facebook lead ads credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("facebook lead ads form_id is required")
	}
	creds, err := b.Credentials.ResolveFacebookLeadAds(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("facebook lead ads access token is required")
	}
	state, err := decodeFacebookLeadAdsCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: facebookLeadAdsCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderFacebookLeadAds, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, facebookLeadAdsDefaultGraphAPIURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, facebookLeadAdsDefaultUserAgent)
	pageSize := facebookLeadAdsPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	page, err := fetchFacebookLeadAdsLeads(ctx, client, baseURL, creds.AccessToken, userAgent, formID, state.After, pageSize)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(page.Data))}
	for _, item := range page.Data {
		submission := mapFacebookLeadAdsLead(item, integration)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	req.Cursor = nextFacebookLeadAdsCursor(page)
	return req, nil
}

func (r FacebookLeadAdsRESTPageSubscriptionRegistrar) ReconcilePageSubscription(ctx context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionSummary, error) {
	if integration.Provider != ProviderFacebookLeadAds {
		return FacebookLeadAdsPageSubscriptionSummary{}, fmt.Errorf("facebook lead ads page subscription requires a Facebook Lead Ads integration")
	}
	pageID := strings.TrimSpace(settingString(integration.Settings, "page_id"))
	if pageID == "" {
		return FacebookLeadAdsPageSubscriptionSummary{}, fmt.Errorf("facebook lead ads page_id is required")
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return FacebookLeadAdsPageSubscriptionSummary{}, err
	}
	form := url.Values{}
	form.Set("subscribed_fields", "leadgen")
	if _, err := facebookLeadAdsDoGraph(ctx, client, baseURL, creds.AccessToken, userAgent, http.MethodPost, "/"+url.PathEscape(pageID)+"/subscribed_apps", nil, form); err != nil {
		return FacebookLeadAdsPageSubscriptionSummary{}, err
	}
	return FacebookLeadAdsPageSubscriptionSummary{
		PageID:       pageID,
		Fields:       []string{"leadgen"},
		Endpoint:     facebookLeadAdsWebhookEndpoint(appBaseURL),
		Subscribed:   true,
		ReconciledAt: r.now(),
	}, nil
}

func (r FacebookLeadAdsRESTPageSubscriptionRegistrar) CleanupPageSubscription(ctx context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionCleanupSummary, error) {
	if integration.Provider != ProviderFacebookLeadAds {
		return FacebookLeadAdsPageSubscriptionCleanupSummary{}, fmt.Errorf("facebook lead ads page subscription cleanup requires a Facebook Lead Ads integration")
	}
	pageID := strings.TrimSpace(firstString(
		settingString(integration.Settings, "facebook_lead_ads_page_subscription_page_id"),
		settingString(integration.Settings, "page_id"),
	))
	if pageID == "" {
		return FacebookLeadAdsPageSubscriptionCleanupSummary{
			Fields:      []string{"leadgen"},
			Endpoint:    facebookLeadAdsWebhookEndpoint(appBaseURL),
			CleanedUpAt: r.now(),
		}, nil
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return FacebookLeadAdsPageSubscriptionCleanupSummary{}, err
	}
	query := url.Values{}
	query.Set("subscribed_fields", "leadgen")
	if _, err := facebookLeadAdsDoGraph(ctx, client, baseURL, creds.AccessToken, userAgent, http.MethodDelete, "/"+url.PathEscape(pageID)+"/subscribed_apps", query, nil); err != nil {
		return FacebookLeadAdsPageSubscriptionCleanupSummary{}, err
	}
	return FacebookLeadAdsPageSubscriptionCleanupSummary{
		PageID:      pageID,
		Fields:      []string{"leadgen"},
		Endpoint:    facebookLeadAdsWebhookEndpoint(appBaseURL),
		Deleted:     true,
		CleanedUpAt: r.now(),
	}, nil
}

func (r FacebookLeadAdsRESTPageSubscriptionRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, FacebookLeadAdsCredentials, string, error) {
	if r.Credentials == nil {
		return nil, "", FacebookLeadAdsCredentials{}, "", fmt.Errorf("facebook lead ads credential resolver is not configured")
	}
	creds, err := r.Credentials.ResolveFacebookLeadAds(ctx, integration.TenantID, integration)
	if err != nil {
		return nil, "", FacebookLeadAdsCredentials{}, "", err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return nil, "", FacebookLeadAdsCredentials{}, "", fmt.Errorf("facebook lead ads access token is required")
	}
	client := leadEgressClient(r.HTTPClient, ProviderFacebookLeadAds, 30*time.Second)
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, creds.APIBaseURL, facebookLeadAdsDefaultGraphAPIURL), "/")
	userAgent := firstString(r.UserAgent, creds.UserAgent, facebookLeadAdsDefaultUserAgent)
	return client, baseURL, creds, userAgent, nil
}

func (r FacebookLeadAdsRESTPageSubscriptionRegistrar) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func (d *Deps) FacebookLeadAdsWebhookChallenge(w http.ResponseWriter, r *http.Request) {
	expected := ""
	if d != nil {
		expected = strings.TrimSpace(d.FacebookLeadAdsWebhookVerifyToken)
	}
	if expected == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "verify_token_not_configured", "Facebook Lead Ads webhook verify token is not configured")
		return
	}
	mode := strings.TrimSpace(r.URL.Query().Get("hub.mode"))
	token := strings.TrimSpace(r.URL.Query().Get("hub.verify_token"))
	challenge := strings.TrimSpace(r.URL.Query().Get("hub.challenge"))
	if mode != "subscribe" || token == "" || challenge == "" {
		httperror.Write(w, http.StatusBadRequest, "invalid_challenge", "Facebook Lead Ads webhook challenge is missing required hub parameters")
		return
	}
	if !hmac.Equal([]byte(token), []byte(expected)) {
		httperror.Write(w, http.StatusForbidden, "invalid_verify_token", "Facebook Lead Ads webhook verify token did not match")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(challenge))
}

func (d *Deps) FacebookLeadAdsWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, facebookLeadAdsWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Facebook Lead Ads webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeFacebookLeadAdsWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	notifications := facebookLeadAdsWebhookNotifications(payload)
	if len(notifications) == 0 {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	if len(notifications) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "too_many_notifications", "Facebook Lead Ads webhook payload has too many leadgen notifications")
		return
	}
	summaries := make([]SyncSummary, 0, len(notifications))
	replays := 0
	for _, notification := range notifications {
		summary, handled, replay, err := d.handleFacebookLeadAdsWebhookNotification(r.Context(), r, body, notification)
		if err != nil {
			status := http.StatusBadGateway
			code := "provider_fetch_failed"
			switch {
			case errors.Is(err, ErrNotFound):
				status = http.StatusNotFound
				code = "integration_not_found"
			case errors.Is(err, ErrMissingWebhookSecret), errors.Is(err, ErrMissingWebhookSignature), errors.Is(err, ErrInvalidWebhookSignature):
				status = http.StatusUnauthorized
				code = "invalid_signature"
			case strings.Contains(err.Error(), "webhook is already being processed"):
				w.Header().Set("Retry-After", "10")
				status = http.StatusServiceUnavailable
				code = "webhook_in_progress"
			}
			httperror.Write(w, status, code, httperror.MessageForStatus(status))
			return
		}
		if handled {
			summaries = append(summaries, summary)
		} else if replay {
			replays++
		}
	}
	if len(summaries) == 0 && replays == len(notifications) {
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"items": summaries})
}

func (d *Deps) handleFacebookLeadAdsWebhookNotification(ctx context.Context, r *http.Request, body []byte, notification facebookLeadAdsWebhookNotification) (SyncSummary, bool, bool, error) {
	integration, err := d.Repo.FindFacebookLeadAdsIntegrationByPageAndForm(ctx, notification.PageID, notification.FormID)
	if err != nil {
		return SyncSummary{}, false, false, err
	}
	resolver := d.facebookLeadAdsCredentialResolver()
	if resolver == nil {
		return SyncSummary{}, false, false, fmt.Errorf("facebook lead ads credential resolver is not configured")
	}
	creds, err := resolver.ResolveFacebookLeadAds(ctx, integration.TenantID, *integration)
	if err != nil {
		return SyncSummary{}, false, false, err
	}
	if err := VerifyFacebookLeadAdsWebhookSignature(creds.AppSecret, body, r.Header.Get("X-Hub-Signature-256")); err != nil {
		return SyncSummary{}, false, false, err
	}
	webhookID := facebookLeadAdsWebhookID(notification)
	claim, err := d.Repo.ClaimWebhook(ctx, integration.TenantID, integration.ID, ProviderFacebookLeadAds, webhookID, "leadgen", body)
	if err != nil {
		return SyncSummary{}, false, false, err
	}
	switch claim {
	case WebhookProcessed:
		return SyncSummary{}, false, true, nil
	case WebhookInProgress:
		return SyncSummary{}, false, false, errors.New("facebook lead ads webhook is already being processed")
	}
	lead, err := d.fetchFacebookLeadAdsWebhookLead(ctx, *integration, creds, notification.LeadID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(ctx, integration.TenantID, ProviderFacebookLeadAds, webhookID, err)
		return SyncSummary{}, false, false, err
	}
	if lead.FormID != "" && !strings.EqualFold(strings.TrimSpace(lead.FormID), strings.TrimSpace(notification.FormID)) {
		err := fmt.Errorf("facebook lead ads webhook lead form mismatch")
		_ = d.Repo.MarkWebhookFailed(ctx, integration.TenantID, ProviderFacebookLeadAds, webhookID, err)
		return SyncSummary{}, false, false, err
	}
	submission := mapFacebookLeadAdsLead(lead, *integration)
	if submission.Fields == nil {
		submission.Fields = map[string]any{}
	}
	submission.Fields["facebook_lead_ads_webhook_page_id"] = notification.PageID
	submission.Fields["facebook_lead_ads_webhook_form_id"] = notification.FormID
	submission.Fields["facebook_lead_ads_webhook_leadgen_id"] = notification.LeadID
	submission.Fields["facebook_lead_ads_webhook_entry_id"] = notification.EntryID
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "facebook-lead-ads-webhook-" + notification.LeadID,
	})
	started := d.now()
	summary := d.executeSync(ctx, integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(ctx, integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(ctx, integration.TenantID, ProviderFacebookLeadAds, webhookID, err)
		return SyncSummary{}, false, false, err
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "facebook lead ads webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(ctx, integration.TenantID, ProviderFacebookLeadAds, webhookID, err)
		return SyncSummary{}, false, false, err
	}
	if err := d.Repo.MarkWebhookProcessed(ctx, integration.TenantID, ProviderFacebookLeadAds, webhookID); err != nil {
		return SyncSummary{}, false, false, err
	}
	return summary, true, false, nil
}

func (d *Deps) fetchFacebookLeadAdsWebhookLead(ctx context.Context, integration Integration, creds FacebookLeadAdsCredentials, leadID string) (facebookLeadAdsLead, error) {
	if strings.TrimSpace(creds.AccessToken) == "" {
		return facebookLeadAdsLead{}, fmt.Errorf("facebook lead ads access token is required")
	}
	client := d.facebookLeadAdsWebhookHTTPClient()
	baseURL := strings.TrimRight(firstString(creds.APIBaseURL, facebookLeadAdsDefaultGraphAPIURL), "/")
	userAgent := firstString(creds.UserAgent, facebookLeadAdsDefaultUserAgent)
	return fetchFacebookLeadAdsLead(ctx, client, baseURL, creds.AccessToken, userAgent, leadID, integration)
}

func (d *Deps) facebookLeadAdsWebhookHTTPClient() *http.Client {
	if d != nil {
		return leadEgressClient(d.HTTPClient, ProviderFacebookLeadAds, 30*time.Second)
	}
	return leadEgressClient(nil, ProviderFacebookLeadAds, 30*time.Second)
}

type facebookLeadAdsCursorState struct {
	After    string `json:"after,omitempty"`
	Complete bool   `json:"complete,omitempty"`
}

func decodeFacebookLeadAdsCursor(cursor string) (facebookLeadAdsCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return facebookLeadAdsCursorState{}, nil
	}
	if cursor == facebookLeadAdsCursorComplete {
		return facebookLeadAdsCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, facebookLeadAdsCursorPrefix) {
		return facebookLeadAdsCursorState{}, fmt.Errorf("invalid Facebook Lead Ads cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, facebookLeadAdsCursorPrefix))
	if raw == "" {
		return facebookLeadAdsCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return facebookLeadAdsCursorState{}, fmt.Errorf("invalid Facebook Lead Ads cursor")
	}
	var state facebookLeadAdsCursorState
	if err := json.Unmarshal(decoded, &state); err != nil {
		state.After = strings.TrimSpace(string(decoded))
	}
	return state, nil
}

func encodeFacebookLeadAdsCursor(after string) string {
	after = strings.TrimSpace(after)
	if after == "" {
		return facebookLeadAdsCursorComplete
	}
	raw, _ := json.Marshal(facebookLeadAdsCursorState{After: after})
	return facebookLeadAdsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func nextFacebookLeadAdsCursor(page facebookLeadAdsLeadPage) string {
	if strings.TrimSpace(page.Paging.Next) == "" {
		return facebookLeadAdsCursorComplete
	}
	after := strings.TrimSpace(page.Paging.Cursors.After)
	if after == "" {
		after = facebookLeadAdsAfterFromNext(page.Paging.Next)
	}
	return encodeFacebookLeadAdsCursor(after)
}

func facebookLeadAdsAfterFromNext(nextURL string) string {
	u, err := url.Parse(strings.TrimSpace(nextURL))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(u.Query().Get("after"))
}

type facebookLeadAdsLeadPage struct {
	Data   []facebookLeadAdsLead `json:"data"`
	Paging struct {
		Cursors struct {
			After string `json:"after"`
		} `json:"cursors"`
		Next string `json:"next"`
	} `json:"paging"`
}

type facebookLeadAdsLead struct {
	ID           string                     `json:"id"`
	CreatedTime  string                     `json:"created_time"`
	FieldData    []facebookLeadAdsFieldData `json:"field_data"`
	AdID         string                     `json:"ad_id"`
	AdName       string                     `json:"ad_name"`
	AdsetID      string                     `json:"adset_id"`
	AdsetName    string                     `json:"adset_name"`
	CampaignID   string                     `json:"campaign_id"`
	CampaignName string                     `json:"campaign_name"`
	FormID       string                     `json:"form_id"`
	IsOrganic    any                        `json:"is_organic"`
	Platform     string                     `json:"platform"`
}

type facebookLeadAdsFieldData struct {
	Name   string   `json:"name"`
	Values []string `json:"values"`
}

func fetchFacebookLeadAdsLeads(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID, after string, pageSize int) (facebookLeadAdsLeadPage, error) {
	rawURL, err := facebookLeadAdsLeadsURL(baseURL, formID, after, pageSize)
	if err != nil {
		return facebookLeadAdsLeadPage{}, err
	}
	raw, err := facebookLeadAdsDoRaw(ctx, client, rawURL, accessToken, userAgent)
	if err != nil {
		return facebookLeadAdsLeadPage{}, err
	}
	var out facebookLeadAdsLeadPage
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return facebookLeadAdsLeadPage{}, fmt.Errorf("decode facebook lead ads leads response: %w", err)
	}
	return out, nil
}

func fetchFacebookLeadAdsLead(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, leadID string, _ Integration) (facebookLeadAdsLead, error) {
	leadID = strings.TrimSpace(leadID)
	if leadID == "" {
		return facebookLeadAdsLead{}, fmt.Errorf("facebook lead ads leadgen_id is required")
	}
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/" + url.PathEscape(leadID))
	if err != nil {
		return facebookLeadAdsLead{}, err
	}
	query := u.Query()
	query.Set("fields", facebookLeadAdsLeadFields())
	u.RawQuery = query.Encode()
	raw, err := facebookLeadAdsDoRaw(ctx, client, u.String(), accessToken, userAgent)
	if err != nil {
		return facebookLeadAdsLead{}, err
	}
	var out facebookLeadAdsLead
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return facebookLeadAdsLead{}, fmt.Errorf("decode facebook lead ads lead response: %w", err)
	}
	return out, nil
}

func facebookLeadAdsLeadsURL(baseURL, formID, after string, pageSize int) (string, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/" + url.PathEscape(strings.TrimSpace(formID)) + "/leads")
	if err != nil {
		return "", err
	}
	query := u.Query()
	query.Set("fields", facebookLeadAdsLeadFields())
	query.Set("limit", strconv.Itoa(facebookLeadAdsPageSize(pageSize)))
	if strings.TrimSpace(after) != "" {
		query.Set("after", strings.TrimSpace(after))
	}
	u.RawQuery = query.Encode()
	return u.String(), nil
}

func facebookLeadAdsLeadFields() string {
	return strings.Join([]string{
		"id",
		"created_time",
		"field_data",
		"ad_id",
		"ad_name",
		"adset_id",
		"adset_name",
		"campaign_id",
		"campaign_name",
		"form_id",
		"is_organic",
		"platform",
	}, ",")
}

func facebookLeadAdsDoRaw(ctx context.Context, client *http.Client, rawURL, accessToken, userAgent string) ([]byte, error) {
	client = leadEgressClient(client, ProviderFacebookLeadAds, 30*time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, facebookLeadAdsDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, facebookLeadAdsResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return nil, FacebookLeadAdsProviderError{Path: req.URL.Path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: facebookLeadAdsResponseSnippet(raw)}
		}
		return nil, fmt.Errorf("facebook lead ads Graph %s failed %d: %s", req.URL.Path, resp.StatusCode, facebookLeadAdsResponseSnippet(raw))
	}
	return raw, nil
}

func facebookLeadAdsDoGraph(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, form url.Values) ([]byte, error) {
	client = leadEgressClient(client, ProviderFacebookLeadAds, 30*time.Second)
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/" + strings.TrimLeft(path, "/"))
	if err != nil {
		return nil, err
	}
	if query != nil {
		q := u.Query()
		for key, values := range query {
			for _, value := range values {
				q.Add(key, value)
			}
		}
		u.RawQuery = q.Encode()
	}
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, facebookLeadAdsDefaultUserAgent))
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, facebookLeadAdsResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return nil, FacebookLeadAdsProviderError{Path: req.URL.Path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: facebookLeadAdsResponseSnippet(raw)}
		}
		return nil, fmt.Errorf("facebook lead ads Graph %s failed %d: %s", req.URL.Path, resp.StatusCode, facebookLeadAdsResponseSnippet(raw))
	}
	return raw, nil
}

func facebookLeadAdsWebhookEndpoint(appBaseURL string) string {
	if strings.TrimSpace(appBaseURL) == "" {
		return "/api/public/lead-integrations/facebook-lead-ads/webhooks"
	}
	return strings.TrimRight(strings.TrimSpace(appBaseURL), "/") + "/api/public/lead-integrations/facebook-lead-ads/webhooks"
}

type FacebookLeadAdsProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FacebookLeadAdsProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("facebook lead ads Graph %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("facebook lead ads Graph %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapFacebookLeadAdsLead(item facebookLeadAdsLead, integration Integration) SubmissionInput {
	formID := firstString(item.FormID, settingString(integration.Settings, "form_id"))
	fields := map[string]any{
		"facebook_lead_ads_lead_id":       item.ID,
		"facebook_lead_ads_form_id":       formID,
		"facebook_lead_ads_page_id":       settingString(integration.Settings, "page_id"),
		"facebook_lead_ads_account_id":    settingString(integration.Settings, "ad_account_id"),
		"facebook_lead_ads_ad_id":         item.AdID,
		"facebook_lead_ads_ad_name":       item.AdName,
		"facebook_lead_ads_adset_id":      item.AdsetID,
		"facebook_lead_ads_adset_name":    item.AdsetName,
		"facebook_lead_ads_campaign_id":   item.CampaignID,
		"facebook_lead_ads_campaign_name": item.CampaignName,
		"facebook_lead_ads_is_organic":    item.IsOrganic,
		"facebook_lead_ads_platform":      item.Platform,
	}
	identity := typeformIdentity{}
	for _, field := range item.FieldData {
		name := strings.TrimSpace(field.Name)
		if name == "" {
			continue
		}
		value := facebookLeadAdsFieldValue(field.Values)
		fields["facebook_lead_ads_field."+name] = value
		if identityValue := facebookLeadAdsIdentityValue(field.Values); identityValue != "" {
			identity.apply(name, identityValue)
		}
	}
	submittedAt := parseFacebookLeadAdsTime(item.CreatedTime)
	return SubmissionInput{
		SourceID:    facebookLeadAdsSourceID(item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    settingString(integration.Settings, "form_name"),
		EventName:   "lead.submitted",
		Tags:        facebookLeadAdsTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func facebookLeadAdsFieldValue(values []string) any {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return ""
	}
	if len(out) == 1 {
		return out[0]
	}
	return out
}

func facebookLeadAdsIdentityValue(values []string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func facebookLeadAdsSourceID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "facebook-lead-ads://lead/" + id
}

func facebookLeadAdsTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"facebook-lead-ads", "facebook-lead-ads:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func parseFacebookLeadAdsTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05-0700", "2006-01-02T15:04:05-07:00"} {
		if t, err := time.Parse(layout, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func facebookLeadAdsPageSize(size int) int {
	if size <= 0 {
		return facebookLeadAdsDefaultPageSize
	}
	if size > facebookLeadAdsMaxPageSize {
		return facebookLeadAdsMaxPageSize
	}
	return size
}

func facebookLeadAdsResponseSnippet(raw []byte) string {
	value := strings.TrimSpace(string(raw))
	if len(value) > 500 {
		return value[:500]
	}
	return value
}

type facebookLeadAdsWebhookPayload struct {
	Object string                        `json:"object"`
	Entry  []facebookLeadAdsWebhookEntry `json:"entry"`
}

type facebookLeadAdsWebhookEntry struct {
	ID      string                         `json:"id"`
	Time    any                            `json:"time"`
	Changes []facebookLeadAdsWebhookChange `json:"changes"`
}

type facebookLeadAdsWebhookChange struct {
	Field string                          `json:"field"`
	Value facebookLeadAdsWebhookLeadValue `json:"value"`
}

type facebookLeadAdsWebhookLeadValue struct {
	LeadID      string `json:"leadgen_id"`
	LeadgenID   string `json:"lead_id"`
	FormID      string `json:"form_id"`
	PageID      string `json:"page_id"`
	AdID        string `json:"ad_id"`
	AdgroupID   string `json:"adgroup_id"`
	CreatedTime any    `json:"created_time"`
}

type facebookLeadAdsWebhookNotification struct {
	EntryID string
	PageID  string
	FormID  string
	LeadID  string
}

func decodeFacebookLeadAdsWebhookPayload(body []byte) (facebookLeadAdsWebhookPayload, error) {
	var out facebookLeadAdsWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return facebookLeadAdsWebhookPayload{}, fmt.Errorf("decode facebook lead ads webhook body: %w", err)
	}
	return out, nil
}

func facebookLeadAdsWebhookNotifications(payload facebookLeadAdsWebhookPayload) []facebookLeadAdsWebhookNotification {
	out := []facebookLeadAdsWebhookNotification{}
	for _, entry := range payload.Entry {
		entryID := strings.TrimSpace(entry.ID)
		for _, change := range entry.Changes {
			if !strings.EqualFold(strings.TrimSpace(change.Field), "leadgen") {
				continue
			}
			value := change.Value
			notification := facebookLeadAdsWebhookNotification{
				EntryID: entryID,
				PageID:  firstString(value.PageID, entryID),
				FormID:  value.FormID,
				LeadID:  firstString(value.LeadID, value.LeadgenID),
			}
			notification.PageID = strings.TrimSpace(notification.PageID)
			notification.FormID = strings.TrimSpace(notification.FormID)
			notification.LeadID = strings.TrimSpace(notification.LeadID)
			if notification.PageID == "" || notification.FormID == "" || notification.LeadID == "" {
				continue
			}
			out = append(out, notification)
		}
	}
	return out
}

func facebookLeadAdsWebhookID(notification facebookLeadAdsWebhookNotification) string {
	return "page:" + notification.PageID + ":form:" + notification.FormID + ":lead:" + notification.LeadID
}

func VerifyFacebookLeadAdsWebhookSignature(secret string, body []byte, header string) error {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	if secret == "" {
		return ErrMissingWebhookSecret
	}
	if header == "" {
		return ErrMissingWebhookSignature
	}
	signature := strings.TrimSpace(strings.TrimPrefix(header, "sha256="))
	if signature == "" || signature == header && !strings.HasPrefix(header, "sha256=") {
		return ErrMissingWebhookSignature
	}
	expectedMAC := hmac.New(sha256.New, []byte(secret))
	expectedMAC.Write(body)
	expected := hex.EncodeToString(expectedMAC.Sum(nil))
	got, err := hex.DecodeString(signature)
	if err != nil {
		return ErrInvalidWebhookSignature
	}
	want, err := hex.DecodeString(expected)
	if err != nil {
		return ErrInvalidWebhookSignature
	}
	if !hmac.Equal(got, want) {
		return ErrInvalidWebhookSignature
	}
	return nil
}
