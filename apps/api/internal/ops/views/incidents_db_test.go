package views

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestIncidentUpdateTimestampIsSerializedAfterParent_DB(t *testing.T) {
	pool := readerDB(t)
	seed := adminDB(t)
	ctx := context.Background()
	repo := &IncidentRepo{Pool: pool}

	// Establish a transaction timestamp before the incident exists. A now()
	// default would reuse this stale timestamp for the later update and place it
	// before opened_at; the server-state trigger must stamp after locking the
	// parent instead.
	earlyTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin early transaction: %v", err)
	}
	defer func() { _ = earlyTx.Rollback(ctx) }()
	var transactionStarted time.Time
	if err := earlyTx.QueryRow(ctx, `SELECT now()`).Scan(&transactionStarted); err != nil {
		t.Fatalf("establish early transaction timestamp: %v", err)
	}
	time.Sleep(5 * time.Millisecond)

	id, _, err := repo.OpenIncident(ctx, "Chronology probe", "sev3", "Opening note", "op@postwave.test", "31000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatalf("OpenIncident: %v", err)
	}
	t.Cleanup(func() { _, _ = seed.Exec(context.Background(), "DELETE FROM ops_incidents WHERE id = $1", id) })
	if _, err := earlyTx.Exec(ctx, `
INSERT INTO ops_incident_updates (incident_id, idempotency_key, body, author)
VALUES ($1::uuid, '31000000-0000-4000-8000-000000000002', 'Later note', 'op@postwave.test')`, id); err != nil {
		t.Fatalf("append from early transaction: %v", err)
	}
	if err := earlyTx.Commit(ctx); err != nil {
		t.Fatalf("commit early transaction: %v", err)
	}

	var openedAt, updatedAt, createdAt time.Time
	if err := seed.QueryRow(ctx, `
SELECT i.opened_at, i.updated_at, u.created_at
  FROM ops_incidents AS i
  JOIN ops_incident_updates AS u ON u.incident_id = i.id
 WHERE i.id = $1::uuid
   AND u.idempotency_key = '31000000-0000-4000-8000-000000000002'`, id).
		Scan(&openedAt, &updatedAt, &createdAt); err != nil {
		t.Fatalf("load chronology: %v", err)
	}
	if !transactionStarted.Before(openedAt) {
		t.Fatalf("test precondition failed: transaction=%s opened=%s", transactionStarted, openedAt)
	}
	if createdAt.Before(openedAt) || updatedAt.Before(createdAt) {
		t.Fatalf("server chronology regressed: opened=%s created=%s updated=%s", openedAt, createdAt, updatedAt)
	}
}

