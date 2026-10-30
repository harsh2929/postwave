package lists

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newListMembershipConsentTestPool(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping pg-backed list-membership consent tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedListMembershipConsentTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tenant seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'list-membership-consent-test',
        'list-membership-consent-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		subscriberCleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open tenant cleanup transaction: %v", cleanupErr)
			return
		}
		defer func() { _ = subscriberCleanupTx.Rollback(cleanupCtx) }()
		// Subscriber/address deletion advances the exact-address generation
		// ledger. Let that trigger work commit while its tenant FK still exists;
		// the second transaction can then cascade the tenant-owned residue.
		if _, cleanupErr = subscriberCleanupTx.Exec(cleanupCtx,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("delete test subscribers: %v", cleanupErr)
			return
		}
		if cleanupErr = subscriberCleanupTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit subscriber cleanup: %v", cleanupErr)
			return
		}

		tenantCleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open final tenant cleanup transaction: %v", cleanupErr)
			return
		}
		defer func() { _ = tenantCleanupTx.Rollback(cleanupCtx) }()
		if _, cleanupErr = tenantCleanupTx.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("delete test tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = tenantCleanupTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit final tenant cleanup: %v", cleanupErr)
		}
	})
	return tenantID
}

type listMembershipSubscriberSnapshot struct {
	ID                    string
	Email                 string
	PrimaryEmail          string
	Status                string
	MailchimpStatus       string
	ConsentSource         string
	ConsentTimestamp      string
	EmailMarketingAt      string
	SMSMarketingAt        string
	ProfilingAt           string
	TargetedAdsAt         string
	AIProcessingAt        string
	SignupSource          string
	SourcePlatform        string
	UpdatedAt             string
	AddressID             string
	AddressStatus         string
	AddressSuppressed     bool
	AddressPrimary        bool
	ReconciliationState   string
	ReconciliationGen     int64
	DecisionChecksum      string
	ConsentClassifiedAt   string
	TerminalOccurredAt    string
	TerminalRecordedAt    string
	ConsentProofExpiresAt string
}

func loadListMembershipSubscriberSnapshot(
	t *testing.T,
	pool *db.Pool,
	tenantID, email string,
) listMembershipSubscriberSnapshot {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open subscriber snapshot transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var got listMembershipSubscriberSnapshot
	if err := tx.QueryRow(ctx, `
SELECT id::text,
       email::text,
       COALESCE(primary_email::text, ''),
       status,
       mailchimp_status,
       consent_source,
       COALESCE(consent_timestamp::text, ''),
       COALESCE(consent_email_marketing_at::text, ''),
       COALESCE(consent_sms_marketing_at::text, ''),
       COALESCE(consent_profiling_at::text, ''),
       COALESCE(consent_targeted_ads_at::text, ''),
       COALESCE(consent_ai_processing_at::text, ''),
       signup_source,
       COALESCE(source_platform, ''),
       updated_at::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND email = $2::citext`, tenantID, email).Scan(
		&got.ID,
		&got.Email,
		&got.PrimaryEmail,
		&got.Status,
		&got.MailchimpStatus,
		&got.ConsentSource,
		&got.ConsentTimestamp,
		&got.EmailMarketingAt,
		&got.SMSMarketingAt,
		&got.ProfilingAt,
		&got.TargetedAdsAt,
		&got.AIProcessingAt,
		&got.SignupSource,
		&got.SourcePlatform,
		&got.UpdatedAt,
	); err != nil {
		t.Fatalf("load subscriber snapshot for %s: %v", email, err)
	}

	var addressCount int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid`, tenantID, got.ID).Scan(&addressCount); err != nil {
		t.Fatalf("count exact-address projections for %s: %v", email, err)
	}
	if addressCount != 1 {
		t.Fatalf("exact-address projection count for %s = %d, want 1", email, addressCount)
	}
	if err := tx.QueryRow(ctx, `
SELECT id::text,
       consent_status,
       suppressed,
       is_primary,
       consent_reconciliation_state,
       consent_reconciliation_generation,
       COALESCE(consent_decision_checksum, ''),
       COALESCE(consent_classified_at::text, ''),
       COALESCE(consent_terminal_occurred_at::text, ''),
       COALESCE(consent_terminal_recorded_at::text, ''),
       COALESCE(consent_proof_expires_at::text, '')
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, got.ID, email).Scan(
		&got.AddressID,
		&got.AddressStatus,
		&got.AddressSuppressed,
		&got.AddressPrimary,
		&got.ReconciliationState,
		&got.ReconciliationGen,
		&got.DecisionChecksum,
		&got.ConsentClassifiedAt,
		&got.TerminalOccurredAt,
		&got.TerminalRecordedAt,
		&got.ConsentProofExpiresAt,
	); err != nil {
		t.Fatalf("load exact-address projection for %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber snapshot: %v", err)
	}
	return got
}

