// SPDX-License-Identifier: AGPL-3.0-only
//
// segment_membership.go — resolve the subscriber set behind a segment,
// preferring the materialised segment_subscribers cache and falling
// back to compiling segments.query_ast inline when the cache is empty
// or stale.
//
// Context (sto-segment-subscribers-materialized, P0):
//
//   - loadSegmentBestHours + LoadSegmentPattern + loadCampaignRecipients
//     all JOIN against `segment_subscribers`. That table didn't exist
//     until migration 0279, and the in-tx fallbacks in those callers
//     ran against an already-aborted Postgres transaction, so every
//     segment-scoped send-time-opt endpoint 500'd for fresh workspaces.
//
//   - Fix: resolveSegmentMembership() returns a (frag, args) pair that
//     names a relation containing the subscriber ids for a segment.
//     When the materialised cache has fresh rows we point the caller
//     at `segment_subscribers WHERE segment_id = ...`; when it's
//     empty/stale/missing we compile segments.query_ast → a SELECT
//     against subscribers and the caller wraps the compiled fragment
//     as an inline CTE / subquery. Either way the caller's outer
//     query is exactly one round-trip and never touches an aborted tx.
package send_time_opt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// segmentMembership names a (subquery, args, isFallback) triple. The
// subquery returns `subscriber_id` (uuid) for every subscriber in the
// segment. Callers wrap it as `IN (<subquery>)` or join against it.
//
// When isFallback is true the caller SHOULD record
// stoSegmentFallbackEngagedTotal so we can alert on a stalled
// materialiser worker.
type segmentMembership struct {
	// Subquery is a SELECT that yields a single subscriber_id (uuid)
	// column. Its placeholders are renumbered to slot in after the
	// caller's existing args; the caller passes (membership.Args...)
	// after their own.
	Subquery   string
	Args       []any
	IsFallback bool
	// Reason is the metric label when IsFallback=true:
	// "empty"        — cache rows exist but none for this segment.
	// "stale"        — cache rows exist but their computed_at is past
	//                  segmentCacheFreshFor.
	// "cache_miss"   — segment_subscribers query errored (e.g. table
	//                  missing on a not-yet-migrated env).
	Reason string
}

// segmentCacheFreshFor bounds the staleness window: cache rows older
// than this trigger a fallback to inline-AST compile. Tuned to the
// materialiser's default refresh cadence (5 min) with grace for jitter.
const segmentCacheFreshFor = 15 * time.Minute

