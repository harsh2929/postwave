package campaigns

// quota.go — monthly-send quota enforcement for the BULK send path.
//
// The quota that the whole pricing ladder rests on used to be checked and
// incremented ONLY on the single-recipient test-send handler. The bulk path
// had no reference to limits at all, so a tenant capped at 2,000 sends could
// queue a 2,000,000-recipient campaign and nothing stopped it.

import (
	"context"
	"errors"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

// monthlySendQuotaError maps the queue-time preflight onto a public error. It
// never admits paid overage: the dispatch-time sendallowance gate is the final
// concurrency-safe authority, and additional managed volume requires a plan
// change before a provider attempt.
func (d *Deps) monthlySendQuotaError(ctx context.Context, tenantID string, requested int, checkErr error) *queueError {
	var le *limits.Error
	if !errors.As(checkErr, &le) {
		// Not a plan-limit breach — a real infrastructure error.
		return &queueError{Status: http.StatusInternalServerError, Err: checkErr}
	}
	return quotaExceededQueueError(checkErr)
}

// quotaExceededQueueError maps a plan-limit breach onto the queue path's error
// type. Returns nil for any other error (including nil), so the caller can
// treat a nil result as "not a quota problem".
//
// The 402 + body shape deliberately mirror limits.WriteExceeded so a caller
// hitting the cap on the bulk path gets the same response as on every other
// metered path.
func quotaExceededQueueError(err error) *queueError {
	var e *limits.Error
	if !errors.As(err, &e) {
		return nil
	}
	// Built from the shared constructor rather than a second hand-written copy
	// of the same envelope. `limits` had the identical map literal, so a change
	// to either diverged from the other with nothing to notice.
	// `plan.`-prefixed subject, matching limits.WriteExceeded exactly.
	//
	// These two build the SAME denial from the same *limits.Error — that
	// duplication is why `entitlement` exists. While PlanLimit ignored its
	// subject argument they agreed by accident; the moment it was honoured they
	// diverged, and the same error yielded `subject: plan.monthly_sends` from
	// one and `subject: monthly_sends` from the other.
	d := entitlement.PlanLimit(
		"plan."+string(e.Resource), string(e.Resource), e.Tier, e.Error(),
		int64(e.Limit), int64(e.Current),
	)
	return &queueError{
		// Status comes from the reason, not a literal. Hardcoding 402 here left
		// the mapping unified in name only: change ReasonPlan's status and
		// `limits` would follow while this path silently would not.
		Status: entitlement.StatusFor(d.Reason),
		// Message is set explicitly. The agent/MCP path reads it from the
		// queueError, and an adversarial review showed that putting a STRUCT in
		// Body broke `messageFromQueueErrorBody` — which switches on
		// map[string]string / map[string]any and matched neither — so an agent
		// that hit the monthly-send cap stopped being told which cap, which
		// tier, and by how much, and got a bare status code instead. That is
		// the opposite of what this contract exists to provide.
		Message: d.Message,
		Body:    map[string]any{"error": entitlement.AsMap(d)},
	}
}
