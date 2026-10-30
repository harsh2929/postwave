// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const tnt = "tenant-1"

// spyGov records the gauntlet steps it was asked to run and lets a test
// force a denial/failure at any one of them.
type spyGov struct {
	quotaErr       error
	sendErr        error
	approvePending bool
	approveRef     string
	approveErr     error
	scrub          func(any) any
	scrubErr       error
	auditErr       error
	steps          []string
	auditOutcome   Outcome
	audited        bool
}

func (g *spyGov) LLMResultProtectionReady() bool { return true }

func (g *spyGov) CheckQuota(context.Context, Caller, *ToolSpec) error {
	g.steps = append(g.steps, "quota")
	return g.quotaErr
}
func (g *spyGov) AuthorizeSend(context.Context, Caller, *ToolSpec) error {
	g.steps = append(g.steps, "send")
	return g.sendErr
}
func (g *spyGov) RequireApproval(context.Context, Caller, *ToolSpec, json.RawMessage) (bool, string, error) {
	g.steps = append(g.steps, "approval")
	return g.approvePending, g.approveRef, g.approveErr
}
func (g *spyGov) ScrubResult(_ context.Context, _ Caller, _ *ToolSpec, result any) (any, error) {
	g.steps = append(g.steps, "scrub")
	if g.scrubErr != nil {
		return nil, g.scrubErr
	}
	if g.scrub != nil {
		return g.scrub(result), nil
	}
	return result, nil
}
func (g *spyGov) Audit(_ context.Context, _ Caller, _ *ToolSpec, outcome Outcome, _ int) error {
	g.steps = append(g.steps, "audit")
	g.audited = true
	g.auditOutcome = outcome
	return g.auditErr
}

// regWith builds a one-tool registry; ran reports whether the handler ran.
func regWith(t *testing.T, spec ToolSpec, ran *bool) *Registry {
	t.Helper()
	if spec.InputSchema == nil {
		spec.InputSchema = json.RawMessage(`{"type":"object"}`)
	}
	spec.Handler = func(context.Context, json.RawMessage) (any, error) {
		*ran = true
		return map[string]any{"ok": true}, nil
	}
	r := NewRegistry()
	r.Register(spec)
	return r
}

func ctxScopes(scopes ...apikeys.Scope) context.Context {
	return apikeys.WithScopes(context.Background(), scopes)
}

func TestExecute_noTenantFailsClosed(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	_, err := Execute(ctxScopes(), r, &spyGov{}, Caller{ /* TenantID empty */ }, "stats", nil)
	if !errors.Is(err, ErrNoTenant) {
		t.Fatalf("want ErrNoTenant for blank tenant, got %v", err)
	}
	if ran {
		t.Fatal("handler must not run without a tenant")
	}
}

func TestExecute_unknownTool(t *testing.T) {
	r := NewRegistry()
	res, err := Execute(context.Background(), r, &spyGov{}, Caller{TenantID: tnt}, "nope", nil)
	if !errors.Is(err, ErrUnknownTool) {
		t.Fatalf("want ErrUnknownTool, got %v", err)
	}
	if res.Outcome != OutcomeError {
		t.Fatalf("want error outcome, got %s", res.Outcome)
	}
}

func TestExecute_surfaceIsolation(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "mcp_only", Description: "x", Annotations: Annotations{ReadOnly: true},
		Surfaces: []Surface{SurfaceMCP}}, &ran)
	g := &spyGov{}
	// Caller on the agent surface must not reach an MCP-only tool, and no
	// governance side-effects (quota/audit) may fire.
	_, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt, Surface: SurfaceAgent}, "mcp_only", nil)
	if !errors.Is(err, ErrUnknownTool) {
		t.Fatalf("want ErrUnknownTool for wrong surface, got %v", err)
	}
	if ran {
		t.Fatal("handler must not run for a tool not exposed on the surface")
	}
	if len(g.steps) != 0 {
		t.Fatalf("no governance step should run for a surface miss, got %v", g.steps)
	}
}

