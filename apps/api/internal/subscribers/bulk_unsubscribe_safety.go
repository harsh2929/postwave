// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const bulkUnsubscribePolicyVersion = "operator-bulk-unsubscribe-v1"

type bulkUnsubscribeTarget struct {
	SubscriberID string
	Email        string
	AddressID    string
	EventID      string
	Address      *SubscriberEmail
}

// applyBulkUnsubscribe records an administrative withdrawal across every
// authoritative representation in one transaction. Unsubscribe is
// intentionally not made automatically reversible: restoring marketing
// permission requires the separately reviewed BulkResubscribe evidence flow.
func (d *Deps) applyBulkUnsubscribe(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ids []string,
	source string,
	auditMeta db.AuditMeta,
) ([]bulkUnsubscribeTarget, error) {
	operationID, err := newRecoveryToken()
	if err != nil {
		return nil, fmt.Errorf("mint bulk unsubscribe operation id: %w", err)
	}

	// Legacy rows can predate the mandatory canonical-address invariant. Create
	// a fail-closed companion before selecting the reviewed scope so revocation
	// never leaves a status-only profile behind. A conflicting address already
	// owned by another profile remains excluded by the subsequent inner join.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
SELECT subscriber.tenant_id,
       subscriber.id,
       subscriber.email,
       NOT EXISTS (
           SELECT 1
             FROM subscriber_emails AS current_primary
            WHERE current_primary.tenant_id = subscriber.tenant_id
              AND current_primary.subscriber_id = subscriber.id
              AND current_primary.is_primary
       ),
       'never_subscribed',
       false
  FROM subscribers AS subscriber
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = ANY($2::uuid[])
   AND NOT EXISTS (
       SELECT 1
         FROM subscriber_emails AS address
        WHERE address.tenant_id = subscriber.tenant_id
          AND address.subscriber_id = subscriber.id
          AND lower(address.email::text) = lower(subscriber.email::text)
   )
ON CONFLICT DO NOTHING`, tenantID, ids); err != nil {
		return nil, fmt.Errorf("ensure canonical addresses for bulk unsubscribe: %w", err)
	}

	// Lock parent profiles in the same canonical normalized-address order used
	// by the exact-address advisory mutex. Do not join or tuple-lock
	// subscriber_emails here: migration 1766 intentionally hides retained
	// positive rows from ordinary SELECT, while the repair resolver below is the
	// only complete and bounded lookup. Parent -> advisory is the shared writer
	// lock order and prevents overlapping audience operations from deadlocking.
	rows, err := tx.Query(ctx, `
SELECT subscriber.id::text,
       subscriber.email::text,
       (
           subscriber.status <> 'blocklisted'
           OR subscriber.mailchimp_status <> 'unsubscribed'
           OR subscriber.consent_email_marketing_at IS NOT NULL
       ) AS subscriber_needs_withdrawal
  FROM subscribers AS subscriber
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = ANY($2::uuid[])
	ORDER BY public.subscriber_email_consent_normalize_email(
	             subscriber.email::text
	         ) COLLATE "C",
	         subscriber.id
 FOR UPDATE OF subscriber`, tenantID, ids)
	if err != nil {
		return nil, fmt.Errorf("lock bulk unsubscribe scope: %w", err)
	}
	type candidate struct {
		subscriberID              string
		email                     string
		subscriberNeedsWithdrawal bool
	}
	candidates := make([]candidate, 0, len(ids))
	for rows.Next() {
		var item candidate
		if err := rows.Scan(
			&item.subscriberID,
			&item.email,
			&item.subscriberNeedsWithdrawal,
		); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan bulk unsubscribe candidate: %w", err)
		}
		candidates = append(candidates, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bulk unsubscribe candidates: %w", err)
	}

	targets := make([]bulkUnsubscribeTarget, 0, len(ids))
	for _, item := range candidates {
		address, _, err := lockEmailConsentAddressForRepair(
			ctx, tx, tenantID, item.subscriberID, item.email,
		)
		if err != nil {
			return nil, fmt.Errorf("resolve bulk unsubscribe address: %w", err)
		}
		// Missing includes a canonical-address collision owned by another
		// profile. It is reported in the existing skipped count and is never
		// mutated through the wrong subscriber identity.
		if address == nil {
			continue
		}
		if !item.subscriberNeedsWithdrawal &&
			address.ConsentStatus == "unsubscribed" && address.Suppressed {
			continue
		}
		targets = append(targets, bulkUnsubscribeTarget{
			SubscriberID: item.subscriberID,
			Email:        address.Email,
			AddressID:    address.ID,
			Address:      address,
		})
	}
	if len(targets) == 0 {
		return targets, nil
	}

	targetIDs := make([]string, 0, len(targets))
	addressIDs := make([]string, 0, len(targets))
	emails := make([]string, 0, len(targets))
	for _, target := range targets {
		targetIDs = append(targetIDs, target.SubscriberID)
		addressIDs = append(addressIDs, target.AddressID)
		emails = append(emails, target.Email)
	}
	actor := strings.TrimSpace(auditMeta.ActorLabel)
	if actor == "" {
		actor = "administrative bulk action"
	}
	preferences, err := json.Marshal(map[string]any{
		"operation":    "bulk_unsubscribe",
		"operation_id": operationID,
		"reason":       "administrative bulk unsubscribe",
		"actor":        actor,
	})
	if err != nil {
		return nil, fmt.Errorf("encode bulk unsubscribe evidence: %w", err)
	}
	proofText := "Administrative bulk unsubscribe operation " + operationID
	var ipAddress any
	if parsed := net.ParseIP(strings.TrimSpace(auditMeta.IP)); parsed != nil {
		ipAddress = parsed.String()
	}

	eventRows, err := tx.Query(ctx, `
INSERT INTO consent_events
       (tenant_id, subject_type, subject_id, subject_email, channel,
        category, action, source, policy_version, preferences, proof_text,
        ip, user_agent, created_at)
SELECT $1::uuid,
       'subscriber',
       batch.address_id,
       batch.email,
       'api',
       'email_marketing',
       'revoked',
       'direct_request',
       $3,
       $4::jsonb,
       $5,
       $6::inet,
       NULLIF($7, ''),
       clock_timestamp()
  FROM unnest($2::text[], $8::text[])
       AS batch(address_id, email)
RETURNING subject_id, id::text`, tenantID, addressIDs,
		bulkUnsubscribePolicyVersion, string(preferences), proofText,
		ipAddress, auditMeta.UserAgent, emails)
	if err != nil {
		return nil, fmt.Errorf("append bulk unsubscribe consent events: %w", err)
	}
	eventsByAddress := make(map[string]string, len(targets))
	for eventRows.Next() {
		var addressID, eventID string
		if err := eventRows.Scan(&addressID, &eventID); err != nil {
			eventRows.Close()
			return nil, fmt.Errorf("scan bulk unsubscribe event: %w", err)
		}
		eventsByAddress[addressID] = eventID
	}
	eventRows.Close()
	if err := eventRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bulk unsubscribe events: %w", err)
	}
	if len(eventsByAddress) != len(targets) {
		return nil, fmt.Errorf("bulk unsubscribe event cardinality mismatch: got %d want %d", len(eventsByAddress), len(targets))
	}

	eventIDs := make([]string, 0, len(targets))
	for index := range targets {
		targets[index].EventID = eventsByAddress[targets[index].AddressID]
		eventIDs = append(eventIDs, targets[index].EventID)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records
       (tenant_id, subscriber_id, email, channel, consent_status, source,
        ip_addr, user_agent, captured_at, evidence)
SELECT $1::uuid,
       batch.subscriber_id::uuid,
       batch.email,
       'email',
       'withdrawn',
       'admin',
       $5::inet,
       NULLIF($6, ''),
       clock_timestamp(),
       jsonb_build_object(
           'event_id', batch.event_id,
           'operation', 'bulk_unsubscribe',
           'operation_id', $4::text,
           'reason', 'administrative bulk unsubscribe',
           'policy_version', $7::text
       )
  FROM unnest($2::text[], $3::text[], $8::text[])
       AS batch(subscriber_id, email, event_id)`, tenantID,
		targetIDs, emails, operationID, ipAddress, auditMeta.UserAgent,
		bulkUnsubscribePolicyVersion, eventIDs); err != nil {
		return nil, fmt.Errorf("append bulk unsubscribe consent proofs: %w", err)
	}

	// Never overwrite a complaint, bounce, erasure, or another owner's hold.
	// The exact address projection below accepts suppression only after an
	// active unified hold exists, so evidence always precedes projection.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions
       (tenant_id, email, reason, source, metadata)
