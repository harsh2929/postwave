// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Deps is the handler bundle wired in main.go.
type Deps struct {
	Store        *Store
	HTTPClient   *http.Client
	RequireHTTPS bool // set false in dev so http://localhost endpoints work
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger

	// Playground fires contact a tenant-controlled receiver synchronously and
	// can hold a connection for ten seconds. Keep their availability boundary
	// route-local: every caller consumes the shared tenant bucket, API keys also
	// consume their own identity bucket, and both cross the small per-tenant
	// in-flight gate.
	PlaygroundAPIKeyRateLimit  func(http.Handler) http.Handler
	PlaygroundTenantRateLimit  func(http.Handler) http.Handler
	PlaygroundConcurrencyLimit func(http.Handler) http.Handler

	replayStore      outboundReplayStore
	playgroundStore  playgroundDataStore
	playgroundLedger playgroundFireLedger
}

type outboundReplayStore interface {
	ReplayDelivery(
		ctx context.Context,
		tenantID, deliveryID, idempotencyKey string,
	) (ReplayDeliveryResult, error)
}

func (d *Deps) outboundReplayStore() outboundReplayStore {
	if d == nil {
		return nil
	}
	if d.replayStore != nil {
		return d.replayStore
	}
	return d.Store
}

const outboundWebhookJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// MountRoutes registers every public outbound-webhooks route on r. The
// scope passed in is enforced on every mutating route inside this
// function via a defensive apikeys.RequireScope(scope) wrap — callers
// no longer have to remember to chain the scope at the call site.
// Read-only routes (List, Deliveries, AllDeliveries, Health) get the
// same wrap because all of these surfaces leak signing material
// metadata + delivery payloads that may carry customer PII.
//
// scope is typically apikeys.ScopeAdmin; pass a narrower scope if a
// deployment wants to expose a read-only sub-surface to a service
// account. Tenant middleware is still expected to be on r upstream.
func (d *Deps) MountRoutes(r chi.Router, scope apikeys.Scope) {
	// Defensive scope wrap — every route below requires `scope`. We
	// gate mutating routes explicitly (P0 RBAC hardening) and apply
	// the same gate to the read routes so a misconfigured caller can
	// never accidentally expose the surface unauthenticated.
	require := apikeys.RequireScope(scope)
	r.With(require).Get("/api/v1/outbound-webhooks", d.List)
	r.With(require).Post("/api/v1/outbound-webhooks", d.Create)
	r.With(require).Patch("/api/v1/outbound-webhooks/{id}", d.Update)
	r.With(require).Delete("/api/v1/outbound-webhooks/{id}", d.Delete)
	r.With(require).Post("/api/v1/outbound-webhooks/{id}/test", d.Test)
	r.With(require).Get("/api/v1/outbound-webhooks/{id}/deliveries", d.Deliveries)
	// Cross-webhook delivery inspector + replay. Both routes operate on
	// outbound_webhook_deliveries rows and require admin scope (delivery
	// payloads may contain customer data + replay can re-fire real
	// webhooks).
	r.With(require).Get("/api/v1/outbound-webhooks/deliveries", d.AllDeliveries)
	r.With(require).Post("/api/v1/outbound-webhooks/deliveries/{id}/replay", d.ReplayDelivery)
	// Key rotation: generates fresh signing material, demotes the
	// existing key to secondary_* for the grace window (default 24h),
	// returns the new public material ONCE.
	r.With(require).Post("/api/v1/outbound-webhooks/{id}/rotate-secret", d.RotateSecret)
	// Refined Webhooks PR 1: 24h health aggregate + re-enable.
	r.With(require).Get("/api/v1/outbound-webhooks/{id}/health", d.Health)
	r.With(require).Post("/api/v1/outbound-webhooks/{id}/re-enable", d.ReEnable)
}