type listMembershipConsentEvidenceCounts struct {
	Events         int
	Records        int
	Receipts       int
	ImportReceipts int
	SyncRows       int
	DoubleOptIns   int
}

func loadListMembershipConsentEvidenceCounts(
	t *testing.T,
	pool *db.Pool,
	tenantID, subscriberID, email string,
) listMembershipConsentEvidenceCounts {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open evidence snapshot transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got listMembershipConsentEvidenceCounts
	if err := tx.QueryRow(ctx, `
SELECT
    (SELECT count(*)::int
       FROM consent_events
      WHERE tenant_id = $1::uuid
        AND (subject_id = $2 OR lower(subject_email::text) = lower($3))),
    (SELECT count(*)::int
       FROM consent_records
      WHERE tenant_id = $1::uuid
        AND (subscriber_id = $2::uuid OR lower(email::text) = lower($3))),
    (SELECT count(*)::int
       FROM consent_receipts
      WHERE tenant_id = $1::uuid
        AND (subscriber_id = $2::uuid OR lower(subscriber_email) = lower($3))),
    (SELECT count(*)::int
       FROM subscriber_import_consent_receipts
      WHERE tenant_id = $1::uuid
        AND subscriber_id = $2::uuid),
    (SELECT count(*)::int
       FROM consent_sync_ledger
      WHERE tenant_id = $1::uuid
        AND subscriber_id = $2::uuid),
    (SELECT count(*)::int
       FROM double_optin_pending
      WHERE tenant_id = $1::uuid
        AND lower(email::text) = lower($3))`, tenantID, subscriberID, email).Scan(
		&got.Events,
		&got.Records,
		&got.Receipts,
		&got.ImportReceipts,
		&got.SyncRows,
		&got.DoubleOptIns,
	); err != nil {
		t.Fatalf("load consent evidence counts for %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit evidence snapshot: %v", err)
	}
	return got
}

func assertActiveListMembership(
	t *testing.T,
	pool *db.Pool,
	tenantID, listID, subscriberID string,
	wantOwners int,
) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open membership assertion transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var native, owners int
	if err := tx.QueryRow(ctx, `
SELECT
    (SELECT count(*)::int
       FROM list_subscribers
      WHERE tenant_id = $1::uuid
        AND list_id = $2::uuid
        AND subscriber_id = $3::uuid
        AND removed_at IS NULL),
    (SELECT count(*)::int
       FROM list_subscriber_sources
      WHERE tenant_id = $1::uuid
        AND list_id = $2::uuid
        AND subscriber_id = $3::uuid
        AND removed_at IS NULL)`, tenantID, listID, subscriberID).Scan(&native, &owners); err != nil {
		t.Fatalf("load active list membership: %v", err)
	}
	if native != 1 {
		t.Errorf("active native membership rows = %d, want 1", native)
	}
	if owners != wantOwners {
		t.Errorf("active membership owner rows = %d, want %d", owners, wantOwners)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit membership assertion: %v", err)
	}
}

