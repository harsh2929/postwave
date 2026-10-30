package subscribers

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// rejectMergeErasureTombstone blocks consolidation when either profile owns an
// address carrying an irreversible erasure tombstone. A merge is an
// identity-linking operation; allowing an erased address to be linked to a
// live profile would resurrect the very identity the tombstone exists to keep
// suppressed. The addresses are judged by the same predicate every other
// subscriber writer uses, so a hash-only privacy-request tombstone counts.
func rejectMergeErasureTombstone(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string) error {
	rows, err := tx.Query(ctx, `
SELECT email::text FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id IN ($2::uuid, $3::uuid)
UNION
SELECT email::text FROM subscribers
 WHERE tenant_id = $1::uuid AND id IN ($2::uuid, $3::uuid) AND email IS NOT NULL`,
		tenantID, primaryID, duplicateID)
	if err != nil {
		return fmt.Errorf("load merge addresses: %w", err)
	}
	addresses, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return fmt.Errorf("load merge addresses: %w", err)
	}
	return rejectErasedAddresses(ctx, tx, tenantID, addresses)
}

// reparentSubscriberSatellites moves every current profile-owned table before
// the duplicate subscriber row is removed.  Immutable address/evidence rows
// keep their exact email; only their owning subscriber UUID changes.  For
// set-like tables, exact collisions are deduplicated.  Restrictive state
// tables receive explicit most-restrictive-wins handling before that generic
// pass.
func reparentSubscriberSatellites(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID, primaryEmail, duplicateEmail, canonicalEmail string) error {
	if err := reparentSubscriberEmails(ctx, tx, tenantID, primaryID, duplicateID, primaryEmail, duplicateEmail); err != nil {
		return err
	}
	if err := mergeChannelConsents(ctx, tx, tenantID, primaryID, duplicateID, canonicalEmail); err != nil {
		return err
	}
	if err := mergePrivacyFlags(ctx, tx, tenantID, primaryID, duplicateID); err != nil {
		return err
	}
	if err := mergeReferralSatellites(ctx, tx, tenantID, primaryID, duplicateID); err != nil {
		return err
	}
	if err := copyDeleteSubscriberTagSets(ctx, tx, tenantID, primaryID, duplicateID); err != nil {
		return err
	}

	// Consent ledgers are append-only to the application role. Their exact
	// addresses and chronology remain immutable; a narrowly-scoped
	// SECURITY DEFINER primitive only redirects UUID ownership columns that
	// would otherwise be SET NULL/CASCADE by deleting the duplicate.
	if err := reparentImmutableMergeEvidence(ctx, tx, tenantID, primaryID, duplicateID); err != nil {
		return err
	}

	// Set-like satellites.  When both profiles already own the same logical
	// membership, the survivor's row is canonical and the duplicate row is
	// redundant; otherwise it is reparented.
	sets := []struct {
		table string
		keys  []string
	}{
		{"ai_profile_summary_cache", []string{"content_hash"}},
		{"archive_comment_votes", []string{"comment_id"}},
		{"consent_sync_ledger", []string{"event_type", "destination_id"}},
		{"list_subscriber_sources", []string{"list_id", "owner_key"}},
		{"list_subscribers", []string{"list_id"}},
		{"lookalike_members", []string{"model_id"}},
		{"merge_field_values", []string{"key"}},
		{"nbp_user_affinity", []string{"product_id"}},
		{"nbp_user_recent_bloom", nil},
		{"profile_object_links", []string{"object_record_id", "subscriber_email", "relationship"}},
		{"segment_static_freeze_members", []string{"freeze_id"}},
		{"segment_subscribers", []string{"segment_id"}},
		{"subscriber_computed_traits", []string{"key"}},
		{"subscriber_decision_explanations", []string{"decision_type", "target_id"}},
		{"subscriber_funnel_events", []string{"event_type", "repeat_ordinal"}},
		{"subscriber_group_memberships", []string{"group_id"}},
		{"subscriber_lifecycle", nil},
		{"subscriber_lookalike_members", []string{"audience_id"}},
		{"subscriber_pii_scan_intents", nil},
		{"subscriber_pii_scan_states", nil},
		{"subscriber_prediction_metadata", []string{"score_type"}},
		{"subscriber_predictions", nil},
		{"subscriber_send_exclusions", []string{"campaign_id"}},
		{"subscriber_tags", []string{"tag_id"}},
		{"subscription_type_opt_outs", []string{"subscription_type_id", "channel"}},
		{"sunset_executions", []string{"policy_id"}},
		{"trigger_delay_preferences", []string{"event_name"}},
		{"winback_candidate_queue", []string{"policy_id"}},
	}
	for _, set := range sets {
		if set.table == "merge_field_values" || set.table == "subscriber_pii_scan_states" || set.table == "subscriber_pii_scan_intents" ||
			set.table == "subscriber_tags" || set.table == "segment_static_freeze_members" {
			// Derived/identity-immutable state remains on the lineage tombstone;
			// fresh primary projections are produced by subscriber write triggers.
			continue
		}
		if err := reparentSet(ctx, tx, set.table, "subscriber_id", set.keys, tenantID, primaryID, duplicateID); err != nil {
			return err
		}
	}

	// The dedupe projection is regenerated by subscriber write triggers.  It is
	// derived state, so retaining the primary row and removing the duplicate row
	// is safer than moving stale duplicate hashes onto the survivor.
	if _, err := tx.Exec(ctx, `DELETE FROM subscriber_dedupe_keys WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}

	loose := []string{
		"ai_explainability_records", "archive_comments", "back_in_stock_subscriptions",
		"campaign_replies", "channel_send_history", "contact_history_events",
		"coupon_assignments", "coupon_codes", "coupon_render_reservations",
		"discount_redemptions", "erasure_receipts", "external_warehouse_trigger_fires",
		"flow_runs", "inbound_emails", "journey_attributes", "llm_action_invocations",
		"nbp_recommendation_audit", "omni_recipients", "onsite_experiment_events",
		"price_drop_watchers", "product_events", "profile_aliases", "profile_predictions",
		"profile_rfm_scores", "push_devices", "review_requests", "segment_event_queue",
		"segment_membership_log", "subscriber_anonymous_profiles",
		"subscriber_attribute_history", "subscriber_gpp_audit", "subscriber_lifecycle_events",
		"subscriber_note_attachments", "subscriber_notes", "subscriber_pii_findings",
		"support_conversations",
	}
	for _, table := range loose {
		if table == "subscriber_pii_findings" {
			// Findings and their review receipts are immutable compliance
			// evidence. The lineage edge resolves their historical subject.
			continue
		}
		if err := reparentLoose(ctx, tx, table, "subscriber_id", tenantID, primaryID, duplicateID); err != nil {
			return err
		}
	}

	// Foreign-key columns with domain-specific names.
	for _, ref := range []struct{ table, column string }{
		{"federated_subscriber_map", "child_subscriber_id"},
		{"gift_subscriptions", "gifter_subscriber_id"},
		{"gift_subscriptions", "redeemed_by_subscriber_id"},
		{"gift_attribution_events", "gifter_subscriber_id"},
		{"gift_attribution_events", "redeemed_subscriber_id"},
	} {
		if err := reparentLoose(ctx, tx, ref.table, ref.column, tenantID, primaryID, duplicateID); err != nil {
			return err
		}
	}
	return nil
}

func copyDeleteSubscriberTagSets(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string) error {
	// These two tables intentionally grant INSERT+DELETE but not UPDATE. Copy
	// with the survivor key, then delete the source row; exact collisions are
	// already represented by the survivor and are ignored.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_tags
    (tenant_id,subscriber_id,tag_id,applied_at,applied_by,source)
SELECT tenant_id,$2::uuid,tag_id,applied_at,applied_by,source
  FROM subscriber_tags
 WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid
ON CONFLICT (tenant_id,subscriber_id,tag_id) DO NOTHING`, tenantID, primaryID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return fmt.Errorf("copy subscriber tags: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM subscriber_tags WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return fmt.Errorf("delete copied subscriber tags: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO segment_static_freeze_members
    (freeze_id,tenant_id,subscriber_id,email,added_at)
SELECT freeze_id,tenant_id,$2::uuid,email,added_at
  FROM segment_static_freeze_members
 WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid
ON CONFLICT (freeze_id,subscriber_id) DO NOTHING`, tenantID, primaryID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return fmt.Errorf("copy static audience membership: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM segment_static_freeze_members WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return fmt.Errorf("delete copied static audience membership: %w", err)
	}
	return nil
}

// mergeReferralSatellites keeps earned credit and payout progress on the
// survivor. A tenant can have at most one current referral-code row per
// subscriber, so when both source profiles already own a code the duplicate
// code deliberately remains on the lineage tombstone: public code resolution
// follows merged_into_subscriber_id and both previously issued URLs remain
// valid. If the survivor has no code, the duplicate's row is moved directly.
func mergeReferralSatellites(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string) error {
	allowed, err := canReparentTable(ctx, tx, "referral_conversions", true)
	if err != nil {
		return err
	}
	if allowed {
		for _, side := range []struct{ column, other string }{
			{"referrer_subscriber_id", "referee_subscriber_id"},
			{"referee_subscriber_id", "referrer_subscriber_id"},
		} {
			deleteQ := `DELETE FROM referral_conversions d
 WHERE d.tenant_id=$1::uuid AND d.` + side.column + `=$3
   AND EXISTS (
       SELECT 1 FROM referral_conversions p
        WHERE p.tenant_id=$1::uuid AND p.` + side.column + `=$2
          AND p.` + side.other + `=d.` + side.other + `)`
			if _, err := tx.Exec(ctx, deleteQ, tenantID, primaryID, duplicateID); err != nil {
				return fmt.Errorf("deduplicate referral conversions: %w", err)
			}
			updateQ := `UPDATE referral_conversions
   SET ` + side.column + `=$2
 WHERE tenant_id=$1::uuid AND ` + side.column + `=$3`
			if _, err := tx.Exec(ctx, updateQ, tenantID, primaryID, duplicateID); err != nil {
				return fmt.Errorf("reparent referral conversions: %w", err)
			}
		}
	}

	allowed, err = canReparentTable(ctx, tx, "referral_payouts", true)
	if err != nil {
		return err
	}
	if allowed {
		if _, err := tx.Exec(ctx, `
UPDATE referral_payouts p
   SET status=CASE
         WHEN p.status='paid' OR d.status='paid' THEN 'paid'
         WHEN p.status='approved' OR d.status='approved' THEN 'approved'
         ELSE 'pending' END,
       reward_label=CASE WHEN p.reward_label='' THEN d.reward_label ELSE p.reward_label END,
       updated_at=clock_timestamp()
  FROM referral_payouts d
 WHERE p.tenant_id=$1::uuid AND p.referrer_subscriber_id=$2
   AND d.tenant_id=$1::uuid AND d.referrer_subscriber_id=$3
   AND p.milestone_count=d.milestone_count`, tenantID, primaryID, duplicateID); err != nil {
			return fmt.Errorf("merge referral payouts: %w", err)
		}
		if _, err := tx.Exec(ctx, `
DELETE FROM referral_payouts d
 WHERE d.tenant_id=$1::uuid AND d.referrer_subscriber_id=$3
   AND EXISTS (
       SELECT 1 FROM referral_payouts p
        WHERE p.tenant_id=$1::uuid AND p.referrer_subscriber_id=$2
          AND p.milestone_count=d.milestone_count)`, tenantID, primaryID, duplicateID); err != nil {
			return fmt.Errorf("deduplicate referral payouts: %w", err)
		}
		if _, err := tx.Exec(ctx, `
UPDATE referral_payouts SET referrer_subscriber_id=$2, updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND referrer_subscriber_id=$3`, tenantID, primaryID, duplicateID); err != nil {
			return fmt.Errorf("reparent referral payouts: %w", err)
		}
	}

	allowed, err = canReparentTable(ctx, tx, "referral_codes", false)
	if err != nil {
		return err
	}
	if allowed {
		if _, err := tx.Exec(ctx, `
UPDATE referral_codes d SET subscriber_id=$2
 WHERE d.tenant_id=$1::uuid AND d.subscriber_id=$3
   AND NOT EXISTS (
       SELECT 1 FROM referral_codes p
        WHERE p.tenant_id=$1::uuid AND p.subscriber_id=$2)`, tenantID, primaryID, duplicateID); err != nil {
			return fmt.Errorf("reparent referral code: %w", err)
		}
	}
	return nil
}

func reparentImmutableMergeEvidence(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string) error {
	var installed bool
	if err := tx.QueryRow(ctx, `SELECT to_regprocedure('public.subscriber_merge_reparent_evidence(uuid,uuid,uuid)') IS NOT NULL`).Scan(&installed); err != nil {
		return err
	}
	if installed {
		_, err := tx.Exec(ctx, `SELECT public.subscriber_merge_reparent_evidence($1::uuid,$2::uuid,$3::uuid)`, tenantID, primaryID, duplicateID)
		if sqlStateIs(err, "PWE01") {
			return ErrErasureBlocked
		}
		return err
	}
	// Deployments preceding migration 1769 may still merge profiles that have
	// no cascade-owned import receipts. Other evidence tables use SET NULL/no
	// FK and therefore remain immutable and intact.
	var cascadeEvidence bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM subscriber_import_consent_receipts WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid)`, tenantID, duplicateID).Scan(&cascadeEvidence); err != nil {
		if isUndefinedSchemaObject(err) {
			return nil
		}
		return err
	}
	if cascadeEvidence {
		return errors.New("subscriber merge evidence reparenting is unavailable; refusing to cascade immutable import receipts")
	}
	return nil
}

func reparentSubscriberEmails(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID, primaryEmail, duplicateEmail string) error {
	// Legacy rows may predate the address junction.  Create a fail-closed
	// address record rather than allowing a canonical identity to disappear.
	for _, item := range []struct{ id, email string }{{primaryID, primaryEmail}, {duplicateID, duplicateEmail}} {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails (tenant_id,subscriber_id,email,is_primary,consent_status)
VALUES ($1::uuid,$2::uuid,$3,true,'never_subscribed')
ON CONFLICT (tenant_id, lower(email::text)) DO NOTHING`, tenantID, item.id, item.email); err != nil && !isUndefinedSchemaObject(err) {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails SET is_primary=false
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}
	// Immutable consent evidence remains attached to the duplicate lineage
	// tombstone. Once an address changes owner, an old positive projection is
	// therefore no longer exact evidence for the survivor and must fail closed.
	// Restrictive states remain restrictive, but every moved address receives a
	// fresh classification checksum bound to its new owner.
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET subscriber_id=$2::uuid,
       consent_status=CASE
         WHEN consent_status='subscribed' THEN 'never_subscribed'
         ELSE consent_status
       END,
       consent_reconciliation_state='failed_closed',
       consent_reconciliation_generation=consent_reconciliation_generation+1,
       consent_decision_checksum=encode(digest(concat_ws(
         ':',
         'subscriber-email-consent-decision/v2',
         tenant_id::text,
         $2::uuid::text,
         id::text,
         subscriber_email_consent_normalize_email(email::text),
         'merge_reparent_without_exact_terminal_grant',
         (consent_reconciliation_generation+1)::text
       ), 'sha256'), 'hex'),
       consent_classified_at=clock_timestamp(),
       consent_terminal_occurred_at=NULL,
       consent_terminal_recorded_at=NULL,
       consent_proof_expires_at=NULL
 WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid`, tenantID, primaryID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}
	return nil
}

func setMergedPrimaryAddress(ctx context.Context, tx pgx.Tx, tenantID, primaryID, email string) error {
	// The partial unique index on (tenant_id, subscriber_id) WHERE is_primary
	// is immediate. A single CASE update can visit the new primary before the
	// old one and fail nondeterministically with 23505, so rotate in two phases.
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
	SET is_primary=false
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND is_primary`, tenantID, primaryID); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET is_primary=true
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid
   AND lower(email::text)=lower($3)`, tenantID, primaryID, email); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}
	return nil
}

