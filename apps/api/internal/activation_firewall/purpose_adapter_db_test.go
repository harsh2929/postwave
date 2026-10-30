// SPDX-License-Identifier: AGPL-3.0-only

package activation_firewall

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func newFirewallPurposeTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed activation-consent tests")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedFirewallPurposeTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'activation-purpose-test',
        'activation-purpose-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
}

type firewallPurposeFixture struct {
	canonicalEmail string
	addressEmail   string
	consentStatus  string
	suppressed     bool
	noLegacyGrant  bool
	wantAllowed    bool
}

// insertFirewallPurposeAddress creates the per-address projection row in its
// pre-decision state. Migration 1766 initializes every new address
// failed_closed; only the terminal projection may promote it.
func insertFirewallPurposeAddress(
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

// proveFirewallAddressGrant commits the exact paired consent event + structured
// consent record that migration 1766 accepts as email-marketing grant
// evidence — the same shape the production per-address consent writer commits.
// It is the only mechanism that reaches consent_reconciliation_state='proven',
// which 1766 requires before a subscribed address or the raw
// subscribers.consent_email_marketing_at vector is legal.
func proveFirewallAddressGrant(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, addressID, email string,
) {
	t.Helper()
	occurredAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	const (
		jurisdiction = "US"
		reason       = "Canonical activation-firewall database fixture"
		operation    = "activation_firewall_fixture"
		policy       = "activation-firewall-test-v1"
		proof        = "Reviewed exact-address grant for activation firewall testing."
	)
	eventID, err := consent.RecordEventInTx(ctx, tx, consent.EventInput{
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

// seedFirewallPurposeFixture builds each fixture's exact end state.
//
// Migration 1766 couples the two projections this test is about: the raw
// subscribers.consent_email_marketing_at vector is only accepted while the
// exact canonical subscriber_emails row holds a proven terminal grant, and a
// subscribed address is only accepted while that proof is its latest decision.
// Every fixture that needs the legacy vector therefore earns it by proving the
// canonical address, and the fixtures whose whole point is a divergence between
// the two projections re-diverge them in a SECOND transaction (downgraded
// address status, deleted address row, cleared vector). The second transaction
// matters: the deferred subscribers_reconcile_email_identity trigger only
// re-runs on a subscribers insert / email change, so a later address-only
// mutation is exactly how these states arise in production. No positive consent
// column is written without real backing evidence.
func seedFirewallPurposeFixture(t *testing.T, pool *pgxpool.Pool, tenantID string, fixture firewallPurposeFixture) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("fixture tenant scope: %v", err)
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
		// Keep the fixture's exact spelling so the case-folding assertion still
		// exercises a differently-cased stored address.
		canonicalAddressEmail = fixture.addressEmail
	}
	canonicalAddressID := insertFirewallPurposeAddress(t, ctx, tx, tenantID, subscriberID,
		canonicalAddressEmail, true, addressIsCanonical && fixture.suppressed)
	proveFirewallAddressGrant(t, ctx, tx, tenantID, subscriberID, canonicalAddressID, canonicalAddressEmail)

	if fixture.addressEmail != "" && !addressIsCanonical {
		otherAddressID := insertFirewallPurposeAddress(t, ctx, tx, tenantID, subscriberID,
			fixture.addressEmail, false, fixture.suppressed)
		if fixture.consentStatus == "subscribed" {
			proveFirewallAddressGrant(t, ctx, tx, tenantID, subscriberID, otherAddressID, fixture.addressEmail)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture %s: %v", fixture.canonicalEmail, err)
	}

	divergeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("fixture divergence scope: %v", err)
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
	if fixture.noLegacyGrant {
		// The terminal projection folds the legacy vector from the proven grant.
		// Restore the deliberately inconsistent state to prove both projections
		// are required.
		if _, err := divergeTx.Exec(ctx, `
UPDATE subscribers
   SET consent_email_marketing_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
			t.Fatalf("reset legacy projection for %s: %v", fixture.canonicalEmail, err)
		}
	}
	if err := divergeTx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture divergence %s: %v", fixture.canonicalEmail, err)
	}
}

func TestPurposeBatchAdapterEmailMarketingRequiresExactCanonicalAddressProjection(t *testing.T) {
	pool := newFirewallPurposeTestPool(t)
	tenantID := uuid.NewString()
	seedFirewallPurposeTenant(t, pool, tenantID)

	positive := "firewall-positive-" + uuid.NewString() + "@example.test"
	caseCanonical := "Firewall-Case-" + uuid.NewString() + "@Example.Test"
	legacyMissing := "firewall-legacy-missing-" + uuid.NewString() + "@example.test"
	missing := "firewall-missing-" + uuid.NewString() + "@example.test"
	mismatch := "firewall-mismatch-" + uuid.NewString() + "@example.test"
	never := "firewall-never-" + uuid.NewString() + "@example.test"
	unsubscribed := "firewall-unsubscribed-" + uuid.NewString() + "@example.test"
	suppressed := "firewall-suppressed-" + uuid.NewString() + "@example.test"
	fixtures := []firewallPurposeFixture{
		{canonicalEmail: positive, addressEmail: positive, consentStatus: "subscribed", wantAllowed: true},
		{canonicalEmail: caseCanonical, addressEmail: strings.ToUpper(caseCanonical), consentStatus: "subscribed", wantAllowed: true},
		{canonicalEmail: legacyMissing, addressEmail: legacyMissing, consentStatus: "subscribed", noLegacyGrant: true},
		{canonicalEmail: missing},
		{canonicalEmail: mismatch, addressEmail: "other-" + uuid.NewString() + "@example.test", consentStatus: "subscribed"},
		{canonicalEmail: never, addressEmail: never, consentStatus: "never_subscribed"},
		{canonicalEmail: unsubscribed, addressEmail: unsubscribed, consentStatus: "unsubscribed"},
		{canonicalEmail: suppressed, addressEmail: suppressed, consentStatus: "subscribed", suppressed: true},
	}
	for _, fixture := range fixtures {
		seedFirewallPurposeFixture(t, pool, tenantID, fixture)
	}

	emails := make([]string, 0, len(fixtures)+1)
	for _, fixture := range fixtures {
		emails = append(emails, strings.ToUpper(fixture.canonicalEmail))
	}
	incomplete := "firewall-no-subscriber-" + uuid.NewString() + "@example.test"
	emails = append(emails, strings.ToUpper(incomplete))

	adapter := &PurposeBatchAdapter{Pool: pool}
	allowed, err := adapter.AllowedBatch(context.Background(), tenantID, emails,
		string(consent.PurposeEmailMarketing))
	if err != nil {
		t.Fatalf("AllowedBatch: %v", err)
	}
	for _, fixture := range fixtures {
		key := strings.ToLower(fixture.canonicalEmail)
		got, exists := allowed[key]
		if !exists || got != fixture.wantAllowed {
			t.Fatalf("allowed[%s] = %v exists=%v; want %v", key, got, exists, fixture.wantAllowed)
		}
	}
	if got, exists := allowed[strings.ToLower(incomplete)]; !exists || got {
		t.Fatalf("incomplete member = %v exists=%v; want explicit denial", got, exists)
	}

	decision := New(adapter, nil).Decide(context.Background(), tenantID,
		consent.PurposeEmailMarketing, "warehouse", emails)
	sort.Strings(decision.Kept)
	wantKept := []string{strings.ToLower(caseCanonical), strings.ToLower(positive)}
	sort.Strings(wantKept)
	if strings.Join(decision.Kept, "|") != strings.Join(wantKept, "|") {
		t.Fatalf("firewall kept %v, want %v", decision.Kept, wantKept)
	}
	if len(decision.Excluded) != len(emails)-len(wantKept) {
		t.Fatalf("firewall excluded %d, want %d", len(decision.Excluded), len(emails)-len(wantKept))
	}
	excludedByEmail := make(map[string]ExclusionRecord, len(decision.Excluded))
	for _, excluded := range decision.Excluded {
		excludedByEmail[excluded.SubscriberEmail] = excluded
		if excluded.RuleClass != RuleClassConsent {
			t.Fatalf("known denial should be a consent exclusion, got %+v", excluded)
		}
	}
	if excluded, exists := excludedByEmail[strings.ToLower(incomplete)]; !exists || excluded.RuleClass != RuleClassConsent {
		t.Fatalf("incomplete batch member was not explicitly consent-denied: %+v exists=%v", excluded, exists)
	}
}

func TestPurposeBatchAdapterDatabaseFailureFailsClosed(t *testing.T) {
	pool := newFirewallPurposeTestPool(t)
	pool.Close()
	adapter := &PurposeBatchAdapter{Pool: pool}
	emails := []string{"firewall-db-one@example.test", "firewall-db-two@example.test"}

	out, err := adapter.AllowedBatch(context.Background(), uuid.NewString(), emails,
		string(consent.PurposeEmailMarketing))
	if err == nil {
		t.Fatal("closed pool returned no error")
	}
	for _, email := range emails {
		if allowed, exists := out[email]; !exists || allowed {
			t.Fatalf("out[%s] = %v exists=%v; want explicit denial", email, allowed, exists)
		}
	}

	decision := New(adapter, nil).Decide(context.Background(), uuid.NewString(),
		consent.PurposeEmailMarketing, "warehouse", emails)
	if len(decision.Kept) != 0 || len(decision.Excluded) != len(emails) {
		t.Fatalf("DB failure decision = kept %v excluded %v", decision.Kept, decision.Excluded)
	}
	for _, excluded := range decision.Excluded {
		if excluded.RuleClass != RuleClassPolicy || excluded.RuleReason != ReasonConsentLookupUnavailable {
			t.Fatalf("DB failure exclusion is not policy fail-deny: %+v", excluded)
		}
	}
}
