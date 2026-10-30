// SPDX-License-Identifier: AGPL-3.0-only

// history.go — reading back what the board already records.
//
// ops_check_history has been appended on every status transition since
// migration 1700 and read by nothing. Without it the board can say "this is
// red" and "it first went red 19h ago", which is enough to notice a problem
// and not enough to decide what to do about it. The two questions that
// actually change the response are:
//
//   - has this ever been green? A check that has been red since it was
//     written is usually a wrong threshold, not an outage.
//   - is it flapping? A check crossing back and forth is a measurement bug,
//     and treating it as an incident burns attention on the wrong thing.
//
// Only the transition log answers either.
package ops

import (
	"context"
	"time"
)

// HistoryEntry is one recorded status transition. The reconciler appends only
// when the status CHANGES, so a check red for a week is a single row -- which
// is why anything derived from this counts transitions, never observations.
type HistoryEntry struct {
	CheckID string    `json:"check_id"`
	From    Status    `json:"from"`
	To      Status    `json:"to"`
	Detail  string    `json:"detail,omitempty"`
	At      time.Time `json:"at"`
}

// History returns a check's transitions, newest first -- the order an operator
// reads a timeline, from now backwards.
func (s *Store) History(ctx context.Context, checkID string, limit int) ([]HistoryEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT check_id, from_status, to_status, detail, at
		  FROM ops_check_history
		 WHERE check_id = $1
		 ORDER BY at DESC, id DESC
		 LIMIT $2`, checkID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []HistoryEntry{}
	for rows.Next() {
		var e HistoryEntry
		if err := rows.Scan(&e.CheckID, &e.From, &e.To, &e.Detail, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// FlapCount is the number of transitions inside the window.
//
// Transitions, not observations: a check that has been solidly red for three
// days has one history row and a flap count of zero, which is correct. A check
// with eight crossings in a day is almost never eight incidents -- it is one
// threshold sitting exactly where the signal lives.
func FlapCount(entries []HistoryEntry, now time.Time, window time.Duration) int {
	cutoff := now.Add(-window)
	n := 0
	for _, e := range entries {
		if e.At.After(cutoff) {
			n++
		}
	}
	return n
}
