// SPDX-License-Identifier: AGPL-3.0-only
package operation

// Why a queued operation is not going to progress.
//
// `flow_runs` is enqueued by a reachable, working path — `EnqueueRun` writes a
// row the moment a trigger matches — and drained by nothing, because
// `flowbuilder.flowRuntimeQualified` is false and the drainer is compiled out
// behind it. So the rows accumulate, correctly stamped `queued`, and stay that
// way indefinitely.
//
// In a single-family view that was invisible: nobody looks at a flow-runs table
// expecting it to move. In the SHARED view it is actively misleading, because
// `queued` there means "waiting its turn" — the same word every other family
// uses for work that is about to happen. A person seeing three flow runs queued
// for a fortnight reads a backlog and goes looking for a stuck worker, and there
// is no worker to find.
//
// This does not change the STATE. The rows genuinely are queued, and inventing
// a `blocked` state would put a value in the vocabulary that no table's CHECK
// constraint permits and no registry entry maps. It adds the reason beside it,
// which is the fact the state cannot carry.

// BlockedReason explains why a family's queued work is not progressing, or "".
type BlockedReason struct {
	// Code is stable for clients to branch on.
	Code string `json:"code"`
	// Message is what a person reads.
	Message string `json:"message"`
}

// blockedFamilies maps a family Kind onto the reason its work cannot proceed.
//
// Deliberately keyed on Kind and populated from the owning package's own
// exported descriptor rather than restating the condition. A second copy of
// "the flow runtime is off" would be one more thing to update on the day it is
// switched on — and the failure would be a view that tells people their
// working flows are blocked, which is worse than the silence it replaced.
var blockedFamilies = map[string]func() *BlockedReason{}

// RegisterBlockedFamily records that a family's work is gated by a runtime that
// is not enabled.
//
// A function, not a value: the gate is a compile-time constant today, and
// resolving it lazily means a future runtime that becomes enabled at boot — or
// per tenant — does not need this file changed to stop lying.
func RegisterBlockedFamily(kind string, reason func() *BlockedReason) {
	blockedFamilies[kind] = reason
}

// BlockedReasonFor returns the reason a family's queued work is stalled, or nil.
//
// Applied ONLY to non-terminal states. A run that already succeeded is not
// blocked by anything, and labelling finished history with a current outage
// would make every completed flow run look like a failure the moment the
// runtime was gated.
//
// Exported so the composition root — which owns the registration — can assert
// that its wiring took effect.
func BlockedReasonFor(kind string, state State) *BlockedReason {
	return blockedReasonFor(kind, state)
}

func blockedReasonFor(kind string, state State) *BlockedReason {
	if state.Terminal() {
		return nil
	}
	fn, ok := blockedFamilies[kind]
	if !ok {
		return nil
	}
	return fn()
}
