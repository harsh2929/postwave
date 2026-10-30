// SPDX-License-Identifier: AGPL-3.0-only
//
// sto-cold-start-fallback-hierarchy (P1) — tiered fallback for cold
// subscribers (< MinOpens weighted events).
//
// BEFORE this file, the cold-subscriber posture was:
//
//   * Repo.GetByID() returned BestHour{BestHourUTC: -1} with no
//     confidence label — the desktop rendered "no data" and the
//     operator gave up.
//   * loadCampaignRecipients() folded a per-campaign tenant mean into
//     ScheduleByBestTime so cold rows still got scheduled — but the
//     mean was computed from whichever subscribers had data, not from
//     a stable tenant aggregate, and was invisible outside the
//     schedule call.
//
// 2026 SOTA from Klaviyo (similar-profiles → account-level →
// re-personalize), MoEngage (BTS → most-popular workspace hour →
// marketer-specified custom fallback), Iterable (per-user → list →
// tenant), and Braze (per-user → channel modal hour) all tier the
// fallback so the UI can SHOW what would be used and the marketer
// can override it.
//
// Moosewave's hierarchy (descending confidence):
//
//	tier 1: subscriber.best_send_hour              confidence='subscriber'
//	tier 2: tenant_send_settings.fallback_hour_utc confidence='tenant_override'
//	tier 3: tenant_modal_hour_cache.modal_hour     confidence='tenant_fallback'
//	tier 4: campaign-scheduler mean (legacy)       confidence='tenant_mean'
//	(no rung) global default = 9                   confidence='global_default'
//
// Tier 2 is the operator knob; tier 3 is the nightly aggregate the
// worker maintains. Tier 4 is the legacy mean ScheduleByBestTime
// already folds in (kept for backwards-compat); tier 5 is the
// final "we know literally nothing" rung pinned at 9 UTC, matching
// the existing loadCampaignRecipients default.
//
// Migration 0306 installs tenant_modal_hour_cache + the fallback_hour_utc
// column. This file declares the narrow Go contract and the leaf
// resolver. The actual DB-backed implementation lives in the campaigns
// package alongside the rest of the tenant_send_settings readers, so
// this package keeps zero coupling on db/pgx for the resolver path.

package send_time_opt

import (
	"context"
	"errors"
)

// Confidence labels surfaced on BestHour for the tiered fallback.
// Callers (the desktop, future RL pipelines) branch on this so the UI
// can render a different badge for each rung.
const (
	// ConfidenceSubscriber — best_send_hour came from the subscriber's
	// own weighted engagement history. Highest confidence.
	ConfidenceSubscriber = "subscriber"

	// ConfidenceTenantOverride — the tenant set an explicit
	// fallback_hour_utc on tenant_send_settings. This beats the
	// computed aggregate (tier 2 > tier 3) because the marketer
	// presumably knows their audience better than a coarse modal
	// hour over a heterogeneous subscriber set.
	ConfidenceTenantOverride = "tenant_override"

	// ConfidenceTenantFallback — tenant_modal_hour_cache.modal_hour,
	// the nightly aggregate of warm subscribers' best hours. Coarse
	// but data-grounded.
	ConfidenceTenantFallback = "tenant_fallback"

	// ConfidenceTenantMean — legacy campaign-time mean from
	// loadCampaignRecipients(). Surfaced only by the schedule path
	// today; the GET-by-id surface never reaches this rung because
	// the cache is recomputed nightly.
	ConfidenceTenantMean = "tenant_mean"

	// ConfidenceGlobalDefault — last-resort 9 UTC (matches the
	// historical mean=9 default in loadCampaignRecipients). Used when
	// neither the override nor the cache nor any subscriber has data.
	ConfidenceGlobalDefault = "global_default"
)

// GlobalDefaultHour is the hour-of-week pinned at the final
// fallback rung. 9 (Sunday 09:00 UTC) matches the legacy mean=9
// default used by loadCampaignRecipients() for tenants with no
// engagement data at all. NOT 0 — a midnight default would clash
// with quiet-hour windows on most tenants.
const GlobalDefaultHour = 9

// TenantFallback is the cold-subscriber rung for one tenant — what
// the resolver returns when the per-subscriber best_send_hour is
// NULL. Confidence indicates which rung produced Hour so the UI
// can render the right badge.
//
// SampleSize is meaningful only for ConfidenceTenantFallback (the
// aggregate row carries it from migration 0306). For the explicit
// override and the global default it's zero — those rungs don't
// have a sample.
type TenantFallback struct {
	Hour       int
	Confidence string
	SampleSize int
}

// FallbackResolver pulls the tenant-level rungs (tiers 2 + 3). The
// concrete implementation lives in the campaigns package alongside
// STOSignalWeightsStore so the same *db.Pool wires both readers from
// main.go; send_time_opt holds only the interface so its tests stay
// pure-Go.
//
// Contract:
//
//   - ResolveTenantFallback MUST NOT return ErrFallbackUnavailable when
//     the tenant_send_settings row is absent and the cache is empty —
//     it should return ({GlobalDefaultHour, ConfidenceGlobalDefault, 0}, nil)
//     so cold-start tenants keep working without a migration backfill.
//   - A DB-read failure SHOULD surface as an error; callers fall back
//     to the global default to keep the cold path alive.
//   - Implementations honour the tenant-RLS GUC the same way the
//     STOSignalWeightsStore does.
type FallbackResolver interface {
	ResolveTenantFallback(ctx context.Context, tenantID string) (TenantFallback, error)
}

// ErrFallbackUnavailable signals that the resolver could not return
// any value — used only by tests; production resolvers fall through
// to the global default rather than erroring.
var ErrFallbackUnavailable = errors.New("send_time_opt: fallback unavailable")

// resolveTenantFallback is the leaf wrapper Repo.GetByID() uses to
// pick the cold-subscriber rung. nil resolver → global default; a
// resolver error → global default (so a transient DB blip doesn't
// 5xx the GET); zero Hour from the resolver is preserved (Sunday
// 00:00 UTC is a valid override).
func resolveTenantFallback(ctx context.Context, r FallbackResolver, tenantID string) TenantFallback {
	if r == nil {
		return TenantFallback{Hour: GlobalDefaultHour, Confidence: ConfidenceGlobalDefault}
	}
	tf, err := r.ResolveTenantFallback(ctx, tenantID)
	if err != nil {
		return TenantFallback{Hour: GlobalDefaultHour, Confidence: ConfidenceGlobalDefault}
	}
	// Normalize: an implementation that hands back an out-of-range hour
	// would break Mode()/HourOfWeek invariants downstream. Clamp into
	// 0..167 and downgrade the label so callers can tell.
	if tf.Hour < 0 || tf.Hour > 167 {
		return TenantFallback{Hour: GlobalDefaultHour, Confidence: ConfidenceGlobalDefault}
	}
	if tf.Confidence == "" {
		tf.Confidence = ConfidenceGlobalDefault
	}
	return tf
}
