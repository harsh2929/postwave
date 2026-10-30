// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Provider delivery-status ingestion and click-tracking link tokens.

// UpdateDeliveryStatus records a provider delivery receipt. The provider's own
// error text is deliberately ignored (the parameter is kept for call-site
// symmetry): only a normalized, operator-safe message derived from the
// validated error code and status is ever stored.
func (s *Store) UpdateDeliveryStatus(ctx context.Context, tenantID, senderProfileID, provider, providerMessageID, status, errorCode, _ string, metadata map[string]any) (Message, error) {
	if strings.TrimSpace(providerMessageID) == "" {
		return Message{}, fmt.Errorf("provider message id is required")
	}
	if !validCanonicalUUIDV4(senderProfileID) {
		return Message{}, fmt.Errorf("canonical sender profile id is required")
	}
	provider = defaulted(strings.ToLower(strings.TrimSpace(provider)), ProviderTwilio)
	rawStatus := strings.ToLower(strings.TrimSpace(status))
	status = normalizeStatus(rawStatus)
	if status == "queued" && rawStatus != "queued" {
		return Message{}, fmt.Errorf("unsupported provider delivery status %q", rawStatus)
	}
	errorCode = safeInboxProviderCode(errorCode)
	var errorMessage string
	if errorCode != "" {
		errorMessage = "Delivery was not completed (provider code " + errorCode + ")."
	} else if oneOf(status, "failed", "undelivered", "canceled") {
		errorMessage = "Delivery was not completed by the provider."
	}
	// Webhook metadata is authenticated provider input, not trusted operator
	// text. Retain only the normalized receipt, never the raw payload/body.
	raw, err := json.Marshal(map[string]any{"delivery_receipt": map[string]any{
		"provider": provider, "status": status, "error_code": errorCode,
	}})
	if err != nil {
		return Message{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Message{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := scanMessage(tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, COALESCE(campaign_id::text, ''),
		       COALESCE(sender_profile_id::text, ''), phone_e164, provider,
		       COALESCE(provider_message_id, ''), direction, body, COALESCE(media_url, ''),
		       segments, status, COALESCE(error_code, ''), COALESCE(error_message, ''),
		       cost_micros, metadata, sent_at, delivered_at, received_at, created_at
		  FROM sms_messages
		 WHERE tenant_id = $1::uuid AND sender_profile_id = $2::uuid
		   AND provider = $3 AND provider_message_id = $4
		   AND direction = 'outbound'
		 FOR UPDATE`, tenantID, senderProfileID, provider, providerMessageID))
	if err != nil {
		return Message{}, err
	}
	if current.Status == status || !deliveryStatusTransitionAllowed(current.Status, status) {
		if err := tx.Commit(ctx); err != nil {
			return Message{}, err
		}
		return current, nil
	}
	row := tx.QueryRow(ctx, `
		UPDATE sms_messages
		   SET provider_message_id = COALESCE(provider_message_id, NULLIF($4, '')),
		       status = $5,
		       error_code = NULLIF($6, ''),
		       error_message = NULLIF($7, ''),
		       delivered_at = CASE WHEN $5 = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
		       sent_at = CASE WHEN dispatch_state IN ('reserved','reconciliation_required') THEN COALESCE(sent_at, now()) ELSE sent_at END,
		       -- A provider callback is delivery evidence, not proof that the
		       -- reply budget/intent settlement committed. Keep unresolved reply
		       -- intents held until one reconciliation owner settles both ledgers.
		       dispatch_state = dispatch_state,
		       metadata = metadata || $8::jsonb
		 WHERE tenant_id = $1::uuid
		   AND sender_profile_id = $2::uuid
		   AND provider = $3
		   AND provider_message_id = $4
		   AND direction = 'outbound'
		RETURNING id::text, tenant_id::text, COALESCE(campaign_id::text, ''),
		          COALESCE(sender_profile_id::text, ''), phone_e164, provider,
		          COALESCE(provider_message_id, ''), direction, body, COALESCE(media_url, ''),
		          segments, status, COALESCE(error_code, ''), COALESCE(error_message, ''),
		          cost_micros, metadata, sent_at, delivered_at, received_at, created_at`,
		tenantID, senderProfileID, provider, providerMessageID, status, errorCode, errorMessage, raw)
	out, err := scanMessage(row)
	if err != nil {
		return Message{}, err
	}
	return out, tx.Commit(ctx)
}

func deliveryStatusTransitionAllowed(from, to string) bool {
	from = normalizeStatus(from)
	to = normalizeStatus(to)
	if from == to {
		return true
	}
	// Provider retries arrive out of order. Once a provider reports a terminal
	// outcome, a later queued/sent/conflicting terminal callback is evidence to
	// retain, not authority to rewrite the operator-visible outcome.
	if from == "delivered" && to == "read" {
		return true
	}
	if oneOf(from, "delivered", "read", "failed", "undelivered", "partially_delivered", "canceled") {
		return false
	}
	rank := map[string]int{
		// Twilio may report accepted before scheduled/queued. A normal
		// accepted->queued callback is forward progress; a late accepted event
		// must not downgrade an already queued message.
		"accepted":  0,
		"scheduled": 1,
		"queued":    2,
		"sent":      3,
	}
	if oneOf(to, "delivered", "read", "failed", "undelivered", "partially_delivered", "canceled") {
		return true
	}
	return rank[to] > rank[from]
}

func (s *Store) CreateLinkTokens(ctx context.Context, tenantID, campaignID, phone string, urls []string, publicBaseURL string) (map[string]string, error) {
	if len(urls) == 0 || publicBaseURL == "" {
		return nil, nil
	}
	replacements := map[string]string{}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, rawURL := range urls {
		targetURL, ok := safeTrackedSMSLink(rawURL)
		if !ok {
			continue
		}
		token, err := NewLinkToken()
		if err != nil {
			return nil, err
		}
		shortURL := PublicClickURL(publicBaseURL, token)
		if shortURL == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO sms_link_tokens (
				tenant_id, campaign_id, phone_e164, token, url
				) VALUES (
					$1::uuid, NULLIF($2, '')::uuid, $3, $4, $5
				)`, tenantID, campaignID, phone, token, targetURL); err != nil {
			return nil, err
		}
		replacements[rawURL] = shortURL
	}
	return replacements, tx.Commit(ctx)
}

func (s *Store) AttachLinkTokens(ctx context.Context, tenantID, campaignID, phone, messageID string) error {
	if campaignID == "" || messageID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE sms_link_tokens
		   SET message_id = $4::uuid
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		   AND phone_e164 = $3
		   AND message_id IS NULL`, tenantID, campaignID, phone, messageID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RecordClick(ctx context.Context, token string, metadata map[string]any) (string, error) {
	if !s.SMSClickResolverIdentityAvailable {
		return "", ErrSMSClickResolverUnavailable
	}
	if strings.TrimSpace(token) == "" {
		return "", fmt.Errorf("token is required")
	}
	raw, err := json.Marshal(nilMap(metadata))
	if err != nil {
		return "", err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tenantID, campaignID, messageID, phone, target string
	if err := tx.QueryRow(ctx, `
		SELECT tenant_id::text, COALESCE(campaign_id::text, ''), COALESCE(message_id::text, ''),
		       phone_e164, url
			  FROM sms_link_tokens
			 WHERE token = $1`, token).Scan(&tenantID, &campaignID, &messageID, &phone, &target); err != nil {
		return "", err
	}
	target, ok := safeTrackedSMSLink(target)
	if !ok {
		return "", fmt.Errorf("tracked link target is unsafe")
	}
	if _, err := tx.Exec(ctx, `
			INSERT INTO sms_link_clicks (
				tenant_id, campaign_id, message_id, phone_e164, url, metadata
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4, $5, $6::jsonb
		)`, tenantID, campaignID, messageID, phone, target, raw); err != nil {
		return "", err
	}
	return target, tx.Commit(ctx)
}

func normalizeStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "accepted":
		return "accepted"
	case "scheduled":
		return "scheduled"
	case "queued":
		return "queued"
	case "sent", "sending", "message-sending", "message-sent":
		return "sent"
	case "delivered", "message-delivered":
		return "delivered"
	case "failed", "delivery_failed", "sending_failed", "message-failed":
		return "failed"
	case "undelivered", "delivery_unconfirmed":
		return "undelivered"
	case "receiving", "received":
		return "received"
	case "read":
		return "read"
	case "partially_delivered":
		return "partially_delivered"
	case "canceled", "cancelled":
		return "canceled"
	default:
		return "queued"
	}
}

// classifyProviderDeliveryStatus is the fail-closed parser used at provider
// callback and successful-send boundaries. normalizeStatus intentionally
// remains the legacy display normalizer; it must not turn an unknown carrier
// value into authority to persist a queued outcome.
func classifyProviderDeliveryStatus(status string) (string, bool) {
	raw := strings.ToLower(strings.TrimSpace(status))
	if raw == "" {
		return "", false
	}
	normalized := normalizeStatus(raw)
	if normalized == "queued" && raw != "queued" {
		return "", false
	}
	return normalized, oneOf(normalized,
		"accepted", "scheduled", "queued", "sent", "delivered", "failed",
		"undelivered", "received", "read", "partially_delivered", "canceled")
}
