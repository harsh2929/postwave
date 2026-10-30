// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/postwave/postwave/apps/api/internal/sandbox"
)

// Outcome classifies how an Execute call ended. It is the single source
// of truth for the result state (the [Result] predicates derive from it)
// and is what the Governor records in the audit trail.
type Outcome string

const (
	OutcomeOK        Outcome = "ok"        // handler ran, returned a payload
	OutcomeError     Outcome = "error"     // handler or an infra step failed
	OutcomeDenied    Outcome = "denied"    // a governance policy refused the call
	OutcomeSandboxed Outcome = "sandboxed" // simulated; handler not run
	OutcomePending   Outcome = "pending"   // queued for human approval; not run
	OutcomeCanceled  Outcome = "canceled"  // context was cancelled/expired
)

// Sentinel errors. Surfaces map these to the right wire code.
var (
	ErrUnknownTool      = errors.New("agenttools: unknown tool")
	ErrNoHandler        = errors.New("agenttools: tool has no handler")
	ErrNoTenant         = errors.New("agenttools: caller has no tenant")
	ErrScopeDenied      = errors.New("agenttools: required scope missing")
	ErrInvalidArguments = errors.New("agenttools: invalid tool arguments")
	ErrQuotaExceeded    = errors.New("agenttools: per-tool quota exceeded")
	// ErrWriteTierReleaseHeld is a compile-time product boundary, not a
	// caller-policy denial. Interactive surfaces must not execute writes until
	// mutation, budget charging, approval binding, and audit evidence share a
	// durable atomic/outbox contract.
	ErrWriteTierReleaseHeld = errors.New("agenttools: interactive write tier is release-held")
	// ErrLLMDataEgressReleaseHeld protects model context independently of the
	// read/write distinction. A tool must declare an audited, bounded output
	// projection before an LLM-facing surface may discover or execute it.
	ErrLLMDataEgressReleaseHeld = errors.New("agenttools: LLM data-egress tier is release-held")
	// ErrMandateDenied is the single denial for a bounded grant: not granted
	// this action, not this resource, expired, revoked, or out of budget. One
	// error on purpose — an agent that could tell which bound it hit could map
	// the shape of a mandate it was never given.
	ErrMandateDenied  = errors.New("agenttools: not authorised by mandate")
	ErrBudgetExceeded = errors.New("agenttools: send budget exceeded")
	ErrScrubFailed    = errors.New("agenttools: result scrubbing failed")
	// ErrInternal wraps an infrastructure failure inside a governance step
	// (a quota/budget/approval lookup that errored, not a policy denial).
	// Surfaces map it to a generic internal-error response so raw internal
	// detail never reaches the model, while logging the cause server-side.
	ErrInternal = errors.New("agenttools: internal error")
)

// InteractiveWriteTierReleased applies to both native MCP and the in-app
// agent. Both draw from the same registry, so holding only the MCP HTTP handler
// would leave an alternate execution path through SurfaceAgent.
const InteractiveWriteTierReleased = false

// WriteTierReleaseHoldCode is stable for HTTP/JSON-RPC/UI adapters.
const WriteTierReleaseHoldCode = "agent_write_tier_release_held"

// LLMDataEgressReleaseHoldCode is stable for HTTP/JSON-RPC/UI adapters.
const LLMDataEgressReleaseHoldCode = "agent_llm_data_egress_release_held"

// Result is the outcome of an Execute call. Outcome is authoritative;
// the boolean predicates are derived from it so the two cannot diverge.
// Field population by outcome:
//   - Tool is set whenever the tool resolved (nil only for ErrUnknownTool
//     / ErrNoTenant / a cancellation before lookup)
//   - Payload is set only for OutcomeOK (and the simulated stub for
//     OutcomeSandboxed)
//   - ApprovalRef is set only for OutcomePending
type Result struct {
	Tool        *ToolSpec
	Outcome     Outcome
	Payload     any
	ApprovalRef string
	LatencyMs   int
}

// IsSandboxed reports the write was simulated, not executed.
func (r *Result) IsSandboxed() bool { return r != nil && r.Outcome == OutcomeSandboxed }

// IsPending reports the call was queued for human approval.
func (r *Result) IsPending() bool { return r != nil && r.Outcome == OutcomePending }

// Ran reports the handler actually executed and returned a payload.
func (r *Result) Ran() bool { return r != nil && r.Outcome == OutcomeOK }

