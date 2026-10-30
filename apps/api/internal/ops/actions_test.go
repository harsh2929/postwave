// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	testActionReplayKey = "018f4f4c-53de-7c12-ae4d-fbbac8f7c101"
	testActionFailKey   = "018f4f4c-53de-7c12-ae4d-fbbac8f7c102"
	testActionPanicKey  = "018f4f4c-53de-7c12-ae4d-fbbac8f7c103"
	testActionAuditKey  = "018f4f4c-53de-7c12-ae4d-fbbac8f7c104"
	testSnoozeKey       = "018f4f4c-53de-7c12-ae4d-fbbac8f7c201"
	testSnoozeReplayKey = "018f4f4c-53de-7c12-ae4d-fbbac8f7c202"
	testSnoozeRaceKey   = "018f4f4c-53de-7c12-ae4d-fbbac8f7c203"
)

// ---- fixtures -------------------------------------------------------------

// recordingSink is the fake AuditSink: it remembers every event and can be
// told to fail, so the fail-closed intent path is testable.
type recordingSink struct {
	mu     sync.Mutex
	events []recordedEvent
	fail   bool
}

type recordedEvent struct {
	Event  string
	Fields map[string]any
}

type blockingRecordingSink struct {
	recordingSink
	intentStarted chan struct{}
	releaseIntent chan struct{}
	startedOnce   sync.Once
}

func (s *blockingRecordingSink) Sink(ctx context.Context, event string, fields map[string]any) error {
	if event == "ops.check.snooze.intent" {
		s.startedOnce.Do(func() { close(s.intentStarted) })
		select {
		case <-s.releaseIntent:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.recordingSink.Sink(ctx, event, fields)
}

func (s *recordingSink) Sink(_ context.Context, event string, fields map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return fmt.Errorf("sink down")
	}
	s.events = append(s.events, recordedEvent{Event: event, Fields: fields})
	return nil
}

func (s *recordingSink) byEvent(event string) []recordedEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []recordedEvent
	for _, e := range s.events {
		if e.Event == event {
			out = append(out, e)
		}
	}
	return out
}

// registerActionCheck registers a well-formed check with an ActionMeta and a
// runner, and unregisters both on cleanup so the global registry stays clean
// for the rest of the package's tests.
func registerActionCheck(t *testing.T, id string, sev Severity, run ActionRunner) {
	t.Helper()
	Register(Check{
		ID: id, Group: "Billing", Title: "t", Why: "w", Remediation: "r",
		Domain: "billing", Owner: "founder",
		Kind: KindEvaluated, Severity: sev, Interval: time.Hour,
		Probe:  func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil },
		Action: &ActionMeta{ID: id + ".act", Label: "Do it", Danger: DangerConfirm},
	})
	t.Cleanup(func() { delete(registry, id) })
	if run != nil {
		BindAction(id, run)
		t.Cleanup(func() { delete(bindings, id) })
	}
}

// cleanupActionRuns deletes, when the test ends, the ops_action_runs rows
// recorded against exactly the named checks: the ones the test registered
// and posted to.
//
// ops_action_runs is a platform ledger with no tenant column, and every
// package's tests share one database while they run, so a row can only be
// told apart by its check_id. The cleanup therefore names its checks and never
// matches a pattern. It used to delete `check_id LIKE 't.%'`, which also
// matched rows that other packages seed: ops/checks' stale-inventory test
// seeded "t.health.NN" runs, and this cleanup deleted them between its seed
// and its probe.
func cleanupActionRuns(t *testing.T, pool *pgxpool.Pool, checkIDs ...string) {
	t.Helper()
	if len(checkIDs) == 0 {
		t.Fatal("cleanupActionRuns: name the check IDs whose runs this test records")
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM ops_action_runs WHERE check_id = ANY($1::text[])`, checkIDs); err != nil {
			t.Errorf("cleanup ops_action_runs: %v", err)
		}
	})
}

func opCtx(r *http.Request) *http.Request {
	ctx := context.WithValue(r.Context(), operatorCtxKey{},
		Operator{ID: "00000000-0000-0000-0000-000000000001", Email: "op@postwave.test"})
	return r.WithContext(ctx)
}

func actionRouter(exec *ActionExecutor, store *Store, sink AuditSink) http.Handler {
	r := chi.NewRouter()
	r.Post("/checks/{id}/action", exec.Handler())
	r.Post("/checks/{id}/snooze", SnoozeHandler(store, sink))
	return r
}

func postJSON(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = opCtx(req)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func snoozeJSON(key, duration, reason string) string {
	body, err := json.Marshal(snoozeRequest{
		IdempotencyKey: key,
		Duration:       duration,
		Reason:         reason,
	})
	if err != nil {
		panic(err)
	}
	return string(body)
}

// Pins cleanupActionRuns to the rows it names. The neighbour has the "t."
// shape that the old `LIKE 't.%'` cleanup matched, so a return to deleting
// by pattern fails here in this package, and not as an occasional failure in
// another package that happens to run at the same time.
func TestCleanupActionRuns_DeletesOnlyTheNamedChecks(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	named := "t.cleanup-named." + suffix
	neighbour := "t.health." + suffix
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM ops_action_runs WHERE check_id = $1`, neighbour); err != nil {
			t.Errorf("cleanup neighbour run: %v", err)
		}
	})

	// Terminal rows: they never enter ops/checks' stale-run inventory.
	insert := func(t *testing.T, checkID string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			INSERT INTO ops_action_runs
			       (check_id, action_id, idempotency_key, operator_email, status, finished_at)
			VALUES ($1, 'cleanup-guard', $1 || '.key', 'op@postwave.test', 'succeeded', now())`,
			checkID); err != nil {
			t.Fatalf("seed %s: %v", checkID, err)
		}
	}
	count := func(checkID string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM ops_action_runs WHERE check_id = $1`, checkID).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", checkID, err)
		}
		return n
	}

	t.Run("owner", func(t *testing.T) {
		cleanupActionRuns(t, pool, named)
		insert(t, named)
		insert(t, neighbour)
	})
	if n := count(named); n != 0 {
		t.Fatalf("cleanupActionRuns left %d row(s) of the check it was given", n)
	}
	if n := count(neighbour); n != 1 {
		t.Fatalf("cleanupActionRuns deleted a row of a check it was not given (%d of 1 left)", n)
	}
}

