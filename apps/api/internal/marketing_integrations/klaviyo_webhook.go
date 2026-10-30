// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const (
	klaviyoWebhookMaxBodyBytes       int64 = 1 << 20
	klaviyoWebhookSignatureTolerance       = 5 * time.Minute
)

var (
	ErrMissingKlaviyoWebhookSecret    = errors.New("klaviyo webhook secret is required")
	ErrMissingKlaviyoWebhookSignature = errors.New("klaviyo webhook signature is required")
	ErrInvalidKlaviyoWebhookSignature = errors.New("invalid klaviyo webhook signature")
	ErrStaleKlaviyoWebhookSignature   = errors.New("stale klaviyo webhook signature")
	ErrMarketingWebhookBodyMismatch   = errors.New("marketing_integrations: webhook body hash mismatch")
)

type KlaviyoWebhookSecretResolver interface {
	Get(context.Context, string) (string, error)
}

type KlaviyoWebhookStore interface {
	FindKlaviyoIntegrationByWebhookToken(ctx context.Context, token string) (*Integration, error)
	ClaimMarketingWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error)
	MarkMarketingWebhookProcessed(ctx context.Context, tenantID, integrationID, provider, webhookID string) error
	MarkMarketingWebhookFailed(ctx context.Context, tenantID, integrationID, provider, webhookID string, err error) error
}

type klaviyoWebhookPayload struct {
	Data []klaviyoWebhookItem `json:"data"`
	Meta struct {
		KlaviyoWebhookID string `json:"klaviyo_webhook_id"`
		KlaviyoAccountID string `json:"klaviyo_account_id"`
		Timestamp        string `json:"timestamp"`
		Version          string `json:"version"`
	} `json:"meta"`
}

type klaviyoWebhookItem struct {
	ExternalID string         `json:"external_id"`
	Topic      string         `json:"topic"`
	Payload    map[string]any `json:"payload"`
}

func (d *Deps) KlaviyoWebhook(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "klaviyo webhook token is required")
		return
	}
	store, ok := d.Repo.(KlaviyoWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "klaviyo webhook storage is not configured")
		return
	}
	integration, err := store.FindKlaviyoIntegrationByWebhookToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "klaviyo integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if integration.Provider != ProviderKlaviyo || marketingIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "klaviyo integration not found")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, klaviyoWebhookMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "klaviyo webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read klaviyo webhook body")
		return
	}
	secret, err := d.klaviyoWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyKlaviyoWebhookSignature(secret, body, r.Header.Get("Klaviyo-Timestamp"), r.Header.Get("Klaviyo-Signature"), d.now()); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	payload, err := decodeKlaviyoWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	webhookID, err := klaviyoWebhookDeliveryID(r.Header.Get("Klaviyo-Webhook-Id"), payload)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_webhook_id", httperror.MessageForStatus(http.StatusBadRequest))
		return
	}
	if err := validateKlaviyoWebhookAccount(integration, payload); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_account", "request authentication failed")
		return
	}
	topic := klaviyoWebhookTopic(payload)
	claim, err := store.ClaimMarketingWebhook(r.Context(), integration.TenantID, integration.ID, ProviderKlaviyo, webhookID, topic, body)
	if err != nil {
		if errors.Is(err, ErrMarketingWebhookBodyMismatch) {
			httperror.Write(w, http.StatusConflict, "webhook_body_mismatch", httperror.MessageForStatus(http.StatusConflict))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "klaviyo webhook is already being processed")
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Metadata: map[string]any{
			"provider":      ProviderKlaviyo,
			"webhook_id":    webhookID,
			"webhook_topic": topic,
		},
	})
	started := d.now()
	summary := klaviyoWebhookSummary(integration, payload, body, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = store.MarkMarketingWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderKlaviyo, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if err := store.MarkMarketingWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderKlaviyo, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) klaviyoWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingKlaviyoWebhookSecret
	}
	ref := firstString(
		settingString(integration.Settings, "klaviyo_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	)
	if ref == "" {
		return "", ErrMissingKlaviyoWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingKlaviyoWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyKlaviyoWebhookSignature(secret string, body []byte, timestampHeader, signatureHeader string, now time.Time) error {
	secret = strings.TrimSpace(secret)
	timestampHeader = strings.TrimSpace(timestampHeader)
	signatureHeader = strings.TrimSpace(signatureHeader)
	if secret == "" {
		return ErrMissingKlaviyoWebhookSecret
	}
	if timestampHeader == "" || signatureHeader == "" {
		return ErrMissingKlaviyoWebhookSignature
	}
	if err := validateKlaviyoWebhookTimestamp(timestampHeader, now); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	_, _ = mac.Write([]byte(timestampHeader))
	expected := hex.EncodeToString(mac.Sum(nil))
	signature := strings.TrimPrefix(strings.TrimPrefix(signatureHeader, "sha256="), "v1=")
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return ErrInvalidKlaviyoWebhookSignature
	}
	return nil
}

func validateKlaviyoWebhookTimestamp(raw string, now time.Time) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ErrMissingKlaviyoWebhookSignature
	}
	if now.IsZero() {
		return nil
	}
	var ts time.Time
	if parsed, err := http.ParseTime(raw); err == nil {
		ts = parsed.UTC()
	} else if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		ts = parsed.UTC()
	} else if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		ts = parsed.UTC()
	} else {
		return ErrStaleKlaviyoWebhookSignature
	}
	now = now.UTC()
	if ts.Before(now.Add(-klaviyoWebhookSignatureTolerance)) || ts.After(now.Add(klaviyoWebhookSignatureTolerance)) {
		return ErrStaleKlaviyoWebhookSignature
	}
	return nil
}

