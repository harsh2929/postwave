// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
)

func submittedSubscriberUpdateFields(in UpdateInput) []string {
	fields := make([]string, 0, 32)
	add := func(present bool, name string) {
		if present {
			fields = append(fields, name)
		}
	}
	add(in.Email != nil, "email")
	add(in.Status != nil, "status")
	add(in.MailchimpStatus != nil, "mailchimp_status")
	add(in.ConsentTimestamp != nil, "consent_timestamp")
	add(in.ConsentSource != nil, "consent_source")
	add(in.ConsentChannel != "", "consent_channel")
	add(in.ConsentLegalBasis != "", "consent_legal_basis")
	add(in.ConsentJurisdiction != "", "consent_jurisdiction")
	add(in.ConsentEvidence != "", "consent_evidence")
	add(in.ConsentReason != "", "consent_reason")
	add(in.ConsentPolicyVersion != "", "consent_policy_version")
	add(in.CustomFields != nil, "custom_fields")
	add(in.MergeFields != nil, "merge_fields")
	add(in.Tags != nil, "tags")
	add(in.Groups != nil, "groups")
	add(in.GDPRPermissions != nil, "gdpr_permissions")
	add(in.SignupIP != nil, "signup_ip")
	add(in.UnsubscribeReason != nil, "unsubscribe_reason")
	add(in.MailchimpLastChanged != nil, "mailchimp_last_changed")
	add(in.ActivitySummary != nil, "activity_summary")
	add(in.SourceID != nil, "source_id")
	add(in.SourcePlatform != nil, "source_platform")
	add(in.FirstName != nil, "first_name")
	add(in.LastName != nil, "last_name")
	add(in.FullName != nil, "full_name")
	add(in.DisplayName != nil, "display_name")
	add(in.Locale != nil, "locale")
	add(in.Language != nil, "language")
	add(in.Country != nil, "country")
	add(in.Region != nil, "region")
	add(in.DataRegion != nil, "data_region")
	add(in.GppSections != nil, "gpp_sections")
	add(in.PredictionModelVersion != nil, "prediction_model_version")
	add(in.PredictionConfidence != nil, "prediction_confidence")
	add(in.PredictionScoreType != "", "prediction_score_type")
	add(in.FrequencyPreference != nil, "frequency_preference")
	add(in.PausedUntil != nil || in.ClearPausedUntil || in.PauseDays > 0, "paused_until")
	return fields
}

func normalizeSubscriberUpdateConsentIntent(in *UpdateInput) (*ConsentProvenanceInput, bool, error) {
	if in == nil {
		return nil, false, fmt.Errorf("%w: request is required", ErrInvalidInput)
	}
	in.ConsentChannel = strings.ToLower(strings.TrimSpace(in.ConsentChannel))
	in.ConsentLegalBasis = strings.ToLower(strings.TrimSpace(in.ConsentLegalBasis))
	in.ConsentJurisdiction = strings.ToUpper(strings.TrimSpace(in.ConsentJurisdiction))
	in.ConsentEvidence = strings.TrimSpace(in.ConsentEvidence)
	in.ConsentReason = strings.TrimSpace(in.ConsentReason)
	in.ConsentPolicyVersion = strings.TrimSpace(in.ConsentPolicyVersion)
	hasClaim := in.ConsentTimestamp != nil || in.ConsentSource != nil ||
		in.ConsentChannel != "" || in.ConsentLegalBasis != "" ||
		in.ConsentJurisdiction != "" || in.ConsentEvidence != "" ||
		in.ConsentReason != "" || in.ConsentPolicyVersion != ""
	grantIntent := in.Status != nil && *in.Status == StatusEnabled
	if !grantIntent {
		if hasClaim {
			return nil, false, fmt.Errorf("%w: consent evidence is accepted only with an explicit status=enabled transition", ErrInvalidInput)
		}
		return nil, false, nil
	}
	if in.ConsentSource == nil || in.ConsentTimestamp == nil {
		return nil, false, fmt.Errorf("%w: status=enabled requires consent_source and consent_timestamp", ErrInvalidInput)
	}
	source := strings.ToLower(strings.TrimSpace(*in.ConsentSource))
	if source != ConsentDoubleOptIn && source != ConsentSingleOptIn {
		return nil, false, fmt.Errorf("%w: status=enabled requires double_optin or single_optin consent_source", ErrInvalidInput)
	}
	provenance := ConsentProvenanceInput{
		Source:        source,
		Channel:       in.ConsentChannel,
		LegalBasis:    in.ConsentLegalBasis,
		OccurredAt:    in.ConsentTimestamp,
		Jurisdiction:  in.ConsentJurisdiction,
		Evidence:      in.ConsentEvidence,
		Reason:        in.ConsentReason,
		PolicyVersion: in.ConsentPolicyVersion,
	}
	if err := normalizeConsentProvenance(&provenance, true); err != nil {
		return nil, false, fmt.Errorf("%w: %s", ErrInvalidInput, err.Error())
	}
	in.ConsentSource = &provenance.Source
	in.ConsentTimestamp = provenance.OccurredAt
	in.ConsentChannel = provenance.Channel
	in.ConsentLegalBasis = provenance.LegalBasis
	in.ConsentJurisdiction = provenance.Jurisdiction
	in.ConsentEvidence = provenance.Evidence
	in.ConsentReason = provenance.Reason
	in.ConsentPolicyVersion = provenance.PolicyVersion
	return &provenance, true, nil
}

