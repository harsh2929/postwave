// event_funnel.go — GAP-LS-071: event funnel predicate (did A then
// B then not C). Klaviyo shipped this in 2024 as a first-class
// segment predicate.
//
// The semantics:
//
//   - A sequence of steps, each {event_name, mode, window?}
//   - mode = "did" / "did_not"
//   - window (optional) clamps the step to a relative time window
//     anchored on the prior step (or now() for the first step)
//
// The compiled SQL chains correlated EXISTS subqueries over the
// product_events table, each step keying off the prior step's
// timestamp via a LATERAL join. We keep depth bounded (max 5
// steps) so a pathological "did A then B then C then D then E
// then F" predicate cannot blow up the planner.

package predicates

import (
	"fmt"
	"strings"
	"time"
)

// FunnelStep is one step in the funnel.
type FunnelStep struct {
	EventName string
	// Mode: "did" or "did_not". did → EXISTS; did_not → NOT EXISTS.
	Mode string
	// WindowDays clamps "in the last N days" measured from the
	// prior step's timestamp (or now() for step 0). Zero = no
	// window.
	WindowDays int
}

// FunnelInput is the call shape.
type FunnelInput struct {
	Steps             []FunnelStep
	PlaceholderOffset int
}

// MaxFunnelSteps caps the depth of a funnel predicate.
const MaxFunnelSteps = 5

// CompileFunnel returns the WHERE fragment.
func CompileFunnel(in FunnelInput) (Fragment, error) {
	if len(in.Steps) == 0 {
		return Fragment{SQL: "TRUE"}, nil
	}
	if len(in.Steps) > MaxFunnelSteps {
		return Fragment{}, fmt.Errorf("predicates: funnel exceeds max depth %d", MaxFunnelSteps)
	}
	off := in.PlaceholderOffset
	if off <= 0 {
		off = 1
	}

	// Build the EXISTS chain right-to-left so each step references
	// the prior step's timestamp via the outer query's `at`.
	args := make([]any, 0, 2*len(in.Steps))
	var b strings.Builder

	// Outermost wrapper: aliases the subscriber row so we can join
	// on tenant + email.
	for i, step := range in.Steps {
		event := strings.TrimSpace(step.EventName)
		if event == "" {
			return Fragment{}, fmt.Errorf("predicates: funnel step %d missing event_name", i)
		}
		mode := strings.ToLower(strings.TrimSpace(step.Mode))
		if mode == "" {
			mode = "did"
		}
		if mode != "did" && mode != "did_not" {
			return Fragment{}, fmt.Errorf("predicates: funnel step %d unknown mode %q", i, step.Mode)
		}

		args = append(args, event)
		eventPH := fmt.Sprintf("$%d", off+len(args)-1)

		windowClause := ""
		if step.WindowDays > 0 {
			args = append(args, step.WindowDays)
			windowPH := fmt.Sprintf("$%d", off+len(args)-1)
			if i == 0 {
				windowClause = fmt.Sprintf(" AND occurred_at >= now() - %s::int * interval '1 day'", windowPH)
			} else {
				// Window relative to the prior step's occurred_at,
				// referenced via the outer alias `pe%d`.
				windowClause = fmt.Sprintf(" AND occurred_at >= pe%d.occurred_at - %s::int * interval '1 day'",
					i-1, windowPH)
			}
		}

		// Order matters — later steps must occur AFTER earlier
		// steps for "did then did" sequencing. For did_not, the
		// "after" anchor is still meaningful (Klaviyo: "did B then
		// not C" means C did not happen after B).
		orderClause := ""
		if i > 0 {
			orderClause = fmt.Sprintf(" AND occurred_at > pe%d.occurred_at", i-1)
		}

		// Open this step. did → EXISTS; did_not → NOT EXISTS.
		op := "EXISTS"
		if mode == "did_not" {
			op = "NOT EXISTS"
		}
		fmt.Fprintf(&b, "%s (SELECT 1 FROM product_events pe%d WHERE pe%d.tenant_id = subscribers.tenant_id"+
			" AND lower(pe%d.subscriber_email::text) = lower(subscribers.email::text)"+
			" AND pe%d.event_name = %s%s%s",
			op, i, i, i, i, eventPH, windowClause, orderClause)

		if i == len(in.Steps)-1 {
			// Close all opened parens.
			for k := 0; k < len(in.Steps); k++ {
				b.WriteString(")")
			}
		} else {
			b.WriteString(" AND ")
		}
	}

	return Fragment{SQL: b.String(), Args: args}, nil
}

// recentAnchor exposed so callers can validate the maximum window
// horizon they want to allow at the public API boundary (Klaviyo
// caps at 365d; we mirror).
func recentAnchor(days int) time.Time { return time.Now().Add(-time.Hour * 24 * time.Duration(days)) }