func TestAddEmailToListImportCreatesFailClosedIdentityWithoutEvidence(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listID := mappedTestList(t, pool, tenantID)
	email := "new.member@example.test"
	repo := &Repo{Pool: pool}

	if err := repo.AddEmailToList(
		context.Background(), tenantID, listID, "  NEW.Member@Example.Test  ", "csv",
	); err != nil {
		t.Fatalf("add imported list member: %v", err)
	}

	got := loadListMembershipSubscriberSnapshot(t, pool, tenantID, email)
	if got.Status != "unconfirmed" {
		t.Errorf("new member lifecycle status = %q, want unconfirmed", got.Status)
	}
	if got.MailchimpStatus != "non_subscribed" {
		t.Errorf("new member compatibility status = %q, want non_subscribed", got.MailchimpStatus)
	}
	if got.ConsentSource != "unknown" {
		t.Errorf("new member consent source = %q, want unknown", got.ConsentSource)
	}
	if got.ConsentTimestamp != "" || got.EmailMarketingAt != "" {
		t.Errorf("new member received consent timestamps: legacy=%q email_purpose=%q",
			got.ConsentTimestamp, got.EmailMarketingAt)
	}
	if got.PrimaryEmail != email {
		t.Errorf("new member primary identity = %q, want %q", got.PrimaryEmail, email)
	}
	if got.SignupSource != "unknown" || got.SourcePlatform != "" {
		t.Errorf("membership fabricated acquisition provenance: signup=%q platform=%q",
			got.SignupSource, got.SourcePlatform)
	}
	if got.AddressStatus != "never_subscribed" {
		t.Errorf("new member exact-address status = %q, want never_subscribed", got.AddressStatus)
	}
	if got.AddressSuppressed || !got.AddressPrimary {
		t.Errorf("new member exact-address shape: suppressed=%v primary=%v, want false/true",
			got.AddressSuppressed, got.AddressPrimary)
	}
	if got.ReconciliationState != "failed_closed" || got.DecisionChecksum == "" {
		t.Errorf("new member exact address was not classified fail-closed: state=%q checksum=%q",
			got.ReconciliationState, got.DecisionChecksum)
	}

	evidence := loadListMembershipConsentEvidenceCounts(t, pool, tenantID, got.ID, email)
	if evidence != (listMembershipConsentEvidenceCounts{}) {
		t.Errorf("list membership fabricated consent evidence: %+v", evidence)
	}
	assertActiveListMembership(t, pool, tenantID, listID, got.ID, 1)
}