// Update applies a partial patch by id or email.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Subscriber, error) {
	return r.update(ctx, tenantID, id, in, nil)
}

// UpdateWithAudit is the request-attributed variant used by mutating HTTP
// surfaces. Its audit event participates in the same commit as the profile,
// histories, normalized addresses, webhook intents, and engine-sync outbox.
func (r *Repo) UpdateWithAudit(ctx context.Context, tenantID, id string, in UpdateInput, auditMeta db.AuditMeta) (*Subscriber, error) {
	auditMeta.TenantID = tenantID
	return r.update(ctx, tenantID, id, in, &auditMeta)
}

func (r *Repo) update(ctx context.Context, tenantID, id string, in UpdateInput, auditMeta *db.AuditMeta) (*Subscriber, error) {
	if r.CustomFields != nil {
		if in.CustomFields != nil {
			cf, err := r.CustomFields.Validate(ctx, tenantID, in.CustomFields)
			if err != nil {
				return nil, fmt.Errorf("validate custom_fields: %w", err)
			}
			in.CustomFields = cf
		}
	}
	consentProvenance, consentGrant, err := normalizeSubscriberUpdateConsentIntent(&in)
	if err != nil {
		return nil, err
	}
	hasPredictionMetadata, predictionScoreType, err := validateSubscriberPredictionPatch(&in)
	if err != nil {
		return nil, err
	}
	// merge_fields is validated by the merge_field_schema compatibility
	// triggers at write time; tenant_custom_fields applies only to the separate
	// custom_fields document (see Upsert for the full boundary rationale).
	// Single tenant-scoped tx covers BOTH the GET lookup and the
	// UPDATE write (audit perf BE-5). Previously two transactions
	// per PATCH: one for Get + commit, then a second for the UPDATE.
	// At sustained PATCH throughput this doubled DB round-trips and
	// the window between the two opened a TOCTOU on `prevStatus`
	// that the old code didn't surface.
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Frequency admissions hold the shared side through commit. Take the
	// exclusive identity fence before the subscriber row lock so neither side
	// can observe a mixed pre/post-rotation send history and authority state.
	if in.Email != nil {
		if err := subscriberidentitylock.Tenant(ctx, tx, tenantID); err != nil {
			return nil, err
		}
	}
	cur, err := getInTxForUpdate(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	// Optimistic concurrency: when the caller supplied an If-Match token,
	// reject the write if the row advanced since they read it. The pre-check
	// catches a client that is already stale relative to this read; the UPDATE
	// below ALSO carries `updated_at = $expected`. The FOR UPDATE read serializes
	// internal callers that intentionally omit a token, while the timestamp
	// predicate preserves exact client-version semantics for HTTP callers.
	var expectedUpdatedAt *time.Time
	if in.IfMatchToken != "" {
		if in.IfMatchToken != httpcache.ConcurrencyToken("subscriber", cur.ID, cur.UpdatedAt) {
			return nil, ErrPreconditionFailed
		}
		ts := cur.UpdatedAt
		expectedUpdatedAt = &ts
	}
	prevStatus := cur.Status
	prevTags := append([]string(nil), cur.Tags...)
	// SUB-024: snapshot the pre-mutation email so a PATCH that rotates the
	// address can re-point every email-keyed historical table (events,
	// topics, tracking prefs, automation/sequence enrollment) onto the new
	// address inside this same tx. Without this, a rename orphaned all of a
	// subscriber's prior subscriber_events rows under the old address — the
	// Merge path already re-points on the duplicate's email, but Update never
	// did. Captured before the in-place patch below overwrites cur.Email.
	prevEmail := cur.Email
	auditBefore := *cur
	auditBefore.CustomFields = copyAnyMap(cur.CustomFields)
	auditBefore.MergeFields = copyAnyMap(cur.MergeFields)
	// Snapshot the pre-mutation attribute state for SUB-008 before `cur`
	// is patched in place below. Only the fields the differ reads are
	// copied; the jsonb maps are shallow-copied so a later in-place map
	// reassignment on `cur` doesn't alias the snapshot.
	var prevAttrSnapshot *Subscriber
	if r.AttributeHistory {
		snap := *cur
		snap.CustomFields = copyAnyMap(cur.CustomFields)
		snap.MergeFields = copyAnyMap(cur.MergeFields)
		prevAttrSnapshot = &snap
	}
	applySubscriberPatch(cur, in)

	customRaw, _ := json.Marshal(nonNilMap(cur.CustomFields))
	mergeRaw, _ := json.Marshal(nonNilMap(cur.MergeFields))
	groupsRaw, _ := json.Marshal(nonNilSliceMap(cur.Groups))
	gdprRaw, _ := json.Marshal(nonNilSliceMap(cur.GDPRPermissions))
	summaryRaw, _ := json.Marshal(nonNilMap(cur.ActivitySummary))
	row := tx.QueryRow(ctx, `
UPDATE subscribers SET
    email = $3,
    primary_email = $3,
    status = $4,
    consent_timestamp = $5,
    consent_source = $6,
    custom_fields = $7::jsonb,
    tags = $8,
    source_id = NULLIF($9, ''),
    source_platform = NULLIF($10, ''),
    mailchimp_status = $11,
    merge_fields = $12::jsonb,
    groups = $13::jsonb,
    gdpr_permissions = $14::jsonb,
    signup_ip = NULLIF($15, '')::inet,
    unsubscribe_reason = NULLIF($16, ''),
    mailchimp_last_changed = $17,
    activity_summary = $18::jsonb,
    first_name = $19,
    last_name = $20,
    full_name = $21,
    display_name = $22,
    locale = $23,
    language = $24,
    country = $25,
    region = $26,
    data_region = $27,
    frequency_preference = $28,
    paused_until = $29,
    updated_at = now()
WHERE tenant_id = $1::uuid
  AND id::text = $2
  AND ($30::timestamptz IS NULL OR updated_at = $30::timestamptz)
RETURNING `+subscriberColumns,
		tenantID, cur.ID, cur.Email, cur.Status, cur.ConsentTimestamp, cur.ConsentSource,
		string(customRaw), cur.Tags, cur.SourceID, cur.SourcePlatform,
		cur.MailchimpStatus, string(mergeRaw), string(groupsRaw), string(gdprRaw),
		cur.SignupIP, cur.UnsubscribeReason, cur.MailchimpLastChanged, string(summaryRaw),
		cur.FirstName, cur.LastName, cur.FullName, cur.DisplayName,
		cur.Locale, cur.Language, cur.Country, cur.Region, cur.DataRegion,
		cur.FrequencyPreference, cur.PausedUntil, expectedUpdatedAt)
	sub, err := scanSubscriber(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// getInTx above already confirmed the row exists for this tenant, so a
		// zero-row UPDATE means the optimistic-concurrency predicate failed (a
		// concurrent writer advanced updated_at), not not-found.
		if expectedUpdatedAt != nil {
			return nil, ErrPreconditionFailed
		}
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if in.Email != nil && !strings.EqualFold(prevEmail, sub.Email) {
		if err := rotateCanonicalSubscriberEmailInTx(ctx, tx, tenantID, sub.ID, prevEmail, sub.Email); err != nil {
			if isUniqueViolation(err) {
				return nil, ErrEmailTaken
			}
			return nil, fmt.Errorf("rotate canonical subscriber email row: %w", err)
		}
	}
	if in.GppSections != nil {
		gpp, err := setGppSectionsInTx(ctx, tx, tenantID, sub.ID, in.GppSections, "api")
		if err != nil {
			return nil, fmt.Errorf("apply gpp_sections on subscriber update: %w", err)
		}
		sub.GppSections = gpp.Sections
		// setGppSectionsInTx advances the owning subscriber's updated_at; keep
		// the response ETag aligned with the state committed by this PATCH.
		if err := tx.QueryRow(ctx, `
SELECT updated_at FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, sub.ID).Scan(&sub.UpdatedAt); err != nil {
			return nil, fmt.Errorf("refresh subscriber version after GPP merge: %w", err)
		}
	}
	if hasPredictionMetadata {
		if err := upsertPredictionMetadataInTx(ctx, tx, tenantID, sub, in, predictionScoreType); err != nil {
			return nil, err
		}
	}
	if err := r.recordSubscriberUpdateHistoryInTx(ctx, tx, tenantID, sub, in, prevTags, prevAttrSnapshot); err != nil {
		return nil, err
	}
	// SUB-024: when the email actually changed, re-point every email-keyed
	// historical / state table from the old address to the new one so the
	// rename does not orphan the subscriber's prior events, topic
	// subscriptions, tracking prefs, automation runs, or sequence
	// enrollments. Same tx as the UPDATE — either the row + all its
	// satellites move together, or nothing does. Mirrors the Merge path's
	// re-pointing, but keyed on (oldEmail -> newEmail) rather than
	// (duplicate -> primary).
	if in.Email != nil && !strings.EqualFold(prevEmail, sub.Email) {
		if err := repointSubscriberEmail(ctx, tx, tenantID, prevEmail, sub.Email); err != nil {
			return nil, err
		}
	}
	if consentGrant {
		if err := r.grantSubscriberUpdateConsentInTx(ctx, tx, tenantID, sub, consentProvenance, auditMeta); err != nil {
			return nil, err
		}
	}
	if err := r.fireSubscriberUpdateWebhooksInTx(ctx, tx, tenantID, sub, prevStatus, in); err != nil {
		return nil, err
	}
	// SUB-121: on an unsubscribe transition, record per-destination consent-sync
	// ledger rows in the same tx so the audit trail commits atomically with the
	// status change.
	if r.ConsentSyncLedger != nil && isUnsubscribeTransition(prevStatus, sub.Status) {
		if err := r.ConsentSyncLedger.RecordEvent(ctx, tx, tenantID, sub.ID, ConsentSyncEventUnsubscribe); err != nil {
			return nil, fmt.Errorf("record consent sync ledger: %w", err)
		}
	}
	previousEngineEmail := ""
	if in.Email != nil && !strings.EqualFold(prevEmail, sub.Email) && listmonkIDFromCustomFields(sub.CustomFields) == 0 {
		// A legacy row may pre-date the local Listmonk marker. The prior address
		// is the only additional datum needed to find and rotate that external
		// record; all ordinary events remain subscriber-id-only.
		previousEngineEmail = prevEmail
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, sub.ID, previousEngineEmail); err != nil {
		return nil, err
	}
	if auditMeta != nil {
		metadata := subscriberMutationAuditMetadata(&auditBefore, sub)
		metadata["operation"] = "subscriber_patch"
		metadata["submitted_fields"] = submittedSubscriberUpdateFields(in)
		if err := db.Audit(ctx, tx, *auditMeta, "subscriber.updated", "subscriber", sub.ID, metadata); err != nil {
			return nil, fmt.Errorf("audit subscriber update: %w", err)
		}
	}
	confirmed := isConfirmationTransition(prevStatus, sub.Status)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// SUB-071: shadow-PII scan on the patched row (best-effort, post-commit).
	r.scanPII(ctx, tenantID, sub)
	// SUB-119: bridge the confirmation to the SSE Bus after commit. The Update
	// HTTP handler already emits subscriber.{updated,status_changed,
	// consent_changed}, so the repo only owns subscriber.confirmed here to
	// avoid double-emitting the others. nil-safe (Bus may be unset).
	if confirmed {
		r.emitBus(tenantID, EventSubscriberConfirmed, map[string]any{
			"id":     sub.ID,
			"email":  sub.Email,
			"status": sub.Status,
		})
	}
	return sub, nil
}

// validateSubscriberPredictionPatch validates the optional prediction-metadata
// fields of a PATCH. It reports whether any were supplied and resolves the
// effective score type (defaulting to churn), trimming the model version in
// place so the persisted value matches what was validated.
func validateSubscriberPredictionPatch(in *UpdateInput) (bool, string, error) {
	hasPredictionMetadata := in.PredictionModelVersion != nil || in.PredictionConfidence != nil
	predictionScoreType := strings.TrimSpace(in.PredictionScoreType)
	if predictionScoreType == "" {
		predictionScoreType = PredictionScoreChurn
	}
	if hasPredictionMetadata && !ValidPredictionScoreType(predictionScoreType) {
		return false, "", fmt.Errorf("%w: invalid prediction_score_type %q", ErrInvalidInput, in.PredictionScoreType)
	}
	if !hasPredictionMetadata && strings.TrimSpace(in.PredictionScoreType) != "" {
		return false, "", fmt.Errorf("%w: prediction_score_type requires model_version or confidence", ErrInvalidInput)
	}
	if in.PredictionConfidence != nil && (*in.PredictionConfidence < 0 || *in.PredictionConfidence > 1) {
		return false, "", fmt.Errorf("%w: prediction_confidence must be in [0,1]", ErrInvalidInput)
	}
	if in.PredictionModelVersion != nil {
		trimmed := strings.TrimSpace(*in.PredictionModelVersion)
		if trimmed == "" || len(trimmed) > 200 {
			return false, "", fmt.Errorf("%w: prediction_model_version must be 1 to 200 characters", ErrInvalidInput)
		}
		in.PredictionModelVersion = &trimmed
	}
	return hasPredictionMetadata, predictionScoreType, nil
}

// applySubscriberPatch copies every supplied UpdateInput field onto the locked
// current row. Pointer fields use nil as "omitted, leave unchanged".
func applySubscriberPatch(cur *Subscriber, in UpdateInput) {
	if in.Email != nil {
		cur.Email = *in.Email
	}
	if in.Status != nil {
		cur.Status = *in.Status
	}
	if in.ConsentTimestamp != nil {
		cur.ConsentTimestamp = in.ConsentTimestamp
	}
	if in.ConsentSource != nil {
		cur.ConsentSource = *in.ConsentSource
	}
	if in.CustomFields != nil {
		cur.CustomFields = in.CustomFields
	}
	if in.MailchimpStatus != nil {
		cur.MailchimpStatus = *in.MailchimpStatus
	}
	if in.MergeFields != nil {
		cur.MergeFields = in.MergeFields
	}
	if in.Tags != nil {
		cur.Tags = in.Tags
	}
	if in.Groups != nil {
		cur.Groups = in.Groups
	}
	if in.GDPRPermissions != nil {
		cur.GDPRPermissions = in.GDPRPermissions
	}
	if in.SignupIP != nil {
		cur.SignupIP = *in.SignupIP
	}
	if in.UnsubscribeReason != nil {
		cur.UnsubscribeReason = *in.UnsubscribeReason
	}
	if in.MailchimpLastChanged != nil {
		cur.MailchimpLastChanged = in.MailchimpLastChanged
	}
	if in.ActivitySummary != nil {
		cur.ActivitySummary = in.ActivitySummary
	}
	if in.SourceID != nil {
		cur.SourceID = *in.SourceID
	}
	if in.SourcePlatform != nil {
		cur.SourcePlatform = *in.SourcePlatform
	}
	// Name columns (SUB-004). Explicit patches win; otherwise, when the
	// underlying jsonb name source changed (merge_fields/custom_fields) and
	// the caller left a name field empty, re-derive it so the first-class
	// columns stay in lockstep with the jsonb the search index reads.
	derived := deriveNames(CreateInput{
		FirstName:    valueOrEmpty(in.FirstName),
		LastName:     valueOrEmpty(in.LastName),
		FullName:     valueOrEmpty(in.FullName),
		DisplayName:  valueOrEmpty(in.DisplayName),
		MergeFields:  cur.MergeFields,
		CustomFields: cur.CustomFields,
	})
	if in.FirstName != nil {
		cur.FirstName = *in.FirstName
	} else if cur.FirstName == "" {
		cur.FirstName = derived.first
	}
	if in.LastName != nil {
		cur.LastName = *in.LastName
	} else if cur.LastName == "" {
		cur.LastName = derived.last
	}
	if in.FullName != nil {
		cur.FullName = *in.FullName
	} else if cur.FullName == "" {
		cur.FullName = derived.full
	}
	if in.DisplayName != nil {
		cur.DisplayName = *in.DisplayName
	} else if cur.DisplayName == "" {
		cur.DisplayName = derived.display
	}
	// Localization columns (SUB-005). Pointer patches; an explicit "" is
	// normalised to NULL via NULLIF in the UPDATE.
	if in.Locale != nil {
		cur.Locale = nilIfEmpty(*in.Locale)
	}
	if in.Language != nil {
		cur.Language = nilIfEmpty(*in.Language)
	}
	if in.Country != nil {
		cur.Country = nilIfEmpty(*in.Country)
	}
	if in.Region != nil {
		cur.Region = nilIfEmpty(*in.Region)
	}
	// DataRegion (SUB-052). Pointer patch; an explicit "" clears the
	// override (NULL → inherit the tenant region). The handler has
	// already validated a non-empty value against regions.Allowed().
	if in.DataRegion != nil {
		cur.DataRegion = nilIfEmpty(*in.DataRegion)
	}
	// FrequencyPreference / PausedUntil (SUB-132). Pointer patches; the
	// handler has already validated a non-empty preference against the
	// migration 0180 CHECK vocabulary. ClearPausedUntil=true wins over a
	// supplied PausedUntil so a caller can explicitly unpause in one PATCH.
	if in.FrequencyPreference != nil {
		cur.FrequencyPreference = *in.FrequencyPreference
	}
	if in.ClearPausedUntil {
		cur.PausedUntil = nil
	} else if in.PausedUntil != nil {
		cur.PausedUntil = in.PausedUntil
	}
}

// upsertPredictionMetadataInTx persists PATCH-supplied prediction metadata for
// the subscriber and hydrates the returned row from the freshest stored score.
func upsertPredictionMetadataInTx(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber, in UpdateInput, predictionScoreType string) error {
	modelVersion := "heuristic-v1"
	if in.PredictionModelVersion != nil {
		modelVersion = *in.PredictionModelVersion
	}
	_, err := tx.Exec(ctx, `
INSERT INTO subscriber_prediction_metadata
  (tenant_id, subscriber_id, score_type, model_version, confidence, features, computed_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, '{}'::jsonb, now(), now())
ON CONFLICT (tenant_id, subscriber_id, score_type) DO UPDATE
   SET model_version = CASE WHEN $6::boolean THEN EXCLUDED.model_version
                            ELSE subscriber_prediction_metadata.model_version END,
       confidence    = CASE WHEN $7::boolean THEN EXCLUDED.confidence
                            ELSE subscriber_prediction_metadata.confidence END,
       computed_at   = now(),
       updated_at    = now()`,
		tenantID, sub.ID, predictionScoreType, modelVersion, in.PredictionConfidence,
		in.PredictionModelVersion != nil, in.PredictionConfidence != nil)
	if err != nil {
		return fmt.Errorf("upsert prediction metadata on subscriber update: %w", err)
	}
	var version string
	var confidence *float64
	if err := tx.QueryRow(ctx, `
SELECT model_version, confidence
  FROM subscriber_prediction_metadata
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY (score_type = 'churn') DESC, computed_at DESC
 LIMIT 1`, tenantID, sub.ID).Scan(&version, &confidence); err != nil {
		return fmt.Errorf("hydrate prediction metadata on subscriber update: %w", err)
	}
	sub.PredictionModelVersion = &version
	sub.PredictionConfidence = confidence
	return nil
}

// recordSubscriberUpdateHistoryInTx appends the tag and attribute history rows
// for a PATCH and reconciles the group-membership junction, all in the same tx
// as the UPDATE.
func (r *Repo) recordSubscriberUpdateHistoryInTx(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber, in UpdateInput, prevTags []string, prevAttrSnapshot *Subscriber) error {
	if r.TagHistory != nil && in.Tags != nil {
		added, removed := tagDelta(prevTags, sub.Tags)
		if len(added) > 0 || len(removed) > 0 {
			if err := r.TagHistory.EmitSubscriberTagDelta(ctx, tx, tenantID, sub.ID, added, removed, "", "subscriber_update"); err != nil {
				return fmt.Errorf("emit tag history: %w", err)
			}
		}
	}
	// Attribute history (SUB-008): diff the pre-mutation snapshot against
	// the persisted row and append one row per changed field, same tx.
	if r.AttributeHistory {
		if changes := diffSubscriberAttributes(prevAttrSnapshot, sub); len(changes) > 0 {
			if err := emitAttributeHistory(ctx, tx, tenantID, sub.ID, changes, "", "subscriber_update"); err != nil {
				return err
			}
		}
	}
	// SUB-117: reconcile the group-membership junction whenever the caller
	// touched the groups field. Same tx; best-effort (no-op pre-1112).
	if in.Groups != nil {
		if err := syncGroupMembershipsFromJSONB(ctx, tx, tenantID, sub.ID, sub.Groups); err != nil {
			return err
		}
	}
	return nil
}

// grantSubscriberUpdateConsentInTx records the exact-address consent grant a
// generic subscriber enable implies. It must advance the normalized address,
// immutable event, structured proof, and purpose projection together.
// Deliverability/complaint/DSAR/manual suppressions are deliberately
// preserved; only this workflow's own reversible consent-status hold may be
// cleared.
func (r *Repo) grantSubscriberUpdateConsentInTx(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber, consentProvenance *ConsentProvenanceInput, auditMeta *db.AuditMeta) error {
	canonicalAddress, err := ensureCanonicalSubscriberEmailForEvidenceInTx(
		ctx, tx, tenantID, sub,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrEmailTaken
		}
		return fmt.Errorf("ensure canonical address for consent grant: %w", err)
	}
	proofAuditMeta := db.AuditMeta{
		TenantID: tenantID, IP: sub.SignupIP, ActorType: "system", ActorLabel: "subscriber-update",
	}
	if auditMeta != nil {
		proofAuditMeta = *auditMeta
	}
	consentEventID, err := recordEmailConsentEvidence(
		ctx, tx, tenantID, sub, canonicalAddress, "subscribed", *consentProvenance,
		"subscriber_status_enable", proofAuditMeta,
	)
	if err != nil {
		return fmt.Errorf("record subscriber enable consent evidence: %w", err)
	}
	if err := clearEmailConsentStatusSuppression(ctx, tx, tenantID, canonicalAddress.Email); err != nil {
		return err
	}
	canonicalAddress, _, err = lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, sub.ID, sub.Email,
	)
	if err != nil {
		return err
	}
	if canonicalAddress == nil {
		return ErrNotFound
	}
	if err := fireEmailConsentWebhook(ctx, r, tx, tenantID, sub, canonicalAddress, consentEventID); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `
SELECT consent_email_marketing_at, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, sub.ID).Scan(
		&sub.ConsentEmailMarketingAt, &sub.UpdatedAt); err != nil {
		return fmt.Errorf("refresh subscriber consent projection: %w", err)
	}
	return nil
}

// fireSubscriberUpdateWebhooksInTx emits the lifecycle webhooks for a PATCH
// inside the same tx. Always emits .updated; ALSO emits .status_changed,
// .consent_changed, .unsubscribed, and .confirmed when the corresponding
// transition happened (so receivers running CRM cleanup or lifecycle
// reactions can subscribe to the specific event without diffing .updated).
func (r *Repo) fireSubscriberUpdateWebhooksInTx(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber, prevStatus string, in UpdateInput) error {
	if r.Webhooks == nil {
		return nil
	}
	if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
		TenantID:  tenantID,
		EventType: EventSubscriberUpdated,
		Body:      sub,
	}); err != nil {
		return fmt.Errorf("dispatch webhook: %w", err)
	}
	// SUB-118: emit a dedicated subscriber.status_changed whenever the
	// status column actually transitioned — so a receiver running a
	// lifecycle reaction can subscribe to status moves without diffing
	// every .updated. This fires on ANY status change (e.g.
	// unconfirmed→enabled), distinct from .unsubscribed below which is
	// only the final-stop transition.
	if prevStatus != sub.Status {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:  tenantID,
			EventType: EventSubscriberStatusChanged,
			Body:      sub,
		}); err != nil {
			return fmt.Errorf("dispatch status_changed webhook: %w", err)
		}
	}
	// SUB-118: emit subscriber.consent_changed when the consent state
	// moved (the caller explicitly patched consent_source and/or
	// consent_timestamp). The mirror of the consent ledger as a
	// subscriber-scoped lifecycle event.
	if consentChanged(in) {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:  tenantID,
			EventType: EventSubscriberConsentChanged,
			Body:      sub,
		}); err != nil {
			return fmt.Errorf("dispatch consent_changed webhook: %w", err)
		}
	}
	if isUnsubscribeTransition(prevStatus, sub.Status) {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      EventSubscriberUnsubscribed,
			Body:           sub,
			IdempotencyKey: "subscriber-unsubscribed:" + sub.ID + ":" + sub.Version,
		}); err != nil {
			return fmt.Errorf("dispatch unsubscribe webhook: %w", err)
		}
	}
	// SUB-119: emit subscriber.confirmed when this PATCH confirmed a
	// double-opt-in subscriber (unconfirmed → enabled). Fired inside the tx
	// so the outbound-webhook receiver never sees a confirmation for a row
	// that didn't commit; the matching SSE Bus emit happens post-commit in
	// update.
	if isConfirmationTransition(prevStatus, sub.Status) {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:  tenantID,
			EventType: EventSubscriberConfirmed,
			Body:      sub,
		}); err != nil {
			return fmt.Errorf("dispatch confirmed webhook: %w", err)
		}
	}
	return nil
}

// consentChanged reports whether a PATCH explicitly touched the subscriber's
// consent state (SUB-118). A consent_source or consent_timestamp present in
// the patch body is the signal — UpdateInput carries pointer fields so a nil
// means "omitted, leave unchanged" (no event) while a non-nil means the caller
// asserted a new consent value.
func consentChanged(in UpdateInput) bool {
	return in.ConsentSource != nil || in.ConsentTimestamp != nil
}

// isUnsubscribeTransition reports whether prev→next represents a tenant-
// visible "this person stopped subscribing" event. We treat "blocklisted"
// (the actual final-stop state in Moosewave's status column) as the
// trigger; "unsubscribed" is also accepted since some imports use it.
func isUnsubscribeTransition(prev, next string) bool {
	if prev == next {
		return false
	}
	return next == StatusBlocklisted || next == "unsubscribed"
}
