// SPDX-License-Identifier: AGPL-3.0-only
//
// lifecycle_notify.go — closes the back-in-stock / price-drop loop. The lifecycle
// evaluator (EvaluateLifecycleTriggers) only transitions a waiting subscription
// to "eligible" once the product restocks / drops in price; on its own that is a
// dead end — nobody is told. This file claims those eligible rows and emits a
// per-subscriber product_event ("back_in_stock" / "price_drop"), which the track
// layer fans out to any matching automation flow (the Klaviyo behaviour: restock
// → flow → email). The claim flips eligible→notified under a status guard so a
// subscriber is notified exactly once even across worker replicas.
package commerce

import (
	"context"
	"encoding/json"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Lifecycle product_event names. A flow with a product_event trigger on one of
// these names fires when the lifecycle notifier emits it.
const (
	EventBackInStock = "back_in_stock"
	EventPriceDrop   = "price_drop"
)

// LifecycleEventEmitter records a subscriber-facing product event. track.Repo
// satisfies it; defined here (dependency inversion) so commerce does not import
// track and main.go injects the concrete repo — the same repo whose FlowRuns
// fanout turns the event into flow enrolments.
type LifecycleEventEmitter interface {
	Insert(ctx context.Context, tenantID, subscriberID, eventName string, propsJSON []byte, occurredAt time.Time, eventID string) (int64, error)
}

// LifecycleNotification is one claimed eligible subscription ready to notify.
type LifecycleNotification struct {
	Kind               string // EventBackInStock | EventPriceDrop
	SubscriberID       string
	ProductID          string
	VariantID          string
	Title              string
	URL                string
	ImageURL           string
	PriceCents         int
	Currency           string
	OriginalPriceCents int // price-drop only
}

// properties renders the product_event properties for this notification.
func (n LifecycleNotification) properties() map[string]any {
	props := map[string]any{
		"product_id":  n.ProductID,
		"title":       n.Title,
		"url":         n.URL,
		"image_url":   n.ImageURL,
		"price_cents": n.PriceCents,
		"currency":    n.Currency,
	}
	if n.VariantID != "" {
		props["variant_id"] = n.VariantID
	}
	if n.Kind == EventPriceDrop {
		props["original_price_cents"] = n.OriginalPriceCents
		props["new_price_cents"] = n.PriceCents
		if n.OriginalPriceCents > n.PriceCents && n.OriginalPriceCents > 0 {
			props["drop_percent"] = (n.OriginalPriceCents - n.PriceCents) * 100 / n.OriginalPriceCents
		}
	}
	return props
}

// ClaimEligibleLifecycleNotifications atomically flips up to `limit` eligible
// back-in-stock and price-drop rows (each resolvable to a subscriber) to
// "notified" and returns them. The status guard makes the claim idempotent: a
// concurrent worker re-running the same batch claims nothing. Rows whose
// subscriber cannot be resolved stay eligible (retried next tick).
func (r *Repo) ClaimEligibleLifecycleNotifications(ctx context.Context, tenantID, integrationID string, now time.Time, limit int) ([]LifecycleNotification, error) {
	if limit <= 0 {
		limit = 500
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := []LifecycleNotification{}

	bisRows, err := tx.Query(ctx, `
WITH eligible AS (
    SELECT s.id,
           COALESCE(s.subscriber_id, sub.id) AS subscriber_id,
           s.product_id,
           COALESCE(s.variant_id::text, '') AS variant_id,
           p.title, COALESCE(p.url, '') AS url, COALESCE(p.image_url, '') AS image_url,
           p.price_cents, p.currency
      FROM back_in_stock_subscriptions s
      JOIN commerce_products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
      LEFT JOIN subscribers sub ON sub.tenant_id = s.tenant_id AND sub.email = s.subscriber_email
     WHERE s.tenant_id = $1::uuid AND s.integration_id::text = $2
       AND s.status = 'eligible'
       AND COALESCE(s.subscriber_id, sub.id) IS NOT NULL
     ORDER BY s.eligible_at ASC NULLS LAST
     LIMIT $4
),
claimed AS (
    UPDATE back_in_stock_subscriptions t
       SET status = 'notified', notified_at = $3, updated_at = now()
      FROM eligible e
     WHERE t.id = e.id AND t.status = 'eligible'
 RETURNING e.subscriber_id::text, e.product_id::text, e.variant_id,
           e.title, e.url, e.image_url, e.price_cents, e.currency
)
SELECT * FROM claimed`, tenantID, integrationID, now.UTC(), limit)
	if err != nil {
		return nil, err
	}
	for bisRows.Next() {
		n := LifecycleNotification{Kind: EventBackInStock}
		if err := bisRows.Scan(&n.SubscriberID, &n.ProductID, &n.VariantID,
			&n.Title, &n.URL, &n.ImageURL, &n.PriceCents, &n.Currency); err != nil {
			bisRows.Close()
			return nil, err
		}
		out = append(out, n)
	}
	if err := bisRows.Err(); err != nil {
		return nil, err
	}
	bisRows.Close()

	pdRows, err := tx.Query(ctx, `
WITH eligible AS (
    SELECT w.id,
           COALESCE(w.subscriber_id, sub.id) AS subscriber_id,
           w.product_id,
           COALESCE(w.variant_id::text, '') AS variant_id,
           p.title, COALESCE(p.url, '') AS url, COALESCE(p.image_url, '') AS image_url,
           p.price_cents, p.currency, w.original_price_cents
      FROM price_drop_watchers w
      JOIN commerce_products p ON p.tenant_id = w.tenant_id AND p.id = w.product_id
      LEFT JOIN subscribers sub ON sub.tenant_id = w.tenant_id AND sub.email = w.subscriber_email
     WHERE w.tenant_id = $1::uuid AND w.integration_id::text = $2
       AND w.status = 'eligible'
       AND COALESCE(w.subscriber_id, sub.id) IS NOT NULL
     ORDER BY w.eligible_at ASC NULLS LAST
     LIMIT $4
),
claimed AS (
    UPDATE price_drop_watchers t
       SET status = 'notified', notified_at = $3, updated_at = now()
      FROM eligible e
     WHERE t.id = e.id AND t.status = 'eligible'
 RETURNING e.subscriber_id::text, e.product_id::text, e.variant_id,
           e.title, e.url, e.image_url, e.price_cents, e.currency, e.original_price_cents
)
SELECT * FROM claimed`, tenantID, integrationID, now.UTC(), limit)
	if err != nil {
		return nil, err
	}
	for pdRows.Next() {
		n := LifecycleNotification{Kind: EventPriceDrop}
		if err := pdRows.Scan(&n.SubscriberID, &n.ProductID, &n.VariantID,
			&n.Title, &n.URL, &n.ImageURL, &n.PriceCents, &n.Currency, &n.OriginalPriceCents); err != nil {
			pdRows.Close()
			return nil, err
		}
		out = append(out, n)
	}
	if err := pdRows.Err(); err != nil {
		return nil, err
	}
	pdRows.Close()

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// emitLifecycleNotifications records a product_event per claimed notification via
// the injected emitter (which fans each out to matching flows). Best-effort: a
// single emit failure is logged by the caller, not fatal — the subscription is
// already claimed, and the metric layer is the source of truth for retries.
func emitLifecycleNotifications(ctx context.Context, emitter LifecycleEventEmitter, tenantID string, now time.Time, items []LifecycleNotification) (emitted int, firstErr error) {
	for _, n := range items {
		propsJSON, err := json.Marshal(n.properties())
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if _, err := emitter.Insert(ctx, tenantID, n.SubscriberID, n.Kind, propsJSON, now.UTC(), ""); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		emitted++
	}
	return emitted, firstErr
}
