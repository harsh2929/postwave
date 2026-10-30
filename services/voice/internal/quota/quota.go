// Package quota implements per-tenant daily AI quota for the voice
// service. Until 0082 landed, the voice handlers called Anthropic with
// no per-tenant rate limit at all — a single misbehaving free tenant
// could spend an arbitrary fraction of the org's Anthropic budget.
//
// The contract is small:
//
//	q.CheckAndConsume(ctx, tenantID, kind, cost)
//
// Returns ErrOverQuota when the increment would put the tenant past
// their daily total. The handler then maps the error to HTTP 429 with
// a JSON body the desktop / web clients can display verbatim.
//
// Two implementations:
//
//   - NoopQuota: always allows. Used in tests + the dev path where
//     the operator hasn't wired a Postgres pool. Matches the "in-
//     memory fallback" pattern the rest of services/voice uses.
//
//   - PostgresQuota: atomic UPSERT into tenant_ai_usage with a CTE
//     that pre-checks the projected sum. Tier resolution is a caller-
//     supplied function so this package doesn't pull in apps/api
//     billing types (which would create a service-boundary import).
//
// Daily reset is implicit: the PRIMARY KEY on tenant_ai_usage is
// (tenant_id, day, kind) where `day` is the UTC date. A fresh date
// mints a fresh row at count=cost; the previous day's row stays for
// audit but doesn't count toward today's quota.
//
// Tier limits are env-overridable so an operator can bump a tier
// during a partner pilot without a code deploy:
//
//	POSTWAVE_AI_QUOTA_FREE   (default 100)
//	POSTWAVE_AI_QUOTA_STUDIO (default 5000)
//	POSTWAVE_AI_QUOTA_SCALE  (default 50000)
//
// Per-kind overrides (PerKind on Limits) are reserved for future use —
// the current schema computes the limit against the daily total across
// all kinds, which is the simplest user-facing story (a single number
// to communicate, a single number to alert on).
package quota

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Limits captures the cap for a tier. PerKind is reserved (currently
// unused; the PostgresQuota check enforces the DailyTotal).
type Limits struct {
	DailyTotal int // total calls/day across all kinds
	// MonthlyCreditMillis is the production commercial allowance. DailyTotal
	// remains for compatibility with older test fakes and is no longer used by
	// the production Voice wiring.
	MonthlyCreditMillis int
	PerKind             map[string]int // optional per-kind override (unused today)
}

// Quota is the contract handlers use before every LLM call.
type Quota interface {
	// CheckAndConsume increments tenant usage for the given kind by
	// `cost`. Returns ErrOverQuota when the increment would push the
	// tenant past their tier's limit. Atomic: two concurrent calls
	// cannot both succeed when the second would overflow.
	CheckAndConsume(ctx context.Context, tenantID, kind string, cost int) error
	// Limits returns the current tier's limits for a tenant. Used by
	// the 429 response body so clients can display "x of N today".
	Limits(ctx context.Context, tenantID string) (Limits, error)
}

// ErrOverQuota is returned when the tenant has hit their daily cap.
// Handlers map this to HTTP 429 with a structured body so the UI can
// surface a clean upgrade prompt instead of a generic error.
var ErrOverQuota = errors.New("ai quota exceeded")

// Default tier limits. Override via env at startup.
const (
	defaultLimitFree   = 100
	defaultLimitStudio = 5000
	defaultLimitScale  = 50000
)

// TierFree, TierStudio, TierScale mirror the tier vocabulary used by
// apps/api's billing package. Duplicated here as constants because
// importing apps/api from services/voice would cross the service
// boundary; the strings are stable.
const (
	TierFree    = "free"
	TierSandbox = "sandbox"
	TierStudio  = "studio"
	TierLaunch  = "launch"
	TierGrowth  = "growth"
	TierScale   = "scale"
)

// LimitsForTier returns the configured limits for a tier name. Unknown
// tiers fall back to the free tier — fail-closed so a typo in the
// tier-resolver function doesn't accidentally grant scale-tier limits.
func LimitsForTier(tier string) Limits {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case TierStudio, TierLaunch, TierGrowth:
		return Limits{DailyTotal: envInt("POSTWAVE_AI_QUOTA_STUDIO", defaultLimitStudio)}
	case TierScale:
		return Limits{DailyTotal: envInt("POSTWAVE_AI_QUOTA_SCALE", defaultLimitScale)}
	default:
		return Limits{DailyTotal: envInt("POSTWAVE_AI_QUOTA_FREE", defaultLimitFree)}
	}
}

// envInt reads a positive int from the env. Empty / non-numeric /
// non-positive values fall back to def so a misconfigured operator
// can't accidentally set the limit to zero (which would lock every
// tenant out).
func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// ---------------------------------------------------------------------
// NoopQuota — always allows.
// ---------------------------------------------------------------------

