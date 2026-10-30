// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancegate

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// RolloutMode is a closed operational policy. The zero value is off so merely
// constructing dependencies cannot silently activate a send gate.
type RolloutMode string

const (
	RolloutOff    RolloutMode = "off"
	RolloutShadow RolloutMode = "shadow"
	RolloutWarn   RolloutMode = "warn"
	RolloutBlock  RolloutMode = "block"
)

type Surface string

const (
	SurfacePreSend  Surface = "presend"
	SurfaceQueue    Surface = "queue"
	SurfaceDispatch Surface = "dispatch"
)

type Action string

const (
	ActionObserve Action = "observe"
	ActionAllow   Action = "allow"
	ActionBlock   Action = "block"
)

// Observation contains closed, low-cardinality dimensions only. Tenant,
// campaign, run, finding, provider error, and content values are deliberately
// absent so this contract cannot create an unbounded metrics label by design.
type Observation struct {
	Mode     RolloutMode
	Surface  Surface
	Status   Status
	Action   Action
	Duration time.Duration
}

type Observer interface {
	ObserveCampaignAssuranceGate(context.Context, Observation)
}

// Rollout projects one Gate into pre-send visibility and staged queue
// enforcement. Shadow and warn evaluate/observe but deliberately leave queue
// rows unbound so they continue through the legacy path; block returns the
// exact immutable receipt. Bound rows are always reauthorized strictly.
type Rollout struct {
	Gate     *Gate
	Mode     RolloutMode
	Observer Observer
	Now      func() time.Time
}

var (
	_ Evaluator       = (*Rollout)(nil)
	_ Authorizer      = (*Rollout)(nil)
	_ BoundAuthorizer = (*Rollout)(nil)
)

// RolloutMode reports the normalized configured mode. It exists so campaign
// entry points can disable legacy direct-enqueue routes as soon as any staged
// assurance rollout is active.
func (r *Rollout) RolloutMode() RolloutMode {
	if r == nil || strings.TrimSpace(string(r.Mode)) == "" {
		return RolloutOff
	}
	return RolloutMode(strings.TrimSpace(string(r.Mode)))
}

func validRolloutMode(mode RolloutMode) bool {
	switch mode {
	case RolloutOff, RolloutShadow, RolloutWarn, RolloutBlock:
		return true
	default:
		return false
	}
}

func ParseRolloutMode(raw string) (RolloutMode, error) {
	value := RolloutMode(strings.ToLower(strings.TrimSpace(raw)))
	if value == "" {
		value = RolloutOff
	}
	if !validRolloutMode(value) {
		return "", fmt.Errorf("campaign assurance rollout mode %q is invalid", raw)
	}
	return value, nil
}

// Evaluate is the five-second pre-send read seam. The handler owns the hard
// timeout; this method only consumes cached relational evidence.
func (r *Rollout) Evaluate(ctx context.Context, request Request) (Evaluation, error) {
	return r.evaluate(ctx, SurfacePreSend, request)
}

// Authorize applies staged queue semantics. Only block returns a binding;
// shadow/warn can therefore never strand recipients on a raw runtime that was
// intentionally left disabled during rollout.
func (r *Rollout) Authorize(ctx context.Context, request Request) (Receipt, error) {
	mode := r.RolloutMode()
	if mode == RolloutOff {
		return Receipt{}, nil
	}
	evaluation, err := r.evaluate(ctx, SurfaceQueue, request)
	if mode == RolloutShadow {
		return Receipt{}, nil
	}
	if mode == RolloutWarn {
		return Receipt{
			PolicyVersion:     PolicyVersion,
			CampaignID:        strings.TrimSpace(request.CampaignID),
			ContentRevisionID: strings.TrimSpace(request.ContentRevisionID),
			SourceHash:        strings.TrimSpace(request.SourceHash),
			RolloutMode:       mode, EvaluationStatus: evaluation.Status,
			EvaluationReasonCode: evaluation.ReasonCode,
		}, nil
	}
	if !validRolloutMode(mode) {
		return Receipt{}, ErrUnavailable
	}
	if err != nil {
		return Receipt{}, err
	}
	receipt, receiptErr := receiptFromEvaluation(evaluation)
	if receiptErr == nil {
		receipt.RolloutMode = mode
	}
	return receipt, receiptErr
}

// ReauthorizeBound ignores the current rollout mode. A row that already
// carries an assurance receipt must still honor a later waiver revocation,
// run staleness, or hash mismatch before it reaches the provider boundary.
func (r *Rollout) ReauthorizeBound(ctx context.Context, request Request) (Receipt, error) {
	evaluation, err := r.evaluate(ctx, SurfaceDispatch, request)
	if err != nil {
		return Receipt{}, err
	}
	return receiptFromEvaluation(evaluation)
}

func (r *Rollout) evaluate(ctx context.Context, surface Surface, request Request) (Evaluation, error) {
	started := time.Now()
	if r != nil && r.Now != nil {
		started = r.Now()
	}
	mode := r.RolloutMode()
	evaluation := Evaluation{
		PolicyVersion: PolicyVersion, TenantID: strings.TrimSpace(request.TenantID),
		CampaignID:        strings.TrimSpace(request.CampaignID),
		ContentRevisionID: strings.TrimSpace(request.ContentRevisionID),
		SourceHash:        strings.TrimSpace(request.SourceHash), Status: StatusUnavailable,
		ReasonCode: ReasonEvidenceUnavailable, RefreshedAt: started.UTC(),
	}
	var err error
	if !validRolloutMode(mode) || r == nil || r.Gate == nil {
		err = ErrUnavailable
	} else {
		evaluation, err = r.Gate.Evaluate(ctx, request)
	}
	action := ActionObserve
	if surface == SurfaceDispatch || (surface == SurfaceQueue && mode == RolloutBlock) {
		action = ActionAllow
		if err != nil || !evaluation.Authorized {
			action = ActionBlock
		}
	}
	finished := time.Now()
	if r != nil && r.Now != nil {
		finished = r.Now()
	}
	if r != nil && r.Observer != nil {
		r.Observer.ObserveCampaignAssuranceGate(ctx, Observation{
			Mode: mode, Surface: surface, Status: evaluation.Status,
			Action: action, Duration: nonNegativeDuration(finished.Sub(started)),
		})
	}
	return evaluation, err
}

func receiptFromEvaluation(evaluation Evaluation) (Receipt, error) {
	if !evaluation.Authorized || evaluation.receipt == nil {
		return Receipt{}, ErrUnavailable
	}
	receipt := *evaluation.receipt
	receipt.OverrideIDs = append([]string(nil), receipt.OverrideIDs...)
	receipt.EvaluationStatus = evaluation.Status
	receipt.EvaluationReasonCode = evaluation.ReasonCode
	return receipt, nil
}

func nonNegativeDuration(value time.Duration) time.Duration {
	if value < 0 {
		return 0
	}
	return value
}
