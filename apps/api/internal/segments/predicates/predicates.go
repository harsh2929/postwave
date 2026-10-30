// Package predicates collects the extension predicate builders that
// supplement the in-process AST compiler in apps/api/internal/segments.
//
// The base compiler in compile.go handles profile fields, tag
// membership, predictive columns, and JSONB custom-field extracts.
// The 2026 Lists & Suppressions modernization adds five new
// predicate families that need richer SQL than a single column
// comparison:
//
//   - aggregate (sum/avg/count of an event property over N days) — GAP-LS-072
//   - composable in_segment / not_in_segment                     — GAP-LS-070
//   - event_funnel (did A then B then not C)                     — GAP-LS-071
//   - location_radius (within N miles of zip / lat-long)         — GAP-LS-073
//   - channel_consent (can/cannot receive on email/sms/push)     — GAP-LS-074
//
// Each helper here is a pure function that takes the predicate
// inputs and returns a parameterised SQL fragment + bound args, so
// the existing compiler can compose them in via the same placeholder
// scheme ($N positional). They are kept in this subpackage so the
// surface stays separate from the legacy in-line compiler — a
// future compiler refactor can adopt them without churning the
// existing call sites.
package predicates

import (
	"fmt"
	"strings"
)

// Fragment is the standard tuple every predicate builder returns:
// a SQL snippet that fits inside a SELECT ... FROM subscribers
// WHERE clause, plus the positional args to bind. start is the
// next placeholder index to use; the builder shifts $1, $2 … by
// (start-1) so callers can splice fragments without renumbering.
type Fragment struct {
	SQL  string
	Args []any
}

// shift renumbers a fragment that was built assuming $1.. to start
// at the given offset. Used by the composable / funnel builders
// that compose sub-fragments.
func shift(frag string, offset int) string {
	if offset <= 0 {
		return frag
	}
	// Walk the string and rewrite $N → $(N+offset). We do it by hand
	// rather than with regexp because the fragments come from
	// trusted local builders and the perf cost matters in tight
	// preview-count loops.
	var b strings.Builder
	for i := 0; i < len(frag); i++ {
		c := frag[i]
		if c != '$' {
			b.WriteByte(c)
			continue
		}
		// Scan digits.
		j := i + 1
		for j < len(frag) && frag[j] >= '0' && frag[j] <= '9' {
			j++
		}
		if j == i+1 {
			b.WriteByte(c)
			continue
		}
		// Parse n.
		n := 0
		for k := i + 1; k < j; k++ {
			n = n*10 + int(frag[k]-'0')
		}
		b.WriteString(fmt.Sprintf("$%d", n+offset))
		i = j - 1
	}
	return b.String()
}
