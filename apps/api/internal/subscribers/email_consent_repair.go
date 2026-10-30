// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

// lockEmailConsentAddressForRepair acquires migration 1766's bounded,
// transaction-scoped exact-address mutex and resolves the one address even
// when the app-role SELECT policy intentionally hides a retained positive.
//
// The security-definer function deliberately does not take a tuple lock. The
// caller must retain tx while appending the exact terminal evidence; the
// evidence trigger re-enters this advisory mutex and projects the final row.
// Taking a subscriber_emails row lock before this call would reintroduce the
// row-to-advisory lock-order inversion that the resolver contract prevents.
func lockEmailConsentAddressForRepair(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, email string,
) (*SubscriberEmail, string, error) {
	return scanEmailConsentRepairAddress(tx.QueryRow(ctx, `
SELECT address_id::text, stored_email, is_primary, consent_status, suppressed,
       last_engaged_at, created_at, updated_at, reconciliation_state
  FROM public.subscriber_email_consent_lock_for_repair(
       $1::uuid, $2::uuid, $3
  )`, tenantID, subscriberID, email), subscriberID)
}

// lockEmailConsentAddressForRepairByID is the secondary-address counterpart
// to lockEmailConsentAddressForRepair. The definer resolves the stored email
// from the exact immutable address UUID before taking the normalized-address
// advisory mutex, then re-checks the identity under that same mutex. This
// avoids trusting mutable PII supplied by an API client.
func lockEmailConsentAddressForRepairByID(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, addressID string,
) (*SubscriberEmail, string, error) {
	if _, err := uuid.Parse(addressID); err != nil {
		return nil, "", nil
	}
	return scanEmailConsentRepairAddress(tx.QueryRow(ctx, `
SELECT address_id::text, stored_email, is_primary, consent_status, suppressed,
       last_engaged_at, created_at, updated_at, reconciliation_state
  FROM public.subscriber_email_consent_lock_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid
  )`, tenantID, subscriberID, addressID), subscriberID)
}

func scanEmailConsentRepairAddress(row scanner, subscriberID string) (*SubscriberEmail, string, error) {
	var address SubscriberEmail
	var reconciliationState string
	err := row.Scan(
		&address.ID, &address.Email, &address.IsPrimary, &address.ConsentStatus,
		&address.Suppressed, &address.LastEngagedAt, &address.CreatedAt,
		&address.UpdatedAt, &reconciliationState,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", mapEmailConsentSerializationError(err)
	}
	address.SubscriberID = subscriberID
	address.Version = httpcache.ConcurrencyToken("subscriber-email", address.ID, address.UpdatedAt)
	return &address, reconciliationState, nil
}

// setEmailSuppressedForRepairByID is migration 1766's sole privileged
// subscriber_emails projection writer. The caller must already hold the exact
// address mutex through a repair resolver and must have appended or removed
// the reviewed suppression evidence in this same transaction. The database
// revalidates both the exact row revision and the authoritative unified hold.
func setEmailSuppressedForRepairByID(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, addressID string,
	expectedUpdatedAt time.Time,
	suppressed bool,
) (*SubscriberEmail, error) {
	if _, err := uuid.Parse(addressID); err != nil {
		return nil, ErrNotFound
	}
	var outcome string
	var returnedID, email, consentStatus, reconciliationState *string
	var isPrimary, returnedSuppressed *bool
	var lastEngagedAt, createdAt, updatedAt *time.Time
	err := tx.QueryRow(ctx, `
SELECT outcome, address_id::text, stored_email, is_primary, consent_status,
       suppressed, last_engaged_at, created_at, updated_at,
       reconciliation_state
  FROM public.subscriber_email_consent_set_suppressed_for_repair_by_id(
       $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::boolean
  )`, tenantID, subscriberID, addressID, expectedUpdatedAt, suppressed).Scan(
		&outcome, &returnedID, &email, &isPrimary, &consentStatus,
		&returnedSuppressed, &lastEngagedAt, &createdAt, &updatedAt,
		&reconciliationState,
	)
	if err != nil {
		return nil, mapEmailSuppressionRepairError(err)
	}
	switch outcome {
	case "not_found":
		return nil, ErrNotFound
	case "stale":
		return nil, ErrEmailPreconditionFailed
	case "updated":
		if returnedID == nil || email == nil || isPrimary == nil ||
			consentStatus == nil || returnedSuppressed == nil ||
			createdAt == nil || updatedAt == nil || reconciliationState == nil {
			return nil, errors.New("subscriber: suppression repair returned an incomplete updated row")
		}
		address := &SubscriberEmail{
			ID:            *returnedID,
			SubscriberID:  subscriberID,
			Email:         *email,
			IsPrimary:     *isPrimary,
			ConsentStatus: *consentStatus,
			Suppressed:    *returnedSuppressed,
			LastEngagedAt: lastEngagedAt,
			CreatedAt:     *createdAt,
			UpdatedAt:     *updatedAt,
		}
		address.Version = httpcache.ConcurrencyToken("subscriber-email", address.ID, address.UpdatedAt)
		return address, nil
	default:
		return nil, fmt.Errorf("subscriber: unknown suppression repair outcome %q", outcome)
	}
}

func mapEmailSuppressionRepairError(err error) error {
	type sqlStateError interface {
		SQLState() string
	}
	var stateErr sqlStateError
	if errors.As(err, &stateErr) {
		switch stateErr.SQLState() {
		case "55P03", "40001", "40P01":
			return ErrConcurrentConsentDecision
		case "23514":
			return ErrEmailSuppressionEvidenceConflict
		}
	}
	return err
}

// mapEmailConsentSerializationError turns the migration's bounded 55P03
// outcome into the package's safe concurrent-decision contract. Callers must
// retry the complete transaction; retrying only the failed statement would
// lose the evidence/projection atomicity guarantee.
func mapEmailConsentSerializationError(err error) error {
	type sqlStateError interface {
		SQLState() string
	}
	var stateErr sqlStateError
	if errors.As(err, &stateErr) {
		switch stateErr.SQLState() {
		case "55P03", // bounded advisory lock timeout
			"40001", // serializable transaction retry
			"40P01": // deadlock victim; retry the whole transaction
			return ErrConcurrentConsentDecision
		}
	}
	return err
}
