// SPDX-License-Identifier: AGPL-3.0-only
//
// Package trigger_delay stores per-subscriber optimized trigger delays for
// automation fanout. The flow trigger can opt in with delay_strategy=optimized;
// track/listmonk fanout then schedules the flow_run in the future instead of
// immediately.
package trigger_delay

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const triggerDelayJSONMaxBodyBytes int64 = 64 << 10
const maxOptimizedDelaySeconds = 30 * 24 * 60 * 60
const maxTriggerDelayEventNameBytes = 256
const maxTriggerDelayReasonBytes = 500

var errInvalidSubscriberID = errors.New("trigger_delay: subscriber_id must be a UUID")
var errInvalidEventName = errors.New("trigger_delay: event_name must be non-empty and 256 bytes or fewer")
var errInvalidReason = errors.New("trigger_delay: reason must be 500 bytes or fewer")

type Repo struct {
	Pool *db.Pool
}

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

type Preference struct {
	TenantID            string    `json:"tenant_id,omitempty"`
	SubscriberID        string    `json:"subscriber_id"`
	EventName           string    `json:"event_name"`
	OptimalDelaySeconds int       `json:"optimal_delay_seconds"`
	SampleCount         int       `json:"sample_count"`
	Confidence          float64   `json:"confidence"`
	Reason              string    `json:"reason,omitempty"`
	ComputedAt          time.Time `json:"computed_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

// PreferenceView is the tenant-safe HTTP representation. Tenant binding is
// authorization context, not subject data, and is never echoed to report
// readers or manual-override writers.
type PreferenceView struct {
	SubscriberID        string    `json:"subscriber_id"`
	EventName           string    `json:"event_name"`
	OptimalDelaySeconds int       `json:"optimal_delay_seconds"`
	SampleCount         int       `json:"sample_count"`
	Confidence          float64   `json:"confidence"`
	Reason              string    `json:"reason,omitempty"`
	ComputedAt          time.Time `json:"computed_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type upsertInput struct {
	SubscriberID        string  `json:"subscriber_id"`
	EventName           string  `json:"event_name"`
	OptimalDelaySeconds int     `json:"optimal_delay_seconds"`
	SampleCount         int     `json:"sample_count,omitempty"`
	Confidence          float64 `json:"confidence,omitempty"`
	Reason              string  `json:"reason,omitempty"`
	ComputedAt          string  `json:"computed_at,omitempty"`
}

// manualOverrideInput is the public write contract. Learned sample,
// confidence, and computation provenance are deliberately absent so an admin
// cannot make a manual override look model-produced.
type manualOverrideInput struct {
	SubscriberID        string `json:"subscriber_id"`
	EventName           string `json:"event_name"`
	OptimalDelaySeconds int    `json:"optimal_delay_seconds"`
	Reason              string `json:"reason,omitempty"`
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports, apikeys.ScopeAdmin)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/trigger-delay/preferences", d.get)
	r.With(admin).Put("/api/v1/trigger-delay/preferences", d.put)
}

func (d *Deps) get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	subscriberID, validSubscriberID := canonicalSubscriberID(r.URL.Query().Get("subscriber_id"))
	eventName := strings.TrimSpace(r.URL.Query().Get("event_name"))
	if strings.TrimSpace(r.URL.Query().Get("subscriber_id")) == "" || eventName == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_params", "subscriber_id and event_name required"))
		return
	}
	if !validSubscriberID {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_subscriber_id", "subscriber_id must be a UUID"))
		return
	}
	if len(eventName) > maxTriggerDelayEventNameBytes {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_event_name", "event_name must be 256 bytes or fewer"))
		return
	}
	out, err := d.Repo.GetPreference(r.Context(), t.ID, subscriberID, eventName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "preference not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, preferenceView(out))
}

func (d *Deps) put(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in manualOverrideInput
	if err := httpbody.DecodeJSON(w, r, triggerDelayJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.SubscriberID) == "" || strings.TrimSpace(in.EventName) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_params", "subscriber_id and event_name required"))
		return
	}
	canonicalID, validSubscriberID := canonicalSubscriberID(in.SubscriberID)
	if !validSubscriberID {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_subscriber_id", "subscriber_id must be a UUID"))
		return
	}
	in.SubscriberID = canonicalID
	if len(strings.TrimSpace(in.EventName)) > maxTriggerDelayEventNameBytes {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_event_name", "event_name must be 256 bytes or fewer"))
		return
	}
	if len(strings.TrimSpace(in.Reason)) > maxTriggerDelayReasonBytes {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_reason", "reason must be 500 bytes or fewer"))
		return
	}
	if in.OptimalDelaySeconds < 0 || in.OptimalDelaySeconds > maxOptimizedDelaySeconds {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_delay", "optimal_delay_seconds must be between 0 and 2592000"))
		return
	}
	out, err := d.Repo.UpsertPreference(r.Context(), t.ID, upsertInput{
		SubscriberID:        in.SubscriberID,
		EventName:           in.EventName,
		OptimalDelaySeconds: in.OptimalDelaySeconds,
		Reason:              in.Reason,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, preferenceView(out))
}

