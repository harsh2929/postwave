// SPDX-License-Identifier: AGPL-3.0-only
//
// actions.go — the action executor and the snooze endpoint.
//
// Four rules from the spec, all enforced HERE rather than trusted to callers:
//
//  1. Idempotency on every invocation: the ops_action_runs UNIQUE key means a
//     double-click replays the stored result instead of re-running.
//  2. Audited before and after — ops.action.intent, then ops.action.outcome —
//     so an action that crashes mid-flight is a 'running' row with an intent
//     record, visible rather than ambiguous.
//  3. Runners proxy existing machinery; this file never implements business
//     logic. It only records, times out, and reports.
//  4. No action without a check: BindAction panics unless the registry check
//     exists and declares ActionMeta.
//
// Audit is a narrow func seam (AuditSink); main.go binds it to the audit_log
// writer. This package never imports the audit machinery, mirroring how
// SessionResolver keeps the auth package out.

package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// actionTimeout bounds every runner. An action that needs longer than this is
// a job, not a button.
const actionTimeout = 30 * time.Second

// actionLifecycleTimeout also bounds the detached ledger/audit work around a
// runner. Without an outer deadline, a database stall could keep a goroutine
// and connection alive indefinitely after the browser's proxy timed out.
const actionLifecycleTimeout = actionTimeout + 5*time.Second

const (
	maxActionRequestBodyBytes int64 = 20 << 10
	maxActionInputRunes             = 4096
	maxActionInputBytes             = 16 << 10
	maxActionResultBytes            = 2048
	maxSnoozeReasonRunes            = 4096
	maxSnoozeReasonBytes            = 16 << 10
)

// criticalSnoozeCap: you cannot snooze "customers are paying and not getting
// accounts" for a quarter. Server-enforced; the UI merely mirrors it.
const criticalSnoozeCap = 7 * 24 * time.Hour

// snoozeActionID keeps snooze intents in the same durable ledger as check
// actions without pretending that a snooze is one of the registry's bound
// business actions. check_id, operator_email, and the canonical input object
// complete the payload binding for the globally unique idempotency key.
const snoozeActionID = "ops.check.snooze"

// ActionRunner executes a check's bound action. input is the operator-typed
// string (may be empty for DangerSafe actions); result is one human-readable
// line stored on the run row and returned to the UI.
type ActionRunner func(ctx context.Context, input string) (result string, err error)

// AuditSink records one operator event. main.go adapts the repo's canonical
// audit_log writer (actor_type 'platform_operator', operator email resolved
// from OperatorFromContext) — see the ops wiring block there.
type AuditSink func(ctx context.Context, event string, fields map[string]any) error

// bindings maps check ID -> runner. Like the check registry it is wiring-time
// state: written only during startup (main.go) and package init, read by the
// handler. No mutex for the same reason registry has none.
var bindings = map[string]ActionRunner{}

// BindAction attaches the runner for a check's declared action. Panics are
// programmer errors and should stop the boot, not degrade to a dead button:
// unknown check, check without ActionMeta, duplicate bind, nil runner.
func BindAction(checkID string, run ActionRunner) {
	c, ok := registry[checkID]
	switch {
	case run == nil:
		panic(fmt.Sprintf("ops: BindAction(%q) with a nil runner", checkID))
	case !ok:
		panic(fmt.Sprintf("ops: BindAction(%q): no such check", checkID))
	case c.Action == nil:
		panic(fmt.Sprintf("ops: BindAction(%q): check declares no ActionMeta", checkID))
	}
	if _, dup := bindings[checkID]; dup {
		panic(fmt.Sprintf("ops: duplicate BindAction(%q)", checkID))
	}
	bindings[checkID] = run
}

// ActionExecutor serves POST /api/internal/ops/checks/{id}/action.
// Pool is the OPS pool (postwave_ops owns no business tables; it has
// SELECT/INSERT/UPDATE on ops_action_runs and INSERT-only on audit_log).
type ActionExecutor struct {
	Pool   *pgxpool.Pool
	Audit  AuditSink
	Logger *slog.Logger
}

type actionRequest struct {
	IdempotencyKey string `json:"idempotency_key"`
	Input          string `json:"input"`
}

type actionResponse struct {
	RunID    string `json:"run_id"`
	Status   string `json:"status"`
	Result   string `json:"result"`
	Replayed bool   `json:"replayed"`
}

