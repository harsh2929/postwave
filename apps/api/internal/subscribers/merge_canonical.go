package subscribers

// This file owns the destructive half of subscriber consolidation.  Both the
// public merge endpoint and Identify's collision path call the same primitive
// so they cannot drift on locking, consent precedence, child-row preservation,
// engine reconciliation, audit durability, or webhook semantics.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pushauthoritylock"
	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
)

var (
	// ErrMergePreconditionRequired means a destructive merge was requested
	// without exact revisions for both rows.  HTTP callers map this to 428.
	ErrMergePreconditionRequired = errors.New("subscriber merge requires exact primary and duplicate revisions")
	// ErrMergeConflict protects relationships that cannot be combined without a
	// human decision (today: two different first-class accounts).
	ErrMergeConflict = errors.New("subscriber merge has conflicting protected relationships")
)

type canonicalMergeOptions struct {
	PrimaryVersion   string
	DuplicateVersion string
	CanonicalEmail   string
	ExternalID       string
	ProfileID        string
	Traits           map[string]any
	Signals          []MergeSignal
	AuditMeta        db.AuditMeta
	AuditReason      string
	Bulk             bool
}

type canonicalMergeOutcome struct {
	Subscriber         *Subscriber
	EventsMoved        int64
	SuppressionsKept   int64
	SignalsRecorded    int
	TagsMerged         int
	CustomFieldsMerged int
}

