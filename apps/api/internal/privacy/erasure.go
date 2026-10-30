// SPDX-License-Identifier: AGPL-3.0-only
//
// erasure.go — subscriber-row anonymization invoked by the
// DeletionFulfillmentWorker once a privacy_requests row becomes
// eligible. Today's scope: subject-scoped erasure (subject_type IN
// ('subscriber','consumer') AND subject_email IS NOT NULL). Tenant-
// admin / full-tenant deletions are out of scope here — those flow
// through a separate operator script because the blast radius spans
// every subscriber row.
//
// Erasure strategy per table:
//
//   subscribers          UPDATE direct identifiers to an erased placeholder;
//                        clear names, phones, external/profile/account ids,
//                        JSON profile bags, IP, localization and derived
//                        profiling state. Status / consent source are kept for
//                        aggregate and legal-state reporting. A tenant-bound,
//                        cryptographically random placeholder is generated
//                        for every erasure so erase -> re-import -> erase can
//                        retain both anonymized generations without violating
//                        UNIQUE (tenant_id, email).
//
//   subscriber_events    NULL out ip + user_agent, replace
//                        subscriber_email with the erased placeholder
//                        so the row joins back to the anonymized
//                        subscriber for aggregate reporting.
//
//   consent_receipts     NULL out ip; replace subscriber_email with the
//                        placeholder. Receipts are an audit record and
//                        must survive (Art. 7(1) GDPR).
//
//   sequence_funnel_events / sequence_enrollments
//                        Replace subscriber_email with a row-scoped variant
//                        of the canonical placeholder. Sequence analytics and
//                        goal aggregates survive, repeated import/erasure
//                        cannot collide with an older retained row, and the
//                        subject's directly identifying address does not.
//
//   subscriber_notes     DELETE — operator-authored notes about the
//                        subscriber lose their subject and have no
//                        independent retention requirement.
//
//   frequency_cap_events DELETE — rolling-window enforcement history contains
//                        plaintext subscriber_email and has no independent
//                        legal-retention purpose. All attached email aliases
//                        are removed in the same transaction.
//
//   subscriber_send_log / intelligent_retry_events
//                        DELETE — queue-time enforcement and retry state carry
//                        the recipient address in plaintext. Neither is legal
//                        evidence; both are removed for the requested address
//                        and every still-attached profile alias.
//
//   suppressions         Upsert a row keyed on a stable, suppression-only
//                        pseudonym (never used for subscriber/history rows)
//                        with email_sha256 set to the hash of the
//                        ORIGINAL plaintext email. The sending path
//                        ORs on email equality + email_sha256 so a
//                        future import or re-subscribe of the same
//                        plaintext address remains suppressed.

package privacy

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
)

const (
	// erasedEmailDomain is the canonical RFC 6761 "invalid" TLD so the
	// placeholder address cannot accidentally route to a real mailbox.
	erasedEmailDomain = "erased.invalid"

	// A 128-bit nonce feeds a tenant/domain-separated SHA-256 derivation. We
	// encode 96 output bits so the longest sequence-row local part remains
	// within the RFC 5321 64-octet limit after its "+e<uuid>" suffix.
	erasureNonceBytes = 16
	erasureTokenBytes = 12

	// The current-schema profile scrub below is implemented and contract-tested,
	// but retained SMS proof/content, Mailchimp reporting/raw commerce payloads,
	// and other append-only event stores still need an approved retention policy
	// plus least-privilege mutation grants. This constant must only become true
	// in the same release that lands that inventory/migration and its PostgreSQL
	// absence proof. Until then every production caller fails before its first
	// write instead of recording a false Art. 17 success.
	erasureHistoryCoverageComplete = false
)

// ErrErasureCoverageIncomplete is safe for errors.Is and HTTP conflict
// mapping. It carries no subject data.
var ErrErasureCoverageIncomplete = errors.New(
	"privacy erasure is unavailable until retained history and content stores have complete transactional coverage",
)