// Governor abstracts the governance machinery so this package imports no
// budgets/approvals/audit/quota/pii code directly. The runtime supplies
// a real implementation in main.go; tests supply a fake. Every method is
// consulted by [Execute] in a fixed order.
// MandateGovernor is the optional bounded-grant gate.
//
// A separate interface, not another Governor method: every existing Governor
// implementation would otherwise have to grow a method, and the ones in tests
// would grow a stub that returns nil — a gate that every fake silently passes.
// Opting in by type assertion means a surface without mandates is unchanged and
// a surface with them cannot forget, because Execute checks for the capability
// whenever the caller presents a mandate.
type MandateGovernor interface {
	// CheckMandate authorises this tool call against the caller's mandate AND
	// spends one use. Return ErrMandateDenied (or a wrapping error) to deny on
	// policy; any other error refuses the call as an infrastructure failure.
	CheckMandate(ctx context.Context, c Caller, tool *ToolSpec) error
}

type Governor interface {
	// CheckQuota enforces the per-tool call quota. Return ErrQuotaExceeded
	// (or an error wrapping it) to deny on policy; any other error is
	// treated as an infrastructure failure and also refuses the call.
	CheckQuota(ctx context.Context, c Caller, tool *ToolSpec) error
	// AuthorizeSend is consulted only for tools with ChargesSend=true.
	// Return ErrBudgetExceeded (or a wrapping error) to deny on policy.
	AuthorizeSend(ctx context.Context, c Caller, tool *ToolSpec) error
	// RequireApproval is consulted only for Destructive tools. It returns
	// pending=true when the action was queued for human approval and must
	// NOT execute now (ref identifies the request).
	RequireApproval(ctx context.Context, c Caller, tool *ToolSpec, args json.RawMessage) (pending bool, ref string, err error)
	// ScrubResult sanitizes PII in a tool result before it reaches a
	// model. Called only when Caller.LLMFacing is true. It may fail: when
	// it returns an error, Execute fails closed and does NOT emit the
	// unscrubbed payload.
	ScrubResult(ctx context.Context, c Caller, tool *ToolSpec, result any) (any, error)
	// Audit records the final outcome (including denials). A non-nil error
	// is routed to a guaranteed fallback sink so a dropped audit row is
	// never completely silent.
	Audit(ctx context.Context, c Caller, tool *ToolSpec, outcome Outcome, latencyMs int) error
}

// LLMResultGovernor is an explicit composition marker. Merely implementing
// ScrubResult is insufficient because NoopGovernor also satisfies Governor;
// every LLM-facing surface must wire a governor that declares result privacy
// protection ready before it may invoke a tool.
type LLMResultGovernor interface {
	Governor
	LLMResultProtectionReady() bool
}

// LLMResultProtectionReady is the mount/runtime composition predicate shared
// by native MCP and the in-app agent.
func LLMResultProtectionReady(gov Governor) bool {
	protected, ok := gov.(LLMResultGovernor)
	return ok && protected.LLMResultProtectionReady()
}

// auditFallback receives audit-write failures so a dropped governance
// record is at least observable. Overridable in tests.
var auditFallback = func(err error) {
	// Audit sinks can fail with database/provider errors that contain private
	// topology or credentials. Preserve the operational signal without echoing
	// the arbitrary error string into application logs.
	log.Printf("agenttools: audit write failed (governance record dropped; class=internal_error)")
}

// clock is injectable so latency is deterministic in tests.
type clock func() time.Time

// Execute runs one tool through the governance gauntlet, in this order:
//
//  0. preconditions: tenant present, context live, tool resolves,
//     tool is exposed on the caller's surface, tool has a handler
//  1. structural interactive write-tier hold (no governance side effects)
//  2. structural LLM output hold (no governance side effects)
//  3. result-protection composition check
//  4. scope check (missing → ErrScopeDenied)
//  5. input-schema validation (before any reservation/charging)
//  6. mandate, when the caller carries one (policy → ErrMandateDenied)
//  7. per-tool quota (policy → ErrQuotaExceeded; infra error → refuse)
//  3. sandbox short-circuit: a sandbox key (from Caller.Sandbox OR the
//     context flag) invoking a write-tier tool gets a simulated result
//  4. send budget (ChargesSend tools → AuthorizeSend)
//  5. approval gate (Destructive tools → RequireApproval; pending → no run)
//  6. context re-check, then run the handler (panics recovered)
//  7. PII scrub (LLM-facing callers; failure fails closed)
//  8. audit (always, including denials)
//
// Quota is intentionally charged before the sandbox short-circuit so that
// sandbox traffic is rate-limited like any other (it cannot be used to
// bypass per-tool quotas). A nil Governor is treated as [NoopGovernor].
func Execute(ctx context.Context, reg *Registry, gov Governor, c Caller, name string, args json.RawMessage) (*Result, error) {
	return executeWithClock(ctx, reg, gov, c, name, args, time.Now)
}

