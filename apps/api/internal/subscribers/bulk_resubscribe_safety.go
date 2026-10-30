// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrConcurrentConsentDecision = errors.New("subscriber: concurrent consent or suppression decision")

type bulkResubscribeTarget struct {
	SubscriberID     string
	SubscriberStatus string
	Email            string
	AddressID        string
	EventID          string
	Address          *SubscriberEmail
}

type capturedSuppressionIDs struct {
	Subscriber []string
	Email      []string
	Legacy     []string
}

type bulkResubscribeHooks struct {
	afterSuppressionCapture func()
}

// lockBulkCanonicalEmailTargets is the shared positive-writer inventory gate
// for reviewed bulk resubscribe and email-marketing grant/revoke. Parent rows
// and exact normalized-address mutexes are acquired in deterministic C order.
// No ordinary address SELECT runs before the resolver: a retained positive may
// be hidden by migration 1766 while the release gate is blocked or proof is
// expired. Legacy profiles receive only a fail-closed companion row.
func lockBulkCanonicalEmailTargets(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ids []string,
) ([]bulkResubscribeTarget, map[string]int, error) {
	rows, err := tx.Query(ctx, `
SELECT subscriber.id::text,
       subscriber.email::text,
       subscriber.status
  FROM subscribers AS subscriber
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = ANY($2::uuid[])
 ORDER BY public.subscriber_email_consent_normalize_email(
              subscriber.email::text
          ) COLLATE "C",
          subscriber.id
 FOR UPDATE OF subscriber`, tenantID, ids)
	if err != nil {
		return nil, nil, fmt.Errorf("lock bulk email-consent subscribers: %w", err)
	}
	type candidate struct {
		subscriberID string
		email        string
		status       string
	}
	candidates := make([]candidate, 0, len(ids))
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.subscriberID, &item.email, &item.status); err != nil {
			rows.Close()
			return nil, nil, fmt.Errorf("scan bulk email-consent subscriber: %w", err)
		}
		candidates = append(candidates, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate bulk email-consent subscribers: %w", err)
	}

	exclusions := map[string]int{}
	if missing := len(ids) - len(candidates); missing > 0 {
		exclusions["missing_or_outside_tenant"] = missing
	}
	targets := make([]bulkResubscribeTarget, 0, len(candidates))
	for _, item := range candidates {
		address, _, err := lockEmailConsentAddressForRepair(
			ctx, tx, tenantID, item.subscriberID, item.email,
		)
		if err != nil {
			return nil, nil, fmt.Errorf("resolve bulk email-consent address: %w", err)
		}
		if address == nil {
			// The resolver mutex is already held. ON CONFLICT DO NOTHING turns
			// a same-tenant duplicate/foreign-profile address into a deterministic
			// exclusion without aborting the complete reviewed transaction.
			if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3, true, 'never_subscribed', false)
ON CONFLICT DO NOTHING`, tenantID, item.subscriberID, item.email); err != nil {
				return nil, nil, fmt.Errorf("stage fail-closed bulk email address: %w", err)
			}
			address, _, err = lockEmailConsentAddressForRepair(
				ctx, tx, tenantID, item.subscriberID, item.email,
			)
			if err != nil {
				return nil, nil, fmt.Errorf("reload staged bulk email address: %w", err)
			}
		}
		if address == nil || !address.IsPrimary {
			exclusions["canonical_address_conflict"]++
			continue
		}
		targets = append(targets, bulkResubscribeTarget{
			SubscriberID:     item.subscriberID,
			SubscriberStatus: item.status,
			Email:            address.Email,
			AddressID:        address.ID,
			Address:          address,
		})
	}
	return targets, exclusions, nil
}

func (d *Deps) applyBulkResubscribe(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ids []string,
	in BulkResubscribeInput,
	auditMeta db.AuditMeta,
) ([]bulkResubscribeTarget, map[string]int, error) {
	return d.applyBulkResubscribeWithHooks(ctx, tx, tenantID, ids, in, auditMeta, bulkResubscribeHooks{})
}

func (d *Deps) applyBulkResubscribeWithHooks(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ids []string,
	in BulkResubscribeInput,
	auditMeta db.AuditMeta,
	hooks bulkResubscribeHooks,
) ([]bulkResubscribeTarget, map[string]int, error) {
	candidates, exclusions, err := lockBulkCanonicalEmailTargets(
		ctx, tx, tenantID, ids,
	)
	if err != nil {
		return nil, nil, err
	}
	targets := make([]bulkResubscribeTarget, 0, len(candidates))
	for _, target := range candidates {
		if target.SubscriberStatus != StatusBlocklisted {
			exclusions["not_blocklisted"]++
			continue
		}
		var protected, reversible bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
           SELECT 1 FROM v_suppressions_unified AS suppression
            WHERE suppression.tenant_id = $1::uuid
              AND lower(suppression.email) = lower($2)
              AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
              AND (
                  suppression.reason NOT IN ('manual_unsubscribe', 'list_manual', 'global_unsubscribe')
                  OR lower(COALESCE(suppression.metadata ->> 'gdpr_erasure', 'false')) = 'true'
              )
       ),
       EXISTS (
           SELECT 1 FROM v_suppressions_unified AS suppression
            WHERE suppression.tenant_id = $1::uuid
              AND lower(suppression.email) = lower($2)
              AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
              AND suppression.reason IN ('manual_unsubscribe', 'list_manual', 'global_unsubscribe')
              AND lower(COALESCE(suppression.metadata ->> 'gdpr_erasure', 'false')) <> 'true'
       )`, tenantID, target.Email).Scan(&protected, &reversible); err != nil {
			return nil, nil, fmt.Errorf("classify bulk resubscribe suppression: %w", err)
		}
		switch {
		case protected:
			exclusions["protected_suppression"]++
		case target.Address.Suppressed && !reversible:
			exclusions["unattributed_address_hold"]++
		default:
			targets = append(targets, target)
		}
	}
	if len(targets) == 0 {
		return targets, exclusions, nil
	}

	emails := make([]string, 0, len(targets))
	for _, target := range targets {
		emails = append(emails, strings.ToLower(target.Email))
	}
	captured, err := captureReversibleSuppressionIDs(ctx, tx, tenantID, emails)
	if err != nil {
		return nil, nil, err
	}
	if hooks.afterSuppressionCapture != nil {
		hooks.afterSuppressionCapture()
	}
	if err := deleteCapturedSuppressions(ctx, tx, tenantID, captured); err != nil {
		return nil, nil, err
	}

	// Re-evaluate after deleting only the rows that were locked and captured.
	// A later one-click unsubscribe, complaint, bounce, or address hold causes
	// the serializable transaction to abort/fail closed; it is never swept by a
	// broad reason-based DELETE.
	var concurrentHolds int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM v_suppressions_unified AS suppression
 WHERE suppression.tenant_id = $1::uuid
   AND lower(suppression.email) = ANY($2::text[])
   AND (suppression.expires_at IS NULL OR suppression.expires_at > now())`, tenantID, emails).Scan(&concurrentHolds); err != nil {
		return nil, nil, fmt.Errorf("recheck bulk resubscribe suppressions: %w", err)
	}
	if concurrentHolds > 0 {
		return nil, nil, ErrConcurrentConsentDecision
	}

	for index := range targets {
		target := &targets[index]
		eventID, err := recordEmailConsentEvidence(
			ctx, tx, tenantID,
			&Subscriber{ID: target.SubscriberID, Email: target.Email},
			target.Address, "subscribed", in.ConsentProvenanceInput,
			"bulk_resubscribe", auditMeta,
		)
		if err != nil {
			return nil, nil, fmt.Errorf("append bulk resubscribe exact evidence: %w", err)
		}
		target.EventID = eventID
		current, state, err := lockEmailConsentAddressForRepairByID(
			ctx, tx, tenantID, target.SubscriberID, target.AddressID,
		)
		if err != nil {
			return nil, nil, fmt.Errorf("refresh bulk resubscribe address: %w", err)
		}
		if current == nil || current.ConsentStatus != "subscribed" || state != "proven" {
			return nil, nil, errors.New("bulk resubscribe exact grant did not reach proven terminal projection")
		}
		updated, err := setEmailSuppressedForRepairByID(
			ctx, tx, tenantID, target.SubscriberID, target.AddressID,
			current.UpdatedAt, false,
		)
		if err != nil {
			return nil, nil, fmt.Errorf("clear bulk resubscribe address suppression: %w", err)
		}
		target.Address = updated
	}
	targetIDs := make([]string, 0, len(targets))
	for _, target := range targets {
		targetIDs = append(targetIDs, target.SubscriberID)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET status = 'enabled',
       mailchimp_status = 'subscribed',
       consent_timestamp = $3,
       consent_source = $4,
       unsubscribe_reason = NULL,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])`, tenantID, targetIDs, in.OccurredAt,
		legacyConsentSource(in.Source)); err != nil {
		return nil, nil, fmt.Errorf("enable reviewed bulk resubscribe scope: %w", err)
	}

	for _, target := range targets {
		if d.Repo.ConsentSyncLedger != nil {
			if err := d.Repo.ConsentSyncLedger.RecordEvent(
				ctx, tx, tenantID, target.SubscriberID, ConsentSyncEventConsentGranted,
			); err != nil {
				return nil, nil, fmt.Errorf("record bulk resubscribe consent sync: %w", err)
			}
		}
		if err := fireEmailConsentWebhook(ctx, d.Repo, tx, tenantID,
			&Subscriber{ID: target.SubscriberID, Email: target.Email},
			target.Address, target.EventID); err != nil {
			return nil, nil, err
		}
	}
	if err := d.Repo.appendEngineSyncMany(ctx, tx, tenantID, targetIDs); err != nil {
		return nil, nil, err
	}
	return targets, exclusions, nil
}