// resolveSegmentMembership returns a membership subquery for the
// segment, using the cache when fresh and the inline-AST compile
// otherwise. argOffset is the number of args already bound on the
// caller's outer query (so we can renumber the compiled-AST
// placeholders). tenantArgPos is the 1-based position of the tenant
// argument in the caller's outer args; we re-use it instead of
// re-binding tenant_id, so the outer query sees a stable arg list.
//
// The function uses its own short-lived tx and never returns an
// aborted tx to the caller. That's the critical fix vs. the old
// in-tx fallback pattern.
func (r *Repo) resolveSegmentMembership(
	ctx context.Context,
	tenantID, segmentID string,
	argOffset int,
	tenantArgPos int,
	scope segments.PopulationScope,
) (*segmentMembership, error) {
	if segmentID == "" {
		return nil, errors.New("send_time_opt: segment_id required")
	}

	// 1. Probe the materialised cache. We pull computed_at for ONE row
	//    — that tells us both "is there any data" and "how stale". A
	//    full count would be more accurate but is wasteful; the row
	//    sample is fine because the materialiser writes all rows for a
	//    segment in one transaction.
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var computedAt *time.Time
	probeErr := tx.QueryRow(ctx, `
SELECT computed_at FROM segment_subscribers
WHERE tenant_id = $1::uuid AND segment_id::text = $2
LIMIT 1`, tenantID, segmentID).Scan(&computedAt)
	if probeErr != nil && !errors.Is(probeErr, pgx.ErrNoRows) {
		// Likely "relation does not exist" on an un-migrated env, OR
		// a transient pgx error. Either way the tx is now poisoned;
		// roll back and switch to AST-compile via a fresh tx.
		_ = tx.Rollback(ctx)
		return r.compileSegmentInlineFresh(ctx, tenantID, segmentID, argOffset, tenantArgPos, scope, "cache_miss")
	}
	cacheHit := probeErr == nil && computedAt != nil
	cacheFresh := cacheHit && time.Since(*computedAt) <= segmentCacheFreshFor

	if cacheHit && cacheFresh {
		scopePredicate, scopeErr := segments.CompilePopulation(
			ctx, nil, tenantID, segments.TransactionSegmentResolver{Queryer: tx}, scope,
		)
		if scopeErr != nil {
			return nil, scopeErr
		}
		// Cache fast-path. Subquery uses the caller's tenant arg
		// directly (via $tenantArgPos) and binds segment_id as our
		// own arg, which we splice in at argOffset+1.
		scopeSQL := renumberPlaceholders(scopePredicate.SQL, argOffset+1)
		sq := fmt.Sprintf(`SELECT ss.subscriber_id FROM segment_subscribers ss
JOIN subscribers ON subscribers.tenant_id = ss.tenant_id AND subscribers.id = ss.subscriber_id
WHERE ss.tenant_id = $%d::uuid AND ss.segment_id::text = $%d
  AND (%s)`,
			tenantArgPos, argOffset+1, scopeSQL)
		// Commit is fine even though we did no writes — it just
		// releases the snapshot.
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &segmentMembership{
			Subquery:   sq,
			Args:       append([]any{segmentID}, scopePredicate.Args...),
			IsFallback: false,
		}, nil
	}

	// 2. Cache stale or empty. Compile the segment's AST inline.
	//    Reason flags drive the prometheus counter:
	reason := "empty"
	if cacheHit && !cacheFresh {
		reason = "stale"
	}

	// Load the segment AST. We do this inside the still-open tx since
	// it isn't poisoned (the probe returned cleanly, just with no row
	// or with a stale row).
	var astRaw []byte
	if err := tx.QueryRow(ctx, `
SELECT query_ast::text FROM segments
WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, segmentID).Scan(&astRaw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			return nil, ErrNotFound
		}
		_ = tx.Rollback(ctx)
		// One more shot via a fresh tx — the original probe may have
		// poisoned this tx after all.
		return r.compileSegmentInlineFresh(ctx, tenantID, segmentID, argOffset, tenantArgPos, scope, reason)
	}
	predicate, err := segments.CompilePopulation(
		ctx,
		json.RawMessage(astRaw),
		tenantID,
		segments.TransactionSegmentResolver{Queryer: tx},
		scope,
	)
	if err != nil {
		return nil, fmt.Errorf("send_time_opt: compile segment ast: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	frag, args := predicate.SQL, predicate.Args
	// Renumber the canonical predicate's $1.. placeholders to start after the
	// caller's existing args.
	renumbered := renumberPlaceholders(frag, argOffset)
	sq := fmt.Sprintf(`SELECT id AS subscriber_id FROM subscribers
WHERE tenant_id = $%d::uuid AND (%s)`,
		tenantArgPos, renumbered)
	return &segmentMembership{
		Subquery:   sq,
		Args:       args,
		IsFallback: true,
		Reason:     reason,
	}, nil
}

// compileSegmentInlineFresh is the cache-miss recovery path: opens a
// fresh tx, loads the segment AST, compiles it. Used when the original
// probe tx was poisoned (e.g. table missing).
func (r *Repo) compileSegmentInlineFresh(
	ctx context.Context,
	tenantID, segmentID string,
	argOffset int,
	tenantArgPos int,
	scope segments.PopulationScope,
	reason string,
) (*segmentMembership, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var astRaw []byte
	if err := tx.QueryRow(ctx, `
SELECT query_ast::text FROM segments
WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, segmentID).Scan(&astRaw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	predicate, err := segments.CompilePopulation(
		ctx,
		json.RawMessage(astRaw),
		tenantID,
		segments.TransactionSegmentResolver{Queryer: tx},
		scope,
	)
	if err != nil {
		return nil, fmt.Errorf("send_time_opt: compile segment ast: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	frag, args := predicate.SQL, predicate.Args
	renumbered := renumberPlaceholders(frag, argOffset)
	sq := fmt.Sprintf(`SELECT id AS subscriber_id FROM subscribers
WHERE tenant_id = $%d::uuid AND (%s)`,
		tenantArgPos, renumbered)
	return &segmentMembership{
		Subquery:   sq,
		Args:       args,
		IsFallback: true,
		Reason:     reason,
	}, nil
}

// renumberPlaceholders rewrites $1, $2, … in a SQL fragment by adding
// `offset` to every placeholder index. Used to splice a compiled
// segment fragment (which starts placeholders at $1) into a query that
// already has `offset` args bound. Mirrors the implementation in
// campaigns/handlers_queue.go; duplicated here to avoid a circular
// dep between send_time_opt and campaigns.
func renumberPlaceholders(frag string, offset int) string {
	if offset == 0 {
		return frag
	}
	out := make([]byte, 0, len(frag)+4)
	i := 0
	for i < len(frag) {
		c := frag[i]
		if c != '$' {
			out = append(out, c)
			i++
			continue
		}
		j := i + 1
		for j < len(frag) && frag[j] >= '0' && frag[j] <= '9' {
			j++
		}
		if j == i+1 {
			out = append(out, c)
			i++
			continue
		}
		n := 0
		for k := i + 1; k < j; k++ {
			n = n*10 + int(frag[k]-'0')
		}
		out = append(out, '$')
		out = append(out, []byte(itoaNonNeg(n+offset))...)
		i = j
	}
	return string(out)
}

// itoaNonNeg is a leaf helper for renumberPlaceholders. Always returns
// at least one digit, even for n==0. Distinct from the file-local
// `itoa` which returns "0" for n<=0.
func itoaNonNeg(n int) string {
	if n == 0 {
		return "0"
	}
	if n < 0 {
		n = -n
	}
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// stoSegmentFallbackEngagedTotal increments every time a segment-scoped
// send-time-opt query had to fall back to compiling the segment AST
// inline against subscribers — i.e. the materialised
// segment_subscribers cache was empty / stale / unavailable. A
// sustained non-zero rate means the segment_materializer worker is
// either stalled or the segment AST changes faster than the refresh
// cadence.
//
//	sto_segment_fallback_engaged_total{reason="empty|stale|cache_miss",surface="best_hours|heatmap|recipients"}
var stoSegmentFallbackEngagedTotal = stoSegmentFallbackCounter()
