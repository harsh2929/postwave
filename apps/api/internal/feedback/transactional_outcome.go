// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// Projecting a deliverability event back onto the transactional message it was
// about.
//
// The join was already here and already used: LookupTenantByESPMessageID
// matches `transactional_emails.provider_message_id` against the ESP's message
// id to decide whose event this is. It answered WHOSE and discarded WHICH.
//
// So a receipt that hard-bounced left the sender's own record reading `sent`,
// and `GET /api/v1/emails/{id}` reported a success that did not happen. The
// address got suppressed — that part worked — but the one system whose entire
// job is to tell you what became of your message never found out.

// TransactionalOutcome is one recipient-level fact about one message.
type TransactionalOutcome struct {
	EmailID   string
	Recipient string
	Outcome   string
	Reason    string
	ESP       string
	At        time.Time
}

// TransactionalProviderOutcome is the narrow, provider-neutral handoff used
// by authenticated ESP webhook receivers. ProviderMessageID identifies the
// message; it is deliberately separate from the provider's event/delivery ID,
// which identifies one webhook observation and must never be used for this
// join.
//
// Opened and clicked are intentionally not valid Outcome values here. They are
// raw engagement observations whose human/machine/privacy classification is
// owned by engagementclassification. This ledger only records mailbox
// delivery outcomes that can be stated without interpreting recipient
// behaviour.
type TransactionalProviderOutcome struct {
	ProviderMessageID string
	Recipients        []string
	Outcome           string
	Reason            string
	ESP               string
	OccurredAt        time.Time
}

var (
	errAmbiguousProviderMessageID = errors.New("feedback: provider message id matches multiple transactional emails")
	errProviderRecipientMismatch  = errors.New("feedback: provider recipient is not on the transactional email")
	// ErrProviderMessageCorrelationPending tells the authenticated webhook
	// boundary not to acknowledge a mailbox outcome yet. The provider message
	// id belongs to neither current send ledger, which is the exact shape of a
	// callback racing persistence of provider acceptance evidence. A retry after
	// the sender commits can then correlate and fan out without a quarantine
	// containing recipient data.
	ErrProviderMessageCorrelationPending = errors.New("feedback: provider message correlation is pending")
)

// ProjectTransactionalOutcome records one authenticated provider outcome and
// enqueues its customer webhook in the caller's transaction. Keeping the
// caller-owned transaction is load-bearing for positive delivery: the
// canonical subscriber event, classification evidence, recipient outcome, and
// outbound delivery intent either all commit or none do.
//
// A provider message ID that matches campaign outbox evidence is a no-op here.
// An ID in neither send ledger is retryable: it may be a callback racing the
// sender's persistence of provider acceptance. More than one matching
// transactional row is rejected rather than choosing one nondeterministically
// and notifying the wrong message.
func (r *Repo) ProjectTransactionalOutcome(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	in TransactionalProviderOutcome,
) error {
	if tx == nil {
		return errors.New("feedback: transactional outcome projection requires a transaction")
	}
	tenantID = strings.TrimSpace(tenantID)
	providerMessageID := strings.TrimSpace(in.ProviderMessageID)
	if tenantID == "" || providerMessageID == "" {
		return nil
	}
	if !validTransactionalOutcome(in.Outcome) {
		return fmt.Errorf("feedback: unsupported transactional outcome %q", strings.TrimSpace(in.Outcome))
	}

	emailID, err := lookupTransactionalEmailByProviderMessageID(
		ctx, tx, tenantID, providerMessageID,
	)
	if err != nil {
		return err
	}
	if emailID == "" {
		campaign, err := providerMessageHasCampaignEvidence(
			ctx, tx, tenantID, providerMessageID,
		)
		if err != nil {
			return err
		}
		if campaign {
			return nil
		}
		return ErrProviderMessageCorrelationPending
	}

	recipients, err := canonicalTransactionalRecipients(
		ctx, tx, tenantID, emailID, in.Recipients,
	)
	if err != nil {
		return err
	}
	if len(recipients) == 0 {
		return errors.New("feedback: transactional outcome requires a recipient")
	}
	at := in.OccurredAt
	if at.IsZero() {
		at = time.Now().UTC()
	}
	for _, recipient := range recipients {
		inserted, err := insertTransactionalOutcome(
			ctx, tx, tenantID, emailID, recipient, strings.TrimSpace(in.Outcome),
			strings.TrimSpace(in.Reason), strings.TrimSpace(in.ESP), at,
		)
		if err != nil {
			return err
		}
		if !inserted {
			continue
		}
		if err := announceTransactionalOutcome(
			ctx, tx, tenantID, emailID, providerMessageID, recipient,
			strings.TrimSpace(in.Outcome), strings.TrimSpace(in.Reason),
			strings.TrimSpace(in.ESP), at,
		); err != nil {
			return err
		}
	}
	return nil
}

