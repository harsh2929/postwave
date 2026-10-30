// SPDX-License-Identifier: AGPL-3.0-only
//
// evaluation_db_test.go — a segment is counted when it is saved, under its
// own archive scope, and every size writer agrees on that scope.
//
// Before: POST /api/v1/segments only inserted, so a new segment sat on the
// list as "—" / "Never" until a manual recompute or the next hourly snapshot;
// and Recompute counted include-archived segments with archived subscribers
// while the snapshot worker, CreateSnapshot and the size-history live point
// did not, so the list's count depended on which writer ran last.

package segments

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func intValue(p *int) string {
	if p == nil {
		return "<nil>"
	}
	return fmt.Sprint(*p)
}

func TestCreateEvaluatesTheNewSegment_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool) // 2 active + 1 archived match
	router := segmentsRouter(&Deps{Repo: &Repo{Pool: pool}})

	for _, tc := range []struct {
		name            string
		includeArchived bool
		want            int
	}{
		{"active only", false, 2},
		{"including archived", true, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := time.Now().Add(-time.Second)
			resp := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
				"name":            "Counted on save " + tc.name + " " + marker,
				"queryAst":        markerAST(marker),
				"includeArchived": tc.includeArchived,
			})
			if resp.Code != http.StatusCreated {
				t.Fatalf("create = %d %s", resp.Code, resp.Body.String())
			}
			created := decodeBody[Segment](t, resp)
			if created.LastCount == nil || *created.LastCount != tc.want {
				t.Fatalf("201 lastCount = %s, want %d", intValue(created.LastCount), tc.want)
			}
			if created.LastEvaluatedAt == nil || created.LastEvaluatedAt.Before(before) {
				t.Fatalf("201 lastEvaluatedAt = %v, want a fresh instant", created.LastEvaluatedAt)
			}

			// The list and the overview read the same persisted values.
			got := decodeBody[Segment](t, serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+created.ID, nil))
			if got.LastCount == nil || *got.LastCount != tc.want || got.LastEvaluatedAt == nil {
				t.Fatalf("GET after create: lastCount=%s lastEvaluatedAt=%v", intValue(got.LastCount), got.LastEvaluatedAt)
			}
			if !got.UpdatedAt.Equal(created.UpdatedAt) {
				t.Fatalf("evaluation moved updated_at (%v -> %v); the ETag would change under the editor", created.UpdatedAt, got.UpdatedAt)
			}
		})
	}
}

func TestUpdateRecountsWhenTheAudienceChanges_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	router := segmentsRouter(&Deps{Repo: &Repo{Pool: pool}})
	created := decodeBody[Segment](t, serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
		"name": "Recount " + marker, "queryAst": markerAST(marker),
	}))
	if created.LastCount == nil || *created.LastCount != 2 {
		t.Fatalf("created lastCount = %s", intValue(created.LastCount))
	}

	// Narrowing the rules re-counts: only the consented fixture matches.
	narrow := `{"op":"condition","field":"email","comparator":"starts_with","value":"consented-` + marker + `"}`
	resp := serveSegments(t, router, tenantID, http.MethodPatch, "/api/v1/segments/"+created.ID, map[string]any{"queryAst": rawJSON(narrow)})
	if resp.Code != http.StatusOK {
		t.Fatalf("PATCH rules = %d %s", resp.Code, resp.Body.String())
	}
	if got := decodeBody[Segment](t, resp); got.LastCount == nil || *got.LastCount != 1 {
		t.Fatalf("after narrowing: lastCount = %s, want 1", intValue(got.LastCount))
	}

	// Widening the archive scope re-counts too, with the archived match.
	resp = serveSegments(t, router, tenantID, http.MethodPatch, "/api/v1/segments/"+created.ID, map[string]any{
		"queryAst": markerAST(marker), "includeArchived": true,
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("PATCH scope = %d %s", resp.Code, resp.Body.String())
	}
	scoped := decodeBody[Segment](t, resp)
	if scoped.LastCount == nil || *scoped.LastCount != 3 {
		t.Fatalf("after including archived: lastCount = %s, want 3", intValue(scoped.LastCount))
	}

	// A rename does not touch the audience, so the evaluation stands as is.
	resp = serveSegments(t, router, tenantID, http.MethodPatch, "/api/v1/segments/"+created.ID, map[string]any{"name": "Renamed " + marker})
	if resp.Code != http.StatusOK {
		t.Fatalf("PATCH name = %d %s", resp.Code, resp.Body.String())
	}
	renamed := decodeBody[Segment](t, resp)
	if renamed.LastCount == nil || *renamed.LastCount != 3 || renamed.LastEvaluatedAt == nil ||
		!renamed.LastEvaluatedAt.Equal(*scoped.LastEvaluatedAt) {
		t.Fatalf("rename changed the evaluation: %s at %v, want 3 at %v", intValue(renamed.LastCount), renamed.LastEvaluatedAt, scoped.LastEvaluatedAt)
	}
}

