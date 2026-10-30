// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// triggerAdminRepository is the parent-scoped persistence contract for nested
// trigger routes. Keeping the parent webhook id in every method makes it
// impossible for handlers to accidentally authorize a child by trigger id
// alone. The unexported Deps seam is used by focused handler tests.
type triggerAdminRepository interface {
	ListTriggers(ctx context.Context, tenantID, webhookID string) ([]Trigger, error)
	CreateTrigger(ctx context.Context, tenantID, webhookID string, in Trigger) (*Trigger, error)
	UpdateTrigger(ctx context.Context, tenantID, webhookID, triggerID string, patch TriggerPatch) (*Trigger, error)
	DeleteTrigger(ctx context.Context, tenantID, webhookID, triggerID string) error
}

type replayAdminRepository interface {
	QueueReplayWithID(
		ctx context.Context,
		tenantID, endpointID string,
		eventID int64,
		replayID string,
	) (string, []Match, error)
}

// inboundPageEnvelope is the published inbound webhook wire contract. The
// shared pagination.Envelope intentionally uses camelCase for older surfaces;
// inbound endpoints are pre-release and follow their OpenAPI/SDK snake_case
// contract exactly.
type inboundPageEnvelope[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
}

// inboundUnsignedRejectedTotal counts inbound webhook POSTs rejected
// for bad/missing signature. Bumps WITHOUT persisting the body so a
// forgery loop can't fill the inbound_events table.
var inboundUnsignedRejectedTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "inbound_webhook_unsigned_rejected_total",
	Help: "Total inbound webhook POSTs rejected for bad/missing HMAC signature. Body is not persisted to inbound_events.",
})

// inboundDuplicateAcceptedTotal counts inbound webhook POSTs that
// matched a previously-received source_event_id (provider replayed because
// our 2xx ack got lost). We ack with 202 and nudge unfinished durable action
// intents; terminal actions are never re-created.
var inboundDuplicateAcceptedTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "inbound_webhook_duplicate_accepted_total",
	Help: "Inbound webhook POSTs ack'd as duplicates via source_event_id idempotency. Unfinished durable action intents are nudged without re-creating terminal actions.",
})

var inboundReplayIdentityRejectedTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "inbound_webhook_replay_identity_rejected_total",
	Help: "Signed inbound webhook POSTs rejected because their stable replay identity was missing or invalid.",
})

var inboundReplayConflictTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "inbound_webhook_replay_conflict_total",
	Help: "Inbound webhook POSTs rejected because an existing replay identity was reused with different processed payload bytes.",
})

var inboundLegacySignatureAcceptedTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "inbound_webhook_legacy_signature_v1_accepted_total",
	Help: "Inbound requests accepted under the explicit legacy timestamp.body compatibility switch. This should remain zero in production.",
})

// inboundRotationGraceTotal counts POSTs accepted via the SECONDARY
// (grace-window) secret during a 24h rotation. Non-zero means upstream
// senders are still signing with the prior secret — expected immediately
// after RotateSecret, should decay to zero within the grace window.
// Sustained values past 24h indicate the operator forgot to update
// the sender. Audit (webhook-rotation CRITICAL #2).
var inboundRotationGraceTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "inbound_webhook_rotation_grace_accepted_total",
	Help: "Inbound webhook POSTs accepted via the secondary (rotation-grace) secret. Decays to zero within the 24h window post-rotation as upstream senders pick up the new secret.",
})

// Deps bundles the inbound webhook handler dependencies.
type Deps struct {
	Repo                 *Repo
	triggerAdminRepo     triggerAdminRepository
	replayAdminRepo      replayAdminRepository
	AutomationServiceURL string
	InternalAPIToken     string
	HTTPClient           *http.Client
	// Executor runs snapshotted trigger actions from the durable action worker.
	// A nil executor leaves actions pending and retry-visible.
	Executor ActionExecutor
	// Logger is called by the durable worker with a terminal Match. Optional.
	Logger func(Match)
	// SafeLogger receives operator-safe worker/handler diagnostics.
	SafeLogger *slog.Logger
	// AllowLegacySignatureV1 is an explicit, temporary migration switch for
	// pre-v2 senders that sign timestamp.rawBody and send a raw hex digest.
	// It defaults false because v1 does not authenticate the replay identity.
	AllowLegacySignatureV1 bool
	// LegacySignatureV1ExpiresAt makes that compatibility switch self-expiring.
	// A zero or elapsed deadline keeps v1 closed even when the boolean is set.
	LegacySignatureV1ExpiresAt time.Time
	// EndpointRateLimitStore supplies the distributed, authenticated endpoint
	// budget. It is applied only after HMAC verification so an attacker who
	// merely knows a public slug cannot starve the legitimate sender.
	EndpointRateLimitStore middleware.FixedWindowStore
	EndpointRateLimit      int
	EndpointRateWindow     time.Duration
}

