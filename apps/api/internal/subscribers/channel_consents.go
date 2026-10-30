// SUB-042 — Per-channel consent on one profile.
//
// A single profile can be reached on up to five channels (email, SMS, push,
// WhatsApp, RCS). Until now consent for these lived in separate stores (the
// 0318 consent vector for email, sms_subscriptions for SMS, ...). This surface
// consolidates them into one row per (profile, channel) in the
// subscriber_channel_consents table (migration 0488), each carrying its own
// status / consent timestamp / source plus a shared frequency cap, so an
// operator can see and manage all five channels on one profile.
//
// Endpoints (scoped under an existing subscriber id):
//   GET   /api/v1/subscribers/{id}/channel-consents            — list all channels
//   PATCH /api/v1/subscribers/{id}/channel-consents/{channel}  — upsert one channel

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// ChannelConsentChannels is the closed set of channels a profile can carry a
// consent row for. Mirrors the migration 0488 CHECK constraint.
var ChannelConsentChannels = []string{"email", "sms", "push", "whatsapp", "rcs"}

// channelConsentStatuses is the unified consent vocabulary. Mirrors the
// migration 0488 CHECK constraint.
var channelConsentStatuses = []string{"opted_in", "opted_out", "pending", "unknown"}

// MountChannelConsentRoutes registers the SUB-042 per-channel consent
// endpoints. The mutating route is wrapped with observability.RecordSurfaceFunc
// so the pw_subscribers_set_channel_consent_total + duration histogram emit.
func MountChannelConsentRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/channel-consents", d.ListChannelConsents)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/channel-consents/{channel}",
			observability.RecordSurfaceFunc("subscribers", "set_channel_consent", d.SetChannelConsent))
}

func (d *Deps) ListChannelConsents(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	items, subscriberVersion, err := d.Repo.ListChannelConsents(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeChannelConsentErr(w, r, err)
		return
	}
	// The collection read is the authority for the exact parent revision that
	// PATCH requires. Omitting this header made every rendered consent selector
	// send an empty If-Match and fail with 428.
	w.Header().Set("ETag", subscriberVersion)
	writeJSON(w, http.StatusOK, map[string]any{
		"items":              items,
		"subscriber_version": subscriberVersion,
	})
}

func (d *Deps) SetChannelConsent(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ifMatch, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httpcache.WritePreconditionRequired(w)
		return
	}
	var in UpdateChannelConsentInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.IfMatchToken = ifMatch
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	out, err := d.Repo.SetChannelConsentWithAudit(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "channel"), in, auditMeta)
	if err != nil {
		d.writeChannelConsentErr(w, r, err)
		return
	}
	w.Header().Set("ETag", out.SubscriberVersion)
	d.emit(t.ID, "subscriber.channel_consent.updated", map[string]any{
		"subscriber_id": out.SubscriberID,
		"channel":       out.Channel,
		"status":        out.Status,
	})
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) writeChannelConsentErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, ErrProtectedEmailSuppression):
		httperror.Write(w, http.StatusConflict, "protected_suppression",
			"this address has an active complaint, bounce, erasure, or separately reviewed suppression; resolve that hold before granting email consent")
	case errors.Is(err, ErrConcurrentConsentDecision):
		httperror.Write(w, http.StatusConflict, "concurrent_consent_change",
			"another consent or suppression decision is in progress; retry the complete request with the latest subscriber version")
	case errors.Is(err, ErrChannelConsentInfrastructureUnavailable):
		httperror.Write(w, http.StatusServiceUnavailable, "consent_sync_unavailable",
			"consent synchronization is temporarily unavailable; no change was saved")
	default:
		tenantID := ""
		if t, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = t.ID
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

// normalizeChannel validates + canonicalises a channel token.
func normalizeChannel(raw string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	for _, c := range ChannelConsentChannels {
		if v == c {
			return v, nil
		}
	}
	return "", fmt.Errorf("%w: channel must be one of %s", ErrInvalidInput, strings.Join(ChannelConsentChannels, "|"))
}

// normalizeChannelConsentStatus validates a status token. Empty falls back.
func normalizeChannelConsentStatus(raw, fallback string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		return fallback, nil
	}
	for _, s := range channelConsentStatuses {
		if v == s {
			return v, nil
		}
	}
	return "", fmt.Errorf("%w: status must be one of %s", ErrInvalidInput, strings.Join(channelConsentStatuses, "|"))
}

const channelConsentColumns = `id::text, subscriber_id::text, channel, status,
       consent_timestamp, consent_source, frequency_cap_until,
       COALESCE(email::text, ''), COALESCE(phone_e164, ''),
       created_at, updated_at`

// ListChannelConsents returns every channel-consent row for the subscriber,
// ordered by channel for a stable UI presentation.
func (r *Repo) ListChannelConsents(ctx context.Context, tenantID, subscriberID string) ([]ChannelConsent, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, "", err
	}
	rows, err := tx.Query(ctx, `
SELECT `+channelConsentColumns+`
  FROM subscriber_channel_consents
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY channel ASC`, tenantID, sub.ID)
	if err != nil {
		return nil, "", err
	}
	items, err := scanChannelConsents(rows)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return items, sub.Version, nil
}

// SetChannelConsent is the system-attributed repository entrypoint. HTTP
// callers use SetChannelConsentWithAudit so actor identity and request
// provenance commit with the canonical decision.
func (r *Repo) SetChannelConsent(ctx context.Context, tenantID, subscriberID, channelRaw string, in UpdateChannelConsentInput) (*ChannelConsent, error) {
	return r.SetChannelConsentWithAudit(ctx, tenantID, subscriberID, channelRaw, in, db.AuditMeta{
		TenantID:   tenantID,
		ActorType:  "system",
		ActorLabel: "subscriber channel consent",
	})
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func scanChannelConsents(rows pgx.Rows) ([]ChannelConsent, error) {
	defer rows.Close()
	out := []ChannelConsent{}
	for rows.Next() {
		c, err := scanChannelConsent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func scanChannelConsent(row scanner) (*ChannelConsent, error) {
	var c ChannelConsent
	if err := row.Scan(&c.ID, &c.SubscriberID, &c.Channel, &c.Status,
		&c.ConsentTimestamp, &c.ConsentSource, &c.FrequencyCapUntil,
		&c.Email, &c.PhoneE164, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, err
	}
	return &c, nil
}
