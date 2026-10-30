// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// Deps bundles dependencies for handler wiring.
type Deps struct {
	Repo *Repo
	// HTTPClient is used for the test-event POST. Replace in tests.
	HTTPClient *http.Client
	// EnvelopeCipher, when set, lets Create wrap the plaintext signing
	// secret with the platform KEK so the dispatcher can sign future
	// deliveries. Nil means new webhooks fall back to unsigned (V1
	// behaviour) — the admin UI flags those.
	EnvelopeCipher SecretWrapper
	// Outbox, when set, enables the Replay endpoint to enqueue past
	// deliveries through the same outbox pipeline as fresh fires. Nil
	// = Replay returns 503 service_unavailable.
	Outbox *outbox.Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

const webhookJSONMaxBodyBytes int64 = 256 << 10 // 256 KiB

// SecretWrapper is the small slice of the envelope cipher this package
// needs. Defined here so we don't drag the full crypto package into
// every test that touches handlers.
type SecretWrapper interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
}

// DefaultClient is what main.go wires into Deps.HTTPClient when the caller
// doesn't override it.
var DefaultClient = newSecureWebhookClient()

// List GET /api/v1/webhooks
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Create POST /api/v1/webhooks. Returns the plaintext signing secret once.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, webhookJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.URL = strings.TrimSpace(in.URL)
	if _, err := validateWebhookDestination(r.Context(), in.URL); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	if len(in.Events) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("no_events", "at least one event required"))
		return
	}
	for _, e := range in.Events {
		if !IsValidEvent(string(e)) {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_event", "unknown event "+string(e)))
			return
		}
	}
	secret, err := NewSecret()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Envelope-wrap the plaintext secret if a KEK is wired. Failure here
	// is fatal — falling back to unsigned silently would mean some
	// webhooks sign and others don't, and operators can't tell which.
	var envelope []byte
	if d.EnvelopeCipher != nil {
		envelope, err = d.EnvelopeCipher.Encrypt(r.Context(), []byte(secret))
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	hook, err := d.Repo.Create(r.Context(), t.ID, in, HashSecret(secret), envelope)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, CreateResponse{Webhook: *hook, Secret: secret})
}

// RotateSecret POST /api/v1/webhooks/{id}/rotate-secret — mints a fresh
// signing secret, reveals it once (SETA-035). Deliveries signed with the
// old secret will fail verification until the receiver is updated.
func (d *Deps) RotateSecret(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	secret, err := NewSecret()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var envelope []byte
	if d.EnvelopeCipher != nil {
		envelope, err = d.EnvelopeCipher.Encrypt(r.Context(), []byte(secret))
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	hook, err := d.Repo.RotateSecret(r.Context(), t.ID, id, HashSecret(secret), envelope)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such webhook"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, CreateResponse{Webhook: *hook, Secret: secret})
}

// Update PATCH /api/v1/webhooks/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, webhookJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.URL != nil {
		u := strings.TrimSpace(*in.URL)
		if _, err := validateWebhookDestination(r.Context(), u); err != nil {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		in.URL = &u
	}
	if in.Events != nil {
		if len(*in.Events) == 0 {
			writeJSON(w, http.StatusBadRequest, errEnv("no_events", "at least one event required"))
			return
		}
		for _, e := range *in.Events {
			if !IsValidEvent(string(e)) {
				writeJSON(w, http.StatusBadRequest, errEnv("bad_event", "unknown event "+string(e)))
				return
			}
		}
	}
	if in.Status != nil && !validStatus(*in.Status) {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_status", "unknown status "+string(*in.Status)))
		return
	}
	out, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Delete DELETE /api/v1/webhooks/{id}
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
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Test POST /api/v1/webhooks/{id}/test — sends a synthetic ping payload
// to the webhook URL. It unwraps the same envelope-encrypted signing secret
// used by the live dispatcher, so a receiver that correctly rejects unsigned
// requests can validate the Test flow end-to-end.
//
// The request body may include {"secret": "..."} so the operator can
// paste the secret from their password manager for a legacy webhook that has
// no encrypted envelope. Modern webhooks need no request body. Every emitted
// test is signed with the same `t=<ts>,v1=<hmac>` scheme as live deliveries.
// Records a webhook_deliveries row regardless of outcome.
func (d *Deps) Test(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	hook, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var inBody struct {
		Secret string `json:"secret"`
	}
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, 1<<14, &inBody, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}
	secret := []byte(strings.TrimSpace(inBody.Secret))
	if len(secret) == 0 {
		envelope, loadErr := d.Repo.LoadSecretEnvelope(r.Context(), t.ID, hook.ID)
		if loadErr != nil && !errors.Is(loadErr, ErrNotFound) {
			httperror.WriteInternal(w, d.Logger, loadErr, r.Context())
			return
		}
		if len(envelope) > 0 {
			cipher, ok := d.EnvelopeCipher.(SecretUnwrapper)
			if !ok {
				httperror.Write(w, http.StatusServiceUnavailable, "signing_unavailable", "webhook signing is temporarily unavailable")
				return
			}
			secret, err = cipher.Decrypt(r.Context(), envelope, nil)
			if err != nil {
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
		}
	}
	if len(secret) == 0 {
		httperror.Write(w, http.StatusConflict, "signing_secret_required", "this legacy webhook has no recoverable signing secret; recreate it before testing")
		return
	}
	payload := map[string]any{
		"event": "ping",
		"data":  map[string]any{"hello": "from postwave", "test": true},
		"at":    time.Now().UTC().Format(time.RFC3339),
	}
	body, _ := json.Marshal(payload)

	client := d.HTTPClient
	if client == nil {
		client = DefaultClient
	}
	if _, err := validateWebhookDestination(r.Context(), hook.URL); err != nil {
		delivery := Delivery{WebhookID: hook.ID, Event: "ping", Attempt: 1, Error: err.Error()}
		_ = d.Repo.RecordDelivery(r.Context(), t.ID, delivery)
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	start := time.Now()
	delivery := Delivery{WebhookID: hook.ID, Event: "ping", Attempt: 1}
	req, reqErr := http.NewRequestWithContext(r.Context(), http.MethodPost, hook.URL, bytes.NewReader(body))
	if reqErr != nil {
		delivery.Error = reqErr.Error()
		_ = d.Repo.RecordDelivery(r.Context(), t.ID, delivery)
		httperror.WriteInternal(w, d.Logger, reqErr, r.Context())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Postwave-Event", "ping")
	ts := time.Now().UTC().Unix()
	mac := hmac.New(sha256.New, secret)
	_, _ = fmt.Fprintf(mac, "%d.", ts)
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))
	signature := fmt.Sprintf("t=%d,v1=%s", ts, sig)
	req.Header.Set("Moosewave-Signature", signature)
	req.Header.Set("Postwave-Signature", signature)
	resp, doErr := client.Do(req)
	delivery.ResponseMS = int(time.Since(start).Milliseconds())
	if doErr != nil {
		delivery.Error = doErr.Error()
		_ = d.Repo.RecordDelivery(r.Context(), t.ID, delivery)
		if d.Logger != nil {
			d.Logger.LogAttrs(r.Context(), slog.LevelWarn, "webhooks.test.delivery_failed",
				slog.String("err", doErr.Error()))
		}
		httperror.Write(w, http.StatusBadGateway, "delivery_failed", "webhook delivery failed")
		return
	}
	defer func() { _ = resp.Body.Close() }()
	delivery.StatusCode = resp.StatusCode
	_ = d.Repo.RecordDelivery(r.Context(), t.ID, delivery)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         resp.StatusCode >= 200 && resp.StatusCode < 300,
		"statusCode": resp.StatusCode,
		"responseMs": delivery.ResponseMS,
	})
}

