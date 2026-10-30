// SPDX-License-Identifier: AGPL-3.0-only
//
// pnl_repo.go — the pgx-backed PnLStore implementation on *Repo. Every
// method opens its own tenant-scoped tx so RLS fires. Each cross-table
// aggregate is best-effort (a missing optional table — commerce_orders,
// profile_predictions — degrades gracefully rather than failing the whole
// report), mirroring usage.go's error-ignore-and-continue idiom.
//
// Performance: the segment's compiled membership predicate can be an
// expensive correlated subquery (predictive/rfm fields). To avoid
// re-running it once per pillar, every member-scoped aggregate references
// a `members` CTE that compiles the AST exactly once (the spec's risk
// mitigation).
package segments

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// compile-time assertion: *Repo satisfies PnLStore.
var _ PnLStore = (*Repo)(nil)

// memberCTE returns a `WITH members AS (...)` prefix selecting the
// segment's member id + email, plus the compiled args. The frag is the
// AST WHERE fragment; its placeholders start at $1 (CompileAST numbers
// from $1), so callers that need extra params must append AFTER the frag
// args and reference them at the right index.
func memberCTE(frag string) string {
	return "WITH members AS (\n" +
		"  SELECT subscribers.id::text AS id, lower(subscribers.email::text) AS email\n" +
		"    FROM subscribers\n" +
		"   WHERE subscribers.tenant_id = current_setting('app.tenant_id', true)::uuid\n" +
		"     AND (" + frag + ")\n)"
}