// NoopQuota is the test / dev implementation. Every CheckAndConsume
// call returns nil; Limits returns a sentinel "unlimited" shape.
type NoopQuota struct{}

// CheckAndConsume implements Quota. Always returns nil.
func (NoopQuota) CheckAndConsume(_ context.Context, _, _ string, _ int) error { return nil }

// Limits implements Quota. Returns DailyTotal = 0 to signal "no cap".
func (NoopQuota) Limits(_ context.Context, _ string) (Limits, error) {
	return Limits{DailyTotal: 0}, nil
}

// ---------------------------------------------------------------------
// PostgresQuota — atomic upsert against tenant_ai_usage.
// ---------------------------------------------------------------------

// advisoryLockNamespace scopes this package's transaction advisory locks so
// they cannot collide with another subsystem's. Arbitrary but fixed.
const advisoryLockNamespace = 0x51544131 // "QTA1"

// TierResolver resolves a tenant id to a tier slug. The caller wires
// this so we don't import apps/api/internal/billing here. Returning
// "" or an unknown string falls back to the free tier (fail-closed).
type TierResolver func(ctx context.Context, tenantID string) (string, error)

// PostgresQuota is the production implementation. Backed by
// tenant_ai_usage (see infra/migrations/0082_quota_and_metadata.sql).
type PostgresQuota struct {
	Pool *pgxpool.Pool
	Tier TierResolver
	// Now is the time source for the UTC day key. Tests override this
	// to verify daily reset; production leaves it nil so we use real
	// time.Now().UTC().
	Now func() time.Time
}

