// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SMS consent is granted in one place and read in another, and the two were
// never connected.
//
// `RecordConsent` writes `sms_subscriptions` (+ `sms_consent_events`), which is
// what `ResolveBroadcastAudience` reads when sending an SMS broadcast. But every
// ACTIVATION path — omnichannel sends, segment preview counts, the activation
// firewall, consent receipts — gates on `subscribers.consent_sms_marketing_at`,
// and no code path in this repo ever set that column to a non-NULL value. Its
// only writers are erasure (NULL) and the merge intersection.
//
// So `internal/omnichannel` resolved zero recipients for every SMS, WhatsApp and
// RCS send — `consentChannel` maps all three onto the sms gate — no matter how
// many people had opted in. Not a partial failure: a total one, silently, with
// the opt-in records sitting right there.
//
// These tests assert the property that was missing: the two audiences agree.

func newSMSConsentTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping SMS consent projection tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect to migrated test database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type smsConsentFixture struct {
	tenantID string
	email    string
	phone    string
	listA    string
	listB    string
}

func seedSMSConsentFixture(t *testing.T, pool *db.Pool) smsConsentFixture {
	t.Helper()
	ctx := context.Background()
	f := smsConsentFixture{
		tenantID: uuid.NewString(),
		email:    "sms-consent-" + uuid.NewString()[:8] + "@example.test",
		phone:    "+1555" + uuid.NewString()[:7][:7],
		listA:    uuid.NewString(),
		listB:    uuid.NewString(),
	}
	// A phone that normalizes cleanly; NormalizePhoneUSCA is strict.
	f.phone = "+1555" + randomDigits(t)

	// Seeded under the ordinary tenant scope, not a worker/RLS-bypass scope: the
	// projection this exercises runs inside `RecordConsent`'s tenant transaction,
	// so a fixture built with more privilege than production has would prove the
	// wrong thing.
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant seed scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, name, slug, tier)
		VALUES ($1::uuid, 'sms-consent-test', 'sms-consent-' || $1::text, 'studio')`,
		f.tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api')`, f.tenantID, f.email); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	for _, id := range []string{f.listA, f.listB} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sms_lists (id, tenant_id, name)
			VALUES ($1::uuid, $2::uuid, $3)`, id, f.tenantID, "sms-"+id[:8]); err != nil {
			t.Fatalf("seed list: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}

	// One tenant delete removes everything the fixture and the test wrote,
	// through ON DELETE CASCADE and the reviewed cascade exception on the
	// guarded SMS tables. The teardown used to delete the child rows first and
	// give up silently on the first error, and the application role has no
	// DELETE on sms_consent_events, so the tenant delete never ran and every
	// test that used this fixture leaked its tenant.
	t.Cleanup(func() { deleteSMSTestTenant(t, pool, f.tenantID) })
	return f
}

func randomDigits(t *testing.T) string {
	t.Helper()
	raw := uuid.NewString()
	out := make([]byte, 0, 7)
	for i := 0; i < len(raw) && len(out) < 7; i++ {
		if raw[i] >= '0' && raw[i] <= '9' {
			out = append(out, raw[i])
		}
	}
	for len(out) < 7 {
		out = append(out, '4')
	}
	if out[0] < '2' {
		out[0] = '2'
	}
	return string(out)
}

// vectorSet reports whether the activation gate would select this subscriber.
// Reads the exact column `segments/predicates/channel_consent.go` compiles to.
func vectorSet(t *testing.T, pool *db.Pool, tenantID, email string) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var set bool
	if err := tx.QueryRow(ctx, `
		SELECT consent_sms_marketing_at IS NOT NULL
		  FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext`,
		tenantID, email).Scan(&set); err != nil {
		t.Fatalf("read consent vector: %v", err)
	}
	return set
}

// broadcastEligible reports whether the SMS broadcast audience would include
// this phone — the OTHER of the two audiences, read the way
// `sms/broadcasts.go` reads it.
func broadcastEligible(t *testing.T, pool *db.Pool, tenantID, phone string) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ok bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM sms_subscriptions s
			 WHERE tenant_id = $1::uuid AND phone_e164 = $2
			   AND public.sms_subscription_send_eligible(
			     s.tenant_id, s.list_id, s.phone_e164, s.status,
			     s.consent_source, s.consent_text, s.consent_at, s.proof))
		  AND NOT EXISTS (
			SELECT 1 FROM sms_suppressions
			 WHERE tenant_id = $1::uuid AND phone_e164 = $2
			   AND (expires_at IS NULL OR expires_at > now()))`,
		tenantID, phone).Scan(&ok); err != nil {
		t.Fatalf("read broadcast eligibility: %v", err)
	}
	return ok
}

