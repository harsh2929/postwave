package zerocopy_triggers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/leader"
)

// FlowRunEnqueuer is the worker's seam onto the journey runtime.
// In production it's flowbuilder.Repo (which inserts into flow_runs).
// Tests pass an in-memory fake.
//
// The worker calls EnqueueRun once per resolved warehouse row.
// trigger_event_name carries "zerocopy:<trigger_name>" so flow_runs
// rows stay legible in ops queries without joining back here.
type FlowRunEnqueuer interface {
	EnqueueRun(ctx context.Context, tenantID string, req EnqueueRequest) (string, error)
}

// EnqueueRequest mirrors flowbuilder.RunEnqueueRequest, but lives in
// this package so we don't take a direct dep on flowbuilder (which
// avoids an import cycle with the worker registration site).
type EnqueueRequest struct {
	FlowID           string
	SubscriberID     string
	TriggerEventName string
	ScheduledAt      time.Time
}

// Worker drains active zero-copy triggers on a ticker.
//
// LEASING IS PROVIDED HERE, not required from the caller. This comment used to
// say the worker "is not safe to run in a multi-replica production process
// until the caller provides distributed ownership/lease semantics" — which was
// true when written and stopped being true eleven lines into runOnce, where
// every tick is wrapped in `leader.Run` (a Postgres session advisory lock held
// for the tick and released with the connection, so a crashed instance frees it
// rather than wedging the worker). The gate's own prerequisite list was updated
// when that landed; this comment was not, and a stale precondition is worse
// than none: it tells the next reader to go build something that already
// exists.
//
// The worker is still never started. `executionEnabled` defaults off and the
// outstanding prerequisite is `release_certification` — credential-provider
// certification and live warehouse suites, per MIGRATION.md. That is a release
// decision, not missing code, and it is not made stale by the code compiling.
type Worker struct {
	Repo      *Repo
	Enqueuer  FlowRunEnqueuer
	Logger    *slog.Logger
	Interval  time.Duration
	BatchSize int
	Now       func() time.Time

	// Firewall (feature #2) gates each fire's ProfileKey on per-purpose
	// consent (PurposeProfiling) + suppression before EnqueueRun, writing
	// run_type='zerocopy_trigger' receipts. Production shares this gate
	// with the manual Poll-now HTTP path.
	Firewall       *activation_firewall.Filter
	ReceiptStore   activation_firewall.Store
	ReceiptSignKey string

	// DLQ, when set, makes each tick also reconcile the dead-letter queue:
	// re-resolve + re-enqueue rows that previously failed (matched_no_subscriber
	// / enqueue_failed). Nil = no reconciliation (the historical behaviour).
	DLQ               *DLQRepo
	DLQMinRetryGap    time.Duration // default 5m
	DLQReconcileLimit int           // default 50
	DLQMaxRetries     int           // default 5
}

// Run starts the worker loop. It performs one immediate tick so newly
// activated triggers do not sit idle until the first interval elapses.
func (w *Worker) Run(ctx context.Context) {
	if !zeroCopyRuntimeQualified() {
		w.log().Warn("zerocopy_triggers: worker disabled; runtime is not release-qualified")
		return
	}
	if w == nil || w.Repo == nil {
		return
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	w.runOnce(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.runOnce(ctx)
		}
	}
}

func (w *Worker) runOnce(ctx context.Context) {
	if !zeroCopyRuntimeQualified() {
		w.log().Warn("zerocopy_triggers: tick blocked; runtime is not release-qualified")
		return
	}
	// Single-flight across replicas. The per-row receipt already makes
	// CORRECTNESS independent of how many instances poll, but every extra
	// replica still issues the warehouse query — and on Snowflake or BigQuery
	// that is billed per scan, so N replicas is an N× warehouse bill for one
	// tenant's data. The advisory lock is held for the tick and released with
	// the connection, so a crashed instance frees it rather than wedging the
	// worker.
	if w.Repo != nil && w.Repo.Pool != nil {
		ran, err := leader.Run(ctx, w.Repo.Pool, "zerocopy-triggers", w.tick)
		if err != nil {
			w.log().Warn("zerocopy_triggers: leader_run_failed", "err", err.Error())
		}
		_ = ran // a lost election is the normal path on every replica but one
		return
	}
	w.tick(ctx) //nolint:errcheck // tick never returns an error
}

