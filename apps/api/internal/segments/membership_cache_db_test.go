// SPDX-License-Identifier: AGPL-3.0-only
//
// membership_cache_db_test.go — the segment_subscribers writer and the
// segment_joined entrants it reports, executed through SegmentEventWorker's
// real drain against Postgres.
//
// Two defects are pinned here:
//   - the entrant query aliased `subscribers` while the compiled predicate
//     names the bare table (42P01), and that failure aborted the refresh's
//     transaction (25P02), so after the first materialisation every
//     event-driven refresh failed and "Entered segment" never fired;
//   - the worker took last_evaluated_at as proof of a baseline, but the manual
//     recompute, the daily snapshot and evaluate-on-save all write it without
//     touching the cache, so the next event forwarded every member as new.

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func drainOnce(t *testing.T, w *SegmentEventWorker, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	started := time.Now()
	if _, err := w.drainTenant(ctx, tenantID); err != nil {
		t.Fatalf("drainTenant after %s: %v\nsessions of this role at the failure:\n%s",
			time.Since(started).Round(time.Millisecond), err, sessionSnapshot(w.Pool))
	}
}

// sessionSnapshot lists what the test role's other sessions were doing, so a
// drain that times out says whether it was waiting on a lock or on a loaded
// machine.
func sessionSnapshot(pool *pgxpool.Pool) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := pool.Query(ctx, `
SELECT pid, state, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, ''),
       extract(epoch FROM now() - query_start)::float8, left(query, 160)
  FROM pg_stat_activity
 WHERE usename = current_user AND pid <> pg_backend_pid() AND state <> 'idle'`)
	if err != nil {
		return "  (pg_stat_activity unavailable: " + err.Error() + ")"
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var pid int
		var state, wait, query string
		var seconds float64
		if err := rows.Scan(&pid, &state, &wait, &seconds, &query); err != nil {
			return b.String() + "  (scan: " + err.Error() + ")"
		}
		fmt.Fprintf(&b, "  pid=%d state=%s wait=%s for=%.3fs %s\n", pid, state, wait, seconds, strings.Join(strings.Fields(query), " "))
	}
	if b.Len() == 0 {
		return "  (no other active sessions)"
	}
	return b.String()
}

func TestSegmentEventWorkerForwardsGenuineEntrantsAfterBaseline_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool) // 2 active + 1 archived match
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Entrants " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	joins := &joinRecorder{}
	w := &SegmentEventWorker{Pool: pool, Repo: repo, Forwarder: joins}

	// First refresh builds the baseline and forwards nobody.
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, w, tenantID)
	row := readSegmentRow(t, pool, tenantID, seg.ID)
	if row.CachedMembers != 2 || row.LastCount == nil || *row.LastCount != 2 || row.BaselineAt == nil {
		t.Fatalf("after first refresh: cache=%d last_count=%s baseline=%v, want 2/2/set", row.CachedMembers, intValue(row.LastCount), row.BaselineAt)
	}
	if got := joins.settle(t, 0); len(got) != 0 {
		t.Fatalf("first refresh forwarded %d entrants, want 0: %+v", len(got), got)
	}

	// A genuinely new member: the second refresh must rewrite the cache and
	// forward exactly that subscriber.
	newcomer := "newcomer-" + marker + "@example.test"
	addSubscriber(t, pool, tenantID, newcomer)
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, w, tenantID)
	row = readSegmentRow(t, pool, tenantID, seg.ID)
	if row.CachedMembers != 3 || row.LastCount == nil || *row.LastCount != 3 {
		t.Fatalf("after second refresh: cache=%d last_count=%s, want 3/3", row.CachedMembers, intValue(row.LastCount))
	}
	got := joins.settle(t, 1)
	if len(got) != 1 || got[0].SubscriberEmail != newcomer || got[0].SegmentID != seg.ID || got[0].TenantID != tenantID {
		t.Fatalf("forwarded %+v, want exactly the newcomer", got)
	}

	// Nothing changed: a third refresh forwards nobody.
	joins.reset()
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, w, tenantID)
	if got := joins.settle(t, 0); len(got) != 0 {
		t.Fatalf("an unchanged refresh forwarded %+v", got)
	}
}

