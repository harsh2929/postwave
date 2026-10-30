// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type failingAddressConsentWebhook struct{ err error }

func (f failingAddressConsentWebhook) Fire(context.Context, pgx.Tx, WebhookFireInput) (int, error) {
	return 0, f.err
}

type recordingSubscriberWebhook struct{ events []string }

func (r *recordingSubscriberWebhook) Fire(_ context.Context, _ pgx.Tx, in WebhookFireInput) (int, error) {
	r.events = append(r.events, in.EventType)
	return 1, nil
}

func multiEmailAuditMeta(tenantID string) db.AuditMeta {
	return db.AuditMeta{
		TenantID:   tenantID,
		ActorType:  "system",
		ActorLabel: "multi-email-db-test",
	}
}

func seedMultiEmailSubscriber(t *testing.T, repo *Repo, tenantID, email string) *Subscriber {
	t.Helper()
	created, err := repo.Upsert(context.Background(), tenantID, CreateInput{
		Email:         email,
		Status:        StatusUnconfirmed,
		ConsentSource: ConsentUnknown,
	})
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	return created
}

func TestSubscriberUpsertGrantWritesCanonicalStructuredProof(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41165"
	seedPrimaryEmailTenant(t, pool, tenantID)
	webhooks := &recordingSubscriberWebhook{}
	repo := &Repo{Pool: pool, Webhooks: webhooks}
	occurredAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	email := fmt.Sprintf("create-proof-%d@example.test", time.Now().UnixNano())

	created, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email:                email,
		Status:               StatusEnabled,
		ConsentTimestamp:     &occurredAt,
		ConsentSource:        ConsentDoubleOptIn,
		ConsentChannel:       "web",
		ConsentLegalBasis:    "consent",
		ConsentEvidence:      "double-opt-in-receipt:create-proof",
		ConsentReason:        "subscriber confirmed the exact address",
		ConsentPolicyVersion: "privacy-2026-07",
		Country:              "DE",
		SignupIP:             "192.0.2.42",
	})
	if err != nil {
		t.Fatalf("Upsert reviewed grant: %v", err)
	}
	if created.ConsentEmailMarketingAt == nil {
		t.Fatal("returned subscriber omitted the committed email-marketing projection")
	}
	if len(webhooks.events) != 2 || webhooks.events[0] != EventSubscriberConsentChanged || webhooks.events[1] != EventSubscriberCreated {
		t.Fatalf("webhook sequence = %v, want consent_changed then subscriber.created", webhooks.events)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var addressID, status string
	var events, proofs int
	if err := tx.QueryRow(ctx, `
SELECT id::text, consent_status
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, created.ID, email).Scan(&addressID, &status); err != nil {
		t.Fatalf("read canonical address: %v", err)
	}
	if status != "subscribed" {
		t.Fatalf("canonical consent_status = %q, want subscribed", status)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM consent_events
 WHERE tenant_id = $1::uuid
   AND subject_id = $2
   AND lower(subject_email::text) = lower($3)
   AND action = 'granted'
   AND preferences ->> 'operation' = 'subscriber_create'`, tenantID, addressID, email).Scan(&events); err != nil {
		t.Fatalf("read immutable event: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM consent_records
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
   AND consent_status = 'granted'
   AND evidence ->> 'evidence' = 'double-opt-in-receipt:create-proof'`, tenantID, created.ID, email).Scan(&proofs); err != nil {
		t.Fatalf("read structured proof: %v", err)
	}
	if events != 1 || proofs != 1 {
		t.Fatalf("create consent evidence counts event=%d proof=%d, want 1/1", events, proofs)
	}
}

func TestSubscriberEnableRequiresExactProofAndPreservesProtectedSuppression(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41167"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	email := fmt.Sprintf("enable-proof-%d@example.test", time.Now().UnixNano())
	subscriber := seedMultiEmailSubscriber(t, repo, tenantID, email)

	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("suppression seed tx: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source)
VALUES ($1::uuid, $2, 'complaint', 'test')`, tenantID, email); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed protected complaint: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit protected complaint: %v", err)
	}

	status := StatusEnabled
	when := time.Now().UTC().Add(-time.Hour)
	source := ConsentDoubleOptIn
	updated, err := repo.UpdateWithAudit(ctx, tenantID, subscriber.ID, UpdateInput{
		Status:               &status,
		ConsentTimestamp:     &when,
		ConsentSource:        &source,
		ConsentChannel:       "web",
		ConsentLegalBasis:    "consent",
		ConsentJurisdiction:  "DE",
		ConsentEvidence:      "double-opt-in-receipt:enable-proof",
		ConsentReason:        "reviewed exact-address reactivation",
		ConsentPolicyVersion: "privacy-2026-07",
	}, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("enable with exact evidence: %v", err)
	}
	if updated.Status != StatusEnabled || updated.ConsentEmailMarketingAt == nil {
		t.Fatalf("returned enabled projection = %#v", updated)
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verification tx: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var addressStatus string
	var events, proofs, complaints int
	if err := verifyTx.QueryRow(ctx, `
SELECT consent_status FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, subscriber.ID, email).Scan(&addressStatus); err != nil {
		t.Fatalf("read address status: %v", err)
	}
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FROM consent_events
 WHERE tenant_id = $1::uuid AND lower(subject_email::text) = lower($2)
   AND action = 'granted' AND preferences ->> 'operation' = 'subscriber_status_enable'`, tenantID, email).Scan(&events); err != nil {
		t.Fatalf("read enable event: %v", err)
	}
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FROM consent_records
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3) AND consent_status = 'granted'`, tenantID, subscriber.ID, email).Scan(&proofs); err != nil {
		t.Fatalf("read enable proof: %v", err)
	}
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FROM email_suppressions
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
   AND reason = 'complaint'`, tenantID, email).Scan(&complaints); err != nil {
		t.Fatalf("read protected complaint: %v", err)
	}
	if addressStatus != "subscribed" || events != 1 || proofs != 1 || complaints != 1 {
		t.Fatalf("enable invariants status=%q events=%d proofs=%d complaints=%d", addressStatus, events, proofs, complaints)
	}
}

