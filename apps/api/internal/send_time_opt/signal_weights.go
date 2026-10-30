// SPDX-License-Identifier: AGPL-3.0-only
//
// sto-click-reply-signal (P1) — per-event-type intent weights for the
// send-time-optimization pipeline.
//
// The historical Compute() / LoadOpenPattern() / LoadSegmentPattern()
// queries filtered subscriber_events.event_type='opened' exclusively.
// That's a weak signal: Apple MPP / Gmail-proxy / SafeLinks pre-fetches
// look identical to a human open, so an opens-only model is structurally
// biased toward bot-prefetch windows even after the bot_open_filter
// regex set runs.
//
// 2026 SOTA (Klaviyo RL STO, Iterable Brand Affinity, MoEngage BTS)
// weights opens + clicks + replies (and, for commerce, placed-orders)
// as separate engagement signals. A click requires the human to act on
// the message; a reply requires composing a response — both are
// dramatically stronger intent signals than an open.
//
// This file declares:
//
//   * SignalWeights — a tiny value type holding per-event-type weights.
//   * DefaultSignalWeights — (open=1, click=3, reply=5), matching the
//     audit sketch and the Klaviyo/Iterable/MoEngage posture of "a
//     reply is ~5x more informative than an open."
//   * SignalWeightsReader — narrow interface a tenant-settings backend
//     can satisfy without dragging the campaigns/settings packages
//     into send_time_opt's dep graph.
//   * weightFor() — leaf lookup used inside the SQL scan loops to
//     decide how many times an event's hour-of-week is appended to the
//     mode-computation slice. Multiplicity is the cleanest way to
//     fold weights into Mode() / buildPattern() without changing those
//     functions' shape — a click with weight=3 contributes 3 entries
//     to `hours`, so it influences the modal-hour pick exactly as if
//     three subscribers had opened at the same hour.

package send_time_opt

import (
	"context"
	"strings"
)

// SignalWeights bundles per-event-type intent weights. Zero disables a
// signal entirely; the SQL filter still includes the event_type so the
// row count + bot-filter metric stay accurate, but the row contributes
// nothing to the hour-distribution. Values must satisfy
// 0 <= w <= MaxSignalWeight; out-of-range values are clamped at the
// boundary (we'd rather clamp than 5xx the worker).
type SignalWeights struct {
	Open  int
	Click int
	Reply int
}

// MaxSignalWeight bounds each per-event weight. Matches the CHECK
// constraint on tenant_send_settings in migration 0301 — a weight
// above 100 would let one signal dominate so totally that the modal
// hour collapses to "whichever single click happened to fire."
const MaxSignalWeight = 100

// DefaultSignalWeights is the fallback used when the tenant has no row
// in tenant_send_settings (or a reader is not wired into Repo). The
// (1, 3, 5) split matches the audit sketch:
//
//   - open=1   — baseline.
//   - click=3  — Klaviyo / Iterable click-vs-open uplift research
//     puts a click at ~3x the predictive value of an open for the
//     next-engagement model.
//   - reply=5  — replies are rare enough that even a single one is a
//     stronger STO signal than 5 opens; MoEngage BTS treats replies
//     as a "definitive intent" tier.
var DefaultSignalWeights = SignalWeights{Open: 1, Click: 3, Reply: 5}

// SignalWeightsReader resolves per-tenant STO signal weights. The
// concrete implementation lives in the campaigns package alongside
// STOStrategyStore so both interfaces share the same *db.Pool +
// table (tenant_send_settings); send_time_opt deliberately holds
// only the interface so its tests don't need a DB.
//
// Implementations MUST return DefaultSignalWeights (NOT an error) when
// the tenant has no settings row yet — first-call tenants must keep
// working without an INSERT. Failures (DB unreachable etc.) should
// return an error; the caller then falls back to DefaultSignalWeights
// to avoid blocking the STO pipeline on a transient settings-row read.
type SignalWeightsReader interface {
	GetSTOSignalWeights(ctx context.Context, tenantID string) (SignalWeights, error)
}

// resolveWeights is the leaf helper Compute() / LoadOpenPattern() /
// LoadSegmentPattern() use to pick weights. nil reader → defaults; a
// read error → defaults (logged at the call site via a counter, not
// here, so this stays leaf-pure). Out-of-range values are clamped.
func resolveWeights(ctx context.Context, r SignalWeightsReader, tenantID string) SignalWeights {
	if r == nil {
		return DefaultSignalWeights
	}
	w, err := r.GetSTOSignalWeights(ctx, tenantID)
	if err != nil {
		return DefaultSignalWeights
	}
	return clampWeights(w)
}

// clampWeights pins each field to [0, MaxSignalWeight]. Defensive: the
// DB CHECK constraint enforces this too, but a caller wiring an
// in-memory implementation for tests could otherwise overflow Mode().
func clampWeights(w SignalWeights) SignalWeights {
	w.Open = clampInt(w.Open, 0, MaxSignalWeight)
	w.Click = clampInt(w.Click, 0, MaxSignalWeight)
	w.Reply = clampInt(w.Reply, 0, MaxSignalWeight)
	return w
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// weightFor returns the multiplicity for an event_type row. Unknown
// event_types (e.g. 'bounced' if it ever leaks into a future SELECT)
// return 0 so they contribute nothing — this is the safe default and
// keeps the function tolerant of vocabulary drift.
//
// The lookup is case-insensitive: subscriber_events.event_type is
// always lowercase in the schema, but defensive normalisation costs
// nothing here.
func weightFor(eventType string, w SignalWeights) int {
	switch strings.ToLower(strings.TrimSpace(eventType)) {
	case "opened":
		return w.Open
	case "clicked":
		return w.Click
	case "replied":
		return w.Reply
	default:
		return 0
	}
}