// ---- executor -------------------------------------------------------------

func TestAction_UnknownCheckIs404(t *testing.T) {
	pool := testPool(t)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.does-not-exist/action",
		`{"idempotency_key":"k-404"}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown action must 404, got %d: %s", w.Code, w.Body)
	}
}

func TestAction_CheckWithoutRunnerIs404(t *testing.T) {
	pool := testPool(t)
	registerActionCheck(t, "t.act-no-runner", SevRoutine, nil) // meta, no bind
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.act-no-runner/action", `{"idempotency_key":"k-nr"}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("check without a bound runner must 404, got %d", w.Code)
	}
}

// The double-click test: the second POST with the same idempotency key must
// return the first run's result WITHOUT invoking the runner again.
func TestAction_DuplicateIdempotencyKeyReplaysWithoutRerunning(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.act-replay")

	var calls int
	registerActionCheck(t, "t.act-replay", SevRoutine,
		func(context.Context, string) (string, error) {
			calls++
			return "replayed 3 events", nil
		})
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w1 := postJSON(t, h, "/checks/t.act-replay/action", `{"idempotency_key":"`+testActionReplayKey+`"}`)
	if w1.Code != http.StatusOK {
		t.Fatalf("first invocation: got %d: %s", w1.Code, w1.Body)
	}
	var r1 actionResponse
	if err := json.Unmarshal(w1.Body.Bytes(), &r1); err != nil {
		t.Fatal(err)
	}
	if r1.Replayed || r1.Status != "succeeded" || r1.Result != "replayed 3 events" {
		t.Fatalf("first invocation wrong: %+v", r1)
	}

	w2 := postJSON(t, h, "/checks/t.act-replay/action", `{"idempotency_key":"`+testActionReplayKey+`"}`)
	if w2.Code != http.StatusOK {
		t.Fatalf("replay must be HTTP 200, got %d: %s", w2.Code, w2.Body)
	}
	var r2 actionResponse
	if err := json.Unmarshal(w2.Body.Bytes(), &r2); err != nil {
		t.Fatal(err)
	}
	if !r2.Replayed {
		t.Fatal("second invocation with the same key must say replayed:true")
	}
	if r2.Result != "replayed 3 events" || r2.RunID != r1.RunID {
		t.Fatalf("replay must return the STORED run, got %+v want run %s", r2, r1.RunID)
	}
	if calls != 1 {
		t.Fatalf("runner ran %d times; an idempotent replay must not re-run", calls)
	}

	conflict := postJSON(t, h, "/checks/t.act-replay/action",
		`{"idempotency_key":"`+testActionReplayKey+`","input":"different payload"}`)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("same key with different payload must conflict, got %d: %s", conflict.Code, conflict.Body)
	}
	if calls != 1 {
		t.Fatalf("payload conflict ran the action; calls=%d", calls)
	}
}

