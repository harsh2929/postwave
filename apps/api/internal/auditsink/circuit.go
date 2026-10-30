// SPDX-License-Identifier: AGPL-3.0-only
//
// circuit.go — per-sink circuit breaker + DLQ writer.
//
// State machine:
//
//   closed     all deliveries pass through.
//                 transitions: 10 consecutive failures → open.
//   open       deliveries short-circuit + write to audit_sink_dlq
//                 without hitting the network.
//                 transitions: cooldown_until elapsed → half_open.
//   half_open  one probe delivery is allowed.
//                 transitions:
//                   probe succeeds → closed (counters reset).
//                   probe fails    → open (cooldown doubles, capped).
//
// The breaker lets a degraded upstream (e.g. Datadog 5xx for an
// hour) stop pinning the worker on the same sink + spamming
// failure logs. Once the cooldown elapses we send a single probe;
// if it succeeds we fully reopen the gate.
//
// Default thresholds:
//   FailureThresholdToOpen = 10
//   InitialCooldown        = 30s
//   MaxCooldown            = 30m
//
// All times are wall-clock — no fancy token-bucket / sliding-window.
// Cooldown is the only quantity that grows on repeated failure.

package auditsink

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// FailureThresholdToOpen is the consecutive-failure count after which
// closed → open transitions. Calibrated low so noisy sinks don't
// burn CPU; high enough to ignore single-request hiccups.
const FailureThresholdToOpen = 10

// InitialCooldown is the wait before a half_open probe is issued.
const InitialCooldown = 30 * time.Second

// MaxCooldown caps the exponential backoff. After ~6 consecutive
// open transitions the cooldown saturates here.
const MaxCooldown = 30 * time.Minute

// circuitDecision is the result of consulting the breaker pre-flight.
type circuitDecision int

const (
	circuitAllow circuitDecision = iota // closed or half_open probe
	circuitDeny                         // open + cooldown not yet elapsed
)

// breakerCheck reads the sink's current circuit state and decides
// whether to admit a delivery. Side-effect: when state is `open` and
// cooldown has elapsed, transitions to `half_open` so the next
// delivery can probe.
func (d *Deps) breakerCheck(ctx context.Context, s Sink) (circuitDecision, error) {
	tx, err := db.WithTenant(ctx, d.Pool, s.TenantID)
	if err != nil {
		return circuitAllow, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var state string
	var cooldownUntil *time.Time
	row := tx.QueryRow(ctx,
		`SELECT circuit_state, cooldown_until
		   FROM audit_sinks WHERE id = $1::uuid`, s.ID)
	if err := row.Scan(&state, &cooldownUntil); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return circuitAllow, nil
		}
		return circuitAllow, err
	}
	switch state {
	case "closed":
		return circuitAllow, tx.Commit(ctx)
	case "half_open":
		// The previous probe is still inflight or just finished —
		// don't let a second one through. The probe is a single-
		// flight operation by design.
		return circuitDeny, tx.Commit(ctx)
	case "open":
		if cooldownUntil == nil || time.Now().UTC().After(*cooldownUntil) {
			// Transition open → half_open.
			if _, err := tx.Exec(ctx,
				`UPDATE audit_sinks SET circuit_state = 'half_open'
				   WHERE id = $1::uuid`, s.ID); err != nil {
				return circuitAllow, err
			}
			return circuitAllow, tx.Commit(ctx)
		}
		return circuitDeny, tx.Commit(ctx)
	}
	// Unknown state — fail safe and allow.
	return circuitAllow, tx.Commit(ctx)
}

// breakerOnSuccess transitions the sink back to closed on a successful
// delivery (no matter the prior state).
func (d *Deps) breakerOnSuccess(ctx context.Context, s Sink) error {
	tx, err := db.WithTenant(ctx, d.Pool, s.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_sinks
   SET circuit_state = 'closed',
       cooldown_until = NULL,
       consecutive_failures = 0,
       last_success_at = now()
 WHERE id = $1::uuid`, s.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// breakerOnFailure increments the failure counter and, when the
// threshold is crossed, transitions to `open` with an exponentially-
// growing cooldown. Returns true when the transition happened
// (caller will write a DLQ row).
func (d *Deps) breakerOnFailure(ctx context.Context, s Sink, errMsg string) (bool, error) {
	tx, err := db.WithTenant(ctx, d.Pool, s.TenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		curState         string
		curCount         int
		curCooldownUntil *time.Time
	)
	row := tx.QueryRow(ctx, `
SELECT circuit_state, COALESCE(consecutive_failures, 0), cooldown_until
  FROM audit_sinks
 WHERE id = $1::uuid
 FOR UPDATE`, s.ID)
	if err := row.Scan(&curState, &curCount, &curCooldownUntil); err != nil {
		return false, err
	}
	newCount := curCount + 1
	newState := curState
	var newCooldown *time.Time
	transitioned := false
	switch curState {
	case "closed":
		if newCount >= FailureThresholdToOpen {
			newState = "open"
			cd := time.Now().UTC().Add(InitialCooldown)
			newCooldown = &cd
			transitioned = true
		}
	case "half_open":
		// Probe failed — back to open with doubled cooldown (capped).
		newState = "open"
		base := InitialCooldown
		if curCooldownUntil != nil {
			// Best-effort: previous cooldown size = time since the
			// cooldown_until value was written minus InitialCooldown.
			// We can't know the original duration without a separate
			// column, so we double by reading the current saturation
			// from consecutive_failures.
			factor := 1 << (newCount / FailureThresholdToOpen)
			if factor < 1 {
				factor = 1
			}
			base = time.Duration(int64(InitialCooldown) * int64(factor))
			if base > MaxCooldown {
				base = MaxCooldown
			}
		}
		cd := time.Now().UTC().Add(base)
		newCooldown = &cd
		transitioned = true
	case "open":
		// Already open — just bump the counter; no DLQ write here
		// (caller did the short-circuit BEFORE calling this fn).
	}
	if _, err := tx.Exec(ctx, `
UPDATE audit_sinks
   SET circuit_state = $1,
       consecutive_failures = $2,
       cooldown_until = $3,
       last_failure_at = now(),
       last_failure_reason = $4
 WHERE id = $5::uuid`,
		newState, newCount, newCooldown, errMsg, s.ID); err != nil {
		return false, err
	}
	return transitioned, tx.Commit(ctx)
}

// writeDLQ inserts a row into audit_sink_dlq capturing the failed
// audit_log id range so an operator can replay later. The caller
// passes the from/to range it was about to deliver.
func (d *Deps) writeDLQ(ctx context.Context, s Sink, fromID, toID int64, errMsg string) error {
	tx, err := db.WithTenant(ctx, d.Pool, s.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO audit_sink_dlq
  (tenant_id, sink_id, from_audit_id, to_audit_id, last_error)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
		s.TenantID, s.ID, fromID, toID, errMsg)
	if err != nil {
		return fmt.Errorf("dlq insert: %w", err)
	}
	return tx.Commit(ctx)
}