// recordTransactionalOutcome writes the outcome for the message an ESP event
// refers to, and reports the message id it landed on ("" when the event was not
// about a transactional send).
//
// Runs INSIDE the caller's transaction on purpose. A bounce that suppresses the
// address but does not update the message — or the reverse — is a state a
// support conversation cannot be had about: the two facts disagree and neither
// timestamp says which is stale. One commit, both or neither.
//
// A missing match is NORMAL, not an error: most bounces are about campaign
// sends, which own their own per-recipient records. Returning an error here
// would fail every campaign bounce.
func recordTransactionalOutcome(
	ctx context.Context, tx pgx.Tx, tenantID, espMessageID, recipient, outcome, reason, esp string,
	at time.Time,
) (emailID string, inserted bool, err error) {
	espMessageID = strings.TrimSpace(espMessageID)
	recipient = strings.ToLower(strings.TrimSpace(recipient))
	if espMessageID == "" || recipient == "" || tenantID == "" {
		return "", false, nil
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}

	emailID, err = lookupTransactionalEmailByProviderMessageID(ctx, tx, tenantID, espMessageID)
	if err != nil || emailID == "" {
		return "", false, err
	}
	canonical, err := canonicalTransactionalRecipients(
		ctx, tx, tenantID, emailID, []string{recipient},
	)
	if err != nil {
		return "", false, err
	}
	recipient = canonical[0]
	inserted, err = insertTransactionalOutcome(
		ctx, tx, tenantID, emailID, recipient, outcome, reason, esp, at,
	)
	return emailID, inserted, err
}

func lookupTransactionalEmailByProviderMessageID(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, providerMessageID string,
) (string, error) {
	var (
		count   int
		emailID string
	)
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(min(id::text), '')
  FROM transactional_emails
 WHERE tenant_id = $1::uuid AND provider_message_id = $2`,
		tenantID, providerMessageID).Scan(&count, &emailID); err != nil {
		return "", err
	}
	switch count {
	case 0:
		return "", nil
	case 1:
		return emailID, nil
	default:
		return "", errAmbiguousProviderMessageID
	}
}

func providerMessageHasCampaignEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, providerMessageID string,
) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM outbox_events
     WHERE tenant_id=$1::uuid
       AND payload->>'esp_message_id'=$2
)`, tenantID, providerMessageID).Scan(&exists)
	return exists, err
}

