// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrProviderReplayConflict = errors.New("sms provider message id was reused with different content")

// RecordInbound stores an inbound SMS and runs carrier consent and tenant
// keyword rules once. duplicate is true only for a content-identical provider
// retry; identity reuse with different canonical metadata, sender context,
// phone, or body returns ErrProviderReplayConflict.
func (s *Store) RecordInbound(ctx context.Context, tenantID, senderID, provider, from, body, providerMessageID string, metadata map[string]any) (Message, InboundAutoReply, bool, error) {
	return s.recordInbound(ctx, tenantID, senderID, provider, from, body, providerMessageID, metadata, "")
}

// recordInboundProviderClassified is used only after the provider webhook has
// authenticated. It lets provider-native opt-out classification override the
// conservative exact-word fallback without trusting an operator/body parser.
func (s *Store) recordInboundProviderClassified(ctx context.Context, tenantID, senderID, provider, from, body, providerMessageID string, metadata map[string]any, classifiedAction string) (Message, InboundAutoReply, bool, error) {
	return s.recordInbound(ctx, tenantID, senderID, provider, from, body, providerMessageID, metadata, classifiedAction)
}

func (s *Store) recordInbound(ctx context.Context, tenantID, senderID, provider, from, body, providerMessageID string, metadata map[string]any, classifiedAction string) (Message, InboundAutoReply, bool, error) {
	if !validSMSInboxBody(body, false) {
		return Message{}, InboundAutoReply{}, false, ErrSMSBodyOutsideContract
	}
	phone, phoneErr := NormalizePhoneUSCA(from)
	if phoneErr != nil {
		return Message{}, InboundAutoReply{}, false, phoneErr
	}
	provider = defaulted(strings.ToLower(strings.TrimSpace(provider)), ProviderTwilio)
	metadata = inboundProviderEvidence(provider, metadata)
	action := classifiedAction
	if !oneOf(action, ConsentGranted, ConsentRevoked, ConsentHelpRequested) {
		action = ClassifyInbound(body)
	}
	if action == "message" {
		action = ""
	}
	raw, phoneErr := json.Marshal(metadata)
	if phoneErr != nil {
		return Message{}, InboundAutoReply{}, false, phoneErr
	}
	tx, phoneErr := db.WithTenant(ctx, s.Pool, tenantID)
	if phoneErr != nil {
		return Message{}, InboundAutoReply{}, false, phoneErr
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out, phoneErr := scanMessage(tx.QueryRow(ctx, `
		INSERT INTO sms_messages (
			tenant_id, sender_profile_id, phone_e164, provider, provider_message_id,
			direction, body, segments, status, metadata, received_at
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, $3, $4, NULLIF($5, ''),
			'inbound', $6, $7, 'received', $8::jsonb, now()
		)
		ON CONFLICT (tenant_id, provider, provider_message_id) WHERE provider_message_id IS NOT NULL
		DO NOTHING
		RETURNING id::text, tenant_id::text, COALESCE(campaign_id::text, ''),
		          COALESCE(sender_profile_id::text, ''), phone_e164, provider,
		          COALESCE(provider_message_id, ''), direction, body, COALESCE(media_url, ''),
		          segments, status, COALESCE(error_code, ''), COALESCE(error_message, ''),
		          cost_micros, metadata, sent_at, delivered_at, received_at, created_at`,
		tenantID, senderID, phone, provider, providerMessageID, body, SegmentCount(body), raw))
	if errors.Is(phoneErr, pgx.ErrNoRows) {
		out, phoneErr = loadInboundProviderReplay(ctx, tx, tenantID, provider, providerMessageID, phone, senderID, body, raw)
		if phoneErr != nil {
			return Message{}, InboundAutoReply{}, false, phoneErr
		}
		if err := tx.Commit(ctx); err != nil {
			return Message{}, InboundAutoReply{}, false, err
		}
		return out, InboundAutoReply{}, true, nil
	}
	if phoneErr != nil {
		return Message{}, InboundAutoReply{}, false, phoneErr
	}

	reply := InboundAutoReply{}
	if action == "" {
		match, found, err := matchKeywordResponseTx(ctx, tx, tenantID, body)
		if err != nil {
			return Message{}, InboundAutoReply{}, false, err
		}
		if found {
			reply = InboundAutoReply{Matched: true, Keyword: match.Keyword, Action: match.Action, Body: match.ResponseBody}
			action = keywordConsentAction(match.Action)
			// SMS-038: attribute the consent grant to the matched keyword so the
			// keyword's opt-in performance can be counted.
			if action != "" {
				if metadata == nil {
					metadata = map[string]any{}
				}
				metadata["keyword"] = match.Keyword
			}
		}
	}
	if action != "" {
		if err := recordConsentTx(ctx, tx, tenantID, ConsentInput{
			PhoneE164: phone, Action: action, Source: provider, ProofText: body,
			Provider: provider, ProviderEventID: providerMessageID, Metadata: metadata,
		}); err != nil {
			return Message{}, InboundAutoReply{}, false, err
		}
	}
	return out, reply, false, tx.Commit(ctx)
}

func loadInboundProviderReplay(ctx context.Context, tx pgx.Tx, tenantID, provider, providerMessageID, phone, senderID, body string, raw []byte) (Message, error) {
	out, err := scanMessage(tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, COALESCE(campaign_id::text, ''),
		       COALESCE(sender_profile_id::text, ''), phone_e164, provider,
		       COALESCE(provider_message_id, ''), direction, body, COALESCE(media_url, ''),
		       segments, status, COALESCE(error_code, ''), COALESCE(error_message, ''),
		       cost_micros, metadata, sent_at, delivered_at, received_at, created_at
		  FROM sms_messages
		 WHERE tenant_id = $1::uuid
		   AND provider = $2
		   AND provider_message_id = $3`, tenantID, provider, providerMessageID))
	if err != nil {
		return Message{}, err
	}
	storedMetadata, err := json.Marshal(nilMap(out.Metadata))
	if err != nil {
		return Message{}, err
	}
	if out.Direction != "inbound" || out.PhoneE164 != phone || out.Body != body ||
		out.SenderProfileID != strings.TrimSpace(senderID) || !bytes.Equal(storedMetadata, raw) {
		return Message{}, ErrProviderReplayConflict
	}
	return out, nil
}