// Handler executes a bound action, exactly once per idempotency key.
//
// Flow: resolve check+runner (404) → insert the run row (unique violation →
// replay the stored result, HTTP 200, no execution) → audit intent → run with
// a 30s timeout and panic recovery → update the row → audit outcome.
//
// The runner and the writes after it run on a context detached from the
// request (context.WithoutCancel): an operator closing the tab must not abort
// a half-executed action, and the outcome row must land even so.
func (e *ActionExecutor) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		checkID := chi.URLParam(r, "id")
		c, ok := Get(checkID)
		run := bindings[checkID]
		if !ok || c.Action == nil || run == nil {
			writeOpsAuthErr(w, http.StatusNotFound,
				"unknown_action", "no action is bound to this check")
			return
		}

		var req actionRequest
		if err := decodeActionJSON(r, &req); err != nil {
			httpbody.WriteError(w, err)
			return
		}
		if req.IdempotencyKey == "" {
			writeOpsAuthErr(w, http.StatusUnprocessableEntity,
				"idempotency_key_required",
				"every action invocation needs an idempotency key")
			return
		}
		if !canonicalActionIntentKey(req.IdempotencyKey) {
			writeOpsAuthErr(w, http.StatusBadRequest,
				"invalid_idempotency_key",
				"idempotency key must be a canonical non-zero UUID")
			return
		}
		if !validActionInput(req.Input) {
			writeOpsAuthErr(w, http.StatusBadRequest,
				"invalid_action_input",
				"action input must be at most 4096 characters without control characters")
			return
		}

		op, ok := OperatorFromContext(r.Context())
		operatorEmail := strings.TrimSpace(op.Email)
		if !ok || operatorEmail == "" {
			// The route is mounted behind RequirePlatformOperator; reaching
			// here without an operator means the mount is wrong. Fail loud.
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"operator_missing",
				"action endpoint reached without an authenticated operator")
			return
		}

		// Detached from the request: a closed tab must not abort a
		// half-executed action or lose its outcome row. Values (operator)
		// survive; cancellation does not.
		ctx, lifecycleCancel := context.WithTimeout(context.WithoutCancel(r.Context()), actionLifecycleTimeout)
		defer lifecycleCancel()

		var runID string
		err := e.Pool.QueryRow(ctx, `
			INSERT INTO ops_action_runs
			       (check_id, action_id, idempotency_key, operator_email, input, status)
			VALUES ($1, $2, $3, $4, to_jsonb($5::text), 'running')
			RETURNING id`,
			checkID, c.Action.ID, req.IdempotencyKey, operatorEmail, req.Input).Scan(&runID)
		if isIdempotencyConflict(err) {
			e.replay(ctx, w, req.IdempotencyKey, checkID, c.Action.ID, operatorEmail, req.Input)
			return
		}
		if err != nil {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"run_insert_failed", "could not record the action run")
			return
		}

		// Intent BEFORE execution, fail-closed: an action the audit trail
		// cannot see must not run. The idempotency key is deliberately
		// consumed — the operator retries with a fresh key once audit works.
		intentFields := map[string]any{
			"check_id": checkID, "action_id": c.Action.ID,
			"run_id": runID, "idempotency_key": req.IdempotencyKey,
			"input": req.Input,
		}
		if e.Audit == nil {
			_ = e.finish(ctx, runID, "failed", "refused to run: operator audit is unavailable")
			writeOpsAuthErr(w, http.StatusServiceUnavailable,
				"audit_unavailable", "refusing to run an unauditable action")
			return
		}
		if err := e.Audit(ctx, "ops.action.intent", intentFields); err != nil {
			e.logf("ops: intent audit write failed", "run_id", runID, "err", err)
			_ = e.finish(ctx, runID, "failed", "refused to run: operator audit is unavailable")
			writeOpsAuthErr(w, http.StatusServiceUnavailable,
				"audit_unavailable", "refusing to run an unauditable action")
			return
		}

		runCtx, cancel := context.WithTimeout(ctx, actionTimeout)
		result, runErr := runSafely(runCtx, run, req.Input)
		cancel()

		status := "succeeded"
		if runErr != nil {
			status = "failed"
			result = runErr.Error()
		}
		result = boundActionResult(result)
		if err := e.finish(ctx, runID, status, result); err != nil {
			e.logf("ops: could not finish action run", "run_id", runID, "err", err)
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"outcome_persist_failed", "the action may have run, but its outcome could not be recorded; retry with the same idempotency key")
			return
		}

		// Outcome audit is best-effort: the action already happened, and the
		// run row itself carries the result. Losing the outcome row is logged,
		// never swallowed silently.
		outcomeFields := map[string]any{
			"check_id": checkID, "action_id": c.Action.ID,
			"run_id": runID, "status": status, "result": result,
		}
		if err := e.Audit(ctx, "ops.action.outcome", outcomeFields); err != nil {
			e.logf("ops: outcome audit write failed", "run_id", runID, "err", err)
		}

		writeActionJSON(w, actionResponse{
			RunID: runID, Status: status, Result: result, Replayed: false,
		})
	}
}

