package flowbuilder

// drainer.go — the missing consumer for the flow_runs queue.
//
// flow_runs had THREE producers and NO consumer:
//
//	apps/api/internal/track/handlers.go        (fanoutFlowRuns)
//	apps/api/main.go                           (tagsFlowTriggerAdapter)
//	apps/api/internal/zerocopy_triggers/worker (FlowRunEnqueuer)
//
// `grep -rn "flow_runs" services/ packages/` returned nothing. The only reader
// was Repo.ListRecentRuns — a UI list endpoint. Rows were inserted at
// status='queued' and stayed there forever.
//
// The consequence was that `tag_added` / `tag_removed` / `list_joined` and every
// zero-copy warehouse trigger NEVER EXECUTED. "Start a flow when this tag is
// applied" and "send a welcome email when someone joins this list" were inert —
// while runs.go's own doc comment asserted that "the automation service drains
// the queue".
//
// It does now.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/automationclient"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// LegacyFlowRunsDrainerQualified is a compile-time release gate. The legacy
// drainer uses a raw cross-tenant pool against FORCE-RLS tables and has no
// certified worker authority/lease/recovery contract, so runtime configuration
// alone must never be able to arm it.
const LegacyFlowRunsDrainerQualified = flowRuntimeQualified

var ErrFlowRuntimeUnavailable = errors.New("flowbuilder: flow runtime is unavailable")

// RunTriggerType maps the event name a producer stored on the flow_runs row to
// the trigger type the automation runtime actually matches on.
//
// These disagree. The tag producer writes "tag.added" (TagTriggerEventName,
// dotted), while the flow-builder catalog and canonical both use "tag_added"
// (underscored). Forwarding the stored name verbatim would be rejected by
// Engine.Trigger as a non-match — a silent no-op replacing a silent no-op.
func RunTriggerType(storedEventName string) string {
	s := strings.TrimSpace(storedEventName)
	if s == "" {
		return ""
	}
	// Producers use dots; the runtime uses underscores.
	return strings.ReplaceAll(s, ".", "_")
}

// runIsAlreadyDispatched reports whether a queued run has ALREADY been fired by
// another path, and must therefore be retired rather than re-fired.
//
// track/handlers.go dispatches product events inline over HTTP on the ingest
// path (`go d.fanout(...)`) AND writes a flow_runs row (`go d.fanoutFlowRuns`).
// That duplicate bookkeeping was harmless only because the queue was never
// drained. Now that it is, firing those rows again would run every product-event
// flow TWICE — and for a flow with re_enrollment='always', that is two sends per
// event.
//
// We keep track's inline path (it is the proven one) and retire its rows here,
// so the queue stays the single source of truth for the triggers that have no
// other dispatcher.
func runIsAlreadyDispatched(triggerType string) bool {
	return triggerType == "product_event"
}

// claimedRun is one row the drainer has taken ownership of.
type claimedRun struct {
	ID              string
	TenantID        string
	FlowID          string
	SubscriberEmail string
	TriggerType     string
	TriggerPayload  map[string]any
}

// RunFailureNotifier fans a terminal flow-run failure to the tenant's
// operators through the unified notification fanout (notifyfanout). nil
// disables the channel; implementations must tolerate concurrent calls.
type RunFailureNotifier interface {
	NotifyRunFailed(ctx context.Context, tenantID, runID, flowID, triggerType, errMsg string)
}

// Drainer claims queued flow_runs and fires them at the automation service.
type Drainer struct {
	Pool                 *db.Pool
	AutomationServiceURL string
	InternalAPIToken     string
	HTTPClient           *http.Client
	Logger               *slog.Logger
	// BatchSize caps rows claimed per tick.
	BatchSize int
	// Notify, when set, reports each terminal run failure so operators hear
	// "automation.failed" on every registered device instead of finding out
	// from a silent queue.
	Notify RunFailureNotifier
}

