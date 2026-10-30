// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type ReplyInput struct {
	SenderProfileID string `json:"sender_profile_id"`
	Body            string `json:"body"`
	MediaURL        string `json:"media_url"`
	ListID          string `json:"list_id"`
}

type ReplyProviderReceipt struct {
	Provider          string `json:"provider"`
	ProviderMessageID string `json:"providerMessageId,omitempty"`
	Status            string `json:"status"`
}

// ReplyMessageReceipt is intentionally content-minimized because the generic
// idempotency store retains the exact response for 24 hours. Phone, body,
// media, metadata, and provider raw payload never enter that replay cache.
type ReplyMessageReceipt struct {
	ID                string     `json:"id"`
	TenantID          string     `json:"tenant_id"`
	SenderProfileID   string     `json:"sender_profile_id"`
	Provider          string     `json:"provider"`
	ProviderMessageID string     `json:"provider_message_id"`
	Direction         string     `json:"direction"`
	Segments          int        `json:"segments"`
	Status            string     `json:"status"`
	CostMicros        int64      `json:"cost_micros"`
	SentAt            *time.Time `json:"sent_at,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
}

type ReplyResponse struct {
	Disposition     string               `json:"disposition"`
	Message         ReplyMessageReceipt  `json:"message"`
	ProviderReceipt ReplyProviderReceipt `json:"providerReceipt"`
}

type ReplyReconciliationResponse struct {
	Disposition     string               `json:"disposition"`
	Code            string               `json:"code"`
	IntentMessageID string               `json:"intentMessageId"`
	ProviderReceipt ReplyProviderReceipt `json:"providerReceipt"`
}

func minimizedReplyMessage(m Message) ReplyMessageReceipt {
	return ReplyMessageReceipt{
		ID: m.ID, TenantID: m.TenantID, SenderProfileID: m.SenderProfileID,
		Provider: m.Provider, ProviderMessageID: m.ProviderMessageID,
		Direction: m.Direction, Segments: m.Segments, Status: m.Status,
		CostMicros: m.CostMicros, SentAt: m.SentAt, CreatedAt: m.CreatedAt,
	}
}

type ReplyBudgetReservation interface {
	Commit(context.Context, ProviderResult) error
	Release(context.Context) error
}

type ReplyBudgetReserver interface {
	ReserveReply(context.Context, string, string, int) (ReplyBudgetReservation, error)
}

type ReplyContractError struct {
	Status  int
	Code    string
	Message string
}

func (e *ReplyContractError) Error() string { return e.Message }

func replyContractError(status int, code, message string) *ReplyContractError {
	return &ReplyContractError{Status: status, Code: code, Message: message}
}

func (s *Store) ResolveReplyListID(ctx context.Context, tenantID, phone, requested string) (string, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var inboundCount int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)::int FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = $2 AND direction = 'inbound'`,
		tenantID, phone).Scan(&inboundCount); err != nil {
		return "", err
	}
	rows, err := tx.Query(ctx, `
SELECT list_id::text
 FROM sms_subscriptions
 WHERE tenant_id = $1::uuid AND phone_e164 = $2
   AND public.sms_subscription_send_eligible(
     tenant_id, list_id, phone_e164, status,
     consent_source, consent_text, consent_at, proof)
 ORDER BY consent_at DESC NULLS LAST, id DESC`, tenantID, phone)
	if err != nil {
		return "", err
	}
	eligible := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return "", err
		}
		eligible = append(eligible, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return "", err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	requested = strings.TrimSpace(requested)
	if requested != "" {
		for _, id := range eligible {
			if id == requested {
				return requested, nil
			}
		}
		return "", replyContractError(http.StatusUnprocessableEntity, "consent_required", "Selected SMS list is not currently opted in for this recipient.")
	}
	if len(eligible) == 0 {
		return "", replyContractError(http.StatusUnprocessableEntity, "consent_required", "No currently opted-in SMS list is available for this recipient.")
	}
	if inboundCount == 0 || len(eligible) != 1 {
		return "", replyContractError(http.StatusUnprocessableEntity, "list_selection_required", "Select a currently opted-in SMS list before sending.")
	}
	return eligible[0], nil
}

type replyIntent struct {
	Message       Message
	DispatchState string
	Created       bool
}

