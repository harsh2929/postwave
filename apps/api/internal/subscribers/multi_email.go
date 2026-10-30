// SUB-016 — Multi-email per profile (up to 5).
//
// One profile may own several addresses (work + personal, a forwarding
// alias, a legacy account); each carries its own consent / suppression /
// engagement state while rolling up to a single subscriber. Addresses live
// in the subscriber_emails junction table (migration 0452); exactly one is
// the primary (canonical) address, mirrored onto subscribers.primary_email.
//
// Endpoints (all scoped under an existing subscriber id):
//   GET    /api/v1/subscribers/{id}/emails              — list addresses
//   POST   /api/v1/subscribers/{id}/emails              — add an address
//   PATCH  /api/v1/subscribers/{id}/emails/{email_id}   — consent/primary/suppress
//   DELETE /api/v1/subscribers/{id}/emails/{email_id}   — remove an address

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// MaxEmailsPerProfile caps the number of addresses a single profile may own
// (SUB-016). Enforced in the application layer (not a DB constraint) so the
// limit can evolve per plan without a migration.
const MaxEmailsPerProfile = 5

const subscriberEmailDeletePolicyVersion = "subscriber-email-delete-v1"

// ErrEmailLimitReached is returned by AddEmail when the profile already owns
// MaxEmailsPerProfile addresses.
var ErrEmailLimitReached = fmt.Errorf("%w: profile already has the maximum of %d emails", ErrInvalidInput, MaxEmailsPerProfile)

// ErrEmailTaken is returned when the address is already attached to a profile
// in this tenant (the per-tenant UNIQUE on subscriber_emails).
var ErrEmailTaken = errors.New("subscriber: email already attached to a profile")

// ErrEmailActivationUnavailable prevents the secondary-address surface from
// claiming that it changed the delivery identity. Canonical rotations must go
// through the subscriber PATCH path, which re-points every email-keyed
// satellite atomically; the old side-table-only promotion was decorative.
var ErrEmailActivationUnavailable = errors.New("subscriber: primary address changes must use the canonical subscriber email editor")

// ErrEmailPreconditionFailed is returned when a per-address If-Match token is
// stale. A consent or suppression decision must never overwrite a concurrent
// operator's reviewed state.
var ErrEmailPreconditionFailed = errors.New("subscriber: email address changed since it was loaded")

// ErrProtectedEmailSuppression means an unsuppress request encountered a
// suppression owned by another safety/compliance source. The address remains
// blocked and must be reviewed in the canonical suppression surface.
var ErrProtectedEmailSuppression = errors.New("subscriber: address has another active suppression; review it in Suppressions")

// ErrEmailSuppressionEvidenceConflict means the exact/version-bound repair
// setter found that the requested projection disagreed with authoritative
// suppression evidence. The transaction is rolled back and the operator must
// reload; raw database details are never exposed.
var ErrEmailSuppressionEvidenceConflict = errors.New("subscriber: suppression evidence changed; reload and review the address")

// MountMultiEmailRoutes registers the SUB-016 per-address CRUD endpoints.
// Mutating routes are wrapped with observability.RecordSurfaceFunc so the
// pw_subscribers_<action>_total + duration histogram are emitted.
func MountMultiEmailRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/emails", d.ListEmails)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/{id}/emails",
			observability.RecordSurfaceFunc("subscribers", "add_email", d.AddEmail))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/emails/{email_id}",
			observability.RecordSurfaceFunc("subscribers", "update_email", d.UpdateEmail))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/subscribers/{id}/emails/{email_id}",
			observability.RecordSurfaceFunc("subscribers", "delete_email", d.DeleteEmail))
}

