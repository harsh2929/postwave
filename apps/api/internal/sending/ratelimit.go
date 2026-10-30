// Send-loop guard — Postgres-backed token bucket.
//
// Per-tenant hourly send cap. The bucket lives in tenant_send_rate_buckets
// (migration 0068); the cap value comes from tenant_sending_settings.
// max_sends_per_hour. The cap is global per-tenant, not per-campaign.
//
// Why Postgres and not Redis: the gateway today has no Redis dependency.
// Adding one for a per-tenant counter that updates a few hundred times an
// hour is overbuilt. The token bucket is one row per tenant, an atomic
// upsert per send, and Postgres FOR UPDATE handles contention fine at this
// scale. If the campaign throughput grows past ~10k sends/hour-per-tenant
// we'll move to Redis with the same Try() shape.
//
// Atomicity contract: Try() takes a row lock on the bucket via
// INSERT … ON CONFLICT … DO UPDATE — Postgres serializes concurrent calls
// for the same tenant_id without an explicit SELECT FOR UPDATE. Two
// gateway instances calling Try() concurrently for one tenant will see
// linearised counter increments.

package sending

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// PostgresRateLimiter is the per-tenant token bucket. Window defaults to
// one hour when zero; smaller windows are useful in tests.
type PostgresRateLimiter struct {
	Pool   *db.Pool
	Window time.Duration
}

// effectiveWindow returns the configured Window or the 1h default.
func (r *PostgresRateLimiter) effectiveWindow() time.Duration {
	if r == nil || r.Window <= 0 {
		return time.Hour
	}
	return r.Window
}

// Try atomically reserves `n` slots from tenantID's bucket.
//
// Returns:
//   - allowed=true, retryAt=zero, nil error → bucket had room; n slots
//     were committed to the counter. The caller MAY proceed to send.
//   - allowed=false, retryAt=<window end>, nil error → bucket is full or
//     no cap configured-and-non-positive. retryAt is the earliest time
//     the counter will reset.
//   - allowed=false, retryAt=zero, err → some Postgres error happened.
//
// Special case: when tenant_sending_settings has no row OR
// max_sends_per_hour IS NULL OR max_sends_per_hour <= 0 we treat the
// tenant as UNCAPPED and return allowed=true without touching the bucket.
// Counting sends for an uncapped tenant would still work but it would also
// bake every gateway send into a write — and the bucket is only useful as
// a gate, not as an analytics counter.
func (r *PostgresRateLimiter) Try(ctx context.Context, tenantID string, n int) (bool, time.Time, error) {
	if n <= 0 {
		return true, time.Time{}, nil
	}
	if r == nil || r.Pool == nil {
		return false, time.Time{}, errors.New("ratelimit: nil pool")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Resolve the cap. Missing row / NULL / <=0 → uncapped → allow.
	var cap int
	var hasCap bool
	err = tx.QueryRow(ctx, `
SELECT COALESCE(max_sends_per_hour, 0), max_sends_per_hour IS NOT NULL
FROM tenant_sending_settings
WHERE tenant_id = $1::uuid`, tenantID).Scan(&cap, &hasCap)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, time.Time{}, fmt.Errorf("ratelimit: read cap: %w", err)
	}
	if errors.Is(err, pgx.ErrNoRows) || !hasCap || cap <= 0 {
		// Uncapped — commit the (empty) tx so the connection returns to
		// the pool cleanly and bail out as allowed.
		if cerr := tx.Commit(ctx); cerr != nil {
			return false, time.Time{}, cerr
		}
		return true, time.Time{}, nil
	}

	// 2. Read-modify-write the bucket row. We use SELECT … FOR UPDATE on
	//    the existing row when present, falling back to INSERT when the
	//    bucket doesn't exist yet. This is two roundtrips instead of one
	//    but it's clear, correct, and the per-tenant contention is low.
	//    The earlier single-statement upsert had a subtle bug where the
	//    RETURNING-side CASE expression saw post-update column values on
	//    the INSERT path and mis-classified the very first send as
	//    denied.
	window := r.effectiveWindow()
	var (
		sent     int
		winStart time.Time
		exists   bool
	)
	err = tx.QueryRow(ctx, `
SELECT sent_count, window_start, true
FROM   tenant_send_rate_buckets
WHERE  tenant_id = $1::uuid
FOR UPDATE`, tenantID).Scan(&sent, &winStart, &exists)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, time.Time{}, fmt.Errorf("ratelimit: read bucket: %w", err)
	}
	now := time.Now().UTC()
	if exists && now.Sub(winStart) >= window {
		// Window elapsed — reset.
		sent = 0
		winStart = now
	}
	if !exists {
		winStart = now
		sent = 0
	}
	if sent+n > cap {
		// Deny. We don't write anything, but we DO want to make sure a
		// freshly-rolled window_start gets persisted so subsequent calls
		// don't see a stale window.
		if exists && winStart.Equal(now) {
			if _, uerr := tx.Exec(ctx, `
UPDATE tenant_send_rate_buckets
SET    window_start = $2, sent_count = 0, updated_at = now()
WHERE  tenant_id    = $1::uuid`, tenantID, winStart); uerr != nil {
				return false, time.Time{}, uerr
			}
			if cerr := tx.Commit(ctx); cerr != nil {
				return false, time.Time{}, cerr
			}
		}
		return false, winStart.Add(window), nil
	}

	// Allow: increment the counter (or insert the row) and commit.
	if exists {
		if _, uerr := tx.Exec(ctx, `
UPDATE tenant_send_rate_buckets
SET    sent_count   = $2,
       window_start = $3,
       updated_at   = now()
WHERE  tenant_id    = $1::uuid`, tenantID, sent+n, winStart); uerr != nil {
			return false, time.Time{}, fmt.Errorf("ratelimit: update bucket: %w", uerr)
		}
	} else {
		if _, ierr := tx.Exec(ctx, `
INSERT INTO tenant_send_rate_buckets (tenant_id, window_start, sent_count, updated_at)
VALUES ($1::uuid, $2, $3, now())`, tenantID, winStart, n); ierr != nil {
			return false, time.Time{}, fmt.Errorf("ratelimit: insert bucket: %w", ierr)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, time.Time{}, err
	}
	return true, time.Time{}, nil
}