// eraseStats counts the rows touched per table for the audit_log entry
// the worker emits alongside the privacy_requests fulfillment.
type eraseStats struct {
	SubscribersAnonymized         int64
	SubscriberEventsAnonymized    int64
	ConsentReceiptsAnonymized     int64
	SequenceFunnelAnonymized      int64
	SequenceEnrollmentsAnonymized int64
	FrequencyCapEventsDeleted     int64
	SubscriberSendLogDeleted      int64
	IntelligentRetryEventsDeleted int64
	SubscriberNotesDeleted        int64
	SuppressionsAffected          int64
	CampaignRepliesAnonymized     int64
	PlaygroundReceiptsShredded    int64
	ConversionIdentityReceiptID   string
	ConversionsIdentityRedacted   int64
	ConversionIdentityTouches     int64
	ConversionCampaignLinks       int64
	ConversionClickBindings       int64
	Placeholder                   string
}

func (s eraseStats) total() int64 {
	return s.SubscribersAnonymized + s.SubscriberEventsAnonymized +
		s.ConsentReceiptsAnonymized + s.SequenceFunnelAnonymized +
		s.SequenceEnrollmentsAnonymized + s.FrequencyCapEventsDeleted +
		s.SubscriberSendLogDeleted + s.IntelligentRetryEventsDeleted +
		s.SubscriberNotesDeleted + s.SuppressionsAffected +
		s.CampaignRepliesAnonymized + s.PlaygroundReceiptsShredded +
		s.ConversionsIdentityRedacted + s.ConversionIdentityTouches +
		s.ConversionCampaignLinks + s.ConversionClickBindings
}

// erasureExecutor is the smallest transaction surface the erasure routine
// needs. pgx.Tx satisfies it, while the narrow contract lets tests prove the
// full PII table inventory without emulating unrelated transaction methods.
type erasureExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// newErasedPlaceholder creates the non-routable identity used by one erasure
// event. It intentionally does not depend on the subject email: surviving rows
// cannot be linked to a guessed address through the placeholder. Tenant-domain
// separation also prevents cross-tenant equality if an entropy source were to
// repeat a nonce. Production calls use crypto/rand.Reader; the reader argument
// keeps entropy failure and repeat-erasure behavior directly testable.
func newErasedPlaceholder(entropy io.Reader, tenantID string) (string, error) {
	if entropy == nil {
		return "", fmt.Errorf("generate erasure placeholder: nil entropy source")
	}

	nonce := make([]byte, erasureNonceBytes)
	if _, err := io.ReadFull(entropy, nonce); err != nil {
		return "", fmt.Errorf("generate erasure placeholder: %w", err)
	}

	material := make([]byte, 0, len(tenantID)+len(nonce)+40)
	material = append(material, "postwave-erasure-placeholder-v2\x00"...)
	material = append(material, tenantID...)
	material = append(material, 0)
	material = append(material, nonce...)
	sum := sha256.Sum256(material)
	token := base64.RawURLEncoding.EncodeToString(sum[:erasureTokenBytes])
	return "erased+" + token + "@" + erasedEmailDomain, nil
}

// erasedSuppressionIdentity returns the stable, tenant-scoped key stored only
// in subscriber_suppressions. Keeping the historical derivation makes retries
// and upgrades idempotent, while separating it from subject/history rows avoids
// the repeated-erasure UNIQUE collision that a deterministic row placeholder
// caused. hashHex remains the send-time lookup for the original plaintext.
func erasedSuppressionIdentity(tenantID, normalizedEmail string) (placeholder, hashHex string) {
	sum := sha256.Sum256([]byte(tenantID + ":" + normalizedEmail))
	hex16 := hex.EncodeToString(sum[:8])
	rawSum := sha256.Sum256([]byte(normalizedEmail))
	return "erased+" + hex16 + "@" + erasedEmailDomain, hex.EncodeToString(rawSum[:])
}

