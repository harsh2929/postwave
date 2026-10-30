// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_verbs.go — SUB-100-bulk-verbs: the extended bulk verbs that complete
// the bulk-ops surface beyond the original delete/tag/untag/unsubscribe/
// move-to-list set. Each verb reuses the BulkTarget audience machinery
// (explicit ids OR segment_id) from bulk_operations.go and writes a single
// subscriber_bulk_operations_audit row (migration 1301) for the activity feed.
//
// Endpoints (all admin-scoped, mounted in MountBulkRoutes):
//
//   POST /api/v1/subscribers/bulk/resubscribe        status -> 'enabled'
//   POST /api/v1/subscribers/bulk/add-to-list        alias of move-to-list
//   POST /api/v1/subscribers/bulk/set-custom-field   patch custom_fields jsonb
//   POST /api/v1/subscribers/bulk/update-merge-field patch merge_fields jsonb
//   POST /api/v1/subscribers/bulk/grant-consent      consent_events 'granted'
//   POST /api/v1/subscribers/bulk/revoke-consent     consent_events 'revoked'
//   POST /api/v1/subscribers/bulk/export-by-segment  stream CSV of audience

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// consentCategories mirrors the consent_events.category CHECK vocabulary
// (migration 0094). A grant/revoke verb against a category outside this set is
// rejected up front rather than caught by the DB CHECK.
var consentCategories = map[string]bool{
	"essential":            true,
	"analytics":            true,
	"marketing":            true,
	"email_marketing":      true,
	"email_tracking":       true,
	"sale_share":           true,
	"targeted_advertising": true,
	"ai_processing":        true,
	"sensitive_data":       true,
}

// consentChannels mirrors the consent_events.channel CHECK vocabulary.
var consentChannels = map[string]bool{
	"web": true, "mobile": true, "desktop": true, "email": true, "import": true, "api": true,
}

var consentProvenanceSources = map[string]bool{
	"double_optin": true, "single_optin": true, "preference_center": true,
	"signed_form": true, "direct_request": true,
}

var consentLegalBases = map[string]bool{
	"consent": true, "contract": true, "legitimate_interest": true, "legal_obligation": true,
}