func seedExistingOptedOutListMember(
	t *testing.T,
	pool *db.Pool,
	tenantID, email string,
) string {
	t.Helper()
	ctx := context.Background()
	fixtureAt := time.Date(2024, time.March, 4, 5, 6, 7, 0, time.UTC)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open opted-out subscriber seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, mailchimp_status, consent_source,
    consent_timestamp, consent_sms_marketing_at, consent_profiling_at,
    consent_targeted_ads_at, consent_ai_processing_at, source_platform
)
VALUES (
    $1::uuid, $2::citext, $2::citext, 'disabled', 'unsubscribed', 'api',
    $3::timestamptz, $3::timestamptz, $3::timestamptz,
    $3::timestamptz, $3::timestamptz, 'crm-fixture'
)
RETURNING id::text`, tenantID, email, fixtureAt).Scan(&subscriberID); err != nil {
		t.Fatalf("seed opted-out subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit opted-out subscriber seed: %v", err)
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open opt-out projection seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var addressID string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, subscriberID, email).Scan(&addressID); err != nil {
		t.Fatalf("resolve opted-out exact address: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = 'unsubscribed',
       suppressed = true
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, addressID); err != nil {
		t.Fatalf("seed opted-out exact-address projection: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit exact-address opt-out seed: %v", err)
	}
	return subscriberID
}

func TestAddEmailToListOwnedPreservesExistingOptedOutProfile(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listID := mappedTestList(t, pool, tenantID)
	email := "opted.out@example.test"
	wantID := seedExistingOptedOutListMember(t, pool, tenantID, "Opted.Out@Example.Test")
	webhooks := &recordingMembershipWebhookFanout{}
	repo := &Repo{Pool: pool, MembershipWebhooks: webhooks}

	before := loadListMembershipSubscriberSnapshot(t, pool, tenantID, email)
	beforeEvidence := loadListMembershipConsentEvidenceCounts(t, pool, tenantID, wantID, email)
	if before.Status != "disabled" || before.MailchimpStatus != "unsubscribed" {
		t.Fatalf("bad opted-out fixture lifecycle: status=%q compat=%q",
			before.Status, before.MailchimpStatus)
	}
	if before.EmailMarketingAt != "" || before.AddressStatus != "unsubscribed" ||
		!before.AddressSuppressed || before.ReconciliationState != "failed_closed" {
		t.Fatalf("bad opted-out fixture consent state: %+v", before)
	}
	if before.SMSMarketingAt == "" || before.ProfilingAt == "" ||
		before.TargetedAdsAt == "" || before.AIProcessingAt == "" {
		t.Fatalf("bad purpose-preservation fixture: %+v", before)
	}

	gotID, err := repo.AddEmailToListOwned(
		context.Background(), tenantID, listID, "OPTED.OUT@EXAMPLE.TEST",
		ListMembershipOwner{Source: "integration", OwnerKey: "integration:test:opted-out"},
	)
	if err != nil {
		t.Fatalf("add existing opted-out member: %v", err)
	}
	if gotID != wantID {
		t.Errorf("resolved subscriber id = %q, want existing %q", gotID, wantID)
	}
	if len(webhooks.events) != 1 {
		t.Fatalf("membership webhook events = %d, want 1", len(webhooks.events))
	}
	event := webhooks.events[0]
	if event.SubscriberID != wantID ||
		event.ListID != listID ||
		!strings.EqualFold(event.Email, email) ||
		event.Source != "integration" ||
		event.AddedAt.IsZero() {
		t.Fatalf("unexpected persisted membership event: %+v", event)
	}

	// A second owner may attach provenance to the same active membership, but
	// it is not a second list-add lifecycle moment.
	if _, err := repo.AddEmailToListOwned(
		context.Background(), tenantID, listID, email,
		ListMembershipOwner{Source: "integration", OwnerKey: "integration:test:second-owner"},
	); err != nil {
		t.Fatalf("attach second active owner: %v", err)
	}
	if len(webhooks.events) != 1 {
		t.Fatalf("active membership re-fired webhook: events=%d", len(webhooks.events))
	}

	after := loadListMembershipSubscriberSnapshot(t, pool, tenantID, email)
	afterEvidence := loadListMembershipConsentEvidenceCounts(t, pool, tenantID, wantID, email)
	if !reflect.DeepEqual(after, before) {
		t.Errorf("membership changed opted-out subscriber or exact-address state:\n before: %+v\n  after: %+v",
			before, after)
	}
	if afterEvidence != beforeEvidence {
		t.Errorf("membership changed opted-out consent evidence: before=%+v after=%+v",
			beforeEvidence, afterEvidence)
	}
	assertActiveListMembership(t, pool, tenantID, listID, wantID, 2)
}

func TestAddEmailToListOwnedConcurrentWritersShareOneFailClosedIdentity(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listID := mappedTestList(t, pool, tenantID)
	email := "concurrent.member@example.test"
	repo := &Repo{Pool: pool}

	const writers = 8
	start := make(chan struct{})
	ids := make([]string, writers)
	errs := make([]error, writers)
	var wg sync.WaitGroup
	wg.Add(writers)
	for i := 0; i < writers; i++ {
		i := i
		go func() {
			defer wg.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			ids[i], errs[i] = repo.AddEmailToListOwned(
				ctx, tenantID, listID, strings.ToUpper(email),
				ListMembershipOwner{
					Source:   "integration",
					OwnerKey: fmt.Sprintf("integration:test:concurrent:%d", i),
				},
			)
		}()
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent writer %d: %v", i, err)
		}
	}
	for i := 1; i < len(ids); i++ {
		if ids[i] != ids[0] {
			t.Errorf("concurrent writer %d resolved id %q, want %q", i, ids[i], ids[0])
		}
	}

	got := loadListMembershipSubscriberSnapshot(t, pool, tenantID, email)
	if got.ID != ids[0] {
		t.Errorf("stored subscriber id = %q, writers returned %q", got.ID, ids[0])
	}
	if got.Status != "unconfirmed" || got.MailchimpStatus != "non_subscribed" ||
		got.ConsentSource != "unknown" || got.EmailMarketingAt != "" ||
		got.AddressStatus != "never_subscribed" || got.ReconciliationState == "proven" {
		t.Errorf("concurrent membership created sendable or consented identity: %+v", got)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open concurrent identity count transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberCount int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)`, tenantID, email).Scan(&subscriberCount); err != nil {
		t.Fatalf("count concurrent subscriber identities: %v", err)
	}
	if subscriberCount != 1 {
		t.Errorf("concurrent subscriber identity count = %d, want 1", subscriberCount)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit concurrent identity count: %v", err)
	}

	evidence := loadListMembershipConsentEvidenceCounts(t, pool, tenantID, got.ID, email)
	if evidence != (listMembershipConsentEvidenceCounts{}) {
		t.Errorf("concurrent membership fabricated consent evidence: %+v", evidence)
	}
	assertActiveListMembership(t, pool, tenantID, listID, got.ID, writers)
}