func (d *Deps) triggerRepository() triggerAdminRepository {
	if d.triggerAdminRepo != nil {
		return d.triggerAdminRepo
	}
	return d.Repo
}

func (d *Deps) replayRepository() replayAdminRepository {
	if d == nil {
		return nil
	}
	if d.replayAdminRepo != nil {
		return d.replayAdminRepo
	}
	return d.Repo
}

const inboundWebhookAdminJSONMaxBodyBytes int64 = 128 << 10 // 128 KiB
const inboundWebhookIngestMaxBodyBytes int64 = 5 << 20      // 5 MiB

// MountAdminRoutes registers the tenant-scoped admin endpoints.
func (d *Deps) MountAdminRoutes(r chi.Router) {
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/inbound-webhooks", d.List)
	r.With(admin).Post("/api/v1/inbound-webhooks", d.Create)
	r.With(admin).Get("/api/v1/inbound-webhooks/{id}", d.Get)
	r.With(admin).Patch("/api/v1/inbound-webhooks/{id}", d.UpdateEndpoint)
	r.With(admin).Post("/api/v1/inbound-webhooks/{id}/rotate", d.Rotate)
	r.With(admin).Delete("/api/v1/inbound-webhooks/{id}", d.Delete)
	r.With(admin).Get("/api/v1/inbound-webhooks/{id}/events", d.ListEvents)
	r.With(admin).Post("/api/v1/inbound-webhooks/transform/preview", d.PreviewTransform)
	// PR 2: re-fire a stored inbound event through the trigger
	// evaluator. Re-executes trigger actions; UI surfaces this in
	// the confirm copy.
	r.With(admin).Post("/api/v1/inbound-webhooks/{id}/events/{event_id}/replay", d.ReplayEvent)
	// Drip trigger CRUD (migration 0090).
	r.With(admin).Get("/api/v1/inbound-webhooks/{id}/triggers", d.ListTriggers)
	r.With(admin).Post("/api/v1/inbound-webhooks/{id}/triggers", d.CreateTrigger)
	r.With(admin).Patch("/api/v1/inbound-webhooks/{id}/triggers/{tid}", d.UpdateTrigger)
	r.With(admin).Delete("/api/v1/inbound-webhooks/{id}/triggers/{tid}", d.DeleteTrigger)
}

// MountPublicRoutes registers the unauthenticated ingest endpoint.
func (d *Deps) MountPublicRoutes(r chi.Router) {
	r.Post("/api/public/inbound/{slug}", d.Ingest)
}