// SegmentPnLRaw loads every raw aggregate for one segment's P&L. The
// segment lookup + AST compile happen first; each downstream pillar is a
// separate best-effort query against the materialised members CTE.
func (r *Repo) SegmentPnLRaw(ctx context.Context, tenantID, segmentID string, windowDays int) (*PnLRawData, error) {
	// Load the segment (and validate it belongs to the tenant) so we get
	// the QueryAST. Reuses the existing tenant-scoped Get.
	seg, err := r.Get(ctx, tenantID, segmentID)
	if err != nil {
		return nil, err
	}
	predicate, err := CompilePopulation(ctx, seg.QueryAST, tenantID, r, DefinitionPopulation(false))
	if err != nil {
		return nil, fmt.Errorf("segments: compile ast for pnl: %w", err)
	}
	frag, args := predicate.SQL, predicate.Args

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &PnLRawData{
		SegmentID:    segmentID,
		Currencies:   []PnLCurrencyTotal{},
		CostCurrency: "USD",
	}
	cte := memberCTE(frag)
	// windowDays is the last positional arg appended after the frag args.
	windowIdx := len(args) + 1
	windowArgs := append(append([]any{}, args...), windowDays)

	// 1. Member count.
	if err := tx.QueryRow(ctx, cte+"\nSELECT count(*)::bigint FROM members", args...).
		Scan(&out.MemberCount); err != nil {
		return nil, fmt.Errorf("segments: pnl member count: %w", err)
	}

	// 2. Revenue per-currency breakdown (conversions by segment members
	//    in the window — D4 member_all_sources scope).
	curRows, err := tx.Query(ctx, cte+fmt.Sprintf(`
SELECT COALESCE(c.currency, ''), count(*)::bigint, COALESCE(sum(c.amount_cents), 0)::bigint
  FROM conversions c
 WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
   AND c.occurred_at >= now() - make_interval(days => $%d)
   AND c.amount_cents IS NOT NULL
   AND lower(c.subscriber_email::text) IN (SELECT email FROM members)
 GROUP BY 1
 ORDER BY 3 DESC, 2 DESC, 1`, windowIdx), windowArgs...)
	if err == nil {
		for curRows.Next() {
			var ct PnLCurrencyTotal
			if scanErr := curRows.Scan(&ct.Currency, &ct.Conversions, &ct.RevenueCents); scanErr != nil {
				curRows.Close()
				return nil, scanErr
			}
			out.Currencies = append(out.Currencies, ct)
		}
		curRows.Close()
	}
	out.DominantCurrency = pnlDominantCurrency(out.Currencies)
	for _, ct := range out.Currencies {
		if ct.Currency == out.DominantCurrency {
			out.RevenueCents = ct.RevenueCents
			out.RevenueConversions = ct.Conversions
			break
		}
	}

	// 3. Attribution provenance split over ALL conversions in window
	//    (member-scoped), so the desktop never presents last-touch as
	//    certain.
	_ = tx.QueryRow(ctx, cte+fmt.Sprintf(`
SELECT
  count(*) FILTER (WHERE c.attributed_via = 'explicit')::bigint,
  count(*) FILTER (WHERE c.attributed_via = 'last_touch')::bigint,
  count(*) FILTER (WHERE c.attributed_via = 'none')::bigint,
  count(*) FILTER (WHERE c.attributed_via = 'code_redemption')::bigint,
  count(*) FILTER (WHERE c.attributed_via = 'campaign_vanity_path')::bigint,
  count(*) FILTER (WHERE c.attributed_via IS NULL)::bigint
  FROM conversions c
 WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
   AND c.occurred_at >= now() - make_interval(days => $%d)
   AND lower(c.subscriber_email::text) IN (SELECT email FROM members)`, windowIdx), windowArgs...).
		Scan(
			&out.Provenance.Explicit, &out.Provenance.LastTouch,
			&out.Provenance.None, &out.Provenance.CodeRedemption,
			&out.Provenance.CampaignVanityPath, &out.Provenance.Unclassified,
		)

	// 4. AOV (commerce_orders, dominant currency only — no cross-currency
	//    sum). Best-effort: missing table / no integration → AOV nil.
	if out.DominantCurrency != "" {
		var orderCount int64
		var aovCents float64
		aovArgs := append(append([]any{}, args...), out.DominantCurrency)
		curIdx := len(args) + 1
		err := tx.QueryRow(ctx, cte+fmt.Sprintf(`
SELECT count(*)::bigint, COALESCE(avg(o.total_cents), 0)::float8
  FROM commerce_orders o
 WHERE o.tenant_id = current_setting('app.tenant_id', true)::uuid
   AND o.currency = $%d
   AND lower(o.customer_email::text) IN (SELECT email FROM members)`, curIdx), aovArgs...).
			Scan(&orderCount, &aovCents)
		if err == nil && orderCount > 0 {
			out.HasOrders = true
			out.AOVCents = int64(aovCents + 0.5)
			out.AOVOrderCount = orderCount
			out.AOVCurrency = out.DominantCurrency
		}
	}

	// 5. CLV reconciliation (profile_predictions). Best-effort.
	_ = tx.QueryRow(ctx, cte+`
SELECT count(*)::bigint,
       COALESCE(sum(p.historic_clv_cents), 0)::bigint,
       COALESCE(sum(p.predicted_clv_cents), 0)::bigint
  FROM profile_predictions p
 WHERE p.tenant_id = current_setting('app.tenant_id', true)::uuid
   AND lower(p.email::text) IN (SELECT email FROM members)`, args...).
		Scan(&out.CLVMembersScored, &out.CLVHistoricSumCents, &out.CLVPredictedSumCents)

	// 6. Cost-side event counts (subscriber_events, member-scoped). Same
	//    window as revenue.
	_ = tx.QueryRow(ctx, cte+fmt.Sprintf(`
SELECT
  count(*) FILTER (WHERE e.event_type = 'unsubscribed')::bigint,
  count(*) FILTER (WHERE e.event_type = 'complained')::bigint
  FROM subscriber_events e
 WHERE e.tenant_id = current_setting('app.tenant_id', true)::uuid
   AND e.at >= now() - make_interval(days => $%d)
   AND lower(e.subscriber_email::text) IN (SELECT email FROM members)`, windowIdx), windowArgs...).
		Scan(&out.UnsubCount, &out.ComplaintCount)

	// 7. Cost config (tenant-wide, D3). Absent row → defaults (zero),
	//    cost_config_present=false.
	var unsubCost, complaintCost int32
	var costCurrency string
	cfgErr := tx.QueryRow(ctx, `
SELECT unsub_cost_cents, complaint_cost_cents, currency
  FROM segment_pnl_cost_config
 WHERE tenant_id = current_setting('app.tenant_id', true)::uuid`).
		Scan(&unsubCost, &complaintCost, &costCurrency)
	if cfgErr == nil {
		out.CostConfigPresent = true
		out.UnsubCostCents = int64(unsubCost)
		out.ComplaintCostCents = int64(complaintCost)
		out.CostCurrency = costCurrency
	} else if out.DominantCurrency != "" {
		// No config: default the cost currency to the revenue currency so
		// the (zero-cost) net contribution is still comparable.
		out.CostCurrency = out.DominantCurrency
	}

	// 8. Holdout config (segment_holdouts). Absent → no holdout.
	var hPercent float64
	var hSeed string
	var hWindow int
	hErr := tx.QueryRow(ctx, `
SELECT percent::float8, seed, window_days
  FROM segment_holdouts
 WHERE segment_id = $1::uuid
   AND tenant_id = current_setting('app.tenant_id', true)::uuid`, segmentID).
		Scan(&hPercent, &hSeed, &hWindow)
	if hErr == nil {
		out.HasHoldout = true
		out.HoldoutPercent = hPercent
		out.HoldoutSeed = hSeed
		out.HoldoutWindow = hWindow
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// SegmentLiftCohorts returns the segment's member subscriber ids and the
// set of those ids that converted (any monetary conversion) within the
// window. The pure liftFromCohorts function does the partition + delta.
func (r *Repo) SegmentLiftCohorts(ctx context.Context, tenantID, segmentID string, windowDays int) ([]string, map[string]bool, error) {
	seg, err := r.Get(ctx, tenantID, segmentID)
	if err != nil {
		return nil, nil, err
	}
	predicate, err := CompilePopulation(ctx, seg.QueryAST, tenantID, r, DefinitionPopulation(false))
	if err != nil {
		return nil, nil, fmt.Errorf("segments: compile ast for lift: %w", err)
	}
	frag, args := predicate.SQL, predicate.Args

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cte := memberCTE(frag)

	// Member ids.
	memberIDs := make([]string, 0, 1024)
	rows, err := tx.Query(ctx, cte+"\nSELECT id FROM members", args...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id string
		if scanErr := rows.Scan(&id); scanErr != nil {
			rows.Close()
			return nil, nil, scanErr
		}
		memberIDs = append(memberIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	// Converted member ids (join conversions on member email → member id).
	converted := make(map[string]bool, 256)
	windowIdx := len(args) + 1
	windowArgs := append(append([]any{}, args...), windowDays)
	crows, err := tx.Query(ctx, cte+fmt.Sprintf(`
SELECT DISTINCT m.id
  FROM members m
  JOIN conversions c
    ON c.tenant_id = current_setting('app.tenant_id', true)::uuid
   AND lower(c.subscriber_email::text) = m.email
 WHERE c.occurred_at >= now() - make_interval(days => $%d)
   AND c.amount_cents IS NOT NULL`, windowIdx), windowArgs...)
	if err == nil {
		for crows.Next() {
			var id string
			if scanErr := crows.Scan(&id); scanErr != nil {
				crows.Close()
				return nil, nil, scanErr
			}
			converted[id] = true
		}
		crows.Close()
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return memberIDs, converted, nil
}

// UpsertSegmentHoldout creates or updates the segment_holdouts row. The
// seed is derived deterministically from the segment id so the same
// segment always hashes its members into stable buckets across config
// edits (changing percent re-slices the SAME ordering, not a new random
// one).
func (r *Repo) UpsertSegmentHoldout(ctx context.Context, tenantID, segmentID string, percent float64, windowDays int) (*SegmentHoldoutConfig, error) {
	// Validate the segment exists for this tenant first.
	if _, err := r.Get(ctx, tenantID, segmentID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	seed := "seg-holdout:" + segmentID
	var cfg SegmentHoldoutConfig
	err = tx.QueryRow(ctx, `
INSERT INTO segment_holdouts (segment_id, tenant_id, percent, seed, window_days)
VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2, $3, $4)
ON CONFLICT (segment_id) DO UPDATE
   SET percent = EXCLUDED.percent,
       window_days = EXCLUDED.window_days,
       updated_at = now()
RETURNING segment_id::text, percent::float8, seed, window_days, decided_at, created_at, updated_at`,
		segmentID, percent, seed, windowDays).
		Scan(&cfg.SegmentID, &cfg.Percent, &cfg.Seed, &cfg.WindowDays, &cfg.DecidedAt, &cfg.CreatedAt, &cfg.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// DeleteSegmentHoldout removes the segment_holdouts row. Returns
// ErrNotFound when no row existed for the segment.
func (r *Repo) DeleteSegmentHoldout(ctx context.Context, tenantID, segmentID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
DELETE FROM segment_holdouts
 WHERE segment_id = $1::uuid
   AND tenant_id = current_setting('app.tenant_id', true)::uuid`, segmentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}
