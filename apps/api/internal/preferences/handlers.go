// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles dependencies for handler wiring.
type Deps struct {
	Repo *Repo
	// OneClickSuppressor is the optional production bridge for the RFC 8058
	// atomic suppression + consent-evidence mutation. When unset, the handler
	// uses an in-package transaction with the same core invariant; topic state
	// remains a secondary projection.
	OneClickSuppressor OneClickSuppressor
	// UnsubscribeFanout, when set, is invoked after a one-click
	// unsubscribe has been honored so outbound webhooks subscribed
	// to "subscriber.unsubscribed" fire. Nil-safe: tests + dev wire
	// nil and the handler skips the publish. The consent_events
	// ledger is the persistent record either way — fanout is the
	// real-time mirror for partner integrations.
	UnsubscribeFanout UnsubscribeFanout
	// Logger is used by httperror.WriteInternal to record server-side
	// error context (tenant_id, request_id, err) without leaking err
	// text in the HTTP response. May be nil in tests; httperror tolerates
	// that.
	Logger *slog.Logger
}

// UnsubscribeFanout is the narrow contract the one-click path needs
// from the events bus. Defined here so preferences doesn't import
// events directly. The production implementation in main.go just
// calls events.Bus.Publish with topic="subscriber.unsubscribed".
type UnsubscribeFanout interface {
	PublishUnsubscribe(tenantID, email, source string)
}

// OneClickEvidence is optional request provenance captured with the durable
// suppression transition. Both fields are pre-sanitized at the public boundary
// so an attacker-controlled header cannot block an opt-out.
type OneClickEvidence struct {
	IP        string
	UserAgent string
}

// OneClickSuppressor is the narrow atomic mutation contract the RFC 8058
// handler depends on. Production commits the suppression, consent revocation,
// and customer-webhook intent in one tenant transaction.
type OneClickSuppressor interface {
	Add(ctx context.Context, tenantID, email, reason string, evidence OneClickEvidence) error
}

const preferenceJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// ---------- topics admin (tenant-scoped) ----------