func TestGrantingSMSConsentMakesBothAudiencesAgree(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	broadcast := broadcastEligible(t, pool, f.tenantID, f.phone)
	activation := vectorSet(t, pool, f.tenantID, f.email)
	if !broadcast {
		t.Fatalf("broadcast audience excluded a subscriber who just opted in")
	}
	if !activation {
		t.Fatalf("the subscriber opted in and the SMS broadcast audience includes them, " +
			"but the activation gate (subscribers.consent_sms_marketing_at) does not. " +
			"Every omnichannel SMS/WhatsApp/RCS send resolves zero recipients while the " +
			"opt-in record sits in sms_subscriptions.")
	}
}

func TestRevokingSMSConsentClearsTheActivationGate(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentRevoked, Source: "keyword",
	}); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	if broadcastEligible(t, pool, f.tenantID, f.phone) {
		t.Fatalf("broadcast audience still includes a revoked subscriber")
	}
	if vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatalf("consent was revoked but the activation gate is still open. A stale " +
			"grant on the vector column is worse than the missing one: it sends to " +
			"someone who said stop.")
	}
}

func TestAOneListRevokeSuppressesTheWholeTenantAndBothAudiencesAgree(t *testing.T) {
	// I wrote this first asserting that revoking one list must leave consent from
	// another intact, and it failed. The premise was wrong, not the projection:
	// `RecordConsent`'s revoke branch writes `sms_suppressions` keyed
	// (tenant_id, phone_e164) with NO list — it models a STOP keyword, which
	// applies to the sender rather than to one list. So a per-list revoke really
	// does suppress the phone tenant-wide.
	//
	// The property worth asserting is therefore not a policy I assumed but the
	// invariant this work exists to establish: whatever the policy is, the
	// activation gate and the broadcast audience give the SAME answer.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	for _, list := range []string{f.listA, f.listB} {
		if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
			PhoneE164: f.phone, ListID: list, SubscriberEmail: f.email,
			Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
		}); err != nil {
			t.Fatalf("grant %s: %v", list, err)
		}
	}
	if !vectorSet(t, pool, f.tenantID, f.email) || !broadcastEligible(t, pool, f.tenantID, f.phone) {
		t.Fatalf("both audiences should include a subscriber opted into two lists")
	}

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listB, SubscriberEmail: f.email,
		Action: ConsentRevoked, Source: "keyword",
	}); err != nil {
		t.Fatalf("revoke list B: %v", err)
	}

	activation := vectorSet(t, pool, f.tenantID, f.email)
	broadcast := broadcastEligible(t, pool, f.tenantID, f.phone)
	if activation != broadcast {
		t.Fatalf("the two audiences disagree after a one-list revoke: activation=%v "+
			"broadcast=%v. One of them would send to someone the other excludes, "+
			"which is the entire defect this projection exists to close.",
			activation, broadcast)
	}
	if activation {
		t.Fatalf("a revoke wrote a tenant-wide suppression but both audiences still " +
			"include the subscriber")
	}
}