// tick is one poll pass. Split from runOnce so the leader wrapper has a unit of
// work to hand the lock, and so tests can drive a pass without a database.
func (w *Worker) tick(ctx context.Context) error {
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now().UTC()
	}
	limit := w.BatchSize
	if limit <= 0 {
		limit = 50
	}
	triggers, err := w.Repo.ListDue(ctx, now, limit)
	if err != nil {
		w.log().Warn("zerocopy_triggers: list_due_failed", "err", err.Error())
		return nil
	}
	gate := w.ConsentGate()
	for i := range triggers {
		t := triggers[i]
		if _, err := PollOnce(ctx, w.Repo, w.Enqueuer, t.TenantID, &t, now, gate); err != nil {
			w.log().Warn("zerocopy_triggers: poll_failed",
				"tenant_id", t.TenantID,
				"trigger_id", t.ID,
				"provider", t.Provider,
				"err", err.Error())
		}
	}

	// Reconcile the dead-letter queue: replay rows that previously failed to
	// resolve / enqueue. Same tick cadence; bounded per pass.
	if w.DLQ != nil {
		gap := w.DLQMinRetryGap
		if gap <= 0 {
			gap = 5 * time.Minute
		}
		dlqLimit := w.DLQReconcileLimit
		if dlqLimit <= 0 {
			dlqLimit = 50
		}
		if n, err := ReconcileDLQ(ctx, w.DLQ, w.Repo, w.Enqueuer, gap, dlqLimit, w.DLQMaxRetries); err != nil {
			w.log().Warn("zerocopy_triggers: dlq_reconcile_failed", "err", err.Error())
		} else if n > 0 {
			w.log().Info("zerocopy_triggers: dlq_reconciled", "touched", n)
		}
	}
	return nil
}

// ConsentGate is the activation-firewall hook. Given the
// fired profile keys it returns the set of keys allowed to proceed
// (lowercased) and the exclusion records for the withheld ones.
type ConsentGate func(ctx context.Context, tenantID, triggerID string, profileKeys []string) (kept map[string]bool, excluded []activation_firewall.ExclusionRecord)

// ConsentGate builds the firewall-backed gate shared by background and
// synchronous poll paths. It returns nil only for incomplete/test wiring;
// production always supplies a concrete activation firewall.
func (w *Worker) ConsentGate() ConsentGate {
	if w == nil || w.Firewall == nil {
		return nil
	}
	return func(ctx context.Context, tenantID, triggerID string, profileKeys []string) (map[string]bool, []activation_firewall.ExclusionRecord) {
		dec := w.Firewall.Decide(ctx, tenantID, consent.PurposeProfiling, "zerocopy", profileKeys)
		kept := make(map[string]bool, len(dec.Kept))
		for _, e := range dec.Kept {
			kept[e] = true
		}
		if len(dec.Excluded) > 0 && w.ReceiptStore != nil {
			runID := fmt.Sprintf("zc:%s:%d", triggerID, time.Now().UnixNano())
			if _, err := w.ReceiptStore.WriteExclusions(ctx, tenantID, runID, activation_firewall.RunTypeZerocopyTrigger, dec.Excluded, w.ReceiptSignKey); err != nil {
				w.log().Warn("zerocopy_triggers: failed to persist exclusion receipts",
					"tenant_id", tenantID, "trigger_id", triggerID, "err", err.Error())
			}
		}
		return kept, dec.Excluded
	}
}

