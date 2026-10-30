// SPDX-License-Identifier: AGPL-3.0-only
//
// sender.go — encrypts + delivers a notification to a user's browser
// subscriptions and prunes dead endpoints. The RFC 8291 payload encryption and
// VAPID JWT signing are handled by the vetted webpush-go library.

package webpush

import (
	"context"
	"net/http"

	webpushlib "github.com/SherClockHolmes/webpush-go"
)

// pushTTL is how long (seconds) a push service should retain the message for an
// offline browser before dropping it. One day covers a closed laptop reopened
// the next morning without holding stale notifications indefinitely.
const pushTTL = 86400

// Notification is the JSON payload the service worker's `push` handler renders.
//
// NotificationID is the cross-channel identity: the notification_feed row id
// this delivery mirrors. Every channel (feed, mobile push, web push, SSE)
// carries the same id so clients can dedup/read-sync one logical
// notification across devices. Event is the canonical manifest event type.
type Notification struct {
	Title          string `json:"title"`
	Body           string `json:"body"`
	URL            string `json:"url,omitempty"`
	Icon           string `json:"icon,omitempty"`
	Tag            string `json:"tag,omitempty"`
	NotificationID string `json:"notification_id,omitempty"`
	Event          string `json:"event,omitempty"`
}

// SendToUser delivers n to every browser subscription the user has registered,
// returning how many endpoints accepted it. Dead endpoints (404/410) are
// pruned. A no-op (0, nil) when Web Push is unconfigured, so callers can fan a
// notification out to web push unconditionally.
func (d *Deps) SendToUser(ctx context.Context, tenantID, userID string, n Notification) (int, error) {
	if !d.Enabled() {
		return 0, nil
	}
	subs, err := d.listForUser(ctx, tenantID, userID)
	if err != nil {
		return 0, err
	}
	if len(subs) == 0 {
		return 0, nil
	}
	payload, err := marshalNotification(n)
	if err != nil {
		return 0, err
	}
	key, dedupable := idempotencyKeyFor(n)
	sent := 0
	for _, s := range subs {
		// Already accepted for this endpoint — the same notification arriving
		// again because a worker retried the enclosing job, or two tabs
		// triggering one fan-out. Counted as sent, because it was.
		if dedupable && d.alreadyAccepted(ctx, tenantID, s.Endpoint, key) {
			sent++
			continue
		}
		resp, err := d.deliver(ctx, s, payload)
		if err != nil {
			// Recorded, not merely logged. A transport failure used to leave no
			// trace at all, so a notification that never arrived was
			// indistinguishable from one never sent.
			d.record(ctx, tenantID, userID, s.Endpoint, n, statusFailed, "transport_error")
			if d.Logger != nil {
				d.Logger.Warn("web push send failed", "endpoint", redactEndpoint(s.Endpoint), "err", err.Error())
			}
			continue
		}
		status := resp.StatusCode
		_ = resp.Body.Close()
		switch {
		case status == http.StatusNotFound || status == http.StatusGone:
			// Subscription is gone — prune it so we stop trying. Terminal, and
			// recorded as such: this notification will never reach this
			// endpoint, and a retry worker must not pick it up.
			d.record(ctx, tenantID, userID, s.Endpoint, n, statusExpired, http.StatusText(status))
			_ = d.deleteSubscription(ctx, tenantID, userID, s.Endpoint)
		case status >= 200 && status < 300:
			d.record(ctx, tenantID, userID, s.Endpoint, n, statusSent, "")
			sent++
		default:
			// The case this whole ledger exists for: a 429 or 503 is transient
			// and was previously dropped forever. `failed` is deliberately NOT
			// terminal, so the row is what a retry worker will look for.
			d.record(ctx, tenantID, userID, s.Endpoint, n, statusFailed, http.StatusText(status))
			if d.Logger != nil {
				d.Logger.Warn("web push rejected", "endpoint", redactEndpoint(s.Endpoint), "status", status)
			}
		}
	}
	return sent, nil
}

// record writes the delivery row and swallows its own failure.
//
// The notification has already been sent by the time this runs, so a
// bookkeeping error must not be reported to the caller as a delivery error —
// that would turn a successful send into a retry.
func (d *Deps) record(ctx context.Context, tenantID, userID, endpoint string, n Notification, status, errCode string) {
	if err := d.recordAttempt(ctx, tenantID, userID, endpoint, n, status, errCode); err != nil && d.Logger != nil {
		d.Logger.Warn("web push delivery not recorded",
			"endpoint", redactEndpoint(endpoint), "status", status, "err", err.Error())
	}
}

// deliver encrypts payload to one subscription and POSTs it via the webpush-go
// library (RFC 8291 + VAPID). Extracted so it can be tested against a mock push
// endpoint without a DB.
func (d *Deps) deliver(ctx context.Context, s storedSubscription, payload []byte) (*http.Response, error) {
	return webpushlib.SendNotificationWithContext(ctx, payload, &webpushlib.Subscription{
		Endpoint: s.Endpoint,
		Keys:     webpushlib.Keys{P256dh: s.P256dh, Auth: s.Auth},
	}, &webpushlib.Options{
		HTTPClient:      d.client(), // SSRF-guarded (safehttp.go) unless overridden in tests
		Subscriber:      d.subject(),
		VAPIDPublicKey:  d.PublicKey,
		VAPIDPrivateKey: d.PrivateKey,
		TTL:             pushTTL,
	})
}

// redactEndpoint trims a push endpoint to its host for logs (the path holds an
// opaque per-subscription token we don't want in logs).
func redactEndpoint(endpoint string) string {
	for i := 8; i < len(endpoint); i++ { // skip "https://"
		if endpoint[i] == '/' {
			return endpoint[:i]
		}
	}
	return endpoint
}
