// SPDX-License-Identifier: AGPL-3.0-only
package settings

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// RetentionPolicy is the per-tenant projection. Wire shape mirrors the
// schema 1:1. The new "extended" knobs (engagement / inbound /
// webhook / form / export grace) landed in migration 0238 and are
// nullable on the table — exposed here as pointers so callers can
// distinguish "not set, use default" from "explicitly 0".
type RetentionPolicy struct {
	TenantID                            string    `json:"tenant_id"`
	AuditLogRetentionDays               int       `json:"audit_log_retention_days"`
	EmailEventRetentionDays             int       `json:"email_event_retention_days"`
	UnsubscribedSubscriberRetentionDays int       `json:"unsubscribed_subscriber_retention_days"`
	EngagementEventRetentionDays        *int      `json:"engagement_event_retention_days,omitempty"`
	InboundEmailRetentionDays           *int      `json:"inbound_email_retention_days,omitempty"`
	WebhookDeliveryRetentionDays        *int      `json:"webhook_delivery_retention_days,omitempty"`
	FormSubmissionRetentionDays         *int      `json:"form_submission_retention_days,omitempty"`
	ExportGraceDays                     *int      `json:"export_grace_days,omitempty"`
	UpdatedByUserID                     *string   `json:"updated_by_user_id,omitempty"`
	UpdatedAt                           time.Time `json:"updated_at"`
}

// Default values mirror the column defaults in migration 0084 plus the
// new knobs added in migration 0238 (which are nullable on the table —
// these defaults are the Go-side fallback when the column is NULL).
const (
	defaultAuditLogRetentionDays        = 90
	defaultEmailEventRetentionDays      = 365
	defaultUnsubRetentionDays           = 730
	defaultEngagementEventRetentionDays = 365
	defaultInboundEmailRetentionDays    = 90
	defaultWebhookDeliveryRetentionDays = 30
	defaultFormSubmissionRetentionDays  = 365
	defaultExportGraceDays              = 7

	auditLogMin        = 7
	auditLogMax        = 2555
	emailEventMin      = 30
	emailEventMax      = 2555
	unsubMin           = 7
	unsubMax           = 3650
	engagementEventMin = 30
	engagementEventMax = 2555
	inboundEmailMin    = 7
	inboundEmailMax    = 2555
	webhookDeliveryMin = 7
	webhookDeliveryMax = 2555
	formSubmissionMin  = 30
	formSubmissionMax  = 2555
	exportGraceMin     = 0
	exportGraceMax     = 365
)

// PrivacyRepo wraps the retention_policies table.
type PrivacyRepo struct{ Pool *db.Pool }

// ErrPrivacyNotFound is returned when a tenant has no row.
var ErrPrivacyNotFound = errors.New("settings: retention policy not found")

func defaultRetention(tenantID string) RetentionPolicy {
	return RetentionPolicy{
		TenantID:                            tenantID,
		AuditLogRetentionDays:               defaultAuditLogRetentionDays,
		EmailEventRetentionDays:             defaultEmailEventRetentionDays,
		UnsubscribedSubscriberRetentionDays: defaultUnsubRetentionDays,
	}
}