func TestOwnedMembershipRemovalPreservesOtherOwnersAndRevivesOnce(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listID := mappedTestList(t, pool, tenantID)
	email := "owned-removal@example.test"
	webhooks := &recordingMembershipWebhookFanout{}
	repo := &Repo{Pool: pool, MembershipWebhooks: webhooks}
	firstOwner := ListMembershipOwner{
		Source:   "integration",
		OwnerKey: "integration:test:first",
	}
	secondOwner := ListMembershipOwner{
		Source:   "integration",
		OwnerKey: "integration:test:second",
	}

	subscriberID, err := repo.AddEmailToListOwned(
		context.Background(), tenantID, listID, email, firstOwner,
	)
	if err != nil {
		t.Fatalf("add first owner: %v", err)
	}
	if _, err := repo.AddEmailToListOwned(
		context.Background(), tenantID, listID, email, secondOwner,
	); err != nil {
		t.Fatalf("add second owner: %v", err)
	}
	if len(webhooks.events) != 1 {
		t.Fatalf("initial membership events = %d, want 1", len(webhooks.events))
	}
	firstRevision := webhooks.events[0].AddedAt

	removed, err := repo.RemoveEmailFromListOwned(
		context.Background(), tenantID, listID, email, firstOwner.OwnerKey,
	)
	if err != nil || !removed {
		t.Fatalf("remove first owner = (%v, %v), want true, nil", removed, err)
	}
	assertActiveListMembership(t, pool, tenantID, listID, subscriberID, 1)
	removed, err = repo.RemoveEmailFromListOwned(
		context.Background(), tenantID, listID, email, firstOwner.OwnerKey,
	)
	if err != nil || removed {
		t.Fatalf("repeat first-owner remove = (%v, %v), want false, nil", removed, err)
	}
	removed, err = repo.RemoveEmailFromListOwned(
		context.Background(), tenantID, listID, email, secondOwner.OwnerKey,
	)
	if err != nil || !removed {
		t.Fatalf("remove final owner = (%v, %v), want true, nil", removed, err)
	}

	verify, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open removed membership verification: %v", err)
	}
	defer func() { _ = verify.Rollback(context.Background()) }()
	var activeNative, activeOwners int
	if err := verify.QueryRow(context.Background(), `
SELECT
    (SELECT count(*)::int
       FROM list_subscribers
      WHERE tenant_id = $1::uuid
        AND list_id = $2::uuid
        AND subscriber_id = $3::uuid
        AND removed_at IS NULL),
    (SELECT count(*)::int
       FROM list_subscriber_sources
      WHERE tenant_id = $1::uuid
        AND list_id = $2::uuid
        AND subscriber_id = $3::uuid
        AND removed_at IS NULL)`,
		tenantID, listID, subscriberID).Scan(&activeNative, &activeOwners); err != nil {
		t.Fatalf("load removed membership: %v", err)
	}
	if activeNative != 0 || activeOwners != 0 {
		t.Fatalf("removed membership remained active: native=%d owners=%d",
			activeNative, activeOwners)
	}
	if err := verify.Commit(context.Background()); err != nil {
		t.Fatalf("commit removed membership verification: %v", err)
	}

	time.Sleep(time.Millisecond)
	if _, err := repo.AddEmailToListOwned(
		context.Background(), tenantID, listID, email, firstOwner,
	); err != nil {
		t.Fatalf("revive membership: %v", err)
	}
	if len(webhooks.events) != 2 {
		t.Fatalf("revival events = %d, want 2", len(webhooks.events))
	}
	if !webhooks.events[1].AddedAt.After(firstRevision) {
		t.Fatalf("revival revision %s did not advance past %s",
			webhooks.events[1].AddedAt, firstRevision)
	}
	assertActiveListMembership(t, pool, tenantID, listID, subscriberID, 1)
}

