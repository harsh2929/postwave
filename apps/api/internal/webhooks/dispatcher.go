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
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// webhooksMalformedPayloadTotal tracks outbox events with bodies
// that can't be JSON-unmarshalled into a DeliveryEnvelope. These
// are terminal failures (the bytes will never parse), so the
// dispatcher acks the outbox row and counts the drop here rather
// than burning the outbox's max_attempts budget on guaranteed
// failure. Alert when nonzero.
var webhooksMalformedPayloadTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "webhooks_dispatcher_malformed_payload_total",
	Help: "Total outbox dispatch events dropped because the payload didn't unmarshal into a DeliveryEnvelope. Terminal — bytes will never parse, so we ack and drop rather than retry.",
})

// OutboxKind is the outbox row kind for queued deliveries. Registered
// once at startup with outbox.Registry.
const OutboxKind = "webhooks.deliver"

// Dispatcher fires events into the outbox so delivery is atomic with
// the business write that triggered it. Callers MUST pass the same
// pgx.Tx that performed the business write — that's the whole point
// of the outbox pattern.
type Dispatcher struct {
	Outbox    *outbox.Repo
	Canonical *outbound_webhooks.TransactionalFanout
}

// FireInput is the call-site shape.
type FireInput struct {
	TenantID  string
	EventType EventType
	// Body is what the receiver will see, JSON-encoded by the dispatcher
	// before storing in the outbox row.
	Body any
	// IdempotencyKey, if set, is forwarded to the receiver so they can
	// dedupe replays. Optional.
	IdempotencyKey string
}

// Fire enqueues one outbox row per matching subscription. Returns the
// number of subscriptions that will receive the event (0 means no one
// was listening — not an error).
//
// tx must already be tenant-scoped (e.g. via db.WithTenant). We don't
// open our own tx because the whole point is to piggyback on the
// caller's write tx for atomicity.
func (d *Dispatcher) Fire(ctx context.Context, tx pgx.Tx, in FireInput) (int, error) {
	if d == nil || (d.Outbox == nil && d.Canonical == nil) {
		// nil-dispatcher is a legal "webhooks not configured" state;
		// callers shouldn't have to install this package to make
		// subscriber writes work.
		return 0, nil
	}
	if in.TenantID == "" {
		return 0, errors.New("webhooks: TenantID required")
	}
	if !isDispatchableEventType(string(in.EventType)) {
		return 0, fmt.Errorf("webhooks: unknown event %q", in.EventType)
	}
	var ids []string
	if d.Outbox != nil {
		rows, err := tx.Query(ctx, `
SELECT id::text FROM webhooks
WHERE tenant_id = $1::uuid AND status = 'active' AND $2 = ANY(events)`,
			in.TenantID, string(in.EventType),
		)
		if err != nil {
			return 0, fmt.Errorf("webhooks: lookup subs: %w", err)
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return 0, err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, err
		}
	}
	canonicalCount := 0
	if d.Canonical != nil &&
		outbound_webhooks.IsTransactionalEventType(string(in.EventType)) {
		var err error
		canonicalCount, err = d.Canonical.Fire(ctx, tx, outbound_webhooks.TransactionalEvent{
			TenantID:      in.TenantID,
			EventType:     string(in.EventType),
			SourceEventID: in.IdempotencyKey,
			Body:          in.Body,
		})
		if err != nil {
			return 0, fmt.Errorf("webhooks: canonical fanout: %w", err)
		}
	}
	if len(ids) == 0 {
		return canonicalCount, nil
	}
	body, err := json.Marshal(in.Body)
	if err != nil {
		return 0, fmt.Errorf("webhooks: marshal body: %w", err)
	}
	for _, id := range ids {
		env := DeliveryEnvelope{
			TenantID:       in.TenantID,
			WebhookID:      id,
			EventType:      string(in.EventType),
			IdempotencyKey: in.IdempotencyKey,
			Body:           body,
		}
		if _, err := d.Outbox.Append(ctx, tx, outbox.Append{
			TenantID: in.TenantID,
			Kind:     OutboxKind,
			Payload:  env,
		}); err != nil {
			return 0, err
		}
	}
	return len(ids) + canonicalCount, nil
}