// Counting is not editing. The ETag the create response hands the editor, and
// the one it holds while a recompute and the event worker count the segment in
// the background, must still be accepted by the next save (migration 2059).
func TestEvaluationKeepsTheEditorsETagValid_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	router := segmentsRouter(&Deps{Repo: repo})
	resp := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
		"name": "ETag " + marker, "queryAst": markerAST(marker),
	})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", resp.Code, resp.Body.String())
	}
	etag := resp.Header().Get("ETag")
	created := decodeBody[Segment](t, resp)
	if etag == "" || created.LastEvaluatedAt == nil {
		t.Fatalf("create returned etag=%q lastEvaluatedAt=%v", etag, created.LastEvaluatedAt)
	}

	// Background evaluation while the editor is open.
	if r := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments/"+created.ID+"/recompute", nil); r.Code != http.StatusAccepted {
		t.Fatalf("recompute = %d %s", r.Code, r.Body.String())
	}
	enqueueSegmentEvent(t, pool, tenantID, created.ID)
	drainOnce(t, &SegmentEventWorker{Pool: pool, Repo: repo}, tenantID)

	save := serveSegmentsWith(t, router, http.MethodPatch, "/api/v1/segments/"+created.ID,
		map[string]any{"description": "Edited after it was counted"},
		func(ctx context.Context) context.Context {
			return ownerContext(ctx, tenantID)
		}, ifMatch(etag))
	if save.Code != http.StatusOK {
		t.Fatalf("save with the create ETag = %d %s, want 200", save.Code, save.Body.String())
	}
}

// A count of one definition is never recorded against another.
func TestRecordEvaluationRefusesAStaleDefinition_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	seg, err := repo.Create(ctx, tenantID, CreateInput{Name: "Stale " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	counted := seg.UpdatedAt
	if _, err = repo.Update(ctx, tenantID, seg.ID, UpdateInput{QueryAST: ptrRaw(`{"op":"condition","field":"email","comparator":"contains","value":"nobody-` + marker + `"}`)}); err != nil {
		t.Fatalf("redefine: %v", err)
	}
	at, err := repo.RecordEvaluation(ctx, tenantID, seg.ID, counted, 99)
	if err != nil {
		t.Fatalf("RecordEvaluation: %v", err)
	}
	if at != nil {
		t.Fatalf("recorded a count for a definition that no longer exists (at %v)", at)
	}
	if row := readSegmentRow(t, pool, tenantID, seg.ID); row.LastCount != nil {
		t.Fatalf("last_count = %s, want the redefinition's cleared value", intValue(row.LastCount))
	}
}

// Recompute, the daily snapshot tick, POST /snapshot and the size-history live
// point all count an include-archived segment the same way.
func TestEveryWriterCountsUnderTheSegmentsArchiveScope_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	router := segmentsRouter(&Deps{Repo: repo})
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{
		Name: "Scope writers " + marker, QueryAST: markerAST(marker), IncludeArchived: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Size history before any snapshot: one live point.
	history := decodeBody[SizeHistoryResponse](t, serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+seg.ID+"/size-history", nil))
	if len(history.Series) != 1 || history.Series[0].Count != 3 || history.Note != sizeHistoryNotStartedNote {
		t.Fatalf("live size point = %+v, want one point of 3 with the not-started note", history)
	}

	resp := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments/"+seg.ID+"/recompute", nil)
	if resp.Code != http.StatusAccepted || decodeBody[RecomputeResponse](t, resp).Count != 3 {
		t.Fatalf("recompute = %d %s, want 202 with count 3", resp.Code, resp.Body.String())
	}

	if err := (&SnapshotWorker{Pool: pool, Repo: repo}).snapshotTenant(context.Background(), tenantID); err != nil {
		t.Fatalf("snapshot tick: %v", err)
	}
	if row := readSegmentRow(t, pool, tenantID, seg.ID); row.LastCount == nil || *row.LastCount != 3 {
		t.Fatalf("after the snapshot tick last_count = %s, want 3", intValue(row.LastCount))
	}
	history = decodeBody[SizeHistoryResponse](t, serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+seg.ID+"/size-history", nil))
	if len(history.Series) != 1 || history.Series[0].Count != 3 || history.Note != "" {
		t.Fatalf("recorded size history = %+v, want the tick's 3", history)
	}

	resp = serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments/"+seg.ID+"/snapshot", nil)
	if resp.Code != http.StatusCreated {
		t.Fatalf("snapshot = %d %s", resp.Code, resp.Body.String())
	}
	if snap := decodeBody[Snapshot](t, resp); snap.Count != 3 || snap.SampleSize != 3 {
		t.Fatalf("snapshot count=%d sample=%d, want 3 and 3", snap.Count, snap.SampleSize)
	}
}