// A failed runner is a visible failure: run row 'failed', outcome audit row
// still written. Never a row stuck in 'running', never a missing outcome.
func TestAction_FailedRunnerIsVisibleAndAudited(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.act-fail")

	registerActionCheck(t, "t.act-fail", SevRoutine,
		func(context.Context, string) (string, error) {
			return "", fmt.Errorf("SES said no")
		})
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.act-fail/action", `{"idempotency_key":"`+testActionFailKey+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d: %s", w.Code, w.Body)
	}
	var resp actionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Status != "failed" || !strings.Contains(resp.Result, "SES said no") {
		t.Fatalf("failure must be reported verbatim, got %+v", resp)
	}

	var status, result string
	var finished *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT status, result, finished_at FROM ops_action_runs WHERE id = $1`,
		resp.RunID).Scan(&status, &result, &finished); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || finished == nil {
		t.Fatalf("run row must be failed+finished, got status=%q finished=%v", status, finished)
	}

	if n := len(sink.byEvent("ops.action.intent")); n != 1 {
		t.Fatalf("want 1 intent audit event, got %d", n)
	}
	outcomes := sink.byEvent("ops.action.outcome")
	if len(outcomes) != 1 {
		t.Fatalf("a FAILED action must still write its outcome audit row; got %d", len(outcomes))
	}
	if outcomes[0].Fields["status"] != "failed" {
		t.Fatalf("outcome audit must say failed, got %v", outcomes[0].Fields)
	}
}

// A panicking runner must land as a failed row, not a stuck 'running' one.
func TestAction_PanickingRunnerBecomesFailedRun(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.act-panic")

	registerActionCheck(t, "t.act-panic", SevRoutine,
		func(context.Context, string) (string, error) { panic("boom") })
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.act-panic/action", `{"idempotency_key":"`+testActionPanicKey+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d: %s", w.Code, w.Body)
	}
	var resp actionResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Status != "failed" || !strings.Contains(resp.Result, "boom") {
		t.Fatalf("panic must surface as a failed run, got %+v", resp)
	}
}

// If the intent audit cannot be written the action must NOT run.
func TestAction_IntentAuditFailureRefusesToRun(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.act-noaudit")

	var calls int
	registerActionCheck(t, "t.act-noaudit", SevRoutine,
		func(context.Context, string) (string, error) { calls++; return "ran", nil })
	sink := &recordingSink{fail: true}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.act-noaudit/action", `{"idempotency_key":"`+testActionAuditKey+`"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unauditable action must 503, got %d", w.Code)
	}
	if calls != 0 {
		t.Fatal("runner must not execute when the intent audit write fails")
	}
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM ops_action_runs WHERE idempotency_key = $1`, testActionAuditKey).
		Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Fatalf("the refused run must be recorded as failed, got %q", status)
	}
}

func TestAction_MissingIdempotencyKeyIs422(t *testing.T) {
	pool := testPool(t)
	registerActionCheck(t, "t.act-nokey", SevRoutine,
		func(context.Context, string) (string, error) { return "", nil })
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.act-nokey/action", `{"input":"x"}`)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing idempotency key must 422, got %d", w.Code)
	}
}

func TestAction_StrictIntentKeyAndBoundedInput(t *testing.T) {
	pool := testPool(t)
	var calls int
	registerActionCheck(t, "t.act-validate", SevRoutine,
		func(context.Context, string) (string, error) { calls++; return "", nil })
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	tests := []string{
		`{"idempotency_key":"not-a-uuid"}`,
		`{"idempotency_key":"00000000-0000-0000-0000-000000000000"}`,
		`{"idempotency_key":" 018f4f4c-53de-7c12-ae4d-fbbac8f7c105"}`,
		`{"idempotency_key":"018F4F4C-53DE-7C12-AE4D-FBBAC8F7C105"}`,
		`{"idempotency_key":"018f4f4c-53de-7c12-ae4d-fbbac8f7c105","input":"bad\ninput"}`,
		`{"idempotency_key":"018f4f4c-53de-7c12-ae4d-fbbac8f7c105","input":"` + string([]byte{0xff}) + `"}`,
		`{"idempotency_key":"018f4f4c-53de-7c12-ae4d-fbbac8f7c105","input":"` + strings.Repeat("x", maxActionInputRunes+1) + `"}`,
	}
	for _, body := range tests {
		w := postJSON(t, h, "/checks/t.act-validate/action", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid action body status=%d body=%s request=%s", w.Code, w.Body, body)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid input reached runner %d times", calls)
	}
}

func TestAction_ResultIsBoundedBeforePersistenceAndResponse(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.act-result-bound")
	registerActionCheck(t, "t.act-result-bound", SevRoutine,
		func(context.Context, string) (string, error) { return strings.Repeat("é", 3000), nil })
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)
	key := "018f4f4c-53de-7c12-ae4d-fbbac8f7c106"
	w := postJSON(t, h, "/checks/t.act-result-bound/action", `{"idempotency_key":"`+key+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	var resp actionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Result) > maxActionResultBytes || !strings.HasSuffix(resp.Result, "…") {
		t.Fatalf("result was not bounded: bytes=%d suffix=%v", len(resp.Result), strings.HasSuffix(resp.Result, "…"))
	}
	var stored string
	if err := pool.QueryRow(context.Background(),
		`SELECT result FROM ops_action_runs WHERE idempotency_key = $1`, key).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != resp.Result {
		t.Fatal("stored and returned bounded results differ")
	}
}

