// SPDX-License-Identifier: AGPL-3.0-only
//
// review_ingest.go — native review webhook inbound runtime.
//
// Some review desks (push-only programs, and the existing review providers when
// wired by webhook instead of polling) deliver reviews via webhooks. For those,
// the native integration is inbound: a public per-integration ingest URL carrying
// an opaque token resolves the owning tenant (before tenant context exists) via
// an RLS lookup policy, then a tolerant mapper turns the webhook body into a
// canonical ReviewInput and lands it. Mirrors the loyalty/support webhook-ingest
// pattern.
package review_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const reviewIngestMaxBodyBytes = 1 << 20

var ErrMissingReviewWebhookSecret = errors.New("review webhook secret is required")

// ReviewIngestStore resolves a review integration by its public ingest token.
type ReviewIngestStore interface {
	FindReviewIntegrationByIngestToken(ctx context.Context, provider, token string) (*Integration, error)
}

type ReviewWebhookClaimStore interface {
	ClaimReviewWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error)
	MarkReviewWebhookProcessed(ctx context.Context, tenantID, integrationID, provider, webhookID string) error
	MarkReviewWebhookFailed(ctx context.Context, tenantID, integrationID, provider, webhookID string, err error) error
}

// MountPublicRoutes registers the unauthenticated review webhook ingest endpoint
// (per-integration token in the URL).
func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Post("/api/public/review-integrations/{provider}/ingest/{token}", d.ReviewWebhookIngest)
}