func TestExecute_scopeDeniedShortCircuits(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{
		Name: "subs_update", Category: CategoryAudience, Description: "x",
		WriteTier: true, RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
	}, &ran)
	g := &spyGov{}
	ctx := ctxScopes(apikeys.ScopeReadSubscribers) // missing write:subscribers
	res, err := Execute(ctx, r, g, Caller{TenantID: tnt}, "subs_update", nil)

	if !errors.Is(err, ErrScopeDenied) {
		t.Fatalf("want ErrScopeDenied, got %v", err)
	}
	var se *ScopeError
	if !errors.As(err, &se) || len(se.Missing) != 1 || se.Missing[0] != apikeys.ScopeWriteSubscribers {
		t.Fatalf("want ScopeError listing write:subscribers, got %v", err)
	}
	if ran {
		t.Fatal("handler must not run when scope is denied")
	}
	if got := g.steps; len(got) != 1 || got[0] != "audit" {
		t.Fatalf("want only [audit] (quota/send/approval not consulted), got %v", got)
	}
	if res.Outcome != OutcomeDenied || g.auditOutcome != OutcomeDenied {
		t.Fatalf("want denied outcome, got res=%s audit=%s", res.Outcome, g.auditOutcome)
	}
}

func TestExecuteInteractiveWriteTierReleaseHoldHasZeroSideEffects(t *testing.T) {
	for _, surface := range []Surface{SurfaceMCP, SurfaceAgent} {
		t.Run(string(surface), func(t *testing.T) {
			var ran bool
			r := regWith(t, ToolSpec{
				Name: "campaign_send", Description: "x", WriteTier: true,
				ChargesSend: true, Annotations: Annotations{Destructive: true, OpenWorld: true},
				RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			}, &ran)
			g := &spyGov{
				quotaErr:       errors.New("quota should not run"),
				sendErr:        errors.New("budget should not run"),
				approvePending: true,
				auditErr:       errors.New("audit should not run"),
			}
			res, err := Execute(
				ctxScopes(apikeys.ScopeWriteCampaigns),
				r,
				g,
				Caller{TenantID: tnt, Surface: surface},
				"campaign_send",
				json.RawMessage(`{}`),
			)
			if !errors.Is(err, ErrWriteTierReleaseHeld) {
				t.Fatalf("error=%v want ErrWriteTierReleaseHeld", err)
			}
			if ran {
				t.Fatal("held interactive write ran its handler")
			}
			if res == nil || res.Outcome != OutcomeDenied || res.Tool == nil {
				t.Fatalf("held result=%+v", res)
			}
			if len(g.steps) != 0 {
				t.Fatalf("held write produced governance side effects: %v", g.steps)
			}
		})
	}
}

func TestExecuteInteractiveWriteHoldPrecedesLLMGovernorComposition(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{
		Name: "campaign_send", Description: "x", WriteTier: true,
		Annotations: Annotations{Destructive: true, OpenWorld: true},
	}, &ran)
	res, err := Execute(ctxScopes(), r, nil, Caller{
		TenantID: tnt, Surface: SurfaceMCP, LLMFacing: true,
	}, "campaign_send", json.RawMessage(`{}`))
	if !errors.Is(err, ErrWriteTierReleaseHeld) {
		t.Fatalf("error=%v want ErrWriteTierReleaseHeld", err)
	}
	if ran || res == nil || res.Outcome != OutcomeDenied {
		t.Fatalf("held write ran or returned wrong result: ran=%v res=%+v", ran, res)
	}
}

func TestExecuteLLMDataEgressHoldHasZeroSideEffects(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{
		Name: "subscriber_profile", Description: "x", Annotations: Annotations{ReadOnly: true},
	}, &ran)
	g := &spyGov{quotaErr: errors.New("quota should not run"), auditErr: errors.New("audit should not run")}
	res, err := Execute(ctxScopes(), r, g, Caller{
		TenantID: tnt, Surface: SurfaceAgent, LLMFacing: true,
	}, "subscriber_profile", json.RawMessage(`{}`))
	if !errors.Is(err, ErrLLMDataEgressReleaseHeld) {
		t.Fatalf("error=%v want ErrLLMDataEgressReleaseHeld", err)
	}
	if ran || len(g.steps) != 0 {
		t.Fatalf("held read produced side effects: ran=%v steps=%v", ran, g.steps)
	}
	if res == nil || res.Outcome != OutcomeDenied || res.Tool == nil {
		t.Fatalf("held result=%+v", res)
	}
}

