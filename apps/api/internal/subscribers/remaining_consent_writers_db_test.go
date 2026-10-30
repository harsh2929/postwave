// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func seedReviewedSecondaryAddress(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, ownerEmail, secondaryEmail string,
) (*Subscriber, *SubscriberEmail) {
	t.Helper()
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	owner := seedMultiEmailSubscriber(t, repo, tenantID, ownerEmail)
	status := "subscribed"
	added, err := repo.AddEmail(
		context.Background(), tenantID, owner.ID,
		AddEmailInput{
			Email:                  secondaryEmail,
			ConsentStatus:          &status,
			ConsentProvenanceInput: reviewedAddressConsent(time.Now().UTC().Add(-time.Minute)),
		},
		multiEmailAuditMeta(tenantID),
	)
	if err != nil {
		t.Fatalf("seed reviewed secondary address: %v", err)
	}
	return owner, added
}

func setRemainingWriterSubscriberBlocklisted(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, subscriberID string,
) {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("blocklist seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `
UPDATE subscribers
   SET status = 'blocklisted',
       mailchimp_status = 'unsubscribed',
       unsubscribe_reason = 'remaining-writer-test',
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
		t.Fatalf("stage blocklisted subscriber: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit blocklisted subscriber: %v", err)
	}
}

func remainingWriterDeleteRequest(tenantID, subscriberID, addressID, version string) *http.Request {
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/subscribers/"+subscriberID+"/emails/"+addressID, nil)
	req.Header.Set("If-Match", version)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", subscriberID)
	route.URLParams.Add("email_id", addressID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	return req.WithContext(ctx)
}

func TestRemainingConsentWritersOperateWhileReleaseGateBlocked(t *testing.T) {
	// Blocking the deployment-wide gate hides subscribed rows in every
	// tenant, so it happens only in the isolated database.
	gate := isolatedReleaseGateDatabase(t)
	pool := gate.appPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	admin := gate.adminPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41779"
	seedPrimaryEmailTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()

	deleteOwner, deleteAddress := seedReviewedSecondaryAddress(
		t, pool, tenantID,
		fmt.Sprintf("gate-delete-owner-%d@example.test", suffix),
		fmt.Sprintf("gate-delete-secondary-%d@example.test", suffix),
	)
	seedRepo := &Repo{Pool: pool}
	grantInput := completeCreateConsentInput()
	grantInput.Email = fmt.Sprintf("gate-bulk-grant-%d@example.test", suffix)
	grantSubscriber, err := seedRepo.Upsert(context.Background(), tenantID, grantInput)
	if err != nil {
		t.Fatalf("seed gate-hidden bulk grant: %v", err)
	}
	resubInput := completeCreateConsentInput()
	resubInput.Email = fmt.Sprintf("gate-bulk-resubscribe-%d@example.test", suffix)
	resubSubscriber, err := seedRepo.Upsert(context.Background(), tenantID, resubInput)
	if err != nil {
		t.Fatalf("seed gate-hidden bulk resubscribe: %v", err)
	}
	setRemainingWriterSubscriberBlocklisted(t, pool, tenantID, resubSubscriber.ID)
	grantAddress := migration1766AddressForSubscriber(t, pool, tenantID, grantSubscriber)
	resubAddress := migration1766AddressForSubscriber(t, pool, tenantID, resubSubscriber)

	gate.block(t)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, migration1766Address{
		ID: deleteAddress.ID, SubscriberID: deleteOwner.ID, Email: deleteAddress.Email,
	})
	assertConsentAddressHiddenFromApp(t, pool, tenantID, grantAddress)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, resubAddress)

	webhooks := &recordingSubscriberWebhook{}
	repo := &Repo{Pool: pool, Webhooks: webhooks}
	if err := repo.DeleteEmail(
		context.Background(), tenantID, deleteOwner.ID, deleteAddress.ID,
		deleteAddress.Version, multiEmailAuditMeta(tenantID),
	); err != nil {
		t.Fatalf("delete gate-hidden secondary address: %v", err)
	}
	d := &Deps{Repo: repo}
	w := httptest.NewRecorder()
	d.BulkGrantConsent(w, bulkVerbsRequest(
		tenantID, "/api/v1/subscribers/bulk/grant-consent",
		fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`,
			grantSubscriber.ID, consentProvenanceJSONAt(time.Now().UTC())),
	))
	if out := decodeBulkResult(t, w); out.Affected != 1 || out.Skipped != 0 {
		t.Fatalf("gate-hidden bulk grant result = %+v", out)
	}
	w = httptest.NewRecorder()
	d.BulkResubscribe(w, bulkVerbsRequest(
		tenantID, "/api/v1/subscribers/bulk/resubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q],%s}`,
			resubSubscriber.ID, consentProvenanceJSONAt(time.Now().UTC())),
	))
	if out := decodeBulkResult(t, w); out.Affected != 1 || out.Skipped != 0 {
		t.Fatalf("gate-hidden bulk resubscribe result = %+v", out)
	}
	if len(webhooks.events) != 3 {
		t.Fatalf("transactional consent webhooks = %v, want three", webhooks.events)
	}

	var deletedAddresses, deleteEvents, deleteProofs, bulkGrantProofs, bulkResubProofs int
	if err := admin.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM subscriber_emails WHERE tenant_id=$1::uuid AND id=$2::uuid),
  (SELECT count(*) FROM consent_events
    WHERE tenant_id=$1::uuid AND subject_id=$2::text AND action='revoked'
      AND preferences->>'operation'='multi_email_address_deleted'),
  (SELECT count(*) FROM consent_records
    WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid
      AND evidence->>'address_id'=$2::text
      AND evidence->>'operation'='multi_email_address_deleted'),
  (SELECT count(*) FROM consent_records
    WHERE tenant_id=$1::uuid AND subscriber_id=$4::uuid
      AND evidence->>'address_id'=$5
      AND evidence->>'event_id'<>'' AND evidence->>'operation'='bulk_consent'),
  (SELECT count(*) FROM consent_records
    WHERE tenant_id=$1::uuid AND subscriber_id=$6::uuid
      AND evidence->>'address_id'=$7
      AND evidence->>'event_id'<>'' AND evidence->>'operation'='bulk_resubscribe')`,
		tenantID, deleteAddress.ID, deleteOwner.ID,
		grantSubscriber.ID, grantAddress.ID,
		resubSubscriber.ID, resubAddress.ID,
	).Scan(&deletedAddresses, &deleteEvents, &deleteProofs, &bulkGrantProofs, &bulkResubProofs); err != nil {
		t.Fatalf("verify gate-hidden writer evidence: %v", err)
	}
	if deletedAddresses != 0 || deleteEvents != 1 || deleteProofs != 1 ||
		bulkGrantProofs != 1 || bulkResubProofs != 1 {
		t.Fatalf("gate-hidden evidence address=%d delete=%d/%d grant=%d resubscribe=%d",
			deletedAddresses, deleteEvents, deleteProofs, bulkGrantProofs, bulkResubProofs)
	}
}

func TestRemainingConsentWritersRenewOrDeleteExpiredHiddenRows(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	const tenantID = "00000000-0000-4000-8000-0099a2c41780"
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()

	deleteOwner := seedMultiEmailSubscriber(t, repo, tenantID,
		fmt.Sprintf("expiry-delete-owner-%d@example.test", suffix))
	deleteAddress, err := repo.AddEmail(context.Background(), tenantID, deleteOwner.ID,
		AddEmailInput{Email: fmt.Sprintf("expiry-delete-secondary-%d@example.test", suffix)},
		multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("seed expiry delete address: %v", err)
	}
	grantSubscriber := seedMultiEmailSubscriber(t, repo, tenantID,
		fmt.Sprintf("expiry-bulk-grant-%d@example.test", suffix))
	resubSubscriber := seedMultiEmailSubscriber(t, repo, tenantID,
		fmt.Sprintf("expiry-bulk-resubscribe-%d@example.test", suffix))
	deleteMigrationAddress := migration1766Address{
		ID: deleteAddress.ID, SubscriberID: deleteOwner.ID, Email: deleteAddress.Email,
	}
	grantAddress := migration1766AddressForSubscriber(t, pool, tenantID, grantSubscriber)
	resubAddress := migration1766AddressForSubscriber(t, pool, tenantID, resubSubscriber)
	expiresAt := time.Now().UTC().Add(400 * time.Millisecond)
	for index, address := range []migration1766Address{deleteMigrationAddress, grantAddress, resubAddress} {
		appendMigration1766ExactGrant(
			t, pool, tenantID, address, time.Now().UTC().Add(-time.Minute), expiresAt,
			"privacy-2026-07", fmt.Sprintf("remaining-writer-expiry:%d", index),
		)
	}
	deleteCurrent := loadRepairWriterAddress(t, pool, tenantID, deleteOwner.ID, deleteAddress.ID)
	setRemainingWriterSubscriberBlocklisted(t, pool, tenantID, resubSubscriber.ID)
	waitForConsentProofExpiry(t, expiresAt)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, deleteMigrationAddress)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, grantAddress)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, resubAddress)

	if err := repo.DeleteEmail(context.Background(), tenantID, deleteOwner.ID,
		deleteAddress.ID, deleteCurrent.Version, multiEmailAuditMeta(tenantID)); err != nil {
		t.Fatalf("delete expired hidden address: %v", err)
	}
	d := &Deps{Repo: repo}
	w := httptest.NewRecorder()
	d.BulkGrantConsent(w, bulkVerbsRequest(tenantID, "/grant",
		fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`,
			grantSubscriber.ID, consentProvenanceJSONAt(time.Now().UTC()))))
	if out := decodeBulkResult(t, w); out.Affected != 1 {
		t.Fatalf("expired bulk grant = %+v", out)
	}
	w = httptest.NewRecorder()
	d.BulkResubscribe(w, bulkVerbsRequest(tenantID, "/resubscribe",
		fmt.Sprintf(`{"subscriber_ids":[%q],%s}`,
			resubSubscriber.ID, consentProvenanceJSONAt(time.Now().UTC()))))
	if out := decodeBulkResult(t, w); out.Affected != 1 {
		t.Fatalf("expired bulk resubscribe = %+v", out)
	}

	for _, tc := range []struct {
		name       string
		subscriber *Subscriber
		address    migration1766Address
	}{
		{name: "grant", subscriber: grantSubscriber, address: grantAddress},
		{name: "resubscribe", subscriber: resubSubscriber, address: resubAddress},
	} {
		current, _, err := func() (*SubscriberEmail, string, error) {
			tx, err := db.WithTenant(context.Background(), pool, tenantID)
			if err != nil {
				return nil, "", err
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			return lockEmailConsentAddressForRepairByID(
				context.Background(), tx, tenantID, tc.subscriber.ID, tc.address.ID,
			)
		}()
		if err != nil || current == nil || current.ConsentStatus != "subscribed" {
			t.Fatalf("%s expired writer projection current=%#v err=%v", tc.name, current, err)
		}
	}
}

