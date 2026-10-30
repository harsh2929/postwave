// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestIntegrationUpsertConsentNeutrality pins the repository boundary used by
// CRM, analytics, loyalty, review, subscription, lead, and support imports.
// Profile syncs may enrich an identity, but they may neither manufacture a new
// marketing grant nor resurrect a previously withdrawn one.
func TestIntegrationUpsertConsentNeutrality(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	const tenantID = "00000000-0000-4000-8000-01765c0a5001"
	seedBulkVerbsTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	suffix := time.Now().UnixNano()

	unsafeEmail := fmt.Sprintf("unsafe-integration-%d@example.test", suffix)
	if _, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email:         unsafeEmail,
		Status:        StatusEnabled,
		ConsentSource: ConsentAPI,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("evidence-free integration grant error = %v, want ErrInvalidInput", err)
	}
	assertSubscriberDoesNotExist(t, pool, tenantID, unsafeEmail)

	grantedEmail := fmt.Sprintf("granted-integration-%d@example.test", suffix)
	grant := completeCreateConsentInput()
	grant.Email = grantedEmail
	granted, err := repo.Upsert(ctx, tenantID, grant)
	if err != nil {
		t.Fatalf("seed reviewed grant: %v", err)
	}
	before := readConsentNeutralityState(t, pool, tenantID, granted.ID)
	if before.Status != StatusEnabled || before.AddressStatus != "subscribed" || !before.HasPurposeGrant {
		t.Fatalf("reviewed seed is not deliverable: %+v", before)
	}

	updated, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email:                grantedEmail,
		Status:               StatusUnconfirmed,
		ConsentSource:        ConsentUnknown,
		PreserveConsentState: true,
		FullName:             "Profile Enrichment",
		SourcePlatform:       "integration-test",
	})
	if err != nil {
		t.Fatalf("neutral profile enrichment: %v", err)
	}
	after := readConsentNeutralityState(t, pool, tenantID, granted.ID)
	if updated.Status != StatusEnabled || updated.FullName != "Profile Enrichment" {
		t.Fatalf("profile enrichment status/name = %q/%q, want enabled/enriched", updated.Status, updated.FullName)
	}
	if !sameConsentNeutralityState(after, before) {
		t.Fatalf("neutral enrichment changed reviewed consent: before=%+v after=%+v", before, after)
	}

	revokedEmail := fmt.Sprintf("revoked-integration-%d@example.test", suffix)
	revoked, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email:         revokedEmail,
		Status:        StatusUnconfirmed,
		ConsentSource: ConsentUnknown,
	})
	if err != nil {
		t.Fatalf("seed non-sendable profile: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed revoked state tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET status = 'blocklisted', mailchimp_status = 'unsubscribed',
       unsubscribe_reason = 'subscriber request', updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, revoked.ID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed blocklisted profile: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = 'unsubscribed', updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, revoked.ID, revokedEmail); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed revoked address: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit revoked state: %v", err)
	}

	if _, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email:                revokedEmail,
		Status:               StatusUnconfirmed,
		ConsentSource:        ConsentUnknown,
		PreserveConsentState: true,
		DisplayName:          "Still Revoked",
		SourcePlatform:       "integration-test",
	}); err != nil {
		t.Fatalf("neutral enrichment of revoked profile: %v", err)
	}
	revokedState := readConsentNeutralityState(t, pool, tenantID, revoked.ID)
	if revokedState.Status != StatusBlocklisted || revokedState.MailchimpStatus != "unsubscribed" ||
		revokedState.AddressStatus != "unsubscribed" || revokedState.HasPurposeGrant {
		t.Fatalf("neutral integration resurrected revoked profile: %+v", revokedState)
	}
}

func sameConsentNeutralityState(a, b consentNeutralityState) bool {
	if a.Status != b.Status || a.MailchimpStatus != b.MailchimpStatus ||
		a.ConsentSource != b.ConsentSource || a.UnsubscribeReason != b.UnsubscribeReason ||
		a.AddressStatus != b.AddressStatus || a.HasPurposeGrant != b.HasPurposeGrant {
		return false
	}
	if a.ConsentTimestamp == nil || b.ConsentTimestamp == nil {
		return a.ConsentTimestamp == nil && b.ConsentTimestamp == nil
	}
	return a.ConsentTimestamp.Equal(*b.ConsentTimestamp)
}

type consentNeutralityState struct {
	Status            string
	MailchimpStatus   string
	ConsentSource     string
	ConsentTimestamp  *time.Time
	UnsubscribeReason string
	AddressStatus     string
	HasPurposeGrant   bool
}

func readConsentNeutralityState(t *testing.T, pool *db.Pool, tenantID, subscriberID string) consentNeutralityState {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("read consent-neutral state tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out consentNeutralityState
	if err := tx.QueryRow(ctx, `
SELECT subscriber.status,
       subscriber.mailchimp_status,
       subscriber.consent_source,
       subscriber.consent_timestamp,
       COALESCE(subscriber.unsubscribe_reason, ''),
       address.consent_status,
       subscriber.consent_email_marketing_at IS NOT NULL
  FROM subscribers AS subscriber
  JOIN subscriber_emails AS address
    ON address.tenant_id = subscriber.tenant_id
   AND address.subscriber_id = subscriber.id
   AND lower(address.email::text) = lower(subscriber.email::text)
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = $2::uuid`, tenantID, subscriberID).Scan(
		&out.Status, &out.MailchimpStatus, &out.ConsentSource,
		&out.ConsentTimestamp, &out.UnsubscribeReason,
		&out.AddressStatus, &out.HasPurposeGrant,
	); err != nil {
		t.Fatalf("read consent-neutral state: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit consent-neutral read: %v", err)
	}
	return out
}

func assertSubscriberDoesNotExist(t *testing.T, pool *db.Pool, tenantID, email string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("absence check tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, tenantID, email).Scan(&count); err != nil {
		t.Fatalf("absence check: %v", err)
	}
	if count != 0 {
		t.Fatalf("unsafe upsert persisted %d subscriber rows", count)
	}
}