// ListTopics GET /api/v1/topics
func (d *Deps) ListTopics(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListTopics(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateTopic POST /api/v1/topics
func (d *Deps) CreateTopic(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateTopicInput
	if err := httpbody.DecodeJSON(w, r, preferenceJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	normalizeCreateTopicInput(&in)
	if err := validateCreateTopicInput(&in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.CreateTopic(r.Context(), t.ID, in)
	if err != nil {
		if isInvalidTopicError(err) {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		if errors.Is(err, ErrSlugConflict) {
			httperror.Write(w, http.StatusConflict, "slug_taken", ErrSlugConflict.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// UpdateTopic PATCH /api/v1/topics/{id}
func (d *Deps) UpdateTopic(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateTopicInput
	if err := httpbody.DecodeJSON(w, r, preferenceJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	normalizeUpdateTopicInput(&in)
	if err := validateUpdateTopicInput(&in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.UpdateTopic(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrSlugConflict):
			httperror.Write(w, http.StatusConflict, "slug_taken", ErrSlugConflict.Error())
		case isInvalidTopicError(err):
			httperror.WriteValidation(w, "validation_failed", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteTopic DELETE /api/v1/topics/{id}
func (d *Deps) DeleteTopic(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.DeleteTopic(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- subscriber topics admin (tenant-scoped) ----------

// ListSubscriberTopics GET /api/v1/subscribers/{email}/topics
func (d *Deps) ListSubscriberTopics(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	email := strings.ToLower(chi.URLParam(r, "email"))
	if email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_email", ""))
		return
	}
	out, err := d.Repo.ListSubscriberTopics(r.Context(), t.ID, email)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// PutSubscriberTopics PUT /api/v1/subscribers/{email}/topics
func (d *Deps) PutSubscriberTopics(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	email := strings.ToLower(chi.URLParam(r, "email"))
	if email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_email", ""))
		return
	}
	var in struct {
		Topics []TopicOptIn `json:"topics"`
	}
	if err := httpbody.DecodeJSON(w, r, preferenceJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateTopicOptIns(in.Topics); err != nil {
		httperror.WriteValidation(w, "validation_failed", "topic selections must contain unique canonical topic UUIDs")
		return
	}
	if err := d.Repo.ReplaceSubscriberTopics(r.Context(), t.ID, email, in.Topics); err != nil {
		if errors.Is(err, ErrInvalidTopicChoice) {
			httperror.WriteValidation(w, "validation_failed", "one or more topics are not available in this workspace")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func normalizeCreateTopicInput(in *CreateTopicInput) {
	if in.DefaultOptInSnake != nil {
		in.DefaultOptIn = *in.DefaultOptInSnake
	}
	if in.DisplayOrderSnake != nil {
		in.DisplayOrder = *in.DisplayOrderSnake
	}
}

func normalizeUpdateTopicInput(in *UpdateTopicInput) {
	if in.DefaultOptInSnake != nil {
		in.DefaultOptIn = in.DefaultOptInSnake
	}
	if in.DisplayOrderSnake != nil {
		in.DisplayOrder = in.DisplayOrderSnake
	}
}

// SubscribeSubscriberTopic POST /api/v1/subscribers/{email}/topics/{topicId}/subscribe
func (d *Deps) SubscribeSubscriberTopic(w http.ResponseWriter, r *http.Request) {
	d.setSingleSubscriberTopic(w, r, true)
}

// UnsubscribeSubscriberTopic POST /api/v1/subscribers/{email}/topics/{topicId}/unsubscribe
func (d *Deps) UnsubscribeSubscriberTopic(w http.ResponseWriter, r *http.Request) {
	d.setSingleSubscriberTopic(w, r, false)
}

func (d *Deps) setSingleSubscriberTopic(w http.ResponseWriter, r *http.Request, optedIn bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	email := strings.ToLower(chi.URLParam(r, "email"))
	if email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_email", ""))
		return
	}
	topicID := chi.URLParam(r, "topicId")
	if topicID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_topic_id", ""))
		return
	}
	items := []TopicOptIn{{
		TopicID: topicID,
		OptedIn: optedIn,
	}}
	if err := validateTopicOptIns(items); err != nil {
		httperror.WriteValidation(w, "validation_failed", "topic must be a canonical UUID")
		return
	}
	if err := d.Repo.ReplaceSubscriberTopics(r.Context(), t.ID, email, items); err != nil {
		if errors.Is(err, ErrInvalidTopicChoice) {
			httperror.WriteValidation(w, "validation_failed", "topic is not available in this workspace")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- public hosted preference page ----------

// PublicLookup GET /api/public/preferences/{token}
func (d *Deps) PublicLookup(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_token", ""))
		return
	}
	pt, err := d.Repo.LookupToken(r.Context(), token)
	if err != nil {
		switch {
		case errors.Is(err, ErrTokenExpired):
			writeJSON(w, http.StatusGone, errEnv("token_expired", "preference link expired"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such token"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	views, err := d.Repo.PublicListSubscriberTopics(r.Context(), pt.TenantID, pt.SubscriberEmail)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// SUB-043: surface the GPC acknowledgement on the hosted preference page so
	// a subscriber whose browser sent a Global Privacy Control signal sees that
	// we honour it (mandatory in CA from 2026-01-01).
	gpc, err := d.Repo.PublicTrackingPrefsGPC(r.Context(), pt.TenantID, pt.SubscriberEmail)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	frequency, pausedUntil, err := d.Repo.PublicFrequencyState(r.Context(), pt.TenantID, pt.SubscriberEmail)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	customization, err := d.Repo.PublicPreferenceCustomization(r.Context(), pt.TenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, PublicLookupResponse{
		Email:               pt.SubscriberEmail,
		ExpiresAt:           pt.ExpiresAt,
		Topics:              views,
		FrequencyPreference: frequency,
		PausedUntil:         pausedUntil,
		GPC:                 gpc,
		Customization:       customization,
	})
}

// PublicUpdate POST /api/public/preferences/{token}
func (d *Deps) PublicUpdate(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_token", ""))
		return
	}
	pt, err := d.Repo.LookupToken(r.Context(), token)
	if err != nil {
		switch {
		case errors.Is(err, ErrTokenExpired):
			writeJSON(w, http.StatusGone, errEnv("token_expired", "preference link expired"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such token"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	var in PublicUpdateInput
	if err := httpbody.DecodeJSON(w, r, preferenceJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode's allowlist (bad_json, payload_too_large).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateTopicOptIns(in.Topics); err != nil {
		httperror.WriteValidation(w, "validation_failed", "topic selections must contain unique canonical topic UUIDs")
		return
	}
	if err := d.Repo.PublicReplaceSubscriberTopics(r.Context(), pt.TenantID, pt.SubscriberEmail, in.Topics); err != nil {
		if errors.Is(err, ErrInvalidTopicChoice) {
			httperror.WriteValidation(w, "validation_failed", "one or more topics are not available")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- helpers ----------

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