func TestOptedOutOnOneListDoesNotClearConsentHeldOnAnother(t *testing.T) {
	// The multi-list correctness case that CAN occur: a subscription reaches
	// `opted_out` without a tenant-wide suppression — an admin edit, an importer,
	// a per-list preference change — while another list is still opted in.
	//
	// A revoke rule phrased as "any opt-out clears the vector" de-consents
	// someone who never withdrew, which is a new consent bug shipped in the name
	// of fixing one. The rule must ask whether ANY unsuppressed opt-in remains.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	for _, list := range []string{f.listA, f.listB} {
		if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
			PhoneE164: f.phone, ListID: list, SubscriberEmail: f.email,
			Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
		}); err != nil {
			t.Fatalf("grant %s: %v", list, err)
		}
	}

	// Opt list B out directly — no suppression, as a non-STOP path would.
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sms_subscriptions SET status = 'opted_out', consent_at = NULL,
		       opt_out_at = clock_timestamp(), consent_text = '', proof = '{}'::jsonb
		 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND phone_e164 = $3`,
		f.tenantID, f.listB, f.phone); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("opt out list B: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit opt-out: %v", err)
	}

	// Any subsequent consent write recomputes the vector.
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("re-affirm list A: %v", err)
	}

	if !vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatalf("list B opted out while list A is still opted in, and the activation " +
			"gate closed. The subscriber never withdrew consent for list A.")
	}
	if !broadcastEligible(t, pool, f.tenantID, f.phone) {
		t.Fatalf("broadcast audience excluded a subscriber still opted into list A")
	}
}

func TestGlobalStopClosesTheActivationGate(t *testing.T) {
	// The path the design nearly missed. RecordConsent guards its
	// sms_subscriptions upsert on `in.ListID != ""`, so a GLOBAL stop (no list)
	// writes a tenant-wide sms_suppressions row and marks NO subscription
	// opted_out. A revoke rule phrased only as "no opted_in row remains" is
	// therefore satisfied by nothing and leaves the gate open — the person said
	// STOP to everything and activation would still select them.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}
	// No ListID — a bare STOP keyword.
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, SubscriberEmail: f.email,
		Action: ConsentRevoked, Source: "keyword",
	}); err != nil {
		t.Fatalf("global stop: %v", err)
	}

	if broadcastEligible(t, pool, f.tenantID, f.phone) {
		t.Fatalf("a global STOP left the broadcast audience open")
	}
	if vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatalf("a global STOP suppressed the phone but left the activation gate " +
			"open. The subscription row is still `opted_in` because the per-list " +
			"upsert is skipped when no list is given, so a rule that only asks " +
			"whether an opted_in row remains never fires.")
	}
}

// The three paths an adversarial review found unprotected when the projection
// lived in `RecordConsent` alone. Each is a separate consent WRITER, and the gap
// they left was fail-OPEN: the grant path opened the activation gate and these
// could not close it.

func TestAnInboundStopClosesTheActivationGate(t *testing.T) {
	// The path that matters most. A carrier webhook or the Twilio handler calls
	// RecordInbound, which routes to `recordConsentTx` — a different consent
	// writer that never touched the projection. A subscriber who texted STOP
	// kept a live SMS grant, and `omnichannel` sends sms/whatsapp/rcs on that
	// grant with no suppression check of its own. That is outbound messaging to
	// someone who sent a statutory opt-out.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if !vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("precondition: the grant should have opened the gate")
	}

	if _, _, _, err := store.RecordInbound(ctx, f.tenantID, "", ProviderTwilio,
		f.phone, "STOP", "prov-"+strings.TrimPrefix(f.phone, "+"), nil); err != nil {
		t.Fatalf("inbound STOP: %v", err)
	}

	if broadcastEligible(t, pool, f.tenantID, f.phone) {
		t.Error("the broadcast audience still includes someone who texted STOP")
	}
	if vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("an inbound STOP left the activation gate OPEN. omnichannel would " +
			"still send sms/whatsapp/rcs to someone who sent a statutory opt-out.")
	}
}

func TestAdminSuppressionClosesAndUnsuppressionReopensTheGate(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	row, err := store.AddSuppression(ctx, f.tenantID, f.phone, "manual", nil)
	if err != nil {
		t.Fatalf("add suppression: %v", err)
	}
	if vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("an admin suppression left the activation gate open")
	}

	// The mirror. Un-suppressing must re-open it, or the two audiences disagree
	// in the other direction and the subscriber is silently unreachable.
	if ok, err := store.DeleteSuppression(ctx, f.tenantID, row.ID, nil); err != nil || !ok {
		t.Fatalf("delete suppression: ok=%v err=%v", ok, err)
	}
	if !broadcastEligible(t, pool, f.tenantID, f.phone) {
		t.Fatal("precondition: removing the suppression should restore broadcast eligibility")
	}
	if !vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("removing a suppression restored the broadcast audience but not the " +
			"activation gate, so the subscriber is reachable by one path and not the other")
	}
}

func TestOneSubscribersConsentWriteDoesNotDeconsentAnotherOnTheSamePhone(t *testing.T) {
	// Households, shared business lines, and re-used numbers all produce two
	// subscribers on one phone. The first version of this projection recomputed
	// EVERY email attached to the phone and, with a CASE that had no ELSE, wrote
	// NULL for anyone with no opted-in row — destroying a grant that came from
	// somewhere else entirely (subscribers/merge_canonical.go writes a non-NULL
	// value), with no way to recover the original date.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	victim := "sms-victim-" + f.email
	earlier := time.Now().UTC().Add(-30 * 24 * time.Hour)
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source,
		                         consent_sms_marketing_at)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api', $3)`,
		f.tenantID, victim, earlier); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed victim: %v", err)
	}
	// A merely PENDING row on the shared phone — never an SMS-derived grant.
	if _, err := tx.Exec(ctx, `
		INSERT INTO sms_subscriptions (tenant_id, list_id, phone_e164, subscriber_email, status)
		VALUES ($1::uuid, $2::uuid, $3, $4::citext, 'pending')`,
		f.tenantID, f.listB, f.phone, victim); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed victim subscription: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// A DIFFERENT subscriber grants on the same phone.
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	if !vectorSet(t, pool, f.tenantID, victim) {
		t.Fatal("another subscriber's consent write cleared this subscriber's " +
			"SMS consent, which did not derive from SMS at all. The grant date is " +
			"evidence in a consent receipt and is now unrecoverable.")
	}
	if !vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("the subscriber who actually granted was not projected")
	}
}

