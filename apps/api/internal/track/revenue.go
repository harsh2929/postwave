// SPDX-License-Identifier: AGPL-3.0-only
//
// revenue.go — the bridge from the behavioral event store to the revenue /
// conversion store (frontier G-49d).
//
// Before this, POST /api/v1/track wrote a product event and fanned it out to
// flows + the automation service, but a tracked ORDER produced $0 attributed
// revenue: the behavioral store and the conversion store were disconnected,
// and conversions (which owns amount_cents + last-touch campaign attribution)
// was only ever written by its own public pixel path and backend integrations.
// So an e-commerce customer tracking "Placed Order" through the CDP saw their
// most important number — revenue — stay zero.
//
// This records an order-shaped track event as a conversion too. Detection is
// deliberately conservative (a known order-level event name AND an extractable
// positive amount) so browse/add-to-cart events with a price never inflate
// revenue, and the recorder is an injected interface so track stays decoupled
// from conversions (the composition root adapts *conversions.Repo).
package track

import (
	"context"
	"math"
	"strconv"
	"strings"
)

// RevenueRecorder records an order-shaped track event into the revenue /
// conversion store. Satisfied in the composition root by an adapter over
// *conversions.Repo; nil-safe (an unset recorder simply skips the bridge, so
// track has no hard dependency on the conversions package).
type RevenueRecorder interface {
	RecordOrder(ctx context.Context, tenantID string, o OrderConversion) error
}

// OrderConversion is the normalized revenue fact extracted from a track event.
type OrderConversion struct {
	Email       string
	EventName   string
	AmountCents int64
	Currency    string
	Properties  map[string]interface{}
}

// orderEventNames are the normalized event names treated as order-level revenue
// events — Klaviyo "Placed Order", Segment "Order Completed", Shopify-ish
// "checkout completed", and bare "purchase". Line-item events (Klaviyo's
// "Ordered Product") are intentionally excluded: they fire once per line and
// would multiply-count a single order's revenue.
var orderEventNames = map[string]bool{
	"placed order":       true,
	"order placed":       true,
	"order completed":    true,
	"completed order":    true,
	"checkout completed": true,
	"purchase":           true,
	"purchased":          true,
}

// revenueFields are the property keys, in priority order, that carry a
// monetary order total in major currency units (dollars, euros …). amount_cents
// is handled separately and takes precedence over all of these.
var revenueFields = []string{"value", "revenue", "total", "amount", "order_total", "total_price"}

// normalizeEventName lowercases and collapses '_' / '-' / whitespace runs to a
// single space so "Placed Order", "placed_order" and "placed-order" all match.
func normalizeEventName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	repl := strings.NewReplacer("_", " ", "-", " ")
	s = repl.Replace(s)
	return strings.Join(strings.Fields(s), " ")
}

// extractOrderConversion decides whether a track event is a revenue-bearing
// order and, if so, returns the normalized conversion. It reports ok=false —
// recording nothing — unless the event name is a known order event AND a
// strictly-positive amount can be extracted, so non-order events (with a
// browse-time price) and zero/negative amounts never become revenue.
func extractOrderConversion(eventName, email string, props map[string]interface{}) (OrderConversion, bool) {
	if !orderEventNames[normalizeEventName(eventName)] {
		return OrderConversion{}, false
	}
	cents, ok := extractAmountCents(props)
	if !ok || cents <= 0 {
		return OrderConversion{}, false
	}
	currency := "USD"
	if c, _ := props["currency"].(string); strings.TrimSpace(c) != "" {
		currency = strings.ToUpper(strings.TrimSpace(c))
	}
	return OrderConversion{
		Email:       email,
		EventName:   eventName,
		AmountCents: cents,
		Currency:    currency,
		Properties:  props,
	}, true
}

// extractAmountCents pulls the order total in cents. An explicit amount_cents
// property (already in minor units) wins; otherwise the first present
// revenueFields value is read as a major-unit amount and converted to cents.
func extractAmountCents(props map[string]interface{}) (int64, bool) {
	if v, present := props["amount_cents"]; present {
		if cents, ok := toNumber(v); ok {
			return int64(math.Round(cents)), true
		}
	}
	for _, key := range revenueFields {
		v, present := props[key]
		if !present {
			continue
		}
		if amount, ok := toNumber(v); ok {
			return int64(math.Round(amount * 100)), true
		}
	}
	return 0, false
}

// toNumber coerces a JSON-decoded value (float64 for numbers, or a numeric
// string) to a float64. Booleans, maps and unparseable strings return ok=false.
func toNumber(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}