func TestRemoveCRMContactMembershipsDetachesOnlyMatchingIntegrationOwner(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listID := mappedTestList(t, pool, tenantID)
	email := "hubspot-lifecycle@example.test"
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open integration seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var integrationID string
	if err := tx.QueryRow(ctx, `
INSERT INTO crm_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
)
VALUES (
    $1::uuid, 'hubspot', 'membership lifecycle', 'connected',
    ARRAY[]::text[], 'crm:hubspot:test', '{}'::jsonb
)
RETURNING id::text`, tenantID).Scan(&integrationID); err != nil {
		t.Fatalf("seed CRM integration: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit CRM integration seed: %v", err)
	}

	subscriberID, err := repo.AddEmailToListOwned(
		ctx,
		tenantID,
		listID,
		email,
		ListMembershipOwner{
			Source:              "integration",
			OwnerKey:            "crm:" + integrationID + ":hubspot:list:7:42",
			Provider:            "hubspot",
			IntegrationID:       integrationID,
			ProviderSegmentType: "list",
			ProviderSegmentID:   "7",
			ProviderMemberID:    "42",
		},
	)
	if err != nil {
		t.Fatalf("add HubSpot owner: %v", err)
	}
	if _, err := repo.AddEmailToListOwned(
		ctx,
		tenantID,
		listID,
		email,
		ListMembershipOwner{
			Source:   "api",
			OwnerKey: "api:operator-retained",
		},
	); err != nil {
		t.Fatalf("add independent owner: %v", err)
	}

	removed, err := repo.RemoveCRMContactMemberships(
		ctx, tenantID, integrationID, "hubspot", subscriberID,
	)
	if err != nil || removed != 1 {
		t.Fatalf("remove CRM contact memberships=(%d,%v), want (1,nil)", removed, err)
	}
	removed, err = repo.RemoveCRMContactMemberships(
		ctx, tenantID, integrationID, "hubspot", subscriberID,
	)
	if err != nil || removed != 0 {
		t.Fatalf("repeat removal=(%d,%v), want (0,nil)", removed, err)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open membership verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var activeNative, activeOwners, activeHubSpotOwners int
	if err := verify.QueryRow(ctx, `
SELECT
    (SELECT count(*)::int
       FROM list_subscribers
      WHERE tenant_id = $1::uuid
        AND list_id = $2::uuid
        AND subscriber_id = $3::uuid
        AND removed_at IS NULL),
    (SELECT count(*)::int
       FROM list_subscriber_sources
      WHERE tenant_id = $1::uuid
        AND list_id = $2::uuid
        AND subscriber_id = $3::uuid
        AND removed_at IS NULL),
    (SELECT count(*)::int
       FROM list_subscriber_sources
      WHERE tenant_id = $1::uuid
        AND list_id = $2::uuid
        AND subscriber_id = $3::uuid
        AND integration_id = $4::uuid
        AND provider = 'hubspot'
        AND removed_at IS NULL)`,
		tenantID, listID, subscriberID, integrationID).Scan(
		&activeNative, &activeOwners, &activeHubSpotOwners,
	); err != nil {
		t.Fatalf("read membership ownership: %v", err)
	}
	if activeNative != 1 || activeOwners != 1 || activeHubSpotOwners != 0 {
		t.Fatalf(
			"active native=%d owners=%d hubspot=%d, want 1/1/0",
			activeNative,
			activeOwners,
			activeHubSpotOwners,
		)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit membership verification: %v", err)
	}
}

func TestAddMembersEmitsOnlyPersistedMembershipRevisions(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listID := mappedTestList(t, pool, tenantID)
	subscriberID := seedExistingOptedOutListMember(
		t, pool, tenantID, "add-members@example.test",
	)
	webhooks := &recordingMembershipWebhookFanout{}
	repo := &Repo{Pool: pool, MembershipWebhooks: webhooks}

	added, err := repo.AddMembers(
		context.Background(), tenantID, listID, []string{subscriberID},
	)
	if err != nil || added != 1 {
		t.Fatalf("first add = (%d, %v), want (1, nil)", added, err)
	}
	if len(webhooks.events) != 1 || webhooks.events[0].AddedAt.IsZero() {
		t.Fatalf("first membership events = %+v", webhooks.events)
	}
	firstRevision := webhooks.events[0].AddedAt

	added, err = repo.AddMembers(
		context.Background(), tenantID, listID, []string{subscriberID},
	)
	if err != nil || added != 0 || len(webhooks.events) != 1 {
		t.Fatalf("active duplicate = (%d, %v), events=%d; want 0, nil, 1",
			added, err, len(webhooks.events))
	}

	removed, err := repo.RemoveMember(
		context.Background(), tenantID, listID, subscriberID,
	)
	if err != nil || !removed {
		t.Fatalf("remove = (%v, %v), want true, nil", removed, err)
	}
	time.Sleep(time.Millisecond)
	added, err = repo.AddMembers(
		context.Background(), tenantID, listID, []string{subscriberID},
	)
	if err != nil || added != 1 || len(webhooks.events) != 2 {
		t.Fatalf("revival = (%d, %v), events=%d; want 1, nil, 2",
			added, err, len(webhooks.events))
	}
	if !webhooks.events[1].AddedAt.After(firstRevision) {
		t.Fatalf("revival revision %s did not advance past %s",
			webhooks.events[1].AddedAt, firstRevision)
	}
}

func TestAddMembersRollsBackWhenWebhookIntentFails(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listID := mappedTestList(t, pool, tenantID)
	subscriberID := seedExistingOptedOutListMember(
		t, pool, tenantID, "add-members-rollback@example.test",
	)
	sentinel := errors.New("injected membership fanout failure")
	repo := &Repo{
		Pool: pool,
		MembershipWebhooks: &recordingMembershipWebhookFanout{
			err: sentinel,
		},
	}
	if _, err := repo.AddMembers(
		context.Background(), tenantID, listID, []string{subscriberID},
	); !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want wrapped %v", err, sentinel)
	}

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open rollback verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var count int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)
  FROM list_subscribers
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = $3::uuid`,
		tenantID, listID, subscriberID).Scan(&count); err != nil {
		t.Fatalf("count membership: %v", err)
	}
	if count != 0 {
		t.Fatalf("membership committed after webhook failure: count=%d", count)
	}
}

func TestDuplicateAndMergeListsEmitInsertedMembersSetWise(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	firstSubscriber := seedExistingOptedOutListMember(
		t, pool, tenantID, "list-copy-one@example.test",
	)
	secondSubscriber := seedExistingOptedOutListMember(
		t, pool, tenantID, "list-copy-two@example.test",
	)
	sourceOne := mappedTestList(t, pool, tenantID)
	sourceTwo := mappedTestList(t, pool, tenantID)
	seedRepo := &Repo{Pool: pool}
	if added, err := seedRepo.AddMembers(
		context.Background(), tenantID, sourceOne,
		[]string{firstSubscriber, secondSubscriber},
	); err != nil || added != 2 {
		t.Fatalf("seed first source = (%d, %v)", added, err)
	}
	if added, err := seedRepo.AddMembers(
		context.Background(), tenantID, sourceTwo,
		[]string{secondSubscriber},
	); err != nil || added != 1 {
		t.Fatalf("seed second source = (%d, %v)", added, err)
	}

	webhooks := &recordingMembershipWebhookFanout{}
	repo := &Repo{Pool: pool, MembershipWebhooks: webhooks}
	duplicateID, copied, err := repo.DuplicateList(
		context.Background(), tenantID, sourceOne, "copy",
	)
	if err != nil || copied != 2 || len(webhooks.events) != 2 {
		t.Fatalf("duplicate = (%q, %d, %v), events=%d; want 2",
			duplicateID, copied, err, len(webhooks.events))
	}
	for _, event := range webhooks.events {
		if event.ListID != duplicateID || event.Source != "admin" || event.AddedAt.IsZero() {
			t.Fatalf("unexpected duplicate membership event: %+v", event)
		}
	}

	webhooks.events = nil
	target := mappedTestList(t, pool, tenantID)
	merged, err := repo.MergeListsMembers(
		context.Background(), tenantID, []string{sourceOne, sourceTwo}, target,
	)
	// secondSubscriber appears in both sources, but ON CONFLICT suppresses the
	// second source's duplicate and therefore its duplicate delivery intent.
	if err != nil || merged != 2 || len(webhooks.events) != 2 {
		t.Fatalf("merge = (%d, %v), events=%d; want 2",
			merged, err, len(webhooks.events))
	}
	for _, event := range webhooks.events {
		if event.ListID != target || event.Source != "admin" || event.AddedAt.IsZero() {
			t.Fatalf("unexpected merged membership event: %+v", event)
		}
	}
}

func TestDuplicateListRollsBackWhenSetBasedFanoutFails(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	subscriberID := seedExistingOptedOutListMember(
		t, pool, tenantID, "list-copy-rollback@example.test",
	)
	source := mappedTestList(t, pool, tenantID)
	if added, err := (&Repo{Pool: pool}).AddMembers(
		context.Background(), tenantID, source, []string{subscriberID},
	); err != nil || added != 1 {
		t.Fatalf("seed source = (%d, %v)", added, err)
	}

	sentinel := errors.New("injected set-based fanout failure")
	webhooks := &recordingMembershipWebhookFanout{err: sentinel}
	repo := &Repo{Pool: pool, MembershipWebhooks: webhooks}
	if _, _, err := repo.DuplicateList(
		context.Background(), tenantID, source, "copy",
	); !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want wrapped %v", err, sentinel)
	}
	if len(webhooks.events) != 1 {
		t.Fatalf("captured events = %d, want 1", len(webhooks.events))
	}
	rolledBackListID := webhooks.events[0].ListID
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open rollback verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var count int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)
  FROM list_subscribers
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid`,
		tenantID, rolledBackListID).Scan(&count); err != nil {
		t.Fatalf("count copied memberships: %v", err)
	}
	if count != 0 {
		t.Fatalf("copied memberships committed after fanout failure: %d", count)
	}
}

var testEngineListIDs atomic.Int64

// mappedTestList mints a live list identity in tenantID and returns its uuid.
// Every membership writer verifies the list in its writing transaction, so a
// made-up uuid is refused as a list the tenant does not have.
func mappedTestList(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	return mapListIdentity(t, pool, tenantID, 7000+testEngineListIDs.Add(1))
}