// The snapshot worker skips a segment redefined after it was listed rather
// than record the old definition's size as today's.
func TestSnapshotWorkerSkipsARedefinedSegment_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	seg, err := repo.Create(ctx, tenantID, CreateInput{Name: "Moving target " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	listed := snapshotDefinition{ID: seg.ID, QueryAST: seg.QueryAST, UpdatedAt: seg.UpdatedAt}
	if _, err = repo.Update(ctx, tenantID, seg.ID, UpdateInput{QueryAST: ptrRaw(`{"op":"condition","field":"email","comparator":"contains","value":"nobody-` + marker + `"}`)}); err != nil {
		t.Fatalf("redefine: %v", err)
	}
	if err = (&SnapshotWorker{Pool: pool, Repo: repo}).snapshotOne(ctx, tenantID, listed); err != nil {
		t.Fatalf("snapshotOne: %v", err)
	}
	if row := readSegmentRow(t, pool, tenantID, seg.ID); row.LastCount != nil {
		t.Fatalf("recorded %s for the old definition", intValue(row.LastCount))
	}
	history, err := repo.SegmentSizeHistory(ctx, tenantID, seg.ID, 90)
	if err != nil {
		t.Fatalf("size history: %v", err)
	}
	if history.Note != sizeHistoryNotStartedNote || len(history.Series) != 1 || history.Series[0].Count != 0 {
		t.Fatalf("history = %+v, want no recorded row and a live 0", history)
	}
}

// A redefinition clears the stored size with the save, so when the recount
// cannot land the list shows no size rather than the old definition's. Here
// the new rule sums an event property one event holds as text, which the
// count cannot add up.
func TestARedefinitionThatCannotBeCountedLeavesNoStaleSize_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	router := segmentsRouter(&Deps{Repo: &Repo{Pool: pool}})
	created := decodeBody[Segment](t, serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
		"name": "Uncountable " + marker, "queryAst": markerAST(marker),
	}))
	if created.LastCount == nil || *created.LastCount != 2 {
		t.Fatalf("created lastCount = %s, want 2", intValue(created.LastCount))
	}
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		exec(`
INSERT INTO product_events (tenant_id, subscriber_id, event_name, properties)
SELECT $1::uuid, id, 'Placed Order', '{"total":"n/a"}'::jsonb FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2`, tenantID, "consented-"+marker+"@example.test")
	})

	spend := `{"op":"condition","field":"metric.track.placed_order.sum","comparator":"gt","value":{"value":100,"property":"total","aggregation":"sum","event_name":"Placed Order"}}`
	resp := serveSegments(t, router, tenantID, http.MethodPatch, "/api/v1/segments/"+created.ID, map[string]any{"queryAst": rawJSON(spend)})
	if resp.Code != http.StatusOK {
		t.Fatalf("PATCH = %d %s", resp.Code, resp.Body.String())
	}
	if got := decodeBody[Segment](t, resp); got.LastCount != nil {
		t.Fatalf("response lastCount = %s, want none", intValue(got.LastCount))
	}
	if row := readSegmentRow(t, pool, tenantID, created.ID); row.LastCount != nil || row.LastEvaluatedAt != nil {
		t.Fatalf("stored size = %s evaluated %v, want none: the old definition's 2 survived the redefinition", intValue(row.LastCount), row.LastEvaluatedAt)
	}
}

// Recording a save's count queues behind whatever holds the segment's row. The
// save's response must not queue with it: past saveRecordTimeout the segment
// is returned uncounted.
func TestSaveEvaluationDoesNotWaitOnALockedSegment_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Locked " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	ctx := context.Background()
	holder, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT 1 FROM segments WHERE id = $1::uuid FOR UPDATE`, seg.ID); err != nil {
		t.Fatalf("hold the row: %v", err)
	}

	d := &Deps{Repo: repo}
	evaluated := *seg
	done := make(chan time.Duration, 1)
	go func() {
		started := time.Now()
		d.evaluateSaved(context.Background(), tenantID, &evaluated)
		done <- time.Since(started)
	}()
	select {
	case took := <-done:
		if evaluated.LastCount != nil {
			t.Fatalf("a count was recorded through a held row lock: %s", intValue(evaluated.LastCount))
		}
		if took < saveRecordTimeout {
			t.Fatalf("returned after %s without waiting for the lock at all", took)
		}
	case <-time.After(saveEvaluationTimeout + saveRecordTimeout + 2*time.Second):
		_ = holder.Rollback(ctx)
		<-done
		t.Fatal("the save's evaluation waited on the held row lock instead of giving up")
	}
}