func TestIncidentLifecycle_DB(t *testing.T) {
	pool := readerDB(t)
	seed := adminDB(t)
	ctx := context.Background()
	repo := &IncidentRepo{Pool: pool}
	r := &Reader{Pool: pool}

	id, replayed, err := repo.OpenIncident(ctx, "Deliverability spike", "sev2", "Complaints rising on shared pool", "op@postwave.test", "30000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatalf("OpenIncident: %v", err)
	}
	if replayed {
		t.Fatal("first OpenIncident must not be a replay")
	}
	if id == "" {
		t.Fatal("OpenIncident returned empty id")
	}
	// Clean up whatever we create so the dev DB does not accumulate test rows.
	t.Cleanup(func() { _, _ = seed.Exec(context.Background(), "DELETE FROM ops_incidents WHERE id = $1", id) })

	// Timeline has the opening note.
	detail, err := r.IncidentTimeline(ctx, id, "")
	if err != nil {
		t.Fatalf("IncidentTimeline: %v", err)
	}
	if detail == nil || detail.Status != "open" || len(detail.Updates) != 1 {
		t.Fatalf("fresh incident should be open with 1 update, got %+v", detail)
	}

	// Append a monitoring note, then resolve.
	if replayed, err := repo.AppendUpdate(ctx, id, "Throttled the sender; watching", "monitoring", "op@postwave.test", "30000000-0000-4000-8000-000000000002"); err != nil || replayed {
		t.Fatalf("AppendUpdate monitoring: %v", err)
	}
	if replayed, err := repo.AppendUpdate(ctx, id, "Rates back to baseline", "resolved", "op@postwave.test", "30000000-0000-4000-8000-000000000003"); err != nil || replayed {
		t.Fatalf("AppendUpdate resolved: %v", err)
	}
	detail, err = r.IncidentTimeline(ctx, id, "")
	if err != nil {
		t.Fatalf("IncidentTimeline after updates: %v", err)
	}
	if detail.Status != "resolved" || detail.ResolvedAt == nil {
		t.Fatalf("incident should be resolved with resolved_at set, got status=%q resolved_at=%v", detail.Status, detail.ResolvedAt)
	}
	if detail.UpdatedAt.Before(detail.OpenedAt) || detail.ResolvedAt.Before(detail.OpenedAt) {
		t.Fatalf("database-owned incident timestamps are inconsistent: %+v", detail)
	}
	if len(detail.Updates) != 3 {
		t.Fatalf("timeline should have 3 updates, got %d", len(detail.Updates))
	}
	if got := []string{
		detail.Updates[0].RequestedStatus,
		detail.Updates[1].RequestedStatus,
		detail.Updates[2].RequestedStatus,
	}; got[0] != "open" || got[1] != "monitoring" || got[2] != "resolved" {
		t.Fatalf("timeline lost requested status transitions: %v", got)
	}
	// The exact resolving write remains an idempotent no-op even after the
	// incident is terminal. The AFTER INSERT trigger does not run when the
	// idempotency conflict suppresses the insert.
	if replayed, err := repo.AppendUpdate(ctx, id, "Rates back to baseline", "resolved", "op@postwave.test", "30000000-0000-4000-8000-000000000003"); err != nil || !replayed {
		t.Fatalf("exact resolved replay = (%v,%v), want (true,nil)", replayed, err)
	}

	// Resolution is terminal at the database boundary for every distinct write,
	// including note-only and repeated-resolved entries, not only reopenings.
	rejected := []struct {
		body, status, key string
	}{
		{"Attempted reopen", "open", "30000000-0000-4000-8000-000000000004"},
		{"Late note", "", "30000000-0000-4000-8000-000000000005"},
		{"Second resolution", "resolved", "30000000-0000-4000-8000-000000000006"},
	}
	for _, tc := range rejected {
		if _, err := repo.AppendUpdate(ctx, id, tc.body, tc.status, "op@postwave.test", tc.key); !errors.Is(err, ErrIncidentResolved) {
			t.Fatalf("post-resolution update status %q error = %v, want ErrIncidentResolved", tc.status, err)
		}
	}
	detail, err = r.IncidentTimeline(ctx, id, "")
	if err != nil {
		t.Fatalf("IncidentTimeline after rejected reopen: %v", err)
	}
	if detail.Status != "resolved" || len(detail.Updates) != 3 {
		t.Fatalf("rejected reopen must roll back header and timeline atomically: %+v", detail)
	}

	// Unresolved-only list must exclude it now.
	open, err := r.ListIncidents(ctx, false, 100)
	if err != nil {
		t.Fatalf("ListIncidents: %v", err)
	}
	for _, row := range open {
		if row.ID == id {
			t.Fatal("resolved incident must not appear in the unresolved list")
		}
	}

	// Appending to a missing incident is a no-rows (→ 404 at the handler).
	if _, err := repo.AppendUpdate(ctx, "00000000-0000-0000-0000-000000000000", "x", "open", "op", "30000000-0000-4000-8000-000000000007"); !isNoRows(err) {
		t.Fatalf("append to missing incident should be no-rows, got %v", err)
	}
}

