// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type purposeAddressFixture struct {
	canonicalEmail string
	addressEmail   string
	consentStatus  string
	suppressed     bool
	noLegacyGrant  bool
	wantAllowed    bool
}

// insertPurposeAddress creates the per-address projection row in its
// pre-decision state. Migration 1766 initializes every new address
// failed_closed; only the terminal projection may promote it.
func insertPurposeAddress(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, email string,
	isPrimary, suppressed bool,
) string {
	t.Helper()
	var addressID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3::citext, $4, 'never_subscribed', $5)
RETURNING id::text`,
		tenantID, subscriberID, email, isPrimary, suppressed).Scan(&addressID); err != nil {
		t.Fatalf("insert address projection for %s: %v", email, err)
	}
	return addressID
}

// provePurposeAddressGrant commits the exact paired consent event + structured
// consent record that migration 1766 accepts as email-marketing grant
// evidence. This is the same shape the production per-address consent writer
// (subscribers.recordEmailConsentEvidence) commits, and it is the only way to
// reach consent_reconciliation_state = 'proven': the record insert trigger
// folds the terminal decision, which flips the address to 'subscribed' and
// projects subscribers.consent_email_marketing_at for a canonical address.
// Writing those positive columns directly is rejected by 1766's constraint
// triggers, so the fixture must go through real proof.
func provePurposeAddressGrant(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, addressID, email string,
) {
	t.Helper()
	occurredAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	const (
		jurisdiction = "US"
		reason       = "Canonical purpose-lookup database fixture"
		operation    = "purpose_lookup_fixture"
		policy       = "purpose-lookup-test-v1"
		proof        = "Reviewed exact-address grant for purpose lookup testing."
	)
	eventID, err := RecordEventInTx(ctx, tx, EventInput{
		TenantID:      tenantID,
		SubjectType:   "subscriber",
		SubjectID:     addressID,
		SubjectEmail:  email,
		Channel:       "email",
		Category:      "email_marketing",
		Action:        "granted",
		Source:        "double_optin",
		PolicyVersion: policy,
		ProofText:     proof,
		Preferences: map[string]any{
			"legal_basis":    "consent",
			"jurisdiction":   jurisdiction,
			"reason":         reason,
			"operation":      operation,
			"subscriber_id":  subscriberID,
			"address_id":     addressID,
			"consent_status": "subscribed",
		},
		OccurredAt: &occurredAt,
	})
	if err != nil {
		t.Fatalf("record consent event for %s: %v", email, err)
	}
	evidence, err := json.Marshal(map[string]any{
		"event_id":       eventID,
		"address_id":     addressID,
		"operation":      operation,
		"legal_basis":    "consent",
		"jurisdiction":   jurisdiction,
		"reason":         reason,
		"policy_version": policy,
		"evidence":       proof,
	})
	if err != nil {
		t.Fatalf("encode consent proof for %s: %v", email, err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records
       (tenant_id, subscriber_id, email, channel, consent_status, source,
        captured_at, evidence)
VALUES ($1::uuid, $2::uuid, $3::citext, 'email', 'granted', 'double_optin',
        $4::timestamptz, $5::jsonb)`,
		tenantID, subscriberID, email, occurredAt, string(evidence)); err != nil {
		t.Fatalf("record structured consent proof for %s: %v", email, err)
	}
}

// seedPurposeAddressFixture builds each fixture's exact end state.
//
// Migration 1766 couples the two projections this test is about: the raw
// subscribers.consent_email_marketing_at vector is only accepted while the
// exact canonical subscriber_emails row holds a proven terminal grant, and a
// subscribed address is only accepted while that same proof is its latest
// decision. So every fixture that needs the legacy vector first earns it by
// proving the canonical address, and the fixtures whose whole point is a
// divergence between the two projections then re-diverge them in a SECOND
// transaction (a downgraded address consent_status, a deleted address row, or a
// cleared vector). The second transaction matters: the deferred
// subscribers_reconcile_email_identity trigger only re-runs on a subscribers
// insert / email change, so a later address-only mutation is exactly how these
// states arise — and survive — in production. Nothing here writes a positive
// consent column that is not backed by real evidence.
func seedPurposeAddressFixture(t *testing.T, pool *pgxpool.Pool, tenantID string, fixture purposeAddressFixture) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers
       (tenant_id, email, primary_email, status, mailchimp_status,
        consent_source)