SELECT $1::uuid,
       batch.email,
       'manual_unsubscribe',
       'api',
       jsonb_build_object(
           'operation', 'bulk_unsubscribe',
           'operation_id', $3::text,
           'subscriber_id', batch.subscriber_id,
           'policy_version', $4::text
       )
  FROM unnest($2::text[], $5::text[]) AS batch(email, subscriber_id)
ON CONFLICT (tenant_id, email) DO NOTHING`, tenantID, emails,
		operationID, bulkUnsubscribePolicyVersion, targetIDs); err != nil {
		return nil, fmt.Errorf("record bulk unsubscribe suppressions: %w", err)
	}

	// The immutable revoke evidence above projects consent_status through
	// migration 1766's trigger. Re-resolve each address to bind suppression to
	// that fresh exact revision, then use the sole privileged projection writer
	// to cross restrictive SELECT RLS without weakening it.
	for index := range targets {
		current, _, err := lockEmailConsentAddressForRepairByID(
			ctx, tx, tenantID, targets[index].SubscriberID, targets[index].AddressID,
		)
		if err != nil {
			return nil, fmt.Errorf("refresh bulk unsubscribe address: %w", err)
		}
		if current == nil {
			return nil, errors.New("bulk unsubscribe address disappeared after evidence append")
		}
		updated, err := setEmailSuppressedForRepairByID(
			ctx, tx, tenantID, targets[index].SubscriberID,
			targets[index].AddressID, current.UpdatedAt, true,
		)
		if err != nil {
			return nil, fmt.Errorf("project bulk unsubscribe suppression: %w", err)
		}
		targets[index].Address = updated
	}

	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET status = 'blocklisted',
       mailchimp_status = 'unsubscribed',
       unsubscribe_reason = 'administrative bulk unsubscribe',
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])`, tenantID, targetIDs); err != nil {
		return nil, fmt.Errorf("blocklist bulk unsubscribe scope: %w", err)
	}

	for _, target := range targets {
		if d.Repo.ConsentSyncLedger != nil {
			if err := d.Repo.ConsentSyncLedger.RecordEvent(
				ctx, tx, tenantID, target.SubscriberID, ConsentSyncEventUnsubscribe,
			); err != nil {
				return nil, fmt.Errorf("record bulk unsubscribe consent sync: %w", err)
			}
		}
		if err := fireEmailConsentWebhook(ctx, d.Repo, tx, tenantID,
			&Subscriber{ID: target.SubscriberID, Email: target.Email},
			target.Address, target.EventID); err != nil {
			return nil, err
		}
	}
	if err := d.Repo.appendEngineSyncMany(ctx, tx, tenantID, targetIDs); err != nil {
		return nil, err
	}

	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.bulk_unsubscribed", "subscribers", "", map[string]any{
		"count":          len(targets),
		"source":         source,
		"operation_id":   operationID,
		"consent_action": "revoked",
		"proof_count":    len(targets),
		"automatic_undo": false,
	}); err != nil {
		return nil, fmt.Errorf("audit bulk unsubscribe: %w", err)
	}
	return targets, nil
}

// bulkUnsubscribeNow exists only to make the evidence timestamp policy
// explicit in tests and documentation. Ledger inserts use clock_timestamp()
// within the transaction; this helper provides the corresponding API-level
// reference without introducing client-controlled chronology.
func bulkUnsubscribeNow() time.Time { return time.Now().UTC() }