// Every display-only evaluation path, and a redefinition, must leave the next
// event-driven refresh forwarding nobody; only a later genuine entrant counts.
func TestSegmentEventWorkerNeverTreatsDisplayEvaluationAsBaseline_DB(t *testing.T) {
	cases := []struct {
		name string
		// prepare returns the segment id after putting it in the state the
		// case describes.
		prepare func(t *testing.T, pool *pgxpool.Pool, router http.Handler, repo *Repo, tenantID, marker string) string
	}{
		{"never evaluated", func(t *testing.T, _ *pgxpool.Pool, _ http.Handler, repo *Repo, tenantID, marker string) string {
			seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Plain " + marker, QueryAST: markerAST(marker)})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			return seg.ID
		}},
		{"created through the API, which evaluates on save", func(t *testing.T, _ *pgxpool.Pool, router http.Handler, _ *Repo, tenantID, marker string) string {
			resp := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
				"name": "Created " + marker, "queryAst": markerAST(marker),
			})
			if resp.Code != http.StatusCreated {
				t.Fatalf("create = %d %s", resp.Code, resp.Body.String())
			}
			seg := decodeBody[Segment](t, resp)
			if seg.LastEvaluatedAt == nil {
				t.Fatal("create did not evaluate; the case would not exercise the hazard")
			}
			return seg.ID
		}},
		{"after a manual recompute", func(t *testing.T, _ *pgxpool.Pool, router http.Handler, repo *Repo, tenantID, marker string) string {
			seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Recomputed " + marker, QueryAST: markerAST(marker)})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			if resp := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments/"+seg.ID+"/recompute", nil); resp.Code != http.StatusAccepted {
				t.Fatalf("recompute = %d %s", resp.Code, resp.Body.String())
			}
			return seg.ID
		}},
		{"after the daily size snapshot", func(t *testing.T, pool *pgxpool.Pool, _ http.Handler, repo *Repo, tenantID, marker string) string {
			seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Snapshotted " + marker, QueryAST: markerAST(marker)})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			if err := (&SnapshotWorker{Pool: pool, Repo: repo}).snapshotTenant(context.Background(), tenantID); err != nil {
				t.Fatalf("snapshot: %v", err)
			}
			return seg.ID
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool := newSegmentsTestPool(t)
			tenantID, marker := seedPreviewAggregateFixture(t, pool)
			repo := &Repo{Pool: pool}
			router := segmentsRouter(&Deps{Repo: repo})
			segID := tc.prepare(t, pool, router, repo, tenantID, marker)
			if row := readSegmentRow(t, pool, tenantID, segID); row.BaselineAt != nil || row.CachedMembers != 0 {
				t.Fatalf("display evaluation wrote a cache baseline: %+v", row)
			}

			joins := &joinRecorder{}
			w := &SegmentEventWorker{Pool: pool, Repo: repo, Forwarder: joins}
			enqueueSegmentEvent(t, pool, tenantID, segID)
			drainOnce(t, w, tenantID)
			if got := joins.settle(t, 0); len(got) != 0 {
				t.Fatalf("first event (%s) forwarded %d existing members as entrants: %+v", tc.name, len(got), got)
			}

			newcomer := "later-" + marker + "@example.test"
			addSubscriber(t, pool, tenantID, newcomer)
			enqueueSegmentEvent(t, pool, tenantID, segID)
			drainOnce(t, w, tenantID)
			if got := joins.settle(t, 1); len(got) != 1 || got[0].SubscriberEmail != newcomer {
				t.Fatalf("genuine entrant forwards = %+v, want exactly %s", got, newcomer)
			}
		})
	}
}

// Redefining a segment through PATCH re-baselines: the broadened definition's
// existing matches are not entrants, later ones are.
func TestSegmentEventWorkerRebaselinesAfterRedefinition_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	router := segmentsRouter(&Deps{Repo: repo})
	// Starts narrow: only the consented fixture subscriber.
	narrow := json.RawMessage(`{"op":"condition","field":"email","comparator":"starts_with","value":"consented-` + marker + `"}`)
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Redefined " + marker, QueryAST: narrow})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	joins := &joinRecorder{}
	w := &SegmentEventWorker{Pool: pool, Repo: repo, Forwarder: joins}
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, w, tenantID)
	if row := readSegmentRow(t, pool, tenantID, seg.ID); row.CachedMembers != 1 || row.BaselineAt == nil {
		t.Fatalf("narrow baseline = %+v", row)
	}

	resp := serveSegments(t, router, tenantID, http.MethodPatch, "/api/v1/segments/"+seg.ID, map[string]any{"queryAst": markerAST(marker)})
	if resp.Code != http.StatusOK {
		t.Fatalf("PATCH = %d %s", resp.Code, resp.Body.String())
	}
	if row := readSegmentRow(t, pool, tenantID, seg.ID); row.BaselineAt != nil {
		t.Fatalf("redefinition kept the old baseline: %+v", row)
	}
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, w, tenantID)
	if got := joins.settle(t, 0); len(got) != 0 {
		t.Fatalf("broadening the definition forwarded %+v as entrants", got)
	}
	if row := readSegmentRow(t, pool, tenantID, seg.ID); row.CachedMembers != 2 || row.BaselineAt == nil {
		t.Fatalf("re-baseline = %+v, want 2 cached and a baseline", row)
	}
}