func TestConsentCannotBeAssertedForASubscriberWithADifferentPhone(t *testing.T) {
	// `RecordConsent` takes a caller-supplied `SubscriberEmail` and does not check
	// that it belongs to the phone that consented. That was inert while the
	// activation column was permanently NULL; projecting it made a write-scoped
	// call able to open ANOTHER subscriber's SMS gate by naming their address.
	//
	// The binding cannot be demanded outright — most subscribers have no
	// `phone_e164` recorded, and requiring a match would fail closed for entire
	// tenants, reinstating the "resolves nobody" bug this work removed. What can
	// be demanded is that the binding is not CONTRADICTED: a subscriber whose own
	// number is on file and is a different number did not consent on this one.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	other := "sms-otherphone-" + f.email
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source, phone_e164)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api', '+15559998888')`,
		f.tenantID, other); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed other-phone subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// A consent write on f.phone naming a subscriber whose number is different.
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: other,
		Action: ConsentGranted, Source: "api", ProofText: "Affirmative test consent",
		Metadata: map[string]any{"evidence_type": "operator_attestation", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("record consent: %v", err)
	}

	if vectorSet(t, pool, f.tenantID, other) {
		t.Fatal("a consent write on one phone opened the SMS activation gate for a " +
			"subscriber whose own number on file is a different one. Nothing about " +
			"that call is evidence that this person consented.")
	}
}