func (d *Deps) ListEmails(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	items, err := d.Repo.ListEmails(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeMultiEmailErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) AddEmail(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in AddEmailInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	ifMatch, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httpcache.WritePreconditionRequired(w)
		return
	}
	out, err := d.Repo.AddEmailExact(r.Context(), t.ID, chi.URLParam(r, "id"), in, ifMatch, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeMultiEmailErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.email.added", map[string]any{
		"subscriber_id": out.SubscriberID,
		"email_id":      out.ID,
		"is_primary":    out.IsPrimary,
	})
	w.Header().Set("ETag", out.Version)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) UpdateEmail(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in UpdateEmailInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	token, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httperror.Write(w, http.StatusPreconditionRequired, "precondition_required",
			"If-Match from the current address version is required")
		return
	}
	in.IfMatchToken = token
	out, err := d.Repo.UpdateEmail(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "email_id"), in, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeMultiEmailErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.email.updated", map[string]any{
		"subscriber_id": out.SubscriberID,
		"email_id":      out.ID,
		"is_primary":    out.IsPrimary,
	})
	w.Header().Set("ETag", out.Version)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteEmail(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	token, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httperror.Write(w, http.StatusPreconditionRequired, "precondition_required",
			"If-Match from the current address version is required")
		return
	}
	if err := d.Repo.DeleteEmail(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "email_id"), token, middleware.AuditMetaFromRequest(r)); err != nil {
		d.writeMultiEmailErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.email.deleted", map[string]any{
		"subscriber_id": chi.URLParam(r, "id"),
		"email_id":      chi.URLParam(r, "email_id"),
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// writeMultiEmailErr maps the per-address repo errors to safe HTTP responses.
func (d *Deps) writeMultiEmailErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, ErrEmailTaken):
		httperror.Write(w, http.StatusConflict, "email_taken", err.Error())
	case errors.Is(err, ErrEmailPreconditionFailed), errors.Is(err, ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, ErrEmailActivationUnavailable):
		httperror.Write(w, http.StatusConflict, "canonical_email_required", err.Error())
	case errors.Is(err, ErrProtectedEmailSuppression):
		httperror.Write(w, http.StatusConflict, "protected_suppression", err.Error())
	case errors.Is(err, ErrEmailSuppressionEvidenceConflict):
		httperror.Write(w, http.StatusConflict, "suppression_evidence_conflict", err.Error())
	case errors.Is(err, ErrConcurrentConsentDecision):
		httperror.Write(w, http.StatusConflict, "concurrent_consent_change",
			"another consent or suppression decision is in progress; retry the complete request with the latest address version")
	case errors.Is(err, ErrInvalidInput):
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		tenantID := ""
		if t, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = t.ID
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

const subscriberEmailColumns = `id::text, subscriber_id::text, email::text, is_primary,
       consent_status, suppressed, last_engaged_at, created_at, updated_at`

// ListEmails returns every address attached to the subscriber, primary first.
func (r *Repo) ListEmails(ctx context.Context, tenantID, subscriberID string) ([]SubscriberEmail, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, subscriber_id::text, email::text,
       lower(email::text) = lower($3),
       consent_status, suppressed, last_engaged_at, created_at, updated_at
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY (lower(email::text) = lower($3)) DESC, created_at ASC`, tenantID, sub.ID, sub.Email)
	if err != nil {
		return nil, err
	}
	items, err := scanSubscriberEmails(rows)
	if err != nil {
		return nil, err
	}
	// The subscriber row is the actual delivery identity. Deriving this field
	// at read time keeps pre-migration/stale junction flags from presenting a
	// decorative primary address to an operator.
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].IsPrimary && !items[j].IsPrimary
	})
	return items, tx.Commit(ctx)
}

// AddEmail attaches a new address to the profile. Enforces the
// MaxEmailsPerProfile cap and the per-tenant address-uniqueness invariant,
// and (when is_primary) atomically demotes the prior primary and updates
// subscribers.primary_email.
func (r *Repo) AddEmail(ctx context.Context, tenantID, subscriberID string, in AddEmailInput, auditMeta db.AuditMeta) (*SubscriberEmail, error) {
	return r.addEmail(ctx, tenantID, subscriberID, in, "", auditMeta)
}

// AddEmailExact is the HTTP write path. A secondary address changes the
// identity graph and may carry reviewed consent evidence, so the mutation is
// based on the exact parent-profile revision the operator inspected.
func (r *Repo) AddEmailExact(ctx context.Context, tenantID, subscriberID string, in AddEmailInput, ifMatchToken string, auditMeta db.AuditMeta) (*SubscriberEmail, error) {
	if strings.TrimSpace(ifMatchToken) == "" {
		return nil, ErrPreconditionFailed
	}
	return r.addEmail(ctx, tenantID, subscriberID, in, ifMatchToken, auditMeta)
}

func (r *Repo) addEmail(ctx context.Context, tenantID, subscriberID string, in AddEmailInput, ifMatchToken string, auditMeta db.AuditMeta) (*SubscriberEmail, error) {
	email, err := normalizeEmail(in.Email)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidInput, err.Error())
	}
	consentStatus, provenance, explicitConsent, err := normalizeEmailConsentIntent(
		in.ConsentStatus, in.ConsentProvenanceInput, "never_subscribed",
	)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockedSubscriberID, err := lockSubscriberEmailIdentity(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	sub, err := getInTx(ctx, tx, tenantID, lockedSubscriberID)
	if err != nil {
		return nil, err
	}
	if ifMatchToken != "" && ifMatchToken != sub.Version {
		return nil, ErrPreconditionFailed
	}

	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		tenantID, sub.ID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= MaxEmailsPerProfile {
		return nil, ErrEmailLimitReached
	}

	// A secondary-address endpoint must not silently rotate the real delivery
	// identity. The canonical subscriber PATCH owns that operation because it
	// also re-points email-keyed histories, topics, tracking preferences, and
	// engine state. The only primary insert allowed here repairs an empty
	// junction with the subscriber's already-canonical address.
	if in.IsPrimary && count > 0 {
		return nil, ErrEmailActivationUnavailable
	}
	makePrimary := count == 0
	if makePrimary && !strings.EqualFold(email, sub.Email) {
		return nil, ErrEmailActivationUnavailable
	}

	stagedConsentStatus := consentStatus
	if emailConsentProofStatus(consentStatus) != "" {
		// Migration 1766's terminal trigger is the only positive projection
		// authority. Insert fail closed, then append the exact evidence pair.
		stagedConsentStatus = "never_subscribed"
	}
	row := tx.QueryRow(ctx, `
	INSERT INTO subscriber_emails (tenant_id, subscriber_id, email, is_primary, consent_status)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)