// RotateSecret POST /api/v1/outbound-webhooks/{id}/rotate-secret
func (d *Deps) RotateSecret(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	// Optional override of the grace window. Default 24h.
	graceMinutes := 24 * 60
	if values, present := r.URL.Query()["grace_minutes"]; present {
		if len(values) != 1 {
			httperror.WriteValidation(
				w,
				"invalid_grace_minutes",
				"grace_minutes must be provided exactly once",
			)
			return
		}
		v := strings.TrimSpace(values[0])
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 7*24*60 {
			httperror.WriteValidation(
				w,
				"invalid_grace_minutes",
				"grace_minutes must be an integer from 1 through 10080",
			)
			return
		}
		graceMinutes = n
	}
	resp, err := d.Store.Rotate(r.Context(), t.ID, id, time.Duration(graceMinutes)*time.Minute)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "webhook not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// AllDeliveries GET /api/v1/outbound-webhooks/deliveries?status=&limit=
//
// Returns the most recent deliveries across all webhooks for the tenant,
// optionally filtered by status (pending | delivered | exhausted | skipped).
// Used
// by the inspector dashboard to surface failed deliveries.
func (d *Deps) AllDeliveries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	q := r.URL.Query()
	status := strings.TrimSpace(q.Get("status"))
	switch status {
	case "", "pending", "delivered", "exhausted", "skipped", "failing":
	default:
		httperror.WriteValidation(
			w,
			"invalid_status",
			"status must be pending, delivered, exhausted, skipped, or failing",
		)
		return
	}
	limit := 100
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 500 {
			httperror.WriteValidation(w, "invalid_limit", "limit must be between 1 and 500")
			return
		}
		limit = n
	}
	out, err := d.Store.ListAllDeliveries(r.Context(), t.ID, status, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deliveries": out,
		"limit":      limit,
		"status":     status,
	})
}

// ReplayDelivery POST /api/v1/outbound-webhooks/deliveries/{id}/replay
//
// Clones a completed delivery into a new pending row so receiver-side
// delivery-id deduplication does not swallow the replay and the original
// attempt history remains immutable. In-flight deliveries cannot be replayed.
func (d *Deps) ReplayDelivery(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "delivery id required"))
		return
	}
	parsedDeliveryID, parseErr := uuid.Parse(id)
	if parseErr != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "delivery not found"))
		return
	}
	id = parsedDeliveryID.String()
	replayKey, err := requiredOutboundReplayIdempotencyKey(r.Header)
	if err != nil {
		if errors.Is(err, ErrReplayIdempotencyRequired) {
			writeJSON(w, http.StatusBadRequest, errEnv(
				"idempotency_key_required",
				"Idempotency-Key is required for delivery replay",
			))
			return
		}
		writeJSON(w, http.StatusBadRequest, errEnv(
			"invalid_idempotency_key",
			"Idempotency-Key must be one value without control characters and at most 255 bytes",
		))
		return
	}
	store := d.outboundReplayStore()
	if store == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("store_unavailable", ""))
		return
	}
	result, err := store.ReplayDelivery(r.Context(), t.ID, id, replayKey)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "delivery not found"))
			return
		}
		if errors.Is(err, ErrDeliveryInProgress) {
			writeJSON(w, http.StatusConflict, errEnv("delivery_in_progress", "wait for the current delivery attempt to finish before replaying"))
			return
		}
		if errors.Is(err, ErrWebhookInactive) {
			writeJSON(w, http.StatusConflict, errEnv(
				"webhook_inactive",
				"activate the webhook before replaying this delivery",
			))
			return
		}
		if errors.Is(err, ErrAuthConfigPending) || errors.Is(err, ErrAuthConfigInvalid) {
			writeJSON(w, http.StatusConflict, errEnv(
				"receiver_auth_unavailable",
				"repair receiver authentication before replaying this delivery",
			))
			return
		}
		if errors.Is(err, ErrDestinationPending) || errors.Is(err, ErrDestinationInvalid) {
			writeJSON(w, http.StatusConflict, errEnv(
				"destination_unavailable",
				"replace the destination URL before replaying this delivery",
			))
			return
		}
		if errors.Is(err, ErrDeliveryPolicyInvalid) {
			writeJSON(w, http.StatusConflict, errEnv(
				"delivery_configuration_invalid",
				"repair the event filter or payload transform before replaying this delivery",
			))
			return
		}
		if errors.Is(err, ErrReplayConflict) {
			writeJSON(w, http.StatusConflict, errEnv(
				"idempotency_key_conflict",
				"Idempotency-Key was already used to replay another delivery",
			))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// List GET /api/v1/outbound-webhooks
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	limit, cursor, err := pagination.ReadParams(r.URL.Query())
	if err != nil {
		httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	out, nextCursor, err := d.Store.ListPage(r.Context(), t.ID, query, limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"webhooks":    out,
		"next_cursor": nextCursor,
	})
}

