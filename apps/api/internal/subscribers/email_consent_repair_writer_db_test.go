// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func requireConsentRepairWriterAppRole(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var user string
	if err := pool.QueryRow(context.Background(), `SELECT current_user`).Scan(&user); err != nil {
		t.Fatalf("read application database role: %v", err)
	}
	if user != "postwave_app" {
		t.Skipf("DATABASE_URL must authenticate as postwave_app for RLS writer proof; got %q", user)
	}
}

func migration1766AddressForSubscriber(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	subscriber *Subscriber,
) migration1766Address {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("address lookup tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	address := migration1766Address{SubscriberID: subscriber.ID, Email: subscriber.Email}
	if err := tx.QueryRow(context.Background(), `
SELECT id::text, email::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, subscriber.ID, subscriber.Email).Scan(
		&address.ID, &address.Email,
	); err != nil {
		t.Fatalf("read subscriber address: %v", err)
	}
	return address
}

func loadRepairWriterAddress(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, subscriberID, addressID string,
) SubscriberEmail {
	t.Helper()
	items, err := (&Repo{Pool: pool}).ListEmails(
		context.Background(), tenantID, subscriberID,
	)
	if err != nil {
		t.Fatalf("list address before it becomes hidden: %v", err)
	}
	for _, item := range items {
		if item.ID == addressID {
			return item
		}
	}
	t.Fatalf("address %s missing from pre-hide list", addressID)
	return SubscriberEmail{}
}

func waitForConsentProofExpiry(t *testing.T, expiresAt time.Time) {
	t.Helper()
	if wait := time.Until(expiresAt.Add(150 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
}

func assertConsentAddressHiddenFromApp(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	address migration1766Address,
) {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("hidden-address check tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var visible int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, address.ID).Scan(&visible); err != nil {
		t.Fatalf("check hidden address: %v", err)
	}
	if visible != 0 {
		t.Fatalf("app-role visible hidden address rows = %d, want 0", visible)
	}
}

func TestEmailChannelConsentRepairResolverRevokesWhileReleaseGateBlocked(t *testing.T) {
	// Blocking the deployment-wide gate hides subscribed rows in every
	// tenant, so it happens only in the isolated database.
	gate := isolatedReleaseGateDatabase(t)
	pool := gate.appPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41771"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	repo := channelConsentRepo(pool)

	grant := channelConsentDecision("opted_in", time.Now().UTC().Add(-time.Hour))
	grant.IfMatchToken = subscriber.Version
	granted, err := repo.SetChannelConsentWithAudit(
		ctx, tenantID, subscriber.ID, "email", grant, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("seed channel grant: %v", err)
	}
	address := migration1766Address{
		ID:           migration1766AddressForSubscriber(t, pool, tenantID, subscriber).ID,
		SubscriberID: subscriber.ID,
		Email:        subscriber.Email,
	}
	multiSubscriber := seedMultiEmailSubscriber(
		t, &Repo{Pool: pool}, tenantID,
		fmt.Sprintf("gate-blocked-multi-%d@example.test", time.Now().UnixNano()),
	)
	multiAddress := migration1766AddressForSubscriber(t, pool, tenantID, multiSubscriber)
	appendMigration1766ExactGrant(
		t, pool, tenantID, multiAddress, time.Now().UTC().Add(-time.Hour),
		time.Now().UTC().Add(24*time.Hour), "privacy-2026-07", "writer-gate-blocked:multi",
	)
	multiCurrent := loadRepairWriterAddress(
		t, pool, tenantID, multiSubscriber.ID, multiAddress.ID,
	)
	addOwner := seedMultiEmailSubscriber(
		t, &Repo{Pool: pool}, tenantID,
		fmt.Sprintf("gate-blocked-add-owner-%d@example.test", time.Now().UnixNano()),
	)
	enableOwner := seedMultiEmailSubscriber(
		t, &Repo{Pool: pool}, tenantID,
		fmt.Sprintf("gate-blocked-enable-%d@example.test", time.Now().UnixNano()),
	)

	gate.block(t)

	assertConsentAddressHiddenFromApp(t, pool, tenantID, address)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, multiAddress)
	multiRepo := &Repo{Pool: pool}
	yes := true
	suppressed, err := multiRepo.UpdateEmail(
		ctx, tenantID, multiSubscriber.ID, multiAddress.ID,
		UpdateEmailInput{
			Suppressed:          &yes,
			SuppressionReason:   "authorized temporary safety hold",
			SuppressionEvidence: "ticket:gate-blocked-suppress",
			IfMatchToken:        multiCurrent.Version,
		}, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("suppress hidden gate-blocked address: %v", err)
	}
	if !suppressed.Suppressed || suppressed.Version == multiCurrent.Version {
		t.Fatalf("hidden suppression response = %#v", suppressed)
	}
	no := false
	unsuppressed, err := multiRepo.UpdateEmail(
		ctx, tenantID, multiSubscriber.ID, multiAddress.ID,
		UpdateEmailInput{
			Suppressed:          &no,
			SuppressionReason:   "reviewed temporary hold removal",
			SuppressionEvidence: "ticket:gate-blocked-unsuppress",
			IfMatchToken:        suppressed.Version,
		}, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("unsuppress hidden gate-blocked address: %v", err)
	}
	if unsuppressed.Suppressed || unsuppressed.Version == suppressed.Version {
		t.Fatalf("hidden unsuppression response = %#v", unsuppressed)
	}
	multiRevoked := "unsubscribed"
	multiRevokeEvidence := reviewedAddressConsent(time.Now().UTC())
	multiRevokeEvidence.Source = "direct_request"
	multiRevokeEvidence.Reason = "subscriber revoked the exact hidden address"
	multiRevocation, err := multiRepo.UpdateEmail(
		ctx, tenantID, multiSubscriber.ID, multiAddress.ID,
		UpdateEmailInput{
			ConsentStatus:          &multiRevoked,
			ConsentProvenanceInput: multiRevokeEvidence,
			IfMatchToken:           unsuppressed.Version,
		}, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("revoke hidden gate-blocked multi-email address: %v", err)
	}
	if multiRevocation.ConsentStatus != multiRevoked || multiRevocation.Version == unsuppressed.Version {
		t.Fatalf("hidden multi-email revocation = %#v", multiRevocation)
	}
	secondaryStatus := "subscribed"
	secondaryEvidence := reviewedAddressConsent(time.Now().UTC())
	added, err := multiRepo.AddEmail(
		ctx, tenantID, addOwner.ID,
		AddEmailInput{
			Email:                  fmt.Sprintf("gate-blocked-added-%d@example.test", time.Now().UnixNano()),
			ConsentStatus:          &secondaryStatus,
			ConsentProvenanceInput: secondaryEvidence,
		}, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("add reviewed address while gate blocked: %v", err)
	}
	if added.ConsentStatus != "subscribed" || added.Version == "" {
		t.Fatalf("gate-blocked reviewed AddEmail response = %#v", added)
	}
	assertConsentAddressHiddenFromApp(t, pool, tenantID, migration1766Address{
		ID: added.ID, SubscriberID: addOwner.ID, Email: added.Email,
	})
	enabledStatus := StatusEnabled
	enabledAt := time.Now().UTC()
	enabledSource := ConsentDoubleOptIn
	enabled, err := multiRepo.UpdateWithAudit(
		ctx, tenantID, enableOwner.ID,
		UpdateInput{
			IfMatchToken:         enableOwner.Version,
			Status:               &enabledStatus,
			ConsentTimestamp:     &enabledAt,
			ConsentSource:        &enabledSource,
			ConsentChannel:       "web",
			ConsentLegalBasis:    "consent",
			ConsentJurisdiction:  "IN",
			ConsentEvidence:      "receipt:gate-blocked-enable",
			ConsentReason:        "subscriber confirmed the exact address",
			ConsentPolicyVersion: "privacy-2026-07",
		}, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("reviewed subscriber enable while gate blocked: %v", err)
	}
	if enabled.Status != StatusEnabled || enabled.ConsentEmailMarketingAt == nil {
		t.Fatalf("gate-blocked reviewed enable response = %#v", enabled)
	}

	createdAt := time.Now().UTC().Add(-time.Minute)
	createdEmail := fmt.Sprintf("gate-blocked-upsert-%d@example.test", time.Now().UnixNano())
	created, err := multiRepo.Upsert(ctx, tenantID, CreateInput{
		Email:                createdEmail,
		Status:               StatusEnabled,
		ConsentTimestamp:     &createdAt,
		ConsentSource:        ConsentDoubleOptIn,
		ConsentChannel:       "web",
		ConsentLegalBasis:    "consent",
		ConsentEvidence:      "receipt:gate-blocked-upsert",
		ConsentReason:        "subscriber confirmed the exact address",
		ConsentPolicyVersion: "privacy-2026-07",
		Country:              "IN",
	})
	if err != nil {
		t.Fatalf("reviewed Upsert while gate blocked: %v", err)
	}
	if created.Status != StatusEnabled || created.ConsentEmailMarketingAt == nil {
		t.Fatalf("gate-blocked reviewed Upsert response = %#v", created)
	}
	revoke := channelConsentDecision("opted_out", time.Now().UTC())
	revoke.IfMatchToken = granted.SubscriberVersion
	revoked, err := repo.SetChannelConsentWithAudit(
		ctx, tenantID, subscriber.ID, "email", revoke, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("revoke hidden gate-blocked address: %v", err)
	}
	if revoked.Status != "opted_out" {
		t.Fatalf("gate-blocked revoke status = %q, want opted_out", revoked.Status)
	}
}

func TestMultiEmailConsentRepairResolverRevokesAndRenewsAfterProofExpiry(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41774"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}

	for _, tc := range []struct {
		name, decision string
	}{
		{name: "revoke", decision: "unsubscribed"},
		{name: "renew", decision: "subscribed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			subscriber := seedMultiEmailSubscriber(
				t, repo, tenantID,
				fmt.Sprintf("expired-multi-%s-%d@example.test", tc.name, time.Now().UnixNano()),
			)
			address := migration1766AddressForSubscriber(t, pool, tenantID, subscriber)
			expiresAt := time.Now().UTC().Add(350 * time.Millisecond)
			appendMigration1766ExactGrant(
				t, pool, tenantID, address, time.Now().UTC().Add(-time.Hour),
				expiresAt, "privacy-2026-07", "writer-multi-expiry:"+tc.name,
			)
			current := loadRepairWriterAddress(t, pool, tenantID, subscriber.ID, address.ID)
			waitForConsentProofExpiry(t, expiresAt)
			assertConsentAddressHiddenFromApp(t, pool, tenantID, address)

			evidence := reviewedAddressConsent(time.Now().UTC())
			if tc.decision == "unsubscribed" {
				evidence.Source = "direct_request"
				evidence.Reason = "subscriber revoked the exact expired address"
			}
			updated, err := repo.UpdateEmail(
				ctx, tenantID, subscriber.ID, address.ID,
				UpdateEmailInput{
					ConsentStatus:          &tc.decision,
					ConsentProvenanceInput: evidence,
					IfMatchToken:           current.Version,
				}, multiEmailAuditMeta(tenantID),
			)
			if err != nil {
				t.Fatalf("%s hidden expired multi-email address: %v", tc.name, err)
			}
			if updated.ConsentStatus != tc.decision || updated.Version == current.Version {
				t.Fatalf("%s hidden multi-email response = %#v", tc.name, updated)
			}
		})
	}
}

func TestMultiEmailConsentRepairResolverMapsHostileLockTimeout(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41775"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	address := migration1766AddressForSubscriber(t, pool, tenantID, subscriber)
	current := loadRepairWriterAddress(t, pool, tenantID, subscriber.ID, address.ID)

	holder, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("multi-email lock-holder tx: %v", err)
	}
	defer func() { _ = holder.Rollback(context.Background()) }()
	if resolved, _, err := lockEmailConsentAddressForRepairByID(
		ctx, holder, tenantID, subscriber.ID, address.ID,
	); err != nil || resolved == nil {
		t.Fatalf("hold by-id repair lock resolved=%#v err=%v", resolved, err)
	}

	revoked := "unsubscribed"
	evidence := reviewedAddressConsent(time.Now().UTC())
	evidence.Source = "direct_request"
	evidence.Reason = "subscriber revoked during contention test"
	started := time.Now()
	_, err = (&Repo{Pool: pool}).UpdateEmail(
		ctx, tenantID, subscriber.ID, address.ID,
		UpdateEmailInput{
			ConsentStatus:          &revoked,
			ConsentProvenanceInput: evidence,
			IfMatchToken:           current.Version,
		}, multiEmailAuditMeta(tenantID),
	)
	elapsed := time.Since(started)
	if !errors.Is(err, ErrConcurrentConsentDecision) {
		t.Fatalf("contending multi-email writer error = %v, want ErrConcurrentConsentDecision", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("bounded by-id repair-lock failure took %v, want <=2s", elapsed)
	}
}

func TestSubscriberEnableRepairResolverRenewsAfterProofExpiry(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41776"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	subscriber := seedMultiEmailSubscriber(
		t, repo, tenantID,
		fmt.Sprintf("expired-enable-%d@example.test", time.Now().UnixNano()),
	)
	address := migration1766AddressForSubscriber(t, pool, tenantID, subscriber)
	expiresAt := time.Now().UTC().Add(350 * time.Millisecond)
	appendMigration1766ExactGrant(
		t, pool, tenantID, address, time.Now().UTC().Add(-time.Hour), expiresAt,
		"privacy-2026-07", "writer-expired-enable",
	)
	current, err := repo.Get(ctx, tenantID, subscriber.ID)
	if err != nil {
		t.Fatalf("read subscriber before expired enable: %v", err)
	}
	waitForConsentProofExpiry(t, expiresAt)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, address)

	status := StatusEnabled
	when := time.Now().UTC()
	source := ConsentDoubleOptIn
	updated, err := repo.UpdateWithAudit(
		ctx, tenantID, subscriber.ID,
		UpdateInput{
			IfMatchToken:         current.Version,
			Status:               &status,
			ConsentTimestamp:     &when,
			ConsentSource:        &source,
			ConsentChannel:       "web",
			ConsentLegalBasis:    "consent",
			ConsentJurisdiction:  "IN",
			ConsentEvidence:      "receipt:expired-enable-renewal",
			ConsentReason:        "subscriber renewed the exact expired address",
			ConsentPolicyVersion: "privacy-2026-07",
		}, multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("enable subscriber with fresh proof after expiry: %v", err)
	}
	if updated.Status != StatusEnabled || updated.ConsentEmailMarketingAt == nil ||
		updated.Version == current.Version {
		t.Fatalf("expired enable response = %#v", updated)
	}
}

func TestEmailChannelConsentRepairResolverRevokesAndRenewsAfterProofExpiry(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41772"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := channelConsentRepo(pool)

	for _, tc := range []struct {
		name, decision string
	}{
		{name: "revoke", decision: "opted_out"},
		{name: "renew", decision: "opted_in"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			subscriber := seedMultiEmailSubscriber(
				t, &Repo{Pool: pool}, tenantID,
				fmt.Sprintf("expired-%s-%d@example.test", tc.name, time.Now().UnixNano()),
			)
			address := migration1766AddressForSubscriber(t, pool, tenantID, subscriber)
			expiresAt := time.Now().UTC().Add(350 * time.Millisecond)
			appendMigration1766ExactGrant(
				t, pool, tenantID, address, time.Now().UTC().Add(-time.Hour),
				expiresAt, "privacy-2026-07", "writer-expiry:"+tc.name,
			)
			current, err := (&Repo{Pool: pool}).Get(ctx, tenantID, subscriber.ID)
			if err != nil {
				t.Fatalf("read subscriber version after expiring grant: %v", err)
			}
			waitForConsentProofExpiry(t, expiresAt)
			assertConsentAddressHiddenFromApp(t, pool, tenantID, address)

			decision := channelConsentDecision(tc.decision, time.Now().UTC())
			decision.IfMatchToken = current.Version
			updated, err := repo.SetChannelConsentWithAudit(
				ctx, tenantID, subscriber.ID, "email", decision, multiEmailAuditMeta(tenantID),
			)
			if err != nil {
				t.Fatalf("%s hidden expired address: %v", tc.name, err)
			}
			if updated.Status != tc.decision {
				t.Fatalf("%s status = %q, want %q", tc.name, updated.Status, tc.decision)
			}
		})
	}
}

func TestEmailChannelConsentRepairResolverMapsHostileLockTimeout(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41773"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	address := migration1766AddressForSubscriber(t, pool, tenantID, subscriber)

	holder, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("lock-holder tx: %v", err)
	}
	defer func() { _ = holder.Rollback(context.Background()) }()
	if resolved, _, err := lockEmailConsentAddressForRepair(
		ctx, holder, tenantID, subscriber.ID, address.Email,
	); err != nil || resolved == nil {
		t.Fatalf("hold repair lock resolved=%#v err=%v", resolved, err)
	}

	decision := channelConsentDecision("opted_out", time.Now().UTC())
	decision.IfMatchToken = subscriber.Version
	started := time.Now()
	_, err = channelConsentRepo(pool).SetChannelConsentWithAudit(
		ctx, tenantID, subscriber.ID, "email", decision, multiEmailAuditMeta(tenantID),
	)
	elapsed := time.Since(started)
	if !errors.Is(err, ErrConcurrentConsentDecision) {
		t.Fatalf("contending channel writer error = %v, want ErrConcurrentConsentDecision", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("bounded repair-lock failure took %v, want <=2s", elapsed)
	}
}
