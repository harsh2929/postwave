// SPDX-License-Identifier: AGPL-3.0-only
//
// events_by_id.go — id-list parsing for GET /api/v1/audit/events
// (desktop-audit gap A21). The desktop's AuditInvestigationTimeline
// used to cursor-walk the main list endpoint with a 5×500 budget just
// to resolve the handful of audit row ids an investigation cites as
// evidence. The events-by-id endpoint fetches exactly those rows; this
// file owns the query-string contract so the cap and the dedupe rules
// are unit-testable without HTTP plumbing.
package audit

import (
	"fmt"
	"strconv"
	"strings"
)

// MaxEventIDsPerRequest caps how many ids one GET /api/v1/audit/events
// call may resolve. 100 comfortably covers an investigation's evidence
// set (the agent cites tens of rows, not hundreds) while keeping the
// ANY($1::bigint[]) scan bounded.
const MaxEventIDsPerRequest = 100

// ParseEventIDs parses the `ids` query parameter ("1,2,3") into a
// deduplicated []int64.
//
// Contract:
//   - empty / blank input is an error (the endpoint is by-id only;
//     "give me everything" stays on the main list endpoint),
//   - every entry must be a positive base-10 int64,
//   - duplicates collapse silently (the timeline may cite one row
//     twice; that's not a caller bug),
//   - more than MaxEventIDsPerRequest distinct ids is an error so the
//     caller learns to batch instead of silently losing rows.
func ParseEventIDs(raw string) ([]int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("ids is required (comma-separated audit row ids)")
	}
	parts := strings.Split(raw, ",")
	seen := make(map[int64]struct{}, len(parts))
	out := make([]int64, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			// Tolerate trailing/double commas ("1,2,") — these come
			// from sloppy client-side joins, not malicious input.
			continue
		}
		n, err := strconv.ParseInt(p, 10, 64)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("ids entry %q is not a positive integer", p)
		}
		if _, dup := seen[n]; dup {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("ids is required (comma-separated audit row ids)")
	}
	if len(out) > MaxEventIDsPerRequest {
		return nil, fmt.Errorf("too many ids: %d (max %d per request)", len(out), MaxEventIDsPerRequest)
	}
	return out, nil
}