// Create POST /api/v1/outbound-webhooks
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, outboundWebhookJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.URL = strings.TrimSpace(in.URL)
	in.Description = strings.TrimSpace(in.Description)
	userID := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		userID = u.ID
	}
	resp, err := d.Store.Create(r.Context(), t.ID, userID, in, d.RequireHTTPS)
	if err != nil {
		switch {
		case errors.Is(err, ErrRedactedDestination):
			writeJSON(w, http.StatusBadRequest, errEnv(
				"redacted_destination",
				"enter the complete destination URL; the displayed address hides its path and query",
			))
		case errors.Is(err, ErrInvalidURL):
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_url",
				"url must be a valid http(s) URL"))
		case errors.Is(err, ErrInvalidDescription):
			httperror.WriteValidation(
				w,
				"invalid_description",
				"description must be at most 512 characters",
			)
		case errors.Is(err, ErrInvalidListID):
			httperror.WriteValidation(w, "invalid_list_id", "list_id must be a UUID")
		case errors.Is(err, ErrListNotFound):
			httperror.WriteValidation(
				w,
				"list_not_found",
				"list_id must identify a list owned by the active workspace",
			)
		case errors.Is(err, ErrEventsRequired):
			writeJSON(w, http.StatusBadRequest, errEnv("events_required",
				"at least one event type is required"))
		case errors.Is(err, ErrInvalidEvent):
			httperror.WriteValidation(w, "invalid_event", err.Error())
		case errors.Is(err, ErrInvalidFilter):
			httperror.WriteValidation(w, "invalid_filter", "filter expression is invalid")
		case errors.Is(err, ErrInvalidTransform):
			httperror.WriteValidation(w, "invalid_transform", "transform template is invalid")
		case errors.Is(err, ErrInvalidAuthConfig):
			httperror.WriteValidation(w, "invalid_auth_config", "request configuration is invalid")
		case errors.Is(err, ErrCipherUnconfigured):
			writeJSON(w, http.StatusServiceUnavailable, errEnv("cipher_unconfigured",
				"this Moosewave deployment has no envelope cipher configured"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

// Update PATCH /api/v1/outbound-webhooks/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, outboundWebhookJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Store.Update(r.Context(), t.ID, id, in, d.RequireHTTPS)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrRedactedDestination):
			writeJSON(w, http.StatusBadRequest, errEnv(
				"redacted_destination",
				"enter the complete destination URL; the displayed address hides its path and query",
			))
		case errors.Is(err, ErrInvalidURL):
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_url", ""))
		case errors.Is(err, ErrInvalidDescription):
			httperror.WriteValidation(
				w,
				"invalid_description",
				"description must be at most 512 characters",
			)
		case errors.Is(err, ErrEventsRequired):
			writeJSON(w, http.StatusBadRequest, errEnv("events_required", ""))
		case errors.Is(err, ErrInvalidEvent):
			httperror.WriteValidation(w, "invalid_event", err.Error())
		case errors.Is(err, ErrInvalidFilter):
			httperror.WriteValidation(w, "invalid_filter", "filter expression is invalid")
		case errors.Is(err, ErrInvalidTransform):
			httperror.WriteValidation(w, "invalid_transform", "transform template is invalid")
		case errors.Is(err, ErrInvalidAuthConfig):
			httperror.WriteValidation(w, "invalid_auth_config", "request configuration is invalid")
		case errors.Is(err, ErrAuthConfigPending), errors.Is(err, ErrAuthConfigInvalid):
			writeJSON(w, http.StatusConflict, errEnv(
				"receiver_auth_unavailable",
				"replace or clear receiver authentication before activating this webhook",
			))
		case errors.Is(err, ErrDestinationPending), errors.Is(err, ErrDestinationInvalid):
			writeJSON(w, http.StatusConflict, errEnv(
				"destination_unavailable",
				"replace the destination URL before activating this webhook",
			))
		case errors.Is(err, ErrDeliveryPolicyInvalid):
			writeJSON(w, http.StatusConflict, errEnv(
				"delivery_configuration_invalid",
				"repair the event filter or payload transform before activating this webhook",
			))
		case errors.Is(err, ErrCipherUnconfigured):
			writeJSON(w, http.StatusServiceUnavailable, errEnv("cipher_unconfigured",
				"this Moosewave deployment has no envelope cipher configured"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Delete DELETE /api/v1/outbound-webhooks/{id}
//
// Tombstones by default: the endpoint disappears from CRUD immediately while
// delivery evidence remains until retention safely purges it. Pass ?soft=1 to
// only deactivate the visible endpoint.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	soft := false
	if values, present := r.URL.Query()["soft"]; present {
		if len(values) != 1 {
			httperror.WriteValidation(
				w,
				"invalid_soft_delete",
				"soft must be provided exactly once",
			)
			return
		}
		switch strings.TrimSpace(values[0]) {
		case "1", "true":
			soft = true
		case "0", "false":
		default:
			httperror.WriteValidation(
				w,
				"invalid_soft_delete",
				"soft must be one of 1, 0, true, or false",
			)
			return
		}
	}
	var err error
	if soft {
		err = d.Store.SoftDelete(r.Context(), t.ID, id)
	} else {
		err = d.Store.Delete(r.Context(), t.ID, id)
	}
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"deleted":     !soft,
		"deactivated": soft,
	})
}

// Test POST /api/v1/outbound-webhooks/{id}/test
//
// Synthesize a `webhook.test` event and synchronously deliver it once.
// Returns the result envelope inline so the dashboard can render it
// next to the row without polling the deliveries log.
func (d *Deps) Test(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	wh, err := d.Store.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	keys, err := d.Store.LoadSigningKeys(r.Context(), t.ID, wh.ID, time.Now().UTC())
	if err != nil {
		if writeTestPreparationError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	cfg, err := d.Store.LoadDeliveryConfig(r.Context(), t.ID, wh.ID)
	if err != nil {
		if writeTestPreparationError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Synthesize a deterministic test payload. We use a sentinel
	// event_type so customers can route test traffic to a sandbox
	// branch in their handler if they want.
	eventID := uuid.NewString()
	envelope := map[string]any{
		"event": map[string]any{
			"id":          eventID,
			"type":        "webhook.test",
			"occurred_at": time.Now().UTC().Format(time.RFC3339),
			"data": map[string]any{
				"message": "This is a test event from Moosewave.",
			},
		},
		"webhook": map[string]any{
			"id": wh.ID,
		},
		"delivery": map[string]any{
			"id":      "test-" + wh.ID,
			"attempt": 1,
		},
	}
	prepared, err := prepareDelivery(cfg, envelope)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if prepared.Filtered {
		writeJSON(w, http.StatusOK, map[string]any{
			"webhook_id":  wh.ID,
			"status_code": http.StatusNoContent,
			"signed":      false,
			"signature":   "",
			"response":    "",
			"filtered":    true,
		})
		return
	}
	body := prepared.Body
	now := time.Now().UTC()
	signed, err := signWithKeys(keys, now, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	authConfig := cfg.AuthConfig
	destination, err := d.Store.ResolveDestination(r.Context(), t.ID, wh.ID)
	if err != nil {
		if writeTestPreparationError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	statusCode, respBody, responseTruncated, postErr := d.post(
		r.Context(),
		destination,
		signed.Signature,
		signed.KeyIDs,
		"webhook.test",
		eventID,
		"test-"+wh.ID,
		body,
		authConfig,
	)
	respPreview, responseRedactions := redactInspectablePlaygroundResponseText(
		truncate(respBody, MaxResponseBodyBytes),
		authConfig,
		destination,
	)
	out := map[string]any{
		"webhook_id":         wh.ID,
		"status_code":        statusCode,
		"signed":             true,
		"signature":          signed.Signature,
		"key_ids":            signed.KeyIDs,
		"response":           respPreview,
		"response_truncated": responseTruncated,
		"redaction_applied":  responseRedactions > 0,
	}
	if postErr != nil {
		safeError, _ := redactInspectablePlaygroundText(postErr.Error(), authConfig)
		safeError, _ = redactPlaygroundDestinationText(safeError, destination)
		out["error"] = safeError
	}
	writeJSON(w, http.StatusOK, out)
}

// writeTestPreparationError projects expected, operator-actionable setup
// failures without leaking cryptographic details or misclassifying them as a
// server fault. It returns true when the response has been written.
func writeTestPreparationError(
	w http.ResponseWriter,
	err error,
) bool {
	switch {
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "webhook not found"))
	case errors.Is(err, ErrWebhookInactive):
		writeJSON(w, http.StatusConflict, errEnv(
			"webhook_inactive",
			"resume this paused webhook before sending a live simulator event",
		))
	case errors.Is(err, ErrCipherUnconfigured):
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"cipher_unconfigured",
			"this Moosewave deployment has no envelope cipher configured",
		))
	case errors.Is(err, ErrAuthConfigPending):
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"delivery_configuration_pending",
			"webhook receiver credentials are still being secured",
		))
	case errors.Is(err, ErrDestinationPending):
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"destination_unavailable",
			"webhook destination is still being secured",
		))
	case errors.Is(err, ErrDestinationInvalid):
		writeJSON(w, http.StatusConflict, errEnv(
			"destination_unavailable",
			"replace the destination URL before sending a test",
		))
	case errors.Is(err, ErrInvalidFilter),
		errors.Is(err, ErrInvalidTransform),
		errors.Is(err, ErrAuthConfigInvalid),
		errors.Is(err, ErrDeliveryPolicyInvalid):
		writeJSON(w, http.StatusConflict, errEnv(
			"delivery_configuration_invalid",
			"review and save the webhook delivery policy before sending a test",
		))
	default:
		return false
	}
	return true
}