func insertTransactionalOutcome(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, emailID, recipient, outcome, reason, esp string,
	at time.Time,
) (bool, error) {

	// ON CONFLICT DO NOTHING, keyed including the outcome: a provider
	// redelivering the same bounce must not rewrite the timestamp, because the
	// first time we heard about it is the fact worth keeping. A LATER, different
	// outcome for the same recipient is a separate row rather than an
	// overwrite — "delivered, then complained" is the true sequence and
	// flattening it would erase the complaint or the delivery.
	// RETURNING tells us whether this was NEW. It is not a nicety: the fanout
	// rejects a repeated source event id outright, so announcing on every
	// delivery made a provider redelivery fail the entire transaction — the
	// bounce would be rejected and redelivered forever, and the address never
	// suppressed. Idempotent storage with a non-idempotent announcement is not
	// idempotent; found by the redelivery test, not by reading this.
	var storedAt time.Time
	err := tx.QueryRow(ctx, `
INSERT INTO transactional_email_outcomes
    (tenant_id, email_id, recipient, outcome, reason, esp, occurred_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, email_id, recipient, outcome) DO NOTHING
RETURNING occurred_at`,
		tenantID, emailID, recipient, outcome, reason, esp, at).Scan(&storedAt)
	if err == pgx.ErrNoRows {
		// Already known. The message id is still returned so the caller can tell
		// "this was about a transactional send we have already recorded" from
		// "this was about something else entirely".
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func canonicalTransactionalRecipients(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, emailID string,
	presented []string,
) ([]string, error) {
	var intended []string
	if err := tx.QueryRow(ctx, `
SELECT to_addrs
  FROM transactional_emails
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, emailID).Scan(&intended); err != nil {
		return nil, err
	}
	allowed := make(map[string]struct{}, len(intended))
	for _, recipient := range intended {
		recipient = strings.ToLower(strings.TrimSpace(recipient))
		if recipient != "" {
			allowed[recipient] = struct{}{}
		}
	}
	recipients := uniqueOutcomeRecipients(presented)
	for _, recipient := range recipients {
		if _, ok := allowed[recipient]; !ok {
			return nil, errProviderRecipientMismatch
		}
	}
	return recipients, nil
}

// projectAndAnnounce records the recipient outcome and, when it landed on a
// real transactional message, fans out the matching `email.*` webhook.
//
// BOTH OR NEITHER, in the caller's transaction. The projection without the
// event leaves the API correct and the integrator uninformed; the event without
// the projection has a webhook pointing at a record that contradicts it. Either
// half alone is worse than the current state, where at least the two agree by
// both being wrong.
//
// A miss is silent and normal: most feedback is about campaign sends, which
// keep their own per-recipient records. Erroring here would fail every campaign
// bounce in order to report that a transactional one was absent.
func (r *Repo) projectAndAnnounce(
	ctx context.Context, tx pgx.Tx, tenantID, espMessageID, recipient, outcome, reason, esp string,
	at time.Time,
) error {
	emailID, inserted, err := recordTransactionalOutcome(ctx, tx, tenantID, espMessageID, recipient, outcome, reason, esp, at)
	if err != nil {
		return err
	}
	// Not a transactional message, or a fact already recorded and already
	// announced. Re-announcing is not merely noisy — the fanout treats a
	// repeated source event id as an error and would abort the whole bounce.
	if emailID == "" || !inserted {
		return nil
	}
	return announceTransactionalOutcome(
		ctx, tx, tenantID, emailID, espMessageID, recipient, outcome, reason, esp, at,
	)
}

func announceTransactionalOutcome(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, emailID, espMessageID, recipient, outcome, reason, esp string,
	at time.Time,
) error {
	eventType, ok := outcomeEventType(outcome)
	if !ok {
		// `deferred` has no webhook. A transient throttle is not news — the
		// message may still arrive — and emitting one per retry would turn a
		// quiet backoff into a burst of webhooks describing nothing final.
		return nil
	}
	// Constructed here rather than injected. TransactionalFanout is a stateless
	// `struct{}` whose authority is the transaction it is handed, so a Repo
	// field would be one more thing main.go must remember to assign — and this
	// ledger already carries a row for a writer whose field is never assigned,
	// making every `if != nil` false forever. There is no nil case to forget.
	_, err := (&outbound_webhooks.TransactionalFanout{}).Fire(ctx, tx, outbound_webhooks.TransactionalEvent{
		TenantID:  tenantID,
		EventType: eventType,
		// Stable per (message, recipient, outcome), matching the projection's
		// primary key: a provider redelivering the same bounce must produce the
		// same source event id, or the integrator receives it twice.
		SourceEventID: emailID + "|" + recipient + "|" + outcome,
		OccurredAt:    at,
		Body: map[string]any{
			"email_id":            emailID,
			"provider_message_id": espMessageID,
			"recipient":           recipient,
			"outcome":             outcome,
			"reason":              reason,
			"esp":                 esp,
			"occurred_at":         at.UTC().Format(time.RFC3339),
		},
	})
	return err
}

func validTransactionalOutcome(outcome string) bool {
	switch strings.TrimSpace(outcome) {
	case "delivered", "bounced", "complained", "deferred":
		return true
	default:
		return false
	}
}

func uniqueOutcomeRecipients(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		recipient := strings.TrimSpace(raw)
		if recipient == "" {
			continue
		}
		key := strings.ToLower(recipient)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

func outcomeEventType(outcome string) (string, bool) {
	switch outcome {
	case "bounced":
		return outbound_webhooks.EventEmailBounced, true
	case "complained":
		return outbound_webhooks.EventEmailComplained, true
	case "delivered":
		return outbound_webhooks.EventEmailDelivered, true
	}
	return "", false
}
