// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// ErrChannelConsentInfrastructureUnavailable prevents an email decision from
// committing when its durable external reconciliation intent cannot be
// appended. The canonical database state and the delivery engine must never
// knowingly diverge on a reviewed grant or withdrawal.
var ErrChannelConsentInfrastructureUnavailable = errors.New("subscriber: channel consent synchronization unavailable")

const canonicalEmailChannelConsentSource = "subscriber_email_terminal_v2"

type normalizedChannelConsentMutation struct {
	channel    string
	status     string
	provenance *ConsentProvenanceInput
}

func normalizeChannelConsentMutation(channelRaw string, in *UpdateChannelConsentInput) (normalizedChannelConsentMutation, error) {
	var out normalizedChannelConsentMutation
	if in == nil {
		return out, fmt.Errorf("%w: request is required", ErrInvalidInput)
	}
	channel, err := normalizeChannel(channelRaw)
	if err != nil {
		return out, err
	}
	out.channel = channel
	if in.ClearFrequencyCap && in.FrequencyCapUntil != nil {
		return out, fmt.Errorf("%w: frequency_cap_until and clear_frequency_cap are mutually exclusive", ErrInvalidInput)
	}

	provenanceFieldsPresent := in.ConsentSource != nil || in.ConsentTimestamp != nil ||
		in.EvidenceChannel != nil || in.LegalBasis != nil || in.Evidence != nil ||
		in.Jurisdiction != nil || in.Reason != nil || in.PolicyVersion != nil
	if in.Status == nil {
		if provenanceFieldsPresent {
			return out, fmt.Errorf("%w: status is required when changing consent evidence", ErrInvalidInput)
		}
		if in.FrequencyCapUntil == nil && !in.ClearFrequencyCap {
			return out, fmt.Errorf("%w: status or a frequency-cap change is required", ErrInvalidInput)
		}
		return out, nil
	}

	status, err := normalizeChannelConsentStatus(*in.Status, "")
	if err != nil {
		return out, err
	}
	if status != "opted_in" && status != "opted_out" {
		return out, fmt.Errorf("%w: channel decisions support only opted_in or opted_out; pending and unknown are read-only fail-closed states", ErrInvalidInput)
	}
	if channel != "email" {
		return out, fmt.Errorf("%w: %s consent cannot be mutated until its canonical delivery store is connected; frequency-cap-only edits remain available", ErrInvalidInput, channel)
	}

	candidate := ConsentProvenanceInput{
		Source:        derefStr(in.ConsentSource),
		Channel:       derefStr(in.EvidenceChannel),
		LegalBasis:    derefStr(in.LegalBasis),
		OccurredAt:    in.ConsentTimestamp,
		Jurisdiction:  derefStr(in.Jurisdiction),
		Evidence:      derefStr(in.Evidence),
		Reason:        derefStr(in.Reason),
		PolicyVersion: derefStr(in.PolicyVersion),
	}
	if err := normalizeConsentProvenance(&candidate, status == "opted_in"); err != nil {
		return out, fmt.Errorf("%w: %s", ErrInvalidInput, err.Error())
	}
	if status == "opted_in" {
		if err := validateCanonicalEmailGrantProvenance(candidate); err != nil {
			return out, err
		}
	}
	in.ConsentTimestamp = candidate.OccurredAt
	in.ConsentSource = &candidate.Source
	out.status = status
	out.provenance = &candidate
	return out, nil
}

func validateCanonicalEmailGrantProvenance(in ConsentProvenanceInput) error {
	if in.LegalBasis != "consent" {
		return fmt.Errorf("%w: email opt-in requires legal_basis=consent", ErrInvalidInput)
	}
	allowed := map[string]map[string]bool{
		"double_optin":      {"email": true, "web": true, "api": true},
		"single_optin":      {"email": true, "web": true, "api": true},
		"signed_form":       {"web": true, "import": true, "api": true},
		"preference_center": {"web": true, "email": true, "api": true},
		"direct_request":    {"desktop": true, "api": true, "email": true},
	}
	if !allowed[in.Source][in.Channel] {
		return fmt.Errorf("%w: evidence channel %q is not valid for source %q", ErrInvalidInput, in.Channel, in.Source)
	}
	return nil
}

