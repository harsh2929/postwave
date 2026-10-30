// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	klaviyoDefaultAPIBaseURL        = "https://a.klaviyo.com/api"
	klaviyoDefaultUserAgent         = "Moosewave Klaviyo Integration"
	klaviyoDefaultWebhookName       = "Moosewave Klaviyo system webhook"
	klaviyoDefaultWebhookDesc       = "Moosewave native Klaviyo system-webhook receiver"
	klaviyoWebhookRegistrationBytes = 64 << 10
)

type KlaviyoWebhookRegistrar interface {
	ReconcileWebhook(context.Context, Integration, string) (KlaviyoWebhookReconcileSummary, error)
	CleanupWebhook(context.Context, Integration, string) (KlaviyoWebhookCleanupSummary, error)
}

type KlaviyoWebhookReconcileSummary struct {
	WebhookID         string    `json:"webhook_id"`
	WebhookToken      string    `json:"webhook_token"`
	Name              string    `json:"name,omitempty"`
	Endpoint          string    `json:"endpoint"`
	Topics            []string  `json:"topics,omitempty"`
	RegisteredAt      time.Time `json:"registered_at"`
	Created           bool      `json:"created,omitempty"`
	Updated           bool      `json:"updated,omitempty"`
	Reused            bool      `json:"reused,omitempty"`
	Repaired          bool      `json:"repaired,omitempty"`
	RepairReason      string    `json:"repair_reason,omitempty"`
	PreviousWebhookID string    `json:"previous_webhook_id,omitempty"`
	Verified          bool      `json:"verified,omitempty"`
	VerifiedAt        time.Time `json:"verified_at,omitempty"`
}

type KlaviyoWebhookCleanupSummary struct {
	WebhookID     string    `json:"webhook_id,omitempty"`
	WebhookToken  string    `json:"webhook_token,omitempty"`
	Endpoint      string    `json:"endpoint,omitempty"`
	Topics        []string  `json:"topics,omitempty"`
	CleanedUpAt   time.Time `json:"cleaned_up_at"`
	Deleted       bool      `json:"deleted,omitempty"`
	NotFound      bool      `json:"not_found,omitempty"`
	Skipped       bool      `json:"skipped,omitempty"`
	SkipReason    string    `json:"skip_reason,omitempty"`
	CleanupReason string    `json:"cleanup_reason,omitempty"`
}

type KlaviyoRESTWebhookRegistrar struct {
	HTTPClient     *http.Client
	Credentials    KlaviyoCredentialResolver
	WebhookSecrets KlaviyoWebhookSecretResolver
	APIBaseURL     string
	UserAgent      string
	Now            func() time.Time
}

