// SPDX-License-Identifier: AGPL-3.0-only
//
// Package subscriberscore computes a per-subscriber CHURN RISK
// score (0..100, higher = more likely to unsubscribe in the next
// 7 days) and persists it onto subscribers.churn_score.
//
// The model is a deliberately simple heuristic — no MLOps platform,
// no model registry. Three signals, weighted, capped at 100:
//
//   * Recency      — days since last open/click/positive event.
//                    A subscriber dark for 60 days is at high risk.
//   * Negative     — count of bounces/complaints in the last 30d.
//                    Even one complaint is a strong signal.
//   * Mismatch     — sends_received_last_30d ÷ opens_last_30d.
//                    High ratio = we're sending more than they engage
//                    with → mailbox-fatigue precursor to unsubscribe.
//
// The scorer reads subscriber_events (per-event log) and writes
// back to subscribers.churn_score in batches. Cadence: every 6h
// from a goroutine in main.go; this is a low-priority background
// signal, not a hot path.

package subscriberscore

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// MaxScore is the upper bound on churn_score. Persisted as smallint,
// so we cap before write.
const MaxScore = 100

// Scorer drives the per-tenant scoring loop. Constructed in main.go.
type Scorer struct {
	Pool   *db.Pool
	Logger *slog.Logger
	// Interval between full sweeps. Zero -> 6h.
	Interval time.Duration
	// BatchSize caps how many subscribers we score per query so a
	// huge tenant doesn't monopolise a tick. Zero -> 5000.
	BatchSize int
}

// Run blocks until ctx is cancelled. Each tick scores every tenant's
// subscribers in batches.
func (s *Scorer) Run(ctx context.Context) {
	if s == nil || s.Pool == nil {
		return
	}
	interval := s.Interval
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	// One immediate tick at startup so a fresh deployment sees
	// scores within minutes, not hours.
	s.tick(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// tick scores every tenant in turn. Bounded per-tenant batch +
// per-tenant timeout so a slow tenant doesn't block the rest.
func (s *Scorer) tick(ctx context.Context) {
	tenants, err := s.listTenants(ctx)
	if err != nil {
		s.log().Warn("churn scorer: list tenants failed", "err", err.Error())
		return
	}
	for _, tenantID := range tenants {
		tCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		if n, err := s.ScoreTenant(tCtx, tenantID); err != nil {
			s.log().Warn("churn scorer: tenant tick failed",
				"tenant_id", tenantID, "err", err.Error())
		} else if n > 0 {
			s.log().Info("churn scorer: tenant tick complete",
				"tenant_id", tenantID, "scored", n)
		}
		cancel()
	}
}

// listTenants enumerates active tenants cross-tenant under
// db.WithWorkerScope. tenants is FORCE RLS and its tenant_worker_select
// policy (migration 1708) requires app.outbox_worker='true'. We bind that
// GUC inside an explicit transaction the helper owns: a transaction-local
// set_config(..., true) on a bare pooled conn would reset before the
// follow-up SELECT (each statement is its own implicit tx outside an
// explicit one), so the scan would see zero tenants and the scorer would
// silently score nothing every tick.
func (s *Scorer) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx,
		`SELECT id::text FROM tenants ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Read-only scan — the deferred Rollback closes the worker-scope tx.
	return out, nil
}

// ScoreTenant computes + persists churn_score for one tenant. Returns
// the number of subscribers written. Exported so the test suite +
// admin "rescan" endpoint can drive a single tenant on demand.
func (s *Scorer) ScoreTenant(ctx context.Context, tenantID string) (int, error) {
	if tenantID == "" {
		return 0, errors.New("subscriberscore: tenant required")
	}
	batch := s.BatchSize
	if batch <= 0 {
		batch = 5000
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// CTE: per-subscriber signals across the last 60 days.
	// We compute days_since_last_event (recency), negative event
	// count (bounce/complaint), and frequency mismatch
	// (sends/opens). The final UPDATE writes the weighted score.
	//
	// We OPTed to do the math in SQL (rather than pull rows into Go
	// and write back) because:
	//   * one round-trip per tenant
	//   * Postgres is faster at counting per-group than Go is
	//   * the model is simple enough that the SQL stays readable
	tag, err := tx.Exec(ctx, `
WITH signals AS (
  SELECT s.id AS subscriber_id, s.email,
    GREATEST(
      0,
      EXTRACT(EPOCH FROM (now() - COALESCE(MAX(e.at) FILTER (WHERE e.event_type IN ('opened','clicked')), now() - interval '180 days'))) / 86400
    ) AS days_since_engage,
    COUNT(*) FILTER (WHERE e.event_type IN ('bounced','complained') AND e.at >= now() - interval '30 days') AS neg_30d,
    COUNT(*) FILTER (WHERE e.event_type = 'sent' AND e.at >= now() - interval '30 days') AS sent_30d,
    COUNT(*) FILTER (WHERE e.event_type IN ('opened','clicked') AND e.at >= now() - interval '30 days') AS pos_30d
   FROM subscribers s
   LEFT JOIN subscriber_events e
     ON e.subscriber_email = s.email AND e.tenant_id = s.tenant_id
  WHERE s.tenant_id = $1::uuid
    AND s.status = 'enabled'
  GROUP BY s.id, s.email
  LIMIT $2
),
scored AS (
  SELECT subscriber_id,
    LEAST($3::int,
      -- Recency: 0..50 over a 60d window. Past 60d clamps to 50.
      LEAST(50, GREATEST(0, ((days_since_engage - 7) * 50 / 53)::int))
      -- Negatives: 30 per bounce/complaint in last 30d.
      + LEAST(60, neg_30d::int * 30)
      -- Mismatch: high send-to-open ratio. Add up to 30 when
      -- the subscriber gets >5 sends but engages with <2.
      + CASE
          WHEN sent_30d >= 5 AND pos_30d = 0 THEN 30
          WHEN sent_30d >= 10 AND pos_30d <= 1 THEN 20
          ELSE 0
        END
    ) AS score
   FROM signals
)
UPDATE subscribers s
   SET churn_score = scored.score,
       churn_score_at = now()
  FROM scored
 WHERE s.id = scored.subscriber_id`,
		tenantID, batch, MaxScore)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// suppressMath silences the math import linter — the heuristic is
// in SQL but we keep math available for future weight functions
// that operate on the Go side.
var _ = math.MaxInt32

func (s *Scorer) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}