// ReviewWebhookIngest receives a provider review webhook on a per-integration
// public URL, resolves the owning tenant by the URL token, verifies the optional
// shared secret, maps the body to a canonical review, and lands it.
func (d *Deps) ReviewWebhookIngest(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "review ingest token is required")
		return
	}
	store, ok := d.Repo.(ReviewIngestStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "ingest_unavailable", "review ingest lookup is not configured")
		return
	}
	integration, err := store.FindReviewIntegrationByIngestToken(r.Context(), provider, token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "review integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if reviewIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "review integration not found")
		return
	}
	if provider != "" && integration.Provider != provider {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "review integration not found")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, reviewIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "review payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ingest body")
		return
	}
	if err := d.verifyReviewWebhook(r, integration, body); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	current, err := d.currentReviewIntegrationForSync(r.Context(), integration.TenantID, integration)
	if err != nil {
		if errors.Is(err, errIntegrationDisconnected) || errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "review integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	integration = current
	webhookID := reviewWebhookMessageID(r)
	webhookTopic := reviewWebhookTopic(r, body)
	var claimStore ReviewWebhookClaimStore
	if webhookID != "" {
		if typed, ok := d.Repo.(ReviewWebhookClaimStore); ok {
			claimStore = typed
			claim, err := claimStore.ClaimReviewWebhook(r.Context(), integration.TenantID, integration.ID, integration.Provider, webhookID, webhookTopic, body)
			if err != nil {
				if errors.Is(err, ErrReviewWebhookBodyMismatch) {
					httperror.Write(w, http.StatusConflict, "webhook_body_mismatch", "review webhook delivery body does not match the previously claimed message")
					return
				}
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			switch claim {
			case WebhookProcessed:
				writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
				return
			case WebhookInProgress:
				w.Header().Set("Retry-After", "10")
				httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "review webhook is already being processed")
				return
			}
		}
	}
	req, ok := mapReviewWebhookWithProviderEvent(integration.Provider, body, r.Header.Get("X-Yotpo-Webhooks-Event-Type"))
	if !ok {
		if claimStore != nil {
			if err := claimStore.MarkReviewWebhookProcessed(r.Context(), integration.TenantID, integration.ID, integration.Provider, webhookID); err != nil {
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	req = normalizeSyncRequest(req)
	current, err = d.currentReviewIntegrationForSync(r.Context(), integration.TenantID, integration)
	if err != nil {
		if claimStore != nil {
			_ = claimStore.MarkReviewWebhookFailed(r.Context(), integration.TenantID, integration.ID, integration.Provider, webhookID, err)
		}
		if errors.Is(err, errIntegrationDisconnected) || errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "review integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	integration = current
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		if claimStore != nil {
			_ = claimStore.MarkReviewWebhookFailed(r.Context(), integration.TenantID, integration.ID, integration.Provider, webhookID, err)
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "review webhook processing failed"))
		if claimStore != nil {
			_ = claimStore.MarkReviewWebhookFailed(r.Context(), integration.TenantID, integration.ID, integration.Provider, webhookID, err)
		}
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if claimStore != nil {
		if err := claimStore.MarkReviewWebhookProcessed(r.Context(), integration.TenantID, integration.ID, integration.Provider, webhookID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
	}
	writeJSON(w, http.StatusAccepted, summary)
}

// verifyReviewWebhook validates the optional webhook secret. The per-integration
// URL token is the primary auth (unguessable); a configured webhook_secret_ref
// adds a generic shared-secret header compare (Authorization: Bearer / X-Webhook-
// Secret). An empty secret — or a nil resolver — disables verification.
func (d *Deps) verifyReviewWebhook(r *http.Request, integration *Integration, _ []byte) error {
	ref := strings.TrimSpace(settingString(integration.Settings, "webhook_secret_ref"))
	if ref == "" {
		return nil
	}
	if d.WebhookSecrets == nil {
		return ErrMissingReviewWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(r.Context(), ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return ErrMissingReviewWebhookSecret
	}
	got := strings.TrimSpace(r.Header.Get("Authorization"))
	if rest, found := strings.CutPrefix(got, "Bearer "); found {
		got = strings.TrimSpace(rest)
	}
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Webhook-Secret"))
	}
	if !hmac.Equal([]byte(got), []byte(strings.TrimSpace(secret))) {
		return fmt.Errorf("review webhook secret mismatch")
	}
	return nil
}

func reviewWebhookMessageID(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		r.Header.Get("WebhookMessageId"),
		r.Header.Get("WebhookMessageIdPerTarget"),
		r.Header.Get("X-Yotpo-Webhooks-Message-Id"),
		r.Header.Get("X-Webhook-Id"),
		r.Header.Get("X-Request-Id"),
	))
}

func reviewWebhookTopic(r *http.Request, body []byte) string {
	if r != nil {
		if topic := strings.TrimSpace(firstString(
			r.Header.Get("X-Yotpo-Webhooks-Event-Type"),
			r.Header.Get("X-Webhook-Topic"),
		)); topic != "" {
			return topic
		}
	}
	if event := reviewWebhookBodyEvent(body); event != "" {
		return event
	}
	return "review.webhook"
}

func reviewWebhookBodyEvent(body []byte) string {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return ""
	}
	return strings.TrimSpace(reviewWebhookString(raw, "event"))
}

// mapReviewWebhook tolerantly turns a review webhook body into a canonical review.
// Field locations vary by provider, so it probes common paths for email, rating,
// title, body, status, and product. Returns false when no reviewer email is
// present. The status is defaulted to "approved" (a value ValidateReview accepts)
// when the payload omits it, so a webhook-delivered review without an explicit
// moderation state still lands.
func mapReviewWebhook(provider string, body []byte) (SyncRequest, bool) {
	return mapReviewWebhookWithProviderEvent(provider, body, "")
}

func mapReviewWebhookWithProviderEvent(provider string, body []byte, providerEvent string) (SyncRequest, bool) {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return SyncRequest{}, false
	}
	if provider == ProviderYotpo {
		bodyEvent := strings.ToLower(strings.TrimSpace(reviewWebhookString(raw, "event")))
		headerEvent := strings.ToLower(strings.TrimSpace(providerEvent))
		if bodyEvent != "" && headerEvent != "" && bodyEvent != headerEvent {
			return SyncRequest{}, false
		}
		event := firstString(bodyEvent, headerEvent)
		if event != "" && event != "review_create" && event != "review_updated" {
			return SyncRequest{}, false
		}
		if event != "" {
			return mapYotpoReviewWebhook(raw, event)
		}
		if req, ok := mapYotpoReviewWebhook(raw, ""); ok {
			return req, true
		}
	}
	email := strings.ToLower(strings.TrimSpace(firstString(
		reviewWebhookString(raw, "email"),
		reviewWebhookString(raw, "reviewer_email"),
		reviewWebhookString(raw, "reviewer", "email"),
		reviewWebhookString(raw, "customer_email"),
		reviewWebhookString(raw, "customer", "email"),
		reviewWebhookString(raw, "author", "email"),
		reviewWebhookString(raw, "data", "email"),
		reviewWebhookString(raw, "data", "reviewer_email"),
		reviewWebhookString(raw, "data", "reviewer", "email"),
		reviewWebhookString(raw, "review", "email"),
		reviewWebhookString(raw, "review", "reviewer", "email"),
	)))
	if email == "" {
		return SyncRequest{}, false
	}
	rating := reviewWebhookInt(raw,
		[]string{"rating"}, []string{"score"}, []string{"stars"},
		[]string{"review", "rating"}, []string{"review", "score"},
		[]string{"data", "rating"}, []string{"data", "score"},
	)
	title := strings.TrimSpace(firstString(
		reviewWebhookString(raw, "title"),
		reviewWebhookString(raw, "review", "title"),
		reviewWebhookString(raw, "data", "title"),
		reviewWebhookString(raw, "subject"),
	))
	bodyText := strings.TrimSpace(firstString(
		reviewWebhookString(raw, "body"),
		reviewWebhookString(raw, "content"),
		reviewWebhookString(raw, "text"),
		reviewWebhookString(raw, "message"),
		reviewWebhookString(raw, "review", "body"),
		reviewWebhookString(raw, "review", "content"),
		reviewWebhookString(raw, "data", "body"),
		reviewWebhookString(raw, "data", "content"),
	))
	status := mapReviewWebhookStatus(strings.TrimSpace(firstString(
		reviewWebhookString(raw, "status"),
		reviewWebhookString(raw, "state"),
		reviewWebhookString(raw, "review", "status"),
		reviewWebhookString(raw, "data", "status"),
	)))
	product := strings.TrimSpace(firstString(
		reviewWebhookString(raw, "product_id"),
		reviewWebhookString(raw, "product_external_id"),
		reviewWebhookString(raw, "product", "id"),
		reviewWebhookString(raw, "review", "product_id"),
		reviewWebhookString(raw, "data", "product_id"),
	))
	reviewerName := strings.TrimSpace(firstString(
		reviewWebhookString(raw, "reviewer_name"),
		reviewWebhookString(raw, "reviewer", "name"),
		reviewWebhookString(raw, "name"),
		reviewWebhookString(raw, "author", "name"),
		reviewWebhookString(raw, "review", "reviewer", "name"),
	))
	sourceID := strings.TrimSpace(firstString(
		reviewWebhookString(raw, "id"),
		reviewWebhookString(raw, "review_id"),
		reviewWebhookString(raw, "review", "id"),
		reviewWebhookString(raw, "data", "id"),
	))
	if sourceID == "" {
		sourceID = email
	}
	review := ReviewInput{
		SourceID:      provider + "://webhook/" + sourceID,
		ProductID:     product,
		ReviewerName:  reviewerName,
		ReviewerEmail: email,
		Rating:        rating,
		Title:         title,
		Body:          bodyText,
		ReviewType:    "product",
		Status:        status,
		EventName:     "review.submitted",
	}
	return SyncRequest{RunMode: "webhook", Reviews: []ReviewInput{review}}, true
}