func (r KlaviyoRESTWebhookRegistrar) ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (KlaviyoWebhookReconcileSummary, error) {
	if integration.Provider != ProviderKlaviyo {
		return KlaviyoWebhookReconcileSummary{}, fmt.Errorf("klaviyo webhook registration requires a Klaviyo integration")
	}
	appBaseURL = strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if appBaseURL == "" {
		return KlaviyoWebhookReconcileSummary{}, fmt.Errorf("public base URL is required for Klaviyo webhook registration")
	}
	token := klaviyoWebhookRouteToken(integration)
	if token == "" {
		generated, err := newKlaviyoWebhookToken()
		if err != nil {
			return KlaviyoWebhookReconcileSummary{}, err
		}
		token = generated
	}
	topics := klaviyoWebhookConfiguredTopics(integration)
	if len(topics) == 0 {
		return KlaviyoWebhookReconcileSummary{}, fmt.Errorf("klaviyo_webhook_topics is required for managed Klaviyo webhook registration")
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return KlaviyoWebhookReconcileSummary{}, err
	}
	authHeader, err := creds.AuthorizationHeader()
	if err != nil {
		return KlaviyoWebhookReconcileSummary{}, err
	}
	secret, err := r.webhookSecret(ctx, integration)
	if err != nil {
		return KlaviyoWebhookReconcileSummary{}, err
	}
	revision := klaviyoWebhookRevision(integration)
	endpoint := klaviyoWebhookEndpoint(appBaseURL, token)
	name := klaviyoWebhookName(integration)
	description := firstString(settingString(integration.Settings, "klaviyo_webhook_description"), klaviyoDefaultWebhookDesc)
	now := r.now()

	previousWebhookID := strings.TrimSpace(settingString(integration.Settings, "klaviyo_webhook_id"))
	repairReason := ""
	if previousWebhookID != "" {
		hook, err := r.getWebhook(ctx, client, baseURL, authHeader, userAgent, revision, previousWebhookID)
		if err != nil {
			var statusErr klaviyoWebhookHTTPStatusError
			if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusNotFound {
				return KlaviyoWebhookReconcileSummary{}, err
			}
			repairReason = "stored_webhook_not_found"
		} else if klaviyoWebhookMatches(hook, endpoint, topics) {
			return KlaviyoWebhookReconcileSummary{
				WebhookID:    hook.ID,
				WebhookToken: token,
				Name:         firstString(hook.Attributes.Name, name),
				Endpoint:     firstString(hook.Attributes.EndpointURL, endpoint),
				Topics:       klaviyoWebhookResourceTopics(hook),
				RegisteredAt: now,
				Reused:       true,
				Verified:     true,
				VerifiedAt:   now,
			}, nil
		} else {
			hook, err = r.updateWebhook(ctx, client, baseURL, authHeader, userAgent, revision, previousWebhookID, name, description, endpoint, secret, topics)
			if err != nil {
				return KlaviyoWebhookReconcileSummary{}, err
			}
			if err := validateKlaviyoWebhookRegistration(hook, previousWebhookID, endpoint, topics); err != nil {
				return KlaviyoWebhookReconcileSummary{}, err
			}
			return KlaviyoWebhookReconcileSummary{
				WebhookID:         hook.ID,
				WebhookToken:      token,
				Name:              firstString(hook.Attributes.Name, name),
				Endpoint:          firstString(hook.Attributes.EndpointURL, endpoint),
				Topics:            klaviyoWebhookResourceTopics(hook),
				RegisteredAt:      now,
				Updated:           true,
				Repaired:          true,
				RepairReason:      "stored_webhook_drifted",
				PreviousWebhookID: previousWebhookID,
				Verified:          true,
				VerifiedAt:        now,
			}, nil
		}
	}

	if hook, ok, err := r.matchingWebhook(ctx, client, baseURL, authHeader, userAgent, revision, endpoint, topics); err != nil {
		return KlaviyoWebhookReconcileSummary{}, err
	} else if ok {
		return KlaviyoWebhookReconcileSummary{
			WebhookID:         hook.ID,
			WebhookToken:      token,
			Name:              firstString(hook.Attributes.Name, name),
			Endpoint:          firstString(hook.Attributes.EndpointURL, endpoint),
			Topics:            klaviyoWebhookResourceTopics(hook),
			RegisteredAt:      now,
			Reused:            true,
			Repaired:          repairReason != "",
			RepairReason:      repairReason,
			PreviousWebhookID: previousWebhookID,
			Verified:          true,
			VerifiedAt:        now,
		}, nil
	}

	hook, err := r.createWebhook(ctx, client, baseURL, authHeader, userAgent, revision, name, description, endpoint, secret, topics)
	if err != nil {
		return KlaviyoWebhookReconcileSummary{}, err
	}
	if err := validateKlaviyoWebhookRegistration(hook, "", endpoint, topics); err != nil {
		return KlaviyoWebhookReconcileSummary{}, err
	}
	return KlaviyoWebhookReconcileSummary{
		WebhookID:         hook.ID,
		WebhookToken:      token,
		Name:              firstString(hook.Attributes.Name, name),
		Endpoint:          firstString(hook.Attributes.EndpointURL, endpoint),
		Topics:            klaviyoWebhookResourceTopics(hook),
		RegisteredAt:      now,
		Created:           true,
		Repaired:          repairReason != "",
		RepairReason:      repairReason,
		PreviousWebhookID: previousWebhookID,
		Verified:          true,
		VerifiedAt:        now,
	}, nil
}