func TestMultiEmailConsentEvidenceCommitsAtomically(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41161"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	subscriber := seedMultiEmailSubscriber(t, repo, tenantID, fmt.Sprintf("canonical-%d@example.test", suffix))
	secondary := fmt.Sprintf("reviewed-%d@example.test", suffix)
	status := "subscribed"
	provenance := reviewedAddressConsent(time.Now().UTC().Add(-time.Hour))

	added, err := repo.AddEmail(ctx, tenantID, subscriber.ID, AddEmailInput{
		Email:                  secondary,
		ConsentStatus:          &status,
		ConsentProvenanceInput: provenance,
	}, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("AddEmail with reviewed grant: %v", err)
	}
	if added.ConsentStatus != "subscribed" || added.IsPrimary || added.Version == "" {
		t.Fatalf("unexpected reviewed address: %#v", added)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var events, proofs, audits int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM consent_events
 WHERE tenant_id = $1::uuid
   AND subject_id = $2
   AND lower(subject_email::text) = lower($3)
   AND category = 'email_marketing'
   AND action = 'granted'`, tenantID, added.ID, secondary).Scan(&events); err != nil {
		t.Fatalf("read consent event: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM consent_records
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
   AND channel = 'email'
   AND consent_status = 'granted'`, tenantID, subscriber.ID, secondary).Scan(&proofs); err != nil {
		t.Fatalf("read structured proof: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND resource_id = $2
   AND action = 'subscriber.email_added'`, tenantID, added.ID).Scan(&audits); err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if events != 1 || proofs != 1 || audits != 1 {
		t.Fatalf("atomic evidence counts events=%d proofs=%d audits=%d, want 1/1/1", events, proofs, audits)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit evidence read: %v", err)
	}

	revoked := "unsubscribed"
	revokeEvidence := reviewedAddressConsent(time.Now().UTC().Add(-30 * time.Minute))
	revokeEvidence.Source = "direct_request"
	revokeEvidence.Reason = "subscriber asked support to revoke this exact address"
	updated, err := repo.UpdateEmail(ctx, tenantID, subscriber.ID, added.ID, UpdateEmailInput{
		ConsentStatus:          &revoked,
		ConsentProvenanceInput: revokeEvidence,
		IfMatchToken:           added.Version,
	}, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("UpdateEmail revocation: %v", err)
	}
	if updated.ConsentStatus != revoked || updated.Version == added.Version {
		t.Fatalf("revocation did not advance state: before=%#v after=%#v", added, updated)
	}
	regrantEvidence := reviewedAddressConsent(time.Now().UTC().Add(-10 * time.Minute))
	regranted, err := repo.UpdateEmail(ctx, tenantID, subscriber.ID, added.ID, UpdateEmailInput{
		ConsentStatus:          &status,
		ConsentProvenanceInput: regrantEvidence,
		IfMatchToken:           updated.Version,
	}, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("UpdateEmail re-grant: %v", err)
	}
	if regranted.ConsentStatus != status {
		t.Fatalf("re-grant state = %q, want %q", regranted.ConsentStatus, status)
	}
	// A later reviewed assertion of the same projected state is still new
	// evidence. It must append proof, advance the strong address revision, and
	// remain visible in the mandatory audit trail.
	reconfirmedEvidence := reviewedAddressConsent(time.Now().UTC().Add(-5 * time.Minute))
	reconfirmedEvidence.Evidence = "hosted double-opt-in receipt:reconfirmed"
	reconfirmedEvidence.Reason = "subscriber reconfirmed the exact address"
	reconfirmed, err := repo.UpdateEmail(ctx, tenantID, subscriber.ID, added.ID, UpdateEmailInput{
		ConsentStatus:          &status,
		ConsentProvenanceInput: reconfirmedEvidence,
		IfMatchToken:           regranted.Version,
	}, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("UpdateEmail same-state re-confirmation: %v", err)
	}
	if reconfirmed.ConsentStatus != status || reconfirmed.Version == regranted.Version {
		t.Fatalf("same-state proof did not advance revision: before=%#v after=%#v", regranted, reconfirmed)
	}
	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for re-grant verification: %v", err)
	}
	var reversibleHolds, reconfirmedProofs, reconfirmedAudits int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
   AND metadata ->> 'operation' = 'multi_email_consent_status'`, tenantID, secondary).Scan(&reversibleHolds); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("read reversible consent hold: %v", err)
	}
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*)
  FROM consent_records
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
   AND consent_status = 'granted'
   AND evidence ->> 'evidence' = 'hosted double-opt-in receipt:reconfirmed'`, tenantID, subscriber.ID, secondary).Scan(&reconfirmedProofs); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("read same-state structured proof: %v", err)
	}
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*)
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND resource_id = $2
   AND action = 'subscriber.email_consent_evidence_recorded'`, tenantID, added.ID).Scan(&reconfirmedAudits); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("read same-state consent audit: %v", err)
	}
	if err := verifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit re-grant verification: %v", err)
	}
	if reversibleHolds != 0 {
		t.Fatalf("re-grant left %d reversible consent-status hold(s)", reversibleHolds)
	}
	if reconfirmedProofs != 1 || reconfirmedAudits != 1 {
		t.Fatalf("same-state evidence counts proof=%d audit=%d, want 1/1", reconfirmedProofs, reconfirmedAudits)
	}
	if _, err := repo.UpdateEmail(ctx, tenantID, subscriber.ID, added.ID, UpdateEmailInput{
		ConsentStatus:          &status,
		ConsentProvenanceInput: provenance,
		IfMatchToken:           regranted.Version,
	}, multiEmailAuditMeta(tenantID)); !errors.Is(err, ErrEmailPreconditionFailed) {
		t.Fatalf("superseded same-state version error = %v, want ErrEmailPreconditionFailed", err)
	}
	if _, err := repo.UpdateEmail(ctx, tenantID, subscriber.ID, added.ID, UpdateEmailInput{
		ConsentStatus:          &status,
		ConsentProvenanceInput: provenance,
		IfMatchToken:           added.Version,
	}, multiEmailAuditMeta(tenantID)); !errors.Is(err, ErrEmailPreconditionFailed) {
		t.Fatalf("stale consent write error = %v, want ErrEmailPreconditionFailed", err)
	}
}