RETURNING `+subscriberEmailColumns,
		tenantID, sub.ID, email, makePrimary, stagedConsentStatus)
	out, err := scanSubscriberEmail(row)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrEmailTaken
		}
		return nil, err
	}
	if makePrimary {
		if err := syncPrimaryEmail(ctx, tx, tenantID, sub.ID, email); err != nil {
			return nil, err
		}
	}
	consentEventID := ""
	if explicitConsent {
		consentEventID, err = recordEmailConsentEvidence(ctx, tx, tenantID, sub, out, consentStatus, *provenance, "multi_email_address_consent", auditMeta)
		if err != nil {
			return nil, err
		}
		if consentStatus == "subscribed" {
			if err := clearEmailConsentStatusSuppression(ctx, tx, tenantID, out.Email); err != nil {
				return nil, err
			}
		} else {
			if err := ensureEmailSafetySuppression(ctx, tx, tenantID, out, "multi_email_consent_status", provenance.Reason, provenance.Evidence); err != nil {
				return nil, err
			}
		}
		out, _, err = lockEmailConsentAddressForRepairByID(
			ctx, tx, tenantID, sub.ID, out.ID,
		)
		if err != nil {
			return nil, err
		}
		if out == nil {
			return nil, ErrNotFound
		}
		if err := fireEmailConsentWebhook(ctx, r, tx, tenantID, sub, out, consentEventID); err != nil {
			return nil, err
		}
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, sub.ID, ""); err != nil {
		return nil, err
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.email_added", "subscriber_email", out.ID, map[string]any{
		"subscriber_id":    sub.ID,
		"email_redacted":   observability.RedactEmail(out.Email),
		"is_primary":       out.IsPrimary,
		"consent_status":   out.ConsentStatus,
		"consent_event_id": consentEventID,
	}); err != nil {
		return nil, fmt.Errorf("audit subscriber email add: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateEmail patches consent / suppression / primary on one address. Setting
// is_primary=true demotes the prior primary and re-points
// subscribers.primary_email in the same tx.
func (r *Repo) UpdateEmail(ctx context.Context, tenantID, subscriberID, emailID string, in UpdateEmailInput, auditMeta db.AuditMeta) (*SubscriberEmail, error) {
	if in.IsPrimary != nil {
		return nil, ErrEmailActivationUnavailable
	}
	consentStatus, provenance, explicitConsent, err := normalizeEmailConsentIntent(
		in.ConsentStatus, in.ConsentProvenanceInput, "",
	)
	if err != nil {
		return nil, err
	}
	if explicitConsent && (consentStatus == "unknown" || consentStatus == "never_subscribed") {
		return nil, fmt.Errorf("%w: unknown and never_subscribed are read-only absence-of-evidence states; record subscribed, unsubscribed, or pending evidence", ErrInvalidInput)
	}
	suppressionChange, err := normalizeEmailSuppressionIntent(&in)
	if err != nil {
		return nil, err
	}
	if explicitConsent && suppressionChange {
		return nil, fmt.Errorf("%w: change consent and suppression in separate reviewed requests", ErrInvalidInput)
	}
	if !explicitConsent && !suppressionChange {
		return nil, fmt.Errorf("%w: consent_status or suppressed is required", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockedSubscriberID, err := lockSubscriberEmailIdentity(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	sub, err := getInTx(ctx, tx, tenantID, lockedSubscriberID)
	if err != nil {
		return nil, err
	}

	// Migration 1766's app-role visibility policy intentionally hides a
	// retained positive while the release gate is blocked or its exact proof is
	// expired. Resolve the immutable address UUID through the narrow definer and
	// acquire its bounded normalized-email mutex before any tuple mutation.
	current, _, err := lockEmailConsentAddressForRepairByID(
		ctx, tx, tenantID, sub.ID, emailID,
	)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, ErrNotFound
	}
	if in.IfMatchToken != "" && in.IfMatchToken != current.Version {
		return nil, ErrEmailPreconditionFailed
	}

	// An explicit consent assertion is evidence-bearing even when its projected
	// status matches the current row. Persist the fresh immutable proof, advance
	// the address revision, and emit the durable audit/webhook/outbox effects so
	// a reviewed re-confirmation is never silently discarded.
	if suppressionChange && current.Suppressed == *in.Suppressed {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return current, nil
	}

	var out *SubscriberEmail
	consentEventID := ""
	if suppressionChange {
		if *in.Suppressed {
			if err := ensureEmailSafetySuppression(ctx, tx, tenantID, current, "multi_email_address_suppression", in.SuppressionReason, in.SuppressionEvidence); err != nil {
				return nil, err
			}
		} else if err := clearReviewedEmailSuppression(ctx, tx, tenantID, current.Email); err != nil {
			return nil, err
		}
		out, err = setEmailSuppressedForRepairByID(
			ctx, tx, tenantID, sub.ID, current.ID, current.UpdatedAt, *in.Suppressed,
		)
		if err != nil {
			return nil, err
		}
	} else {
		// Evidence is written before any raw address projection. The terminal
		// record trigger re-enters the resolver mutex, folds the immutable pair,
		// and updates even an RLS-hidden row. Retrying only a failed statement is
		// forbidden; every error rolls this complete transaction back.
		consentEventID, err = recordEmailConsentEvidence(ctx, tx, tenantID, sub, current, consentStatus, *provenance, "multi_email_address_consent", auditMeta)
		if err != nil {
			return nil, err
		}
		if consentStatus == "subscribed" {
			if err := clearEmailConsentStatusSuppression(ctx, tx, tenantID, current.Email); err != nil {
				return nil, err
			}
		} else {
			if err := ensureEmailSafetySuppression(ctx, tx, tenantID, current, "multi_email_consent_status", provenance.Reason, provenance.Evidence); err != nil {
				return nil, err
			}
		}
		out, _, err = lockEmailConsentAddressForRepairByID(
			ctx, tx, tenantID, sub.ID, current.ID,
		)
		if err != nil {
			return nil, err
		}
		if out == nil {
			return nil, ErrNotFound
		}
		if err := fireEmailConsentWebhook(ctx, r, tx, tenantID, sub, out, consentEventID); err != nil {
			return nil, err
		}
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, sub.ID, ""); err != nil {
		return nil, err
	}
	auditMeta.TenantID = tenantID
	action := "subscriber.email_suppression_changed"
	metadata := map[string]any{
		"subscriber_id":  sub.ID,
		"email_redacted": observability.RedactEmail(out.Email),
		"suppressed":     out.Suppressed,
		"reason":         strings.TrimSpace(in.SuppressionReason),
	}
	if explicitConsent {
		action = "subscriber.email_consent_changed"
		if current.ConsentStatus == out.ConsentStatus {
			action = "subscriber.email_consent_evidence_recorded"
		}
		metadata = map[string]any{
			"subscriber_id":    sub.ID,
			"email_redacted":   observability.RedactEmail(out.Email),
			"previous_status":  current.ConsentStatus,
			"new_status":       out.ConsentStatus,
			"consent_event_id": consentEventID,
		}
	}
	if err := db.Audit(ctx, tx, auditMeta, action, "subscriber_email", out.ID, metadata); err != nil {
		return nil, fmt.Errorf("audit subscriber email update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteEmail removes an address. The primary address cannot be deleted while
// other addresses remain (set a new primary first); deleting the last address
// is allowed.
func (r *Repo) DeleteEmail(ctx context.Context, tenantID, subscriberID, emailID, ifMatchToken string, auditMeta db.AuditMeta) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockedSubscriberID, err := lockSubscriberEmailIdentity(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return err
	}
	sub, err := getInTx(ctx, tx, tenantID, lockedSubscriberID)
	if err != nil {
		return err
	}

	// Resolve by immutable UUID before any address tuple access. Migration 1766
	// intentionally hides retained positives while the release gate is blocked
	// or their proof is expired; the narrow resolver both finds that exact row
	// and acquires its normalized-address mutex without weakening send RLS.
	current, _, err := lockEmailConsentAddressForRepairByID(
		ctx, tx, tenantID, sub.ID, emailID,
	)
	if err != nil {
		return err
	}
	if current == nil {
		return ErrNotFound
	}
	if ifMatchToken != "" && ifMatchToken != current.Version {
		return ErrEmailPreconditionFailed
	}
	if current.IsPrimary || strings.EqualFold(current.Email, sub.Email) {
		return fmt.Errorf("%w: the canonical address cannot be removed; change the subscriber email first", ErrInvalidInput)
	}

	// A subscribed secondary can be RLS-hidden and therefore cannot be deleted
	// directly by the app role. Record an exact-address withdrawal first. The
	// terminal trigger demotes the projection under the same re-entrant mutex,
	// making the row ordinarily visible without a privileged delete function.
	// The immutable event/proof deliberately survives address removal.
	consentEventID := ""
	if current.ConsentStatus == "subscribed" {
		occurredAt := time.Now().UTC()
		provenance := ConsentProvenanceInput{
			Source:        "direct_request",
			Channel:       "api",
			LegalBasis:    "consent",
			OccurredAt:    &occurredAt,
			Jurisdiction:  "UNSPECIFIED",
			Evidence:      "Authenticated operator removed this exact secondary address from the subscriber profile.",
			Reason:        "Secondary address removed from subscriber profile.",
			PolicyVersion: subscriberEmailDeletePolicyVersion,
		}
		consentEventID, err = recordEmailConsentEvidence(
			ctx, tx, tenantID, sub, current, "unsubscribed", provenance,
			"multi_email_address_deleted", auditMeta,
		)
		if err != nil {
			return mapEmailConsentSerializationError(err)
		}
		current, _, err = lockEmailConsentAddressForRepairByID(
			ctx, tx, tenantID, sub.ID, emailID,
		)
		if err != nil {
			return err
		}
		if current == nil {
			return ErrEmailPreconditionFailed
		}
		if current.ConsentStatus == "subscribed" {
			return errors.New("subscriber: address deletion withdrawal did not reach terminal projection")
		}
		if err := fireEmailConsentWebhook(
			ctx, r, tx, tenantID, sub, current, consentEventID,
		); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND id = $3::uuid
   AND updated_at = $4::timestamptz`,
		tenantID, sub.ID, emailID, current.UpdatedAt)
	if err != nil {
		return mapEmailConsentSerializationError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrEmailPreconditionFailed
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, sub.ID, ""); err != nil {
		return err
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.email_deleted", "subscriber_email", current.ID, map[string]any{
		"subscriber_id":    sub.ID,
		"email_redacted":   observability.RedactEmail(current.Email),
		"consent_status":   current.ConsentStatus,
		"suppressed":       current.Suppressed,
		"consent_event_id": consentEventID,
	}); err != nil {
		return fmt.Errorf("audit subscriber email delete: %w", err)
	}
	return mapEmailConsentSerializationError(tx.Commit(ctx))
}