// replay returns the stored result for an idempotency key that already has a
// run row. The runner is NOT invoked. A row still 'running' replays as
// running — the truthful answer while the first invocation is in flight.
func (e *ActionExecutor) replay(ctx context.Context, w http.ResponseWriter, key, checkID, actionID, operatorEmail, input string) {
	var resp actionResponse
	var storedCheckID, storedActionID, storedOperatorEmail, storedInput string
	err := e.Pool.QueryRow(ctx, `
		SELECT id, status, result, check_id, action_id, operator_email,
		       COALESCE(input #>> '{}', '')
		  FROM ops_action_runs
		 WHERE idempotency_key = $1`, key).
		Scan(&resp.RunID, &resp.Status, &resp.Result, &storedCheckID, &storedActionID, &storedOperatorEmail, &storedInput)
	if err != nil {
		writeOpsAuthErr(w, http.StatusInternalServerError,
			"replay_lookup_failed", "could not load the prior run for this idempotency key")
		return
	}
	if storedCheckID != checkID || storedActionID != actionID ||
		storedOperatorEmail != operatorEmail || storedInput != input {
		writeOpsAuthErr(w, http.StatusConflict,
			"idempotency_conflict", "idempotency key is already bound to a different operator action payload")
		return
	}
	resp.Result = boundActionResult(resp.Result)
	resp.Replayed = true
	writeActionJSON(w, resp)
}

func (e *ActionExecutor) finish(ctx context.Context, runID, status, result string) error {
	return finishActionRun(ctx, e.Pool, runID, status, result)
}

func finishActionRun(ctx context.Context, pool *pgxpool.Pool, runID, status, result string) error {
	command, err := pool.Exec(ctx, `
		UPDATE ops_action_runs
		   SET status = $2, result = $3, finished_at = now()
		 WHERE id = $1`, runID, status, result)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("finish action run %s: updated %d rows", runID, command.RowsAffected())
	}
	return nil
}

func (e *ActionExecutor) logf(msg string, args ...any) {
	if e.Logger != nil {
		e.Logger.Error(msg, args...)
	} else {
		slog.Error(msg, args...)
	}
}

// runSafely converts a panicking runner into an error: a crashed action must
// end as a 'failed' row with an outcome audit record, never as a 500 with a
// row stuck in 'running'.
func runSafely(ctx context.Context, run ActionRunner, input string) (result string, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("action panicked: %v", p)
		}
	}()
	return run(ctx, input)
}

func isIdempotencyConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" &&
		pgErr.ConstraintName == "ops_action_runs_idempotency_key_key"
}

func writeActionJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(v)
}

type snoozeRequest struct {
	IdempotencyKey string `json:"idempotency_key"`
	Duration       string `json:"duration"` // "36h", "90m", or "Nd" for days
	Reason         string `json:"reason"`
}

// snoozeIntent is stored as a JSON object in ops_action_runs.input. Keeping
// typed fields instead of a delimiter-joined string makes arbitrary multiline
// reasons collision-free and lets PostgreSQL compare the payload as jsonb.
type snoozeIntent struct {
	DurationNS int64  `json:"duration_ns"`
	Reason     string `json:"reason"`
}

type snoozeResponse struct {
	RunID        string     `json:"run_id"`
	Status       string     `json:"status"`
	Result       string     `json:"result"`
	SnoozedUntil *time.Time `json:"snoozed_until"`
	Replayed     bool       `json:"replayed"`
}

