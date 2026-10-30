// SPDX-License-Identifier: AGPL-3.0-only
//
// sto-strategy-persistence (P2). Implements two narrow interfaces the
// send_time_opt package consumes:
//
//   1. send_time_opt.StrategyPersister — writes campaigns.send_time_strategy
//      every time POST /api/v1/campaigns/{id}/schedule-by-best-time
//      resolves to a known strategy ("modal_hour" or "per_recipient").
//      Persisting the operator's intent on the row lets the campaign
//      detail slideover render a read-only badge so the operator can
//      see "this campaign sends at each recipient's best hour" without
//      re-opening the SendTime page. Mirrors how Klaviyo Personalized
//      Send Time, Braze Intelligent Timing, Iterable STO, and MoEngage
//      Sherpa surface the strategy on the campaign detail view.
//
//   2. send_time_opt.TenantSendDefaults — reads
//      tenant_send_settings.default_sto_strategy so the
//      schedule-by-best-time handler can fall back to the tenant's
//      pinned default when the request body omits `strategy`. Missing
//      row → no default (legacy "unspecified" posture preserved).
//
// Both interfaces live in send_time_opt to keep the package testable in
// isolation; the campaigns package owns the SQL because the campaign
// row + tenant_send_settings row live in the campaigns schema neighbourhood.

package campaigns

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// STOStrategyStore couples the persister + defaults reader because they
// share a *db.Pool. main.go constructs one and hands the same pointer to
// both send_time_opt.Deps.StrategyPersister and
// send_time_opt.Deps.TenantDefaults.
type STOStrategyStore struct {
	Pool *db.Pool
}

// SetCampaignStrategy writes campaigns.send_time_strategy under tenant
// scope. Unknown values are coerced to "none" so the CHECK constraint
// in migration 0299 cannot fire from a drifted caller.
//
// Implements send_time_opt.StrategyPersister.
func (s *STOStrategyStore) SetCampaignStrategy(
	ctx context.Context,
	tenantID, campaignID, strategy string,
) error {
	if s == nil || s.Pool == nil {
		return errors.New("campaigns: STOStrategyStore.Pool is nil")
	}
	if tenantID == "" {
		return errors.New("campaigns: SetCampaignStrategy requires tenant id")
	}
	if campaignID == "" {
		return errors.New("campaigns: SetCampaignStrategy requires campaign id")
	}
	if !ValidSendTimeStrategy(strategy) {
		// Unknown label → fold to "none". Same posture as
		// NormalizeSendTimeStrategy; we'd rather no-op than 5xx.
		strategy = SendTimeStrategyNone
	}
	strategy = NormalizeSendTimeStrategy(strategy)

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return fmt.Errorf("campaigns: open tx for strategy persist: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	res, err := tx.Exec(ctx, `
UPDATE campaigns
   SET send_time_strategy = $3,
       updated_at         = now()
 WHERE id::text   = $2
   AND tenant_id  = $1::uuid`,
		tenantID, campaignID, strategy)
	if err != nil {
		return fmt.Errorf("campaigns: update send_time_strategy: %w", err)
	}
	if res.RowsAffected() == 0 {
		// Match the rest of the package: a missing row is ErrNotFound
		// so the caller (send_time_opt.Schedule) can decide whether to
		// surface it as a 404. In practice the handler swallows this
		// (the schedule already succeeded), but the typed error keeps
		// the contract clean.
		return ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("campaigns: commit strategy persist: %w", err)
	}
	return nil
}

// DefaultStrategy reads tenant_send_settings.default_sto_strategy for
// the given tenant. Missing row → "" (no default), which the handler
// interprets as "unspecified" exactly like before.
//
// Implements send_time_opt.TenantSendDefaults.
func (s *STOStrategyStore) DefaultStrategy(ctx context.Context, tenantID string) (string, error) {
	if s == nil || s.Pool == nil {
		return "", errors.New("campaigns: STOStrategyStore.Pool is nil")
	}
	if tenantID == "" {
		return "", errors.New("campaigns: DefaultStrategy requires tenant id")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", fmt.Errorf("campaigns: open tx for defaults read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var strategy string
	err = tx.QueryRow(ctx, `
SELECT default_sto_strategy
  FROM tenant_send_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&strategy)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No settings row yet — first-call tenant. "" means
			// "no default", which the handler treats as legacy
			// "unspecified". No 5xx.
			_ = tx.Commit(ctx)
			return "", nil
		}
		return "", fmt.Errorf("campaigns: read default strategy: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("campaigns: commit defaults read: %w", err)
	}
	// "none" is a valid persisted value but means "don't impose a
	// default" for handler purposes; fold to "" so the handler's
	// allowedStrategies whitelist filter naturally skips it.
	if strategy == SendTimeStrategyNone {
		return "", nil
	}
	return strategy, nil
}

// NewSTOStrategyStore is a constructor for symmetry with the other repo
// types in this package. Lets main.go construct the store without
// peeking into the struct fields.
func NewSTOStrategyStore(pool *db.Pool) *STOStrategyStore {
	return &STOStrategyStore{Pool: pool}
}