func (r KlaviyoRESTWebhookRegistrar) CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (KlaviyoWebhookCleanupSummary, error) {
	if integration.Provider != ProviderKlaviyo {
		return KlaviyoWebhookCleanupSummary{}, fmt.Errorf("klaviyo webhook cleanup requires a Klaviyo integration")
	}
	token := klaviyoWebhookRouteToken(integration)
	endpoint := strings.TrimSpace(settingString(integration.Settings, "klaviyo_webhook_endpoint"))
	if endpoint == "" && strings.TrimSpace(appBaseURL) != "" && token != "" {
		endpoint = klaviyoWebhookEndpoint(appBaseURL, token)
	}
	topics := klaviyoWebhookConfiguredTopics(integration)
	webhookID := strings.TrimSpace(settingString(integration.Settings, "klaviyo_webhook_id"))
	now := r.now()
	if webhookID == "" && endpoint == "" {
		return KlaviyoWebhookCleanupSummary{
			WebhookToken:  token,
			Topics:        topics,
			CleanedUpAt:   now,
			Skipped:       true,
			SkipReason:    "missing_webhook_id_and_endpoint",
			CleanupReason: "missing_provider_webhook_evidence",
		}, nil
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return KlaviyoWebhookCleanupSummary{}, err
	}
	authHeader, err := creds.AuthorizationHeader()
	if err != nil {
		return KlaviyoWebhookCleanupSummary{}, err
	}
	revision := klaviyoWebhookRevision(integration)
	if webhookID == "" {
		return r.cleanupMatchingWebhook(ctx, client, baseURL, authHeader, userAgent, revision, token, endpoint, topics, "matched_endpoint_without_stored_id")
	}
	if err := r.deleteWebhook(ctx, client, baseURL, authHeader, userAgent, revision, webhookID); err != nil {
		var statusErr klaviyoWebhookHTTPStatusError
		if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusNotFound {
			return KlaviyoWebhookCleanupSummary{}, err
		}
		if endpoint != "" {
			return r.cleanupMatchingWebhook(ctx, client, baseURL, authHeader, userAgent, revision, token, endpoint, topics, "stored_id_not_found_matched_endpoint")
		}
		return KlaviyoWebhookCleanupSummary{
			WebhookID:     webhookID,
			WebhookToken:  token,
			Endpoint:      endpoint,
			Topics:        topics,
			CleanedUpAt:   now,
			NotFound:      true,
			CleanupReason: "stored_id_not_found",
		}, nil
	}
	return KlaviyoWebhookCleanupSummary{
		WebhookID:     webhookID,
		WebhookToken:  token,
		Endpoint:      endpoint,
		Topics:        topics,
		CleanedUpAt:   now,
		Deleted:       true,
		CleanupReason: "stored_id",
	}, nil
}

func (r KlaviyoRESTWebhookRegistrar) cleanupMatchingWebhook(ctx context.Context, client *http.Client, baseURL, authHeader, userAgent, revision, token, endpoint string, topics []string, reason string) (KlaviyoWebhookCleanupSummary, error) {
	now := r.now()
	hook, ok, err := r.matchingWebhook(ctx, client, baseURL, authHeader, userAgent, revision, endpoint, topics)
	if err != nil {
		return KlaviyoWebhookCleanupSummary{
			WebhookToken:  token,
			Endpoint:      endpoint,
			Topics:        topics,
			CleanedUpAt:   now,
			Skipped:       true,
			SkipReason:    "fallback_lookup_failed",
			CleanupReason: reason + "_fallback_lookup_failed",
		}, nil
	}
	if !ok {
		return KlaviyoWebhookCleanupSummary{
			WebhookToken:  token,
			Endpoint:      endpoint,
			Topics:        topics,
			CleanedUpAt:   now,
			NotFound:      true,
			CleanupReason: reason + "_not_found",
		}, nil
	}
	if err := r.deleteWebhook(ctx, client, baseURL, authHeader, userAgent, revision, hook.ID); err != nil {
		return KlaviyoWebhookCleanupSummary{}, err
	}
	return KlaviyoWebhookCleanupSummary{
		WebhookID:     hook.ID,
		WebhookToken:  token,
		Endpoint:      firstString(hook.Attributes.EndpointURL, endpoint),
		Topics:        klaviyoWebhookResourceTopics(hook),
		CleanedUpAt:   now,
		Deleted:       true,
		CleanupReason: reason,
	}, nil
}

func (r KlaviyoRESTWebhookRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, KlaviyoCredentials, string, error) {
	if r.Credentials == nil {
		return nil, "", KlaviyoCredentials{}, "", fmt.Errorf("klaviyo credential resolver is not configured")
	}
	creds, err := r.Credentials.ResolveKlaviyo(ctx, integration.TenantID, integration)
	if err != nil {
		return nil, "", KlaviyoCredentials{}, "", err
	}
	if _, err := creds.AuthorizationHeader(); err != nil {
		return nil, "", KlaviyoCredentials{}, "", err
	}
	client := marketingEgressClient(r.HTTPClient, ProviderKlaviyo, 30*time.Second)
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, creds.APIBaseURL, klaviyoDefaultAPIBaseURL), "/")
	userAgent := firstString(r.UserAgent, settingString(integration.Settings, "user_agent"), klaviyoDefaultUserAgent)
	return client, baseURL, creds, userAgent, nil
}

func (r KlaviyoRESTWebhookRegistrar) webhookSecret(ctx context.Context, integration Integration) (string, error) {
	if r.WebhookSecrets == nil {
		return "", ErrMissingKlaviyoWebhookSecret
	}
	ref := firstString(
		settingString(integration.Settings, "klaviyo_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	)
	if ref == "" {
		return "", ErrMissingKlaviyoWebhookSecret
	}
	secret, err := r.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingKlaviyoWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func (r KlaviyoRESTWebhookRegistrar) getWebhook(ctx context.Context, client *http.Client, baseURL, authHeader, userAgent, revision, webhookID string) (klaviyoWebhookResource, error) {
	rawURL := strings.TrimRight(baseURL, "/") + "/webhooks/" + url.PathEscape(webhookID) + "?include=webhook-topics"
	raw, _, err := klaviyoWebhookDo(ctx, client, http.MethodGet, rawURL, authHeader, userAgent, revision, nil, http.StatusOK)
	if err != nil {
		return klaviyoWebhookResource{}, err
	}
	out, err := decodeKlaviyoWebhookResponse(raw)
	if err != nil {
		return klaviyoWebhookResource{}, err
	}
	return out.Data, nil
}

func (r KlaviyoRESTWebhookRegistrar) matchingWebhook(ctx context.Context, client *http.Client, baseURL, authHeader, userAgent, revision, endpoint string, topics []string) (klaviyoWebhookResource, bool, error) {
	if strings.TrimSpace(endpoint) == "" {
		return klaviyoWebhookResource{}, false, nil
	}
	rawURL := strings.TrimRight(baseURL, "/") + "/webhooks?include=webhook-topics"
	for pages := 0; pages < 5 && rawURL != ""; pages++ {
		raw, _, err := klaviyoWebhookDo(ctx, client, http.MethodGet, rawURL, authHeader, userAgent, revision, nil, http.StatusOK)
		if err != nil {
			return klaviyoWebhookResource{}, false, err
		}
		out, err := decodeKlaviyoWebhookListResponse(raw)
		if err != nil {
			return klaviyoWebhookResource{}, false, err
		}
		for _, hook := range out.Data {
			if klaviyoWebhookMatches(hook, endpoint, topics) {
				return hook, true, nil
			}
		}
		rawURL = strings.TrimSpace(out.Links.Next)
	}
	return klaviyoWebhookResource{}, false, nil
}

func (r KlaviyoRESTWebhookRegistrar) createWebhook(ctx context.Context, client *http.Client, baseURL, authHeader, userAgent, revision, name, description, endpoint, secret string, topics []string) (klaviyoWebhookResource, error) {
	body := klaviyoWebhookRequestBody("", name, description, endpoint, secret, topics)
	raw, _, err := klaviyoWebhookDo(ctx, client, http.MethodPost, strings.TrimRight(baseURL, "/")+"/webhooks", authHeader, userAgent, revision, bytes.NewReader(body), http.StatusCreated, http.StatusOK)
	if err != nil {
		return klaviyoWebhookResource{}, err
	}
	out, err := decodeKlaviyoWebhookResponse(raw)
	if err != nil {
		return klaviyoWebhookResource{}, err
	}
	return out.Data, nil
}

func (r KlaviyoRESTWebhookRegistrar) updateWebhook(ctx context.Context, client *http.Client, baseURL, authHeader, userAgent, revision, webhookID, name, description, endpoint, secret string, topics []string) (klaviyoWebhookResource, error) {
	body := klaviyoWebhookRequestBody(webhookID, name, description, endpoint, secret, topics)
	rawURL := strings.TrimRight(baseURL, "/") + "/webhooks/" + url.PathEscape(webhookID)
	raw, _, err := klaviyoWebhookDo(ctx, client, http.MethodPatch, rawURL, authHeader, userAgent, revision, bytes.NewReader(body), http.StatusOK)
	if err != nil {
		return klaviyoWebhookResource{}, err
	}
	out, err := decodeKlaviyoWebhookResponse(raw)
	if err != nil {
		return klaviyoWebhookResource{}, err
	}
	return out.Data, nil
}

func (r KlaviyoRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL, authHeader, userAgent, revision, webhookID string) error {
	rawURL := strings.TrimRight(baseURL, "/") + "/webhooks/" + url.PathEscape(webhookID)
	_, _, err := klaviyoWebhookDo(ctx, client, http.MethodDelete, rawURL, authHeader, userAgent, revision, nil, http.StatusNoContent, http.StatusOK)
	return err
}

type klaviyoWebhookHTTPStatusError struct {
	Method     string
	URL        string
	StatusCode int
	Body       string
}

func (e klaviyoWebhookHTTPStatusError) Error() string {
	return fmt.Sprintf("klaviyo webhook API %s %s failed %d: %s", e.Method, e.URL, e.StatusCode, e.Body)
}

func klaviyoWebhookDo(ctx context.Context, client *http.Client, method, rawURL, authHeader, userAgent, revision string, body io.Reader, okStatuses ...int) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", strings.TrimSpace(authHeader))
	req.Header.Set("revision", firstString(revision, klaviyoDefaultAPIRevision))
	req.Header.Set("Accept", "application/vnd.api+json")
	if body != nil {
		req.Header.Set("Content-Type", "application/vnd.api+json")
	}
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, klaviyoWebhookRegistrationBytes))
	if readErr != nil {
		return nil, resp.StatusCode, readErr
	}
	for _, ok := range okStatuses {
		if resp.StatusCode == ok {
			return raw, resp.StatusCode, nil
		}
	}
	return nil, resp.StatusCode, klaviyoWebhookHTTPStatusError{Method: method, URL: rawURL, StatusCode: resp.StatusCode, Body: string(raw)}
}