// SnoozeHandler serves POST /api/internal/ops/checks/{id}/snooze.
//
// The reason and a canonical UUID idempotency key are mandatory. The key is
// durably bound to check + operator + canonical duration/reason in
// ops_action_runs before any audit or state mutation. A retry therefore only
// replays the recorded running/failed/succeeded state; it never extends the
// snooze. Critical checks cap at 7 days, enforced HERE against the registry's
// severity — a client that lies about severity changes nothing.
func SnoozeHandler(store *Store, audit AuditSink) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		checkID := chi.URLParam(r, "id")
		c, ok := Get(checkID)
		if !ok {
			writeOpsAuthErr(w, http.StatusNotFound,
				"unknown_check", "no such check")
			return
		}

		var req snoozeRequest
		if err := decodeActionJSON(r, &req); err != nil {
			httpbody.WriteError(w, err)
			return
		}
		if req.IdempotencyKey == "" {
			writeOpsAuthErr(w, http.StatusUnprocessableEntity,
				"idempotency_key_required",
				"every snooze invocation needs an idempotency key")
			return
		}
		if !canonicalActionIntentKey(req.IdempotencyKey) {
			writeOpsAuthErr(w, http.StatusBadRequest,
				"invalid_idempotency_key",
				"idempotency key must be a canonical non-zero UUID")
			return
		}
		reason, reasonOK := validSnoozeReason(req.Reason)
		if !reasonOK {
			writeOpsAuthErr(w, http.StatusUnprocessableEntity,
				"invalid_reason", "reason must be 1 to 4096 characters and contain only text controls")
			return
		}
		d, err := parseSnoozeDuration(req.Duration)
		if err != nil || d <= 0 {
			writeOpsAuthErr(w, http.StatusUnprocessableEntity,
				"bad_duration", `duration must be positive, e.g. "36h" or "5d"`)
			return
		}
		if c.Severity == SevCritical && d > criticalSnoozeCap {
			writeOpsAuthErr(w, http.StatusUnprocessableEntity,
				"critical_snooze_capped", "critical checks cannot be snoozed for more than 7 days")
			return
		}

		op, operatorOK := OperatorFromContext(r.Context())
		operatorEmail := strings.TrimSpace(op.Email)
		if !operatorOK || operatorEmail == "" {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"operator_missing", "snooze endpoint reached without an authenticated operator")
			return
		}
		if store == nil || store.pool == nil {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"snooze_unavailable", "snooze storage is unavailable")
			return
		}

		intent := snoozeIntent{DurationNS: int64(d), Reason: reason}
		intentJSON, err := json.Marshal(intent)
		if err != nil {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"snooze_intent_failed", "could not record the snooze intent")
			return
		}

		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), actionLifecycleTimeout)
		defer cancel()

		var runID string
		var startedAt time.Time
		err = store.pool.QueryRow(ctx, `
			INSERT INTO ops_action_runs
			       (check_id, action_id, idempotency_key, operator_email, input, status)
			VALUES ($1, $2, $3, $4, $5::jsonb, 'running')
			RETURNING id, started_at`,
			checkID, snoozeActionID, req.IdempotencyKey, operatorEmail, string(intentJSON)).
			Scan(&runID, &startedAt)
		if isIdempotencyConflict(err) {
			replaySnooze(ctx, w, store.pool, req.IdempotencyKey, checkID, operatorEmail, string(intentJSON))
			return
		}
		if err != nil {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"snooze_intent_failed", "could not record the snooze intent")
			return
		}

		// The expiry is anchored to the durable row's database timestamp, not
		// whichever wall clock happens to serve a later retry.
		until := startedAt.UTC().Add(d)
		intentFields := map[string]any{
			"check_id": checkID, "until": until.Format(time.RFC3339),
			"duration": d.String(), "reason": reason, "actor": operatorEmail,
			"run_id": runID, "idempotency_key": req.IdempotencyKey,
		}
		if audit == nil || audit(ctx, "ops.check.snooze.intent", intentFields) != nil {
			_ = finishActionRun(ctx, store.pool, runID, "failed",
				"refused to snooze: operator audit is unavailable")
			writeOpsAuthErr(w, http.StatusServiceUnavailable,
				"audit_unavailable", "refusing to apply an unauditable snooze")
			return
		}
		if err := store.Snooze(ctx, checkID, until, reason); err != nil {
			_ = finishActionRun(ctx, store.pool, runID, "failed", "could not persist the snooze")
			if errors.Is(err, ErrSnoozeReasonRequired) {
				writeOpsAuthErr(w, http.StatusUnprocessableEntity,
					"reason_required", "a snooze without a reason is a mute button; say why")
				return
			}
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"snooze_failed", "could not persist the snooze")
			return
		}

		result := until.Format(time.RFC3339Nano)
		if err := finishActionRun(ctx, store.pool, runID, "succeeded", result); err != nil {
			slog.Error("ops: could not finish snooze run", "run_id", runID, "err", err)
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"snooze_outcome_persist_failed",
				"the snooze may have applied, but its outcome could not be recorded; retry with the same idempotency key")
			return
		}

		if err := audit(ctx, "ops.check.snoozed", map[string]any{
			"check_id":        checkID,
			"until":           until.Format(time.RFC3339),
			"duration":        d.String(),
			"reason":          reason,
			"actor":           operatorEmail,
			"run_id":          runID,
			"idempotency_key": req.IdempotencyKey,
		}); err != nil {
			slog.Error("ops: snooze audit write failed", "check_id", checkID, "err", err)
		}

		writeActionJSON(w, snoozeResponse{
			RunID: runID, Status: "succeeded", Result: result,
			SnoozedUntil: &until, Replayed: false,
		})
	}
}