func (s *Store) LoadReplyIntent(ctx context.Context, tenantID, storageKey, requestHash string) (replyIntent, error) {
	if !strings.HasPrefix(storageKey, "scope-v1:") || len(requestHash) != 64 {
		return replyIntent{}, replyContractError(http.StatusServiceUnavailable, "reply_idempotency_unavailable", "durable reply request identity is unavailable")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return replyIntent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var storedHash string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(dispatch_request_hash, '') FROM sms_messages
 WHERE tenant_id = $1::uuid AND dispatch_idempotency_key = $2`, tenantID, storageKey).Scan(&storedHash); err != nil {
		return replyIntent{}, err
	}
	if storedHash == "" || storedHash != requestHash {
		return replyIntent{}, replyContractError(http.StatusUnprocessableEntity, "idempotency_key_request_mismatch", "Idempotency-Key was already used for a different reply request.")
	}
	intent, err := loadReplyIntentTx(ctx, tx, tenantID, storageKey)
	if err != nil {
		return replyIntent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return replyIntent{}, err
	}
	return intent, nil
}

func (s *Store) ReserveReplyIntent(ctx context.Context, tenantID, storageKey, requestHash, phone string, in SendInput, provider string, segments int) (replyIntent, error) {
	if !strings.HasPrefix(storageKey, "scope-v1:") || len(requestHash) != 64 {
		return replyIntent{}, errors.New("reply intent requires principal-scoped idempotency key")
	}
	if !validSMSInboxBody(in.Body, false) {
		return replyIntent{}, ErrSMSBodyOutsideContract
	}
	meta := map[string]any{}
	for key, value := range in.Metadata {
		meta[key] = value
	}
	meta["reply_source"] = "inbox"
	meta["reply_list_id"] = in.ListID
	raw, err := json.Marshal(meta)
	if err != nil {
		return replyIntent{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return replyIntent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenantID+"|"+phone); err != nil {
		return replyIntent{}, err
	}
	if existing, err := loadReplyIntentTx(ctx, tx, tenantID, storageKey); err == nil {
		var storedHash string
		if err := tx.QueryRow(ctx, `SELECT COALESCE(dispatch_request_hash, '') FROM sms_messages WHERE tenant_id = $1::uuid AND dispatch_idempotency_key = $2`, tenantID, storageKey).Scan(&storedHash); err != nil {
			return replyIntent{}, err
		}
		if storedHash == "" || storedHash != requestHash {
			return replyIntent{}, replyContractError(http.StatusUnprocessableEntity, "idempotency_key_request_mismatch", "Idempotency-Key was already used for a different reply.")
		}
		existing.Created = false
		if err := tx.Commit(ctx); err != nil {
			return replyIntent{}, err
		}
		return existing, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return replyIntent{}, err
	}
	var pendingID string
	err = tx.QueryRow(ctx, `
SELECT id::text FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = $2
   AND dispatch_state IN ('reserved','reconciliation_required')
 ORDER BY created_at DESC LIMIT 1`, tenantID, phone).Scan(&pendingID)
	if err == nil {
		return replyIntent{}, replyContractError(http.StatusConflict, "reply_reconciliation_pending", "A prior provider-accepted reply is still being reconciled; do not resend.")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return replyIntent{}, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO sms_messages (
  tenant_id, sender_profile_id, phone_e164, provider, direction, body,
  media_url, segments, status, metadata, dispatch_idempotency_key,
  dispatch_state, dispatch_request_hash
) VALUES (
  $1::uuid, $2::uuid, $3, $4, 'outbound', $5,
  NULLIF($6,''), $7, 'queued', $8::jsonb, $9, 'reserved', $10
)
RETURNING id::text, tenant_id::text, COALESCE(campaign_id::text,''),
          COALESCE(sender_profile_id::text,''), phone_e164, provider,
          COALESCE(provider_message_id,''), direction, body, COALESCE(media_url,''),
          segments, status, COALESCE(error_code,''), COALESCE(error_message,''),
          cost_micros, metadata, sent_at, delivered_at, received_at, created_at`,
		tenantID, in.SenderProfileID, phone, provider, in.Body, in.MediaURL,
		segments, raw, storageKey, requestHash)
	message, err := scanMessageStrict(row)
	if err != nil {
		return replyIntent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return replyIntent{}, err
	}
	return replyIntent{Message: message, DispatchState: "reserved", Created: true}, nil
}

