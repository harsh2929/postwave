// SPDX-License-Identifier: AGPL-3.0-only
package operation

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// One list of everything currently running, across every family.
//
// The registry could already answer "what does `partial` mean on
// `writeback_runs`" and nobody could ask "what is running right now". Twenty
// families each have their own page, so the question a person actually has —
// "is the thing I started finished?" — is answered by remembering which of
// twenty screens their job lives on. The families were built one at a time and
// the shared view was never built at all.
//
// WHY A UNION AND NOT A TABLE. A `operations` table every family wrote to would
// be a second source of truth, and the failure mode is the one this codebase
// keeps hitting: a family that forgets to write is silently absent, and absent
// looks exactly like finished. Reading the families directly cannot drift,
// because there is nothing to keep in sync.

// Record is one operation in the shared view.
type Record struct {
	Kind       string     `json:"kind"`
	Table      string     `json:"-"`
	ID         string     `json:"id"`
	State      State      `json:"state"`
	RawStatus  string     `json:"raw_status"`
	CreatedAt  *time.Time `json:"created_at,omitempty"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Error      string     `json:"error,omitempty"`
	// OccurredAt is what the list is ordered by: the most recent of the times
	// this family records. Surfaced so a client sorting a merged page does not
	// have to re-derive the same precedence and get it subtly different.
	OccurredAt time.Time `json:"occurred_at"`
	// Blocked explains why a non-terminal operation will not progress — a
	// disabled runtime rather than a queue it is waiting in. Nil when the work
	// is genuinely just waiting.
	Blocked *BlockedReason `json:"blocked,omitempty"`
}

// Query narrows the shared view.
type Query struct {
	// States filters to canonical states. Empty means every state.
	States []State
	// Limit caps the merged result. Applied per family as well, so one busy
	// family cannot crowd out the rest of the page.
	Limit int
}

const (
	defaultLimit = 50
	maxLimit     = 200
)

// Aggregator reads the shared view.
type Aggregator struct{ Pool *db.Pool }

// List returns the tenant's operations across every tenant-scoped family,
// newest first.
//
// A family whose query fails does NOT fail the request. The whole point is to
// answer "is my job done" without knowing which family it lives in, and a view
// that goes blank because one table is mid-migration is worse than one that is
// honestly incomplete — so failures are collected and reported alongside the
// rows, rather than swallowed or fatal.
func (a *Aggregator) List(ctx context.Context, tenantID string, q Query) ([]Record, []string, error) {
	if a == nil || a.Pool == nil {
		return nil, nil, fmt.Errorf("operation: aggregator unavailable")
	}
	if tenantID == "" {
		return nil, nil, fmt.Errorf("operation: tenant required")
	}
	limit := q.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	tx, err := db.WithTenant(ctx, a.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	wanted := map[State]bool{}
	for _, s := range q.States {
		wanted[s] = true
	}

	var out []Record
	var degraded []string
	for _, family := range TenantFamilies() {
		cols := FamilyColumns[family.Table]
		rows, err := tx.Query(ctx, familySelect(family.Table, cols), tenantID, limit)
		if err != nil {
			degraded = append(degraded, family.Kind)
			continue
		}
		for rows.Next() {
			var rec Record
			var raw string
			var errText *string
			if err := rows.Scan(&rec.ID, &raw, &rec.CreatedAt, &rec.StartedAt, &rec.FinishedAt, &errText); err != nil {
				degraded = append(degraded, family.Kind)
				break
			}
			state, ok := Canonical(family.Table, raw)
			if !ok {
				// An unmapped status is a registry gap, not a row to hide. The
				// DB-backed test fails on it, so this only happens between a
				// migration landing and the registry catching up — and during
				// that window the row must still be visible, because it is
				// still somebody's running job.
				state = StateUnknown
			}
			if len(wanted) > 0 && !wanted[state] {
				continue
			}
			rec.Kind = family.Kind
			rec.Table = family.Table
			rec.State = state
			rec.RawStatus = raw
			if errText != nil {
				rec.Error = *errText
			}
			rec.OccurredAt = occurredAt(rec)
			rec.Blocked = blockedReasonFor(family.Kind, state)
			out = append(out, rec)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			degraded = append(degraded, family.Kind)
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].OccurredAt.Equal(out[j].OccurredAt) {
			// A stable tiebreak so two runs stamped in the same transaction do
			// not swap places between requests and read as new activity.
			return out[i].ID > out[j].ID
		}
		return out[i].OccurredAt.After(out[j].OccurredAt)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	sort.Strings(degraded)
	return out, degraded, tx.Commit(ctx)
}

// occurredAt is the most recent time this row has.
//
// Finished, else started, else created. Ordering on created_at alone would bury
// a long job that just failed beneath every job queued since it started, which
// is the opposite of what someone scanning for problems needs.
func occurredAt(rec Record) time.Time {
	if rec.FinishedAt != nil {
		return *rec.FinishedAt
	}
	if rec.StartedAt != nil {
		return *rec.StartedAt
	}
	if rec.CreatedAt != nil {
		return *rec.CreatedAt
	}
	return time.Time{}
}

// familySelect builds one family's arm of the view.
//
// Identifiers are interpolated, which is safe here and only here: every table
// and column name comes from the compile-time registry above, never from a
// request. The tenant id and limit are bound parameters. `quoteIdent` is
// applied anyway so a future registry entry with an odd name cannot change the
// shape of the statement.
func familySelect(table string, cols Columns) string {
	col := func(name string) string {
		if name == "" {
			// A family that does not record this fact selects NULL rather than
			// a zero value: "no start time recorded" and "started at the epoch"
			// are different facts, and the second is a lie the UI would render.
			return "NULL::timestamptz"
		}
		return quoteIdent(name)
	}
	errCol := "NULL::text"
	if cols.Error != "" {
		errCol = quoteIdent(cols.Error)
	}
	// Ordered and limited PER FAMILY so one busy table cannot fill the page and
	// hide every other family's work.
	return fmt.Sprintf(`
SELECT id::text, status, %s, %s, %s, %s
  FROM %s
 WHERE %s = $1::uuid
 ORDER BY COALESCE(%s, %s, %s) DESC NULLS LAST
 LIMIT $2`,
		col(cols.CreatedAt), col(cols.StartedAt), col(cols.FinishedAt), errCol,
		quoteIdent(table), quoteIdent(cols.TenantID),
		col(cols.FinishedAt), col(cols.StartedAt), col(cols.CreatedAt),
	)
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