func TestAnUnrecordedPhoneDoesNotBlockConsent(t *testing.T) {
	// The other half, and the reason the rule is "not contradicted" rather than
	// "must match": most subscribers have no phone on file, and demanding one
	// would fail closed for whole tenants — exactly the outage this work removed.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if !vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("a subscriber with no phone on file was refused SMS consent. The " +
			"binding check must reject only a CONTRADICTED binding, not an absent one.")
	}
}

func TestAnUnboundRevokeCannotDestroyAnotherSubscribersConsent(t *testing.T) {
	// The direction the first guard missed, and the more damaging one.
	//
	// Migration 1863 added the binding check to the ELIGIBLE branch only. The
	// symmetric grant was refused, but a REVOKE naming an unrelated subscriber
	// still cleared their consent date — irreversible loss of consent evidence
	// plus a denial of service on the channel, and unlike the grant direction it
	// needed no phone on file at all.
	//
	// Both of migrations 1861 and 1862 promise in their own text that derivation
	// never clears a grant it did not create. This is that promise under attack.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	victim := "sms-revoke-victim-" + f.email
	granted := time.Now().UTC().Add(-365 * 24 * time.Hour)
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source,
		                         phone_e164, consent_sms_marketing_at)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api', '+15551110000', $3)`,
		f.tenantID, victim, granted); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed victim: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// A revoke on a DIFFERENT number, naming the victim's address.
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: victim,
		Action: ConsentRevoked, Source: "api",
	}); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	if !vectorSet(t, pool, f.tenantID, victim) {
		t.Fatal("a revoke on an unrelated phone erased a subscriber's SMS consent " +
			"date. Nothing about that call is evidence that this person withdrew, " +
			"and the original grant date is unrecoverable.")
	}
}

func TestBindingComparesNormalisedDigitsNotRawStrings(t *testing.T) {
	// The fail-closed hazard in the first binding rule. `sms_subscriptions`
	// stores NormalizePhoneUSCA output (`+1XXXXXXXXXX`) while the subscriber-side
	// normalizers are international and disagree, and migration 0476 explicitly
	// permits legacy partially-formatted rows. A raw string comparison refuses a
	// subscriber opting in ON THEIR OWN NUMBER stored as `555 933 0457` — a
	// fail-closed outage wearing a safety check's clothes, and the two audiences
	// disagree again.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()

	for _, stored := range []string{"5559330457", "+1 555 933 0457", "+1-555-933-0457", "15559330457"} {
		t.Run(stored, func(t *testing.T) {
			f := seedSMSConsentFixture(t, pool)
			tx, err := db.WithTenant(ctx, pool, f.tenantID)
			if err != nil {
				t.Fatalf("tenant scope: %v", err)
			}
			if _, err := tx.Exec(ctx, `
				UPDATE subscribers SET phone_e164 = $2
				 WHERE tenant_id = $1::uuid AND email = $3::citext`,
				f.tenantID, stored, f.email); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatalf("set stored phone: %v", err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatalf("commit: %v", err)
			}

			// Opt in on the SAME number, in canonical form.
			if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
				PhoneE164: "+15559330457", ListID: f.listA, SubscriberEmail: f.email,
				Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
			}); err != nil {
				t.Fatalf("grant: %v", err)
			}
			if !vectorSet(t, pool, f.tenantID, f.email) {
				t.Fatalf("a subscriber whose number is stored as %q was refused consent "+
					"for opting in on that very number. The binding must compare "+
					"normalised digits, not raw strings.", stored)
			}
		})
	}
}