// ---- BindAction wiring panics ----------------------------------------------

func mustPanic(t *testing.T, why string, f func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatal(why)
		}
	}()
	f()
}

func TestBindAction_PanicsOnUnknownCheck(t *testing.T) {
	mustPanic(t, "binding an action to an unregistered check must panic", func() {
		BindAction("t.bind-nocheck", func(context.Context, string) (string, error) { return "", nil })
	})
}

func TestBindAction_PanicsWithoutActionMeta(t *testing.T) {
	Register(Check{
		ID: "t.bind-nometa", Why: "w", Remediation: "r",
		Domain: "billing", Owner: "founder",
		Kind: KindEvaluated, Interval: time.Hour,
		Probe: func(context.Context, *Env) (Status, string, error) { return StatusOK, "", nil },
	})
	t.Cleanup(func() { delete(registry, "t.bind-nometa") })
	mustPanic(t, "binding a runner to a check with no ActionMeta must panic", func() {
		BindAction("t.bind-nometa", func(context.Context, string) (string, error) { return "", nil })
	})
}

func TestBindAction_PanicsOnDuplicateBind(t *testing.T) {
	run := func(context.Context, string) (string, error) { return "", nil }
	registerActionCheck(t, "t.bind-dup", SevRoutine, run)
	mustPanic(t, "a second BindAction for the same check must panic", func() {
		BindAction("t.bind-dup", run)
	})
}

// ---- snooze -----------------------------------------------------------------

func TestSnooze_RequiresCanonicalIdempotencyKey(t *testing.T) {
	pool := testPool(t)
	registerActionCheck(t, "t.snz-key", SevRoutine, nil)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	for _, body := range []string{
		`{"duration":"24h","reason":"vendor incident"}`,
		snoozeJSON("not-a-uuid", "24h", "vendor incident"),
		snoozeJSON("00000000-0000-0000-0000-000000000000", "24h", "vendor incident"),
		snoozeJSON("018F4F4C-53DE-7C12-AE4D-FBBAC8F7C201", "24h", "vendor incident"),
	} {
		w := postJSON(t, h, "/checks/t.snz-key/snooze", body)
		if w.Code != http.StatusUnprocessableEntity && w.Code != http.StatusBadRequest {
			t.Fatalf("invalid key status=%d body=%s", w.Code, w.Body)
		}
	}
	if len(sink.events) != 0 {
		t.Fatalf("invalid snooze key reached audit: %+v", sink.events)
	}
}