// Replay POST /api/v1/webhooks/{id}/deliveries/{delivery_id}/replay
//
// Re-enqueues a past delivery through the same outbox pipeline as a
// fresh fire, but with the original payload. Useful when a tenant's
// receiver was down + they've fixed it + they want to recover the
// missed event without waiting for the next live one.
//
// Surfacing "payload not retained" as 422 (vs 404) matters: the row
// exists; the payload-bytes column was NULL because the row pre-
// dates migration 0050. The error code lets the admin UI render a
// clear "this is too old to replay" message.
func (d *Deps) Replay(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d.Outbox == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"outbox_unavailable",
			"replay requires the outbox dispatcher; not wired in this deployment"))
		return
	}
	deliveryIDStr := chi.URLParam(r, "delivery_id")
	deliveryID, err := strconv.ParseInt(deliveryIDStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "delivery_id must be an integer"))
		return
	}
	webhookID, eventType, payload, err := d.Repo.LoadDeliveryPayload(r.Context(), t.ID, deliveryID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "delivery not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if len(payload) == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"payload_not_retained",
			"this delivery pre-dates payload retention (migration 0050) so cannot be replayed"))
		return
	}
	// The stored payload is the WireEnvelope JSON. Pull `body` out so
	// we re-fire the original event payload, not the re-wrapped wire
	// envelope (the dispatcher will re-wrap on the way out).
	var wire WireEnvelope
	if err := json.Unmarshal(payload, &wire); err != nil {
		if d.Logger != nil {
			d.Logger.LogAttrs(r.Context(), slog.LevelError, "webhooks.replay.payload_corrupted",
				slog.String("err", err.Error()))
		}
		writeJSON(w, http.StatusInternalServerError, errEnv(
			"payload_corrupted", "stored payload is not a valid WireEnvelope"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	env := DeliveryEnvelope{
		WebhookID:      webhookID,
		EventType:      eventType,
		IdempotencyKey: wire.IdempotencyKey,
		Body:           wire.Body,
	}
	if _, err := d.Outbox.Append(r.Context(), tx, outbox.Append{
		TenantID: t.ID,
		Kind:     OutboxKind,
		Payload:  env,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"ok":                   true,
		"replayed_delivery_id": deliveryID,
		"webhook_id":           webhookID,
		"event_type":           eventType,
	})
}

// GetDelivery GET /api/v1/webhooks/{id}/deliveries/{delivery_id}
//
// Returns one delivery plus its retained request payload so an admin can
// inspect exactly what was sent when debugging a failing consumer (SETA-004).
// Unlike Replay, a NULL payload is NOT an error here — the metadata is returned
// with payloadRetained=false so old rows still show status/latency/error.
func (d *Deps) GetDelivery(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	deliveryID, err := strconv.ParseInt(chi.URLParam(r, "delivery_id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "delivery_id must be an integer"))
		return
	}
	detail, err := d.Repo.GetDeliveryDetail(r.Context(), t.ID, id, deliveryID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "delivery not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

// Deliveries GET /api/v1/webhooks/{id}/deliveries
func (d *Deps) Deliveries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	limit := 100
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = v
	}
	var beforeID int64
	if v, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64); err == nil && v > 0 {
		beforeID = v
	}
	out, err := d.Repo.ListDeliveries(r.Context(), t.ID, id, limit, beforeID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func validStatus(s Status) bool {
	switch s {
	case StatusActive, StatusPaused, StatusFailing:
		return true
	default:
		return false
	}
}
