// SPDX-License-Identifier: AGPL-3.0-only
//
// sto-cold-start-fallback-hierarchy (P1) — concrete DB-backed
// implementation of send_time_opt.FallbackResolver. Reads the two
// tenant-level rungs installed by migration 0306:
//
//   tier 2: tenant_send_settings.fallback_hour_utc   ('tenant_override')
//   tier 3: tenant_modal_hour_cache.modal_hour       ('tenant_fallback')
//
// Tier 1 (subscriber.best_send_hour) and tier 4 (campaign-time mean)
// live elsewhere — this resolver only owns the tenant rungs.
//
// Lives in the campaigns package alongside STOSignalWeightsStore and
// STOStrategyStore so main.go can construct one cheap struct per
// pool and hand the pointer onto send_time_opt.Repo. Symmetric with
// the existing tenant_send_settings reader pattern.

package campaigns

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/send_time_opt"
)

// STOFallbackStore reads the per-tenant cold-start fallback rungs from
// tenant_send_settings + tenant_modal_hour_cache (migration 0306).
// Symmetric with STOSignalWeightsStore / STOStrategyStore.
type STOFallbackStore struct {
	Pool *db.Pool
}

// NewSTOFallbackStore is the constructor used by main.go.
func NewSTOFallbackStore(pool *db.Pool) *STOFallbackStore {
	return &STOFallbackStore{Pool: pool}
}

// ResolveTenantFallback picks the highest-confidence tenant rung
// available for tenantID. Hierarchy:
//
//  1. tenant_send_settings.fallback_hour_utc when not NULL
//     → ConfidenceTenantOverride. The operator's pinned hour beats
//     the computed aggregate by design — they presumably know
//     their audience better than a coarse modal hour.
//  2. tenant_modal_hour_cache.modal_hour when not NULL
//     → ConfidenceTenantFallback. The nightly aggregate of warm
//     subscribers' best hours.
//  3. Otherwise GlobalDefaultHour (9 UTC) → ConfidenceGlobalDefault.
//     Matches the legacy mean=9 default in loadCampaignRecipients()
//     so cold-start tenants get the same posture they had before
//     this feature shipped.
//
// Missing rows on either table are non-errors — first-call tenants
// must keep working without an INSERT. A read failure surfaces an
// error; the send_time_opt-side resolver then falls through to the
// global default.
//
// Implements send_time_opt.FallbackResolver.
func (s *STOFallbackStore) ResolveTenantFallback(
	ctx context.Context, tenantID string,
) (send_time_opt.TenantFallback, error) {
	if s == nil || s.Pool == nil {
		return send_time_opt.TenantFallback{
			Hour:       send_time_opt.GlobalDefaultHour,
			Confidence: send_time_opt.ConfidenceGlobalDefault,
		}, errors.New("campaigns: STOFallbackStore.Pool is nil")
	}
	if tenantID == "" {
		return send_time_opt.TenantFallback{
			Hour:       send_time_opt.GlobalDefaultHour,
			Confidence: send_time_opt.ConfidenceGlobalDefault,
		}, errors.New("campaigns: ResolveTenantFallback requires tenant id")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return send_time_opt.TenantFallback{
			Hour:       send_time_opt.GlobalDefaultHour,
			Confidence: send_time_opt.ConfidenceGlobalDefault,
		}, fmt.Errorf("campaigns: open tx for fallback read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Tier 2 — explicit operator override.
	var override *int16
	err = tx.QueryRow(ctx, `
SELECT fallback_hour_utc FROM tenant_send_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&override)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return send_time_opt.TenantFallback{
			Hour:       send_time_opt.GlobalDefaultHour,
			Confidence: send_time_opt.ConfidenceGlobalDefault,
		}, fmt.Errorf("campaigns: read tenant_send_settings: %w", err)
	}
	if override != nil {
		if cerr := tx.Commit(ctx); cerr != nil {
			return send_time_opt.TenantFallback{
				Hour:       send_time_opt.GlobalDefaultHour,
				Confidence: send_time_opt.ConfidenceGlobalDefault,
			}, fmt.Errorf("campaigns: commit fallback override read: %w", cerr)
		}
		return send_time_opt.TenantFallback{
			Hour:       int(*override),
			Confidence: send_time_opt.ConfidenceTenantOverride,
		}, nil
	}

	// Tier 3 — computed aggregate.
	var modal *int16
	var sampleSize int
	err = tx.QueryRow(ctx, `
SELECT modal_hour, sample_size FROM tenant_modal_hour_cache
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&modal, &sampleSize)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return send_time_opt.TenantFallback{
			Hour:       send_time_opt.GlobalDefaultHour,
			Confidence: send_time_opt.ConfidenceGlobalDefault,
		}, fmt.Errorf("campaigns: read tenant_modal_hour_cache: %w", err)
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		return send_time_opt.TenantFallback{
			Hour:       send_time_opt.GlobalDefaultHour,
			Confidence: send_time_opt.ConfidenceGlobalDefault,
		}, fmt.Errorf("campaigns: commit fallback aggregate read: %w", cerr)
	}
	if modal != nil {
		return send_time_opt.TenantFallback{
			Hour:       int(*modal),
			Confidence: send_time_opt.ConfidenceTenantFallback,
			SampleSize: sampleSize,
		}, nil
	}

	// Tier 5 — global default. Cache row exists with NULL modal_hour
	// (empty tenant) OR cache row missing entirely (never computed);
	// both land here.
	return send_time_opt.TenantFallback{
		Hour:       send_time_opt.GlobalDefaultHour,
		Confidence: send_time_opt.ConfidenceGlobalDefault,
	}, nil
}