// Create POST /api/v1/inbound-webhooks. Returns the plaintext secret once.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in struct {
		Name        string `json:"name"`
		TransformJQ string `json:"transform_jq"`
	}
	if r.ContentLength > 0 {
		if err := httpbody.DecodeJSON(w, r, inboundWebhookAdminJSONMaxBodyBytes, &in); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	out, err := d.Repo.CreateWithOptions(r.Context(), t.ID, in.Name, in.TransformJQ)
	if err != nil {
		// Pre-validate so a DB failure doesn't masquerade as a 400 +
		// raw err.Error echo. The validator is cheap to repeat and
		// guarantees the message is operator-authored.
		if vErr := ValidateTransformJQ(in.TransformJQ); vErr != nil {
			httperror.WriteValidation(w, "validation_failed", vErr.Error())
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

type endpointPatchInput struct {
	Name        *string `json:"name,omitempty"`
	Enabled     *bool   `json:"enabled,omitempty"`
	TransformJQ *string `json:"transform_jq,omitempty"`
}

func (d *Deps) UpdateEndpoint(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in endpointPatchInput
	if err := httpbody.DecodeJSON(w, r, inboundWebhookAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpdateEndpoint(r.Context(), t.ID, id, EndpointPatch{
		Name:        in.Name,
		Enabled:     in.Enabled,
		TransformJQ: in.TransformJQ,
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		// UpdateEndpoint can return either an operator-authored
		// ValidateTransformJQ error (safe to echo) or a DB error
		// (must not leak). Pre-check so callers still see 400 +
		// validation_failed for the validator path.
		if in.TransformJQ != nil {
			if vErr := ValidateTransformJQ(*in.TransformJQ); vErr != nil {
				httperror.WriteValidation(w, "validation_failed", vErr.Error())
				return
			}
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PreviewTransform(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TransformJQ string          `json:"transform_jq"`
		Body        json.RawMessage `json:"body"`
	}
	if err := httpbody.DecodeJSON(w, r, inboundWebhookAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Body) == 0 {
		in.Body = json.RawMessage(`{}`)
	}
	out, err := ApplyTransformJQContext(r.Context(), in.TransformJQ, in.Body)
	if err != nil {
		// ApplyTransformJQ emits operator-authored messages.
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	var decoded any
	if json.Unmarshal(out, &decoded) != nil {
		decoded = string(out)
	}
	writeJSON(w, http.StatusOK, map[string]any{"body": decoded})
}

// Get GET /api/v1/inbound-webhooks/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "endpoint id required"))
		return
	}
	out, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// List GET /api/v1/inbound-webhooks?q=
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	// Accept ?query= (desktop UI canonical) and ?q= (legacy clients).
	q := listsearch.ReadQuery(r.URL.Query())
	limit, cursor, err := pagination.ReadParams(r.URL.Query())
	if err != nil {
		httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
		return
	}
	out, nextCursor, err := d.Repo.ListPage(r.Context(), t.ID, q, limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, inboundPageEnvelope[Endpoint]{
		Items:      out,
		NextCursor: nextCursor,
	})
}

// Rotate POST /api/v1/inbound-webhooks/{id}/rotate
func (d *Deps) Rotate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "endpoint id required"))
		return
	}
	out, err := d.Repo.RotateSecret(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListEvents GET /api/v1/inbound-webhooks/{id}/events?limit=50&cursor=
//
// Returns the most recent N inbound events for the endpoint, newest
// first. Default limit 50; clamped to [1, 500] in the repo. The
// response shape is `{items: [...]}` matching the rest of the
// inbound_webhooks list endpoints.
func (d *Deps) ListEvents(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "endpoint id required"))
		return
	}
	limit, cursor, err := pagination.ReadParams(r.URL.Query())
	if err != nil {
		httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
		return
	}
	if cursor.ID != "" {
		if _, err := strconv.ParseInt(cursor.ID, 10, 64); err != nil {
			httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
			return
		}
	}
	out, nextCursor, err := d.Repo.ListEventsPage(r.Context(), t.ID, id, limit, cursor)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, inboundPageEnvelope[InboundEvent]{
		Items:      out,
		NextCursor: nextCursor,
	})
}

