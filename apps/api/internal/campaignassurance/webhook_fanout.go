// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// Campaign Assurance gates dispatch. A blocked run means a campaign will not
// send until someone acts on it, which is not something an integrator should
// have to discover by polling — so the terminal outcome is announced on the
// customer webhook catalog inside the same transaction that records it. A
// webhook that fired for an outcome the database rolled back would be worse
// than no webhook at all.
//
// This mirrors appendFinalizationAuditEvents, which writes the internal
// content-free audit trail for the same transition. They are deliberately
// separate: the audit ledger is ours and is never delivered anywhere, while
// this payload leaves the building.

// finalizationWebhookTopics returns the customer topics a terminal run
// announces, in delivery order.
func finalizationWebhookTopics(run Run) []string {
	topics := []string{outbound_webhooks.EventAssuranceRunCompleted}
	if run.GateDecision == GateBlock {
		// The actionable subset, in addition to — not instead of — completion,
		// so an integrator subscribed to either one still sees the outcome.
		topics = append(topics, outbound_webhooks.EventAssuranceRunBlocked)
	}
	return topics
}

// finalizationSourceEventID is the integrator's dedup key. It is derived from
// the run and topic alone so a retried finalization reuses it rather than
// delivering the same outcome twice.
func finalizationSourceEventID(run Run, topic string) string {
	return "assurance|" + run.ID + "|" + topic
}

// finalizationWebhookBody names the decision and the exact frozen revision it
// was reached against. It carries no campaign content: this body is delivered
// to a third-party endpoint, and the evidence assurance reasons over IS the
// tenant's message text. A consumer that needs the findings reads them back
// from the receipt API under its own credentials.
func finalizationWebhookBody(run Run) map[string]any {
	return map[string]any{
		"run_id":              run.ID,
		"campaign_id":         run.CampaignID,
		"content_revision_id": run.ContentRevisionID,
		"send_plan_id":        run.SendPlanID,
		"profile":             run.Profile,
		"state":               run.State,
		// `decision` rather than a boolean: `incomplete` and `unavailable` are
		// distinct from a pass, and a boolean would collapse them into one.
		"decision":               run.GateDecision,
		"blocking_finding_count": run.BlockingFindingCount,
		"finding_count":          run.FindingCount,
	}
}

// appendFinalizationWebhookEvents enqueues the terminal outcome for every
// tenant webhook subscribed to it. It runs in the finalizing transaction.
func appendFinalizationWebhookEvents(ctx context.Context, tx pgx.Tx, run Run) error {
	body := finalizationWebhookBody(run)
	fanout := &outbound_webhooks.TransactionalFanout{}
	for _, topic := range finalizationWebhookTopics(run) {
		if _, err := fanout.Fire(ctx, tx, outbound_webhooks.TransactionalEvent{
			TenantID:      run.TenantID,
			EventType:     topic,
			SourceEventID: finalizationSourceEventID(run, topic),
			Body:          body,
		}); err != nil {
			return fmt.Errorf("campaignassurance: announce %s: %w", topic, err)
		}
	}
	return nil
}