func TestRemainingConsentWriterHandlersMapHostileLocksToConflict(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	const tenantID = "00000000-0000-4000-8000-0099a2c41781"
	seedPrimaryEmailTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	deleteOwner, deleteAddress := seedReviewedSecondaryAddress(
		t, pool, tenantID,
		fmt.Sprintf("lock-delete-owner-%d@example.test", suffix),
		fmt.Sprintf("lock-delete-secondary-%d@example.test", suffix),
	)
	repo := &Repo{Pool: pool}
	bulkInput := completeCreateConsentInput()
	bulkInput.Email = fmt.Sprintf("lock-bulk-%d@example.test", suffix)
	bulkSubscriber, err := repo.Upsert(context.Background(), tenantID, bulkInput)
	if err != nil {
		t.Fatalf("seed lock bulk subscriber: %v", err)
	}
	setRemainingWriterSubscriberBlocklisted(t, pool, tenantID, bulkSubscriber.ID)
	bulkAddress := migration1766AddressForSubscriber(t, pool, tenantID, bulkSubscriber)

	deleteHolder, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("delete holder tx: %v", err)
	}
	defer func() { _ = deleteHolder.Rollback(context.Background()) }()
	if current, _, err := lockEmailConsentAddressForRepairByID(context.Background(), deleteHolder,
		tenantID, deleteOwner.ID, deleteAddress.ID); err != nil || current == nil {
		t.Fatalf("hold delete address current=%#v err=%v", current, err)
	}
	bulkHolder, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("bulk holder tx: %v", err)
	}
	defer func() { _ = bulkHolder.Rollback(context.Background()) }()
	if current, _, err := lockEmailConsentAddressForRepair(context.Background(), bulkHolder,
		tenantID, bulkSubscriber.ID, bulkAddress.Email); err != nil || current == nil {
		t.Fatalf("hold bulk address current=%#v err=%v", current, err)
	}

	d := &Deps{Repo: repo}
	deleteResponse := httptest.NewRecorder()
	d.DeleteEmail(deleteResponse, remainingWriterDeleteRequest(
		tenantID, deleteOwner.ID, deleteAddress.ID, deleteAddress.Version,
	))
	if deleteResponse.Code != http.StatusConflict || !strings.Contains(deleteResponse.Body.String(), "concurrent_consent_change") {
		t.Fatalf("hostile delete response = %d %s", deleteResponse.Code, deleteResponse.Body.String())
	}
	for _, tc := range []struct {
		name string
		call func(http.ResponseWriter, *http.Request)
		body string
	}{
		{
			name: "grant", call: d.BulkGrantConsent,
			body: fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`,
				bulkSubscriber.ID, consentProvenanceJSONAt(time.Now().UTC())),
		},
		{
			name: "resubscribe", call: d.BulkResubscribe,
			body: fmt.Sprintf(`{"subscriber_ids":[%q],%s}`,
				bulkSubscriber.ID, consentProvenanceJSONAt(time.Now().UTC())),
		},
	} {
		response := httptest.NewRecorder()
		tc.call(response, bulkVerbsRequest(tenantID, "/"+tc.name, tc.body))
		if response.Code != http.StatusConflict || response.Header().Get("Retry-After") != "1" ||
			!strings.Contains(response.Body.String(), "concurrent_consent_change") {
			t.Fatalf("hostile %s response = %d headers=%v body=%s",
				tc.name, response.Code, response.Header(), response.Body.String())
		}
	}
}

func TestRemainingConsentWritersRollbackWebhookFailure(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	sentinel := errors.New("injected remaining-writer webhook failure")

	t.Run("delete", func(t *testing.T) {
		const tenantID = "00000000-0000-4000-8000-0099a2c41782"
		owner, address := seedReviewedSecondaryAddress(t, pool, tenantID,
			fmt.Sprintf("rollback-delete-owner-%d@example.test", time.Now().UnixNano()),
			fmt.Sprintf("rollback-delete-secondary-%d@example.test", time.Now().UnixNano()))
		repo := &Repo{Pool: pool, Webhooks: failingAddressConsentWebhook{err: sentinel}}
		err := repo.DeleteEmail(context.Background(), tenantID, owner.ID, address.ID,
			address.Version, multiEmailAuditMeta(tenantID))
		if !errors.Is(err, sentinel) {
			t.Fatalf("delete webhook error = %v, want sentinel", err)
		}
		tx, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			t.Fatalf("delete rollback verify tx: %v", err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		var addresses, events, proofs, audits int
		if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM subscriber_emails WHERE tenant_id=$1::uuid AND id=$2::uuid),
  (SELECT count(*) FROM consent_events WHERE tenant_id=$1::uuid
    AND subject_id=$2::text AND preferences->>'operation'='multi_email_address_deleted'),
  (SELECT count(*) FROM consent_records WHERE tenant_id=$1::uuid
    AND subscriber_id=$3::uuid AND evidence->>'operation'='multi_email_address_deleted'),
  (SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid
    AND resource_id=$2::text AND action='subscriber.email_deleted')`,
			tenantID, address.ID, owner.ID).Scan(&addresses, &events, &proofs, &audits); err != nil {
			t.Fatalf("verify delete rollback: %v", err)
		}
		if addresses != 1 || events != 0 || proofs != 0 || audits != 0 {
			t.Fatalf("delete rollback address=%d event=%d proof=%d audit=%d", addresses, events, proofs, audits)
		}
	})

	t.Run("bulk_grant", func(t *testing.T) {
		const tenantID = "00000000-0000-4000-8000-0099a2c41783"
		seedPrimaryEmailTenant(t, pool, tenantID)
		seedRepo := &Repo{Pool: pool}
		subscriber := seedMultiEmailSubscriber(t, seedRepo, tenantID,
			fmt.Sprintf("rollback-bulk-grant-%d@example.test", time.Now().UnixNano()))
		d := &Deps{Repo: &Repo{Pool: pool, Webhooks: failingAddressConsentWebhook{err: sentinel}}}
		response := httptest.NewRecorder()
		d.BulkGrantConsent(response, bulkVerbsRequest(tenantID, "/grant",
			fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`,
				subscriber.ID, consentProvenanceJSONAt(time.Now().UTC()))))
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("bulk grant rollback response = %d %s", response.Code, response.Body.String())
		}
		tx, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			t.Fatalf("bulk grant rollback verify tx: %v", err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		var status string
		var events, proofs, audits, activity int
		if err := tx.QueryRow(context.Background(), `
SELECT consent_status FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND is_primary`, tenantID, subscriber.ID).Scan(&status); err != nil {
			t.Fatalf("read rolled-back bulk grant address: %v", err)
		}
		if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM consent_events WHERE tenant_id=$1::uuid
    AND preferences->>'operation'='bulk_consent' AND action='granted'),
  (SELECT count(*) FROM consent_records WHERE tenant_id=$1::uuid
    AND subscriber_id=$2::uuid AND evidence->>'operation'='bulk_consent'),
  (SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid
    AND action='subscriber.bulk_consent_granted'),
  (SELECT count(*) FROM subscriber_bulk_operations_audit WHERE tenant_id=$1::uuid
    AND verb='grant_consent')`, tenantID, subscriber.ID).Scan(&events, &proofs, &audits, &activity); err != nil {
			t.Fatalf("verify rolled-back bulk grant: %v", err)
		}
		if status == "subscribed" || events != 0 || proofs != 0 || audits != 0 || activity != 0 {
			t.Fatalf("bulk grant rollback status=%q event=%d proof=%d audit=%d activity=%d",
				status, events, proofs, audits, activity)
		}
	})

	t.Run("bulk_resubscribe", func(t *testing.T) {
		const tenantID = "00000000-0000-4000-8000-0099a2c41784"
		seedPrimaryEmailTenant(t, pool, tenantID)
		seedRepo := &Repo{Pool: pool}
		grant := completeCreateConsentInput()
		grant.Email = fmt.Sprintf("rollback-bulk-resubscribe-%d@example.test", time.Now().UnixNano())
		subscriber, err := seedRepo.Upsert(context.Background(), tenantID, grant)
		if err != nil {
			t.Fatalf("seed rollback resubscribe: %v", err)
		}
		seedDeps := &Deps{Repo: seedRepo}
		response := httptest.NewRecorder()
		seedDeps.BulkUnsubscribe(response, bulkVerbsRequest(tenantID, "/unsubscribe",
			fmt.Sprintf(`{"subscriber_ids":[%q]}`, subscriber.ID)))
		if out := decodeBulkResult(t, response); out.Affected != 1 {
			t.Fatalf("seed rollback unsubscribe = %+v", out)
		}
		d := &Deps{Repo: &Repo{Pool: pool, Webhooks: failingAddressConsentWebhook{err: sentinel}}}
		response = httptest.NewRecorder()
		d.BulkResubscribe(response, bulkVerbsRequest(tenantID, "/resubscribe",
			fmt.Sprintf(`{"subscriber_ids":[%q],%s}`,
				subscriber.ID, consentProvenanceJSONAt(time.Now().UTC()))))
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("bulk resubscribe rollback response = %d %s", response.Code, response.Body.String())
		}
		tx, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			t.Fatalf("bulk resubscribe rollback verify tx: %v", err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		var subscriberStatus, addressStatus string
		var suppressed bool
		var holds, grants int
		if err := tx.QueryRow(context.Background(), `
SELECT subscriber.status, address.consent_status, address.suppressed
  FROM subscribers AS subscriber
  JOIN subscriber_emails AS address
    ON address.tenant_id=subscriber.tenant_id
   AND address.subscriber_id=subscriber.id AND address.is_primary
 WHERE subscriber.tenant_id=$1::uuid AND subscriber.id=$2::uuid`, tenantID, subscriber.ID).Scan(
			&subscriberStatus, &addressStatus, &suppressed,
		); err != nil {
			t.Fatalf("read rolled-back resubscribe state: %v", err)
		}
		if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM v_suppressions_unified
    WHERE tenant_id=$1::uuid AND lower(email)=lower($2)
      AND (expires_at IS NULL OR expires_at>now())),
  (SELECT count(*) FROM consent_records
    WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid
      AND evidence->>'operation'='bulk_resubscribe')`, tenantID, subscriber.Email, subscriber.ID).Scan(&holds, &grants); err != nil {
			t.Fatalf("verify rolled-back resubscribe evidence: %v", err)
		}
		if subscriberStatus != StatusBlocklisted || addressStatus != "unsubscribed" ||
			!suppressed || holds < 1 || grants != 0 {
			t.Fatalf("bulk resubscribe rollback status=%q address=%q suppressed=%v holds=%d grants=%d",
				subscriberStatus, addressStatus, suppressed, holds, grants)
		}
	})
}

func TestRemainingConsentWritersFailClosedAcrossTenantAndDuplicateTargets(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	const localTenant = "00000000-0000-4000-8000-0099a2c41785"
	const foreignTenant = "00000000-0000-4000-8000-0099a2c41786"
	seedPrimaryEmailTenant(t, pool, localTenant)
	seedPrimaryEmailTenant(t, pool, foreignTenant)
	localRepo := &Repo{Pool: pool}
	local := seedMultiEmailSubscriber(t, localRepo, localTenant,
		fmt.Sprintf("local-bulk-%d@example.test", time.Now().UnixNano()))
	foreign := seedMultiEmailSubscriber(t, localRepo, foreignTenant,
		fmt.Sprintf("foreign-bulk-%d@example.test", time.Now().UnixNano()))
	d := &Deps{Repo: localRepo}
	response := httptest.NewRecorder()
	d.BulkGrantConsent(response, bulkVerbsRequest(localTenant, "/grant",
		fmt.Sprintf(`{"subscriber_ids":[%q,%q,%q],"category":"email_marketing",%s}`,
			local.ID, local.ID, foreign.ID, consentProvenanceJSONAt(time.Now().UTC()))))
	out := decodeBulkResult(t, response)
	if out.Affected != 1 || out.Skipped != 1 || out.Exclusions["missing_or_outside_tenant"] != 1 {
		t.Fatalf("duplicate/cross-tenant bulk result = %+v", out)
	}

	owner, secondary := seedReviewedSecondaryAddress(t, pool, localTenant,
		fmt.Sprintf("cross-delete-owner-%d@example.test", time.Now().UnixNano()),
		fmt.Sprintf("cross-delete-secondary-%d@example.test", time.Now().UnixNano()))
	if err := localRepo.DeleteEmail(context.Background(), foreignTenant, foreign.ID,
		secondary.ID, secondary.Version, multiEmailAuditMeta(foreignTenant)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant delete error = %v, want not found", err)
	}
	tx, err := db.WithTenant(context.Background(), pool, localTenant)
	if err != nil {
		t.Fatalf("cross-tenant verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var secondaryRows, localGrants int
	if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM subscriber_emails
    WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND id=$3::uuid),
  (SELECT count(*) FROM consent_records
    WHERE tenant_id=$1::uuid AND subscriber_id=$4::uuid
      AND evidence->>'operation'='bulk_consent')`,
		localTenant, owner.ID, secondary.ID, local.ID).Scan(&secondaryRows, &localGrants); err != nil {
		t.Fatalf("verify duplicate/cross-tenant isolation: %v", err)
	}
	if secondaryRows != 1 || localGrants != 1 {
		t.Fatalf("cross-tenant isolation secondary=%d local_grants=%d", secondaryRows, localGrants)
	}
}