// Deliveries GET /api/v1/outbound-webhooks/{id}/deliveries?limit=50&cursor=
func (d *Deps) Deliveries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	limit, cursor, err := pagination.ReadParams(r.URL.Query())
	if err != nil {
		httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
		return
	}
	out, nextCursor, err := d.Store.ListDeliveriesPage(r.Context(), t.ID, id, limit, cursor)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "webhook not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deliveries":  out,
		"next_cursor": nextCursor,
	})
}

// post issues the signed HTTP POST to the customer URL and returns
// (status, response-body, error). 10s timeout matches the worker.
func (d *Deps) post(ctx context.Context, url, sig, keyIDs, eventType, eventID, deliveryID string, body []byte, authConfig *AuthConfig) (int, string, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, "", false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Moosewave-Webhooks/1.0")
	req.Header.Set(SignatureHeader, sig)
	if keyIDs != "" {
		req.Header.Set(KeyIDHeader, keyIDs)
	}
	req.Header.Set(EventHeader, eventType)
	if eventID != "" {
		req.Header.Set(EventIDHeader, eventID)
	}
	req.Header.Set(DeliveryHeader, deliveryID)
	req.Header.Set(TestHeader, "true")
	applyAuthConfig(req, authConfig)
	client := d.HTTPClient
	if client == nil {
		if d.RequireHTTPS {
			client = NewSecureHTTPClient(nil)
		} else {
			client = HTTPClientRejectingRedirects(&http.Client{Timeout: 10 * time.Second})
		}
	}
	client = HTTPClientRejectingRedirects(client)
	if authConfig != nil && authConfig.MTLSCertPEM != "" {
		client, err = clientWithAuth(client, authConfig)
		if err != nil {
			return 0, "", false, err
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", false, err
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBodyBytes+1))
	truncated := readErr != nil || len(respBody) > MaxResponseBodyBytes
	if truncated {
		// A partial JSON/string preview can cut through the value that would have
		// established its sensitivity. Withhold it instead of applying regex-only
		// redaction to an incomplete credential-bearing response.
		respBody = nil
	}
	if resp.StatusCode < 100 || resp.StatusCode > 599 {
		// net/http accepts any three-digit response code, including 600-999.
		// The public receipt and database intentionally model the registered
		// HTTP range only; normalize an out-of-domain response to the same
		// conservative status-zero transport outcome used for other unmodelled
		// receiver behavior.
		return 0, string(respBody), truncated, fmt.Errorf(
			"receiver returned unsupported HTTP status %d", resp.StatusCode,
		)
	}
	if readErr != nil {
		return resp.StatusCode, "", true, errors.New("receiver response body was incomplete")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, string(respBody), truncated, fmt.Errorf("http %d", resp.StatusCode)
	}
	return resp.StatusCode, string(respBody), truncated, nil
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