func mergeChannelConsents(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID, primaryEmail string) error {
	// opted_out > unknown > opted_in.  When the duplicate is stricter, carry
	// its evidence fields; caps use the later boundary because that withholds
	// delivery for longer.
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_channel_consents p
   SET status=CASE
         WHEN d.status='opted_out' OR p.status='opted_out' THEN 'opted_out'
         WHEN d.status='unknown' OR p.status='unknown' THEN 'unknown'
         ELSE p.status END,
       consent_timestamp=CASE
         WHEN d.status='opted_out' AND p.status<>'opted_out' THEN d.consent_timestamp
         ELSE p.consent_timestamp END,
       consent_source=CASE
         WHEN d.status='opted_out' AND p.status<>'opted_out' THEN d.consent_source
         ELSE p.consent_source END,
       frequency_cap_until=CASE
         WHEN p.frequency_cap_until IS NULL THEN d.frequency_cap_until
         WHEN d.frequency_cap_until IS NULL THEN p.frequency_cap_until
         ELSE GREATEST(p.frequency_cap_until,d.frequency_cap_until) END,
       email=CASE WHEN p.channel='email' THEN $4 ELSE p.email END,
       updated_at=clock_timestamp()
  FROM subscriber_channel_consents d
 WHERE p.tenant_id=$1::uuid AND p.subscriber_id=$2::uuid
   AND d.tenant_id=$1::uuid AND d.subscriber_id=$3::uuid
   AND d.channel=p.channel`, tenantID, primaryID, duplicateID, primaryEmail); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}
	if err := reparentSet(ctx, tx, "subscriber_channel_consents", "subscriber_id", []string{"channel"}, tenantID, primaryID, duplicateID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE subscriber_channel_consents SET email=$3 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND channel='email'`, tenantID, primaryID, primaryEmail); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}
	return nil
}