func normalizeConsentProvenance(in *ConsentProvenanceInput, requireEvidence bool) error {
	in.Source = strings.ToLower(strings.TrimSpace(in.Source))
	if !consentProvenanceSources[in.Source] {
		return ErrInvalidInputWith("source must identify a reviewed consent record")
	}
	in.Channel = strings.ToLower(strings.TrimSpace(in.Channel))
	if !consentChannels[in.Channel] {
		return ErrInvalidInputWith("channel must be one of web/mobile/desktop/email/import/api")
	}
	in.LegalBasis = strings.ToLower(strings.TrimSpace(in.LegalBasis))
	if !consentLegalBases[in.LegalBasis] {
		return ErrInvalidInputWith("legal_basis must be one of consent/contract/legitimate_interest/legal_obligation")
	}
	if in.OccurredAt == nil {
		return ErrInvalidInputWith("occurred_at is required")
	}
	when := in.OccurredAt.UTC()
	if when.After(time.Now().UTC().Add(5 * time.Minute)) {
		return ErrInvalidInputWith("occurred_at cannot be in the future")
	}
	in.OccurredAt = &when
	in.Jurisdiction = strings.ToUpper(strings.TrimSpace(in.Jurisdiction))
	if in.Jurisdiction == "" || len(in.Jurisdiction) > 32 {
		return ErrInvalidInputWith("jurisdiction is required and must be 32 characters or fewer")
	}
	in.Evidence = strings.TrimSpace(in.Evidence)
	if requireEvidence && in.Evidence == "" {
		return ErrInvalidInputWith("evidence is required")
	}
	if len(in.Evidence) > 2048 {
		return ErrInvalidInputWith("evidence must be 2048 characters or fewer")
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || len(in.Reason) > 500 {
		return ErrInvalidInputWith("reason is required and must be 500 characters or fewer")
	}
	in.PolicyVersion = strings.TrimSpace(in.PolicyVersion)
	if in.PolicyVersion == "" || len(in.PolicyVersion) > 100 {
		return ErrInvalidInputWith("policy_version is required and must be 100 characters or fewer")
	}
	return nil
}

// ErrInvalidInputWith keeps these validation errors distinguishable without
// leaking internal database details into the HTTP response.
func ErrInvalidInputWith(message string) error {
	return &consentValidationError{message: message}
}

type consentValidationError struct{ message string }

func (e *consentValidationError) Error() string { return e.message }

// recordBulkVerbAudit writes one metadata row to subscriber_bulk_operations_audit
// inside the supplied tenant tx. Best-effort: a failure here must NOT abort the
// verb's primary mutation (the row is for the activity feed, not correctness),
// so callers ignore the returned error after logging if desired.
func recordBulkVerbAudit(ctx context.Context, tx pgx.Tx, tenantID, verb, source string, affected, skipped int, params map[string]any, actor string) error {
	raw, err := json.Marshal(params)
	if err != nil {
		raw = []byte("{}")
	}
	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_bulk_operations_audit
       (tenant_id, verb, source, affected_count, skipped_count, params, actor)
VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)`,
		tenantID, verb, source, affected, skipped, raw, actor)
	return err
}

// actorFromRequest renders a stable actor label for the audit row.
func actorFromRequest(r *http.Request) string {
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		if e := strings.TrimSpace(u.Email); e != "" {
			return "admin:" + e
		}
	}
	return "admin:unknown"
}

// --- Resubscribe (inverse of unsubscribe) ---

func (d *Deps) BulkResubscribe(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in BulkResubscribeInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := normalizeConsentProvenance(&in.ConsentProvenanceInput, true); err != nil {
		httperror.WriteValidation(w, "invalid_consent_evidence", err.Error())
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, in.BulkTarget)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	tx, err := db.WithTenantOptions(r.Context(), d.Repo.Pool, t.ID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	if strings.TrimSpace(auditMeta.ActorLabel) == "" {
		auditMeta.ActorLabel = actorFromRequest(r)
	}
	targets, exclusions, err := d.applyBulkResubscribe(r.Context(), tx, t.ID, ids, in, auditMeta)
	if err != nil {
		d.writeBulkConsentMutationErr(w, r, err)
		return
	}
	affected := len(targets)
	if err := recordBulkVerbAudit(r.Context(), tx, t.ID, "resubscribe", source, affected, len(ids)-affected, map[string]any{
		"source": in.Source, "channel": in.Channel, "legal_basis": in.LegalBasis,
		"jurisdiction": in.Jurisdiction, "policy_version": in.PolicyVersion,
		"reason": in.Reason, "evidence_present": in.Evidence != "", "exclusions": exclusions,
	}, actorFromRequest(r)); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := db.Audit(r.Context(), tx, auditMeta, "subscriber.bulk_resubscribed", "subscribers", "", map[string]any{
		"count": affected, "source": source, "consent_source": in.Source,
		"channel": in.Channel, "legal_basis": in.LegalBasis,
		"jurisdiction": in.Jurisdiction, "policy_version": in.PolicyVersion,
		"reason": in.Reason, "evidence_present": in.Evidence != "",
		"exclusions": exclusions,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		d.writeBulkConsentMutationErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, BulkResult{
		Affected:   affected,
		Skipped:    len(ids) - affected,
		Source:     source,
		Exclusions: exclusions,
	})
}

func (d *Deps) writeBulkConsentMutationErr(w http.ResponseWriter, r *http.Request, err error) {
	err = mapEmailConsentSerializationError(err)
	switch {
	case errors.Is(err, ErrConcurrentConsentDecision),
		errors.Is(err, ErrEmailPreconditionFailed):
		w.Header().Set("Retry-After", "1")
		httperror.Write(w, http.StatusConflict, "concurrent_consent_change",
			"another consent or suppression decision is in progress; review the audience and retry the complete bulk request")
	case errors.Is(err, ErrEmailSuppressionEvidenceConflict):
		httperror.Write(w, http.StatusConflict, "suppression_evidence_conflict",
			"the suppression evidence changed while this audience was reviewed; refresh the audience before retrying")
	default:
		tenantID := ""
		if tenant, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = tenant.ID
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

// --- set-custom-field / update-merge-field (jsonb patch) ---

func (d *Deps) BulkSetCustomField(w http.ResponseWriter, r *http.Request) {
	d.bulkJSONField(w, r, "custom_fields", "set_custom_field")
}

func (d *Deps) BulkUpdateMergeField(w http.ResponseWriter, r *http.Request) {
	d.bulkJSONField(w, r, "merge_fields", "update_merge_field")
}

// bulkJSONField is the shared implementation for set-custom-field and
// update-merge-field. column is the jsonb column to patch; verb is the audit
// label. A nil/absent value with remove=true deletes the key; otherwise the
// key is set (jsonb concat overwrites the existing key).
func (d *Deps) bulkJSONField(w http.ResponseWriter, r *http.Request, column, verb string) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in BulkCustomFieldInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Key = strings.TrimSpace(in.Key)
	if in.Key == "" {
		httperror.WriteValidation(w, "missing_key", "key is required")
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, in.BulkTarget)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var ct pgconn.CommandTag
	if in.Remove {
		// Delete the key: jsonb minus text operator (col - key).
		// column is a fixed internal string (never user input), so the
		// fmt-injected identifier is safe.
		ct, err = tx.Exec(r.Context(),
			"UPDATE subscribers SET "+column+" = COALESCE("+column+", '{}'::jsonb) - $3, updated_at = now() "+
				"WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])",
			t.ID, ids, in.Key)
	} else {
		// Set the key: jsonb concat with a single-key object. Marshal the
		// value to a jsonb scalar/object so any JSON type is supported.
		valRaw, mErr := json.Marshal(map[string]any{in.Key: in.Value})
		if mErr != nil {
			httperror.WriteValidation(w, "invalid_value", mErr.Error())
			return
		}
		ct, err = tx.Exec(r.Context(),
			"UPDATE subscribers SET "+column+" = COALESCE("+column+", '{}'::jsonb) || $3::jsonb, updated_at = now() "+
				"WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])",
			t.ID, ids, valRaw)
	}
	if err != nil {
		if writeCustomFieldsValidationError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	affected := int(ct.RowsAffected())
	_ = recordBulkVerbAudit(r.Context(), tx, t.ID, verb, source, affected, len(ids)-affected, map[string]any{
		"key":    in.Key,
		"remove": in.Remove,
	}, actorFromRequest(r))
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, BulkResult{
		Affected: affected,
		Source:   source,
	})
}

// --- grant-consent / revoke-consent (consent_events ledger) ---

func (d *Deps) BulkGrantConsent(w http.ResponseWriter, r *http.Request) {
	d.bulkConsent(w, r, "granted", "grant_consent")
}

func (d *Deps) BulkRevokeConsent(w http.ResponseWriter, r *http.Request) {
	d.bulkConsent(w, r, "revoked", "revoke_consent")
}

// bulkConsent appends one immutable decision per resolved subject. Generic
// categories remain subscriber-scoped; email_marketing is routed through the
// migration-1766 exact-address writer so the event, proof, terminal projection,
// webhook, engine intent, and audits commit or roll back together.
func (d *Deps) bulkConsent(w http.ResponseWriter, r *http.Request, action, verb string) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in BulkConsentInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Category = strings.TrimSpace(in.Category)
	if !consentCategories[in.Category] {
		httperror.WriteValidation(w, "invalid_category", "category must be one of the consent vocabulary")
		return
	}
	if err := normalizeConsentProvenance(&in.ConsentProvenanceInput, action == "granted"); err != nil {
		httperror.WriteValidation(w, "invalid_consent_evidence", err.Error())
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, in.BulkTarget)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	tx, err := db.WithTenantOptions(r.Context(), d.Repo.Pool, t.ID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	if strings.TrimSpace(auditMeta.ActorLabel) == "" {
		auditMeta.ActorLabel = actorFromRequest(r)
	}
	affected := 0
	exclusions := map[string]int{}
	if in.Category == "email_marketing" {
		targets, targetExclusions, err := d.applyBulkEmailConsent(
			r.Context(), tx, t.ID, ids, in, action, auditMeta,
		)
		if err != nil {
			d.writeBulkConsentMutationErr(w, r, err)
			return
		}
		affected = len(targets)
		exclusions = targetExclusions
	} else {
		// Non-delivery categories remain subscriber-scoped and append-only.
		preferences, _ := json.Marshal(map[string]any{
			"legal_basis": in.LegalBasis, "jurisdiction": in.Jurisdiction,
			"reason": in.Reason, "operation": "bulk_consent",
		})
		ct, err := tx.Exec(r.Context(), `
INSERT INTO consent_events
       (tenant_id, subject_type, subject_id, subject_email, channel,
        category, action, source, policy_version, preferences, proof_text, created_at)
SELECT $1::uuid, 'subscriber', s.id::text, s.email, $3, $4, $5, $6, $7, $8::jsonb, $9, $10
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid AND s.id = ANY($2::uuid[])`,
			t.ID, ids, in.Channel, in.Category, action, in.Source,
			in.PolicyVersion, preferences, in.Evidence, in.OccurredAt)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		affected = int(ct.RowsAffected())
		if skipped := len(ids) - affected; skipped > 0 {
			exclusions["missing_or_outside_tenant"] = skipped
		}
	}
	if err := recordBulkVerbAudit(r.Context(), tx, t.ID, verb, source, affected, len(ids)-affected, map[string]any{
		"category": in.Category, "channel": in.Channel, "action": action,
		"source": in.Source, "legal_basis": in.LegalBasis,
		"jurisdiction": in.Jurisdiction, "policy_version": in.PolicyVersion,
		"reason": in.Reason, "evidence_present": in.Evidence != "", "exclusions": exclusions,
	}, actorFromRequest(r)); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := db.Audit(r.Context(), tx, auditMeta, "subscriber.bulk_consent_"+action, "subscribers", "", map[string]any{
		"count": affected, "source": source, "category": in.Category,
		"channel": in.Channel, "action": action, "consent_source": in.Source,
		"legal_basis": in.LegalBasis, "jurisdiction": in.Jurisdiction,
		"policy_version": in.PolicyVersion, "reason": in.Reason,
		"evidence_present": in.Evidence != "", "exclusions": exclusions,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		d.writeBulkConsentMutationErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, BulkResult{
		Affected:   affected,
		Skipped:    len(ids) - affected,
		Source:     source,
		Exclusions: exclusions,
	})
}

// --- export-by-segment (CSV stream of the resolved audience) ---

func (d *Deps) BulkExportBySegment(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in BulkExportInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, in.BulkTarget)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	if in.Limit > 0 && len(ids) > in.Limit {
		ids = ids[:in.Limit]
	}
	// Record the export request (count only — never the full id set) before
	// streaming so the activity feed reflects the export even on a client
	// disconnect mid-stream.
	if atx, aerr := db.WithTenant(r.Context(), d.Repo.Pool, t.ID); aerr == nil {
		_ = recordBulkVerbAudit(r.Context(), atx, t.ID, "export_by_segment", source, len(ids), 0, map[string]any{
			"segment_id": in.SegmentID,
			"limit":      in.Limit,
		}, actorFromRequest(r))
		_ = atx.Commit(r.Context())
	}
	csvw := &csvDownloadWriter{ResponseWriter: w}
	if err := d.Repo.StreamCSVByIDs(r.Context(), t.ID, csvw, ids); err != nil {
		if !csvw.wrote {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
}