// normalizeSubjectEmail lowercases and trims the subject_email exactly
// the way the suppression / subscriber lookup paths do so erasure
// matches the same rows the sending path would have rejected.
func normalizeSubjectEmail(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// eraseSubscriberData runs INSIDE the caller's open, tenant-bound transaction.
// Every statement still scopes by tenant_id explicitly as defense in depth.
// The function does not commit; the caller's tx.Commit completes the unit of
// work alongside the privacy_requests status update + audit row insert.
func eraseSubscriberData(ctx context.Context, tx erasureExecutor, tenantID, subjectEmail string) (eraseStats, error) {
	policy, err := currentErasurePolicyReadiness()
	if err != nil {
		return eraseStats{}, fmt.Errorf("%w: invalid store policy: %v", ErrErasureCoverageIncomplete, err)
	}
	if len(policy.ApprovalRequired) != 0 {
		return eraseStats{}, fmt.Errorf("%w: %d store policies require approval",
			ErrErasureCoverageIncomplete, len(policy.ApprovalRequired))
	}
	if !erasureHistoryCoverageComplete {
		return eraseStats{}, ErrErasureCoverageIncomplete
	}
	return eraseSubscriberDataWithEntropy(ctx, tx, tenantID, subjectEmail, rand.Reader)
}

func eraseSubscriberDataWithEntropy(
	ctx context.Context,
	tx erasureExecutor,
	tenantID, subjectEmail string,
	entropy io.Reader,
) (eraseStats, error) {
	var stats eraseStats
	normalized := normalizeSubjectEmail(subjectEmail)
	if tenantID == "" || normalized == "" {
		return stats, nil
	}
	placeholder, err := newErasedPlaceholder(entropy, tenantID)
	if err != nil {
		return stats, err
	}
	suppressionPlaceholder, hashHex := erasedSuppressionIdentity(tenantID, normalized)
	stats.Placeholder = placeholder

	// Signed conversion ingest owns the shared side of this tenant fence from
	// before its idempotency claim through commit. Taking the exclusive side
	// makes the cutover atomic: a pre-erasure ingest commits first and is found
	// by the fresh snapshot below, while a post-erasure ingest cannot commit old
	// subject identity behind an already-recorded receipt.
	if _, err := tx.Exec(ctx, `
SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended($1, 2029)
)`, tenantID); err != nil {
		return stats, fmt.Errorf("fence conversion subject identity erasure: %w", err)
	}
	// Email-keyed retry insertion and canonical-email rotation take this exact
	// tenant lock. Enqueue-first therefore commits before the deletes below;
	// erasure-first leaves a durable hash tombstone that the later enqueue sees
	// before it can recreate plaintext operational state.
	if err := subscriberidentitylock.Tenant(ctx, tx, tenantID); err != nil {
		return stats, fmt.Errorf("fence sending subject identity erasure: %w", err)
	}

	// Run before replacing the canonical subscriber row so the database
	// capability can still capture external-id, alias, click, and exact HMAC
	// projection links. The function is tenant-bound, least-privileged, and
	// returns only an immutable content-free receipt plus row counts.
	err = tx.QueryRow(ctx, `
SELECT receipt_id::text, conversions_redacted,
       identity_touches_shredded, campaign_links_severed,
       click_bindings_deleted
  FROM public.conversion_subject_identity_privacy_erase(
       $1::uuid, $2::citext, $3::citext, $4::uuid
  )`, tenantID, normalized, placeholder, uuid.NewString()).Scan(
		&stats.ConversionIdentityReceiptID,
		&stats.ConversionsIdentityRedacted,
		&stats.ConversionIdentityTouches,
		&stats.ConversionCampaignLinks,
		&stats.ConversionClickBindings,
	)
	if err != nil {
		return stats, fmt.Errorf("erase conversion subject identity: %w", err)
	}

	tag, err := tx.Exec(ctx, `
UPDATE subscribers AS subscriber
   SET email = $3::citext,
       primary_email = $3::citext,
       custom_fields = '{}'::jsonb,
       merge_fields = '{}'::jsonb,
       tags = '{}'::text[],
       groups = '[]'::jsonb,
       gdpr_permissions = '[]'::jsonb,
       activity_summary = '{}'::jsonb,
       gpp_sections = '{}'::jsonb,
       first_name = '',
       last_name = '',
       full_name = '',
       display_name = '',
       signup_ip = NULL,
       unsubscribe_reason = NULL,
       source_id = NULL,
       source_platform = NULL,
       external_id = NULL,
       phone_e164 = NULL,
       timezone = NULL,
       locale = NULL,
       language = NULL,
       country = NULL,
       region = NULL,
       data_region = NULL,
       detected_jurisdiction = NULL,
       jurisdiction_changed_at = NULL,
       jurisdiction_reconfirm_required = false,
       consent_timestamp = NULL,
       consent_email_marketing_at = NULL,
       consent_sms_marketing_at = NULL,
       consent_profiling_at = NULL,
       consent_targeted_ads_at = NULL,
       consent_ai_processing_at = NULL,
       mailchimp_last_changed = NULL,
       signup_source = 'unknown',
       account_id = NULL,
       profile_id = gen_random_uuid(),
       best_send_hour = NULL,
       best_send_hour_at = NULL,
       engagement_score = NULL,
       engagement_score_at = NULL,
       churn_score = NULL,
       churn_score_at = NULL,
       rating = NULL,
       frequency_preference = 'default',
       paused_until = NULL,
       updated_at = now()
 WHERE subscriber.tenant_id = $1::uuid
   AND (
       lower(subscriber.email::text) = $2
       OR lower(COALESCE(subscriber.primary_email::text, '')) = $2
       OR EXISTS (
           SELECT 1
             FROM subscriber_emails AS address
            WHERE address.tenant_id = subscriber.tenant_id
              AND address.subscriber_id = subscriber.id
              AND lower(address.email::text) = $2
       )
   )
   AND subscriber.email::text <> $3`,
		tenantID, normalized, placeholder)
	if err != nil {
		return stats, fmt.Errorf("erase subscribers: %w", err)
	}
	stats.SubscribersAnonymized = tag.RowsAffected()

	// Projected subscriber events cannot be updated directly: the governed
	// SECURITY DEFINER boundary redacts the canonical row, mirrors the exact
	// linked campaign_report_events row, and appends a content-free chained
	// before/after receipt in this same transaction. Unlinked canonical rows are
	// still redacted by the same function, so there is one authority regardless
	// of projection state.
	var subscriberEventsAnonymized int64
	err = tx.QueryRow(ctx, `
SELECT campaign_report_projection_privacy_erase_subscriber_events(
       $1::uuid,
       ARRAY(
           SELECT $2::citext
           UNION
           SELECT lower(address.email::text)::citext
             FROM subscriber_emails AS address
             JOIN subscribers AS subscriber
               ON subscriber.tenant_id = address.tenant_id
              AND subscriber.id = address.subscriber_id
            WHERE subscriber.tenant_id = $1::uuid
              AND subscriber.email = $3::citext
       ),
       $3::citext,
       gen_random_uuid()
  )`, tenantID, normalized, placeholder).Scan(&subscriberEventsAnonymized)
	if err != nil {
		return stats, fmt.Errorf("erase subscriber_events: %w", err)
	}
	stats.SubscriberEventsAnonymized = subscriberEventsAnonymized

	tag, err = tx.Exec(ctx, `
UPDATE consent_receipts
   SET subscriber_email = $3,
       ip = NULL
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email) IN (
       SELECT $2
       UNION
       SELECT lower(address.email::text)
         FROM subscriber_emails AS address
         JOIN subscribers AS subscriber
           ON subscriber.tenant_id = address.tenant_id
          AND subscriber.id = address.subscriber_id
        WHERE subscriber.tenant_id = $1::uuid
          AND subscriber.email = $3::citext
   )`,
		tenantID, normalized, placeholder)
	if err != nil {
		return stats, fmt.Errorf("erase consent_receipts: %w", err)
	}
	stats.ConsentReceiptsAnonymized = tag.RowsAffected()

	tag, err = tx.Exec(ctx, `
UPDATE sequence_funnel_events
   SET subscriber_email = (
       split_part($3, '@', 1) || '+f' || id::text || '@' ||
       split_part($3, '@', 2)
   )::citext
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email::text) IN (
       SELECT $2
       UNION
       SELECT lower(address.email::text)
         FROM subscriber_emails AS address
         JOIN subscribers AS subscriber
           ON subscriber.tenant_id = address.tenant_id
          AND subscriber.id = address.subscriber_id
        WHERE subscriber.tenant_id = $1::uuid
          AND subscriber.email = $3::citext
   )
   AND subscriber_email::text <> $3`,
		tenantID, normalized, placeholder)
	if err != nil {
		return stats, fmt.Errorf("erase sequence_funnel_events: %w", err)
	}
	stats.SequenceFunnelAnonymized = tag.RowsAffected()

	tag, err = tx.Exec(ctx, `
UPDATE sequence_enrollments
   SET subscriber_email = (
       split_part($3, '@', 1) || '+e' || id::text || '@' ||
       split_part($3, '@', 2)
   )::citext
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email::text) IN (
       SELECT $2
       UNION
       SELECT lower(address.email::text)
         FROM subscriber_emails AS address
         JOIN subscribers AS subscriber
           ON subscriber.tenant_id = address.tenant_id
          AND subscriber.id = address.subscriber_id
        WHERE subscriber.tenant_id = $1::uuid
          AND subscriber.email = $3::citext
   )
   AND subscriber_email::text <> $3`,
		tenantID, normalized, placeholder)
	if err != nil {
		return stats, fmt.Errorf("erase sequence_enrollments: %w", err)
	}
	stats.SequenceEnrollmentsAnonymized = tag.RowsAffected()

	// campaign_replies is evidence, not a profile row, so it is erased in place
	// rather than deleted: migration 1965's receipt digests are deliberately not
	// recomputed, leaving proof of exactly what arrived while the plaintext
	// identity goes. Migration 1974 permits this single one-way transition and
	// nothing else — the guard rejects a rewrite to any other real address.
	//
	// Matched on the raw address rather than the placeholder because this table
	// is keyed on the envelope the reply arrived from, which the subscribers
	// UPDATE above does not touch. `identity_redacted_at IS NULL` makes a
	// retried privacy request a no-op instead of a guard violation.
	tag, err = tx.Exec(ctx, `
UPDATE campaign_replies
   SET recipient_email = $3::citext,
       subject = NULL,
       identity_redacted_at = now()
 WHERE tenant_id = $1::uuid
   AND lower(recipient_email::text) = $2
   AND identity_redacted_at IS NULL`,
		tenantID, normalized, placeholder)
	if err != nil {
		return stats, fmt.Errorf("erase campaign_replies: %w", err)
	}
	stats.CampaignRepliesAnonymized = tag.RowsAffected()

	// Simulator inspection receipts may contain arbitrary request/receiver text.
	// Migration 2007 stores only a bounded email digest locator beside the
	// encrypted receipt. Erasure cryptoshreds both in this same transaction while
	// retaining fire_id, request_sha256, and idempotency_key_sha256 as the
	// payload-free no-redispatch fence. This is deliberately email-locator scoped:
	// names, phones, and other identifiers without the requested/current alias are
	// not discoverable. A pending fire is conservatively consumed as
	// transport-ambiguous because the receiver call may already be in flight.
	var playgroundReceiptsShredded int64
	err = tx.QueryRow(ctx, `
WITH subject_hashes AS (
    SELECT encode(digest(lower(btrim($2)), 'sha256'), 'hex') AS email_sha256
    UNION
    SELECT encode(digest(lower(address.email::text), 'sha256'), 'hex')
      FROM subscriber_emails AS address
      JOIN subscribers AS subscriber
        ON subscriber.tenant_id = address.tenant_id
       AND subscriber.id = address.subscriber_id
     WHERE subscriber.tenant_id = $1::uuid
       AND subscriber.email = $3::citext
), shredded AS (
    UPDATE outbound_webhook_playground_fires
       SET state='receipt_expired',
           outcome=COALESCE(outcome, 'transport_ambiguous'),
           receiver_status_code=COALESCE(receiver_status_code, 0),
           receipt_envelope=NULL,
           receipt_sha256=NULL,
           subject_email_sha256s='{}'::text[],
           completed_at=COALESCE(completed_at, now()),
           receipt_expired_at=now()
     WHERE tenant_id=$1::uuid
       AND state IN ('pending','completed','ambiguous')
       AND subject_email_sha256s && ARRAY(
           SELECT email_sha256 FROM subject_hashes
       )::text[]
    RETURNING 1
)
SELECT count(*) FROM shredded`, tenantID, normalized, placeholder).Scan(
		&playgroundReceiptsShredded,
	)
	if err != nil {
		return stats, fmt.Errorf("erase outbound webhook playground receipts: %w", err)
	}
	stats.PlaygroundReceiptsShredded = playgroundReceiptsShredded

	tag, err = tx.Exec(ctx, `
DELETE FROM subscriber_notes
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email::text) IN (
       SELECT $2
       UNION
       SELECT lower(address.email::text)
         FROM subscriber_emails AS address
         JOIN subscribers AS subscriber
           ON subscriber.tenant_id = address.tenant_id
          AND subscriber.id = address.subscriber_id
        WHERE subscriber.tenant_id = $1::uuid
          AND subscriber.email = $3::citext
   )`,
		tenantID, normalized, placeholder)
	if err != nil {
		return stats, fmt.Errorf("delete subscriber_notes: %w", err)
	}
	stats.SubscriberNotesDeleted = tag.RowsAffected()

	// Current-profile satellite stores carry aliases, free-text history,
	// inferred traits, denormalized channel identifiers, and model feature
	// snapshots. None is approved tombstone evidence, so remove the subject's
	// rows while the anonymized subscriber UUID still provides a stable target.
	profileDeletes := []struct {
		name string
		sql  string
	}{
		{"subscriber_attribute_history", `DELETE FROM subscriber_attribute_history WHERE tenant_id = $1::uuid AND subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext)`},
		{"profile_aliases", `DELETE FROM profile_aliases WHERE tenant_id = $1::uuid AND subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext)`},
		{"subscriber_computed_traits", `DELETE FROM subscriber_computed_traits WHERE tenant_id = $1::uuid AND subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext)`},
		{"subscriber_channel_consents", `DELETE FROM subscriber_channel_consents WHERE tenant_id = $1::uuid AND subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext)`},
		{"subscriber_prediction_metadata", `DELETE FROM subscriber_prediction_metadata WHERE tenant_id = $1::uuid AND subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext)`},
		// Frequency-cap rows are enforcement history, not legal evidence. Delete
		// the requested address plus every still-attached alias while those
		// aliases remain available in this transaction.
		{"frequency_cap_events", `DELETE FROM frequency_cap_events WHERE tenant_id = $1::uuid AND lower(btrim(subscriber_email)) IN (SELECT $2 UNION SELECT lower(btrim(address.email::text)) FROM subscriber_emails AS address JOIN subscribers AS subscriber ON subscriber.tenant_id = address.tenant_id AND subscriber.id = address.subscriber_id WHERE subscriber.tenant_id = $1::uuid AND subscriber.email = $3::citext)`},
		// Queue-time send reservations and intelligent-retry rows carry the same
		// plaintext subject key. They have no independent legal-retention role;
		// the counts-only fulfillment receipt is the durable erasure evidence.
		{"subscriber_send_log", `DELETE FROM subscriber_send_log WHERE tenant_id = $1::uuid AND lower(btrim(subscriber_email::text)) IN (SELECT $2 UNION SELECT lower(btrim(address.email::text)) FROM subscriber_emails AS address JOIN subscribers AS subscriber ON subscriber.tenant_id = address.tenant_id AND subscriber.id = address.subscriber_id WHERE subscriber.tenant_id = $1::uuid AND subscriber.email = $3::citext)`},
		{"intelligent_retry_events", `DELETE FROM intelligent_retry_events WHERE tenant_id = $1::uuid AND lower(btrim(subscriber_email::text)) IN (SELECT $2 UNION SELECT lower(btrim(address.email::text)) FROM subscriber_emails AS address JOIN subscribers AS subscriber ON subscriber.tenant_id = address.tenant_id AND subscriber.id = address.subscriber_id WHERE subscriber.tenant_id = $1::uuid AND subscriber.email = $3::citext)`},
		// Not a DELETE, deliberately. `postwave_app` holds no delete privilege
		// on this table and must not: a PII finding is evidence that a tenant
		// stored personal data in the wrong field, so the tenant cannot be able
		// to erase it, and `pii_scanner` asserts exactly that. Erasure still has
		// to remove the subject's rows, so migration 1913 puts the delete behind
		// a SECURITY DEFINER function that binds its tenant argument to
		// app.tenant_id. Review receipts follow by ON DELETE CASCADE.
		{"subscriber_pii_findings", `SELECT subscriber_pii_findings_erase($1::uuid, $2::citext)`},
		{"profile_predictions", `DELETE FROM profile_predictions WHERE tenant_id = $1::uuid AND (subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext) OR lower(email::text) IN (SELECT lower(email::text) FROM subscriber_emails WHERE tenant_id = $1::uuid AND subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext)))`},
		{"profile_rfm_scores", `DELETE FROM profile_rfm_scores WHERE tenant_id = $1::uuid AND (subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext) OR lower(email::text) IN (SELECT lower(email::text) FROM subscriber_emails WHERE tenant_id = $1::uuid AND subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext)))`},
	}
	for _, deletion := range profileDeletes {
		arguments := []any{tenantID, placeholder}
		switch deletion.name {
		case "frequency_cap_events", "subscriber_send_log", "intelligent_retry_events":
			arguments = []any{tenantID, normalized, placeholder}
		}
		tag, err := tx.Exec(ctx, deletion.sql, arguments...)
		if err != nil {
			return stats, fmt.Errorf("erase %s: %w", deletion.name, err)
		}
		switch deletion.name {
		case "frequency_cap_events":
			stats.FrequencyCapEventsDeleted = tag.RowsAffected()
		case "subscriber_send_log":
			stats.SubscriberSendLogDeleted = tag.RowsAffected()
		case "intelligent_retry_events":
			stats.IntelligentRetryEventsDeleted = tag.RowsAffected()
		}
	}

	// Active send-time suppression check reads from subscriber_suppressions
	// (0081). The deletion worker writes there. The legacy `suppressions`
	// table from 0060 stays consistent via a separate UPDATE so its
	// plaintext row also gets the hash backfill — important because some
	// import paths still write there.
	tag, err = tx.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
VALUES ($1::uuid, $3::citext, $2, 'dsar_deletion', 'manual')
ON CONFLICT (tenant_id, email) DO UPDATE SET
    email_sha256 = EXCLUDED.email_sha256,
    reason = 'dsar_deletion'`,
		tenantID, hashHex, suppressionPlaceholder)
	if err != nil {
		return stats, fmt.Errorf("upsert subscriber_suppression: %w", err)
	}
	stats.SuppressionsAffected = tag.RowsAffected()

	// A multi-email profile requires one irreversible hash tombstone for every
	// address, not only the address used to submit the request. The historical
	// deterministic derivation is reproduced in PostgreSQL so existing and new
	// suppression rows converge without round-tripping plaintext into Go.
	tag, err = tx.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
SELECT $1::uuid,
       ('erased+' || substr(encode(digest($1::text || ':' || lower(address.email::text), 'sha256'), 'hex'), 1, 16) || '@erased.invalid')::citext,
       encode(digest(lower(address.email::text), 'sha256'), 'hex'),
       'dsar_deletion',
       'manual'
  FROM subscriber_emails AS address
 WHERE address.tenant_id = $1::uuid
   AND address.subscriber_id IN (
       SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $3::citext
   )
   AND lower(address.email::text) <> $2
   AND lower(address.email::text) NOT LIKE '%@erased.invalid'
ON CONFLICT (tenant_id, email) DO UPDATE SET
    email_sha256 = EXCLUDED.email_sha256,
    reason = 'dsar_deletion'`,
		tenantID, normalized, placeholder)
	if err != nil {
		return stats, fmt.Errorf("upsert secondary subscriber suppressions: %w", err)
	}
	stats.SuppressionsAffected += tag.RowsAffected()

	// Mirror stable hash tombstones into the older suppression store because
	// compatibility readers still consult it. The send gates match email_sha256,
	// so the original plaintext can then be removed from every suppression table.
	if _, err := tx.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, email_sha256, reason)
