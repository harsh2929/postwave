// SPDX-License-Identifier: AGPL-3.0-only
//
// mirror.go is the single entrypoint internal sources (inbound email replies,
// SMS inbox) use to land in the support spine. Until now only external
// support_integrations providers wrote support_conversations/support_messages;
// first-party inbound never reached the helpdesk, so the reserved source_types
// ('inbound_email','campaign_reply','sms') were never populated.
package service_suite

import (
	"context"
	"encoding/json"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// MirrorInbound upserts the conversation, appends the message, and — for
// inbound messages — auto-runs the rule-based spam scorer, recording an
// assessment when the verdict is not 'ham'. Idempotent: UpsertConversation and
// CreateMessage both dedup on their natural keys, so re-delivery of the same
// inbound event is safe. The spam write is best-effort (a scorer/record failure
// never fails the mirror). Returns the (possibly pre-existing) conversation.
func (r *Repo) MirrorInbound(ctx context.Context, tenantID string, conv Conversation, msg Message) (*Conversation, error) {
	c, err := r.UpsertConversation(ctx, tenantID, conv)
	if err != nil {
		return nil, err
	}
	m, err := r.CreateMessage(ctx, tenantID, c.ID, msg)
	if err != nil {
		return nil, err
	}
	if msg.Direction == "inbound" {
		assessment := ScoreSpam(msg, conv.SubscriberID != "")
		if assessment.Verdict != "ham" {
			assessment.ConversationID = c.ID
			assessment.MessageID = m.ID
			// Best-effort + idempotent: re-delivery of the same message must not
			// accumulate duplicate assessments (CreateMessage already deduped m).
			_ = r.recordAutoSpamAssessment(ctx, tenantID, assessment)
		}
	}
	return c, nil
}

// recordAutoSpamAssessment writes a rule-scored assessment for the mirror path,
// idempotent per (tenant, message) via ON CONFLICT DO NOTHING against the
// support_spam_assessments_message_unique partial index. Separate from the
// operator-facing CreateSpamAssessment (which returns the row) so re-delivery
// of an inbound message can't pile up duplicate signals.
func (r *Repo) recordAutoSpamAssessment(ctx context.Context, tenantID string, in SpamAssessment) error {
	if in.MessageID == "" {
		return nil // no message to key idempotency on
	}
	normalizeSpamAssessment(&in)
	signals, _ := json.Marshal(in.Signals)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO support_spam_assessments
    (tenant_id, conversation_id, message_id, score, verdict, signals, assessed_by)
VALUES ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, $4, $5, $6::jsonb, $7)
ON CONFLICT (tenant_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
		tenantID, in.ConversationID, in.MessageID, in.Score, in.Verdict,
		string(signals), in.AssessedBy); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
