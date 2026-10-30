// SPDX-License-Identifier: AGPL-3.0-only

package webhooks

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/feedback"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

func seedWebhookTransactionalEmail(
	t *testing.T,
	pool *db.Pool,
	tenantID, providerMessageID, recipient string,
) string {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var emailID string
	if err := tx.QueryRow(context.Background(), `
INSERT INTO transactional_emails
    (tenant_id, from_addr, to_addrs, subject, status, provider_message_id, sent_at)
VALUES ($1::uuid, 'billing@example.test', ARRAY[$2], 'Delivery projection', 'sent', $3, now())
RETURNING id::text`, tenantID, recipient, providerMessageID).Scan(&emailID); err != nil {
		t.Fatalf("seed transactional email: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	return emailID
}

func transactionalDeliveryCounts(
	t *testing.T,
	pool *db.Pool,
	tenantID, providerEventID, emailID string,
) (canonical, outcomes, receipts int, status string) {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM subscriber_events
    WHERE tenant_id=$1::uuid AND source_event_id=$2),
  (SELECT count(*) FROM transactional_email_outcomes
    WHERE tenant_id=$1::uuid AND email_id=$3::uuid AND outcome='delivered'),
  (SELECT count(*) FROM outbound_webhook_event_receipts
    WHERE tenant_id=$1::uuid AND event_type='email.delivered'),
  (SELECT status FROM transactional_emails
    WHERE tenant_id=$1::uuid AND id=$3::uuid)`,
		tenantID, providerEventID, emailID,
	).Scan(&canonical, &outcomes, &receipts, &status); err != nil {
		t.Fatal(err)
	}
	return canonical, outcomes, receipts, status
}

func TestProviderDeliveryCommitsCanonicalOutcomeAndFanoutExactlyOnce_DB(t *testing.T) {
	pool := webhookDB(t)
	tenantID := seedWebhookTenant(t, pool)
	providerMessageID := "ses-message-" + uuid.NewString()
	providerEventID := "sns-event-" + uuid.NewString()
	recipient := "delivered@example.test"
	emailID := seedWebhookTransactionalEmail(t, pool, tenantID, providerMessageID, recipient)
	deps := &DeliverabilityDeps{
		Pool:           pool,
		TenantResolver: &feedback.Repo{Pool: pool},
	}
	event := classifyOutcome{
		Email: recipient, EventType: "delivered",
		ProviderName: suppressions.SourceSES,
		ProviderID:   providerEventID, MessageID: providerMessageID,
		OccurredAt: time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond),
	}

	for attempt := 0; attempt < 2; attempt++ {
		attemptEvent := event
		if attempt == 1 {
			attemptEvent.Email = strings.ToUpper(recipient)
		}
		if err := deps.appendEvent(context.Background(), tenantID, attemptEvent, attemptEvent.OccurredAt); err != nil {
			t.Fatalf("append provider delivery attempt %d: %v", attempt+1, err)
		}
	}
	canonical, outcomes, receipts, status := transactionalDeliveryCounts(
		t, pool, tenantID, providerEventID, emailID,
	)
	if canonical != 1 || outcomes != 1 || receipts != 1 {
		t.Fatalf("canonical/outcome/receipt = %d/%d/%d, want 1/1/1", canonical, outcomes, receipts)
	}
	if status != "sent" {
		t.Fatalf("transactional status = %q, want append-only sent plus recipient outcome", status)
	}
}

func TestProviderDeliveryRejectsRecipientOutsideCorrelatedMessage_DB(t *testing.T) {
	pool := webhookDB(t)
	tenantID := seedWebhookTenant(t, pool)
	providerMessageID := "ses-recipient-message-" + uuid.NewString()
	providerEventID := "sns-recipient-event-" + uuid.NewString()
	emailID := seedWebhookTransactionalEmail(
		t, pool, tenantID, providerMessageID, "intended@example.test",
	)
	deps := &DeliverabilityDeps{
		Pool:           pool,
		TenantResolver: &feedback.Repo{Pool: pool},
	}
	event := classifyOutcome{
		Email: "different@example.test", EventType: "delivered",
		ProviderName: suppressions.SourceSES,
		ProviderID:   providerEventID, MessageID: providerMessageID,
		OccurredAt: time.Now().UTC().Truncate(time.Microsecond),
	}

	if err := deps.appendEvent(context.Background(), tenantID, event, event.OccurredAt); err == nil {
		t.Fatal("recipient outside correlated message was accepted")
	}
	canonical, outcomes, receipts, _ := transactionalDeliveryCounts(
		t, pool, tenantID, providerEventID, emailID,
	)
	if canonical != 0 || outcomes != 0 || receipts != 0 {
		t.Fatalf("mismatch leaked canonical/outcome/receipt = %d/%d/%d", canonical, outcomes, receipts)
	}
}

func TestProviderDeliveryBeforeMessagePersistenceRetriesAndThenConverges_DB(t *testing.T) {
	pool := webhookDB(t)
	tenantID := seedWebhookTenant(t, pool)
	providerMessageID := "ses-race-message-" + uuid.NewString()
	providerEventID := "sns-race-event-" + uuid.NewString()
	recipient := "raced@example.test"
	deps := &DeliverabilityDeps{
		Pool:           pool,
		TenantResolver: &feedback.Repo{Pool: pool},
	}
	event := classifyOutcome{
		Email: recipient, EventType: "delivered",
		ProviderName: suppressions.SourceSES,
		ProviderID:   providerEventID, MessageID: providerMessageID,
		OccurredAt: time.Now().UTC().Truncate(time.Microsecond),
	}

	// The provider callback can race the sender's provider_message_id update.
	// Do not acknowledge or partially commit it: the provider retry is the
	// privacy-minimal durable queue until correlation evidence exists.
	err := deps.appendEvent(context.Background(), tenantID, event, event.OccurredAt)
	if !errors.Is(err, feedback.ErrProviderMessageCorrelationPending) {
		t.Fatalf("early provider delivery error = %v, want correlation pending", err)
	}
	check, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var earlyCanonical int
	if err := check.QueryRow(context.Background(), `
SELECT count(*) FROM subscriber_events
 WHERE tenant_id=$1::uuid AND source_event_id=$2`, tenantID, providerEventID).Scan(&earlyCanonical); err != nil {
		_ = check.Rollback(context.Background())
		t.Fatal(err)
	}
	if err := check.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if earlyCanonical != 0 {
		t.Fatalf("pending correlation committed %d canonical events", earlyCanonical)
	}
	emailID := seedWebhookTransactionalEmail(t, pool, tenantID, providerMessageID, recipient)
	if err := deps.appendEvent(context.Background(), tenantID, event, event.OccurredAt); err != nil {
		t.Fatalf("retry provider delivery after message persistence: %v", err)
	}

	canonical, outcomes, receipts, _ := transactionalDeliveryCounts(
		t, pool, tenantID, providerEventID, emailID,
	)
	if canonical != 1 || outcomes != 1 || receipts != 1 {
		t.Fatalf("healed canonical/outcome/receipt = %d/%d/%d, want 1/1/1", canonical, outcomes, receipts)
	}
}