func TestExecuteValidatesArgumentsBeforeQuotaOrHandler(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{
		Name:        "report_read",
		Description: "x",
		Annotations: Annotations{ReadOnly: true},
		InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"limit":{"type":"integer","minimum":1,"maximum":10}},"required":["limit"]}`),
	}, &ran)
	g := &spyGov{}
	res, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt, Surface: SurfaceMCP}, "report_read", json.RawMessage(`{"limit":100,"extra":true}`))
	if !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("error=%v want ErrInvalidArguments", err)
	}
	if ran {
		t.Fatal("invalid arguments reached handler")
	}
	if res == nil || res.Outcome != OutcomeError {
		t.Fatalf("invalid argument result=%+v", res)
	}
	if got := g.steps; len(got) != 1 || got[0] != "audit" {
		t.Fatalf("validation must precede quota/budget/approval; steps=%v", got)
	}
}

func TestExecute_quotaDenied(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	g := &spyGov{quotaErr: ErrQuotaExceeded}
	res, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt}, "stats", nil)
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	if ran {
		t.Fatal("handler must not run when quota exceeded")
	}
	if res.Outcome != OutcomeDenied || g.auditOutcome != OutcomeDenied {
		t.Fatalf("quota policy denial should be OutcomeDenied, got %s", res.Outcome)
	}
}

func TestExecute_govInfraErrorIsErrorNotDenied(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	g := &spyGov{quotaErr: errors.New("db is down")} // NOT a policy sentinel
	res, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt}, "stats", nil)
	if err == nil || ran {
		t.Fatalf("infra error should refuse the call: err=%v ran=%v", err, ran)
	}
	if res.Outcome != OutcomeError {
		t.Fatalf("a non-sentinel governor error must be OutcomeError, got %s", res.Outcome)
	}
	// Infra errors are wrapped in ErrInternal (so surfaces return a generic
	// frame and never leak raw internal detail) — and are NOT the policy
	// sentinel.
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("infra error should wrap ErrInternal, got %v", err)
	}
	if errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("infra error must not masquerade as the quota policy sentinel")
	}
}

func TestExecute_sandboxSimulatesWrite(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{
		Name: "subs_update", Description: "x", WriteTier: true,
		RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
	}, &ran)
	g := &spyGov{}
	ctx := ctxScopes(apikeys.ScopeWriteSubscribers)
	res, err := Execute(ctx, r, g, Caller{TenantID: tnt, Sandbox: true}, "subs_update", nil)
	if err != nil {
		t.Fatalf("sandbox write should not error: %v", err)
	}
	if ran {
		t.Fatal("handler must not run for a sandbox key")
	}
	if !res.IsSandboxed() {
		t.Fatalf("want sandboxed result, got %+v", res)
	}
	payload, _ := res.Payload.(map[string]any)
	if payload["simulated"] != true || payload["status"] != "not_executed" {
		t.Fatalf("want simulated/not_executed payload, got %v", res.Payload)
	}
	for _, s := range g.steps {
		if s == "send" {
			t.Fatal("send budget should not run for a sandboxed write")
		}
	}
}

func TestExecute_sandboxFlagFromContext(t *testing.T) {
	// A surface that forgets to set Caller.Sandbox must still simulate when
	// the context carries the sandbox flag (the cross-check).
	var ran bool
	r := regWith(t, ToolSpec{Name: "subs_update", Description: "x", WriteTier: true,
		RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers}}, &ran)
	ctx := sandbox.WithFlag(ctxScopes(apikeys.ScopeWriteSubscribers))
	res, err := Execute(ctx, r, &spyGov{}, Caller{TenantID: tnt /* Sandbox false! */}, "subs_update", nil)
	if err != nil || ran {
		t.Fatalf("ctx sandbox flag should simulate the write: err=%v ran=%v", err, ran)
	}
	if !res.IsSandboxed() {
		t.Fatalf("want sandboxed via ctx flag, got %s", res.Outcome)
	}
}

func TestExecute_sandboxReadRunsNormally(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	_, err := Execute(ctxScopes(), r, &spyGov{}, Caller{TenantID: tnt, Sandbox: true}, "stats", nil)
	if err != nil {
		t.Fatalf("read in sandbox should run: %v", err)
	}
	if !ran {
		t.Fatal("read-only handler should run even for sandbox keys")
	}
}

func TestExecute_sendBudgetDenied(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{
		Name: "campaign_send", Description: "x", WriteTier: true, ChargesSend: true,
		Annotations:    Annotations{OpenWorld: true},
		RequiredScopes: []apikeys.Scope{apikeys.ScopeSendTransactional},
	}, &ran)
	g := &spyGov{sendErr: ErrBudgetExceeded}
	ctx := ctxScopes(apikeys.ScopeSendTransactional)
	res, err := Execute(ctx, r, g, Caller{TenantID: tnt}, "campaign_send", nil)
	if !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("want ErrBudgetExceeded, got %v", err)
	}
	if ran || res.Outcome != OutcomeDenied {
		t.Fatalf("send budget denial: ran=%v outcome=%s", ran, res.Outcome)
	}
}

func TestExecute_destructivePendingApproval(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{
		Name: "api_key_revoke", Description: "x", WriteTier: true,
		Annotations:    Annotations{Destructive: true},
		RequiredScopes: []apikeys.Scope{apikeys.ScopeAdmin},
	}, &ran)
	g := &spyGov{approvePending: true, approveRef: "appr_1"}
	ctx := ctxScopes(apikeys.ScopeAdmin)
	res, err := Execute(ctx, r, g, Caller{TenantID: tnt}, "api_key_revoke", nil)
	if err != nil {
		t.Fatalf("pending approval should not error: %v", err)
	}
	if ran {
		t.Fatal("destructive handler must not run while approval is pending")
	}
	if !res.IsPending() || res.ApprovalRef != "appr_1" {
		t.Fatalf("want pending result with ref, got %+v", res)
	}
}

func TestExecute_happyPathScrubsForLLM(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "subs_search", Description: "x", LLMOutputSafe: true, Annotations: Annotations{ReadOnly: true},
		RequiredScopes: []apikeys.Scope{apikeys.ScopeReadSubscribers}}, &ran)
	scrubbed := map[string]any{"redacted": true}
	g := &spyGov{scrub: func(any) any { return scrubbed }}
	ctx := ctxScopes(apikeys.ScopeReadSubscribers)
	res, err := Execute(ctx, r, g, Caller{TenantID: tnt, LLMFacing: true}, "subs_search", nil)
	if err != nil {
		t.Fatalf("happy path errored: %v", err)
	}
	if !ran || res.Outcome != OutcomeOK {
		t.Fatalf("want ran + ok, got ran=%v outcome=%s", ran, res.Outcome)
	}
	if p, _ := res.Payload.(map[string]any); p["redacted"] != true {
		t.Fatalf("want scrubbed payload, got %v", res.Payload)
	}
	want := []string{"quota", "scrub", "audit"}
	for i, w := range want {
		if i >= len(g.steps) || g.steps[i] != w {
			t.Fatalf("step order %v, want prefix %v", g.steps, want)
		}
	}
}

func TestExecuteLLMFacingCallRequiresProtectedGovernor(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "subscriber_profile", Description: "x", LLMOutputSafe: true, Annotations: Annotations{ReadOnly: true}}, &ran)
	for _, governor := range []Governor{nil, NoopGovernor{}} {
		res, err := Execute(ctxScopes(), r, governor, Caller{TenantID: tnt, Surface: SurfaceMCP, LLMFacing: true}, "subscriber_profile", json.RawMessage(`{}`))
		if !errors.Is(err, ErrInternal) {
			t.Fatalf("governor=%T error=%v want ErrInternal", governor, err)
		}
		if ran {
			t.Fatalf("governor=%T allowed unsanitized handler", governor)
		}
		if res == nil || res.Outcome != OutcomeError {
			t.Fatalf("governor=%T result=%+v", governor, res)
		}
	}
}

func TestExecute_scrubFailureFailsClosed(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "subs_search", Description: "x", LLMOutputSafe: true, Annotations: Annotations{ReadOnly: true}}, &ran)
	g := &spyGov{scrubErr: errors.New("pii service down")}
	res, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt, LLMFacing: true}, "subs_search", nil)
	if !errors.Is(err, ErrScrubFailed) {
		t.Fatalf("want ErrScrubFailed, got %v", err)
	}
	if res.Payload != nil {
		t.Fatal("unscrubbed payload must NOT leak when scrubbing fails")
	}
	if res.Outcome != OutcomeError {
		t.Fatalf("want OutcomeError, got %s", res.Outcome)
	}
}

func TestExecute_nonLLMSkipsScrub(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	g := &spyGov{scrub: func(any) any { return "SCRUBBED" }}
	res, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt, LLMFacing: false}, "stats", nil)
	if err != nil {
		t.Fatalf("errored: %v", err)
	}
	for _, s := range g.steps {
		if s == "scrub" {
			t.Fatal("scrub must not run for non-LLM callers")
		}
	}
	if res.Payload == "SCRUBBED" {
		t.Fatal("payload should not be scrubbed for non-LLM callers")
	}
}

func TestExecute_canceledContext(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	ctx, cancel := context.WithCancel(ctxScopes())
	cancel()
	res, err := Execute(ctx, r, &spyGov{}, Caller{TenantID: tnt}, "stats", nil)
	if err == nil || ran {
		t.Fatalf("cancelled context should not run handler: err=%v ran=%v", err, ran)
	}
	if res.Outcome != OutcomeCanceled {
		t.Fatalf("want OutcomeCanceled, got %s", res.Outcome)
	}
}

func TestExecute_handlerPanicRecovered(t *testing.T) {
	r := NewRegistry()
	r.Register(ToolSpec{Name: "boom", Description: "x", InputSchema: json.RawMessage(`{"type":"object"}`),
		Annotations: Annotations{ReadOnly: true},
		Handler:     func(context.Context, json.RawMessage) (any, error) { panic("kaboom") }})
	g := &spyGov{}
	res, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt}, "boom", nil)
	if err == nil {
		t.Fatal("a panicking handler must surface as an error, not crash")
	}
	if res.Outcome != OutcomeError || !g.audited || g.auditOutcome != OutcomeError {
		t.Fatalf("panic should be audited as OutcomeError, got res=%s audited=%v", res.Outcome, g.audited)
	}
}

func TestExecuteLLMFacingHandlerErrorIsSanitized(t *testing.T) {
	var logs bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousWriter) })
	r := NewRegistry()
	r.Register(ToolSpec{
		Name: "aggregate", Description: "x", LLMOutputSafe: true,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Annotations: Annotations{ReadOnly: true},
		Handler: func(context.Context, json.RawMessage) (any, error) {
			return nil, fmt.Errorf("load aggregate: %w", errors.New(`pq: relation tenant_private.events does not exist`))
		},
	})
	res, err := Execute(ctxScopes(), r, &spyGov{}, Caller{
		TenantID: tnt, Surface: SurfaceMCP, LLMFacing: true,
	}, "aggregate", nil)
	if err != ErrInternal {
		t.Fatalf("LLM handler error=%v want canonical ErrInternal", err)
	}
	if strings.Contains(err.Error(), "tenant_private") || res == nil || res.Outcome != OutcomeError {
		t.Fatalf("private handler detail escaped or result drifted: res=%+v err=%v", res, err)
	}
	if strings.Contains(logs.String(), "tenant_private") || strings.Contains(logs.String(), "does not exist") {
		t.Fatalf("private handler detail escaped to logs: %q", logs.String())
	}
}

func TestExecuteLLMFacingHandlerPanicIsSanitized(t *testing.T) {
	var logs bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousWriter) })
	r := NewRegistry()
	r.Register(ToolSpec{
		Name: "aggregate", Description: "x", LLMOutputSafe: true,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Annotations: Annotations{ReadOnly: true},
		Handler: func(context.Context, json.RawMessage) (any, error) {
			panic("postgres password=private panic detail")
		},
	})
	res, err := Execute(ctxScopes(), r, &spyGov{}, Caller{
		TenantID: tnt, Surface: SurfaceAgent, LLMFacing: true,
	}, "aggregate", nil)
	if err != ErrInternal {
		t.Fatalf("LLM panic error=%v want canonical ErrInternal", err)
	}
	if strings.Contains(err.Error(), "password") || res == nil || res.Outcome != OutcomeError {
		t.Fatalf("panic detail escaped or result drifted: res=%+v err=%v", res, err)
	}
	if strings.Contains(logs.String(), "password") || strings.Contains(logs.String(), "panic detail") {
		t.Fatalf("panic detail escaped to logs: %q", logs.String())
	}
}

func TestExecuteLLMFacingHandlerPreservesKnownSentinelMappingWithoutWrapperText(t *testing.T) {
	r := NewRegistry()
	r.Register(ToolSpec{
		Name: "aggregate", Description: "x", LLMOutputSafe: true,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Annotations: Annotations{ReadOnly: true},
		Handler: func(context.Context, json.RawMessage) (any, error) {
			return nil, fmt.Errorf("private validation detail: %w", ErrInvalidArguments)
		},
	})
	_, err := Execute(ctxScopes(), r, &spyGov{}, Caller{
		TenantID: tnt, Surface: SurfaceMCP, LLMFacing: true,
	}, "aggregate", nil)
	if err != ErrInvalidArguments || !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("known handler sentinel mapping drifted: %v", err)
	}
	if strings.Contains(err.Error(), "private validation") {
		t.Fatalf("known sentinel retained wrapper text: %v", err)
	}
}

func TestExecuteNonLLMHandlerErrorRemainsAvailableToTrustedCaller(t *testing.T) {
	privateErr := errors.New("trusted internal diagnostic")
	r := NewRegistry()
	r.Register(ToolSpec{
		Name: "aggregate", Description: "x",
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Annotations: Annotations{ReadOnly: true},
		Handler: func(context.Context, json.RawMessage) (any, error) {
			return nil, privateErr
		},
	})
	_, err := Execute(ctxScopes(), r, &spyGov{}, Caller{TenantID: tnt}, "aggregate", nil)
	if !errors.Is(err, privateErr) {
		t.Fatalf("trusted non-LLM diagnostic was unexpectedly rewritten: %v", err)
	}
}

func TestExecuteLLMFacingInfrastructureErrorsAreSanitizedBeforeTraceAndLogs(t *testing.T) {
	tests := []struct {
		name string
		spec ToolSpec
		gov  *spyGov
		want error
	}{
		{
			name: "quota",
			spec: ToolSpec{Name: "aggregate", Description: "x", LLMOutputSafe: true, Annotations: Annotations{ReadOnly: true}},
			gov:  &spyGov{quotaErr: errors.New("postgres password=quota-secret")},
			want: ErrInternal,
		},
		{
			name: "send budget",
			spec: ToolSpec{Name: "send", Description: "x", LLMOutputSafe: true, WriteTier: true, ChargesSend: true, Annotations: Annotations{OpenWorld: true}},
			gov:  &spyGov{sendErr: errors.New("redis password=budget-secret")},
			want: ErrInternal,
		},
		{
			name: "approval",
			spec: ToolSpec{Name: "destroy", Description: "x", LLMOutputSafe: true, WriteTier: true, Annotations: Annotations{Destructive: true}},
			gov:  &spyGov{approveErr: errors.New("postgres password=approval-secret")},
			want: ErrInternal,
		},
		{
			name: "scrubber",
			spec: ToolSpec{Name: "scrub", Description: "x", LLMOutputSafe: true, Annotations: Annotations{ReadOnly: true}},
			gov:  &spyGov{scrubErr: errors.New("provider token=scrub-secret")},
			want: ErrScrubFailed,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			previousWriter := log.Writer()
			log.SetOutput(&logs)
			defer log.SetOutput(previousWriter)

			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			previousTracer := tracer
			tracer = provider.Tracer("agenttools-sanitization-test")
			defer func() {
				tracer = previousTracer
				_ = provider.Shutdown(context.Background())
			}()

			var ran bool
			reg := regWith(t, tc.spec, &ran)
			_, err := Execute(ctxScopes(), reg, tc.gov, Caller{
				TenantID: tnt, LLMFacing: true,
			}, tc.spec.Name, nil)
			if err != tc.want {
				t.Fatalf("error=%v want canonical %v", err, tc.want)
			}
			for _, secret := range []string{"password", "quota-secret", "budget-secret", "approval-secret", "token=", "scrub-secret"} {
				if strings.Contains(err.Error(), secret) || strings.Contains(logs.String(), secret) {
					t.Fatalf("secret %q escaped through error/log: err=%v logs=%q", secret, err, logs.String())
				}
			}
			ended := recorder.Ended()
			if len(ended) != 1 {
				t.Fatalf("ended spans=%d want=1", len(ended))
			}
			traceText := ended[0].Status().Description
			for _, event := range ended[0].Events() {
				traceText += " " + event.Name
				for _, attr := range event.Attributes {
					traceText += " " + string(attr.Key) + "=" + attr.Value.String()
				}
			}
			for _, secret := range []string{"password", "quota-secret", "budget-secret", "approval-secret", "token=", "scrub-secret"} {
				if strings.Contains(traceText, secret) {
					t.Fatalf("secret %q escaped to trace: %q", secret, traceText)
				}
			}
		})
	}
}

func TestDefaultAuditFallbackDoesNotLogSinkErrorText(t *testing.T) {
	var logs bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(previousWriter)

	var ran bool
	r := regWith(t, ToolSpec{Name: "aggregate", Description: "x", LLMOutputSafe: true, Annotations: Annotations{ReadOnly: true}}, &ran)
	res, err := Execute(ctxScopes(), r, &spyGov{auditErr: errors.New("postgres password=audit-secret")}, Caller{
		TenantID: tnt, LLMFacing: true,
	}, "aggregate", nil)
	if err != nil || res == nil || res.Outcome != OutcomeOK {
		t.Fatalf("successful read drifted: res=%+v err=%v", res, err)
	}
	if strings.Contains(logs.String(), "password") || strings.Contains(logs.String(), "audit-secret") {
		t.Fatalf("audit sink detail escaped to logs: %q", logs.String())
	}
	if !strings.Contains(logs.String(), "governance record dropped") {
		t.Fatalf("bounded audit failure signal missing: %q", logs.String())
	}
}

func TestExecuteUnknownCallerToolNameNeverEntersTrace(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previousTracer := tracer
	tracer = provider.Tracer("agenttools-name-sanitization-test")
	defer func() {
		tracer = previousTracer
		_ = provider.Shutdown(context.Background())
	}()

	secretName := "password=private-secret"
	_, err := Execute(ctxScopes(), NewRegistry(), &spyGov{}, Caller{
		TenantID: tnt, Surface: SurfaceMCP, LLMFacing: true,
	}, secretName, nil)
	if err != ErrUnknownTool {
		t.Fatalf("error=%v want ErrUnknownTool", err)
	}
	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("ended spans=%d want=1", len(ended))
	}
	traceText := ended[0].Name() + " " + ended[0].Status().Description
	for _, attr := range ended[0].Attributes() {
		traceText += " " + string(attr.Key) + "=" + attr.Value.String()
	}
	if strings.Contains(traceText, secretName) || strings.Contains(traceText, "private-secret") {
		t.Fatalf("caller tool name escaped to trace: %q", traceText)
	}
	if !strings.Contains(traceText, "unknown_tool") {
		t.Fatalf("bounded unknown-tool trace identity missing: %q", traceText)
	}
}

func TestExecute_auditFailureGoesToFallback(t *testing.T) {
	// A dropped audit row must never be completely silent: it routes to
	// the guaranteed fallback sink, and the call still succeeds (audit is
	// best-effort for the happy path, not a hard gate on reads).
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	orig := auditFallback
	defer func() { auditFallback = orig }()
	var captured error
	auditFallback = func(err error) { captured = err }

	g := &spyGov{auditErr: errors.New("audit sink unreachable")}
	res, err := Execute(ctxScopes(), r, g, Caller{TenantID: tnt}, "stats", nil)
	if err != nil || res.Outcome != OutcomeOK {
		t.Fatalf("read should still succeed when audit fails: err=%v outcome=%s", err, res.Outcome)
	}
	if captured == nil {
		t.Fatal("audit failure must be routed to the fallback sink, not swallowed")
	}
}

func TestExecute_nilGovernorUsesNoop(t *testing.T) {
	var ran bool
	r := regWith(t, ToolSpec{Name: "stats", Description: "x", Annotations: Annotations{ReadOnly: true}}, &ran)
	res, err := Execute(ctxScopes(), r, nil, Caller{TenantID: tnt}, "stats", nil)
	if err != nil || !ran || res.Outcome != OutcomeOK {
		t.Fatalf("nil governor should permit: err=%v ran=%v outcome=%s", err, ran, res.Outcome)
	}
}
