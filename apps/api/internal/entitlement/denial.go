// SPDX-License-Identifier: AGPL-3.0-only

// Package entitlement carries the one shape for "you cannot do this, and here
// is why".
//
// The blueprint asks for a shared entitlement/policy explanation so that every
// new feature stops inventing its own plan/role/flag behaviour. Measured: 79
// non-test references to StatusPaymentRequired/StatusForbidden across 44 files.
// Two of them were byte-for-byte hand copies of the SAME rule —
// `limits.WriteExceeded` and `campaigns.quotaExceededQueueError` built the
// identical `plan_limit_exceeded` envelope in two packages, so a change to one
// silently diverged from the other.
//
// An earlier draft of this comment also claimed "65 distinct reason field
// shapes" and named two functions that do not exist. That number does not
// survive measurement — there are 94 `json:"reason"` fields in 7 tag forms, and
// most are not denial classes at all (bounce reason, suppression reason, DLQ
// reason, privacy-request reason). The duplication that motivated this package
// is the two-copy one above, which is real; the wider figure is withdrawn.
//
// WHY A CLASS AND NOT JUST A MESSAGE. A client cannot act on prose. "Upgrade
// your plan", "ask an admin", "wait for the window to reset" and "this is
// disabled for your workspace" need four different affordances, and today a
// surface has to pattern-match an error string to tell them apart — which is
// how a paywall ends up shown to someone who actually needs a role change.
// `Reason` is the machine-readable half; `Message` remains the human half.
//
// SCOPE. This is the DENIAL contract, not an entitlement engine. It does not
// decide whether a tenant may do something — `limits`, `feature_flags`,
// `rbac` and the plan tables still own that. It standardises how the answer
// "no" is expressed, which is the part every surface currently reinvents.
package entitlement

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// Reason is why the caller was refused. Closed vocabulary: a client switches on
// it to choose an affordance, so a new value is a client-visible contract
// change and must be added deliberately.
type Reason string

const (
	// ReasonPlan — the workspace's plan does not include this, or a plan limit
	// is exhausted. The affordance is an upgrade.
	ReasonPlan Reason = "plan"
	// ReasonRole — the caller's role forbids it. The affordance is to ask
	// someone with the role, NOT to upgrade. Conflating the two shows a paywall
	// to a person whose workspace already paid.
	ReasonRole Reason = "role"
	// ReasonFlag — disabled for this workspace by configuration. Neither money
	// nor permissions change it; someone has to turn it on.
	ReasonFlag Reason = "flag"
	// ReasonQuota — a rate or usage window is exhausted but will reset. The
	// affordance is to wait, and `RetryAfter` says how long.
	ReasonQuota Reason = "quota"
	// ReasonPolicy — a compliance or safety rule refuses it. Usually not
	// self-serviceable at all, which the client should say plainly rather than
	// offering a button that cannot work.
	ReasonPolicy Reason = "policy"
	// ReasonRuntime — the capability's execution is contained. Distinct from
	// the rest because nothing the CALLER does changes it; see
	// internal/runtimecapability, which owns that surface.
	ReasonRuntime Reason = "runtime"
)

// Valid reports whether r is a known reason. Used by the drift guard so an
// unclassified denial fails rather than reaching a client as an empty string.
func (r Reason) Valid() bool {
	switch r {
	case ReasonPlan, ReasonRole, ReasonFlag, ReasonQuota, ReasonPolicy, ReasonRuntime:
		return true
	}
	return false
}

// httpStatus maps a reason to its status code.
//
// Centralised because the mapping is part of the contract, and because getting
// it wrong is invisible: a role denial returned as 402 tells every client to
// show a billing page.
func (r Reason) httpStatus() int {
	switch r {
	case ReasonPlan:
		return http.StatusPaymentRequired
	case ReasonQuota:
		return http.StatusTooManyRequests
	case ReasonRuntime:
		return http.StatusServiceUnavailable
	default:
		// Role, flag and policy are all "authenticated, understood, refused".
		return http.StatusForbidden
	}
}

// Denial is the canonical refusal.
type Denial struct {
	// Subject is what was refused — a resource or operation name.
	//
	// Deliberately NOT called `capability`. That key is ALREADY on the wire with
	// a different meaning: apps/mobile parses a `capability` + `runtime_status`
	// envelope from internal/runtimecapability meaning "execution is contained
	// in this deployment". Reusing the name would let a 402 plan denial be read
	// as "switched off in this deployment" the moment the two envelopes grow a
	// field in common — and ReasonRuntime points at exactly that surface, so
	// they will.
	//
	// An earlier version claimed this was "a shared vocabulary a client can key
	// help content off". No such vocabulary exists: rbac uses
	// `subscribers.write`, audit uses `campaign.send`, runtimecapability uses
	// `flow_execution`, and the values emitted here matched none of them.
	Subject string `json:"subject,omitempty"`
	// Reason is the machine-readable class. Required.
	Reason Reason `json:"reason"`
	// Code is the specific code within the reason, e.g. `plan_limit_exceeded`.
	Code string `json:"code"`
	// Message is human-facing and safe to show. It must not leak the
	// configuration that produced the decision — a caller learning the exact
	// internal flag name learns more about the deployment than the refusal
	// requires.
	Message string `json:"message"`
	// Resource, Limit and Current describe a numeric ceiling when there is one.
	// Omitted otherwise rather than sent as zero, because 0 is a real limit.
	Resource string `json:"resource,omitempty"`
	Limit    *int64 `json:"limit,omitempty"`
	Current  *int64 `json:"current,omitempty"`
	// Tier is the plan that produced a ReasonPlan denial.
	Tier string `json:"tier,omitempty"`
	// RequiredRole is the role that WOULD be allowed, for ReasonRole. This is
	// what turns "forbidden" into an actionable "ask an admin".
	RequiredRole string `json:"required_role,omitempty"`
	// RetryAfterSeconds is set for ReasonQuota. Mirrored into the Retry-After
	// header by Write.
	RetryAfterSeconds int `json:"retry_after_seconds,omitempty"`
	// Remedy is the ONE action that resolves this, if any. Empty means the
	// caller cannot self-serve, which is itself worth saying.
	Remedy string `json:"remedy,omitempty"`
}