// mergeCanonicalInTx consolidates duplicateID into primaryID in the caller's
// tenant transaction. It deliberately does not commit. Canonical identity and
// then the tenant's push-eligibility writer lease are acquired before the two
// subscriber rows; those rows are then locked in UUID order and their
// caller-observed revisions are checked before any mutation occurs.
func (r *Repo) mergeCanonicalInTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, primaryID, duplicateID string,
	opts canonicalMergeOptions,
) (*canonicalMergeOutcome, error) {
	if missingMergeVersion(opts.PrimaryVersion) || missingMergeVersion(opts.DuplicateVersion) {
		return nil, ErrMergePreconditionRequired
	}
	if err := pushauthoritylock.EnsureMutationAllowed(ctx); err != nil {
		return nil, err
	}
	// Identify may already hold canonical identity before it discovers that two
	// profiles must merge. Keep that global order here as identity -> push ->
	// subscriber rows so the public merge path cannot invert the two tenant
	// advisory locks against Identify.
	if err := subscriberidentitylock.Tenant(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	// Subscriber merge reparents push_devices. Acquire the Route43 tenant
	// writer lease before locking either subscriber row so a concurrent device
	// upsert cannot hold the lease while waiting on this transaction's FK key
	// lock. Every later push_devices statement re-enters the same lease through
	// migration 1996's trigger.
	if err := pushauthoritylock.Exclusive(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	primary, duplicate, err := loadMergeSubscribersForUpdate(ctx, tx, tenantID, primaryID, duplicateID)
	if err != nil {
		return nil, err
	}
	if primary.Version != opts.PrimaryVersion || duplicate.Version != opts.DuplicateVersion {
		return nil, ErrPreconditionFailed
	}
	if primary.AccountID != nil && duplicate.AccountID != nil && *primary.AccountID != *duplicate.AccountID {
		return nil, ErrMergeConflict
	}
	var alreadyMerged bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscribers
     WHERE tenant_id=$1::uuid AND id IN ($2::uuid,$3::uuid)
       AND NULLIF(to_jsonb(subscribers)->>'merged_into_subscriber_id','') IS NOT NULL
)`, tenantID, primary.ID, duplicate.ID).Scan(&alreadyMerged); err != nil {
		return nil, err
	}
	if alreadyMerged {
		return nil, ErrMergeConflict
	}

	canonicalEmail := strings.TrimSpace(opts.CanonicalEmail)
	if canonicalEmail == "" {
		canonicalEmail = primary.Email
	}
	if !strings.EqualFold(canonicalEmail, primary.Email) && !strings.EqualFold(canonicalEmail, duplicate.Email) {
		return nil, fmt.Errorf("canonical merge email must belong to one of the locked profiles")
	}
	if err := rejectMergeErasureTombstone(ctx, tx, tenantID, primary.ID, duplicate.ID); err != nil {
		return nil, err
	}

	mergedTags := unionStrings(primary.Tags, duplicate.Tags)
	mergedCF := mergeMaps(primary.CustomFields, duplicate.CustomFields)
	mergedCF = mergeMaps(mergedCF, nonNilMap(opts.Traits))
	mergedMF := mergeMaps(primary.MergeFields, duplicate.MergeFields)
	mergedGroups := unionObjectSlices(primary.Groups, duplicate.Groups)
	mergedGDPR := unionGDPRPermissions(primary.GDPRPermissions, duplicate.GDPRPermissions)
	mergedNames := deriveNames(CreateInput{MergeFields: mergedMF, CustomFields: mergedCF})
	mergedStatus := strictestStatus(primary.Status, duplicate.Status)
	mergedMailchimpStatus := strictestMailchimpStatus(primary.MailchimpStatus, duplicate.MailchimpStatus, mergedStatus)
	mergedConsent := earliestConsent(primary.ConsentTimestamp, duplicate.ConsentTimestamp)
	mergedArchivedAt := earliestConsent(primary.ArchivedAt, duplicate.ArchivedAt)

	cfRaw, _ := json.Marshal(mergedCF)
	mfRaw, _ := json.Marshal(mergedMF)
	groupsRaw, _ := json.Marshal(mergedGroups)
	gdprRaw, _ := json.Marshal(mergedGDPR)

	// Preserve every source identifier that cannot remain on the survivor's
	// single canonical columns. Explicit merge may consolidate aliases owned by
	// these two rows, but it must never steal an alias from an unrelated third
	// profile.
	for _, alias := range []struct {
		kind, value, sourceID string
	}{
		{"email", primary.Email, primary.ID},
		{"email", duplicate.Email, duplicate.ID},
		{"external_id", derefOrEmpty(primary.ExternalID), primary.ID},
		{"external_id", derefOrEmpty(duplicate.ExternalID), duplicate.ID},
		{"phone", mergePhoneAlias(primary.CustomFields), primary.ID},
		{"phone", mergePhoneAlias(duplicate.CustomFields), duplicate.ID},
	} {
		if err := claimMergeAlias(ctx, tx, tenantID, primary.ID, duplicate.ID, alias.kind, alias.value, alias.sourceID); err != nil {
			return nil, err
		}
	}

	var eventsMoved int64
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_events
 WHERE tenant_id=$1::uuid AND lower(subscriber_email)=lower($2)`, tenantID, duplicate.Email).Scan(&eventsMoved); err != nil && !isUndefinedTable(err) {
		return nil, err
	}
	var suppressionsKept int64
	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM suppressions WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)) +
  (SELECT count(*) FROM email_suppressions WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)) +
  (SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2))`,
		tenantID, duplicate.Email).Scan(&suppressionsKept); err != nil && !isUndefinedTable(err) {
		return nil, err
	}

	// Address/evidence rows retain their exact address.  ID-keyed satellites are
	// reparented; email-keyed operational state is canonicalised separately.
	if err := reparentSubscriberSatellites(ctx, tx, tenantID, primary.ID, duplicate.ID, primary.Email, duplicate.Email, canonicalEmail); err != nil {
		return nil, err
	}
	// CanonicalEmail may deliberately select the duplicate profile's address
	// (Identify does this when its input email belongs to the lower-precedence
	// match). Repoint every distinct losing source, including the survivor's
	// former address; moving only duplicate.Email orphans the primary's send-cap
	// and retry history in that case.
	seenSourceEmails := map[string]struct{}{}
	for _, sourceEmail := range []string{primary.Email, duplicate.Email} {
		normalizedSource := strings.ToLower(strings.TrimSpace(sourceEmail))
		if normalizedSource == "" || strings.EqualFold(sourceEmail, canonicalEmail) {
			continue
		}
		if _, seen := seenSourceEmails[normalizedSource]; seen {
			continue
		}
		seenSourceEmails[normalizedSource] = struct{}{}
		if err := repointSubscriberEmailForPurpose(
			ctx, tx, tenantID, sourceEmail, canonicalEmail,
			projectionMutationSubscriberMerge,
		); err != nil {
			return nil, err
		}
	}

	newExternalID := derefOrEmpty(primary.ExternalID)
	if strings.TrimSpace(opts.ExternalID) != "" {
		newExternalID = strings.TrimSpace(opts.ExternalID)
	}
	newProfileID := primary.ProfileID
	if strings.TrimSpace(opts.ProfileID) != "" {
		newProfileID = strings.TrimSpace(opts.ProfileID)
	}
	accountID := primary.AccountID
	if accountID == nil {
		accountID = duplicate.AccountID
	}
	unsubReason := primary.UnsubscribeReason
	if strings.TrimSpace(unsubReason) == "" {
		unsubReason = duplicate.UnsubscribeReason
	}

	// A purpose grant is retained only when both source profiles carried it.
	// Consent evidence remains in its immutable ledgers; the aggregate vector
	// must never become more permissive as a side effect of deduplication.
	intersection := func(a, b *time.Time) *time.Time {
		if a == nil || b == nil {
			return nil
		}
		return earliestConsent(a, b)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET tags=$3::text[], custom_fields=$4::jsonb, merge_fields=$5::jsonb,
       groups=$6::jsonb, gdpr_permissions=$7::jsonb,
       status=$8, mailchimp_status=$9, consent_timestamp=$10,
       external_id=NULLIF($11,''), profile_id=NULLIF($12,'')::uuid,
       account_id=$13::uuid, first_name=$14, last_name=$15,
       full_name=$16, display_name=$17, unsubscribe_reason=$18,
       archived_at=$19,
       consent_email_marketing_at=$20, consent_sms_marketing_at=$21,
       consent_profiling_at=$22, consent_targeted_ads_at=$23,
       consent_ai_processing_at=$24,
       jurisdiction_reconfirm_required=(jurisdiction_reconfirm_required OR $25),
       paused_until=CASE
         WHEN paused_until IS NULL THEN $26
         WHEN $26::timestamptz IS NULL THEN paused_until
         ELSE GREATEST(paused_until,$26::timestamptz)
       END,
       updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
		tenantID, primary.ID, mergedTags, string(cfRaw), string(mfRaw), string(groupsRaw), string(gdprRaw),
		mergedStatus, mergedMailchimpStatus, mergedConsent, newExternalID, newProfileID, accountID,
		mergedNames.first, mergedNames.last, mergedNames.full, mergedNames.display, unsubReason,
		mergedArchivedAt,
		intersection(primary.ConsentEmailMarketingAt, duplicate.ConsentEmailMarketingAt),
		intersection(primary.ConsentSMSMarketingAt, duplicate.ConsentSMSMarketingAt),
		intersection(primary.ConsentProfilingAt, duplicate.ConsentProfilingAt),
		intersection(primary.ConsentTargetedAdsAt, duplicate.ConsentTargetedAdsAt),
		intersection(primary.ConsentAIProcessingAt, duplicate.ConsentAIProcessingAt),
		duplicate.JurisdictionReconfirmRequired, duplicate.PausedUntil); err != nil {
		return nil, err
	}

	lineageSupported, err := mergeLineageColumnsInstalled(ctx, tx)
	if err != nil {
		return nil, err
	}
	if !lineageSupported {
		if err := assertNoSubscriberFKChildren(ctx, tx, duplicate.ID); err != nil {
			return nil, err
		}
	}
	if err := tombstoneMergedDuplicate(ctx, tx, tenantID, primary.ID, duplicate.ID); err != nil {
		return nil, err
	}
	if !strings.EqualFold(primary.Email, canonicalEmail) {
		if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET email=$3, primary_email=$3, updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, primary.ID, canonicalEmail); err != nil {
			return nil, err
		}
	}
	if err := setMergedPrimaryAddress(ctx, tx, tenantID, primary.ID, canonicalEmail); err != nil {
		return nil, err
	}

	signalsRecorded, err := recordMergeSignals(ctx, tx, tenantID, primary.ID, duplicate.ID, opts.Signals)
	if err != nil {
		return nil, err
	}
	sub, err := scanSubscriber(tx.QueryRow(ctx, subscriberSelectSQL+`
WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, primary.ID))
	if err != nil {
		return nil, err
	}

	opts.AuditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, opts.AuditMeta, "subscriber.merged", "subscriber", primary.ID, map[string]any{
		"primary_id": primary.ID, "duplicate_id": duplicate.ID,
		"events_moved": eventsMoved, "suppressions_preserved": suppressionsKept,
		"tags_merged": len(mergedTags), "custom_fields_merged": len(mergedCF),
		"signals_recorded": signalsRecorded, "reason": opts.AuditReason,
		"primary_version_before":   opts.PrimaryVersion,
		"duplicate_version_before": opts.DuplicateVersion,
		"primary_version_after":    sub.Version,
		"bulk":                     opts.Bulk,
	}); err != nil {
		return nil, fmt.Errorf("audit subscriber merge: %w", err)
	}
	if err := r.appendEngineMergeSync(ctx, tx, tenantID, sub.ID, primary.Email, duplicate.Email,
		listmonkIDFromCustomFields(duplicate.CustomFields)); err != nil {
		return nil, err
	}
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID: tenantID, EventType: EventSubscriberMerged, Body: sub,
			IdempotencyKey: "subscriber-merge:" + primary.ID + ":" + sub.Version,
		}); err != nil {
			return nil, fmt.Errorf("dispatch merged webhook: %w", err)
		}
	}
	return &canonicalMergeOutcome{
		Subscriber: sub, EventsMoved: eventsMoved, SuppressionsKept: suppressionsKept,
		SignalsRecorded: signalsRecorded, TagsMerged: len(mergedTags), CustomFieldsMerged: len(mergedCF),
	}, nil
}