func executeWithClock(ctx context.Context, reg *Registry, gov Governor, c Caller, name string, args json.RawMessage, now clock) (outRes *Result, outErr error) {
	if gov == nil {
		gov = NoopGovernor{}
	}
	// Resolve only for bounded trace identity before opening the span. A raw
	// tools/call name is caller-controlled; unknown or surface-inaccessible
	// names must never become a span name/attribute.
	var tool *ToolSpec
	if reg != nil {
		tool = reg.Lookup(name)
	}
	traceToolName := "unknown_tool"
	if tool != nil && (c.Surface == "" || tool.ExposedOn(c.Surface)) {
		traceToolName = tool.Name
	}
	// Observability: one OTel GenAI execute_tool span per invocation. No-op
	// when tracing is disabled. The deferred finish records the final
	// outcome/latency/error once the function returns.
	ctx, span := startToolSpan(ctx, c, traceToolName)
	defer func() {
		// Sanitize before tracing: finishToolSpan records err.Error() as both an
		// exception event and status description. This is the final cross-cutting
		// boundary for quota/budget/approval/scrub/handler failures.
		if c.LLMFacing && outErr != nil {
			outErr = llmSafeExecutionError(outErr)
		}
		finishToolSpan(span, outRes, outErr)
	}()
	started := now()
	elapsed := func() int { return int(now().Sub(started) / time.Millisecond) }

	// 0a. authentication precondition: never run with a blank tenant.
	if c.TenantID == "" {
		return &Result{Outcome: OutcomeError, LatencyMs: elapsed()}, ErrNoTenant
	}
	// 0b. bail fast if the context is already done — no tool attributed.
	if err := ctx.Err(); err != nil {
		return &Result{Outcome: OutcomeCanceled, LatencyMs: elapsed()}, err
	}
	// 0c. resolve.
	if tool == nil {
		return &Result{Outcome: OutcomeError, LatencyMs: elapsed()}, ErrUnknownTool
	}
	// 0d. surface isolation: a tool not exposed on the caller's surface
	// is indistinguishable from unknown (don't leak its existence) and
	// must not trigger any governance side-effects. Empty Surface means a
	// trusted internal caller and skips the check.
	if c.Surface != "" && !tool.ExposedOn(c.Surface) {
		return &Result{Outcome: OutcomeError, LatencyMs: elapsed()}, ErrUnknownTool
	}
	// 0e. a handler-less (proxy-only) spec can never run: refuse before
	// any governance side-effect so it cannot consume quota / queue an
	// approval and then fail.
	if tool.Handler == nil {
		return &Result{Tool: tool, Outcome: OutcomeError, LatencyMs: elapsed()}, ErrNoHandler
	}
	// 0f. The shared registry also backs the in-app agent. Refuse interactive
	// writes here, before finish/audit or any quota/mandate/budget/approval
	// side effect, so no alternate surface can bypass the native HTTP hold.
	if tool.WriteTier && (c.Surface == SurfaceMCP || c.Surface == SurfaceAgent) && !InteractiveWriteTierReleased {
		return &Result{Tool: tool, Outcome: OutcomeDenied, LatencyMs: elapsed()}, ErrWriteTierReleaseHeld
	}
	// 0g. Read-only does not imply model-safe. Hold every LLM-facing result
	// whose exact projection has not been reviewed, before audit/quota/mandate
	// or handler side effects. This specifically contains subscriber/profile,
	// campaign-content, URL, tag, and tenant-defined free-text egress.
	if c.LLMFacing && !tool.LLMOutputSafe {
		return &Result{Tool: tool, Outcome: OutcomeDenied, LatencyMs: elapsed()}, ErrLLMDataEgressReleaseHeld
	}
	// 0h. Even an explicitly bounded projection still requires the real
	// defense-in-depth scrubber. Check composition after structural holds so a
	// held write/read returns its stable release code without depending on a
	// governor or producing governance side effects.
	if c.LLMFacing && !LLMResultProtectionReady(gov) {
		return &Result{Tool: tool, Outcome: OutcomeError, LatencyMs: elapsed()}, fmt.Errorf("%w: LLM result protection governor is required", ErrInternal)
	}

	// finish stamps the result and audits it (with a guaranteed fallback).
	finish := func(res *Result, outcome Outcome) {
		res.Tool = tool
		res.Outcome = outcome
		res.LatencyMs = elapsed()
		if err := gov.Audit(ctx, c, tool, outcome, res.LatencyMs); err != nil {
			auditFallback(err)
		}
	}

	// 1. scopes (sourced from ctx — the same authority as the rest of the API).
	if missing := tool.MissingScopes(ctx); len(missing) > 0 {
		res := &Result{}
		finish(res, OutcomeDenied)
		return res, scopeError(missing)
	}

	// 2. Arguments are centrally validated before mandate uses, quota checks,
	// budget authorization, approvals, or the handler. Schemas fail closed on
	// unknown fields unless they explicitly opt into additionalProperties.
	if err := validateToolArguments(tool.InputSchema, args); err != nil {
		res := &Result{}
		finish(res, OutcomeError)
		return res, err
	}

	// 3. mandate: the bounded grant, when the caller carries one.
	//
	// BEFORE quota, deliberately. Quota is a per-tool rate limit and consuming
	// it for a call the mandate was never going to permit lets an agent burn
	// somebody else's budget by asking for things it is not allowed to do.
	//
	// A caller with no mandate passes: the surfaces that predate mandates still
	// authenticate with a full key, and failing closed here would take the agent
	// surface offline for a control nothing has issued yet. What a mandate does
	// today is NARROW an authenticated caller, never widen one — it runs after
	// scopes, so it can only subtract.
	if c.Mandate != "" {
		if gov, ok := gov.(MandateGovernor); ok {
			if err := gov.CheckMandate(ctx, c, tool); err != nil {
				res := &Result{}
				oc := outcomeForGovErr(err, ErrMandateDenied)
				finish(res, oc)
				if oc == OutcomeDenied {
					return res, err
				}
				return res, fmt.Errorf("%w: %v", ErrInternal, err)
			}
		}
	}

	// 3. quota
	if err := gov.CheckQuota(ctx, c, tool); err != nil {
		res := &Result{}
		oc := outcomeForGovErr(err, ErrQuotaExceeded)
		finish(res, oc)
		if oc == OutcomeDenied {
			return res, err
		}
		return res, fmt.Errorf("%w: %v", ErrInternal, err)
	}

	// 4. sandbox: cross-check the struct field AND the context flag so a
	// surface that forgets to denormalize the flag still fails safe.
	if (c.Sandbox || sandbox.IsFlagged(ctx)) && tool.WriteTier {
		res := &Result{Payload: sandboxPayload(tool)}
		finish(res, OutcomeSandboxed)
		return res, nil
	}

	// 4. send budget
	if tool.ChargesSend {
		if err := gov.AuthorizeSend(ctx, c, tool); err != nil {
			res := &Result{}
			oc := outcomeForGovErr(err, ErrBudgetExceeded)
			finish(res, oc)
			if oc == OutcomeDenied {
				return res, err
			}
			return res, fmt.Errorf("%w: %v", ErrInternal, err)
		}
	}

	// 5. approval gate for destructive tools
	if tool.Annotations.Destructive {
		pending, ref, err := gov.RequireApproval(ctx, c, tool, args)
		if err != nil {
			res := &Result{}
			finish(res, OutcomeError) // approval *errors* are infra, not policy
			return res, fmt.Errorf("%w: %v", ErrInternal, err)
		}
		if pending {
			res := &Result{ApprovalRef: ref}
			finish(res, OutcomePending)
			return res, nil
		}
	}

	// 6. context re-check (the gauntlet may have spanned a cancellation),
	// then run the handler with panic recovery.
	if err := ctx.Err(); err != nil {
		res := &Result{}
		finish(res, OutcomeCanceled)
		return res, err
	}
	payload, err := runHandler(ctx, tool, args)
	if err != nil {
		res := &Result{}
		finish(res, OutcomeError)
		if c.LLMFacing {
			return res, llmSafeHandlerError(tool, err)
		}
		return res, err
	}

	// 7. PII scrub for model-facing callers — fail closed on error so we
	// never emit an unscrubbed payload.
	if c.LLMFacing {
		scrubbed, serr := gov.ScrubResult(ctx, c, tool, payload)
		if serr != nil {
			res := &Result{}
			finish(res, OutcomeError)
			return res, fmt.Errorf("%w: %v", ErrScrubFailed, serr)
		}
		payload = scrubbed
	}

	// 8. audit + return
	res := &Result{Payload: payload}
	finish(res, OutcomeOK)
	return res, nil
}