// syncPrimaryEmail mirrors the chosen primary onto subscribers.primary_email.
func syncPrimaryEmail(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, email string) error {
	_, err := tx.Exec(ctx, `
UPDATE subscribers SET primary_email = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, subscriberID, email)
	return err
}

// ensureCanonicalSubscriberEmailInTx makes the normalized address row a
// mandatory fail-closed companion to the subscriber identity. Positive
// projection is intentionally impossible through this helper: immutable exact
// evidence and migration 1766's terminal trigger are the sole grant authority.
func ensureCanonicalSubscriberEmailInTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	subscriber *Subscriber,
) error {
	if subscriber == nil {
		return errors.New("subscriber: canonical email requires subscriber")
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET is_primary = false, updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND is_primary
   AND lower(email::text) <> lower($3)`, tenantID, subscriber.ID, subscriber.Email); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET is_primary = true,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)
   AND NOT is_primary`, tenantID, subscriber.ID, subscriber.Email)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM subscriber_emails
     WHERE tenant_id = $1::uuid
       AND subscriber_id = $2::uuid
       AND lower(email::text) = lower($3)
)`, tenantID, subscriber.ID, subscriber.Email).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status)
VALUES ($1::uuid, $2::uuid, $3, true, 'never_subscribed')`, tenantID, subscriber.ID, subscriber.Email); err != nil {
				return err
			}
		}
	}
	subscriber.PrimaryEmail = subscriber.Email
	return nil
}

// ensureCanonicalSubscriberEmailForEvidenceInTx resolves migration 1766's
// exact-address mutex before touching the address table and guarantees that a
// canonical row exists in a fail-closed state. A reviewed positive is never
// staged here: recordEmailConsentEvidence owns the later terminal projection.
func ensureCanonicalSubscriberEmailForEvidenceInTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	subscriber *Subscriber,
) (*SubscriberEmail, error) {
	if subscriber == nil {
		return nil, errors.New("subscriber: canonical email requires subscriber")
	}
	resolved, _, err := lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, subscriber.ID, subscriber.Email,
	)
	if err != nil {
		return nil, err
	}
	if resolved != nil && resolved.IsPrimary {
		subscriber.PrimaryEmail = subscriber.Email
		return resolved, nil
	}
	if resolved != nil {
		// A non-primary retained positive can be RLS-hidden. The repair resolver
		// intentionally cannot promote identity, so do not pretend the update
		// succeeded or collide with the existing normalized address.
		if _, err := scanSubscriberEmail(tx.QueryRow(ctx, `