func mergePrivacyFlags(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string) error {
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_privacy_flags p
   SET gpc_signaled=(p.gpc_signaled OR d.gpc_signaled),
       do_not_sell=(p.do_not_sell OR d.do_not_sell),
       marketing_consent_status=CASE
         WHEN p.marketing_consent_status IN ('denied','opted_out','withdrawn') THEN p.marketing_consent_status
         WHEN d.marketing_consent_status IN ('denied','opted_out','withdrawn') THEN d.marketing_consent_status
         WHEN p.marketing_consent_status='unknown' OR d.marketing_consent_status='unknown' THEN 'unknown'
         ELSE p.marketing_consent_status END,
       last_updated=clock_timestamp()
  FROM subscriber_privacy_flags d
 WHERE p.tenant_id=$1::uuid AND p.subscriber_id=$2::uuid
   AND d.tenant_id=$1::uuid AND d.subscriber_id=$3::uuid`, tenantID, primaryID, duplicateID); err != nil && !isUndefinedSchemaObject(err) {
		return err
	}
	return reparentSet(ctx, tx, "subscriber_privacy_flags", "subscriber_id", nil, tenantID, primaryID, duplicateID)
}

func reparentLoose(ctx context.Context, tx pgx.Tx, table, column, tenantID, primaryID, duplicateID string) error {
	allowed, err := canReparentTable(ctx, tx, table, false)
	if err != nil || !allowed {
		return err
	}
	query := `UPDATE ` + table + ` SET ` + column + `=$2::uuid WHERE tenant_id=$1::uuid AND ` + column + `=$3::uuid`
	if _, err := tx.Exec(ctx, query, tenantID, primaryID, duplicateID); err != nil {
		if isUndefinedSchemaObject(err) {
			return nil
		}
		return fmt.Errorf("reparent %s.%s: %w", table, column, err)
	}
	return nil
}

func reparentSet(ctx context.Context, tx pgx.Tx, table, column string, keys []string, tenantID, primaryID, duplicateID string) error {
	allowed, err := canReparentTable(ctx, tx, table, true)
	if err != nil || !allowed {
		return err
	}
	var equal strings.Builder
	for _, key := range keys {
		equal.WriteString(` AND p.` + key + ` IS NOT DISTINCT FROM d.` + key)
	}
	deleteQ := `DELETE FROM ` + table + ` d WHERE d.tenant_id=$1::uuid AND d.` + column + `=$3::uuid
AND EXISTS (SELECT 1 FROM ` + table + ` p WHERE p.tenant_id=$1::uuid AND p.` + column + `=$2::uuid` + equal.String() + `)`
	if _, err := tx.Exec(ctx, deleteQ, tenantID, primaryID, duplicateID); err != nil {
		if isUndefinedSchemaObject(err) {
			return nil
		}
		return fmt.Errorf("deduplicate %s.%s: %w", table, column, err)
	}
	return reparentLoose(ctx, tx, table, column, tenantID, primaryID, duplicateID)
}

func canReparentTable(ctx context.Context, tx pgx.Tx, table string, needsDelete bool) (bool, error) {
	var exists, canUpdate, canDelete bool
	if err := tx.QueryRow(ctx, `
SELECT to_regclass('public.' || $1) IS NOT NULL,
       has_table_privilege(current_user, 'public.' || $1, 'UPDATE'),
       has_table_privilege(current_user, 'public.' || $1, 'DELETE')`, table).Scan(&exists, &canUpdate, &canDelete); err != nil {
		return false, err
	}
	return exists && canUpdate && (!needsDelete || canDelete), nil
}

// assertNoSubscriberFKChildren is the anti-data-loss backstop.  A future
// migration that adds a subscriber-owned table cannot be silently cascaded by
// merge: if its rows were not handled above, the entire transaction fails.
func assertNoSubscriberFKChildren(ctx context.Context, tx pgx.Tx, duplicateID string) error {
	rows, err := tx.Query(ctx, `
SELECT n.nspname, c.relname, a.attname
  FROM pg_constraint f
  JOIN pg_class c ON c.oid=f.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN unnest(f.conkey) WITH ORDINALITY k(attnum,ord) ON true
  JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.attnum
 WHERE f.contype='f' AND f.confrelid='subscribers'::regclass
   AND a.attname<>'tenant_id'
	   AND c.relname NOT IN ('consent_records','subscriber_import_consent_receipts')
 ORDER BY n.nspname,c.relname,a.attname`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type ref struct{ schema, table, column string }
	refs := []ref{}
	for rows.Next() {
		var item ref
		if err := rows.Scan(&item.schema, &item.table, &item.column); err != nil {
			return err
		}
		refs = append(refs, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range refs {
		var exists bool
		query := fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s.%s WHERE %s=$1::uuid)`, quoteIdent(item.schema), quoteIdent(item.table), quoteIdent(item.column))
		if err := tx.QueryRow(ctx, query, duplicateID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return fmt.Errorf("subscriber merge refused to cascade unhandled rows in %s.%s", item.schema, item.table)
		}
	}
	return nil
}

func quoteIdent(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }

func isUndefinedSchemaObject(err error) bool {
	type sqlState interface{ SQLState() string }
	var state sqlState
	if !errors.As(err, &state) {
		return false
	}
	return state.SQLState() == "42P01" || state.SQLState() == "42703"
}

func sqlStateIs(err error, code string) bool {
	type sqlState interface{ SQLState() string }
	var state sqlState
	return errors.As(err, &state) && state.SQLState() == code
}