// Get loads the retention row. ErrPrivacyNotFound when absent.
func (r *PrivacyRepo) Get(ctx context.Context, tenantID string) (*RetentionPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
SELECT tenant_id::text, audit_log_retention_days, email_event_retention_days,
       unsubscribed_subscriber_retention_days,
       engagement_event_retention_days, inbound_email_retention_days,
       webhook_delivery_retention_days, form_submission_retention_days,
       export_grace_days,
       updated_by_user_id::text, updated_at
FROM retention_policies
WHERE tenant_id = $1::uuid`
	var rp RetentionPolicy
	var updater *string
	err = tx.QueryRow(ctx, q, tenantID).Scan(
		&rp.TenantID, &rp.AuditLogRetentionDays, &rp.EmailEventRetentionDays,
		&rp.UnsubscribedSubscriberRetentionDays,
		&rp.EngagementEventRetentionDays, &rp.InboundEmailRetentionDays,
		&rp.WebhookDeliveryRetentionDays, &rp.FormSubmissionRetentionDays,
		&rp.ExportGraceDays,
		&updater, &rp.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrPrivacyNotFound
		}
		return nil, err
	}
	if updater != nil && *updater != "" {
		rp.UpdatedByUserID = updater
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &rp, nil
}

// AuditLogRetentionDays is the helper the audit-log-trim sweeper calls
// per-tenant. Returns the per-tenant value, or the package default if no
// row exists. Always returns a sane positive value.
//
// Historical: there used to be no audit-log-trim cron and this comment
// noted that gap. The sweeper now lives at
// apps/api/internal/audit/trim.go (audit.Trimmer) and consumes this
// helper through the PrivacyReader interface — see main.go around the
// `auditTrimmer := &audit.Trimmer{...}` wire-up. Comment retained for
// context on why the signature returns int + sane fallbacks rather
// than the raw row value.
func (r *PrivacyRepo) AuditLogRetentionDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultAuditLogRetentionDays, nil
		}
		return 0, err
	}
	if rp.AuditLogRetentionDays <= 0 {
		return defaultAuditLogRetentionDays, nil
	}
	return rp.AuditLogRetentionDays, nil
}

// EmailEventRetentionDays returns the tenant's engagement/raw-provider payload
// retention window, defaulting safely when the row has not been created yet.
func (r *PrivacyRepo) EmailEventRetentionDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultEmailEventRetentionDays, nil
		}
		return 0, err
	}
	if rp.EmailEventRetentionDays <= 0 {
		return defaultEmailEventRetentionDays, nil
	}
	return rp.EmailEventRetentionDays, nil
}

// UnsubscribedSubscriberRetentionDays returns the per-tenant window
// after which a row in subscribers whose status went 'disabled' /
// 'blocklisted' should be hard-deleted by the retention sweeper.
func (r *PrivacyRepo) UnsubscribedSubscriberRetentionDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultUnsubRetentionDays, nil
		}
		return 0, err
	}
	if rp.UnsubscribedSubscriberRetentionDays <= 0 {
		return defaultUnsubRetentionDays, nil
	}
	return rp.UnsubscribedSubscriberRetentionDays, nil
}

// EngagementEventRetentionDays returns the per-tenant window after
// which opens / clicks / engagement_events rows are pruned. Falls
// back to the package default when the column is NULL or the row
// doesn't exist.
func (r *PrivacyRepo) EngagementEventRetentionDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultEngagementEventRetentionDays, nil
		}
		return 0, err
	}
	if rp.EngagementEventRetentionDays == nil || *rp.EngagementEventRetentionDays <= 0 {
		return defaultEngagementEventRetentionDays, nil
	}
	return *rp.EngagementEventRetentionDays, nil
}

// InboundEmailRetentionDays governs how long the raw MIME body + html
// + subject of inbound_emails is kept before the sweeper NULLs the
// content columns out.
func (r *PrivacyRepo) InboundEmailRetentionDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultInboundEmailRetentionDays, nil
		}
		return 0, err
	}
	if rp.InboundEmailRetentionDays == nil || *rp.InboundEmailRetentionDays <= 0 {
		return defaultInboundEmailRetentionDays, nil
	}
	return *rp.InboundEmailRetentionDays, nil
}

// WebhookDeliveryRetentionDays controls deletion of finalised
// outbound_webhook_deliveries rows.
func (r *PrivacyRepo) WebhookDeliveryRetentionDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultWebhookDeliveryRetentionDays, nil
		}
		return 0, err
	}
	if rp.WebhookDeliveryRetentionDays == nil || *rp.WebhookDeliveryRetentionDays <= 0 {
		return defaultWebhookDeliveryRetentionDays, nil
	}
	return *rp.WebhookDeliveryRetentionDays, nil
}

// FormSubmissionRetentionDays governs hard deletion of form_submissions
// rows past their retention window.
func (r *PrivacyRepo) FormSubmissionRetentionDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultFormSubmissionRetentionDays, nil
		}
		return 0, err
	}
	if rp.FormSubmissionRetentionDays == nil || *rp.FormSubmissionRetentionDays <= 0 {
		return defaultFormSubmissionRetentionDays, nil
	}
	return *rp.FormSubmissionRetentionDays, nil
}

// ExportGraceDays is the post-expires_at grace window the
// tenant_exports sweeper waits before deleting expired bundles.
func (r *PrivacyRepo) ExportGraceDays(ctx context.Context, tenantID string) (int, error) {
	rp, err := r.Get(ctx, tenantID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			return defaultExportGraceDays, nil
		}
		return 0, err
	}
	if rp.ExportGraceDays == nil || *rp.ExportGraceDays < 0 {
		return defaultExportGraceDays, nil
	}
	return *rp.ExportGraceDays, nil
}

// PrivacyPatch is the wire-shape for PATCH. Pointers so missing fields
// are left alone.
type PrivacyPatch struct {
	AuditLogRetentionDays               *int `json:"audit_log_retention_days,omitempty"`
	EmailEventRetentionDays             *int `json:"email_event_retention_days,omitempty"`
	UnsubscribedSubscriberRetentionDays *int `json:"unsubscribed_subscriber_retention_days,omitempty"`
	EngagementEventRetentionDays        *int `json:"engagement_event_retention_days,omitempty"`
	InboundEmailRetentionDays           *int `json:"inbound_email_retention_days,omitempty"`
	WebhookDeliveryRetentionDays        *int `json:"webhook_delivery_retention_days,omitempty"`
	FormSubmissionRetentionDays         *int `json:"form_submission_retention_days,omitempty"`
	ExportGraceDays                     *int `json:"export_grace_days,omitempty"`
}

// Upsert applies the patch atomically. First insert pulls defaults; subsequent
// updates COALESCE missing fields onto current values.
func (r *PrivacyRepo) Upsert(ctx context.Context, tenantID, userID string, patch PrivacyPatch) (*RetentionPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
INSERT INTO retention_policies
    (tenant_id, audit_log_retention_days, email_event_retention_days,
     unsubscribed_subscriber_retention_days,
     engagement_event_retention_days, inbound_email_retention_days,
     webhook_delivery_retention_days, form_submission_retention_days,
     export_grace_days,
     updated_by_user_id, updated_at)
VALUES
    ($1::uuid, COALESCE($2, 90), COALESCE($3, 365), COALESCE($4, 730),
     $5, $6, $7, $8, $9,
     NULLIF($10,'')::uuid, now())
ON CONFLICT (tenant_id) DO UPDATE SET
    audit_log_retention_days               = COALESCE(EXCLUDED.audit_log_retention_days,               retention_policies.audit_log_retention_days),
    email_event_retention_days             = COALESCE(EXCLUDED.email_event_retention_days,             retention_policies.email_event_retention_days),
    unsubscribed_subscriber_retention_days = COALESCE(EXCLUDED.unsubscribed_subscriber_retention_days, retention_policies.unsubscribed_subscriber_retention_days),
    engagement_event_retention_days        = COALESCE(EXCLUDED.engagement_event_retention_days,        retention_policies.engagement_event_retention_days),
    inbound_email_retention_days           = COALESCE(EXCLUDED.inbound_email_retention_days,           retention_policies.inbound_email_retention_days),
    webhook_delivery_retention_days        = COALESCE(EXCLUDED.webhook_delivery_retention_days,        retention_policies.webhook_delivery_retention_days),
    form_submission_retention_days         = COALESCE(EXCLUDED.form_submission_retention_days,         retention_policies.form_submission_retention_days),
    export_grace_days                      = COALESCE(EXCLUDED.export_grace_days,                      retention_policies.export_grace_days),
    updated_by_user_id                     = COALESCE(EXCLUDED.updated_by_user_id,                     retention_policies.updated_by_user_id),
    updated_at                             = now()
RETURNING tenant_id::text, audit_log_retention_days, email_event_retention_days,
          unsubscribed_subscriber_retention_days,
          engagement_event_retention_days, inbound_email_retention_days,
          webhook_delivery_retention_days, form_submission_retention_days,
          export_grace_days,
          updated_by_user_id::text, updated_at`
	var (
		out     RetentionPolicy
		updater *string
	)
	err = tx.QueryRow(ctx, q,
		tenantID, patch.AuditLogRetentionDays, patch.EmailEventRetentionDays,
		patch.UnsubscribedSubscriberRetentionDays,
		patch.EngagementEventRetentionDays, patch.InboundEmailRetentionDays,
		patch.WebhookDeliveryRetentionDays, patch.FormSubmissionRetentionDays,
		patch.ExportGraceDays,
		userID,
	).Scan(
		&out.TenantID, &out.AuditLogRetentionDays, &out.EmailEventRetentionDays,
		&out.UnsubscribedSubscriberRetentionDays,
		&out.EngagementEventRetentionDays, &out.InboundEmailRetentionDays,
		&out.WebhookDeliveryRetentionDays, &out.FormSubmissionRetentionDays,
		&out.ExportGraceDays,
		&updater, &out.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if updater != nil && *updater != "" {
		out.UpdatedByUserID = updater
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// PrivacyDeps mounts the retention HTTP surface.
type PrivacyDeps struct {
	Repo   *PrivacyRepo
	Logger *slog.Logger
}

// MountRoutes wires GET/PATCH /api/v1/settings/privacy. Retention
// policies are tenant-wide and affect downstream audit-log trimmer +
// email-event purger sweepers, so writes are gated on the admin
// scope. Reads remain open to any authenticated tenant member.
func (d *PrivacyDeps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/settings/privacy", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/settings/privacy", d.Patch)
}

// Get GET /api/v1/settings/privacy.
func (d *PrivacyDeps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	rp, err := d.Repo.Get(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrPrivacyNotFound) {
			writeJSON(w, http.StatusOK, defaultRetention(t.ID))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rp)
}

// Patch PATCH /api/v1/settings/privacy.
func (d *PrivacyDeps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	userID := ""
	if u, _ := middleware.UserFromContext(r.Context()); u != nil {
		userID = u.ID
	}
	var in PrivacyPatch
	if err := httpbody.DecodeJSON(w, r, settingsJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns either "bad_json" or "payload_too_large" — both are
		// in httperror.IsValidationCode allowlist (operator-authored text).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.AuditLogRetentionDays != nil {
		v := *in.AuditLogRetentionDays
		if v < auditLogMin || v > auditLogMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_audit_log_retention",
				"audit_log_retention_days must be between 7 and 2555"))
			return
		}
	}
	if in.EmailEventRetentionDays != nil {
		v := *in.EmailEventRetentionDays
		if v < emailEventMin || v > emailEventMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_email_event_retention",
				"email_event_retention_days must be between 30 and 2555"))
			return
		}
	}
	if in.UnsubscribedSubscriberRetentionDays != nil {
		v := *in.UnsubscribedSubscriberRetentionDays
		if v < unsubMin || v > unsubMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_unsub_retention",
				"unsubscribed_subscriber_retention_days must be between 7 and 3650"))
			return
		}
	}
	if in.EngagementEventRetentionDays != nil {
		v := *in.EngagementEventRetentionDays
		if v < engagementEventMin || v > engagementEventMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_engagement_retention",
				"engagement_event_retention_days must be between 30 and 2555"))
			return
		}
	}
	if in.InboundEmailRetentionDays != nil {
		v := *in.InboundEmailRetentionDays
		if v < inboundEmailMin || v > inboundEmailMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_inbound_email_retention",
				"inbound_email_retention_days must be between 7 and 2555"))
			return
		}
	}
	if in.WebhookDeliveryRetentionDays != nil {
		v := *in.WebhookDeliveryRetentionDays
		if v < webhookDeliveryMin || v > webhookDeliveryMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_webhook_delivery_retention",
				"webhook_delivery_retention_days must be between 7 and 2555"))
			return
		}
	}
	if in.FormSubmissionRetentionDays != nil {
		v := *in.FormSubmissionRetentionDays
		if v < formSubmissionMin || v > formSubmissionMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_form_submission_retention",
				"form_submission_retention_days must be between 30 and 2555"))
			return
		}
	}
	if in.ExportGraceDays != nil {
		v := *in.ExportGraceDays
		if v < exportGraceMin || v > exportGraceMax {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_export_grace",
				"export_grace_days must be between 0 and 365"))
			return
		}
	}
	before, _ := d.Repo.Get(r.Context(), t.ID)
	out, err := d.Repo.Upsert(r.Context(), t.ID, userID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	emitSettingsAudit(r.Context(), d.Repo.Pool, r, t.ID,
		"settings.privacy.updated", "retention_policy", t.ID, before, out)
	writeJSON(w, http.StatusOK, out)
}