// omnichannelWouldMaterialize runs the EXACT predicate
// `internal/omnichannel/runtime.go` uses to materialize an SMS/WhatsApp/RCS
// recipient: the send identity column, non-null and non-empty.
//
// Asserting on the column alone would certify my own assumption about what
// omnichannel needs. This runs the condition that decides whether a message is
// ever created.
func omnichannelWouldMaterialize(t *testing.T, pool *db.Pool, tenantID, email string) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ok bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM subscribers
			 WHERE tenant_id = $1::uuid AND email = $2::citext
			   AND COALESCE(phone_e164, sms_send_identity) IS NOT NULL
			   AND COALESCE(phone_e164, sms_send_identity)::text <> '')`,
		tenantID, email).Scan(&ok); err != nil {
		t.Fatalf("materialization predicate: %v", err)
	}
	return ok
}

func TestOptingInGivesOmnichannelASendIdentity(t *testing.T) {
	// Consent was only half the outage.
	//
	// `omnichannel/runtime.go:57` uses `subscribers.phone_e164` as the send
	// identity for sms, whatsapp AND rcs, and filters it non-null before
	// inserting an omni_recipients row. No production path writes that column:
	// migration 0476 adds it with no backfill, `subscriberColumns` does not select
	// it, Create/Update have no phone field, and its only writers set it to NULL.
	//
	// So opening the consent gate (1861/1862) was necessary and NOT sufficient —
	// a fully consenting subscriber still materialized zero recipients, and the
	// send looked like it had simply found nobody to send to.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if omnichannelWouldMaterialize(t, pool, f.tenantID, f.email) {
		t.Fatal("precondition: the subscriber should have no send identity yet")
	}

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	if !vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("precondition: consent should be open")
	}
	if !omnichannelWouldMaterialize(t, pool, f.tenantID, f.email) {
		t.Fatal("the subscriber opted in, consent is open, and omnichannel would " +
			"still materialize ZERO recipients because subscribers.phone_e164 — the " +
			"send identity for sms/whatsapp/rcs — is empty. The send finds nobody " +
			"and reports success.")
	}
}

func TestTheSendIdentityIsThePhoneTheyConsentedOn(t *testing.T) {
	// Not merely "some phone". The identity must be the number whose opt-in
	// authorises the send, or the message goes to a number nobody consented for
	// while the consent record points at a different one.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var identity string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(COALESCE(phone_e164, sms_send_identity)::text, '') FROM subscribers
		 WHERE tenant_id = $1::uuid AND email = $2::citext`,
		f.tenantID, f.email).Scan(&identity); err != nil {
		t.Fatalf("read identity: %v", err)
	}
	if identity != f.phone {
		t.Fatalf("send identity is %q, want the consented number %q", identity, f.phone)
	}
}