func TestMultiEmailWebhookFailureRollsBackAddressAndEvidence(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41162"
	seedPrimaryEmailTenant(t, pool, tenantID)
	seedRepo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	subscriber := seedMultiEmailSubscriber(t, seedRepo, tenantID, fmt.Sprintf("rollback-canonical-%d@example.test", suffix))
	secondary := fmt.Sprintf("rollback-secondary-%d@example.test", suffix)
	status := "subscribed"
	sentinel := errors.New("forced webhook append failure")
	repo := &Repo{Pool: pool, Webhooks: failingAddressConsentWebhook{err: sentinel}}

	if _, err := repo.AddEmail(ctx, tenantID, subscriber.ID, AddEmailInput{
		Email:                  secondary,
		ConsentStatus:          &status,
		ConsentProvenanceInput: reviewedAddressConsent(time.Now().UTC().Add(-time.Hour)),
	}, multiEmailAuditMeta(tenantID)); !errors.Is(err, sentinel) {
		t.Fatalf("AddEmail error = %v, want webhook sentinel", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var addresses, events, proofs, audits int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscriber_emails WHERE lower(email::text) = lower($1)`, secondary).Scan(&addresses); err != nil {
		t.Fatalf("read rolled-back address: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM consent_events WHERE lower(subject_email::text) = lower($1)`, secondary).Scan(&events); err != nil {
		t.Fatalf("read rolled-back event: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM consent_records WHERE lower(email::text) = lower($1)`, secondary).Scan(&proofs); err != nil {
		t.Fatalf("read rolled-back proof: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM audit_log
 WHERE action = 'subscriber.email_added'
   AND metadata ->> 'subscriber_id' = $1`, subscriber.ID).Scan(&audits); err != nil {
		t.Fatalf("read rolled-back audit: %v", err)
	}
	if addresses != 0 || events != 0 || proofs != 0 || audits != 0 {
		t.Fatalf("partial write escaped rollback: address=%d event=%d proof=%d audit=%d", addresses, events, proofs, audits)
	}
}

func TestSubscriberUpsertGrantWebhookFailureRollsBackProfileAddressAndEvidence(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41168"
	seedPrimaryEmailTenant(t, pool, tenantID)
	sentinel := errors.New("forced reviewed-create webhook failure")
	repo := &Repo{Pool: pool, Webhooks: failingAddressConsentWebhook{err: sentinel}}
	email := fmt.Sprintf("rollback-reviewed-create-%d@example.test", time.Now().UnixNano())
	when := time.Now().UTC().Add(-time.Minute)

	if _, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email:                email,
		Status:               StatusEnabled,
		ConsentTimestamp:     &when,
		ConsentSource:        ConsentDoubleOptIn,
		ConsentChannel:       "web",
		ConsentLegalBasis:    "consent",
		ConsentEvidence:      "receipt:rollback-reviewed-create",
		ConsentReason:        "subscriber confirmed the exact address",
		ConsentPolicyVersion: "privacy-2026-07",
		Country:              "GB",
	}); !errors.Is(err, sentinel) {
		t.Fatalf("reviewed Upsert error = %v, want webhook sentinel", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("reviewed Upsert rollback tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscribers, addresses, events, proofs int
	if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)),
       (SELECT count(*) FROM subscriber_emails WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)),
       (SELECT count(*) FROM consent_events WHERE tenant_id=$1::uuid AND lower(subject_email::text)=lower($2)),
       (SELECT count(*) FROM consent_records WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2))`,
		tenantID, email).Scan(&subscribers, &addresses, &events, &proofs); err != nil {
		t.Fatalf("verify reviewed Upsert rollback: %v", err)
	}
	if subscribers != 0 || addresses != 0 || events != 0 || proofs != 0 {
		t.Fatalf("reviewed Upsert partial commit profile=%d address=%d event=%d proof=%d",
			subscribers, addresses, events, proofs)
	}
}

func TestMultiEmailConcurrentExactRevisionAllowsOneConsentDecision(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41169"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	subscriber := seedMultiEmailSubscriber(
		t, repo, tenantID, fmt.Sprintf("concurrent-canonical-%d@example.test", suffix),
	)
	added, err := repo.AddEmail(ctx, tenantID, subscriber.ID, AddEmailInput{
		Email: fmt.Sprintf("concurrent-reviewed-%d@example.test", suffix),
	}, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("seed concurrent address: %v", err)
	}

	subscribed := "subscribed"
	unsubscribed := "unsubscribed"
	grantEvidence := reviewedAddressConsent(time.Now().UTC())
	revokeEvidence := reviewedAddressConsent(time.Now().UTC().Add(time.Microsecond))
	revokeEvidence.Source = "direct_request"
	revokeEvidence.Reason = "subscriber concurrently revoked the exact address"
	inputs := []UpdateEmailInput{
		{
			ConsentStatus:          &subscribed,
			ConsentProvenanceInput: grantEvidence,
			IfMatchToken:           added.Version,
		},
		{
			ConsentStatus:          &unsubscribed,
			ConsentProvenanceInput: revokeEvidence,
			IfMatchToken:           added.Version,
		},
	}
	start := make(chan struct{})
	results := make(chan error, len(inputs))
	var wg sync.WaitGroup
	for _, input := range inputs {
		input := input
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := repo.UpdateEmail(
				ctx, tenantID, subscriber.ID, added.ID, input, multiEmailAuditMeta(tenantID),
			)
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	succeeded, stale := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrEmailPreconditionFailed):
			stale++
		default:
			t.Fatalf("unexpected concurrent exact-decision error: %v", err)
		}
	}
	if succeeded != 1 || stale != 1 {
		t.Fatalf("concurrent exact decisions success=%d stale=%d, want 1/1", succeeded, stale)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("concurrent decision verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var events, proofs, audits int
	if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM consent_events
         WHERE tenant_id=$1::uuid AND subject_id=$2 AND category='email_marketing'),
       (SELECT count(*) FROM consent_records
         WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid
           AND lower(email::text)=lower($4)),
       (SELECT count(*) FROM audit_log
         WHERE tenant_id=$1::uuid AND resource_id=$2
           AND action IN ('subscriber.email_consent_changed','subscriber.email_consent_evidence_recorded'))`,
		tenantID, added.ID, subscriber.ID, added.Email).Scan(&events, &proofs, &audits); err != nil {
		t.Fatalf("verify concurrent decision effects: %v", err)
	}
	if events != 1 || proofs != 1 || audits != 1 {
		t.Fatalf("concurrent decision effects event=%d proof=%d audit=%d, want 1/1/1", events, proofs, audits)
	}
}

func TestMultiEmailConcurrentCapNeverExceedsFive(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41163"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	subscriber := seedMultiEmailSubscriber(t, repo, tenantID, fmt.Sprintf("cap-canonical-%d@example.test", suffix))
	for index := 0; index < 3; index++ {
		if _, err := repo.AddEmail(ctx, tenantID, subscriber.ID, AddEmailInput{
			Email: fmt.Sprintf("cap-%d-%d@example.test", suffix, index),
		}, multiEmailAuditMeta(tenantID)); err != nil {
			t.Fatalf("seed address %d: %v", index, err)
		}
	}

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for index := 0; index < 2; index++ {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := repo.AddEmail(ctx, tenantID, subscriber.ID, AddEmailInput{
				Email: fmt.Sprintf("cap-race-%d-%d@example.test", suffix, index),
			}, multiEmailAuditMeta(tenantID))
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	successes, capFailures := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrEmailLimitReached):
			capFailures++
		default:
			t.Fatalf("unexpected concurrent add error: %v", err)
		}
	}
	if successes != 1 || capFailures != 1 {
		t.Fatalf("race outcomes successes=%d cap_failures=%d, want 1/1", successes, capFailures)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscriber_emails WHERE subscriber_id = $1::uuid`, subscriber.ID).Scan(&count); err != nil {
		t.Fatalf("count addresses: %v", err)
	}
	if count != MaxEmailsPerProfile {
		t.Fatalf("address count = %d, want %d", count, MaxEmailsPerProfile)
	}
}