SELECT `+subscriberEmailColumns+`
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND id = $3::uuid
 FOR UPDATE`, tenantID, subscriber.ID, resolved.ID)); errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrEmailActivationUnavailable
		} else if err != nil {
			return nil, err
		}
	}
	if err := ensureCanonicalSubscriberEmailInTx(ctx, tx, tenantID, subscriber); err != nil {
		return nil, err
	}
	resolved, _, err = lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, subscriber.ID, subscriber.Email,
	)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, ErrNotFound
	}
	return resolved, nil
}

// rotateCanonicalSubscriberEmailInTx reconciles a subscriber PATCH email
// rotation with the multi-email junction. If the new address already exists
// on this profile, its own consent/suppression evidence follows it. A genuinely
// new address replaces the prior canonical row and starts never_subscribed;
// consent never transfers merely because an operator changed an identifier.
func rotateCanonicalSubscriberEmailInTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, oldEmail, newEmail string,
) error {
	if strings.EqualFold(oldEmail, newEmail) {
		return nil
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET is_primary = false, updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND is_primary`, tenantID, subscriberID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_emails
   SET is_primary = true, updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, subscriberID, newEmail)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	tag, err = tx.Exec(ctx, `
UPDATE subscriber_emails
   SET email = $4,
       is_primary = true,
       consent_status = 'never_subscribed',
       suppressed = false,
       last_engaged_at = NULL,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, subscriberID, oldEmail, newEmail)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var count int
		if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID).Scan(&count); err != nil {
			return err
		}
		if count >= MaxEmailsPerProfile {
			return ErrEmailLimitReached
		}
		_, err = tx.Exec(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status)
VALUES ($1::uuid, $2::uuid, $3, true, 'never_subscribed')`, tenantID, subscriberID, newEmail)
		return err
	}
	return nil
}

