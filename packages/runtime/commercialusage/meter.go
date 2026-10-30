// Package commercialusage provides the shared, fail-closed monthly allowance
// authority used by the API, automation, and voice services.
package commercialusage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	runtimedb "github.com/postwave/postwave/packages/runtime/db"
)

type Resource string

const (
	ResourceAICreditMillis Resource = "ai_credit_millis"
	ResourceAutomationRuns Resource = "automation_runs"
	ResourceTrackedEvents  Resource = "tracked_events"
	ResourceAPIOperations  Resource = "api_operations"
)

var (
	ErrExceeded            = errors.New("commercial usage allowance exceeded")
	ErrIdempotencyConflict = errors.New("commercial usage idempotency conflict")
)

// Error is safe to project into a structured plan-limit response.
type Error struct {
	Resource  Resource
	Tier      string
	Limit     int64
	Used      int64
	Requested int64
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s allowance exceeded for %s tier: used=%d requested=%d limit=%d", e.Resource, e.Tier, e.Used, e.Requested, e.Limit)
}

func (e *Error) Unwrap() error { return ErrExceeded }

// Receipt is returned both for a new reservation and an idempotent replay.
type Receipt struct {
	Resource    Resource
	Tier        string
	PeriodStart time.Time
	Limit       int64
	Used        int64
	Requested   int64
	Replay      bool
}

// Meter serializes admissions per tenant, month, and resource in PostgreSQL.
// Production callers must provide Pool. A nil pool is an error, never an
// unlimited fallback.
type Meter struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

type tierAllowance struct {
	aiCreditMillis int64
	automationRuns int64
	trackedEvents  int64
	apiOperations  int64
}

var catalog = map[string]tierAllowance{
	"sandbox": {aiCreditMillis: 25_000, automationRuns: 10_000, trackedEvents: 50_000, apiOperations: 10_000},
	"launch":  {aiCreditMillis: 250_000, automationRuns: 25_000, trackedEvents: 250_000, apiOperations: 100_000},
	"growth":  {aiCreditMillis: 1_250_000, automationRuns: 250_000, trackedEvents: 1_000_000, apiOperations: 500_000},
	"scale":   {aiCreditMillis: 5_000_000, automationRuns: 2_500_000, trackedEvents: 4_000_000, apiOperations: 1_500_000},
}

// CanonicalTier preserves read compatibility without creating parallel plans.
// Unknown values fail closed as Sandbox.
func CanonicalTier(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "launch", "sending", "studio":
		return "launch"
	case "growth":
		return "growth"
	case "scale", "pro", "enterprise":
		return "scale"
	default:
		return "sandbox"
	}
}

func LimitForTier(tier string, resource Resource) int64 {
	allowance := catalog[CanonicalTier(tier)]
	switch resource {
	case ResourceAICreditMillis:
		return allowance.aiCreditMillis
	case ResourceAutomationRuns:
		return allowance.automationRuns
	case ResourceTrackedEvents:
		return allowance.trackedEvents
	case ResourceAPIOperations:
		return allowance.apiOperations
	default:
		return 0
	}
}

// Reserve consumes units. A non-empty idempotency key makes exact replays free;
// reusing the key with a different amount is rejected. Empty keys count every
// admission and avoid a high-cardinality reservation ledger when the owning
// resource already has its own durable request ledger.
func (m *Meter) Reserve(ctx context.Context, tenantID string, resource Resource, units int64, idempotencyKey, source string) (Receipt, error) {
	if m == nil || m.Pool == nil {
		return Receipt{}, errors.New("commercial usage meter is not configured")
	}
	if strings.TrimSpace(tenantID) == "" {
		return Receipt{}, errors.New("commercial usage tenant is required")
	}
	if LimitForTier("sandbox", resource) == 0 {
		return Receipt{}, fmt.Errorf("unknown commercial usage resource %q", resource)
	}
	if units <= 0 {
		return Receipt{}, errors.New("commercial usage units must be positive")
	}
	if len(idempotencyKey) > 1024 || len(source) > 128 {
		return Receipt{}, errors.New("commercial usage identity is too long")
	}

	now := time.Now().UTC()
	if m.Now != nil {
		now = m.Now().UTC()
	}
	period := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)

	tx, err := runtimedb.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return Receipt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tier, err := resolveTier(ctx, tx, tenantID)
	if err != nil {
		return Receipt{}, err
	}
	limit := LimitForTier(tier, resource)
	if limit <= 0 {
		return Receipt{}, &Error{Resource: resource, Tier: tier, Limit: limit, Requested: units}
	}

	var keyHash []byte
	if idempotencyKey != "" {
		hash := sha256.Sum256([]byte(idempotencyKey))
		keyHash = hash[:]
	}

	// Keep the exact, row-locked decision in PostgreSQL while collapsing the
	// ensure/lock/replay/insert/update sequence into one database round trip.
	// This path is synchronous on every metered request, so avoiding four extra
	// client/server exchanges materially reduces its latency contribution.
	var outcome string
	var used int64
	if err := tx.QueryRow(ctx, `
SELECT outcome, used_units
  FROM commercial_usage_reserve(
       $1::uuid, $2::date, $3::text, $4::bigint,
       $5::bigint, $6::bytea, $7::text
  )`, tenantID, period, string(resource), limit, units, keyHash, strings.TrimSpace(source)).Scan(&outcome, &used); err != nil {
		return Receipt{}, fmt.Errorf("commercial usage: reserve: %w", err)
	}
	switch outcome {
	case "replay":
		if err := tx.Commit(ctx); err != nil {
			return Receipt{}, fmt.Errorf("commercial usage: commit replay: %w", err)
		}
		return Receipt{Resource: resource, Tier: tier, PeriodStart: period, Limit: limit, Used: used, Requested: units, Replay: true}, nil
	case "conflict":
		return Receipt{}, ErrIdempotencyConflict
	case "exceeded":
		return Receipt{}, &Error{Resource: resource, Tier: tier, Limit: limit, Used: used, Requested: units}
	case "reserved":
		// Continue to commit below.
	default:
		return Receipt{}, fmt.Errorf("commercial usage: unexpected reserve outcome %q", outcome)
	}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, fmt.Errorf("commercial usage: commit: %w", err)
	}
	return Receipt{Resource: resource, Tier: tier, PeriodStart: period, Limit: limit, Used: used, Requested: units}, nil
}

func resolveTier(ctx context.Context, tx pgx.Tx, tenantID string) (string, error) {
	var tier string
	err := tx.QueryRow(ctx, `
SELECT COALESCE(NULLIF(bs.tier, ''), NULLIF(t.tier, ''), 'sandbox')
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID).Scan(&tier)
	if errors.Is(err, pgx.ErrNoRows) {
		return "sandbox", nil
	}
	if err != nil {
		return "", fmt.Errorf("commercial usage: resolve tier: %w", err)
	}
	return CanonicalTier(tier), nil
}