VALUES ($1::uuid, $3::citext, $2, 'dsar_deletion')
ON CONFLICT (tenant_id, email) DO UPDATE SET
    email_sha256 = EXCLUDED.email_sha256,
    reason = 'dsar_deletion'`,
		tenantID, hashHex, suppressionPlaceholder); err != nil {
		return stats, fmt.Errorf("upsert legacy suppression tombstone: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, email_sha256, reason)
SELECT $1::uuid,
       ('erased+' || substr(encode(digest($1::text || ':' || lower(address.email::text), 'sha256'), 'hex'), 1, 16) || '@erased.invalid')::citext,
       encode(digest(lower(address.email::text), 'sha256'), 'hex'),
       'dsar_deletion'
  FROM subscriber_emails AS address
 WHERE address.tenant_id = $1::uuid
   AND address.subscriber_id IN (
       SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $3::citext
   )
   AND lower(address.email::text) <> $2
   AND lower(address.email::text) NOT LIKE '%@erased.invalid'
ON CONFLICT (tenant_id, email) DO UPDATE SET
    email_sha256 = EXCLUDED.email_sha256,
    reason = 'dsar_deletion'`,
		tenantID, normalized, placeholder); err != nil {
		return stats, fmt.Errorf("upsert secondary legacy suppression tombstones: %w", err)
	}

	for _, cleanup := range []struct {
		name string
		sql  string
	}{
		{"subscriber_suppressions plaintext", `DELETE FROM subscriber_suppressions WHERE tenant_id = $1::uuid AND lower(email::text) IN (SELECT $2 UNION SELECT lower(address.email::text) FROM subscriber_emails AS address WHERE address.tenant_id = $1::uuid AND address.subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $3::citext))`},
		{"legacy suppressions plaintext", `DELETE FROM suppressions WHERE tenant_id = $1::uuid AND lower(email::text) IN (SELECT $2 UNION SELECT lower(address.email::text) FROM subscriber_emails AS address WHERE address.tenant_id = $1::uuid AND address.subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $3::citext))`},
		{"email_suppressions plaintext", `DELETE FROM email_suppressions WHERE tenant_id = $1::uuid AND lower(email::text) IN (SELECT $2 UNION SELECT lower(address.email::text) FROM subscriber_emails AS address WHERE address.tenant_id = $1::uuid AND address.subscriber_id IN (SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $3::citext))`},
	} {
		if _, err := tx.Exec(ctx, cleanup.sql, tenantID, normalized, placeholder); err != nil {
			return stats, fmt.Errorf("erase %s: %w", cleanup.name, err)
		}
	}

	// The 1766 canonical-identity trigger creates the placeholder address when
	// subscribers.email changes. Delete every older primary/secondary address
	// only after its history and suppression tombstone have been processed.
	if _, err := tx.Exec(ctx, `
DELETE FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id IN (
       SELECT id FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext
   )
   AND lower(email::text) <> lower($2)`,
		tenantID, placeholder); err != nil {
		return stats, fmt.Errorf("erase subscriber_emails: %w", err)
	}

	return stats, nil
}