func TestSubscriberEmailMigrationRejectsEvidenceLessRawGrantAndDecorativePrimary(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41164"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	subscriber := seedMultiEmailSubscriber(t, repo, tenantID, fmt.Sprintf("guard-canonical-%d@example.test", suffix))

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails (tenant_id, subscriber_id, email, consent_status)
VALUES ($1::uuid, $2::uuid, $3, 'subscribed')`, tenantID, subscriber.ID, fmt.Sprintf("raw-grant-%d@example.test", suffix)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("deferred grant insert failed before commit: %v", err)
	}
	if err := tx.Commit(ctx); err == nil {
		t.Fatal("evidence-less raw subscribed row committed")
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("second tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails (tenant_id, subscriber_id, email, is_primary)
VALUES ($1::uuid, $2::uuid, $3, true)`, tenantID, subscriber.ID, fmt.Sprintf("fake-primary-%d@example.test", suffix)); err == nil {
		t.Fatal("decorative primary row was accepted")
	}
}

func TestSubscriberEmailMigrationReconcilesEverySubscriberIdentityWriter(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41165"
	seedPrimaryEmailTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	initial := fmt.Sprintf("raw-identity-%d@example.test", suffix)
	rotated := fmt.Sprintf("raw-identity-rotated-%d@example.test", suffix)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'unknown')