func TestSnooze_DuplicateKeyReplaysWithoutExtendingOrReauditing(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.snz-replay")
	truncate(t, pool, "ops_check_results")
	registerActionCheck(t, "t.snz-replay", SevRoutine, nil)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)
	body := snoozeJSON(testSnoozeReplayKey, "24h", " vendor incident ")

	first := postJSON(t, h, "/checks/t.snz-replay/snooze", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first snooze status=%d body=%s", first.Code, first.Body)
	}
	var firstResponse snoozeResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstResponse); err != nil {
		t.Fatal(err)
	}
	if firstResponse.Status != "succeeded" || firstResponse.Replayed || firstResponse.SnoozedUntil == nil {
		t.Fatalf("first snooze response=%+v", firstResponse)
	}

	var firstExpiry time.Time
	var firstXmin string
	if err := pool.QueryRow(context.Background(), `
		SELECT acked_until, xmin::text
		  FROM ops_check_results
		 WHERE check_id = 't.snz-replay'`).Scan(&firstExpiry, &firstXmin); err != nil {
		t.Fatal(err)
	}

	time.Sleep(5 * time.Millisecond)
	replay := postJSON(t, h, "/checks/t.snz-replay/snooze", body)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status=%d body=%s", replay.Code, replay.Body)
	}
	var replayResponse snoozeResponse
	if err := json.Unmarshal(replay.Body.Bytes(), &replayResponse); err != nil {
		t.Fatal(err)
	}
	if !replayResponse.Replayed || replayResponse.Status != "succeeded" ||
		replayResponse.RunID != firstResponse.RunID || replayResponse.SnoozedUntil == nil ||
		!replayResponse.SnoozedUntil.Equal(*firstResponse.SnoozedUntil) {
		t.Fatalf("replay did not return the exact durable outcome: first=%+v replay=%+v", firstResponse, replayResponse)
	}

	var replayExpiry time.Time
	var replayXmin string
	if err := pool.QueryRow(context.Background(), `
		SELECT acked_until, xmin::text
		  FROM ops_check_results
		 WHERE check_id = 't.snz-replay'`).Scan(&replayExpiry, &replayXmin); err != nil {
		t.Fatal(err)
	}
	if !replayExpiry.Equal(firstExpiry) || replayXmin != firstXmin {
		t.Fatalf("replay mutated/extended snooze: expiry %s -> %s, xmin %s -> %s",
			firstExpiry, replayExpiry, firstXmin, replayXmin)
	}
	if n := len(sink.byEvent("ops.check.snooze.intent")); n != 1 {
		t.Fatalf("replay wrote %d intent audit events, want 1", n)
	}
	if n := len(sink.byEvent("ops.check.snoozed")); n != 1 {
		t.Fatalf("replay wrote %d success audit events, want 1", n)
	}
	var runCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM ops_action_runs WHERE idempotency_key = $1`, testSnoozeReplayKey).
		Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 1 {
		t.Fatalf("idempotency ledger rows=%d, want 1", runCount)
	}
}

func TestSnooze_SameKeyDifferentTypedPayloadOperatorOrCheckConflicts(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.snz-bound-a", "t.snz-bound-b")
	truncate(t, pool, "ops_check_results")
	registerActionCheck(t, "t.snz-bound-a", SevRoutine, nil)
	registerActionCheck(t, "t.snz-bound-b", SevRoutine, nil)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)
	base := snoozeJSON(testSnoozeReplayKey, "24h", "vendor\nincident")
	if w := postJSON(t, h, "/checks/t.snz-bound-a/snooze", base); w.Code != http.StatusOK {
		t.Fatalf("first snooze status=%d body=%s", w.Code, w.Body)
	}

	for name, request := range map[string]struct {
		path string
		body string
	}{
		"duration": {path: "/checks/t.snz-bound-a/snooze", body: snoozeJSON(testSnoozeReplayKey, "25h", "vendor\nincident")},
		"reason":   {path: "/checks/t.snz-bound-a/snooze", body: snoozeJSON(testSnoozeReplayKey, "24h", "vendor incident")},
		"check":    {path: "/checks/t.snz-bound-b/snooze", body: base},
	} {
		t.Run(name, func(t *testing.T) {
			w := postJSON(t, h, request.path, request.body)
			if w.Code != http.StatusConflict {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
		})
	}

	req := httptest.NewRequest(http.MethodPost, "/checks/t.snz-bound-a/snooze", strings.NewReader(base))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(req.Context(), operatorCtxKey{},
		Operator{ID: "00000000-0000-0000-0000-000000000002", Email: "other@postwave.test"}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("different operator status=%d body=%s", w.Code, w.Body)
	}

	if n := len(sink.byEvent("ops.check.snooze.intent")); n != 1 {
		t.Fatalf("conflicting retries wrote %d intents, want 1", n)
	}
	var otherRows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM ops_check_results WHERE check_id = 't.snz-bound-b'`).Scan(&otherRows); err != nil {
		t.Fatal(err)
	}
	if otherRows != 0 {
		t.Fatal("a conflicting check payload mutated the other check")
	}
}

func TestSnooze_ConcurrentReplayAndCancelledRequestStayOneIntent(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.snz-race")
	truncate(t, pool, "ops_check_results")
	registerActionCheck(t, "t.snz-race", SevRoutine, nil)
	sink := &blockingRecordingSink{
		intentStarted: make(chan struct{}),
		releaseIntent: make(chan struct{}),
	}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)
	body := snoozeJSON(testSnoozeRaceKey, "24h", "provider outage")

	requestContext, cancelRequest := context.WithCancel(context.Background())
	firstRequest := httptest.NewRequest(http.MethodPost, "/checks/t.snz-race/snooze", strings.NewReader(body)).
		WithContext(requestContext)
	firstRequest.Header.Set("Content-Type", "application/json")
	firstRequest = opCtx(firstRequest)
	first := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		h.ServeHTTP(first, firstRequest)
		close(firstDone)
	}()

	select {
	case <-sink.intentStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("first snooze never reached its durable intent audit")
	}
	// Simulate a browser/proxy disappearing after the API durably claimed the
	// key. The handler's detached lifecycle must still finish exactly once.
	cancelRequest()

	running := postJSON(t, h, "/checks/t.snz-race/snooze", body)
	if running.Code != http.StatusOK {
		t.Fatalf("concurrent replay status=%d body=%s", running.Code, running.Body)
	}
	var runningResponse snoozeResponse
	if err := json.Unmarshal(running.Body.Bytes(), &runningResponse); err != nil {
		t.Fatal(err)
	}
	if runningResponse.Status != "running" || !runningResponse.Replayed || runningResponse.SnoozedUntil != nil {
		t.Fatalf("concurrent replay must truthfully retain running intent: %+v", runningResponse)
	}

	close(sink.releaseIntent)
	select {
	case <-firstDone:
	case <-time.After(5 * time.Second):
		t.Fatal("detached snooze did not finish after request cancellation")
	}
	if first.Code != http.StatusOK {
		t.Fatalf("detached first snooze status=%d body=%s", first.Code, first.Body)
	}
	var firstResponse snoozeResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstResponse); err != nil {
		t.Fatal(err)
	}
	if firstResponse.Status != "succeeded" || firstResponse.RunID != runningResponse.RunID {
		t.Fatalf("first/concurrent responses disagree: first=%+v running=%+v", firstResponse, runningResponse)
	}

	terminalReplay := postJSON(t, h, "/checks/t.snz-race/snooze", body)
	var terminal snoozeResponse
	if err := json.Unmarshal(terminalReplay.Body.Bytes(), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Status != "succeeded" || !terminal.Replayed || terminal.RunID != firstResponse.RunID ||
		terminal.SnoozedUntil == nil || !terminal.SnoozedUntil.Equal(*firstResponse.SnoozedUntil) {
		t.Fatalf("terminal replay changed the intent: first=%+v terminal=%+v", firstResponse, terminal)
	}
	if n := len(sink.byEvent("ops.check.snooze.intent")); n != 1 {
		t.Fatalf("concurrent replay wrote %d intent audits, want 1", n)
	}
	if n := len(sink.byEvent("ops.check.snoozed")); n != 1 {
		t.Fatalf("concurrent replay wrote %d success audits, want 1", n)
	}
}