func (r *Repo) ResolveDelay(ctx context.Context, tenantID, subscriberID, eventName string) (time.Duration, bool, error) {
	pref, err := r.GetPreference(ctx, tenantID, subscriberID, eventName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, err
	}
	if pref.OptimalDelaySeconds <= 0 {
		return 0, false, nil
	}
	return time.Duration(pref.OptimalDelaySeconds) * time.Second, true, nil
}

func (r *Repo) GetPreference(ctx context.Context, tenantID, subscriberID, eventName string) (*Preference, error) {
	canonicalID, ok := canonicalSubscriberID(subscriberID)
	if !ok {
		return nil, errInvalidSubscriberID
	}
	normalizedEventName := normalizeEventName(eventName)
	if normalizedEventName == "" || len(normalizedEventName) > maxTriggerDelayEventNameBytes {
		return nil, errInvalidEventName
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Preference
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text, subscriber_id::text, event_name, optimal_delay_seconds,
       sample_count, confidence::float8, COALESCE(reason, ''), computed_at, updated_at
  FROM trigger_delay_preferences
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND event_name = $3`,
		tenantID, canonicalID, normalizedEventName).
		Scan(&out.TenantID, &out.SubscriberID, &out.EventName, &out.OptimalDelaySeconds,
			&out.SampleCount, &out.Confidence, &out.Reason, &out.ComputedAt, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *Repo) UpsertPreference(ctx context.Context, tenantID string, in upsertInput) (*Preference, error) {
	canonicalID, ok := canonicalSubscriberID(in.SubscriberID)
	if !ok {
		return nil, errInvalidSubscriberID
	}
	in.SubscriberID = canonicalID
	in.EventName = normalizeEventName(in.EventName)
	if in.EventName == "" || len(in.EventName) > maxTriggerDelayEventNameBytes {
		return nil, errInvalidEventName
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if len(in.Reason) > maxTriggerDelayReasonBytes {
		return nil, errInvalidReason
	}
	computedAt := time.Now().UTC()
	if raw := strings.TrimSpace(in.ComputedAt); raw != "" {
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			computedAt = parsed.UTC()
		}
	}
	if in.Confidence < 0 {
		in.Confidence = 0
	}
	if in.Confidence > 1 {
		in.Confidence = 1
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Preference
	err = tx.QueryRow(ctx, `
INSERT INTO trigger_delay_preferences (
    tenant_id, subscriber_id, event_name, optimal_delay_seconds,
    sample_count, confidence, reason, computed_at, updated_at
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NULLIF($7, ''), $8, now())
ON CONFLICT (tenant_id, subscriber_id, event_name) DO UPDATE
   SET optimal_delay_seconds = EXCLUDED.optimal_delay_seconds,
       sample_count          = EXCLUDED.sample_count,
       confidence            = EXCLUDED.confidence,
       reason                = EXCLUDED.reason,
       computed_at           = EXCLUDED.computed_at,
       updated_at            = now()
RETURNING tenant_id::text, subscriber_id::text, event_name, optimal_delay_seconds,
          sample_count, confidence::float8, COALESCE(reason, ''), computed_at, updated_at`,
		tenantID, in.SubscriberID, in.EventName,
		in.OptimalDelaySeconds, in.SampleCount, in.Confidence, in.Reason, computedAt).
		Scan(&out.TenantID, &out.SubscriberID, &out.EventName, &out.OptimalDelaySeconds,
			&out.SampleCount, &out.Confidence, &out.Reason, &out.ComputedAt, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func normalizeEventName(v string) string {
	return strings.ToLower(strings.TrimSpace(v))
}

func canonicalSubscriberID(value string) (string, bool) {
	id, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", false
	}
	return id.String(), true
}

func preferenceView(in *Preference) PreferenceView {
	return PreferenceView{
		SubscriberID:        in.SubscriberID,
		EventName:           in.EventName,
		OptimalDelaySeconds: in.OptimalDelaySeconds,
		SampleCount:         in.SampleCount,
		Confidence:          in.Confidence,
		Reason:              in.Reason,
		ComputedAt:          in.ComputedAt,
		UpdatedAt:           in.UpdatedAt,
	}
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