RETURNING id::text`, tenantID, initial).Scan(&subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("raw subscriber insert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit raw subscriber insert: %v", err)
	}

	assertCanonical := func(wantEmail, wantStatus string) {
		t.Helper()
		readTx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("tenant scope for canonical read: %v", err)
		}
		defer func() { _ = readTx.Rollback(ctx) }()
		var email, status string
		var primary bool
		if err := readTx.QueryRow(ctx, `
SELECT email::text, consent_status, is_primary
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID).Scan(&email, &status, &primary); err != nil {
			t.Fatalf("read reconciled address: %v", err)
		}
		if email != wantEmail || status != wantStatus || !primary {
			t.Fatalf("reconciled address = %q/%q/primary=%v, want %q/%q/true", email, status, primary, wantEmail, wantStatus)
		}
	}
	assertCanonical(initial, "never_subscribed")

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for rotation: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET email = $3, primary_email = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID, rotated); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("raw subscriber rotation: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit raw subscriber rotation: %v", err)
	}
	assertCanonical(rotated, "never_subscribed")
}

func TestSubscriberEmailMigrationRejectsReceiptOnlyImportGrant(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41166"
	seedPrimaryEmailTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("raw-evidenced-%d@example.test", suffix)
	capturedAt := time.Now().UTC().Add(-time.Hour)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, status, consent_source,
    consent_timestamp, consent_email_marketing_at
) VALUES (
    $1::uuid, $2, 'enabled', 'double_optin', $3, $3
)
RETURNING id::text`, tenantID, email, capturedAt).Scan(&subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("raw evidenced subscriber insert: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status,
    source, captured_at, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'granted',
    'import', $4, '{"receipt":"verified-import-42"}'::jsonb
)`, tenantID, subscriberID, email, capturedAt); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("raw structured grant: %v", err)
	}
	commitErr := tx.Commit(ctx)
	if commitErr == nil {
		t.Fatal("receipt-only import grant committed without the required approval and per-row proof chain")
	}
	var pgErr *pgconn.PgError
	if !errors.As(commitErr, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("receipt-only import grant error = %v, want SQLSTATE 23514", commitErr)
	}

	readTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for rejected projection read: %v", err)
	}
	defer func() { _ = readTx.Rollback(ctx) }()
	var subscribedCount int
	if err := readTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
   AND consent_status = 'subscribed'`, tenantID, email).Scan(&subscribedCount); err != nil {
		t.Fatalf("read rejected subscriber-email projection: %v", err)
	}
	if subscribedCount != 0 {
		t.Fatalf("receipt-only import grant left %d subscribed projections, want 0", subscribedCount)
	}
}