func loadReplyIntentTx(ctx context.Context, tx pgx.Tx, tenantID, storageKey string) (replyIntent, error) {
	var state string
	if err := tx.QueryRow(ctx, `
SELECT dispatch_state FROM sms_messages
 WHERE tenant_id = $1::uuid AND dispatch_idempotency_key = $2`,
		tenantID, storageKey).Scan(&state); err != nil {
		return replyIntent{}, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, COALESCE(campaign_id::text,''),
       COALESCE(sender_profile_id::text,''), phone_e164, provider,
       COALESCE(provider_message_id,''), direction, body, COALESCE(media_url,''),
       segments, status, COALESCE(error_code,''), COALESCE(error_message,''),
       cost_micros, metadata, sent_at, delivered_at, received_at, created_at
  FROM sms_messages
 WHERE tenant_id = $1::uuid AND dispatch_idempotency_key = $2`,
		tenantID, storageKey)
	message, err := scanMessageStrict(row)
	return replyIntent{Message: message, DispatchState: state}, err
}

func (s *Store) FinalizeReplyIntent(ctx context.Context, tenantID, intentID string, result ProviderResult) (Message, error) {
	status, statusOK := classifyProviderDeliveryStatus(result.Status)
	if !statusOK || oneOf(status, "received") {
		return Message{}, errors.New("provider returned an unsupported successful delivery status")
	}
	meta, err := json.Marshal(providerReceiptMetadata(result))
	if err != nil {
		return Message{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Message{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE sms_messages
   SET provider = $3, provider_message_id = NULLIF($4,''),
       status = $5, error_code = NULLIF($6,''), error_message = NULLIF($7,''),
       cost_micros = $8, metadata = metadata || $9::jsonb,
       sent_at = COALESCE(sent_at, now()), dispatch_state = 'persisted'
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND dispatch_state = 'reserved'
RETURNING id::text, tenant_id::text, COALESCE(campaign_id::text,''),
          COALESCE(sender_profile_id::text,''), phone_e164, provider,
          COALESCE(provider_message_id,''), direction, body, COALESCE(media_url,''),
          segments, status, COALESCE(error_code,''), COALESCE(error_message,''),
          cost_micros, metadata, sent_at, delivered_at, received_at, created_at`,
		tenantID, intentID, result.Provider, result.MessageID,
		status, result.ErrorCode,
		result.ErrorMessage, result.PriceMicros, meta)
	message, err := scanMessageStrict(row)
	if err != nil {
		return Message{}, err
	}
	return message, tx.Commit(ctx)
}

func providerReceiptMetadata(result ProviderResult) map[string]any {
	receipt := map[string]any{
		"provider":    result.Provider,
		"message_id":  result.MessageID,
		"status":      defaulted(result.Status, "unknown"),
		"cost_micros": result.PriceMicros,
	}
	if result.ErrorCode != "" {
		receipt["error_code"] = result.ErrorCode
	}
	return map[string]any{"provider_receipt": receipt}
}

func (s *Store) MarkReplyIntentFailed(ctx context.Context, tenantID, intentID, code string) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE sms_messages
   SET status = 'failed', error_code = NULLIF($3,''), dispatch_state = 'provider_failed'
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND dispatch_state = 'reserved'`,
		tenantID, intentID, code)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) MarkReplyIntentReconciliation(ctx context.Context, tenantID, intentID string, result ProviderResult) error {
	status, statusOK := classifyProviderDeliveryStatus(result.Status)
	if !statusOK || status == "received" {
		status = ""
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE sms_messages
	   SET provider = $3, provider_message_id = COALESCE(NULLIF($4,''), provider_message_id),
	       status = COALESCE(NULLIF($5,''), status),
	       dispatch_state = 'reconciliation_required', sent_at = COALESCE(sent_at, now())
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND dispatch_state = 'reserved'`,
		tenantID, intentID, result.Provider, result.MessageID, status)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scanMessageStrict(row scanner) (Message, error) {
	var out Message
	var metaRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.CampaignID, &out.SenderProfileID,
		&out.PhoneE164, &out.Provider, &out.ProviderMessageID, &out.Direction, &out.Body,
		&out.MediaURL, &out.Segments, &out.Status, &out.ErrorCode, &out.ErrorMessage,
		&out.CostMicros, &metaRaw, &out.SentAt, &out.DeliveredAt, &out.ReceivedAt,
		&out.CreatedAt); err != nil {
		return Message{}, err
	}
	if len(metaRaw) > 0 {
		if err := json.Unmarshal(metaRaw, &out.Metadata); err != nil {
			return Message{}, err
		}
	}
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return out, nil
}

func stringValue(value any) string {
	out, _ := value.(string)
	return out
}