func lockSubscriberEmailIdentity(ctx context.Context, tx pgx.Tx, tenantID, identity string) (string, error) {
	var locked string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, identity).Scan(&locked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return locked, nil
}

func hasConsentProvenance(in ConsentProvenanceInput) bool {
	return strings.TrimSpace(in.Source) != "" ||
		strings.TrimSpace(in.Channel) != "" ||
		strings.TrimSpace(in.LegalBasis) != "" ||
		in.OccurredAt != nil ||
		strings.TrimSpace(in.Jurisdiction) != "" ||
		strings.TrimSpace(in.Evidence) != "" ||
		strings.TrimSpace(in.Reason) != "" ||
		strings.TrimSpace(in.PolicyVersion) != ""
}

// normalizeEmailConsentIntent keeps omission distinct from an explicit
// assertion. Omitted add consent becomes never_subscribed; every explicit
// status needs a complete reviewed evidence envelope, including revocations
// and non-decision imports. This prevents a JSON default from fabricating a
// marketing grant.
func normalizeEmailConsentIntent(
	raw *string,
	provenance ConsentProvenanceInput,
	fallback string,
) (status string, normalized *ConsentProvenanceInput, explicit bool, err error) {
	if raw == nil {
		if hasConsentProvenance(provenance) {
			return "", nil, false, fmt.Errorf("%w: consent_status is required when consent evidence is supplied", ErrInvalidInput)
		}
		return fallback, nil, false, nil
	}
	if strings.TrimSpace(*raw) == "" {
		return "", nil, false, fmt.Errorf("%w: consent_status cannot be empty", ErrInvalidInput)
	}
	status, err = normalizeConsentStatus(*raw, "")
	if err != nil {
		return "", nil, false, err
	}
	if err := normalizeConsentProvenance(&provenance, true); err != nil {
		return "", nil, false, fmt.Errorf("%w: %s", ErrInvalidInput, err.Error())
	}
	return status, &provenance, true, nil
}