func decodeKlaviyoWebhookPayload(body []byte) (klaviyoWebhookPayload, error) {
	var out klaviyoWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return klaviyoWebhookPayload{}, fmt.Errorf("decode klaviyo webhook JSON: %w", err)
	}
	return out, nil
}

func klaviyoWebhookDeliveryID(header string, payload klaviyoWebhookPayload) (string, error) {
	header = strings.TrimSpace(header)
	bodyID := strings.TrimSpace(payload.Meta.KlaviyoWebhookID)
	if header == "" || bodyID == "" {
		return "", fmt.Errorf("klaviyo webhook id is required in both header and body metadata")
	}
	if !strings.EqualFold(header, bodyID) {
		return "", fmt.Errorf("klaviyo webhook id header/body mismatch")
	}
	return header, nil
}

func validateKlaviyoWebhookAccount(integration *Integration, payload klaviyoWebhookPayload) error {
	expected := firstString(
		settingString(integration.Settings, "account_id"),
		settingString(integration.Settings, "klaviyo_account_id"),
	)
	if expected == "" {
		return nil
	}
	got := strings.TrimSpace(payload.Meta.KlaviyoAccountID)
	if got == "" {
		return fmt.Errorf("klaviyo account id is required")
	}
	if !strings.EqualFold(expected, got) {
		return fmt.Errorf("klaviyo account id mismatch")
	}
	return nil
}

func klaviyoWebhookSummary(integration *Integration, payload klaviyoWebhookPayload, body []byte, req SyncRequest) SyncSummary {
	metadata := cloneMap(req.Metadata)
	evidence := klaviyoWebhookEvidence(payload, body)
	for key, value := range evidence {
		metadata[key] = value
	}
	metadata["sync_model"] = klaviyoNativeSyncModel
	metadata["verification_mode"] = "klaviyo_signed_system_webhook"
	metadata["native_provider_row"] = true
	metadata["native_klaviyo_webhook"] = true
	metadata["webhook_receiver_ready"] = true
	metadata["provider_webhook_subscription"] = "operator_or_allowlisted_app_configured"
	profilesSeen := 0
	if ids, ok := evidence["profile_ids"].([]string); ok {
		profilesSeen = len(ids)
	}
	return SyncSummary{
		IntegrationID: integration.ID,
		Status:        "completed",
		ProfilesSeen:  profilesSeen,
		EventsSeen:    len(payload.Data),
		Metadata:      metadata,
	}
}

func klaviyoWebhookEvidence(payload klaviyoWebhookPayload, body []byte) map[string]any {
	topics := []string{}
	eventIDs := []string{}
	externalIDs := []string{}
	profileIDs := []string{}
	metricIDs := []string{}
	for _, item := range payload.Data {
		topics = appendUniqueLimit(topics, klaviyoWebhookItemTopic(item), 25)
		externalIDs = appendUniqueLimit(externalIDs, item.ExternalID, 25)
		eventIDs = appendUniqueLimit(eventIDs, firstString(
			item.ExternalID,
			klaviyoNestedString(item.Payload, "data", "id"),
			klaviyoNestedString(item.Payload, "data", "attributes", "uuid"),
		), 25)
		profileIDs = appendUniqueLimit(profileIDs, klaviyoNestedString(item.Payload, "data", "relationships", "profile", "data", "id"), 25)
		metricIDs = appendUniqueLimit(metricIDs, klaviyoNestedString(item.Payload, "data", "relationships", "metric", "data", "id"), 25)
	}
	sum := sha256.Sum256(body)
	out := map[string]any{
		"payload_count":      len(payload.Data),
		"body_sha256":        hex.EncodeToString(sum[:]),
		"klaviyo_webhook_id": strings.TrimSpace(payload.Meta.KlaviyoWebhookID),
	}
	if payload.Meta.KlaviyoAccountID != "" {
		out["klaviyo_account_id"] = strings.TrimSpace(payload.Meta.KlaviyoAccountID)
	}
	if payload.Meta.Timestamp != "" {
		out["provider_timestamp"] = strings.TrimSpace(payload.Meta.Timestamp)
	}
	if payload.Meta.Version != "" {
		out["provider_payload_version"] = strings.TrimSpace(payload.Meta.Version)
	}
	if len(topics) > 0 {
		out["webhook_topics"] = topics
	}
	if len(eventIDs) > 0 {
		out["event_ids"] = eventIDs
	}
	if len(externalIDs) > 0 {
		out["external_ids"] = externalIDs
	}
	if len(profileIDs) > 0 {
		out["profile_ids"] = profileIDs
	}
	if len(metricIDs) > 0 {
		out["metric_ids"] = metricIDs
	}
	return out
}

func klaviyoWebhookTopic(payload klaviyoWebhookPayload) string {
	topics := []string{}
	for _, item := range payload.Data {
		topics = appendUniqueLimit(topics, klaviyoWebhookItemTopic(item), 2)
	}
	if len(topics) == 1 {
		return topics[0]
	}
	if len(topics) > 1 {
		return "multiple"
	}
	return "klaviyo.system_webhook"
}

func klaviyoWebhookItemTopic(item klaviyoWebhookItem) string {
	return firstString(
		item.Topic,
		klaviyoNestedString(item.Payload, "topic"),
		klaviyoNestedString(item.Payload, "data", "attributes", "metric_name"),
		"klaviyo.system_webhook",
	)
}

func klaviyoNestedString(root map[string]any, keys ...string) string {
	var current any = root
	for _, key := range keys {
		m, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = m[key]
	}
	return anyString(current)
}

func appendUniqueLimit(values []string, value string, limit int) []string {
	value = strings.TrimSpace(value)
	if value == "" || limit <= 0 || len(values) >= limit {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
