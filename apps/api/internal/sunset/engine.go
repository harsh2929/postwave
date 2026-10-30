// SPDX-License-Identifier: AGPL-3.0-only
//
// engine.go — the detector pipeline. Discovers candidates by querying
// the subscriber engagement view, filters out subscribers with excluded
// tags, executes the policy's Action per candidate, and writes an
// Execution row for each. The Execution UNIQUE (policy_id,
// subscriber_id) makes re-runs idempotent: a candidate already acted
// on under this policy is skipped without re-running the action.

package sunset

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// SubscriberStore is the seam to the subscriber/engagement layer. We
// keep the interface narrow so the engine can be unit-tested without
// the full subscribers package + DB. Production wires a thin Postgres
// implementation that joins subscribers with the engagement
// aggregates.
type SubscriberStore interface {
	// Candidates returns subscribers in scope of the policy:
	// inactivity ≥ policy.InactiveDays AND not carrying any tag in
	// policy.ExcludedTags AND not already in the suppression list.
	// The contract: callers ALREADY filtered out subscribers with an
	// existing Execution row for this policy.
	Candidates(ctx context.Context, tenantID string, policy Policy, limit int) ([]Candidate, error)

	// AddSuppression inserts into email_suppressions with the given
	// source. Idempotent — re-inserting the same address is a no-op.
	AddSuppression(ctx context.Context, tenantID, email, source, reason string) error

	// AddTag writes a single tag onto the subscriber. Idempotent.
	AddTag(ctx context.Context, tenantID, subscriberID, tag string) error

	// EnqueueWinback appends to winback_candidate_queue. Idempotent
	// per (policy_id, subscriber_id).
	EnqueueWinback(ctx context.Context, tenantID, policyID, subscriberID string) error
}

// PolicyStore is the seam to sunset_policies + sunset_executions.
type PolicyStore interface {
	GetPolicy(ctx context.Context, tenantID, policyID string) (Policy, error)
	ListPolicies(ctx context.Context, tenantID string, enabledOnly bool) ([]Policy, error)
	CreatePolicy(ctx context.Context, tenantID string, p Policy) (Policy, error)
	UpdatePolicy(ctx context.Context, tenantID string, p Policy) (Policy, error)
	DeletePolicy(ctx context.Context, tenantID, policyID string) error

	RecordExecution(ctx context.Context, e Execution) error
	ListExecutions(ctx context.Context, tenantID, policyID string, limit int) ([]Execution, error)
}

type TagHistoryEmitter interface {
	EmitSunsetTagApplied(ctx context.Context, tenantID, policyID, subscriberID, tagName string)
}

// Engine runs the discovery → action → log pipeline.
type Engine struct {
	Policies    PolicyStore
	Subscribers SubscriberStore
	History     TagHistoryEmitter
	Clock       func() time.Time
	// MaxPerRun bounds how many candidates one Run will process. The
	// detector is meant to be cron-tickled; running for 30s with a cap
	// of 10k beats running unbounded and stalling the worker.
	MaxPerRun int
}

// NewEngine constructs an Engine with sensible defaults.
func NewEngine(policies PolicyStore, subscribers SubscriberStore) *Engine {
	return &Engine{
		Policies:    policies,
		Subscribers: subscribers,
		Clock:       time.Now,
		MaxPerRun:   10_000,
	}
}

// Run executes one detector pass for one policy. Returns a RunSummary
// the dashboard can render. The caller (cron tick) loops over enabled
// policies; the engine has no "run all" entry point — keeping the
// per-policy scope explicit means a partial failure of one policy
// doesn't poison the others.
func (e *Engine) Run(ctx context.Context, tenantID, policyID string) (RunSummary, error) {
	if e.Policies == nil || e.Subscribers == nil {
		return RunSummary{}, errors.New("sunset: engine not wired (Policies/Subscribers nil)")
	}
	now := e.now()
	summary := RunSummary{
		PolicyID:  policyID,
		StartedAt: now,
		ByAction:  map[Action]int{},
	}

	policy, err := e.Policies.GetPolicy(ctx, tenantID, policyID)
	if err != nil {
		return summary, fmt.Errorf("load policy: %w", err)
	}
	if !policy.Enabled {
		summary.CompletedAt = e.now()
		summary.Errors = append(summary.Errors, "policy disabled; no candidates scanned")
		return summary, nil
	}

	limit := e.MaxPerRun
	if limit <= 0 {
		limit = 10_000
	}
	candidates, err := e.Subscribers.Candidates(ctx, tenantID, policy, limit)
	if err != nil {
		summary.CompletedAt = e.now()
		return summary, fmt.Errorf("discover candidates: %w", err)
	}
	summary.CandidatesSeen = len(candidates)

	for _, c := range candidates {
		action, reason, err := e.actionFor(ctx, tenantID, policy, c)
		if err != nil {
			summary.Errors = append(summary.Errors,
				fmt.Sprintf("%s: %s", c.Email, err.Error()))
			continue
		}
		summary.ByAction[action]++
		_ = e.Policies.RecordExecution(ctx, Execution{
			TenantID:     tenantID,
			PolicyID:     policy.ID,
			SubscriberID: c.SubscriberID,
			ActionTaken:  action,
			Reason:       reason,
			ExecutedAt:   e.now(),
		})
	}
	summary.CompletedAt = e.now()
	return summary, nil
}

// actionFor decides what to do with one candidate. The decision tree:
//
//  1. If candidate carries any excluded tag → ActionSkipped.
//  2. Otherwise execute the policy's configured Action.
//
// The "any excluded tag" check is done in code here even though
// Candidates() also filters on excluded_tags — defence in depth so a
// candidate that gained an excluded tag between discovery and
// execution still gets skipped.
func (e *Engine) actionFor(ctx context.Context, tenantID string, p Policy, c Candidate) (Action, string, error) {
	if hasAnyTag(c.Tags, p.ExcludedTags) {
		return ActionSkipped, "candidate carries an excluded tag", nil
	}
	switch p.Action {
	case ActionSuppress:
		if err := e.Subscribers.AddSuppression(ctx, tenantID, c.Email, "sunset", fmt.Sprintf("policy=%s inactive_days=%d", p.ID, c.InactiveDays)); err != nil {
			return "", "", err
		}
		return ActionSuppress, "", nil
	case ActionTag:
		tagName := "sunset_candidate"
		if err := e.Subscribers.AddTag(ctx, tenantID, c.SubscriberID, tagName); err != nil {
			return "", "", err
		}
		if e.History != nil {
			e.History.EmitSunsetTagApplied(ctx, tenantID, p.ID, c.SubscriberID, tagName)
		}
		return ActionTag, "", nil
	case ActionWinback:
		if err := e.Subscribers.EnqueueWinback(ctx, tenantID, p.ID, c.SubscriberID); err != nil {
			return "", "", err
		}
		return ActionWinback, "", nil
	}
	return ActionSkipped, "policy has unknown action", nil
}

func (e *Engine) now() time.Time {
	if e.Clock == nil {
		return time.Now().UTC()
	}
	return e.Clock().UTC()
}

func hasAnyTag(have, blocked []string) bool {
	if len(blocked) == 0 || len(have) == 0 {
		return false
	}
	set := make(map[string]struct{}, len(blocked))
	for _, b := range blocked {
		set[b] = struct{}{}
	}
	for _, h := range have {
		if _, ok := set[h]; ok {
			return true
		}
	}
	return false
}