func mapYotpoReviewWebhook(raw map[string]any, eventOverride string) (SyncRequest, bool) {
	event := strings.TrimSpace(firstString(reviewWebhookString(raw, "event"), eventOverride))
	normalizedEvent := strings.ToLower(event)
	if normalizedEvent != "" && normalizedEvent != "review_create" && normalizedEvent != "review_updated" {
		return SyncRequest{}, false
	}
	email := strings.ToLower(strings.TrimSpace(firstString(
		reviewWebhookString(raw, "data", "customer_email"),
		reviewWebhookString(raw, "data", "email"),
		reviewWebhookString(raw, "data", "reviewer_email"),
	)))
	if email == "" {
		return SyncRequest{}, false
	}
	rating := reviewWebhookInt(raw, []string{"data", "score"}, []string{"data", "rating"})
	if rating < 1 || rating > 5 {
		return SyncRequest{}, false
	}
	sourceID := strings.TrimSpace(firstString(
		reviewWebhookString(raw, "data", "id"),
		reviewWebhookString(raw, "id"),
	))
	if sourceID == "" {
		sourceID = email
	}
	externalProductID := strings.TrimSpace(reviewWebhookString(raw, "data", "external_product_id"))
	providerProductID := strings.TrimSpace(reviewWebhookString(raw, "data", "product_id"))
	externalOrderID := strings.TrimSpace(reviewWebhookString(raw, "data", "external_order_id"))
	providerOrderID := strings.TrimSpace(reviewWebhookString(raw, "data", "order_id"))
	externalCustomerID := strings.TrimSpace(reviewWebhookString(raw, "data", "external_customer_id"))
	providerCustomerID := strings.TrimSpace(firstString(
		reviewWebhookString(raw, "data", "customer_id"),
		reviewWebhookString(raw, "data", "customer", "id"),
		reviewWebhookString(raw, "data", "user_id"),
	))
	status := mapReviewWebhookStatus(reviewWebhookString(raw, "data", "status"))
	if reviewWebhookBool(raw, "data", "deleted") || reviewWebhookBool(raw, "data", "archived") {
		status = "archived"
	}
	submittedRaw := firstString(
		reviewWebhookString(raw, "data", "created_at"),
		reviewWebhookString(raw, "data", "updated_at"),
	)
	if normalizedEvent == "review_updated" {
		submittedRaw = firstString(
			reviewWebhookString(raw, "data", "updated_at"),
			reviewWebhookString(raw, "data", "created_at"),
		)
	}
	metadata := map[string]any{
		"webhook_source": "yotpo",
	}
	if event != "" {
		metadata["webhook_event"] = event
		metadata["yotpo_event"] = event
	}
	if appKey := strings.TrimSpace(reviewWebhookString(raw, "data", "app_key")); appKey != "" {
		metadata["yotpo_app_key"] = appKey
	}
	if productTitle := strings.TrimSpace(reviewWebhookString(raw, "data", "product_title")); productTitle != "" {
		metadata["product_title"] = productTitle
	}
	if externalProductID != "" {
		metadata["external_product_id"] = externalProductID
	}
	if providerProductID != "" {
		metadata["provider_product_id"] = providerProductID
	}
	if language := strings.TrimSpace(reviewWebhookString(raw, "data", "language")); language != "" {
		metadata["language"] = language
	}
	if externalOrderID != "" {
		metadata["external_order_id"] = externalOrderID
	}
	if providerOrderID != "" {
		metadata["provider_order_id"] = providerOrderID
	}
	if externalCustomerID != "" {
		metadata["external_customer_id"] = externalCustomerID
	}
	if providerCustomerID != "" {
		metadata["provider_customer_id"] = providerCustomerID
	}
	eventName := "review.submitted"
	if normalizedEvent == "review_updated" {
		eventName = "review.updated"
	}
	review := ReviewInput{
		SourceID:      "yotpo://review/" + sourceID,
		ReviewerName:  strings.TrimSpace(reviewWebhookString(raw, "data", "reviewer_display_name")),
		ReviewerEmail: email,
		Rating:        rating,
		Title:         strings.TrimSpace(reviewWebhookString(raw, "data", "title")),
		Body:          strings.TrimSpace(reviewWebhookString(raw, "data", "content")),
		ReviewType:    "product",
		Status:        status,
		VerifiedBuyer: reviewWebhookBool(raw, "data", "verified_buyer"),
		EventName:     eventName,
		Metadata:      metadata,
		RawPayload:    raw,
		SubmittedAt:   parseReviewTime(submittedRaw),
	}
	return SyncRequest{RunMode: "webhook", Reviews: []ReviewInput{review}}, true
}