func (w *Worker) log() *slog.Logger {
	if w != nil && w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

// PollOnce runs a single tick against one trigger. It is exposed as
// a package-level function (vs a method) so the HTTP handler can call
// it for the "Poll now" button without spinning up the loop.
//
// Contract:
//   - Resolves the driver from t.Provider.
//   - Calls driver.Poll(ctx, t, t.MaxRowsPerTick).
//   - For each row: resolves subscriber, enqueues flow_run (if journey
//     is set + subscriber resolved), records a fire row.
//   - Updates the trigger's last_polled_at + last_seen_cursor.
//
// Returns the per-row fires created (in the same order driver
// returned), or an error if the driver itself failed.
func PollOnce(
	ctx context.Context,
	repo *Repo,
	enq FlowRunEnqueuer,
	tenantID string,
	t *Trigger,
	now time.Time,
	gates ...ConsentGate,
) ([]Fire, error) {
	if !zeroCopyRuntimeQualified() {
		return nil, ErrZeroCopyRuntimeUnavailable
	}
	return pollOnceQualified(ctx, repo, enq, tenantID, t, now, gates...)
}

// pollOnceQualified contains the legacy polling algorithm for focused tests
// and future certification work. Production callers must use PollOnce, whose
// static release gate prevents warehouse I/O and cursor mutation.
func pollOnceQualified(
	ctx context.Context,
	repo *Repo,
	enq FlowRunEnqueuer,
	tenantID string,
	t *Trigger,
	now time.Time,
	gates ...ConsentGate,
) ([]Fire, error) {
	if repo == nil || t == nil {
		return nil, errors.New("zerocopy_triggers: nil repo or trigger")
	}
	if t.Status != "active" && t.Status != "draft" {
		// Paused / errored triggers don't get polled. Drafts are
		// allowed for the "Poll now" hand-test affordance.
		return nil, nil
	}
	var gate ConsentGate
	if len(gates) > 0 {
		gate = gates[0]
	}
	// Any path capable of enqueueing a journey requires both the durable
	// enqueuer seam and the consent firewall. Failing before the warehouse poll
	// prevents an incomplete composition from advancing its cursor or looking
	// like a successful log-only run.
	if strings.TrimSpace(t.JourneyID) != "" {
		if enq == nil {
			return nil, errors.New("zerocopy_triggers: journey execution requires an enqueuer")
		}
		if gate == nil {
			return nil, errors.New("zerocopy_triggers: journey execution requires a consent gate")
		}
	}
	driver := resolveDriver(t.Provider)
	rows, err := driver.Poll(ctx, *t, t.MaxRowsPerTick)
	if err != nil {
		// Best-effort RecordTick — but still surface the original
		// error so the HTTP handler / worker logs see it.
		_ = repo.RecordTick(ctx, tenantID, t.ID, "", 0, truncateError(err), now)
		return nil, fmt.Errorf("driver poll failed: %w", err)
	}
	// Consent-safe activation firewall: decide which profile keys may proceed
	// before any flow_run is enqueued. Fail-DENY semantics live inside the gate.
	var consentKept map[string]bool
	// Keys the firewall actually ruled on. NOT the same as the keys we sent:
	// activation_firewall.normalizeEmails drops blank and duplicate keys before
	// Decide partitions anything, so a row whose profile-key cell is empty
	// appears in neither Kept nor Excluded. Reading absence as "withheld" made
	// such a row settle its cursor with no receipt of any kind — the same
	// silent drop, arrived at from a different direction. It falls through to
	// the normal path instead, where it earns a `matched_no_subscriber`
	// receipt.
	var consentEvaluated map[string]bool
	if gate != nil {
		keys := make([]string, 0, len(rows))
		for _, row := range rows {
			keys = append(keys, row.ProfileKey)
		}
		var excluded []activation_firewall.ExclusionRecord
		consentKept, excluded = gate(ctx, tenantID, t.ID, keys)
		consentEvaluated = make(map[string]bool, len(consentKept)+len(excluded))
		for k := range consentKept {
			consentEvaluated[k] = true
		}
		for _, e := range excluded {
			consentEvaluated[strings.ToLower(strings.TrimSpace(e.SubscriberEmail))] = true
		}
	}
	fires := make([]Fire, 0, len(rows))
	// The cursor is a WATERMARK over the longest settled prefix of cursor
	// VALUE GROUPS — not a running max over rows, and not a per-row prefix.
	//
	// Two earlier versions of this were wrong in the same direction. Taking the
	// running max advanced past rows that had not finished. Taking a per-ROW
	// prefix still did, whenever two rows shared a cursor value: settling the
	// first published that value, and the second row's failure could not take
	// it back, so `WHERE <cursor> > :last_seen_cursor` never returned it again.
	// Ties are not exotic — the default cursor column is `updated_at`, and the
	// receipt's own unique key is (cursor_value, profile_key) precisely because
	// cursor_value does not identify a row.
	//
	// So the unit of advance is the GROUP: a cursor value may be published only
	// once every row carrying it has settled, and only if every earlier group
	// did too. Outcomes are recorded per row here and the watermark is computed
	// from them afterwards, because deciding it inline is what hid the tie.
	settled := make([]bool, len(rows))
	// String compare, correct for both ISO-8601 timestamps and zero-padded
	// monotonic ids — the two shapes operators are expected to use.
	settle := func(i int) { settled[i] = true }
	for i, row := range rows {
		fire := Fire{
			TriggerID:   t.ID,
			CursorValue: row.CursorValue,
			ProfileKey:  row.ProfileKey,
			Payload:     row.Payload,
			FiredAt:     now,
			Status:      "fired",
		}
		// Consent-safe activation firewall (feature #2): a profile the
		// firewall withheld is never enqueued. It IS settled — the signed
		// exclusion receipt written by the gate is the authoritative audit
		// trail — so the cursor advances past it and we do not re-poll. We do
		// NOT write a fire row here: the status CHECK has no "excluded" value,
		// and the firewall's own receipt table records the exclusion.
		normalizedKey := strings.ToLower(strings.TrimSpace(row.ProfileKey))
		if consentEvaluated[normalizedKey] && !consentKept[normalizedKey] {
			settle(i)
			continue
		}
		// Durably CLAIM the row before anything irreversible happens to it.
		//
		// The claim is a database uniqueness constraint rather than a check
		// here, because two replicas polling one trigger would both pass a
		// read-then-write before either INSERTed.
		receiptID, outcome, cerr := repo.ClaimFire(ctx, tenantID, t.ID, row.CursorValue, row.ProfileKey, DefaultFireClaimLease)
		if cerr != nil {
			// The watermark stays closed: a row we could not even claim has no
			// receipt, so advancing past it would lose it with no evidence
			// anywhere. The next tick re-reads it.
			fire.Status = "error"
			fire.Error = truncateError(cerr)
			fires = append(fires, fire)
			continue
		}
		switch outcome {
		case ClaimSettled:
			// Already terminal. Nothing to do, and safe to pass.
			settle(i)
			continue
		case ClaimHeld:
			// Another poller owns it and has not finished. Not ours to touch,
			// and NOT safe to pass — it may still fail and need re-reading.
			continue
		case ClaimIndeterminate:
			// A stale `enqueueing` row: it reached EnqueueRun and we cannot
			// tell whether the run was created, because flow_runs has no
			// idempotency key. Retrying risks a duplicate enrolment, dropping
			// it risks a lost one, and neither is ours to choose silently.
			// Terminate it with the marker and let the cursor pass, so one
			// unknowable row cannot wedge the trigger forever — it is queryable
			// via ListIndeterminate and logged here.
			if merr := repo.MarkIndeterminate(ctx, tenantID, receiptID); merr != nil {
				slog.Warn("zerocopy_triggers: mark_indeterminate_failed",
					"tenant_id", tenantID, "trigger_id", t.ID, "err", merr.Error())
				continue
			}
			slog.Warn("zerocopy_triggers: indeterminate_enqueue",
				"tenant_id", tenantID, "trigger_id", t.ID,
				"receipt_id", receiptID,
				"note", "a poller stopped between EnqueueRun and its receipt; check the journey before retrying")
			fire.Status = "error"
			fire.Error = IndeterminateFireError
			fires = append(fires, fire)
			settle(i)
			continue
		}

		// Resolve subscriber for the row.
		subscriberID, rerr := repo.ResolveSubscriberID(ctx, tenantID, row.ProfileKey)
		if rerr != nil {
			fire.Status = "error"
			fire.Error = truncateError(rerr)
			if finishFireSafely(ctx, repo, tenantID, receiptID, &fire) {
				settle(i)
			}
			fires = append(fires, fire)
			continue
		}
		fire.SubscriberID = subscriberID
		switch {
		case strings.TrimSpace(t.JourneyID) == "":
			fire.Status = "skipped_log_only"
		case subscriberID == "":
			fire.Status = "matched_no_subscriber"
		default:
			if enq == nil {
				// Log-only fallback when the worker is constructed
				// without an enqueuer (e.g. early-boot or test).
				fire.Status = "skipped_log_only"
			} else {
				// Record the INTENT before acting on it. Without this write a
				// poller that stops after EnqueueRun leaves a receipt
				// indistinguishable from one that stopped before it, and lease
				// expiry has to guess between a duplicate enrolment and a lost
				// one. `claimed` now provably means "never reached EnqueueRun".
				if merr := repo.MarkEnqueueing(ctx, tenantID, receiptID); merr != nil {
					// Do not enqueue behind a receipt we could not advance: on
					// a crash that row would read as `claimed` and be retried,
					// which is the duplicate. MarkEnqueueing returns an error
					// when it matched NO row, so a claim lost to lease expiry
					// stops here too.
					fire.Status = "error"
					fire.Error = truncateError(merr)
					fires = append(fires, fire)
					continue
				}
				runID, eerr := enq.EnqueueRun(ctx, tenantID, EnqueueRequest{
					FlowID:           t.JourneyID,
					SubscriberID:     subscriberID,
					TriggerEventName: "zerocopy:" + t.Name,
					ScheduledAt:      now,
				})
				if eerr != nil {
					fire.Status = "error"
					fire.Error = truncateError(eerr)
				} else {
					fire.FlowRunID = runID
					fire.Status = "fired"
				}
			}
		}
		if finishFireSafely(ctx, repo, tenantID, receiptID, &fire) {
			settle(i)
		}
		// Otherwise the receipt is still `claimed` or `enqueueing`. Passing it
		// would strand it: no later tick would re-read it, and the lease could
		// never fire because the cursor had moved on.
		fires = append(fires, fire)
	}
	firedCount := 0
	for _, f := range fires {
		if f.Status == "fired" {
			firedCount++
		}
	}
	maxCursor := settledWatermark(rows, settled, t.LastSeenCursor, len(rows) >= driverRowLimit(t))
	if err := repo.RecordTick(ctx, tenantID, t.ID, maxCursor, firedCount, "", now); err != nil {
		// Tick metadata update failed — log but don't drop the
		// already-recorded fires. The next tick will catch up.
		slog.Warn("zerocopy_triggers: record_tick_failed",
			"trigger_id", t.ID, "tenant_id", tenantID, "err", err.Error())
	}
	return fires, nil
}

// recordFireSafely persists a fire row, swallowing the error after
// logging it. We don't want a single ledger insert failure to break
// the rest of the tick — fires are operational, not transactional.
// finishFireSafely closes out a claimed receipt and reports whether it reached
// a terminal state. The caller uses that to decide whether the cursor may
// advance past the row: a receipt still `claimed` or `enqueueing` must be
// re-read, and a cursor that has moved on makes that impossible.
func finishFireSafely(ctx context.Context, repo *Repo, tenantID string, receiptID int64, f *Fire) bool {
	f.ID = receiptID
	if err := repo.FinishFire(ctx, tenantID, receiptID, *f); err != nil {
		slog.Warn("zerocopy_triggers: finish_fire_failed",
			"trigger_id", f.TriggerID, "tenant_id", tenantID,
			"receipt_id", receiptID, "err", err.Error(), "status", f.Status)
		return false
	}
	return true
}

// settledWatermark computes the cursor a tick may persist.
//
// The unit is the cursor VALUE GROUP, not the row. Drivers resume with
// `WHERE <cursor> > :last_seen_cursor`, so publishing a value declares every
// row carrying it to be finished. A per-row prefix did not: with two rows
// sharing a value, settling the first published it, and nothing the second row
// did afterwards could take it back — the sibling was never returned again,
// with no receipt, no DLQ entry and no log line. That is the silent drop this
// mechanism exists to prevent, and ties are the ordinary case: the default
// cursor column is `updated_at`, and the receipt's own unique key is
// (cursor_value, profile_key) precisely because cursor_value does not identify
// a row.
//
// Rules, in order:
//   - out-of-order rows advance nothing. "Longest settled prefix" is not a
//     resumable position when the sequence is not sorted, and operators own the
//     query, so this is not something to assume.
//   - a group publishes only if every row in it settled AND every earlier group
//     published.
//   - when the batch filled the driver's row limit, the LAST group may be
//     truncated mid-value — rows sharing its cursor could be waiting on the
//     other side of the LIMIT. Publishing it would skip them on the healthy
//     path, with no crash and no concurrency involved. So the final group is
//     withheld; the next tick re-reads it and completes it.
func settledWatermark(rows []DriverRow, settled []bool, current string, truncated bool) string {
	if len(rows) == 0 {
		return current
	}
	for i := 1; i < len(rows); i++ {
		if rows[i].CursorValue < rows[i-1].CursorValue {
			return current
		}
	}
	watermark := current
	groupStart := 0
	for i := 0; i <= len(rows); i++ {
		if i < len(rows) && rows[i].CursorValue == rows[groupStart].CursorValue {
			continue
		}
		// rows[groupStart:i] is one complete cursor-value group.
		lastGroup := i == len(rows)
		if lastGroup && truncated {
			break
		}
		whole := true
		for j := groupStart; j < i; j++ {
			if !settled[j] {
				whole = false
				break
			}
		}
		if !whole {
			break
		}
		if rows[groupStart].CursorValue > watermark {
			watermark = rows[groupStart].CursorValue
		}
		groupStart = i
	}
	return watermark
}

// driverRowLimit mirrors the bound the driver was asked to honour, so a batch
// that came back full can be recognised as possibly truncated.
func driverRowLimit(t *Trigger) int {
	if t != nil && t.MaxRowsPerTick > 0 {
		return t.MaxRowsPerTick
	}
	return defaultMaxRowsPerTick
}

func recordFireSafely(ctx context.Context, repo *Repo, tenantID string, f *Fire) {
	id, err := repo.RecordFire(ctx, tenantID, *f)
	if err != nil {
		slog.Warn("zerocopy_triggers: record_fire_failed",
			"trigger_id", f.TriggerID, "tenant_id", tenantID,
			"err", err.Error(), "status", f.Status)
		return
	}
	f.ID = id
}

// truncateError keeps last_error / fire.error rows from blowing up
// when a driver returns a 4KB stack trace.
func truncateError(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if len(s) > 1024 {
		s = s[:1024]
	}
	return s
}