func TestAnExistingSendIdentityIsNotOverwritten(t *testing.T) {
	// The column is a profile field a tenant may already maintain through their
	// own import. Derivation fills a gap; it must not overwrite an operator's
	// data with a number that merely happens to have an SMS subscription.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	// The SAME number in a DIFFERENT format: same last ten digits, so the binding
	// is not contradicted, but a distinct string so an overwrite is detectable.
	//
	// An earlier version used `"+1" + f.phone[2:]`, which is byte-identical to
	// f.phone — the test passed over a mutation that replaced COALESCE with a
	// plain assignment, because overwriting produced the same value.
	stored := f.phone[1:]
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE subscribers SET phone_e164 = $2
		 WHERE tenant_id = $1::uuid AND email = $3::citext`,
		f.tenantID, stored, f.email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("preset identity: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	tx2, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx2.Rollback(ctx) }()
	var got string
	if err := tx2.QueryRow(ctx, `
		SELECT COALESCE(COALESCE(phone_e164, sms_send_identity)::text, '') FROM subscribers
		 WHERE tenant_id = $1::uuid AND email = $2::citext`,
		f.tenantID, f.email).Scan(&got); err != nil {
		t.Fatalf("read identity: %v", err)
	}
	if got != stored {
		t.Fatalf("derivation overwrote an operator-maintained send identity: "+
			"had %q, now %q", stored, got)
	}
}

func TestChangingNumbersAfterAStopDoesNotLockTheSubscriberOut(t *testing.T) {
	// The self-poisoning loop migration 1866 exists to break.
	//
	// 1865 derived the send identity into `subscribers.phone_e164` — the exact
	// column `sms_binding_not_contradicted` reads as EVIDENCE of which number
	// belongs to a subscriber. The guard began arbitrating against its own
	// output, and because the identity is never cleared on revoke, permanently:
	//
	//   opt in on A -> identity = A       STOP -> gate closed, identity kept
	//   opt in on B -> guard sees A as evidence, contradicts B, gate stays shut
	//
	// Meanwhile `sms_subscriptions` still holds B opted_in, so the broadcast
	// audience would text B while the activation gate reports no consent — the
	// two-audiences split, reopened in the opposite direction.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	newPhone := "+1555" + randomDigits(t)

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant on the first number: %v", err)
	}
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: f.phone, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentRevoked, Source: "keyword",
	}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("precondition: the STOP should have closed the gate")
	}

	// A new number, a fresh opt-in.
	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: newPhone, ListID: f.listB, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("grant on the new number: %v", err)
	}

	if !vectorSet(t, pool, f.tenantID, f.email) {
		t.Fatal("a subscriber who stopped on one number and opted in on a new one " +
			"is permanently locked out: the derived identity from the old number is " +
			"being read back as evidence that the new one is not theirs.")
	}
	if !broadcastEligible(t, pool, f.tenantID, newPhone) {
		t.Fatal("the broadcast audience excludes the new number too")
	}
}

func TestTheDerivedIdentityFollowsTheMostRecentConsent(t *testing.T) {
	// The ORDER BY was completely untested: a review mutated it to a fully
	// inverted rule and all three original tests still passed, because each
	// seeded exactly one subscription so every selection rule gave the same
	// answer.
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	older, newer := f.phone, "+1555"+randomDigits(t)

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: older, ListID: f.listA, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("first grant: %v", err)
	}
	// RecordConsent uses DB clock time. Keep a small separation so the second
	// immutable event/projection tuple is unambiguously newer without mutating
	// either evidence timestamp after the fact.
	time.Sleep(2 * time.Millisecond)

	if err := store.RecordConsent(ctx, f.tenantID, ConsentInput{
		PhoneE164: newer, ListID: f.listB, SubscriberEmail: f.email,
		Action: ConsentGranted, Source: "form", ProofText: "Affirmative test consent", Metadata: map[string]any{"evidence_type": "web_form", "evidence_id": "route40-test-consent"},
	}); err != nil {
		t.Fatalf("second grant: %v", err)
	}

	tx2, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx2.Rollback(ctx) }()
	var identity string
	if err := tx2.QueryRow(ctx, `
		SELECT COALESCE(sms_send_identity, '') FROM subscribers
		 WHERE tenant_id = $1::uuid AND email = $2::citext`,
		f.tenantID, f.email).Scan(&identity); err != nil {
		t.Fatalf("read identity: %v", err)
	}
	if identity != newer {
		t.Fatalf("send identity is %q, want the most recently consented number %q. "+
			"Two eligible opt-ins must resolve deterministically to the newest, or "+
			"the number a message goes to depends on row order.", identity, newer)
	}
}

// deleteSMSTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure fails the test, so a leaked tenant cannot go unnoticed.
//
// A delete that finds no row is accepted, because some tests delete the
// fixture tenant themselves: as their assertion
// (TestSuppressionDeleteGuardDoesNotBlockTenantCascade), or in a cleanup of
// their own that runs first
// (TestRoute42ReadIndexesSupportProductionQueryShapes). The DELETE here is
// always tenant-bound, so zero rows means the tenant is already gone, not that
// it was hidden.
func deleteSMSTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteSMSTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed > 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want at most 1", tenantID, removed)
		}
		return
	}
}

func deleteSMSTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
