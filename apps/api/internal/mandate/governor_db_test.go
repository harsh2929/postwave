// SPDX-License-Identifier: AGPL-3.0-only

package mandate

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
)

// The mandate must bound the agent surface, not merely exist beside it.
//
// `agenttools.Execute` is the one governed path every surface calls, and its
// package doc exists because governance used to be wired per-surface and the
// native MCP write path would have inherited none of it. A mandate that is not a
// step in that gauntlet repeats exactly that mistake.

type passGovernor struct{ audited []agenttools.Outcome }

func (g *passGovernor) CheckQuota(context.Context, agenttools.Caller, *agenttools.ToolSpec) error {
	return nil
}
func (g *passGovernor) AuthorizeSend(context.Context, agenttools.Caller, *agenttools.ToolSpec) error {
	return nil
}
func (g *passGovernor) RequireApproval(context.Context, agenttools.Caller, *agenttools.ToolSpec, json.RawMessage) (bool, string, error) {
	return false, "", nil
}
func (g *passGovernor) ScrubResult(_ context.Context, _ agenttools.Caller, _ *agenttools.ToolSpec, result any) (any, error) {
	return result, nil
}
func (g *passGovernor) Audit(_ context.Context, _ agenttools.Caller, _ *agenttools.ToolSpec, outcome agenttools.Outcome, _ int) error {
	g.audited = append(g.audited, outcome)
	return nil
}

// gatedGovernor is passGovernor PLUS the mandate gate, which is how a surface
// that has adopted mandates is wired.
type gatedGovernor struct {
	passGovernor
	gate *ToolGate
}

func (g *gatedGovernor) CheckMandate(ctx context.Context, c agenttools.Caller, tool *agenttools.ToolSpec) error {
	return g.gate.CheckMandate(ctx, c, tool)
}

