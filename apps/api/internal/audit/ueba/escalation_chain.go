// SPDX-License-Identifier: AGPL-3.0-only

package ueba

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// EscalationChainDetector flags privilege-escalation chains:
// role-assume → permission-grant → resource-access within a short
// window for the same actor.
//
// Detect is stateless per-event; the chain context lives in a small
// ring-buffer of recent events per actor that the worker passes in
// via prev. That's a simplification — the production wiring (worker.go)
// keeps a per-actor sliding window keyed by (tenant_id, actor_label)
// and re-evaluates each fresh event against the window.
type EscalationChainDetector struct {
	// MaxWindow is the chain timeout: events further apart than this
	// don't compose into a single chain. Default 5min.
	MaxWindow time.Duration
	// MinChainLength is the minimum number of distinct step kinds the
	// window must contain to fire. Default 3 (assume → grant → access).
	MinChainLength int
}

// ChainStep classifies a single audit action into one of the four
// escalation steps. Unknown action verbs return ChainStepNone.
type ChainStep int

const (
	ChainStepNone ChainStep = iota
	ChainStepAssumeRole
	ChainStepPermissionGrant
	ChainStepResourceAccess
	ChainStepDestructive
)

func (s ChainStep) String() string {
	switch s {
	case ChainStepAssumeRole:
		return "assume_role"
	case ChainStepPermissionGrant:
		return "permission_grant"
	case ChainStepResourceAccess:
		return "resource_access"
	case ChainStepDestructive:
		return "destructive"
	}
	return "none"
}

// IdentifyChainStep classifies an action verb. Exported so unit tests
// can pin the classification without instantiating the detector.
func IdentifyChainStep(action string) ChainStep {
	a := strings.ToLower(action)
	switch {
	case strings.Contains(a, "assume_role") || strings.Contains(a, "role.assume") || strings.Contains(a, "session.assume"):
		return ChainStepAssumeRole
	case strings.Contains(a, "permission.grant") || strings.Contains(a, "role.grant") || strings.Contains(a, "policy.attach") || strings.Contains(a, "scope.grant"):
		return ChainStepPermissionGrant
	case strings.Contains(a, "delete") || strings.Contains(a, "purge") || strings.Contains(a, "drop") || strings.Contains(a, "destroy") || strings.Contains(a, "revoke") || strings.Contains(a, "rotate") || strings.Contains(a, "wipe"):
		return ChainStepDestructive
	case strings.Contains(a, ".get") || strings.Contains(a, ".read") || strings.Contains(a, ".list") || strings.Contains(a, ".export") || strings.Contains(a, ".download"):
		return ChainStepResourceAccess
	}
	return ChainStepNone
}

func (d *EscalationChainDetector) Name() string { return "escalation_chain" }

// WalkChain inspects a recent-event window for the same actor. Returns
// the distinct ChainStep kinds present in the window plus the earliest
// event timestamp. Exported so worker.go can drive the sliding window
// without re-deriving the chain logic.
func WalkChain(window []AuditEvent, maxAge time.Duration, now time.Time) ([]ChainStep, time.Time) {
	if maxAge <= 0 {
		maxAge = 5 * time.Minute
	}
	cutoff := now.Add(-maxAge)
	seen := map[ChainStep]bool{}
	var earliest time.Time
	for _, e := range window {
		if e.At.Before(cutoff) {
			continue
		}
		step := IdentifyChainStep(e.Action)
		if step == ChainStepNone {
			continue
		}
		seen[step] = true
		if earliest.IsZero() || e.At.Before(earliest) {
			earliest = e.At
		}
	}
	out := make([]ChainStep, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	return out, earliest
}

// Detect uses the prev event as a single-element window proxy. The
// production worker should call WalkChain directly against the actor's
// full sliding window; Detect itself is the simpler "two consecutive
// events compose an escalation" check used as a per-event fast-path
// (no sliding-window state needed).
func (d *EscalationChainDetector) Detect(_ context.Context, ev AuditEvent, _ *Baseline, prev *AuditEvent) []DetectorReason {
	maxWindow := d.MaxWindow
	if maxWindow <= 0 {
		maxWindow = 5 * time.Minute
	}
	cur := IdentifyChainStep(ev.Action)
	if cur == ChainStepNone {
		return nil
	}
	if prev == nil {
		return nil
	}
	if ev.At.Sub(prev.At) > maxWindow || ev.At.Before(prev.At) {
		return nil
	}
	prevStep := IdentifyChainStep(prev.Action)
	if prevStep == ChainStepNone {
		return nil
	}
	// Look for the canonical escalation transitions:
	//   assume_role → permission_grant
	//   assume_role → resource_access
	//   permission_grant → resource_access
	//   permission_grant → destructive
	//   resource_access → destructive
	transition := chainTransitionKey(prevStep, cur)
	if !isEscalationTransition(transition) {
		return nil
	}
	dt := ev.At.Sub(prev.At)
	confidence := clamp01(1.0 - dt.Seconds()/maxWindow.Seconds())
	if cur == ChainStepDestructive {
		confidence = clamp01(confidence + 0.2)
	}
	return []DetectorReason{{
		Type: d.Name(),
		Reason: fmt.Sprintf(
			"%s → %s within %s (escalation transition)",
			prevStep.String(), cur.String(), dt.Truncate(time.Second).String(),
		),
		Confidence: confidence,
		Mitre:      MitreFor(d.Name()),
	}}
}

func chainTransitionKey(from, to ChainStep) string {
	return from.String() + "→" + to.String()
}

func isEscalationTransition(key string) bool {
	switch key {
	case "assume_role→permission_grant",
		"assume_role→resource_access",
		"assume_role→destructive",
		"permission_grant→resource_access",
		"permission_grant→destructive",
		"resource_access→destructive":
		return true
	}
	return false
}
