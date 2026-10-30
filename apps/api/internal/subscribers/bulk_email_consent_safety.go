// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// applyBulkEmailConsent is the exact-address implementation behind the
// email_marketing grant/revoke verbs. Generic consent categories remain
// subscriber-scoped, but email marketing is a delivery permission and must
// bind every immutable event/proof pair to the canonical address UUID.
func (d *Deps) applyBulkEmailConsent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ids []string,
	in BulkConsentInput,
	action string,
	auditMeta db.AuditMeta,
) ([]bulkResubscribeTarget, map[string]int, error) {
	status := ""
	expectedState := ""
	syncEvent := ""
	switch action {
	case "granted":
		status = "subscribed"
		expectedState = "proven"
		syncEvent = ConsentSyncEventConsentGranted
	case "revoked":
		status = "unsubscribed"
		expectedState = "failed_closed"
		syncEvent = ConsentSyncEventConsentRevoked
	default:
		return nil, nil, fmt.Errorf("unsupported bulk email consent action %q", action)
	}

	targets, exclusions, err := lockBulkCanonicalEmailTargets(
		ctx, tx, tenantID, ids,
	)
	if err != nil {
		return nil, nil, err
	}
	for index := range targets {
		target := &targets[index]
		eventID, err := recordEmailConsentEvidence(
			ctx, tx, tenantID,
			&Subscriber{ID: target.SubscriberID, Email: target.Email},
			target.Address, status, in.ConsentProvenanceInput,
			"bulk_consent", auditMeta,
		)
		if err != nil {
			return nil, nil, fmt.Errorf("append bulk exact-address consent evidence: %w", err)
		}
		target.EventID = eventID
		current, state, err := lockEmailConsentAddressForRepairByID(
			ctx, tx, tenantID, target.SubscriberID, target.AddressID,
		)
		if err != nil {
			return nil, nil, fmt.Errorf("refresh bulk exact-address consent projection: %w", err)
		}
		if current == nil || current.ConsentStatus != status || state != expectedState {
			return nil, nil, errors.New("bulk exact-address consent evidence did not reach its terminal projection")
		}
		target.Address = current
		if d.Repo.ConsentSyncLedger != nil {
			if err := d.Repo.ConsentSyncLedger.RecordEvent(
				ctx, tx, tenantID, target.SubscriberID, syncEvent,
			); err != nil {
				return nil, nil, fmt.Errorf("record bulk exact-address consent sync: %w", err)
			}
		}
		if err := fireEmailConsentWebhook(
			ctx, d.Repo, tx, tenantID,
			&Subscriber{ID: target.SubscriberID, Email: target.Email},
			current, eventID,
		); err != nil {
			return nil, nil, err
		}
	}

	if len(targets) > 0 {
		targetIDs := make([]string, 0, len(targets))
		for _, target := range targets {
			targetIDs = append(targetIDs, target.SubscriberID)
		}
		if err := d.Repo.appendEngineSyncMany(ctx, tx, tenantID, targetIDs); err != nil {
			return nil, nil, err
		}
	}
	return targets, exclusions, nil
}