func toolRegistry(t *testing.T, name string) (*agenttools.Registry, int) {
	t.Helper()
	calls := 0
	reg := agenttools.NewRegistry()
	reg.Register(agenttools.ToolSpec{
		Name:        name,
		Description: "test tool",
		InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`),
		Handler: func(context.Context, json.RawMessage) (any, error) {
			calls++
			return map[string]any{"ok": true}, nil
		},
	})
	return reg, calls
}

func TestAMandateBoundsWhichToolsAnAgentMayRun(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	m, err := repo.Mint(ctx, tenantID, userID, Grant{
		Purpose:   "suppress bounced subscribers",
		Actions:   []string{"subscribers_suppress"},
		Resources: []string{"tool:subscribers_suppress"},
		Uses:      2,
		TTL:       time.Hour,
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	reg, _ := toolRegistry(t, "subscribers_suppress")
	gov := &gatedGovernor{gate: &ToolGate{Repo: repo}}
	caller := agenttools.Caller{TenantID: tenantID, ActorType: "agent", Mandate: m.Token}

	// The granted tool runs.
	if _, err := agenttools.Execute(ctx, reg, gov, caller, "subscribers_suppress", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("the granted tool was denied: %v", err)
	}

	// A tool the mandate does not name is refused — even though the API key
	// behind the caller could run it.
	other, _ := toolRegistry(t, "subscribers_delete")
	if _, err := agenttools.Execute(ctx, other, gov, caller, "subscribers_delete", json.RawMessage(`{}`)); err == nil {
		t.Fatal("a tool the mandate does not name was executed. The agent still " +
			"holds the whole tenant key's authority, which is the state mandates " +
			"exist to end.")
	}
}

// The budget bounds the agent even for a tool it IS allowed to run.
func TestTheMandateBudgetStopsTheAgentMidTask(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	m, err := repo.Mint(ctx, tenantID, userID, Grant{
		Purpose: "suppress two", Actions: []string{"subscribers_suppress"},
		Resources: []string{"tool:subscribers_suppress"}, Uses: 2, TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	reg, _ := toolRegistry(t, "subscribers_suppress")
	gov := &gatedGovernor{gate: &ToolGate{Repo: repo}}
	caller := agenttools.Caller{TenantID: tenantID, ActorType: "agent", Mandate: m.Token}

	for i := 0; i < 2; i++ {
		if _, err := agenttools.Execute(ctx, reg, gov, caller, "subscribers_suppress", json.RawMessage(`{}`)); err != nil {
			t.Fatalf("call %d denied: %v", i+1, err)
		}
	}
	if _, err := agenttools.Execute(ctx, reg, gov, caller, "subscribers_suppress", json.RawMessage(`{}`)); err == nil {
		t.Fatal("the third call on a two-use mandate ran; the budget does not " +
			"reach the tool path")
	}
}

// A caller with NO mandate is unchanged. Failing closed here would take every
// existing agent surface offline for a control nothing has issued yet.
func TestACallerWithoutAMandateIsUnaffected(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, _ := seedMandateTenant(t, pool)
	reg, _ := toolRegistry(t, "subscribers_suppress")
	gov := &gatedGovernor{gate: &ToolGate{Repo: &Repo{Pool: pool}}}

	caller := agenttools.Caller{TenantID: tenantID, ActorType: "api_key"} // no Mandate
	if _, err := agenttools.Execute(ctx, reg, gov, caller, "subscribers_suppress", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("a caller with no mandate was refused: %v", err)
	}
}

// An unwired store must DENY a caller that presented a mandate. It expected to
// be bounded; running unbounded because the store is missing is the failure.
func TestAPresentedMandateWithNoStoreIsDenied(t *testing.T) {
	ctx := context.Background()
	reg, _ := toolRegistry(t, "subscribers_suppress")
	gov := &gatedGovernor{gate: &ToolGate{Repo: nil}}
	caller := agenttools.Caller{TenantID: uuid.NewString(), ActorType: "agent", Mandate: "something"}

	_, err := agenttools.Execute(ctx, reg, gov, caller, "subscribers_suppress", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("a mandate-bearing call ran with no mandate store; the agent " +
			"believed it was bounded and was not")
	}
	if !errors.Is(err, agenttools.ErrMandateDenied) {
		t.Errorf("err = %v, want a mandate denial", err)
	}
}

// The mandate gate runs BEFORE quota. Consuming a per-tool quota for a call the
// mandate was never going to permit lets an agent burn somebody else's budget
// by asking for things it is not allowed to do.
type quotaCountingGovernor struct {
	gatedGovernor
	quotaChecks int
}

func (g *quotaCountingGovernor) CheckQuota(context.Context, agenttools.Caller, *agenttools.ToolSpec) error {
	g.quotaChecks++
	return nil
}

func TestADeniedMandateDoesNotConsumeQuota(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	tenantID, userID := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	m, err := repo.Mint(ctx, tenantID, userID, Grant{
		Purpose: "one tool only", Actions: []string{"subscribers_suppress"},
		Resources: []string{"tool:subscribers_suppress"}, Uses: 1, TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	reg, _ := toolRegistry(t, "subscribers_delete")
	gov := &quotaCountingGovernor{gatedGovernor: gatedGovernor{gate: &ToolGate{Repo: repo}}}
	caller := agenttools.Caller{TenantID: tenantID, ActorType: "agent", Mandate: m.Token}

	if _, err := agenttools.Execute(ctx, reg, gov, caller, "subscribers_delete", json.RawMessage(`{}`)); err == nil {
		t.Fatal("an ungranted tool ran")
	}
	if gov.quotaChecks != 0 {
		t.Fatalf("quota was checked %d time(s) for a call the mandate refused; an "+
			"agent can burn the tenant's quota by asking for things it may not do",
			gov.quotaChecks)
	}
}

// A mandate minted for one tenant must not authorise a call made as another.
//
// Written because a mutation removing the tenant comparison failed nothing: the
// case was simply not covered. It is reachable only through a wiring mistake —
// a caller assembled with one tenant and a mandate token from another — which is
// exactly the kind of mistake that has to fail rather than execute cross-tenant.
func TestAMandateFromAnotherTenantIsRefused(t *testing.T) {
	pool := mandatePool(t)
	ctx := context.Background()
	ownerTenant, ownerUser := seedMandateTenant(t, pool)
	otherTenant, _ := seedMandateTenant(t, pool)
	repo := &Repo{Pool: pool}

	m, err := repo.Mint(ctx, ownerTenant, ownerUser, Grant{
		Purpose: "owner's task", Actions: []string{"subscribers_suppress"},
		Resources: []string{"tool:subscribers_suppress"}, Uses: 5, TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	reg, _ := toolRegistry(t, "subscribers_suppress")
	gov := &gatedGovernor{gate: &ToolGate{Repo: repo}}
	// The token is valid; the caller claims a DIFFERENT tenant.
	caller := agenttools.Caller{TenantID: otherTenant, ActorType: "agent", Mandate: m.Token}

	if _, err := agenttools.Execute(ctx, reg, gov, caller, "subscribers_suppress", json.RawMessage(`{}`)); err == nil {
		t.Fatal("a mandate minted for one tenant authorised a call made as " +
			"another; the grant crossed a tenant boundary")
	}
}
