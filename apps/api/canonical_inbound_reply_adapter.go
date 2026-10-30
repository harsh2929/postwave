// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/inbound_email"
	"github.com/postwave/postwave/apps/api/internal/replies"
)

// canonicalInboundReplyWriter converts the tenant-slug inbound envelope into
// the same canonical reply store used by provider webhooks. The inbound_email
// package owns the surrounding transaction and immutable link; this adapter
// owns only the vocabulary conversion, avoiding a package cycle.
type canonicalInboundReplyWriter struct {
	Store *replies.Store
}

func (writer canonicalInboundReplyWriter) RequiresWorkerScope() bool {
	return writer.Store != nil && writer.Store.RequiresWorkerScope()
}

func (writer canonicalInboundReplyWriter) PersistInboundEmail(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	em inbound_email.Email,
	inboundEmailID int64,
	ingestKey string,
	receivedAt time.Time,
) (string, bool, error) {
	if writer.Store == nil {
		return "", false, errors.New("canonical inbound reply store is not configured")
	}
	rawMessageID := strings.TrimSpace(em.MessageID)
	if rawMessageID == "" {
		digest := strings.TrimPrefix(strings.TrimSpace(ingestKey), "event:v1:")
		if digest == "" {
			return "", false, errors.New("canonical inbound reply requires a provider or replay identity")
		}
		rawMessageID = "postwave-ingest:" + digest
	}
	metadata, err := json.Marshal(map[string]any{
		"ingest_path":               "signed_tenant_slug",
		"inbound_email_id":          inboundEmailID,
		"inbound_ingest_key_sha256": strings.TrimPrefix(strings.TrimSpace(ingestKey), "event:v1:"),
	})
	if err != nil {
		return "", false, fmt.Errorf("encode canonical inbound reply metadata: %w", err)
	}
	headers := make(replies.Headers, len(em.ReplyHeaders))
	for name, value := range em.ReplyHeaders {
		headers[name] = value
	}
	classificationBody := em.BodyText
	if strings.TrimSpace(classificationBody) == "" {
		classificationBody = em.BodyHTML
	}
	return writer.Store.PersistInTx(ctx, tx, tenantID, replies.Reply{
		TenantID:              tenantID,
		CampaignID:            em.CampaignID,
		SubscriberID:          em.SubscriberID,
		RecipientEmail:        em.From,
		InReplyTo:             em.InReplyTo,
		Subject:               em.Subject,
		BodySnippet:           classificationBody,
		RawMessageID:          rawMessageID,
		Source:                replies.SourcePostwaveInbound,
		ReceivedAt:            receivedAt,
		Metadata:              metadata,
		EnvelopeRecipient:     em.To,
		ClassificationHeaders: headers,
		ClassificationBody:    classificationBody,
		MatchMethod:           replies.MatchInReplyTo,
	})
}