// Entrant detection is best-effort: when it fails inside a rewrite, the rewrite
// after it in the same transaction must still run and commit. The failing
// query is the one SEG-C4 shipped: it aliased subscribers while the compiled
// predicate names the bare table, so Postgres rejected it (42P01) and, run
// outside a savepoint, aborted the transaction so every later statement of the
// rewrite failed with 25P02.
func TestEntrantDetectionFailureDoesNotAbortTheRewrite_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Savepoint " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Detection only runs against a baseline.
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, &SegmentEventWorker{Pool: pool, Repo: repo}, tenantID)
	addSubscriber(t, pool, tenantID, "late-"+marker+"@example.test")

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := RefreshMembershipCache(ctx, tx, tenantID, seg.ID, MembershipRefreshOptions{
		DetectEntrants: true,
		entrantQuery:   aliasedEntrantQuery,
	})
	if err != nil {
		t.Fatalf("rewrite after a failed detection: %v", err)
	}
	var pgErr *pgconn.PgError
	if !errors.As(result.EntrantDetectionErr, &pgErr) || pgErr.Code != "42P01" {
		t.Fatalf("EntrantDetectionErr = %v, want the aliased query's 42P01", result.EntrantDetectionErr)
	}
	if len(result.Entrants) != 0 {
		t.Fatalf("a failed detection reported entrants: %+v", result.Entrants)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if result.Members != 3 {
		t.Fatalf("members = %d, want 3", result.Members)
	}
	if row := readSegmentRow(t, pool, tenantID, seg.ID); row.CachedMembers != 3 || row.BaselineAt == nil || row.LastCount == nil || *row.LastCount != 3 {
		t.Fatalf("rewrite did not persist: cache=%d baseline=%v last_count=%s", row.CachedMembers, row.BaselineAt, intValue(row.LastCount))
	}
}