// today returns the UTC date string ("YYYY-MM-DD") that keys the
// composite PK. We use a string instead of time.Time so we don't have
// to round-trip the timezone through pgx.
func (q *PostgresQuota) today() time.Time {
	now := time.Now().UTC()
	if q.Now != nil {
		now = q.Now().UTC()
	}
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

// CheckAndConsume runs an atomic UPSERT inside a tenant-scoped tx.
//
// The query shape:
//  1. Bind app.tenant_id (RLS).
//  2. UPSERT the (tenant, day, kind) row, returning the new count.
//  3. Sum across all kinds for today.
//  4. If the sum exceeds the tier's DailyTotal, roll back via a
//     compensating UPDATE so the failed call doesn't leak budget.
//
// We rely on the tx for atomicity: the UPSERT + sum + compensating
// UPDATE all succeed or none do.
//
// SERIALIZATION IS PER TENANT, NOT PER ROW. This comment used to say the
// UPSERT's row lock made concurrent calls safe. That is true only when both
// calls use the SAME kind: the conflict target is (tenant_id, day, kind), so
// two calls with DIFFERENT kinds touch different rows, take no common lock, and
// under READ COMMITTED neither one's SUM sees the other's uncommitted
// increment. Both conclude they are under the cap and both commit.
//
// Demonstrated against Postgres: two transactions incrementing different kinds
// each read a total of 1 while the committed total became 2. The overshoot is
// bounded by the number of concurrently-distinct kinds — and this service uses
// at least five (sequence, sequence_draft, regenerate, template_generate, plus
// chat's caller-supplied kind), each unit of which is a paid generation.
//
// The advisory lock below closes it: transaction-scoped, keyed on the tenant,
// released automatically on commit or rollback, and it needs no schema change
// or isolation-level bump.
func (q *PostgresQuota) CheckAndConsume(ctx context.Context, tenantID, kind string, cost int) error {
	if q == nil || q.Pool == nil {
		return errors.New("quota: postgres pool not configured")
	}
	if tenantID == "" {
		return errors.New("quota: tenant id required")
	}
	if kind == "" {
		return errors.New("quota: kind required")
	}
	if cost <= 0 {
		cost = 1
	}

	tier, err := q.resolveTier(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("quota: resolve tier: %w", err)
	}
	limits := LimitsForTier(tier)

	tx, err := q.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("quota: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("quota: bind tenant: %w", err)
	}

	// Serialize every quota decision for this tenant. hashtext() is stable
	// within a major version and collisions only cost a little contention, not
	// correctness — two tenants sharing a hash simply queue behind each other.
	// The namespace constant keeps this lock space distinct from any other
	// advisory-lock user in the database.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock($1::int, hashtext($2))`,
		advisoryLockNamespace, tenantID); err != nil {
		return fmt.Errorf("quota: lock tenant: %w", err)
	}

	day := q.today()

	// Atomic UPSERT — RETURNING the per-kind count after the +cost.
	// We don't use the per-kind count for the limit check (current
	// product is a single daily-total cap), but having it back makes
	// the row visible for audit + future per-kind rules.
	var perKindCount int
	if err := tx.QueryRow(ctx, `
INSERT INTO tenant_ai_usage (tenant_id, day, kind, count)
VALUES ($1::uuid, $2::date, $3, $4)
ON CONFLICT (tenant_id, day, kind) DO UPDATE
   SET count = tenant_ai_usage.count + EXCLUDED.count,
       updated_at = now()
RETURNING count`, tenantID, day, kind, cost).Scan(&perKindCount); err != nil {
		return fmt.Errorf("quota: upsert usage: %w", err)
	}

	// Sum across all kinds for today. The same tx sees the row we
	// just wrote (READ COMMITTED is fine because the UPSERT held the
	// row lock above).
	var totalToday int
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(SUM(count), 0)::int FROM tenant_ai_usage
 WHERE tenant_id = $1::uuid AND day = $2::date`, tenantID, day).Scan(&totalToday); err != nil {
		return fmt.Errorf("quota: sum usage: %w", err)
	}

	if limits.DailyTotal > 0 && totalToday > limits.DailyTotal {
		// Compensate the increment so a rejected call doesn't permanently
		// burn the tenant's budget. The UPDATE is in the same tx as the
		// UPSERT so a tx-level rollback would also work — but we want
		// the row to exist (with the original count, pre-increment) for
		// observability and to keep the audit trail honest.
		if _, err := tx.Exec(ctx, `
UPDATE tenant_ai_usage
   SET count = count - $4,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND day = $2::date AND kind = $3`,
			tenantID, day, kind, cost); err != nil {
			return fmt.Errorf("quota: rollback increment: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("quota: commit rollback: %w", err)
		}
		return ErrOverQuota
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("quota: commit: %w", err)
	}
	return nil
}

// Limits returns the tier's limits without consuming any quota.
// Used by the 429 response body so clients can render "x of N today".
func (q *PostgresQuota) Limits(ctx context.Context, tenantID string) (Limits, error) {
	if q == nil {
		return Limits{}, errors.New("quota: nil receiver")
	}
	tier, err := q.resolveTier(ctx, tenantID)
	if err != nil {
		return Limits{}, err
	}
	return LimitsForTier(tier), nil
}

// LookupTier exposes the resolved tier for a tenant. Used by handlers
// to populate the 429 response body so clients can render a tier-aware
// upgrade prompt.
func (q *PostgresQuota) LookupTier(ctx context.Context, tenantID string) (string, error) {
	return q.resolveTier(ctx, tenantID)
}

// resolveTier defers to the configured TierResolver. A nil resolver
// or empty result falls back to the free tier — same fail-closed
// posture as LimitsForTier.
func (q *PostgresQuota) resolveTier(ctx context.Context, tenantID string) (string, error) {
	if q.Tier == nil {
		return TierFree, nil
	}
	tier, err := q.Tier(ctx, tenantID)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(tier) == "" {
		return TierFree, nil
	}
	return tier, nil
}

// BillingStateTierResolver is the standard production resolver. It
// looks up tenants.tier (or billing_state.tier — implementations may
// project from either). When the row is missing, returns "free" so a
// brand-new tenant lands in the most restrictive bucket until billing
// confirms a paid tier.
//
// Defined here as a helper so main.go can wire it in one line; the
// type is exposed so tests can construct PostgresQuota with a fake
// resolver.
func BillingStateTierResolver(pool *pgxpool.Pool) TierResolver {
	return func(ctx context.Context, tenantID string) (string, error) {
		if pool == nil || tenantID == "" {
			return TierFree, nil
		}
		// We don't go through db.WithTenant here because billing_state
		// has its own RLS policy that allows the row owner to read its
		// own tier. The set_config call binds the GUC the policy reads.
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			return "", err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
			return "", err
		}
		var tier string
		err = tx.QueryRow(ctx, `
SELECT COALESCE(tier, '') FROM billing_state WHERE tenant_id = $1::uuid LIMIT 1`,
			tenantID).Scan(&tier)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return TierFree, tx.Commit(ctx)
			}
			return "", err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", err
		}
		// Return Moosewave's canonical commercial vocabulary. Legacy names
		// remain read-compatible, but no new allowance decision is made in
		// terms of the retired names.
		switch strings.ToLower(strings.TrimSpace(tier)) {
		case "studio", "sending", TierLaunch:
			return TierLaunch, nil
		case TierGrowth:
			return TierGrowth, nil
		case "pro", TierScale, "enterprise":
			return TierScale, nil
		default:
			return TierSandbox, nil
		}
	}
}

// resetsAtUTCMidnight returns the next UTC midnight as an RFC3339
// string. Used in the 429 response body so the client can show a
// "resets at HH:MM" hint without recomputing.
func ResetsAtUTCMidnight(now time.Time) string {
	tomorrow := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
	return tomorrow.Format(time.RFC3339)
}