func normalizeEmailSuppressionIntent(in *UpdateEmailInput) (bool, error) {
	if in == nil {
		return false, fmt.Errorf("%w: request is required", ErrInvalidInput)
	}
	reason := strings.TrimSpace(in.SuppressionReason)
	evidence := strings.TrimSpace(in.SuppressionEvidence)
	if in.Suppressed == nil {
		if reason != "" || evidence != "" {
			return false, fmt.Errorf("%w: suppressed is required when suppression evidence is supplied", ErrInvalidInput)
		}
		return false, nil
	}
	if reason == "" || len([]rune(reason)) > 500 {
		return false, fmt.Errorf("%w: suppression_reason is required and must be 500 characters or fewer", ErrInvalidInput)
	}
	if len([]rune(evidence)) > 2048 {
		return false, fmt.Errorf("%w: suppression_evidence must be 2048 characters or fewer", ErrInvalidInput)
	}
	if !*in.Suppressed && evidence == "" {
		return false, fmt.Errorf("%w: suppression_evidence is required to unsuppress an address", ErrInvalidInput)
	}
	in.SuppressionReason = reason
	in.SuppressionEvidence = evidence
	return true, nil
}

func emailConsentEventAction(status string) string {
	switch status {
	case "subscribed":
		return "granted"
	case "unsubscribed":
		return "revoked"
	default:
		return "imported"
	}
}

func emailConsentProofStatus(status string) string {
	switch status {
	case "subscribed":
		return "granted"
	case "unsubscribed":
		return "withdrawn"
	case "pending":
		return "pending"
	default:
		return ""
	}
}

func emailConsentProofSource(source string) string {
	switch source {
	case "signed_form":
		return "form"
	case "direct_request":
		return "admin"
	case "double_optin", "single_optin", "preference_center":
		return source
	default:
		return "api"
	}
}

func recordEmailConsentEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	subscriber *Subscriber,
	address *SubscriberEmail,
	status string,
	provenance ConsentProvenanceInput,
	operation string,
	auditMeta db.AuditMeta,
) (string, error) {
	operation = strings.TrimSpace(operation)
	if operation == "" {
		operation = "multi_email_address_consent"
	}
	// Before the evidence lands, so the certified fold this insert triggers
	// has a channel row to write the decision into.
	if err := ensureEmailChannelConsentProjectionRow(ctx, tx, tenantID, subscriber, address); err != nil {
		return "", err
	}
	preferences := map[string]any{
		"legal_basis":    provenance.LegalBasis,
		"jurisdiction":   provenance.Jurisdiction,
		"reason":         provenance.Reason,
		"operation":      operation,
		"subscriber_id":  subscriber.ID,
		"address_id":     address.ID,
		"consent_status": status,
	}
	eventID, err := consent.RecordEventInTx(ctx, tx, consent.EventInput{
		TenantID:      tenantID,
		SubjectType:   "subscriber",
		SubjectID:     address.ID,
		SubjectEmail:  address.Email,
		Channel:       provenance.Channel,
		Category:      "email_marketing",
		Action:        emailConsentEventAction(status),
		Source:        provenance.Source,
		PolicyVersion: provenance.PolicyVersion,
		IP:            auditMeta.IP,
		UserAgent:     auditMeta.UserAgent,
		ProofText:     provenance.Evidence,
		Preferences:   preferences,
		OccurredAt:    provenance.OccurredAt,
	})
	if err != nil {
		return "", fmt.Errorf("record per-address consent event: %w", err)
	}
	proofStatus := emailConsentProofStatus(status)
	if proofStatus == "" {
		return eventID, nil
	}
	evidenceRaw, err := json.Marshal(map[string]any{
		"event_id":       eventID,
		"address_id":     address.ID,
		"operation":      operation,
		"legal_basis":    provenance.LegalBasis,
		"jurisdiction":   provenance.Jurisdiction,
		"reason":         provenance.Reason,
		"policy_version": provenance.PolicyVersion,
		"evidence":       provenance.Evidence,
	})
	if err != nil {
		return "", fmt.Errorf("encode per-address consent proof: %w", err)
	}
	var ip any
	if parsed := net.ParseIP(strings.TrimSpace(auditMeta.IP)); parsed != nil {
		ip = parsed.String()
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records
       (tenant_id, subscriber_id, email, channel, consent_status, source,
        ip_addr, user_agent, captured_at, evidence)
VALUES ($1::uuid, $2::uuid, $3, 'email', $4, $5,
        $6::inet, NULLIF($7, ''), $8, $9::jsonb)`,
		tenantID, subscriber.ID, address.Email, proofStatus,
		emailConsentProofSource(provenance.Source), ip, auditMeta.UserAgent,
		provenance.OccurredAt, string(evidenceRaw)); err != nil {
		return "", fmt.Errorf("record structured per-address consent proof: %w", err)
	}
	return eventID, nil
}

func ensureEmailSafetySuppression(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	address *SubscriberEmail,
	operation, reason, evidence string,
) error {
	metadataRaw, err := json.Marshal(map[string]any{
		"operation":           operation,
		"subscriber_id":       address.SubscriberID,
		"subscriber_email_id": address.ID,
		"reason":              strings.TrimSpace(reason),
		"evidence":            strings.TrimSpace(evidence),
	})
	if err != nil {
		return fmt.Errorf("encode address suppression evidence: %w", err)
	}
	// Never overwrite a bounce, complaint, erasure, or another owner's
	// suppression. The canonical table has one row per address; an existing
	// stronger row already withholds delivery and must retain its provenance.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions
       (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'list_manual', 'api', $3::jsonb)
ON CONFLICT (tenant_id, email) DO NOTHING`, tenantID, address.Email, string(metadataRaw)); err != nil {
		return fmt.Errorf("record address suppression: %w", err)
	}
	return nil
}