// aliasedEntrantQuery is SEG-C4's entrant query, kept to replay its failure.
func aliasedEntrantQuery(ctx context.Context, tx pgx.Tx, _, _, predicate string, args []any) ([]SegmentJoinEvent, bool, error) {
	rows, err := tx.Query(ctx, `
SELECT s.email FROM subscribers s
 WHERE s.tenant_id = $1::uuid AND (`+predicate+`)
   AND NOT EXISTS (SELECT 1 FROM segment_subscribers b
                    WHERE b.tenant_id = $1::uuid AND b.segment_id = $2::uuid AND b.subscriber_id = s.id)`, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	for rows.Next() {
	}
	return nil, false, rows.Err()
}

// A rewrite can take seconds on a large segment and the materialiser runs one
// for every stale segment, so it must not hold up edits: a PATCH and a save's
// evaluation made while it runs complete at once. The rewrite then describes a
// definition the segment no longer has, so it records neither a baseline nor a
// count; the next rewrite re-baselines instead of diffing the new definition
// against the old definition's rows.
func TestSegmentEditsDoNotWaitForAMembershipRewrite_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Edited mid-rewrite " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, &SegmentEventWorker{Pool: pool, Repo: repo}, tenantID)

	var editErr, evalErr error
	var evaluatedAt *time.Time
	renamed := "Renamed mid-rewrite " + marker
	// Detection runs after the rewrite has taken its lock and read the
	// definition, and before it writes anything: the middle of the rewrite.
	midRewrite := func(ctx context.Context, tx pgx.Tx, tenantID, segmentID, predicate string, args []any) ([]SegmentJoinEvent, bool, error) {
		editCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var edited *Segment
		edited, editErr = repo.Update(editCtx, tenantID, segmentID, UpdateInput{
			Name:     &renamed,
			QueryAST: ptrRaw(string(markerAST("nobody-" + marker))),
		})
		if editErr == nil {
			evaluatedAt, evalErr = repo.RecordEvaluation(editCtx, tenantID, segmentID, edited.UpdatedAt, 0)
		}
		return collectEntrants(ctx, tx, tenantID, segmentID, predicate, args)
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := RefreshMembershipCache(ctx, tx, tenantID, seg.ID, MembershipRefreshOptions{DetectEntrants: true, entrantQuery: midRewrite})
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if editErr != nil {
		t.Fatalf("PATCH during the rewrite: %v", editErr)
	}
	if evalErr != nil || evaluatedAt == nil {
		t.Fatalf("evaluation during the rewrite: at=%v err=%v", evaluatedAt, evalErr)
	}
	if !result.Superseded {
		t.Fatalf("the rewrite did not notice the edit: %+v", result)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	row := readSegmentRow(t, pool, tenantID, seg.ID)
	if row.BaselineAt != nil {
		t.Fatalf("a rewrite of the old definition recorded a baseline for the new one (%v)", row.BaselineAt)
	}
	if row.LastCount == nil || *row.LastCount != 0 {
		t.Fatalf("last_count = %s, want the new definition's 0, not the old one's 2", intValue(row.LastCount))
	}
}

// The cache is the active population whatever the segment's scope, but the
// size it records is the segment's own: an include-archived segment reads 3,
// not the 2 it caches, so the list stops flipping between writers.
func TestMembershipCacheCountsUnderTheSegmentsArchiveScope_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{
		Name: "Archive scope " + marker, QueryAST: markerAST(marker), IncludeArchived: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	w := &SegmentEventWorker{Pool: pool, Repo: repo}
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, w, tenantID)
	row := readSegmentRow(t, pool, tenantID, seg.ID)
	if row.CachedMembers != 2 {
		t.Fatalf("cache = %d, want the 2 active members", row.CachedMembers)
	}
	if row.LastCount == nil || *row.LastCount != 3 {
		t.Fatalf("last_count = %s, want 3 (include_archived)", intValue(row.LastCount))
	}
}

// Two replicas refreshing one segment at once must not both report the same
// entrant: the second waits for the first and diffs against its rows.
func TestConcurrentRewritesForwardEachEntrantOnce_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Concurrent " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	baseline := &SegmentEventWorker{Pool: pool, Repo: repo}
	enqueueSegmentEvent(t, pool, tenantID, seg.ID)
	drainOnce(t, baseline, tenantID)
	addSubscriber(t, pool, tenantID, "racer-"+marker+"@example.test")

	ctx := context.Background()
	first, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Rollback(ctx) }()
	firstResult, err := RefreshMembershipCache(ctx, first, tenantID, seg.ID, MembershipRefreshOptions{DetectEntrants: true})
	if err != nil {
		t.Fatalf("first rewrite: %v", err)
	}

	type outcome struct {
		result MembershipRefresh
		err    error
	}
	second := make(chan outcome, 1)
	go func() {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			second <- outcome{err: err}
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		res, err := RefreshMembershipCache(ctx, tx, tenantID, seg.ID, MembershipRefreshOptions{DetectEntrants: true})
		if err == nil {
			err = tx.Commit(ctx)
		}
		second <- outcome{result: res, err: err}
	}()
	// Give the second rewrite ample time to reach its diff while the first is
	// still uncommitted; without the advisory lock it would diff the old cache.
	time.Sleep(300 * time.Millisecond)
	if err := first.Commit(ctx); err != nil {
		t.Fatalf("first commit: %v", err)
	}
	got := <-second
	if got.err != nil {
		t.Fatalf("second rewrite: %v", got.err)
	}
	if len(firstResult.Entrants) != 1 {
		t.Fatalf("first rewrite entrants = %+v, want the racer", firstResult.Entrants)
	}
	if len(got.result.Entrants) != 0 {
		t.Fatalf("second rewrite reported the same entrant again: %+v", got.result.Entrants)
	}
}

// A segment deleted between enqueue and refresh is reported as gone and its
// stale cache rows are dropped.
func TestMembershipRewriteOfDeletedSegment_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, _ := seedPreviewAggregateFixture(t, pool)
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := RefreshMembershipCache(ctx, tx, tenantID, uuid.NewString(), MembershipRefreshOptions{DetectEntrants: true})
	if err != nil {
		t.Fatalf("rewrite of a missing segment: %v", err)
	}
	if result.Found || result.Members != 0 || len(result.Entrants) != 0 {
		t.Fatalf("result = %+v, want not found", result)
	}
}