func TestSnooze_EmptyReasonIs422(t *testing.T) {
	pool := testPool(t)
	registerActionCheck(t, "t.snz-noreason", SevRoutine, nil)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.snz-noreason/snooze", snoozeJSON(testSnoozeKey, "24h", "  "))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty reason must 422, got %d: %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), "invalid_reason") {
		t.Fatalf("empty reason must fail for its reason, got %s", w.Body.String())
	}
}

func TestSnooze_StoreRefusesEmptyReason(t *testing.T) {
	pool := testPool(t)
	s := NewStore(pool)
	if err := s.Snooze(context.Background(), "t.snz-store", time.Now().Add(time.Hour), " "); err == nil {
		t.Fatal("Store.Snooze must refuse an empty reason")
	}
}

func TestSnooze_CriticalCapsAtSevenDays(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.snz-crit")
	truncate(t, pool, "ops_check_results")
	registerActionCheck(t, "t.snz-crit", SevCritical, nil)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.snz-crit/snooze", snoozeJSON(testSnoozeKey, "8d", "vendor migration"))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("8d snooze on a critical check must 422, got %d: %s", w.Code, w.Body)
	}

	w = postJSON(t, h, "/checks/t.snz-crit/snooze", snoozeJSON(testSnoozeKey, "7d", "vendor migration"))
	if w.Code != http.StatusOK {
		t.Fatalf("7d snooze on a critical check must be allowed, got %d: %s", w.Code, w.Body)
	}
	if n := len(sink.byEvent("ops.check.snoozed")); n != 1 {
		t.Fatalf("want exactly 1 ops.check.snoozed audit event, got %d", n)
	}
	if n := len(sink.byEvent("ops.check.snooze.intent")); n != 1 {
		t.Fatalf("want exactly 1 ops.check.snooze.intent audit event, got %d", n)
	}
}