// SetChannelConsentWithAudit converges an email decision across the immutable
// exact-address evidence pair, address status, suppressions, subscriber
// purpose/status projections, channel projection, consent-sync ledger,
// outbound webhook, audit log, and engine-sync outbox in one transaction.
func (r *Repo) SetChannelConsentWithAudit(
	ctx context.Context,
	tenantID, subscriberID, channelRaw string,
	in UpdateChannelConsentInput,
	auditMeta db.AuditMeta,
) (*ChannelConsent, error) {
	mutation, err := normalizeChannelConsentMutation(channelRaw, &in)
	if err != nil {
		return nil, err
	}
	if mutation.channel == "email" && mutation.status != "" &&
		(r == nil || r.EngineSyncOutbox == nil || r.Webhooks == nil) {
		return nil, ErrChannelConsentInfrastructureUnavailable
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	subscriber, err := getInTxForUpdate(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	if in.IfMatchToken != "" && in.IfMatchToken != httpcache.ConcurrencyToken("subscriber", subscriber.ID, subscriber.UpdatedAt) {
		return nil, ErrPreconditionFailed
	}
	if mutation.status == "opted_in" && subscriber.ArchivedAt != nil {
		return nil, fmt.Errorf("%w: archived subscribers cannot receive a new email grant", ErrInvalidInput)
	}

	var address *SubscriberEmail
	consentEventID := ""
	if mutation.status != "" {
		address, err = ensureCanonicalChannelConsentAddress(ctx, tx, tenantID, subscriber)
		if err != nil {
			return nil, err
		}
		consentStatus := "unsubscribed"
		if mutation.status == "opted_in" {
			consentStatus = "subscribed"
		}
		consentEventID, err = recordEmailConsentEvidence(ctx, tx, tenantID, subscriber, address,
			consentStatus, *mutation.provenance, "channel_consent_email", auditMeta)
		if err != nil {
			return nil, err
		}
		if mutation.status == "opted_in" {
			if err := applyEmailChannelGrant(ctx, tx, tenantID, subscriber, address, *mutation.provenance); err != nil {
				return nil, err
			}
		} else if err := applyEmailChannelRevocation(ctx, tx, tenantID, subscriber, address, *mutation.provenance); err != nil {
			return nil, err
		}
	}

	out, err := upsertChannelConsentProjection(ctx, tx, tenantID, subscriber, mutation, in)
	if err != nil {
		return nil, err
	}
	if mutation.status != "" {
		address, err = loadCanonicalChannelConsentAddress(ctx, tx, tenantID, subscriber)
		if err != nil {
			return nil, err
		}
		if r.ConsentSyncLedger != nil {
			eventType := ConsentSyncEventUnsubscribe
			if mutation.status == "opted_in" {
				eventType = ConsentSyncEventConsentGranted
			}
			if err := r.ConsentSyncLedger.RecordEvent(ctx, tx, tenantID, subscriber.ID, eventType); err != nil {
				return nil, fmt.Errorf("record channel consent sync: %w", err)
			}
		}
		if err := fireEmailConsentWebhook(ctx, r, tx, tenantID, subscriber, address, consentEventID); err != nil {
			return nil, err
		}
		if err := r.appendEngineSync(ctx, tx, tenantID, subscriber.ID, ""); err != nil {
			return nil, err
		}
	} else if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:  tenantID,
			EventType: EventSubscriberConsentChanged,
			Body: map[string]any{
				"id":                  subscriber.ID,
				"channel":             mutation.channel,
				"frequency_cap_until": out.FrequencyCapUntil,
			},
			IdempotencyKey: fmt.Sprintf("subscriber-channel-cap:%s:%d", out.ID, out.UpdatedAt.UnixMicro()),
		}); err != nil {
			return nil, fmt.Errorf("dispatch channel-cap webhook: %w", err)
		}
	}

	auditMeta.TenantID = tenantID
	metadata := map[string]any{
		"channel":             mutation.channel,
		"previous_version":    in.IfMatchToken,
		"frequency_cap_until": out.FrequencyCapUntil,
		"clear_frequency_cap": in.ClearFrequencyCap,
	}
	if mutation.status != "" {
		metadata["status"] = mutation.status
		metadata["consent_event_id"] = consentEventID
		metadata["email_redacted"] = observability.RedactEmail(subscriber.Email)
	}
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.channel_consent_updated", "subscriber", subscriber.ID, metadata); err != nil {
		return nil, fmt.Errorf("audit channel consent: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriber.ID); err != nil {
		return nil, fmt.Errorf("advance subscriber channel-consent version: %w", err)
	}
	updatedSubscriber, err := getInTx(ctx, tx, tenantID, subscriber.ID)
	if err != nil {
		return nil, err
	}
	out.SubscriberVersion = updatedSubscriber.Version
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func ensureCanonicalChannelConsentAddress(ctx context.Context, tx pgx.Tx, tenantID string, subscriber *Subscriber) (*SubscriberEmail, error) {
	// Acquire migration 1766's bounded exact-address mutex before any address
	// lookup or row lock. A retained positive may be hidden by the global gate
	// or proof-expiry SELECT policy, so the resolver's security-definer result is
	// the only safe pre-evidence identity source. Retain this transaction while
	// recordEmailConsentEvidence appends and projects the terminal decision.
	resolved, _, err := lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, subscriber.ID, subscriber.Email,
	)
	if err != nil {
		return nil, err
	}
	if resolved != nil {
		return resolved, nil
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
SELECT $1::uuid, $2::uuid, $3::citext,
       NOT EXISTS (
           SELECT 1 FROM subscriber_emails
            WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND is_primary
       ),
       'never_subscribed', false
 WHERE NOT EXISTS (
       SELECT 1 FROM subscriber_emails
        WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
          AND lower(email::text) = lower($3::text)
 )
ON CONFLICT DO NOTHING`, tenantID, subscriber.ID, subscriber.Email); err != nil {
		return nil, fmt.Errorf("ensure canonical consent address: %w", err)
	}
	return loadCanonicalChannelConsentAddress(ctx, tx, tenantID, subscriber)
}

func loadCanonicalChannelConsentAddress(ctx context.Context, tx pgx.Tx, tenantID string, subscriber *Subscriber) (*SubscriberEmail, error) {
	resolved, _, err := lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, subscriber.ID, subscriber.Email,
	)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, ErrEmailTaken
	}

	address, err := scanSubscriberEmail(tx.QueryRow(ctx, `
SELECT `+subscriberEmailColumns+` FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
 FOR UPDATE`, tenantID, subscriber.ID, subscriber.Email))
	// A pre-evidence retained positive can remain intentionally invisible even
	// after the resolver has acquired its advisory mutex. In that case the
	// resolver's exact identity/status is sufficient to append the new terminal
	// evidence. Once the evidence trigger projects a non-positive or renewed
	// positive, the later call returns the full visible address row.
	if errors.Is(err, pgx.ErrNoRows) {
		return resolved, nil
	}
	if err != nil {
		return nil, err
	}
	return address, nil
}

func applyEmailChannelGrant(
	ctx context.Context, tx pgx.Tx, tenantID string,
	subscriber *Subscriber, address *SubscriberEmail, provenance ConsentProvenanceInput,
) error {
	email := strings.ToLower(strings.TrimSpace(address.Email))
	captured, err := captureReversibleSuppressionIDs(ctx, tx, tenantID, []string{email})
	if err != nil {
		return err
	}
	if err := deleteCapturedSuppressions(ctx, tx, tenantID, captured); err != nil {
		return err
	}
	var held bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM v_suppressions_unified
     WHERE tenant_id = $1::uuid AND lower(email) = lower($2)
       AND (expires_at IS NULL OR expires_at > now())
)`, tenantID, address.Email).Scan(&held); err != nil {
		return fmt.Errorf("recheck canonical email suppressions: %w", err)
	}
	if held {
		return ErrProtectedEmailSuppression
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = 'subscribed', suppressed = false,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, address.ID); err != nil {
		return fmt.Errorf("grant canonical email consent: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET status = 'enabled', mailchimp_status = 'subscribed',
       consent_timestamp = $3, consent_source = $4,
       consent_email_marketing_at = $3, unsubscribe_reason = NULL,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriber.ID,
		provenance.OccurredAt, legacyConsentSource(provenance.Source)); err != nil {
		return fmt.Errorf("project canonical email grant: %w", err)
	}
	return nil
}