VALUES ($1::uuid, $2::citext, $2::citext, 'enabled', 'subscribed', 'api')
RETURNING id::text`, tenantID, fixture.canonicalEmail).Scan(&subscriberID); err != nil {
		t.Fatalf("insert subscriber %s: %v", fixture.canonicalEmail, err)
	}

	addressIsCanonical := fixture.addressEmail != "" &&
		strings.EqualFold(strings.TrimSpace(fixture.addressEmail), strings.TrimSpace(fixture.canonicalEmail))
	canonicalAddressEmail := fixture.canonicalEmail
	if addressIsCanonical {
		// Preserve the fixture's exact spelling so the case-folding assertion
		// still exercises a differently-cased stored address.
		canonicalAddressEmail = fixture.addressEmail
	}
	canonicalAddressID := insertPurposeAddress(t, ctx, tx, tenantID, subscriberID,
		canonicalAddressEmail, true, addressIsCanonical && fixture.suppressed)
	provePurposeAddressGrant(t, ctx, tx, tenantID, subscriberID, canonicalAddressID, canonicalAddressEmail)

	if fixture.addressEmail != "" && !addressIsCanonical {
		otherAddressID := insertPurposeAddress(t, ctx, tx, tenantID, subscriberID,
			fixture.addressEmail, false, fixture.suppressed)
		if fixture.consentStatus == "subscribed" {
			provePurposeAddressGrant(t, ctx, tx, tenantID, subscriberID, otherAddressID, fixture.addressEmail)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit purpose fixture %s: %v", fixture.canonicalEmail, err)
	}

	divergeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = divergeTx.Rollback(ctx) }()
	switch {
	case fixture.addressEmail == "" || !addressIsCanonical:
		// No canonical address is wanted: the proven grant stays in the ledger
		// and the folded legacy vector survives the address row's removal.
		if _, err := divergeTx.Exec(ctx, `