func TestDeleteEmailExactRevisionRaceHasOneTerminalWinner(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	const tenantID = "00000000-0000-4000-8000-0099a2c41787"
	owner, address := seedReviewedSecondaryAddress(t, pool, tenantID,
		fmt.Sprintf("race-delete-owner-%d@example.test", time.Now().UnixNano()),
		fmt.Sprintf("race-delete-secondary-%d@example.test", time.Now().UnixNano()))
	repo := &Repo{Pool: pool}
	start := make(chan struct{})
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for index := range errs {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			errs[index] = repo.DeleteEmail(context.Background(), tenantID, owner.ID,
				address.ID, address.Version, multiEmailAuditMeta(tenantID))
		}(index)
	}
	close(start)
	wg.Wait()
	successes, rejected := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrNotFound), errors.Is(err, ErrEmailPreconditionFailed):
			rejected++
		default:
			t.Fatalf("delete race error = %v", err)
		}
	}
	if successes != 1 || rejected != 1 {
		t.Fatalf("delete race successes=%d rejected=%d errors=%v", successes, rejected, errs)
	}
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("delete race verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var addresses, events, proofs, audits int
	if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM subscriber_emails WHERE tenant_id=$1::uuid AND id=$2::uuid),
  (SELECT count(*) FROM consent_events WHERE tenant_id=$1::uuid
    AND subject_id=$2::text AND preferences->>'operation'='multi_email_address_deleted'),
  (SELECT count(*) FROM consent_records WHERE tenant_id=$1::uuid
    AND subscriber_id=$3::uuid AND evidence->>'operation'='multi_email_address_deleted'),
  (SELECT count(*) FROM audit_log WHERE tenant_id=$1::uuid
    AND resource_id=$2::text AND action='subscriber.email_deleted')`,
		tenantID, address.ID, owner.ID).Scan(&addresses, &events, &proofs, &audits); err != nil {
		t.Fatalf("verify delete race terminal winner: %v", err)
	}
	if addresses != 0 || events != 1 || proofs != 1 || audits != 1 {
		t.Fatalf("delete race address=%d event=%d proof=%d audit=%d", addresses, events, proofs, audits)
	}
}

func TestBulkEmailConsentConcurrentDecisionsPreserveTerminalOrder(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedPrimaryEmailTenant(t, pool, tenantID)
	repo := &Repo{Pool: pool}
	subscriber := seedMultiEmailSubscriber(t, repo, tenantID,
		fmt.Sprintf("race-bulk-consent-%d@example.test", time.Now().UnixNano()))
	address := migration1766AddressForSubscriber(t, pool, tenantID, subscriber)
	d := &Deps{Repo: repo}
	earlierGrant := time.Now().UTC().Add(-time.Minute)
	laterRevoke := time.Now().UTC()
	type decision struct {
		name string
		call func(http.ResponseWriter, *http.Request)
		body string
	}
	decisions := []decision{
		{
			name: "grant", call: d.BulkGrantConsent,
			body: fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`,
				subscriber.ID, consentProvenanceJSONAt(earlierGrant)),
		},
		{
			name: "revoke", call: d.BulkRevokeConsent,
			body: fmt.Sprintf(`{"subscriber_ids":[%q],"category":"email_marketing",%s}`,
				subscriber.ID, consentProvenanceJSONAt(laterRevoke)),
		},
	}
	responses := make([]*httptest.ResponseRecorder, len(decisions))
	start := make(chan struct{})
	var wg sync.WaitGroup
	for index := range decisions {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			responses[index] = httptest.NewRecorder()
			decisions[index].call(responses[index], bulkVerbsRequest(
				tenantID, "/"+decisions[index].name, decisions[index].body,
			))
		}(index)
	}
	close(start)
	wg.Wait()
	successfulRequests := 0
	for index, response := range responses {
		switch response.Code {
		case http.StatusOK:
			successfulRequests++
		case http.StatusConflict:
			if !strings.Contains(response.Body.String(), "concurrent_consent_change") {
				t.Fatalf("%s race conflict body = %s", decisions[index].name, response.Body.String())
			}
		default:
			t.Fatalf("%s race response = %d %s", decisions[index].name, response.Code, response.Body.String())
		}
	}
	// If the later decision lost the serializable race, retry its complete
	// request. A statement-only retry is forbidden; this proves the advertised
	// 409 contract is sufficient to reach the deterministic terminal decision.
	if responses[1].Code == http.StatusConflict {
		retry := httptest.NewRecorder()
		decisions[1].call(retry, bulkVerbsRequest(tenantID, "/revoke-retry", decisions[1].body))
		if retry.Code != http.StatusOK {
			t.Fatalf("complete revoke retry = %d %s", retry.Code, retry.Body.String())
		}
		successfulRequests++
	}

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("bulk consent race verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var status string
	var events, proofs, audits, activity int
	if err := tx.QueryRow(context.Background(), `
SELECT consent_status FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, address.ID).Scan(&status); err != nil {
		t.Fatalf("read bulk consent race projection: %v", err)
	}
	if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM consent_events
    WHERE tenant_id=$1::uuid AND subject_id=$2::text
      AND category='email_marketing' AND preferences->>'operation'='bulk_consent'),
  (SELECT count(*) FROM consent_records
    WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid
      AND evidence->>'address_id'=$2::text
      AND evidence->>'event_id'<>'' AND evidence->>'operation'='bulk_consent'),
  (SELECT count(*) FROM audit_log
    WHERE tenant_id=$1::uuid AND action IN (
      'subscriber.bulk_consent_granted','subscriber.bulk_consent_revoked'
    )),
  (SELECT count(*) FROM subscriber_bulk_operations_audit
    WHERE tenant_id=$1::uuid AND verb IN ('grant_consent','revoke_consent'))`,
		tenantID, address.ID, subscriber.ID).Scan(&events, &proofs, &audits, &activity); err != nil {
		t.Fatalf("read bulk consent race evidence: %v", err)
	}
	if status != "unsubscribed" || events != successfulRequests || proofs != successfulRequests ||
		audits != successfulRequests || activity != successfulRequests {
		t.Fatalf("bulk consent race status=%q successes=%d event=%d proof=%d audit=%d activity=%d",
			status, successfulRequests, events, proofs, audits, activity)
	}
}

