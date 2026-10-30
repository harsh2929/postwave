// SPDX-License-Identifier: AGPL-3.0-only
//
// G3 follow-up: classify-on-ingest. ClassifyAndSaveByID is the
// context-based (no *http.Request) entry point the inbound-email MX
// handler calls in a goroutine right after an inbound reply is stored,
// so a reply that matched a campaign is auto-classified instead of
// waiting for an operator to click "Classify".

package campaign_replies

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ClassifyAndSaveByID resolves an inbound row's immutable canonical link,
// classifies the canonical bounded body, and appends a receipt-backed intent
// revision — all within one tenant-scoped tx. No-op
// (nil error) when the email isn't linked to a campaign, the classifier
// is nil, or the classifier is unavailable; transient infra errors are
// returned so the caller can log them.
func ClassifyAndSaveByID(ctx context.Context, pool *db.Pool, classifier IntentClassifier, tenantID string, emailID int64) error {
	if classifier == nil || pool == nil || tenantID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var campaignReplyID, subject, body, bodyHash string
	var bodyRedacted bool
	err = tx.QueryRow(ctx, `
SELECT reply.id::text,
       COALESCE(reply.subject, ''),
       CASE WHEN reply.body_redacted_at IS NULL
            THEN COALESCE(reply.body_stripped, reply.body_snippet, '')
            ELSE '' END,
       reply.body_evidence_sha256,
       reply.body_redacted_at IS NOT NULL
  FROM inbound_email_campaign_reply_links link
  JOIN campaign_replies reply
    ON reply.tenant_id = link.tenant_id
   AND reply.id = link.campaign_reply_id
 WHERE link.tenant_id = $1::uuid
   AND link.inbound_email_id = $2::bigint`, tenantID, emailID).
		Scan(&campaignReplyID, &subject, &body, &bodyHash, &bodyRedacted)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if bodyRedacted {
		return nil
	}
	intent, err := classifier.ClassifyReply(ctx, tenantID, subject, body)
	if err != nil {
		if errors.Is(err, ErrClassifierUnavailable) {
			return nil // voice service down — leave unclassified, operator can retry
		}
		return err
	}

	classifierName := normalizeIntentClassifier(intent.Classifier)
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_reply_intent_classifications (
    tenant_id, campaign_reply_id, intent_class,
    intent_confidence, classifier, classifier_version
)
VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, $6
)`, tenantID, campaignReplyID, intent.Label, intent.Confidence,
		classifierName, normalizeIntentClassifierVersion(classifierName)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