func (d *Drainer) log() *slog.Logger {
	if d != nil && d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

func (d *Drainer) client() *http.Client {
	if d.HTTPClient != nil {
		return d.HTTPClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (d *Drainer) batch() int {
	if d.BatchSize > 0 {
		return d.BatchSize
	}
	return 100
}

// Drain is compile-time contained. FOR UPDATE SKIP LOCKED alone does not grant
// cross-tenant FORCE-RLS authority and cannot make an unauthenticated provider
// call crash-safe.
func (d *Drainer) Drain(ctx context.Context) (int, error) {
	if !LegacyFlowRunsDrainerQualified {
		return 0, ErrFlowRuntimeUnavailable
	}
	if d == nil || d.Pool == nil || d.AutomationServiceURL == "" {
		return 0, nil
	}
	runs, err := d.claim(ctx)
	if err != nil {
		return 0, err
	}
	dispatched := 0
	for _, run := range runs {
		if runIsAlreadyDispatched(run.TriggerType) {
			// Retire without firing — track already dispatched it inline.
			d.finish(ctx, run.ID, run.TenantID, "completed", "")
			continue
		}
		if err := d.fire(ctx, run); err != nil {
			d.log().Warn("flow_runs: dispatch failed",
				"run", run.ID, "flow", run.FlowID, "trigger", run.TriggerType, "err", err.Error())
			d.finish(ctx, run.ID, run.TenantID, "failed", err.Error())
			if d.Notify != nil {
				d.Notify.NotifyRunFailed(ctx, run.TenantID, run.ID, run.FlowID, run.TriggerType, err.Error())
			}
			continue
		}
		d.finish(ctx, run.ID, run.TenantID, "completed", "")
		dispatched++
	}
	return dispatched, nil
}

// claim atomically takes ownership of up to BatchSize queued runs, flipping
// them to 'running' so a second drainer cannot pick them up.
func (d *Drainer) claim(ctx context.Context) ([]claimedRun, error) {
	// The drainer is tenant-agnostic (it services every tenant), so it runs
	// outside the per-tenant RLS GUC and filters explicitly by the row's own
	// tenant_id when it writes back.
	rows, err := d.Pool.Query(ctx, `
UPDATE flow_runs r
   SET status = 'running', started_at = now()
 WHERE r.id IN (
   SELECT id FROM flow_runs
    WHERE status = 'queued' AND scheduled_at <= now()
    ORDER BY scheduled_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
 )
RETURNING r.id::text, r.tenant_id::text, r.flow_id::text,
          (SELECT s.email::text FROM subscribers s WHERE s.id = r.subscriber_id),
          COALESCE(r.trigger_event_name, ''),
          COALESCE(r.trigger_payload, '{}'::jsonb)`, d.batch())
	if err != nil {
		return nil, fmt.Errorf("flow_runs: claim: %w", err)
	}
	defer rows.Close()

	var out []claimedRun
	for rows.Next() {
		var (
			run     claimedRun
			email   *string
			evName  string
			rawJSON []byte
		)
		if err := rows.Scan(&run.ID, &run.TenantID, &run.FlowID, &email, &evName, &rawJSON); err != nil {
			return nil, err
		}
		if email != nil {
			run.SubscriberEmail = *email
		}
		run.TriggerType = RunTriggerType(evName)
		run.TriggerPayload = map[string]any{}
		if len(rawJSON) > 0 {
			_ = json.Unmarshal(rawJSON, &run.TriggerPayload)
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

// fire POSTs the run at the automation service's trigger endpoint.
func (d *Drainer) fire(ctx context.Context, run claimedRun) error {
	if strings.TrimSpace(d.InternalAPIToken) == "" {
		return errors.New("flow_runs: internal API bearer is not configured")
	}
	if run.SubscriberEmail == "" {
		// The subscriber was deleted between enqueue and drain. Nothing to do,
		// and re-queueing would never succeed.
		return fmt.Errorf("subscriber no longer exists")
	}
	if run.TriggerType == "" {
		return fmt.Errorf("run has no trigger event name")
	}

	body, err := json.Marshal(map[string]any{
		"automation_id":    run.FlowID,
		"trigger_type":     run.TriggerType,
		"subscriber_email": run.SubscriberEmail,
		"payload":          run.TriggerPayload,
	})
	if err != nil {
		return err
	}
	url, err := automationclient.TriggerURL(d.AutomationServiceURL)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tenant-Id", run.TenantID)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(d.InternalAPIToken))

	resp, err := d.client().Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("automation service returned %d", resp.StatusCode)
	}
	return nil
}

// finish stamps the terminal state on a claimed row.
func (d *Drainer) finish(ctx context.Context, runID, tenantID, status, errMsg string) {
	var errArg any
	if errMsg != "" {
		errArg = errMsg
	}
	if _, err := d.Pool.Exec(ctx, `
UPDATE flow_runs
   SET status = $3, finished_at = now(), error = $4
 WHERE id = $1::uuid AND tenant_id = $2::uuid`, runID, tenantID, status, errArg); err != nil {
		d.log().Warn("flow_runs: finish failed", "run", runID, "err", err.Error())
	}
}

// Requeue returns runs stuck in 'running' (a drainer died mid-flight) to
// 'queued' so another replica can pick them up. Without this a crash would
// strand the run in exactly the way the missing consumer stranded all of them.
// Requeue is a BLIND time-based sweep, and naming that is the point.
//
// It flips any `running` row older than the window back to `queued`. It cannot
// distinguish a run that never reached `fire()` from one whose POST already
// returned 202 and whose `finish()` write was lost — so a drainer that dies in
// that gap re-executes the flow on the next sweep. For a flow with
// `re_enrollment='always'` that is a duplicate enrolment and duplicate SENDS.
//
// The re-issued POST is the NON-durable one. `fire()` sends neither
// `source_event_id` nor an `Idempotency-Key`, and the automation service enters
// its durable path only when BOTH are present (handlers/automation.go) —
// otherwise it falls through to the non-idempotent `Engine.Trigger`. The
// durable machinery exists (`Engine.TriggerDurable`); this caller does not use
// it.
//
// This is exactly the claim/enqueue split that zero-copy triggers built for
// themselves — a unique receipt index plus an INSERT..ON CONFLICT claim, so two
// lease holders cannot both enqueue. `flow_runs` has no equivalent: no
// idempotency key on the table, and no worker-GUC RLS policy of the kind
// migration 0325 grants the zero-copy tables.
//
// So `durable_claim_recovery` is genuinely OUTSTANDING, not merely unwired, and
// the gate's prerequisite list is correct to keep it listed. Recorded here
// because Requeue's existence reads as recovery, and reading it that way is how
// somebody talks themselves into opening the gate. Verified 2026-08-18 by an
// adversarial pass that set out to prove the prerequisite was already built.
func (d *Drainer) Requeue(ctx context.Context, olderThan time.Duration) (int64, error) {
	if !LegacyFlowRunsDrainerQualified {
		return 0, ErrFlowRuntimeUnavailable
	}
	if d == nil || d.Pool == nil {
		return 0, nil
	}
	tag, err := d.Pool.Exec(ctx, `
UPDATE flow_runs
   SET status = 'queued', started_at = NULL
 WHERE status = 'running'
   AND started_at < now() - $1::interval`, olderThan.String())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// Run drives the drainer on a ticker until ctx is cancelled.
//
// It also periodically requeues runs left stuck in 'running' by a drainer that
// died mid-flight — otherwise a crash would strand a run in exactly the way the
// missing consumer stranded all of them.
func (d *Drainer) Run(ctx context.Context, interval time.Duration) {
	if d == nil {
		return
	}
	if !LegacyFlowRunsDrainerQualified {
		d.log().Warn("flow_runs drainer disabled: end-to-end flow runtime is not qualified")
		return
	}
	if d.Pool == nil {
		return
	}
	if d.AutomationServiceURL == "" {
		d.log().Warn("flow_runs drainer disabled: AUTOMATION_SERVICE_URL is unset — " +
			"tag_added / tag_removed / list_joined and zero-copy warehouse triggers will not fire")
		return
	}
	if interval <= 0 {
		interval = 5 * time.Second
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()

	// Reclaim stuck runs roughly every 20 ticks.
	const stuckAfter = 10 * time.Minute
	sweep := 0

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if n, err := d.Drain(ctx); err != nil {
				d.log().Warn("flow_runs drain failed", "err", err.Error())
			} else if n > 0 {
				d.log().Debug("flow_runs drained", "dispatched", n)
			}
			sweep++
			if sweep >= 20 {
				sweep = 0
				if n, err := d.Requeue(ctx, stuckAfter); err != nil {
					d.log().Warn("flow_runs requeue failed", "err", err.Error())
				} else if n > 0 {
					d.log().Info("flow_runs requeued stuck runs", "count", n)
				}
			}
		}
	}
}