func TestSnooze_FailsClosedBeforeMutationWhenAuditUnavailable(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.snz-noaudit")
	truncate(t, pool, "ops_check_results")
	registerActionCheck(t, "t.snz-noaudit", SevRoutine, nil)
	sink := &recordingSink{fail: true}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.snz-noaudit/snooze", snoozeJSON(testSnoozeKey, "24h", "vendor incident"))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unauditable snooze status=%d body=%s", w.Code, w.Body)
	}
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM ops_check_results WHERE check_id = 't.snz-noaudit'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("unauditable snooze mutated the check result")
	}
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM ops_action_runs WHERE idempotency_key = $1`, testSnoozeKey).
		Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Fatalf("unauditable snooze ledger status=%q, want failed", status)
	}
}

func TestSnooze_RejectsInvalidOrOversizedReasonAndOverflowDuration(t *testing.T) {
	pool := testPool(t)
	registerActionCheck(t, "t.snz-validate", SevRoutine, nil)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)
	for _, body := range []string{
		snoozeJSON(testSnoozeKey, "24h", "bad\x00reason"),
		snoozeJSON(testSnoozeKey, "24h", strings.Repeat("x", maxSnoozeReasonRunes+1)),
	} {
		w := postJSON(t, h, "/checks/t.snz-validate/snooze", body)
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid reason status=%d body=%s", w.Code, w.Body)
		}
	}
	if _, err := parseSnoozeDuration("106752d"); err == nil {
		t.Fatal("overflowing day duration must be rejected")
	}
}

func TestSnooze_UnknownCheckIs404(t *testing.T) {
	pool := testPool(t)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, NewStore(pool), sink.Sink)

	w := postJSON(t, h, "/checks/t.snz-ghost/snooze", snoozeJSON(testSnoozeKey, "24h", "x"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("snoozing an unknown check must 404, got %d", w.Code)
	}
}

// End-to-end through the board: a snoozed red check moves to the SNOOZED lane
// and out of ON FIRE.
func TestSnooze_SnoozedCheckAppearsInSnoozedLane(t *testing.T) {
	pool := testPool(t)
	cleanupActionRuns(t, pool, "t.snz-lane")
	truncate(t, pool, "ops_check_results", "ops_check_history")
	registerActionCheck(t, "t.snz-lane", SevCritical, nil)
	c, _ := Get("t.snz-lane")
	store := NewStore(pool)
	sink := &recordingSink{}
	h := actionRouter(&ActionExecutor{Pool: pool, Audit: sink.Sink}, store, sink.Sink)

	now := time.Now().UTC()
	if err := store.Upsert(context.Background(), "t.snz-lane", Result{}, StatusRed, "on fire", now); err != nil {
		t.Fatal(err)
	}

	// Pre-snooze: the red critical check sits in ON FIRE.
	results, err := store.LoadAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	board := BuildBoard(now, []Check{c}, results)
	if !laneHasCard(board, "ON FIRE", "t.snz-lane") {
		t.Fatal("precondition: red critical check must be in ON FIRE")
	}

	w := postJSON(t, h, "/checks/t.snz-lane/snooze", snoozeJSON(testSnoozeKey, "48h", "replaying tonight"))
	if w.Code != http.StatusOK {
		t.Fatalf("snooze failed: %d %s", w.Code, w.Body)
	}

	results, err = store.LoadAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	board = BuildBoard(now, []Check{c}, results)
	if laneHasCard(board, "ON FIRE", "t.snz-lane") {
		t.Fatal("a snoozed check must leave ON FIRE")
	}
	if !laneHasCard(board, "SNOOZED", "t.snz-lane") {
		t.Fatal("a snoozed check must appear in the SNOOZED lane — snoozed is not gone")
	}
	// The reason travels to the card, so the board can say WHY it's muted.
	for _, lane := range board.Lanes {
		if lane.Name == "SNOOZED" {
			if lane.Cards[0].AckReason != "replaying tonight" {
				t.Fatalf("snoozed card must carry the reason, got %q", lane.Cards[0].AckReason)
			}
		}
	}
}

// The board is how the UI learns a check HAS a button: the registry's
// ActionMeta must travel onto the card verbatim.
func TestBuildBoard_CardCarriesActionMeta(t *testing.T) {
	c := Check{
		ID: "t.card-action", Why: "w", Remediation: "r",
		Kind: KindEvaluated, Severity: SevCritical, Interval: time.Hour,
		Action: &ActionMeta{ID: "t.card-action.act", Label: "Replay", Danger: DangerTypeToConfirm, InputHint: "type the tenant slug"},
	}
	now := time.Now().UTC()
	board := BuildBoard(now, []Check{c}, map[string]Result{
		"t.card-action": {CheckID: "t.card-action", Status: StatusRed, LastReportedAt: now},
	})
	if !laneHasCard(board, "ON FIRE", "t.card-action") {
		t.Fatal("precondition: check must be in ON FIRE")
	}
	for _, l := range board.Lanes {
		if l.Name != "ON FIRE" {
			continue
		}
		a := l.Cards[0].Action
		if a == nil || a.ID != "t.card-action.act" || a.Danger != DangerTypeToConfirm || a.InputHint == "" {
			t.Fatalf("card must carry the registry's ActionMeta verbatim, got %+v", a)
		}
	}
}

func laneHasCard(b BoardResponse, lane, id string) bool {
	for _, l := range b.Lanes {
		if l.Name != lane {
			continue
		}
		for _, c := range l.Cards {
			if c.ID == id {
				return true
			}
		}
	}
	return false
}

// A snooze on a check that has NEVER reported must not fabricate an
// observation: the stub row still derives to stale (epoch-old), it is merely
// snoozed.
func TestSnooze_NeverReportedCheckGetsHonestStub(t *testing.T) {
	pool := testPool(t)
	truncate(t, pool, "ops_check_results")
	store := NewStore(pool)

	until := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	if err := store.Snooze(context.Background(), "t.snz-stub", until, "not deployed yet"); err != nil {
		t.Fatal(err)
	}
	results, err := store.LoadAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	r, ok := results["t.snz-stub"]
	if !ok || r.AckedUntil == nil || !r.AckedUntil.Equal(until) {
		t.Fatalf("snooze stub missing or wrong: %+v", r)
	}
	c := Check{ID: "t.snz-stub", Kind: KindEvaluated, Interval: time.Hour}
	if eff := r.Effective(time.Now().UTC(), c); eff != StatusStale {
		t.Fatalf("the stub must still derive to stale (no fabricated freshness), got %q", eff)
	}
}

// ---- migration 1703's audit_log lane: the defending DB test ----------------
//
// The ops role may append tenant-less platform_operator rows to audit_log and
// NOTHING else: no tenant-attributed writes (RLS), no reads (no SELECT grant).
func TestOpsRole_AuditLogPlatformLaneOnly(t *testing.T) {
	pool := testPool(t) // superuser pool, used for setup/teardown
	opsPool := restrictedOpsPool(t)
	t.Cleanup(func() {
		// audit_log is append-only; deletion needs the internal-writer GUC
		// inside one tx. Only the row step 1 commits is deleted.
		tx, err := pool.Begin(context.Background())
		if err != nil {
			t.Errorf("cleanup begin: %v", err)
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(context.Background(),
			`SELECT set_config('app.audit_internal_writer','true',true)`); err != nil {
			t.Errorf("cleanup guc: %v", err)
			return
		}
		if _, err := tx.Exec(context.Background(),
			`DELETE FROM audit_log WHERE action = 'ops.test.platform-write' AND tenant_id IS NULL`); err != nil {
			t.Errorf("cleanup audit_log: %v", err)
			return
		}
		_ = tx.Commit(context.Background())
	})

	// 1. Platform lane: NULL tenant + platform_operator actor → allowed.
	if _, err := opsPool.Exec(context.Background(), `
		INSERT INTO audit_log (tenant_id, action, metadata, actor_type, actor_label)
		VALUES (NULL, 'ops.test.platform-write', '{"check_id":"t.x"}', 'platform_operator', 'op@postwave.test')`); err != nil {
		t.Fatalf("the ops role must be able to write a tenant-less platform_operator audit row: %v", err)
	}

	// 2. Tenant-attributed write → RLS must refuse (the ops role cannot
	// forge a row into any tenant's audit trail). Step 1 proved the INSERT
	// grant, so the refusal must be the row-level security policy (42501).
	// Any other error, such as a dropped connection or a missing tenant,
	// proves nothing.
	requireSQLState(t, forgeTenantAuditRowAsOpsRole(t, pool), "42501",
		"the ops role must NOT be able to write a tenant-attributed audit row")

	// 3. No reads: the audit trail is append-only from the ops role's seat.
	_, err := opsPool.Exec(context.Background(), `SELECT count(*) FROM audit_log`)
	requireSQLState(t, err, "42501", "the ops role must not be able to READ audit_log")
}

// forgeTenantAuditRowAsOpsRole attempts step 2's forgery against a tenant
// that exists only inside one transaction, which is always rolled back.
//
// The test used to target `SELECT id FROM tenants LIMIT 1`: whichever tenant
// another package's test happened to hold in the shared database. On a freshly
// migrated database (no tenants) the test failed. When that package deleted
// its tenant between the SELECT and the INSERT, the INSERT failed on the
// foreign key and the test passed without RLS refusing anything. Committing
// a tenant of our own is no better. Deleting a tenant cascades over every
// tenant-owned table and takes thousands of locks, and that is enough to
// exhaust the shared lock table for every package running at the same time.
//
// Here the tenant is real to the INSERT: its foreign key would be satisfied,
// so RLS is the only thing that can refuse. Nothing is committed, so no other
// package can see it or remove it. SET LOCAL ROLE takes the same postwave_ops
// seat as restrictedOpsPool for this transaction only.
func forgeTenantAuditRowAsOpsRole(t *testing.T, pool *pgxpool.Pool) error {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin forgery tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var tenantID string
	if err = tx.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier)
		VALUES ('ops-audit-lane-' || substr(md5(random()::text), 1, 12), 'Ops audit lane forgery target', 'studio')
		RETURNING id::text`).Scan(&tenantID); err != nil {
		t.Fatalf("seed forgery-target tenant: %v", err)
	}
	if _, err = tx.Exec(ctx, `SET LOCAL ROLE postwave_ops`); err != nil {
		t.Fatalf("assume postwave_ops: %v", err)
	}
	var role string
	if err = tx.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil || role != "postwave_ops" {
		t.Fatalf("forgery must run as postwave_ops, got current_user=%q err=%v", role, err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log (tenant_id, action, actor_type)
		VALUES ($1::uuid, 'ops.test.forged', 'platform_operator')`, tenantID)
	return err
}

// requireSQLState fails unless err is a PostgreSQL error with exactly code.
func requireSQLState(t *testing.T, err error, code, why string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code {
		t.Fatalf("%s: want SQLSTATE %s, got %v", why, code, err)
	}
}