// llmSafeHandlerError is the final model-context boundary for errors returned
// by a tool handler (including errors synthesized by runHandler after a
// panic). Handlers routinely wrap database, HTTP, and provider failures; none
// of that text is an API contract and it can contain schema names, request
// fragments, or credentials. Preserve only the stable error classification a
// surface needs for its existing wire mapping. Everything else is logged on
// the server and becomes the same generic ErrInternal sentinel.
func llmSafeHandlerError(tool *ToolSpec, err error) error {
	safe := llmSafeExecutionError(err)
	if safe != ErrInternal {
		return safe
	}
	toolName := ""
	if tool != nil {
		toolName = tool.Name
	}
	// Do not log err: the same arbitrary provider/DB text that is unsafe for a
	// model is unsafe for the default application log. The trace/audit outcome
	// and bounded tool name retain operational classification without payload.
	log.Printf("agenttools: LLM-facing tool handler failed (tool=%q class=internal_error)", toolName)
	return ErrInternal
}

// llmSafeExecutionError canonicalizes every error before it can cross an
// LLM-facing return, log adapter, or trace boundary. Internally generated
// typed argument/scope errors are bounded contracts; wrapped policy sentinels
// keep their classification without retaining wrapper text. All other detail
// collapses to ErrInternal.
func llmSafeExecutionError(err error) error {
	if err == nil {
		return nil
	}
	switch err.(type) {
	case *ScopeError, *ArgumentValidationError:
		return err
	}
	for _, sentinel := range []error{
		ErrUnknownTool,
		ErrNoHandler,
		ErrNoTenant,
		ErrScopeDenied,
		ErrInvalidArguments,
		ErrQuotaExceeded,
		ErrWriteTierReleaseHeld,
		ErrLLMDataEgressReleaseHeld,
		ErrMandateDenied,
		ErrBudgetExceeded,
		ErrScrubFailed,
		ErrInternal,
		context.Canceled,
		context.DeadlineExceeded,
	} {
		if errors.Is(err, sentinel) {
			return sentinel
		}
	}
	return ErrInternal
}