DELETE FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, canonicalAddressID); err != nil {
			t.Fatalf("drop canonical address for %s: %v", fixture.canonicalEmail, err)
		}
	case fixture.consentStatus != "subscribed":
		if _, err := divergeTx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, canonicalAddressID, fixture.consentStatus); err != nil {
			t.Fatalf("diverge canonical address status for %s: %v", fixture.canonicalEmail, err)
		}
	}
	// The terminal projection folds the legacy vector from the proven grant.
	// Clear it again for this deliberately inconsistent fixture so the test
	// proves the legacy projection remains independently necessary.
	if fixture.noLegacyGrant {
		if _, err := divergeTx.Exec(ctx, `
UPDATE subscribers
   SET consent_email_marketing_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
			t.Fatalf("reset legacy projection for %s: %v", fixture.canonicalEmail, err)
		}
	}
	if err := divergeTx.Commit(ctx); err != nil {
		t.Fatalf("commit purpose fixture divergence %s: %v", fixture.canonicalEmail, err)
	}
	return subscriberID
}

func TestPurposeLookupEmailMarketingRequiresExactCanonicalAddressProjection(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	// Keep the canonical/side values paired while still making every fixture
	// globally unique in a shared integration database.
	positive := "purpose-positive-" + uuid.NewString() + "@example.test"
	caseCanonical := "Purpose-Case-" + uuid.NewString() + "@Example.Test"
	missing := "purpose-missing-" + uuid.NewString() + "@example.test"
	mismatch := "purpose-mismatch-" + uuid.NewString() + "@example.test"
	never := "purpose-never-" + uuid.NewString() + "@example.test"
	unsubscribed := "purpose-unsubscribed-" + uuid.NewString() + "@example.test"
	suppressed := "purpose-suppressed-" + uuid.NewString() + "@example.test"
	legacyMissing := "purpose-legacy-missing-" + uuid.NewString() + "@example.test"
	fixtures := []purposeAddressFixture{
		{canonicalEmail: positive, addressEmail: positive, consentStatus: "subscribed", wantAllowed: true},
		{canonicalEmail: caseCanonical, addressEmail: strings.ToUpper(caseCanonical), consentStatus: "subscribed", wantAllowed: true},
		{canonicalEmail: legacyMissing, addressEmail: legacyMissing, consentStatus: "subscribed", noLegacyGrant: true, wantAllowed: false},
		{canonicalEmail: missing, addressEmail: "", consentStatus: "", wantAllowed: false},
		{canonicalEmail: mismatch, addressEmail: "other-" + uuid.NewString() + "@example.test", consentStatus: "subscribed", wantAllowed: false},
		{canonicalEmail: never, addressEmail: never, consentStatus: "never_subscribed", wantAllowed: false},
		{canonicalEmail: unsubscribed, addressEmail: unsubscribed, consentStatus: "unsubscribed", wantAllowed: false},
		{canonicalEmail: suppressed, addressEmail: suppressed, consentStatus: "subscribed", suppressed: true, wantAllowed: false},
	}
	for _, fixture := range fixtures {
		seedPurposeAddressFixture(t, pool, tenantID, fixture)
	}

	lookup := &PurposeLookup{Pool: pool}
	for _, fixture := range fixtures {
		t.Run(fixture.consentStatus+"/"+fixture.canonicalEmail, func(t *testing.T) {
			allowed, err := lookup.Allowed(context.Background(), tenantID,
				strings.ToUpper(fixture.canonicalEmail), string(PurposeEmailMarketing))
			if err != nil || allowed != fixture.wantAllowed {
				t.Fatalf("Allowed(%s) = %v, %v; want %v", fixture.canonicalEmail, allowed, err, fixture.wantAllowed)
			}
		})
	}

	batchEmails := make([]string, 0, len(fixtures)+1)
	for _, fixture := range fixtures {
		batchEmails = append(batchEmails, strings.ToUpper(fixture.canonicalEmail))
	}
	incomplete := "purpose-no-subscriber-" + uuid.NewString() + "@example.test"
	batchEmails = append(batchEmails, incomplete)
	batch, err := lookup.AllowedBatch(context.Background(), tenantID, batchEmails, string(PurposeEmailMarketing))
	if err != nil {
		t.Fatalf("AllowedBatch: %v", err)
	}
	for _, fixture := range fixtures {
		key := strings.ToLower(fixture.canonicalEmail)
		allowed, exists := batch[key]
		if !exists || allowed != fixture.wantAllowed {
			t.Fatalf("batch[%s] = %v exists=%v; want %v", key, allowed, exists, fixture.wantAllowed)
		}
	}
	if allowed, exists := batch[incomplete]; !exists || allowed {
		t.Fatalf("incomplete batch member = %v exists=%v; want explicit denial", allowed, exists)
	}
}

func TestPurposeLookupDatabaseFailureFailsClosed(t *testing.T) {
	pool := newTrackingTestPool(t)
	pool.Close()
	lookup := &PurposeLookup{Pool: pool}
	tenantID := uuid.NewString()
	email := "purpose-db-failure@example.test"
	allowed, err := lookup.Allowed(context.Background(), tenantID, email, string(PurposeEmailMarketing))
	if err == nil || allowed {
		t.Fatalf("closed pool single lookup = %v, %v; want denied error", allowed, err)
	}
	batch, err := lookup.AllowedBatch(context.Background(), tenantID, []string{email}, string(PurposeEmailMarketing))
	if err == nil {
		t.Fatal("closed pool batch lookup returned no error")
	}
	if allowed, exists := batch[email]; !exists || allowed {
		t.Fatalf("closed pool batch = %v exists=%v; want explicit denial", allowed, exists)
	}
}

func TestPurposeLookupNonEmailPurposeRetainsLegacyProjection(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	email := "purpose-profiling-" + uuid.NewString() + "@example.test"
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers
       (tenant_id, email, status, mailchimp_status, consent_source, consent_profiling_at)
VALUES ($1::uuid, $2::citext, 'enabled', 'subscribed', 'api', $3::timestamptz)`,
		tenantID, email, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	allowed, err := (&PurposeLookup{Pool: pool}).Allowed(ctx, tenantID, email, string(PurposeProfiling))
	if err != nil || !allowed {
		t.Fatalf("profiling lookup = %v, %v; want legacy grant", allowed, err)
	}
}
