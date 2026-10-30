// SPDX-License-Identifier: AGPL-3.0-only
//
// sto-click-reply-signal (P1). Implements
// send_time_opt.SignalWeightsReader by reading the per-tenant signal
// weight columns added to tenant_send_settings in migration 0301.
//
// The interface contract (see send_time_opt/signal_weights.go) is:
//
//   * Missing tenant row → return DefaultSignalWeights with nil error.
//     First-call tenants must keep working without an INSERT; the
//     send_time_opt worker treats this exactly the same as a tenant
//     with an explicit (1,3,5) row.
//   * Read failure → return DefaultSignalWeights + the error; the
//     send_time_opt resolver falls back to defaults but the metric
//     emitted upstream can flag the read.
//   * Successful row → return the persisted values verbatim (the DB
//     CHECK constraint already pins them to [0, 100], so the
//     send_time_opt-side clampWeights() is defensive-only).
//
// This file lives in the campaigns package — same as STOStrategyStore
// — because main.go already constructs an STOStrategyStore pointed at
// the same *db.Pool; the wiring is symmetrical and keeps the
// tenant_send_settings table reads in one neighbourhood.

package campaigns

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/send_time_opt"
)

// STOSignalWeightsStore reads per-tenant STO signal weights from
// tenant_send_settings. Lives alongside STOStrategyStore so main.go
// can construct one cheap struct per pool and hand the same pointer
// to both interface fields on send_time_opt.Repo / send_time_opt.Deps
// as the surfaces grow.
type STOSignalWeightsStore struct {
	Pool *db.Pool
}

// NewSTOSignalWeightsStore is a constructor for symmetry with the rest
// of the package; main.go uses this so it doesn't peek into struct
// fields.
func NewSTOSignalWeightsStore(pool *db.Pool) *STOSignalWeightsStore {
	return &STOSignalWeightsStore{Pool: pool}
}

// GetSTOSignalWeights reads sto_signal_weight_{open,click,reply} for
// the given tenant. Missing row → DefaultSignalWeights + nil.
//
// Implements send_time_opt.SignalWeightsReader.
func (s *STOSignalWeightsStore) GetSTOSignalWeights(
	ctx context.Context, tenantID string,
) (send_time_opt.SignalWeights, error) {
	if s == nil || s.Pool == nil {
		return send_time_opt.DefaultSignalWeights,
			errors.New("campaigns: STOSignalWeightsStore.Pool is nil")
	}
	if tenantID == "" {
		return send_time_opt.DefaultSignalWeights,
			errors.New("campaigns: GetSTOSignalWeights requires tenant id")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return send_time_opt.DefaultSignalWeights,
			fmt.Errorf("campaigns: open tx for sto-weights read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var openW, clickW, replyW int16
	err = tx.QueryRow(ctx, `
SELECT sto_signal_weight_open, sto_signal_weight_click, sto_signal_weight_reply
  FROM tenant_send_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&openW, &clickW, &replyW)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No settings row yet → first-call tenant. Commit-rollback
			// the empty tx and hand back defaults. Treating "no row" as
			// success (not error) keeps the worker happy on cold tenants.
			_ = tx.Commit(ctx)
			return send_time_opt.DefaultSignalWeights, nil
		}
		return send_time_opt.DefaultSignalWeights,
			fmt.Errorf("campaigns: read sto-weights: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return send_time_opt.DefaultSignalWeights,
			fmt.Errorf("campaigns: commit sto-weights read: %w", err)
	}
	return send_time_opt.SignalWeights{
		Open:  int(openW),
		Click: int(clickW),
		Reply: int(replyW),
	}, nil
}