func applyEmailChannelRevocation(
	ctx context.Context, tx pgx.Tx, tenantID string,
	subscriber *Subscriber, address *SubscriberEmail, provenance ConsentProvenanceInput,
) error {
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET consent_status = 'unsubscribed', suppressed = true,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, address.ID); err != nil {
		return fmt.Errorf("withdraw canonical email consent: %w", err)
	}
	if err := ensureEmailSafetySuppression(ctx, tx, tenantID, address,
		"channel_consent_email", provenance.Reason, provenance.Evidence); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET status = 'blocklisted', mailchimp_status = 'unsubscribed',
       consent_timestamp = $3, consent_source = $4,
       consent_email_marketing_at = NULL, unsubscribe_reason = $5,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriber.ID,
		provenance.OccurredAt, legacyConsentSource(provenance.Source), provenance.Reason); err != nil {
		return fmt.Errorf("project canonical email withdrawal: %w", err)
	}
	return nil
}

// ensureEmailChannelConsentProjectionRow makes the profile's email
// channel-consent row exist so the canonical fold has somewhere to put the
// decision.
//
// refresh_subscriber_email_consent_projection (migration 1766) is what turns
// exact-address evidence into the (profile, email) row the Consent tab reads,
// and it is an UPDATE: it can only correct a row that is already there. Until
// now only this file's PATCH surface and the jurisdiction re-confirmation
// inserted one, so a profile whose consent was recorded anywhere else — every
// hosted signup form, an import, a bulk resubscribe — had no row at all, and
// the Consent tab read "Unknown" with no timestamp for somebody who had
// plainly consented.
//
// The row is inserted at its 'unknown' defaults and nothing more: the status,
// timestamp and source still come only from the certified fold, so this can
// never become a second, disagreeing opinion about what was consented to.
// Only the profile's own canonical address gets one, because the row is
// profile-wide — a secondary address's decision must not speak for the
// profile, which is the same rule the fold applies.
func ensureEmailChannelConsentProjectionRow(
	ctx context.Context, tx pgx.Tx, tenantID string, subscriber *Subscriber, address *SubscriberEmail,
) error {
	if subscriber == nil || address == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_channel_consents (tenant_id, subscriber_id, channel, email)
SELECT $1::uuid, profile.id, 'email', profile.email
  FROM subscribers AS profile
 WHERE profile.tenant_id = $1::uuid
   AND profile.id = $2::uuid
   AND lower(btrim(profile.email::text)) = lower(btrim($3))
ON CONFLICT (tenant_id, subscriber_id, channel) DO NOTHING`,
		tenantID, subscriber.ID, address.Email); err != nil {
		return fmt.Errorf("ensure the email channel consent row: %w", err)
	}
	return nil
}

func upsertChannelConsentProjection(
	ctx context.Context, tx pgx.Tx, tenantID string, subscriber *Subscriber,
	mutation normalizedChannelConsentMutation, in UpdateChannelConsentInput,
) (*ChannelConsent, error) {
	var phone *string
	if err := tx.QueryRow(ctx, `
SELECT phone_e164 FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriber.ID).Scan(&phone); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var timestamp any
	source := ""
	if mutation.provenance != nil {
		timestamp = mutation.provenance.OccurredAt
		source = canonicalEmailChannelConsentSource
	}
	return scanChannelConsent(tx.QueryRow(ctx, `
INSERT INTO subscriber_channel_consents
    (tenant_id, subscriber_id, channel, status, consent_timestamp,
     consent_source, frequency_cap_until, email, phone_e164)
VALUES ($1::uuid, $2::uuid, $3,
        COALESCE(NULLIF($4, ''), 'unknown'), $5::timestamptz,
        COALESCE(NULLIF($6, ''), 'unknown'),
        CASE WHEN $7 THEN NULL ELSE $8::timestamptz END, $9, $10)
ON CONFLICT (tenant_id, subscriber_id, channel) DO UPDATE SET
    status = COALESCE(NULLIF($4, ''), subscriber_channel_consents.status),
    consent_timestamp = CASE WHEN NULLIF($4, '') IS NOT NULL
                             THEN $5::timestamptz ELSE subscriber_channel_consents.consent_timestamp END,
    consent_source = CASE WHEN NULLIF($4, '') IS NOT NULL
                          THEN $6 ELSE subscriber_channel_consents.consent_source END,
    frequency_cap_until = CASE WHEN $7 THEN NULL WHEN $8::timestamptz IS NOT NULL THEN $8::timestamptz
                               ELSE subscriber_channel_consents.frequency_cap_until END,
    email = $9, phone_e164 = $10, updated_at = clock_timestamp()
RETURNING `+channelConsentColumns,
		tenantID, subscriber.ID, mutation.channel, mutation.status, timestamp,
		source, in.ClearFrequencyCap, in.FrequencyCapUntil, subscriber.Email, phone))
}