func clearReviewedEmailSuppression(ctx context.Context, tx pgx.Tx, tenantID, email string) error {
	if _, err := tx.Exec(ctx, `
DELETE FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
   AND source = 'api'
   AND metadata ->> 'operation' = 'multi_email_address_suppression'`, tenantID, email); err != nil {
		return fmt.Errorf("clear reviewed address suppression: %w", err)
	}
	var stillSuppressed bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM v_suppressions_unified
     WHERE tenant_id = $1::uuid
       AND lower(email) = lower($2)
       AND (expires_at IS NULL OR expires_at > now())
)`, tenantID, email).Scan(&stillSuppressed); err != nil {
		return fmt.Errorf("verify remaining address suppressions: %w", err)
	}
	if stillSuppressed {
		return ErrProtectedEmailSuppression
	}
	return nil
}

// clearEmailConsentStatusSuppression removes only the reversible hold created
// by this component's prior non-subscribed decision. Bounce, complaint,
// erasure, manually reviewed address holds, and other owners remain intact and
// continue to block through the unified suppression gate.
func clearEmailConsentStatusSuppression(ctx context.Context, tx pgx.Tx, tenantID, email string) error {
	if _, err := tx.Exec(ctx, `
DELETE FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
   AND source = 'api'
   AND metadata ->> 'operation' = 'multi_email_consent_status'`, tenantID, email); err != nil {
		return fmt.Errorf("clear address consent-status suppression: %w", err)
	}
	return nil
}

func fireEmailConsentWebhook(
	ctx context.Context,
	repo *Repo,
	tx pgx.Tx,
	tenantID string,
	subscriber *Subscriber,
	address *SubscriberEmail,
	eventID string,
) error {
	if repo == nil || repo.Webhooks == nil {
		return nil
	}
	if _, err := repo.Webhooks.Fire(ctx, tx, WebhookFireInput{
		TenantID:  tenantID,
		EventType: EventSubscriberConsentChanged,
		Body: map[string]any{
			"id":               subscriber.ID,
			"email":            subscriber.Email,
			"email_address_id": address.ID,
			"address":          address.Email,
			"consent_status":   address.ConsentStatus,
			"consent_event_id": eventID,
		},
		IdempotencyKey: "subscriber-email-consent:" + eventID,
	}); err != nil {
		return fmt.Errorf("dispatch per-address consent webhook: %w", err)
	}
	return nil
}

func normalizeConsentStatus(raw, fallback string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		return fallback, nil
	}
	switch v {
	// SUB-044: 'never_subscribed' is the third meaningful state — the address
	// was added but the contact has never opted in (distinct from 'unknown',
	// which means "no recorded signal either way"). Mirrors the widened
	// subscriber_emails.consent_status CHECK (migration 0500).
	case "subscribed", "unsubscribed", "pending", "unknown", "never_subscribed":
		return v, nil
	default:
		return "", fmt.Errorf("%w: consent_status must be one of subscribed|unsubscribed|pending|unknown|never_subscribed", ErrInvalidInput)
	}
}

func isUniqueViolation(err error) bool {
	type pgxErrorWithCode interface{ SQLState() string }
	var coder pgxErrorWithCode
	if errors.As(err, &coder) {
		return coder.SQLState() == "23505"
	}
	return false
}

func scanSubscriberEmails(rows pgx.Rows) ([]SubscriberEmail, error) {
	defer rows.Close()
	out := []SubscriberEmail{}
	for rows.Next() {
		e, err := scanSubscriberEmail(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

func scanSubscriberEmail(row scanner) (*SubscriberEmail, error) {
	var e SubscriberEmail
	if err := row.Scan(&e.ID, &e.SubscriberID, &e.Email, &e.IsPrimary,
		&e.ConsentStatus, &e.Suppressed, &e.LastEngagedAt, &e.CreatedAt, &e.UpdatedAt); err != nil {
		return nil, err
	}
	e.Version = httpcache.ConcurrencyToken("subscriber-email", e.ID, e.UpdatedAt)
	return &e, nil
}
