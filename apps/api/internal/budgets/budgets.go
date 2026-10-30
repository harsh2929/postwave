// SPDX-License-Identifier: AGPL-3.0-only
//
// Package budgets owns per-API-key send + dollar caps. The middleware sits in
// front of the handler chain on API-key-authenticated routes, calls Check
// before the handler runs, and returns a structured 429 when the cap is hit.
//
// Periods:
//   - "sends"  — daily, anchored at UTC midnight.
//   - "cost"   — monthly, anchored at the first of the UTC month.
//
// Usage rows are stored per (api_key_id, period_date) where period_date is
// the day-bucket for sends and the month-start day for cost. The Repo's
// IncrementUsage uses ON CONFLICT DO UPDATE so concurrent increments are
// race-free at the database level.
package budgets

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Resource is the kind of budget being checked.
type Resource string

const (
	ResourceSends Resource = "sends"
	ResourceCost  Resource = "cost"
)

// Budget mirrors the relevant subset of api_keys columns.
type Budget struct {
	APIKeyID             string
	TenantID             string
	SendsPerDay          *int // nil => unlimited
	DollarsPerMonthCents *int // nil => unlimited
}

// Usage is the current period's running totals for a key.
type Usage struct {
	APIKeyID  string
	Period    time.Time
	Sends     int
	CostCents int
}

// BudgetExceededError is returned by Check when the requested increment
// would push usage over the configured cap. It carries enough information
// for the middleware to render a structured 429.
type BudgetExceededError struct {
	Resource   string
	RetryAfter time.Time
	Limit      int
	Current    int
}

// Error implements the error interface.
func (e *BudgetExceededError) Error() string {
	return fmt.Sprintf("budgets: %s budget exhausted (current=%d limit=%d, retry_after=%s)",
		e.Resource, e.Current, e.Limit, e.RetryAfter.UTC().Format(time.RFC3339))
}

// IsBudgetExceeded reports whether err is a *BudgetExceededError.
func IsBudgetExceeded(err error) (*BudgetExceededError, bool) {
	var b *BudgetExceededError
	if errors.As(err, &b) {
		return b, true
	}
	return nil, false
}

// PeriodFor returns the bucket date for the given resource at the given
// instant. Sends bucket per UTC day; cost buckets per UTC month-start.
func PeriodFor(resource Resource, at time.Time) time.Time {
	at = at.UTC()
	switch resource {
	case ResourceCost:
		return time.Date(at.Year(), at.Month(), 1, 0, 0, 0, 0, time.UTC)
	default:
		return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
	}
}

// NextPeriod returns the start of the period after the one containing at.
// Used to populate Retry-After on a 429.
func NextPeriod(resource Resource, at time.Time) time.Time {
	p := PeriodFor(resource, at)
	switch resource {
	case ResourceCost:
		return p.AddDate(0, 1, 0)
	default:
		return p.AddDate(0, 0, 1)
	}
}

// Checker is the surface the middleware needs from a Repo. Defining it as an
// interface keeps middleware tests free of pgx.
type Checker interface {
	LoadBudget(ctx context.Context, apiKeyID string) (*Budget, error)
	LoadUsage(ctx context.Context, apiKeyID string, period time.Time) (*Usage, error)
	IncrementUsage(ctx context.Context, b *Budget, resource Resource, increment int, at time.Time) error
}

// Check returns nil if the proposed increment fits the budget; otherwise a
// *BudgetExceededError. It does NOT mutate usage — callers (the middleware,
// the cost recorder) call IncrementUsage separately once they've decided to
// commit the work.
func Check(ctx context.Context, c Checker, keyID string, resource Resource, increment int) error {
	b, err := c.LoadBudget(ctx, keyID)
	if err != nil {
		return err
	}
	if b == nil {
		return nil
	}
	now := time.Now().UTC()
	period := PeriodFor(resource, now)
	u, err := c.LoadUsage(ctx, keyID, period)
	if err != nil {
		return err
	}
	current := 0
	limitPtr := (*int)(nil)
	switch resource {
	case ResourceSends:
		if u != nil {
			current = u.Sends
		}
		limitPtr = b.SendsPerDay
	case ResourceCost:
		if u != nil {
			current = u.CostCents
		}
		limitPtr = b.DollarsPerMonthCents
	default:
		return fmt.Errorf("budgets: unknown resource %q", resource)
	}
	if limitPtr == nil {
		return nil
	}
	limit := *limitPtr
	if current+increment > limit {
		return &BudgetExceededError{
			Resource:   string(resource),
			RetryAfter: NextPeriod(resource, now),
			Limit:      limit,
			Current:    current,
		}
	}
	return nil
}