func TestIncidentIdempotencyIsPayloadBoundAndConcurrent_DB(t *testing.T) {
	pool := readerDB(t)
	seed := adminDB(t)
	ctx := context.Background()
	repo := &IncidentRepo{Pool: pool}

	const (
		openKey   = "50000000-0000-4000-8000-000000000001"
		updateKey = "50000000-0000-4000-8000-000000000002"
	)
	type openResult struct {
		id       string
		replayed bool
		err      error
	}
	openResults := make([]openResult, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range openResults {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			openResults[i].id, openResults[i].replayed, openResults[i].err = repo.OpenIncident(
				ctx, "Concurrent probe", "sev2", "Opening note", "op@postwave.test", openKey,
			)
		}(i)
	}
	close(start)
	wg.Wait()
	for i, result := range openResults {
		if result.err != nil {
			t.Fatalf("concurrent OpenIncident[%d]: %v", i, result.err)
		}
	}
	if openResults[0].id == "" || openResults[0].id != openResults[1].id {
		t.Fatalf("same-key opens returned different IDs: %+v", openResults)
	}
	if openResults[0].replayed == openResults[1].replayed {
		t.Fatalf("exactly one concurrent open must be the replay: %+v", openResults)
	}
	id := openResults[0].id
	t.Cleanup(func() { _, _ = seed.Exec(context.Background(), "DELETE FROM ops_incidents WHERE id = $1", id) })

	var beforeUpdated string
	var beforeCount int
	if err := seed.QueryRow(ctx, `
SELECT updated_at::text, update_count FROM ops_incidents WHERE id = $1`, id).
		Scan(&beforeUpdated, &beforeCount); err != nil {
		t.Fatalf("load open chronology: %v", err)
	}
	replayedID, replayed, err := repo.OpenIncident(
		ctx, "Concurrent probe", "sev2", "Opening note", "op@postwave.test", openKey,
	)
	if err != nil || !replayed || replayedID != id {
		t.Fatalf("exact open replay = (%q,%v,%v), want (%q,true,nil)", replayedID, replayed, err, id)
	}
	var afterUpdated string
	var afterCount int
	if err := seed.QueryRow(ctx, `
SELECT updated_at::text, update_count FROM ops_incidents WHERE id = $1`, id).
		Scan(&afterUpdated, &afterCount); err != nil {
		t.Fatalf("reload open chronology: %v", err)
	}
	if beforeUpdated != afterUpdated || beforeCount != 1 || afterCount != 1 {
		t.Fatalf("open replay changed chronology: before=(%s,%d) after=(%s,%d)", beforeUpdated, beforeCount, afterUpdated, afterCount)
	}

	openMismatches := []struct {
		name, title, severity, body, actor string
	}{
		{"title", "Different title", "sev2", "Opening note", "op@postwave.test"},
		{"severity", "Concurrent probe", "sev1", "Opening note", "op@postwave.test"},
		{"body", "Concurrent probe", "sev2", "Different body", "op@postwave.test"},
		{"actor", "Concurrent probe", "sev2", "Opening note", "other@postwave.test"},
	}
	for _, tc := range openMismatches {
		t.Run("open_key_mismatch_"+tc.name, func(t *testing.T) {
			_, _, err := repo.OpenIncident(ctx, tc.title, tc.severity, tc.body, tc.actor, openKey)
			if !errors.Is(err, ErrIncidentIdempotencyConflict) {
				t.Fatalf("error = %v, want ErrIncidentIdempotencyConflict", err)
			}
		})
	}

	type appendResult struct {
		replayed bool
		err      error
	}
	appendResults := make([]appendResult, 2)
	start = make(chan struct{})
	for i := range appendResults {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			appendResults[i].replayed, appendResults[i].err = repo.AppendUpdate(
				ctx, id, "Monitoring note", "monitoring", "op@postwave.test", updateKey,
			)
		}(i)
	}
	close(start)
	wg.Wait()
	for i, result := range appendResults {
		if result.err != nil {
			t.Fatalf("concurrent AppendUpdate[%d]: %v", i, result.err)
		}
	}
	if appendResults[0].replayed == appendResults[1].replayed {
		t.Fatalf("exactly one concurrent append must be the replay: %+v", appendResults)
	}

	if err := seed.QueryRow(ctx, `
SELECT updated_at::text, update_count FROM ops_incidents WHERE id = $1`, id).
		Scan(&beforeUpdated, &beforeCount); err != nil {
		t.Fatalf("load append chronology: %v", err)
	}
	replayed, err = repo.AppendUpdate(ctx, id, "Monitoring note", "monitoring", "op@postwave.test", updateKey)
	if err != nil || !replayed {
		t.Fatalf("exact append replay = (%v,%v), want (true,nil)", replayed, err)
	}
	if err := seed.QueryRow(ctx, `
SELECT updated_at::text, update_count FROM ops_incidents WHERE id = $1`, id).
		Scan(&afterUpdated, &afterCount); err != nil {
		t.Fatalf("reload append chronology: %v", err)
	}
	if beforeUpdated != afterUpdated || beforeCount != 2 || afterCount != 2 {
		t.Fatalf("append replay changed chronology: before=(%s,%d) after=(%s,%d)", beforeUpdated, beforeCount, afterUpdated, afterCount)
	}

	appendMismatches := []struct {
		name, body, status, actor string
	}{
		{"body", "Different note", "monitoring", "op@postwave.test"},
		{"status", "Monitoring note", "resolved", "op@postwave.test"},
		{"actor", "Monitoring note", "monitoring", "other@postwave.test"},
	}
	for _, tc := range appendMismatches {
		t.Run("append_key_mismatch_"+tc.name, func(t *testing.T) {
			_, err := repo.AppendUpdate(ctx, id, tc.body, tc.status, tc.actor, updateKey)
			if !errors.Is(err, ErrIncidentIdempotencyConflict) {
				t.Fatalf("error = %v, want ErrIncidentIdempotencyConflict", err)
			}
		})
	}

	otherID, _, err := repo.OpenIncident(
		ctx, "Other incident", "sev3", "Other opening", "op@postwave.test",
		"50000000-0000-4000-8000-000000000003",
	)
	if err != nil {
		t.Fatalf("open other incident: %v", err)
	}
	t.Cleanup(func() { _, _ = seed.Exec(context.Background(), "DELETE FROM ops_incidents WHERE id = $1", otherID) })
	if _, err := repo.AppendUpdate(ctx, otherID, "Monitoring note", "monitoring", "op@postwave.test", updateKey); !errors.Is(err, ErrIncidentIdempotencyConflict) {
		t.Fatalf("cross-incident key reuse error = %v, want ErrIncidentIdempotencyConflict", err)
	}
}