type klaviyoWebhookResponse struct {
	Data  klaviyoWebhookResource `json:"data"`
	Links struct {
		Next string `json:"next"`
	} `json:"links,omitempty"`
}

type klaviyoWebhookListResponse struct {
	Data  []klaviyoWebhookResource `json:"data"`
	Links struct {
		Next string `json:"next"`
	} `json:"links,omitempty"`
}

type klaviyoWebhookResource struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Attributes struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		EndpointURL string `json:"endpoint_url"`
		Enabled     bool   `json:"enabled"`
		CreatedAt   string `json:"created_at"`
		UpdatedAt   string `json:"updated_at"`
	} `json:"attributes"`
	Relationships struct {
		WebhookTopics struct {
			Data []struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"data"`
		} `json:"webhook-topics"`
	} `json:"relationships"`
}

func decodeKlaviyoWebhookResponse(raw []byte) (klaviyoWebhookResponse, error) {
	var out klaviyoWebhookResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && !errors.Is(err, io.EOF) {
		return klaviyoWebhookResponse{}, fmt.Errorf("decode klaviyo webhook response: %w", err)
	}
	return out, nil
}

func decodeKlaviyoWebhookListResponse(raw []byte) (klaviyoWebhookListResponse, error) {
	var out klaviyoWebhookListResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && !errors.Is(err, io.EOF) {
		return klaviyoWebhookListResponse{}, fmt.Errorf("decode klaviyo webhook list response: %w", err)
	}
	return out, nil
}

func klaviyoWebhookRequestBody(webhookID, name, description, endpoint, secret string, topics []string) []byte {
	relationshipData := make([]map[string]string, 0, len(topics))
	for _, topic := range topics {
		relationshipData = append(relationshipData, map[string]string{"type": "webhook-topic", "id": topic})
	}
	data := map[string]any{
		"type": "webhook",
		"attributes": map[string]any{
			"name":         name,
			"description":  description,
			"endpoint_url": endpoint,
			"secret_key":   secret,
			"enabled":      true,
		},
		"relationships": map[string]any{
			"webhook-topics": map[string]any{"data": relationshipData},
		},
	}
	if webhookID != "" {
		data["id"] = webhookID
	}
	raw, _ := json.Marshal(map[string]any{"data": data})
	return raw
}

func validateKlaviyoWebhookRegistration(hook klaviyoWebhookResource, expectedID, endpoint string, topics []string) error {
	if strings.TrimSpace(hook.ID) == "" {
		return fmt.Errorf("verify klaviyo webhook: missing webhook id")
	}
	if expectedID != "" && hook.ID != expectedID {
		return fmt.Errorf("verify klaviyo webhook %q: provider returned id %q", expectedID, hook.ID)
	}
	if !klaviyoWebhookMatches(hook, endpoint, topics) {
		return fmt.Errorf("verify klaviyo webhook %q: provider registration does not match endpoint/topics", hook.ID)
	}
	return nil
}

func klaviyoWebhookMatches(hook klaviyoWebhookResource, endpoint string, topics []string) bool {
	if strings.TrimSpace(hook.ID) == "" || strings.TrimSpace(endpoint) == "" {
		return false
	}
	if strings.TrimSpace(hook.Attributes.EndpointURL) != endpoint {
		return false
	}
	if len(topics) > 0 && !sameStringSet(klaviyoWebhookResourceTopics(hook), topics) {
		return false
	}
	return true
}

func klaviyoWebhookResourceTopics(hook klaviyoWebhookResource) []string {
	out := []string{}
	for _, item := range hook.Relationships.WebhookTopics.Data {
		out = appendUniqueLimit(out, item.ID, 100)
	}
	sort.Strings(out)
	return out
}

func klaviyoWebhookEndpoint(appBaseURL, token string) string {
	return strings.TrimRight(strings.TrimSpace(appBaseURL), "/") + "/api/public/marketing-integrations/klaviyo/webhooks/" + url.PathEscape(strings.TrimSpace(token))
}

func klaviyoWebhookRouteToken(integration Integration) string {
	return firstString(
		settingString(integration.Settings, "klaviyo_webhook_token"),
		settingString(integration.Settings, "marketing_webhook_token"),
		settingString(integration.Settings, "webhook_token"),
	)
}

func klaviyoWebhookRevision(integration Integration) string {
	return firstString(settingString(integration.Settings, "revision"), settingString(integration.Settings, "api_revision"), klaviyoDefaultAPIRevision)
}

func klaviyoWebhookName(integration Integration) string {
	return firstString(settingString(integration.Settings, "klaviyo_webhook_name"), settingString(integration.Settings, "webhook_name"), klaviyoDefaultWebhookName)
}

func klaviyoWebhookConfiguredTopics(integration Integration) []string {
	return cleanStringList(firstStringSlice(
		integration.Settings["klaviyo_webhook_topics"],
		integration.Settings["webhook_topics"],
		integration.Settings["topics"],
	))
}

func firstStringSlice(values ...any) []string {
	for _, value := range values {
		out := stringSlice(value)
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

func stringSlice(value any) []string {
	switch v := value.(type) {
	case nil:
		return nil
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			out = append(out, anyString(item))
		}
		return out
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		return strings.FieldsFunc(v, func(r rune) bool {
			return r == ',' || r == '\n' || r == '\t'
		})
	default:
		return nil
	}
}

func cleanStringList(values []string) []string {
	out := []string{}
	for _, value := range values {
		out = appendUniqueLimit(out, value, 100)
	}
	sort.Strings(out)
	return out
}

func sameStringSet(left, right []string) bool {
	left = cleanStringList(left)
	right = cleanStringList(right)
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func newKlaviyoWebhookToken() (string, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate klaviyo webhook token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func (r KlaviyoRESTWebhookRegistrar) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}