// replaySnooze is deliberately read-only. In particular, a row that remains
// running after a crash is returned as running and left for the fail-loud
// reconciliation check; the server never guesses whether an ambiguous
// external action is safe to repeat.
func replaySnooze(ctx context.Context, w http.ResponseWriter, pool *pgxpool.Pool, key, checkID, operatorEmail, intentJSON string) {
	var resp snoozeResponse
	var storedCheckID, storedActionID, storedOperatorEmail string
	var payloadMatches bool
	err := pool.QueryRow(ctx, `
		SELECT id, status, result, check_id, action_id, operator_email,
		       input = $2::jsonb
		  FROM ops_action_runs
		 WHERE idempotency_key = $1`, key, intentJSON).
		Scan(&resp.RunID, &resp.Status, &resp.Result, &storedCheckID,
			&storedActionID, &storedOperatorEmail, &payloadMatches)
	if err != nil {
		writeOpsAuthErr(w, http.StatusInternalServerError,
			"replay_lookup_failed", "could not load the prior snooze for this idempotency key")
		return
	}
	if storedCheckID != checkID || storedActionID != snoozeActionID ||
		storedOperatorEmail != operatorEmail || !payloadMatches {
		writeOpsAuthErr(w, http.StatusConflict,
			"idempotency_conflict", "idempotency key is already bound to a different operator action payload")
		return
	}
	if resp.Status == "succeeded" {
		until, err := time.Parse(time.RFC3339Nano, resp.Result)
		if err != nil {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"replay_corrupt", "the prior snooze outcome is not readable")
			return
		}
		resp.SnoozedUntil = &until
	}
	resp.Result = boundActionResult(resp.Result)
	resp.Replayed = true
	writeActionJSON(w, resp)
}

// parseSnoozeDuration accepts Go durations ("36h") plus a day suffix ("5d"),
// because operators think in days and time.ParseDuration refuses them.
func parseSnoozeDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if n, found := strings.CutSuffix(s, "d"); found {
		days, err := strconv.ParseInt(n, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("bad day count %q", s)
		}
		if days > math.MaxInt64/int64(24*time.Hour) {
			return 0, fmt.Errorf("day count %q overflows duration", s)
		}
		return time.Duration(days) * 24 * time.Hour, nil
	}
	return time.ParseDuration(s)
}

func canonicalActionIntentKey(value string) bool {
	if value == "" || value != strings.TrimSpace(value) {
		return false
	}
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.String() == value
}

func decodeActionJSON(r *http.Request, dst any) error {
	raw, err := httpbody.DecodeJSONBytes(r, maxActionRequestBodyBytes, dst, httpbody.Options{})
	if err != nil {
		return err
	}
	if !utf8.Valid(raw) {
		return errors.New("request body is not valid UTF-8 JSON")
	}
	return nil
}

func validActionInput(value string) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxActionInputRunes || len(value) > maxActionInputBytes {
		return false
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

func validSnoozeReason(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) ||
		utf8.RuneCountInString(value) > maxSnoozeReasonRunes || len(value) > maxSnoozeReasonBytes {
		return value, false
	}
	for _, char := range value {
		if unicode.IsControl(char) && char != '\t' && char != '\n' && char != '\r' {
			return value, false
		}
	}
	return value, true
}

func boundActionResult(value string) string {
	value = strings.TrimSpace(strings.ToValidUTF8(value, "�"))
	if len(value) <= maxActionResultBytes {
		return value
	}
	const suffix = "…"
	limit := maxActionResultBytes - len(suffix)
	end := 0
	for offset := range value {
		if offset > limit {
			break
		}
		end = offset
	}
	if end == 0 {
		return suffix
	}
	return strings.TrimSpace(value[:end]) + suffix
}