// isDispatchableEventType bridges the two catalogs during the legacy-to-
// canonical transition. Compatibility producers may fire a canonical-only
// topic through Dispatcher so its transactional fanout shares their business
// transaction; a typo that exists in neither catalog still fails closed.
func isDispatchableEventType(eventType string) bool {
	return IsValidEvent(eventType) || outbound_webhooks.IsAllowedEvent(eventType)
}

// DeliveryEnvelope is the outbox row payload. The worker decodes this
// to look up the URL+envelope-encrypted secret and sign + send.
type DeliveryEnvelope struct {
	TenantID       string          `json:"tenant_id,omitempty"`
	WebhookID      string          `json:"webhook_id"`
	EventType      string          `json:"event_type"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	Body           json.RawMessage `json:"body"`
}

// SecretUnwrapper is the dispatcher-side counterpart to SecretWrapper.
// Defined here so the outbox handler test can stub it out.
type SecretUnwrapper interface {
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// DeliverHandler is registered against outbox kind=OutboxKind. It
// resolves the webhook, unwraps the signing secret, signs the body,
// POSTs, and records a webhook_deliveries row.
//
// Returning an error tells the outbox to retry (with exponential
// backoff up to MaxAttempts; then DLQ). Returning nil marks the row
// completed.
type DeliverHandler struct {
	Pool       *db.Pool
	Repo       *Repo
	Cipher     SecretUnwrapper
	HTTPClient *http.Client
	// MaxBodyBytes truncates the response body we read for error logging
	// so a hostile receiver can't flood the deliveries table.
	MaxBodyBytes int64
}

// Handle implements outbox.HandlerFunc.
func (h *DeliverHandler) Handle(ctx context.Context, ev outbox.Event) error {
	var env DeliveryEnvelope
	if err := json.Unmarshal(ev.Payload, &env); err != nil {
		// Malformed payload is a terminal failure — re-attempting with
		// the same bytes will never succeed. Log it, increment a
		// counter so the operator sees the volume, and ack so the
		// outbox doesn't waste retries cycling through max_attempts
		// just to land in DLQ on the same error.
		webhooksMalformedPayloadTotal.Inc()
		slog.Warn("webhooks: dropping malformed dispatch payload",
			"event_id", ev.ID, "err", err.Error())
		return nil
	}
	// Older callers may omit a business idempotency key. The outbox row id is
	// stable across delivery retries, so it is a safe server-generated default.
	if env.IdempotencyKey == "" {
		env.IdempotencyKey = "outbox:" + ev.ID
	}
	if env.TenantID == "" {
		env.TenantID = ev.TenantID
	}
	hook, err := h.Repo.Get(ctx, ev.TenantID, env.WebhookID)
	if err != nil {
		// Webhook deleted between Fire and Deliver — ack so the row
		// doesn't bounce forever for a subscription that no longer
		// exists.
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return fmt.Errorf("load webhook: %w", err)
	}
	if hook.Status == StatusPaused {
		// Paused mid-flight — silently drop. The admin UI will show no
		// new delivery rows; that's the intended UX of "paused".
		return nil
	}
	envelope, err := h.Repo.LoadSecretEnvelope(ctx, ev.TenantID, env.WebhookID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("load envelope: %w", err)
	}
	var secret []byte
	if len(envelope) > 0 && h.Cipher != nil {
		s, err := h.Cipher.Decrypt(ctx, envelope, nil)
		if err != nil {
			return fmt.Errorf("decrypt secret: %w", err)
		}
		secret = s
	}
	// secret == nil here means a legacy webhook without an envelope —
	// signing is skipped, same behaviour as the V1 Test endpoint.
	wireBody, delErr := h.deliver(ctx, hook.URL, env, secret)
	h.recordDelivery(ctx, ev.TenantID, hook, env, delErr, ev.Attempts+1, wireBody)
	return delErr
}

// deliver signs (when secret != nil) and POSTs. Returns the wire-
// format body bytes alongside the result so the caller can persist
// them for replay (the recordDelivery path).
func (h *DeliverHandler) deliver(ctx context.Context, url string, env DeliveryEnvelope, secret []byte) (wireBody []byte, err error) {
	wire := WireEnvelope{
		TenantID:       env.TenantID,
		EventType:      env.EventType,
		WebhookID:      env.WebhookID,
		IdempotencyKey: env.IdempotencyKey,
		DeliveredAt:    time.Now().UTC(),
		Body:           env.Body,
	}
	wireBody, err = json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("marshal wire: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(wireBody))
	if err != nil {
		return wireBody, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Moosewave-Event", env.EventType)
	// Legacy aliases remain during the public rename so existing receivers do
	// not silently stop processing deliveries. New integrations use Moosewave-*.
	req.Header.Set("Postwave-Event", env.EventType)
	req.Header.Set("User-Agent", "Moosewave-Webhooks/1.0")
	if env.IdempotencyKey != "" {
		req.Header.Set("Moosewave-Idempotency-Key", env.IdempotencyKey)
		req.Header.Set("Postwave-Idempotency-Key", env.IdempotencyKey)
	}
	if len(secret) > 0 {
		ts := time.Now().UTC().Unix()
		mac := hmac.New(sha256.New, secret)
		_, _ = fmt.Fprintf(mac, "%d.", ts)
		mac.Write(wireBody)
		sig := hex.EncodeToString(mac.Sum(nil))
		signature := fmt.Sprintf("t=%d,v1=%s", ts, sig)
		req.Header.Set("Moosewave-Signature", signature)
		req.Header.Set("Postwave-Signature", signature)
	}

	client := h.HTTPClient
	if client == nil {
		// Fallback must use the secure transport — bare http.Client
		// would skip dial-time private-IP blocking, leaving a DNS
		// rebinding window between webhook-create validation and
		// delivery time (audit finding C1, SSRF).
		client = outbound_webhooks.NewSecureHTTPClient(nil)
	}
	resp, err := client.Do(req)
	if err != nil {
		return wireBody, fmt.Errorf("post: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	limit := h.MaxBodyBytes
	if limit <= 0 {
		limit = 1024
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return wireBody, nil
	}
	return wireBody, fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

// recordDelivery best-effort-writes a webhook_deliveries row. Swallows
// errors so a flaky bookkeeping write doesn't bounce a successful
// delivery into the retry queue.
//
// Stores the wire-format payload bytes so the admin can replay this
// delivery later. If payload retention is undesirable for a deployment
// (storage cost / privacy posture), pass nil for payload — the
// replay endpoint will surface "payload not retained" cleanly.
func (h *DeliverHandler) recordDelivery(ctx context.Context, tenantID string, hook *Webhook, env DeliveryEnvelope, delErr error, attempt int, payload []byte) {
	d := Delivery{
		WebhookID: hook.ID,
		Event:     env.EventType,
		Attempt:   attempt,
		At:        time.Now().UTC(),
	}
	if delErr != nil {
		d.Error = delErr.Error()
		// status_code: parse from the "status N: ..." prefix when present.
		// We deliberately keep this lossy — the human-readable Error
		// captures the same info, this is just a quick filter for the
		// dashboard.
		if code, ok := parseStatusPrefix(delErr.Error()); ok {
			d.StatusCode = code
		}
	} else {
		// Default success code; we can't recover the actual 2xx
		// without re-plumbing it back from deliver. 200 is fine for
		// the dashboard.
		d.StatusCode = http.StatusOK
	}
	if err := h.Repo.RecordDeliveryWithPayload(ctx, tenantID, d, payload); err != nil {
		// Swallow — see method doc.
		return
	}
}

// parseStatusPrefix pulls the int after "status " from an error like
// "status 503: backend unavailable".
func parseStatusPrefix(s string) (int, bool) {
	const prefix = "status "
	i := strings.Index(s, prefix)
	if i < 0 {
		return 0, false
	}
	rest := s[i+len(prefix):]
	end := strings.IndexAny(rest, " :,")
	if end < 0 {
		end = len(rest)
	}
	code := 0
	for _, c := range rest[:end] {
		if c < '0' || c > '9' {
			return 0, false
		}
		code = code*10 + int(c-'0')
	}
	if code < 100 || code > 999 {
		return 0, false
	}
	return code, true
}

// WireEnvelope is the JSON sent on the HTTP request to the receiver.
// Distinct from DeliveryEnvelope (the outbox-internal shape) so we can
// evolve the wire format without rewriting outbox rows.
type WireEnvelope struct {
	TenantID       string          `json:"tenant_id"`
	EventType      string          `json:"event_type"`
	WebhookID      string          `json:"webhook_id"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	DeliveredAt    time.Time       `json:"delivered_at"`
	Body           json.RawMessage `json:"body"`
}