// mapReviewWebhookStatus normalizes a provider review status to one ValidateReview
// accepts (pending, approved, rejected, spam, archived). An unknown or empty
// status defaults to "approved" so a webhook-delivered review still lands.
func mapReviewWebhookStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "pending", "unmoderated", "in_review", "awaiting":
		return "pending"
	case "rejected", "declined", "denied":
		return "rejected"
	case "spam":
		return "spam"
	case "archived", "hidden", "deleted":
		return "archived"
	default:
		return "approved"
	}
}

func reviewWebhookString(node map[string]any, path ...string) string {
	cur := any(node)
	for i, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		v, ok := m[key]
		if !ok || v == nil {
			return ""
		}
		if i == len(path)-1 {
			switch typed := v.(type) {
			case string:
				return strings.TrimSpace(typed)
			case float64:
				return strings.TrimSpace(fmt.Sprint(typed))
			case json.Number:
				return strings.TrimSpace(typed.String())
			default:
				return ""
			}
		}
		cur = v
	}
	return ""
}

func reviewWebhookBool(node map[string]any, path ...string) bool {
	cur := any(node)
	for i, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		v, ok := m[key]
		if !ok || v == nil {
			return false
		}
		if i == len(path)-1 {
			switch typed := v.(type) {
			case bool:
				return typed
			case string:
				switch strings.ToLower(strings.TrimSpace(typed)) {
				case "1", "true", "yes":
					return true
				default:
					return false
				}
			case float64:
				return typed != 0
			case json.Number:
				n, err := typed.Int64()
				return err == nil && n != 0
			default:
				return false
			}
		}
		cur = v
	}
	return false
}

func reviewWebhookInt(node map[string]any, paths ...[]string) int {
	for _, path := range paths {
		cur := any(node)
		ok := true
		for i, key := range path {
			m, isMap := cur.(map[string]any)
			if !isMap {
				ok = false
				break
			}
			v, present := m[key]
			if !present || v == nil {
				ok = false
				break
			}
			if i == len(path)-1 {
				switch typed := v.(type) {
				case float64:
					return int(typed)
				case int:
					return typed
				case json.Number:
					if n, err := typed.Int64(); err == nil {
						return int(n)
					}
				case string:
					if n, err := parseReviewInt(typed); err == nil {
						return n
					}
				}
				ok = false
				break
			}
			cur = v
		}
		_ = ok
	}
	return 0
}

func parseReviewInt(value string) (int, error) {
	value = strings.TrimSpace(value)
	var n int
	_, err := fmt.Sscanf(value, "%d", &n)
	return n, err
}