func TestIncidentTimelineCeilingIsExactUnderConcurrency_DB(t *testing.T) {
	_ = readerDB(t) // proves the ops role can reach this view
	seed := adminDB(t)
	ctx := context.Background()

	var id string
	if err := seed.QueryRow(ctx, `
INSERT INTO ops_incidents (idempotency_key, title, severity, opened_by)
VALUES ('60000000-0000-4000-8000-000000000001', 'Concurrent ceiling probe', 'sev3', 'op@postwave.test')
RETURNING id::text`).Scan(&id); err != nil {
		t.Fatalf("insert incident: %v", err)
	}
	t.Cleanup(func() { _, _ = seed.Exec(context.Background(), "DELETE FROM ops_incidents WHERE id = $1", id) })

	if _, err := seed.Exec(ctx, `
INSERT INTO ops_incident_updates (incident_id, idempotency_key, body, author)
SELECT $1::uuid, gen_random_uuid(), 'preload-' || n::text, 'op@postwave.test'
  FROM generate_series(1, 9998) AS n`, id); err != nil {
		t.Fatalf("preload timeline: %v", err)
	}

	const contenders = 8
	errs := make([]error, contenders)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = seed.Exec(ctx, `
INSERT INTO ops_incident_updates (incident_id, idempotency_key, body, author)
VALUES ($1::uuid, gen_random_uuid(), $2, 'op@postwave.test')`, id, fmt.Sprintf("contender-%d", i))
		}(i)
	}
	close(start)
	wg.Wait()

	succeeded := 0
	limited := 0
	for _, err := range errs {
		if err == nil {
			succeeded++
			continue
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "54000" {
			limited++
			continue
		}
		t.Fatalf("unexpected concurrent insert error: %v", err)
	}
	if succeeded != 2 || limited != contenders-2 {
		t.Fatalf("concurrent ceiling results: succeeded=%d limited=%d, want 2/%d", succeeded, limited, contenders-2)
	}

	var updateCount, rowCount int
	if err := seed.QueryRow(ctx, `
SELECT i.update_count, count(u.id)::int
  FROM ops_incidents AS i
  LEFT JOIN ops_incident_updates AS u ON u.incident_id = i.id
 WHERE i.id = $1::uuid
 GROUP BY i.update_count`, id).Scan(&updateCount, &rowCount); err != nil {
		t.Fatalf("load final timeline count: %v", err)
	}
	if updateCount != 10000 || rowCount != 10000 {
		t.Fatalf("timeline ceiling drifted: header=%d rows=%d, want 10000/10000", updateCount, rowCount)
	}
}