// runHandler invokes the tool handler, converting a panic into an error
// so a buggy handler produces an audited OutcomeError instead of crashing
// the request goroutine.
func runHandler(ctx context.Context, tool *ToolSpec, args json.RawMessage) (out any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("agenttools: handler %q panicked: %v", tool.Name, r)
			out = nil
		}
	}()
	return tool.Handler(ctx, args)
}

// outcomeForGovErr classifies a Governor error: a policy sentinel (the
// expected "denied" condition for that gate) maps to OutcomeDenied;
// anything else is an infrastructure failure and maps to OutcomeError.
// Either way the call does not run — both are fail-closed.
func outcomeForGovErr(err error, policySentinel error) Outcome {
	if errors.Is(err, policySentinel) {
		return OutcomeDenied
	}
	return OutcomeError
}

// sandboxPayload is the canonical result for a write-tier tool invoked by
// a sandbox-only key. It carries explicit not_executed markers so a model
// cannot read it as a real success.
func sandboxPayload(tool *ToolSpec) map[string]any {
	return map[string]any{
		"status":    "not_executed",
		"sandbox":   true,
		"simulated": true,
		"tool":      tool.Name,
		"message":   "sandbox key: the write was validated and accepted but NOT executed; no state changed and no email was sent",
	}
}

// NoopGovernor permits everything and records nothing. It is the default
// when a nil Governor is passed, and the baseline for tests.
type NoopGovernor struct{}

// LLMResultProtectionReady is deliberately false. NoopGovernor is useful for
// non-LLM unit/internal calls, but must never make a partially wired model-facing
// mount appear privacy-safe.
func (NoopGovernor) LLMResultProtectionReady() bool { return false }

func (NoopGovernor) CheckQuota(context.Context, Caller, *ToolSpec) error    { return nil }
func (NoopGovernor) AuthorizeSend(context.Context, Caller, *ToolSpec) error { return nil }
func (NoopGovernor) RequireApproval(context.Context, Caller, *ToolSpec, json.RawMessage) (bool, string, error) {
	return false, "", nil
}
func (NoopGovernor) ScrubResult(_ context.Context, _ Caller, _ *ToolSpec, result any) (any, error) {
	return result, nil
}
func (NoopGovernor) Audit(context.Context, Caller, *ToolSpec, Outcome, int) error { return nil }