func TestRemainingConsentWriterInventoryUsesExactAddressContract(t *testing.T) {
	files := map[string][]string{
		"multi_email.go": {
			"lockEmailConsentAddressForRepairByID",
			"multi_email_address_deleted",
			"AND updated_at = $4::timestamptz",
		},
		"bulk_resubscribe_safety.go": {
			"lockBulkCanonicalEmailTargets",
			"recordEmailConsentEvidence",
			"setEmailSuppressedForRepairByID",
		},
		"bulk_email_consent_safety.go": {
			"lockBulkCanonicalEmailTargets",
			"recordEmailConsentEvidence",
			"lockEmailConsentAddressForRepairByID",
		},
		"bulk_verbs.go": {
			"applyBulkEmailConsent",
			"writeBulkConsentMutationErr",
		},
		"bulk_paste.go": {
			`status != "" && status != StatusUnconfirmed`,
			"bulk-pasted subscribers must be unconfirmed",
		},
		"bulk_recover.go": {
			`case "unsubscribe":`,
			"reviewed_resubscribe_required",
		},
	}
	for name, required := range files {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read writer inventory file %s: %v", name, err)
		}
		text := string(raw)
		for _, needle := range required {
			if !strings.Contains(text, needle) {
				t.Errorf("%s missing exact-address contract %q", name, needle)
			}
		}
	}
	for name, forbidden := range map[string][]string{
		"bulk_resubscribe_safety.go": {"SET consent_status = 'subscribed'"},
		"bulk_verbs.go":              {"UPDATE subscriber_emails AS address"},
	} {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read writer inventory file %s: %v", name, err)
		}
		for _, needle := range forbidden {
			if strings.Contains(string(raw), needle) {
				t.Errorf("%s retained forbidden raw positive projection %q", name, needle)
			}
		}
	}

	// The other synchronous bulk-ingest surfaces are not positive writers:
	// they expose no proof envelope, so an enabled row must fail the shared
	// create normalizer before any repository/database write.
	csvInput, err := buildCreateInput(
		[]string{"inventory-csv@example.test", StatusEnabled},
		map[string]int{"email": 0, "status": 1},
	)
	if err != nil {
		t.Fatalf("build CSV inventory input: %v", err)
	}
	if err := normalizeCreate(&csvInput); err == nil {
		t.Fatal("CSV bulk import accepted enabled status without an exact proof envelope")
	}
	batchInput := batchRecordToCreateInput(BatchUpsertRecord{
		Email: "inventory-batch@example.test", Status: StatusEnabled,
	})
	if err := normalizeCreate(&batchInput); err == nil {
		t.Fatal("batch upsert accepted enabled status without an exact proof envelope")
	}
	mergeInput, _ := BuildCreateInputWithMergeFields(
		[]string{"inventory-merge@example.test", StatusEnabled},
		map[string]int{"email": 0, "status": 1}, nil,
	)
	if err := normalizeCreate(&mergeInput); err == nil {
		t.Fatal("merge-field CSV import accepted enabled status without an exact proof envelope")
	}
}