// Delete DELETE /api/v1/inbound-webhooks/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Ingest POST /api/public/inbound/{slug}
func (d *Deps) Ingest(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	id, tenantID, secret, enabled, operationErr := d.Repo.LookupBySlug(r.Context(), slug)
	if operationErr != nil {
		if errors.Is(operationErr, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("unknown_endpoint", ""))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, operationErr, r.Context())
		return
	}
	if !enabled {
		writeJSON(w, http.StatusGone, errEnv("disabled", ""))
		return
	}
	body, operationErr := httpbody.ReadJSONAtMost(r, inboundWebhookIngestMaxBodyBytes, httpbody.Options{})
	if operationErr != nil {
		// httpbody emits only normalized, operator-safe messages for empty,
		// malformed-media, oversized, and transport read failures.
		httpbody.WriteError(w, operationErr)
		return
	}
	sig := firstNonBlank(
		r.Header.Get("X-Moosewave-Signature"),
		r.Header.Get("X-Postwave-Signature"),
	)
	ts := strings.TrimSpace(firstNonBlank(
		r.Header.Get("X-Moosewave-Timestamp"),
		r.Header.Get("X-Postwave-Timestamp"),
	))
	if err := validateInboundTimestamp(ts, time.Now()); err != nil {
		inboundUnsignedRejectedTotal.Inc()
		switch {
		case errors.Is(err, errMissingTimestamp):
			writeJSON(w, http.StatusUnauthorized, errEnv("missing_timestamp", "request authentication failed"))
		case errors.Is(err, errBadTimestamp):
			writeJSON(w, http.StatusUnauthorized, errEnv("bad_timestamp", "request authentication failed"))
		default:
			writeJSON(w, http.StatusUnauthorized, errEnv("stale_timestamp", "signature timestamp outside ±5min replay window"))
		}
		return
	}
	eventIdentity, operationErr := inboundWebhookEventIdentity(r.Header)
	if operationErr != nil {
		inboundReplayIdentityRejectedTotal.Inc()
		code := "missing_event_id"
		if errors.Is(operationErr, errEventIDTooLong) {
			code = "invalid_event_id"
		}
		writeJSON(w, http.StatusBadRequest, errEnv(code, operationErr.Error()))
		return
	}
	signatureVersion, signatureDigest, operationErr := parseInboundSignature(sig)
	if operationErr != nil {
		inboundUnsignedRejectedTotal.Inc()
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature_format",
			"request authentication failed"))
		return
	}
	legacyV1Allowed := d.AllowLegacySignatureV1 &&
		!d.LegacySignatureV1ExpiresAt.IsZero() &&
		time.Now().UTC().Before(d.LegacySignatureV1ExpiresAt)
	if signatureVersion == "v1" && !legacyV1Allowed {
		inboundUnsignedRejectedTotal.Inc()
		writeJSON(w, http.StatusUnauthorized, errEnv("legacy_signature_disabled",
			"upgrade sender signing to inbound signature v2"))
		return
	}
	signed := authenticatedInboundPayloadV2(ts, eventIdentity, body)
	if signatureVersion == "v1" {
		signed = legacyTimestampedPayload(ts, body)
	}
	valid := SignatureValid(secret, signed, signatureDigest)
	// Dual-verify against the secondary secret only during its bounded
	// rotation grace period. A lookup failure is an availability failure,
	// never permission to accept an unverifiable event.
	if !valid {
		sec, lookupErr := d.Repo.LookupSecondarySecret(r.Context(), tenantID, id)
		if lookupErr != nil {
			httperror.WriteInternal(w, d.SafeLogger, lookupErr, httperror.WithTenantIDLog(r.Context(), tenantID))
			return
		}
		valid = SignatureValid(sec, signed, signatureDigest)
		if valid {
			inboundRotationGraceTotal.Inc()
		}
	}
	if !valid {
		// Don't persist invalid-sig events: forgeries are a DoS lever
		// against inbound_events (an attacker with the public URL but
		// no secret could otherwise inflate the table arbitrarily).
		// Return 401 without recording — accountancy of unsigned
		// attempts belongs in metrics, not the persistent event log.
		inboundUnsignedRejectedTotal.Inc()
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", ""))
		return
	}
	if signatureVersion == "v1" {
		inboundLegacySignatureAcceptedTotal.Inc()
	}
	if limited, resetAt, limitErr := d.reserveAuthenticatedEndpoint(
		r.Context(),
		id,
		time.Now().UTC(),
	); limitErr != nil {
		httperror.Write(w, http.StatusServiceUnavailable, "rate_limit_unavailable",
			"rate limit storage unavailable")
		return
	} else if limited {
		retryAfter := int(time.Until(resetAt).Seconds())
		if retryAfter < 1 {
			retryAfter = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		httperror.Write(w, http.StatusTooManyRequests, "rate_limited",
			"authenticated endpoint delivery rate exceeded")
		return
	}
	eventIDHash := sha256.Sum256([]byte(eventIdentity))
	srcID := inboundReplayKeyPrefix + hex.EncodeToString(eventIDHash[:])
	// Authenticate the exact bytes first, then enforce that a JSON media type
	// actually contains one complete JSON value before persistence or actions.
	var validatedJSON any
	if err := httpbody.DecodeJSONValue(body, &validatedJSON, httpbody.Options{AllowUnknownFields: true, UseNumber: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	headers := flattenHeaders(r.Header)
	headersJSON, _ := json.Marshal(headers)
	processedBody := body
	if transformJQ, err := d.Repo.GetTransformJQ(r.Context(), tenantID, id); err == nil && strings.TrimSpace(transformJQ) != "" {
		transformed, terr := ApplyTransformJQContext(r.Context(), transformJQ, body)
		if terr != nil {
			// ApplyTransformJQ emits operator-authored messages.
			httperror.WriteValidation(w, "validation_failed", terr.Error())
			return
		}
		processedBody = transformed
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	rawBodyDigest := sha256.Sum256(body)
	actionOptions := RecordEventOptions{
		AuthenticatedRawBodySHA256: rawBodyDigest[:],
	}
	if strings.TrimSpace(d.AutomationServiceURL) != "" {
		var parsed any
		if json.Unmarshal(processedBody, &parsed) == nil {
			if email := normalizeActionEmail(extractAutomationEmail(parsed)); email != "" {
				actionOptions.QueueAutomationEvent = true
				actionOptions.AutomationSubscriberEmail = email
			}
		}
	}
	_, dup, _, operationErr := d.Repo.RecordEventWithActions(
		r.Context(),
		tenantID,
		id,
		headersJSON,
		processedBody,
		valid,
		srcID,
		actionOptions,
	)
	if operationErr != nil {
		if errors.Is(operationErr, ErrReplayConflict) {
			inboundReplayConflictTotal.Inc()
			writeJSON(w, http.StatusConflict, errEnv("event_id_conflict", "event id was already used for a different payload"))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, operationErr, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	if dup {
		// Provider redelivery: the atomic replay claim found the original
		// receipt and nudged any unfinished/expired action leases. Succeeded
		// and permanently-failed actions remain terminal.
		inboundDuplicateAcceptedTotal.Inc()
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

func (d *Deps) reserveAuthenticatedEndpoint(
	ctx context.Context,
	endpointID string,
	now time.Time,
) (limited bool, resetAt time.Time, err error) {
	if d == nil || d.EndpointRateLimitStore == nil {
		return false, time.Time{}, nil
	}
	limit := d.EndpointRateLimit
	if limit <= 0 {
		limit = 600
	}
	window := d.EndpointRateWindow
	if window <= 0 {
		window = time.Minute
	}
	count, resetAt, err := d.EndpointRateLimitStore.Reserve(
		ctx,
		"inbound-webhook:endpoint:"+strings.TrimSpace(endpointID),
		limit,
		window,
		now,
	)
	if err != nil {
		return false, time.Time{}, err
	}
	return count > limit, resetAt, nil
}

// firstNonBlank returns the first trimmed-non-empty string. Local
// helper because the inbound_webhooks package doesn't otherwise need
// strings/utils plumbing.
func firstNonBlank(vals ...string) string {
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

// ListTriggers GET /api/v1/inbound-webhooks/{id}/triggers
func (d *Deps) ListTriggers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	out, err := d.triggerRepository().ListTriggers(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

type triggerInput struct {
	Name           string  `json:"name"`
	Active         *bool   `json:"active,omitempty"`
	MatchJSONPath  string  `json:"match_jsonpath"`
	MatchOperator  string  `json:"match_operator"`
	MatchValue     *string `json:"match_value,omitempty"`
	EmailJSONPath  string  `json:"email_jsonpath"`
	ActionType     string  `json:"action_type"`
	ActionTargetID string  `json:"action_target_id"`
}

// CreateTrigger POST /api/v1/inbound-webhooks/{id}/triggers
func (d *Deps) CreateTrigger(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in triggerInput
	if err := httpbody.DecodeJSON(w, r, inboundWebhookAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_name", "name required"))
		return
	}
	if strings.TrimSpace(in.MatchJSONPath) == "" || strings.TrimSpace(in.EmailJSONPath) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_jsonpath", "match_jsonpath and email_jsonpath required"))
		return
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	tr := Trigger{
		Name:           in.Name,
		Active:         active,
		MatchJSONPath:  in.MatchJSONPath,
		MatchOperator:  in.MatchOperator,
		MatchValue:     in.MatchValue,
		EmailJSONPath:  in.EmailJSONPath,
		ActionType:     in.ActionType,
		ActionTargetID: in.ActionTargetID,
	}
	tr, err := normalizeAndValidateTrigger(tr)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.triggerRepository().CreateTrigger(r.Context(), t.ID, id, tr)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrInvalidTrigger):
			httperror.WriteValidation(w, "validation_failed", err.Error())
		default:
			httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

type triggerPatchInput struct {
	Name           *string `json:"name,omitempty"`
	Active         *bool   `json:"active,omitempty"`
	MatchJSONPath  *string `json:"match_jsonpath,omitempty"`
	MatchOperator  *string `json:"match_operator,omitempty"`
	MatchValue     *string `json:"match_value,omitempty"`
	EmailJSONPath  *string `json:"email_jsonpath,omitempty"`
	ActionType     *string `json:"action_type,omitempty"`
	ActionTargetID *string `json:"action_target_id,omitempty"`
}

// UpdateTrigger PATCH /api/v1/inbound-webhooks/{id}/triggers/{tid}
func (d *Deps) UpdateTrigger(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	tid := chi.URLParam(r, "tid")
	var in triggerPatchInput
	if err := httpbody.DecodeJSON(w, r, inboundWebhookAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	patch, err := normalizeAndValidateTriggerPatch(TriggerPatch(in))
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.triggerRepository().UpdateTrigger(r.Context(), t.ID, id, tid, patch)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrInvalidTrigger):
			httperror.WriteValidation(w, "validation_failed", err.Error())
		default:
			httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteTrigger DELETE /api/v1/inbound-webhooks/{id}/triggers/{tid}
func (d *Deps) DeleteTrigger(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	tid := chi.URLParam(r, "tid")
	if err := d.triggerRepository().DeleteTrigger(r.Context(), t.ID, id, tid); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func extractAutomationEmail(v any) string {
	switch x := v.(type) {
	case map[string]any:
		for _, key := range []string{"subscriber_email", "email", "customer_email", "contact_email"} {
			if s, ok := x[key].(string); ok && strings.Contains(s, "@") {
				return strings.TrimSpace(s)
			}
		}
		for _, child := range x {
			if got := extractAutomationEmail(child); got != "" {
				return got
			}
		}
	case []any:
		for _, child := range x {
			if got := extractAutomationEmail(child); got != "" {
				return got
			}
		}
	case string:
		if strings.Contains(x, "@") {
			return strings.TrimSpace(x)
		}
	}
	return ""
}

func inboundWebhookEventName(v any) string {
	if m, ok := v.(map[string]any); ok {
		for _, key := range []string{"event_name", "event", "type"} {
			if s, ok := m[key].(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	return "inbound_webhook"
}

const inboundStoredHeaderValueMaxBytes = 512
const inboundRedactedHeaderValue = "[redacted before storage]"

var inboundInspectableHeaderNames = []string{
	"Content-Type",
	"Content-Encoding",
	"User-Agent",
	"X-Moosewave-Timestamp",
	"X-Postwave-Timestamp",
	"X-Request-Id",
	"Traceparent",
}

var inboundEventIdentityHeaderNames = []string{
	"X-Moosewave-Event-Id",
	"X-Postwave-Event-Id",
	"X-Event-Id",
	"X-GitHub-Delivery",
	"X-Linear-Delivery",
	"X-Stripe-Event-Id",
}

var inboundSensitiveHeaderNames = []string{
	"Authorization",
	"Proxy-Authorization",
	"Cookie",
	"Set-Cookie",
	"X-Api-Key",
	"X-Auth-Token",
	"X-Moosewave-Signature",
	"X-Postwave-Signature",
	"X-Hub-Signature",
	"X-Hub-Signature-256",
	"Stripe-Signature",
}

// flattenHeaders deliberately does not mirror the incoming header bag. Public
// webhook requests routinely carry bearer tokens, cookies, signatures, API
// keys and arbitrary custom authentication headers. Persisting that bag and
// returning it through the admin event API turns the debugging view into a
// credential store. Keep a small troubleshooting allow-list, fingerprint
// sender event identifiers, and retain only a marker for known credentials.
func flattenHeaders(h http.Header) map[string]string {
	out := make(map[string]string)
	for _, name := range inboundInspectableHeaderNames {
		if value := boundedInboundHeaderValue(h.Get(name)); value != "" {
			out[http.CanonicalHeaderKey(name)] = value
		}
	}
	for _, name := range inboundEventIdentityHeaderNames {
		if value := strings.TrimSpace(h.Get(name)); value != "" {
			digest := sha256.Sum256([]byte(value))
			out[http.CanonicalHeaderKey(name)] = "sha256:" + hex.EncodeToString(digest[:8])
		}
	}
	for _, name := range inboundSensitiveHeaderNames {
		if strings.TrimSpace(h.Get(name)) != "" {
			out[http.CanonicalHeaderKey(name)] = inboundRedactedHeaderValue
		}
	}
	return out
}

func boundedInboundHeaderValue(value string) string {
	value = strings.Map(func(r rune) rune {
		if r == '\t' || r >= ' ' {
			return r
		}
		return -1
	}, strings.TrimSpace(value))
	if len(value) > inboundStoredHeaderValueMaxBytes {
		return value[:inboundStoredHeaderValueMaxBytes] + "…"
	}
	return value
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