func TestIncidentTimelineIsBounded_DB(t *testing.T) {
	pool := readerDB(t)
	seed := adminDB(t)
	ctx := context.Background()

	var id string
	if err := seed.QueryRow(ctx, `
INSERT INTO ops_incidents (idempotency_key, title, severity, opened_by)
VALUES ('40000000-0000-4000-8000-000000000001', 'Bounded timeline probe', 'sev3', 'op@postwave.test')
RETURNING id::text`).Scan(&id); err != nil {
		t.Fatalf("insert incident: %v", err)
	}
	t.Cleanup(func() { _, _ = seed.Exec(context.Background(), "DELETE FROM ops_incidents WHERE id = $1", id) })

	if _, err := seed.Exec(ctx, `
INSERT INTO ops_incident_updates (id, incident_id, idempotency_key, body, author)
SELECT ('60000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
       $1::uuid,
       ('61000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
       'update-' || n::text,
       'op@postwave.test'
  FROM generate_series(1, $2) AS n`, id, incidentTimelineUpdateLimit+2); err != nil {
		t.Fatalf("insert timeline updates: %v", err)
	}
	// Force every row onto the same timestamp to prove UUID tie-breaking has no
	// duplicate/gap boundary. Production timestamps are server-owned and may be
	// equal under concurrency; this admin-only fixture update cannot be issued
	// by postwave_ops.
	if _, err := seed.Exec(ctx, `
UPDATE ops_incident_updates
   SET created_at = (SELECT opened_at FROM ops_incidents WHERE id = $1::uuid)
 WHERE incident_id = $1::uuid`, id); err != nil {
		t.Fatalf("align timeline timestamps: %v", err)
	}

	reader := &Reader{Pool: pool}
	detail, err := reader.IncidentTimeline(ctx, id, "")
	if err != nil {
		t.Fatalf("IncidentTimeline: %v", err)
	}
	if !detail.UpdatesTruncated {
		t.Fatal("timeline above the response cap must report truncation")
	}
	if len(detail.Updates) != incidentTimelineUpdateLimit {
		t.Fatalf("timeline returned %d updates, want cap %d", len(detail.Updates), incidentTimelineUpdateLimit)
	}
	if detail.NextBefore == "" || detail.NextBefore != detail.Updates[0].ID {
		t.Fatalf("first page cursor=%q oldest=%q", detail.NextBefore, detail.Updates[0].ID)
	}

	seen := make(map[string]bool, incidentTimelineUpdateLimit+2)
	appendPage := func(page *IncidentDetail) {
		t.Helper()
		for i, update := range page.Updates {
			if seen[update.ID] {
				t.Fatalf("duplicate update across pages: %s", update.ID)
			}
			seen[update.ID] = true
			if i > 0 {
				previous := page.Updates[i-1]
				if previous.CreatedAt.After(update.CreatedAt) ||
					(previous.CreatedAt.Equal(update.CreatedAt) && previous.ID >= update.ID) {
					t.Fatalf("page is not deterministic (created_at,id) ascending: %s then %s", previous.ID, update.ID)
				}
			}
		}
	}
	appendPage(detail)
	older, err := reader.IncidentTimeline(ctx, id, detail.NextBefore)
	if err != nil {
		t.Fatalf("older IncidentTimeline: %v", err)
	}
	if older.UpdatesTruncated || older.NextBefore != "" || len(older.Updates) != 2 {
		t.Fatalf("older page = len %d truncated=%v next=%q, want 2/false/empty",
			len(older.Updates), older.UpdatesTruncated, older.NextBefore)
	}
	appendPage(older)
	if len(seen) != incidentTimelineUpdateLimit+2 {
		t.Fatalf("pagination covered %d unique updates, want %d", len(seen), incidentTimelineUpdateLimit+2)
	}

	// A canonical UUID is not a globally transferable cursor. Another
	// incident's update and a deleted update both fail identically.
	var otherIncident, foreignCursor string
	if err := seed.QueryRow(ctx, `
INSERT INTO ops_incidents (idempotency_key, title, severity, opened_by)
VALUES ('62000000-0000-4000-8000-000000000001', 'Other cursor owner', 'sev3', 'op@postwave.test')
RETURNING id::text`).Scan(&otherIncident); err != nil {
		t.Fatalf("insert other incident: %v", err)
	}
	t.Cleanup(func() {
		_, _ = seed.Exec(context.Background(), "DELETE FROM ops_incidents WHERE id = $1", otherIncident)
	})
	if err := seed.QueryRow(ctx, `
INSERT INTO ops_incident_updates (incident_id, idempotency_key, body, author)
VALUES ($1::uuid, '62000000-0000-4000-8000-000000000002', 'foreign', 'op@postwave.test')
RETURNING id::text`, otherIncident).Scan(&foreignCursor); err != nil {
		t.Fatalf("insert foreign cursor: %v", err)
	}
	if _, err := reader.IncidentTimeline(ctx, id, foreignCursor); !errors.Is(err, ErrIncidentCursorNotFound) {
		t.Fatalf("cross-incident cursor error=%v, want ErrIncidentCursorNotFound", err)
	}

	deletedCursor := older.Updates[0].ID
	if _, err := seed.Exec(ctx,
		`DELETE FROM ops_incident_updates WHERE incident_id = $1::uuid AND id = $2::uuid`, id, deletedCursor); err != nil {
		t.Fatalf("delete cursor fixture: %v", err)
	}
	if _, err := reader.IncidentTimeline(ctx, id, deletedCursor); !errors.Is(err, ErrIncidentCursorNotFound) {
		t.Fatalf("deleted cursor error=%v, want ErrIncidentCursorNotFound", err)
	}
}
