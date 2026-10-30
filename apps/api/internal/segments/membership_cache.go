// SPDX-License-Identifier: AGPL-3.0-only
//
// membership_cache.go — the one way segment_subscribers is rewritten.
//
// Two workers keep the materialised membership cache (migration 0279) current:
// SegmentEventWorker within about a second of a subscriber event, and the
// send-time materialiser for segments whose cache has gone stale.
// They used to be two copies of one statement sequence, "kept byte-compatible"
// by a comment, and each copy carried the same three defects:
//
//   - the event worker decided whether a baseline existed from
//     last_evaluated_at, which display-only writers also set, so the next
//     event after a recompute forwarded every member as a new entrant;
//   - its entrant query aliased `subscribers` while the compiled predicate
//     names the table itself (42P01), and the failure aborted the transaction
//     it was meant to be best-effort inside, so every later refresh failed;
//   - both wrote the active-only cache size into last_count, overwriting the
//     archive-inclusive figure a segment with include_archived displays.
//
// RefreshMembershipCache is now the only writer, and both workers reach it
// through RefreshAndForwardEntrants, so either one reports the subscribers who
// entered. It stamps segments.membership_baseline_at (migration 2058) in the
// same transaction as the rewrite, diffs entrants against that baseline inside
// a savepoint, and writes last_count under the segment's own archive scope.

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// MembershipRefreshOptions tunes one cache rewrite.
type MembershipRefreshOptions struct {
	// DetectEntrants diffs the new membership against the existing baseline
	// before replacing it, and reports the subscribers who entered. It has no
	// effect on a segment with no baseline yet: there, every member would look
	// new.
	DetectEntrants bool

	// entrantQuery replaces collectEntrants. Tests set it to make detection fail
	// inside a real rewrite; production leaves it nil.
	entrantQuery entrantQueryFunc
}

// entrantQueryFunc reads the subscribers who entered a segment; see
// collectEntrants.
type entrantQueryFunc func(ctx context.Context, tx pgx.Tx, tenantID, segmentID, predicate string, args []any) ([]SegmentJoinEvent, bool, error)

// MembershipRefresh reports one rewrite of a segment's membership cache.
type MembershipRefresh struct {
	// Found is false when the segment no longer exists. Any cache rows left
	// behind were removed and nothing else was written.
	Found bool
	// Members is the number of subscribers now cached: the segment's
	// non-archived definition population, which is what every consumer of the
	// cache activates, whatever the segment's include_archived setting.
	Members int
	// Count is the segment's size under its own archive scope, written to
	// last_count. It equals Members unless the segment includes archived
	// subscribers.
	Count int
	// Baselined reports whether the cache already held a baseline for the
	// current definition before this rewrite.
	Baselined bool
	// Entrants are the subscribers who match now but were not cached before.
	// Populated only when DetectEntrants is set and a baseline existed, and
	// capped at entrantForwardCap.
	Entrants []SegmentJoinEvent
	// EntrantsCapped reports that more subscribers entered than Entrants holds.
	EntrantsCapped bool
	// EntrantDetectionErr is why entrant detection failed, if it did. Detection
	// is best-effort: it runs in a savepoint, so its failure leaves the rewrite
	// itself intact and Entrants empty.
	EntrantDetectionErr error
	// Superseded reports that the segment was edited while the rewrite ran. The
	// rows describe the definition the rewrite read, so it recorded neither a
	// baseline nor a count: a redefinition has already cleared the baseline,
	// and the next rewrite starts a new one instead of diffing the new
	// definition against these rows. Entrants are still reported; they entered
	// the segment as it was defined until the edit.
	Superseded bool
}