func captureReversibleSuppressionIDs(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
) (capturedSuppressionIDs, error) {
	var captured capturedSuppressionIDs
	queries := []struct {
		destination *[]string
		sql         string
	}{
		{&captured.Subscriber, `
SELECT id::text FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = ANY($2::text[])
   AND (expires_at IS NULL OR expires_at > now())
   AND reason IN ('manual_unsubscribe', 'list_manual', 'global_unsubscribe')
   AND lower(COALESCE(metadata ->> 'gdpr_erasure', 'false')) <> 'true'
 ORDER BY lower(email::text), id FOR UPDATE`},
		{&captured.Email, `
SELECT id::text FROM email_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = ANY($2::text[])
   AND (expires_at IS NULL OR expires_at > now())
   AND reason IN ('unsubscribe', 'manual', 'imported', 'manual_unsubscribe', 'list_manual', 'global_unsubscribe')
   AND lower(COALESCE(metadata ->> 'gdpr_erasure', 'false')) <> 'true'
 ORDER BY lower(email::text), id FOR UPDATE`},
		{&captured.Legacy, `
SELECT id::text FROM suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = ANY($2::text[])
   AND reason IN ('manual_unsubscribe', 'list_manual', 'global_unsubscribe')
 ORDER BY lower(email::text), id FOR UPDATE`},
	}
	for _, query := range queries {
		rows, err := tx.Query(ctx, query.sql, tenantID, emails)
		if err != nil {
			return captured, fmt.Errorf("capture reversible suppression rows: %w", err)
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return captured, fmt.Errorf("scan reversible suppression row: %w", err)
			}
			*query.destination = append(*query.destination, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return captured, fmt.Errorf("iterate reversible suppression rows: %w", err)
		}
	}
	return captured, nil
}

func deleteCapturedSuppressions(ctx context.Context, tx pgx.Tx, tenantID string, captured capturedSuppressionIDs) error {
	for _, operation := range []struct {
		table string
		ids   []string
	}{
		{"subscriber_suppressions", captured.Subscriber},
		{"email_suppressions", captured.Email},
		{"suppressions", captured.Legacy},
	} {
		if len(operation.ids) == 0 {
			continue
		}
		query := "DELETE FROM " + operation.table + " WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])"
		tag, err := tx.Exec(ctx, query, tenantID, operation.ids)
		if err != nil {
			return fmt.Errorf("delete captured %s rows: %w", operation.table, err)
		}
		if int(tag.RowsAffected()) != len(operation.ids) {
			return ErrConcurrentConsentDecision
		}
	}
	return nil
}

func legacyConsentSource(source string) string {
	switch source {
	case ConsentDoubleOptIn, ConsentSingleOptIn:
		return source
	case ConsentImport:
		return ConsentImport
	default:
		return ConsentAPI
	}
}