func tombstoneMergedDuplicate(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string) error {
	lineageColumns, err := mergeLineageColumnsInstalled(ctx, tx)
	if err != nil {
		return err
	}
	if !lineageColumns {
		_, err := tx.Exec(ctx, `DELETE FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, duplicateID)
		return err
	}
	syntheticEmail := "merged-" + duplicateID + "@no-email.invalid"
	_, err = tx.Exec(ctx, `
UPDATE subscribers
   SET email=$4, primary_email=$4, status='blocklisted',
       mailchimp_status='unsubscribed', consent_timestamp=NULL,
       consent_source='unknown', external_id=NULL, profile_id=gen_random_uuid(),
       account_id=NULL, custom_fields='{}'::jsonb, merge_fields='{}'::jsonb,
       tags=ARRAY[]::text[], groups='[]'::jsonb, gdpr_permissions='[]'::jsonb,
       first_name='', last_name='', full_name='', display_name='',
       signup_ip=NULL, unsubscribe_reason=NULL, activity_summary='{}'::jsonb,
       source_id=NULL, source_platform=NULL, mailchimp_last_changed=NULL,
       engagement_score=NULL, engagement_score_at=NULL,
       best_send_hour=NULL, best_send_hour_at=NULL, timezone=NULL,
       churn_score=NULL, churn_score_at=NULL, rating=NULL,
       phone_e164=NULL, locale=NULL, language=NULL, country=NULL, region=NULL,
       detected_jurisdiction=NULL, jurisdiction_changed_at=NULL,
       jurisdiction_reconfirm_required=false, gpp_sections='{}'::jsonb,
       consent_email_marketing_at=NULL, consent_sms_marketing_at=NULL,
       consent_profiling_at=NULL, consent_targeted_ads_at=NULL,
       consent_ai_processing_at=NULL, frequency_preference='paused', paused_until=NULL,
       archived_at=COALESCE(archived_at,clock_timestamp()),
       merged_into_subscriber_id=$2::uuid, merged_at=clock_timestamp(),
       updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$3::uuid`, tenantID, primaryID, duplicateID, syntheticEmail)
	return err
}

func claimMergeAlias(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID, aliasType, value, sourceID string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	tag, err := tx.Exec(ctx, `
INSERT INTO profile_aliases
    (tenant_id, subscriber_id, alias_type, alias_value, confidence, source, provenance)
VALUES ($1::uuid, $2::uuid, $4, $5, 1.0, 'merge',
        jsonb_build_object('merged_from_subscriber_id', $6::text))
ON CONFLICT (tenant_id, alias_type, lower(alias_value)) DO UPDATE
   SET subscriber_id = EXCLUDED.subscriber_id,
       confidence = GREATEST(profile_aliases.confidence, EXCLUDED.confidence),
       source = 'merge',
       provenance = profile_aliases.provenance || EXCLUDED.provenance,
       updated_at = clock_timestamp()
 WHERE profile_aliases.subscriber_id IN ($2::uuid,$3::uuid)`,
		tenantID, primaryID, duplicateID, aliasType, value, sourceID)
	if err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("%w: %s alias is owned by another subscriber", ErrMergeConflict, aliasType)
	}
	return nil
}

func mergePhoneAlias(customFields map[string]any) string {
	raw, _ := customFields["phone"].(string)
	normalized, err := normalizeE164(raw)
	if err != nil {
		return ""
	}
	return normalized
}

func mergeLineageColumnsInstalled(ctx context.Context, tx pgx.Tx) (bool, error) {
	var installed bool
	if err := tx.QueryRow(ctx, `
SELECT count(*)=2
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='subscribers'
	   AND column_name IN ('merged_into_subscriber_id','merged_at')`).Scan(&installed); err != nil {
		return false, err
	}
	return installed, nil
}

func loadMergeSubscribersForUpdate(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string) (*Subscriber, *Subscriber, error) {
	ids := []string{primaryID, duplicateID}
	sort.Strings(ids)
	rows, err := tx.Query(ctx, subscriberSelectSQL+`
WHERE tenant_id=$1::uuid AND id IN ($2::uuid,$3::uuid)
ORDER BY id
FOR UPDATE`, tenantID, ids[0], ids[1])
	if err != nil {
		return nil, nil, err
	}
	items, err := scanSubscribers(rows)
	if err != nil {
		return nil, nil, err
	}
	if len(items) != 2 {
		return nil, nil, ErrNotFound
	}
	var primary, duplicate *Subscriber
	for i := range items {
		item := items[i]
		switch item.ID {
		case primaryID:
			primary = &item
		case duplicateID:
			duplicate = &item
		}
	}
	if primary == nil || duplicate == nil {
		return nil, nil, ErrNotFound
	}
	return primary, duplicate, nil
}

func unionObjectSlices(a, b []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(a)+len(b))
	seen := map[string]struct{}{}
	for _, values := range [][]map[string]any{a, b} {
		for _, value := range values {
			raw, _ := json.Marshal(value)
			key := string(raw)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, value)
		}
	}
	return out
}

func strictestMailchimpStatus(a, b, mergedStatus string) string {
	rank := func(s string) int {
		switch s {
		case "cleaned":
			return 5
		case "unsubscribed":
			return 4
		case "pending":
			return 3
		case "non_subscribed":
			return 2
		case "subscribed":
			return 1
		default:
			return 0
		}
	}
	selected := a
	if rank(b) > rank(a) {
		selected = b
	}
	if rank(selected) == 0 {
		selected = mailchimpStatusFromListmonk(mergedStatus)
	}
	if mergedStatus != StatusEnabled && selected == "subscribed" {
		selected = mailchimpStatusFromListmonk(mergedStatus)
	}
	return selected
}