// RefreshMembershipCache rewrites segment_subscribers for one segment inside
// the caller's tenant-scoped transaction, then records the new baseline,
// last_count and last_evaluated_at. The caller commits, and must not act on
// Entrants until that commit has succeeded.
func RefreshMembershipCache(ctx context.Context, tx pgx.Tx, tenantID, segmentID string, opts MembershipRefreshOptions) (MembershipRefresh, error) {
	var out MembershipRefresh
	// Cache writers take a per-segment advisory lock: every API replica runs
	// both workers, and without it two of them diff against the same old cache
	// and forward the same entrant twice. The second waits, then diffs against
	// the first one's committed rows. A lock on the segments row would do the
	// same but would also stall every edit and evaluation of the segment for
	// the whole rewrite; the advisory lock is invisible to them.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('segment_cache:' || lower($1), 0))`, segmentID); err != nil {
		return out, err
	}
	var astRaw []byte
	var includeArchived bool
	var version time.Time
	err := tx.QueryRow(ctx, `
SELECT query_ast::text, include_archived, membership_baseline_at IS NOT NULL, updated_at
  FROM segments
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, segmentID).Scan(&astRaw, &includeArchived, &out.Baselined, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		// Deleted between enqueue and refresh. The foreign key cascades, so this
		// only matters for rows a concurrent writer committed after the delete.
		_, err = tx.Exec(ctx, `
DELETE FROM segment_subscribers
 WHERE tenant_id = $1::uuid AND segment_id::text = $2`, tenantID, segmentID)
		return out, err
	}
	if err != nil {
		return out, err
	}
	out.Found = true
	ast := json.RawMessage(astRaw)
	resolver := TransactionSegmentResolver{Queryer: tx}

	cached, err := CompilePopulation(ctx, ast, tenantID, resolver, DefinitionPopulation(false))
	if err != nil {
		return out, err
	}
	// $1 is the tenant and $2 the segment; the predicate's own placeholders
	// follow them.
	predicate := shiftPlaceholders(cached.SQL, 2)
	args := append([]any{tenantID, segmentID}, cached.Args...)

	// Entrants are diffed BEFORE the rewrite, which erases the baseline.
	if opts.DetectEntrants && out.Baselined {
		query := opts.entrantQuery
		if query == nil {
			query = collectEntrants
		}
		out.Entrants, out.EntrantsCapped, out.EntrantDetectionErr = collectEntrantsInSavepoint(ctx, tx, query, tenantID, segmentID, predicate, args)
	}

	// The cache is always the active population; the displayed size follows the
	// segment's own archive scope, the same one Recompute and the size snapshot
	// count under, so the list stops flipping between writers. It is counted
	// before the rewrite: the INSERT's foreign-key checks key-share-lock the
	// segments row until commit, which holds up a rename, so nothing slow
	// should run after it.
	archiveScopedCount := -1
	if includeArchived {
		scoped, compileErr := CompilePopulation(ctx, ast, tenantID, resolver, DefinitionPopulation(true))
		if compileErr != nil {
			return out, compileErr
		}
		if err = tx.QueryRow(ctx, "SELECT COUNT(*) FROM subscribers WHERE "+scoped.SQL, scoped.Args...).Scan(&archiveScopedCount); err != nil {
			return out, err
		}
	}

	if _, err = tx.Exec(ctx, `
DELETE FROM segment_subscribers
 WHERE tenant_id = $1::uuid AND segment_id::text = $2`, tenantID, segmentID); err != nil {
		return out, err
	}
	tag, err := tx.Exec(ctx, `
INSERT INTO segment_subscribers (tenant_id, segment_id, subscriber_id, computed_at)
SELECT $1::uuid, $2::uuid, subscribers.id, now()
  FROM subscribers
 WHERE subscribers.tenant_id = $1::uuid AND (`+predicate+`)
ON CONFLICT (tenant_id, segment_id, subscriber_id) DO UPDATE
SET computed_at = EXCLUDED.computed_at`, args...)
	if err != nil {
		return out, err
	}
	out.Members = int(tag.RowsAffected())
	out.Count = out.Members
	if includeArchived {
		out.Count = archiveScopedCount
	}

	// Pinned to the version read above, like every other size writer: an edit
	// that landed during the rewrite (it no longer waits for one) means the
	// rows and the count describe a definition the segment no longer has.
	tag, err = tx.Exec(ctx, `
UPDATE segments
   SET last_count = $3,
       last_evaluated_at = now(),
       membership_baseline_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND updated_at = $4`, tenantID, segmentID, out.Count, version)
	if err != nil {
		return out, err
	}
	out.Superseded = tag.RowsAffected() == 0
	return out, nil
}

// collectEntrantsInSavepoint runs entrant detection in a savepoint. A failed
// statement aborts a Postgres transaction, so detection that merely logged its
// error used to leave the cache rewrite after it failing with 25P02 on every
// refresh. Rolling back to the savepoint keeps the rewrite alive.
func collectEntrantsInSavepoint(ctx context.Context, tx pgx.Tx, query entrantQueryFunc, tenantID, segmentID, predicate string, args []any) ([]SegmentJoinEvent, bool, error) {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	entrants, capped, err := query(ctx, savepoint, tenantID, segmentID, predicate, args)
	if err != nil {
		if rollbackErr := savepoint.Rollback(ctx); rollbackErr != nil {
			return nil, false, errors.Join(err, rollbackErr)
		}
		return nil, false, err
	}
	if err := savepoint.Commit(ctx); err != nil {
		return nil, false, err
	}
	return entrants, capped, nil
}

// collectEntrants returns the subscribers who match the segment's cached
// population now but are not in its segment_subscribers baseline: the
// transition the segment_joined trigger fires on. It reads at most
// entrantForwardCap+1 rows so overflow is detectable without being unbounded.
//
// The outer relation is the bare `subscribers` table because the compiled
// predicate refers to `subscribers.<column>`; aliasing it is a 42P01.
func collectEntrants(ctx context.Context, tx pgx.Tx, tenantID, segmentID, predicate string, args []any) ([]SegmentJoinEvent, bool, error) {
	rows, err := tx.Query(ctx, `
SELECT subscribers.email
  FROM subscribers
 WHERE subscribers.tenant_id = $1::uuid AND (`+predicate+`)
   AND NOT EXISTS (
       SELECT 1 FROM segment_subscribers baseline
        WHERE baseline.tenant_id = $1::uuid
          AND baseline.segment_id = $2::uuid
          AND baseline.subscriber_id = subscribers.id)
 ORDER BY subscribers.id
 LIMIT `+strconv.Itoa(entrantForwardCap+1), args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := make([]SegmentJoinEvent, 0)
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, false, err
		}
		if strings.TrimSpace(email) == "" {
			continue
		}
		out = append(out, SegmentJoinEvent{TenantID: tenantID, SubscriberEmail: email, SegmentID: segmentID})
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(out) > entrantForwardCap {
		return out[:entrantForwardCap], true, nil
	}
	return out, false, nil
}