type denialEnvelope struct {
	Error Denial `json:"error"`
}

// Write emits the denial.
//
// A denial with an invalid reason is written as ReasonPolicy/403 rather than
// with an empty class: a client switching on the field must never receive a
// value outside the vocabulary, and defaulting to the least self-serviceable
// reason avoids inviting an upgrade that would not help.
func Write(w http.ResponseWriter, d Denial) {
	if !d.Reason.Valid() {
		d.Reason = ReasonPolicy
	}
	// The top-tier rule applies to EVERY denial, not only ones built by
	// PlanLimit. It lived in `remedyForTier`, which is unexported, so a site
	// outside this package could not apply it even knowing it existed — and
	// three sites converted later duly hardcoded `upgrade_plan`. A rule one
	// constructor enforces and every other caller must remember is not one rule.
	if d.Remedy == RemedyUpgradePlan && isTopTier(d.Tier) {
		d.Remedy = ""
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if d.Reason == ReasonQuota && d.RetryAfterSeconds > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(d.RetryAfterSeconds))
	}
	w.WriteHeader(d.Reason.httpStatus())
	_ = json.NewEncoder(w).Encode(denialEnvelope{Error: d})
}

// PlanLimit builds the plan-ceiling denial.
//
// Named because it was the shape hand-copied between `limits` and `campaigns`.
// One constructor means a change to the envelope reaches both.
func PlanLimit(subject, resource, tier, message string, limit, current int64) Denial {
	return Denial{
		// The parameter, not `resource`. It was assigned `resource` and the
		// argument silently ignored, so `limits.WriteExceeded` passing
		// "plan.contacts" put "contacts" on the wire — a caller could not
		// distinguish the subject it named from the resource it metered, and no
		// test asserted subject at all.
		Subject:  subject,
		Reason:   ReasonPlan,
		Code:     "plan_limit_exceeded",
		Message:  message,
		Resource: resource,
		Tier:     tier,
		Limit:    &limit,
		Current:  &current,
		// No remedy on the TOP tier. `pro` is the highest plan, so telling a pro
		// tenant at their ceiling to "upgrade_plan" points at a button that does
		// not exist — and the repo's own fixture is exactly that case (tier
		// `pro`, monthly_sends 500000/500000). An empty remedy means "you cannot
		// self-serve this", which is true and more useful than a dead end.
		Remedy: remedyForTier(tier),
	}
}

// RemedyUpgradePlan is the remedy for a ceiling a tenant can buy their way past.
// Named because it is the one remedy with a precondition — it is a lie on the
// top tier — and Write enforces that.
const RemedyUpgradePlan = "upgrade_plan"

// RemedyContactWorkspaceAdmin is the remedy for something only a workspace
// administrator can change — a feature flag, an allowance they control.
//
// Named here because the string is a CLIENT CONTRACT: apps/web's
// denialGuidance branches on it to render "a workspace administrator can raise
// this allowance". It was a bare literal hand-copied into two packages, which
// is one typo away from a denial that renders as unexplained prose.
const RemedyContactWorkspaceAdmin = "contact_workspace_admin"

// topTier is the highest canonical Moosewave plan. Above it
// there is nothing to upgrade to, so a ceiling breach needs a different answer.
const topTier = "scale"

func remedyForTier(tier string) string {
	if isTopTier(tier) {
		return ""
	}
	return RemedyUpgradePlan
}

func isTopTier(tier string) bool {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case topTier, "pro", "enterprise":
		return true
	default:
		return false
	}
}

// StatusFor exposes the reason→status mapping to callers that must build their
// own response envelope (a queued-job error, an RPC result) instead of writing
// straight to an http.ResponseWriter. Without it those callers hardcode a
// literal status and the "one mapping" property holds only where Write is used.
func StatusFor(r Reason) int { return r.httpStatus() }

// AsMap renders a Denial as a plain map.
//
// Needed because several call sites carry an `any` body that downstream code
// type-switches on. A review demonstrated the cost of ignoring that: placing
// the struct directly into such a body made an agent-facing extractor match
// neither of its arms, and a rich plan-limit explanation became an empty
// string. Marshalling through JSON keeps this in lock-step with the wire shape
// rather than being a second hand-maintained projection of it.
func AsMap(d Denial) map[string]any {
	raw, err := json.Marshal(d)
	if err != nil {
		// Unreachable for this struct; degrade to the fields a caller most
		// needs rather than returning nil and losing the message entirely.
		return map[string]any{"code": d.Code, "message": d.Message, "reason": string(d.Reason)}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{"code": d.Code, "message": d.Message, "reason": string(d.Reason)}
	}
	return out
}
