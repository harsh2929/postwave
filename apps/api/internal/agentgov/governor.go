// SPDX-License-Identifier: AGPL-3.0-only
//
// Package agentgov is the production implementation of
// agenttools.Governor: it binds the canonical tool-execution chokepoint
// to Moosewave's governance systems (per-key send budgets, human approval
// gates, and the cross-surface audit log). The old MCP per-tool quota path is
// structurally held because its usage rows are not server-attributed to the
// native tool invocation.
//
// It is constructed once in main.go and injected into every agent
// surface (the native MCP server, and the in-app agent) so the
// governance posture is identical and defined in one place. The package
// imports the governance systems directly; nothing imports it, so there
// is no cycle.
package agentgov

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/budgets"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// QuotaChecker is the legacy advisory per-tool counter. Satisfied by
// *apikeycalls.Repo. It must not be treated as an enforcement primitive for
// native MCP until recording and reservation are atomic and server-attributed.
type QuotaChecker interface {
	CheckQuota(ctx context.Context, tenantID, toolName string) (exceeded bool, dailyLimit, usedToday int, err error)
}

// NativeMCPPerToolQuotaReleased is a structural release boundary. The outer
// HTTP recorder sees only POST /mcp/rpc (and an untrusted optional tool
// header), while this governor checks the inner native tool name. Consequently
// existing rows cannot authoritatively count native invocations and stale
// configured limits must not deny or advertise protection for this surface.
const NativeMCPPerToolQuotaReleased = false

// Deps wires the governor to the runtime. Any field may be nil, which
// disables that gate (useful in dev / tests) — but main.go must wire all
// of them before any write-tier tool is enabled, which Validate-time and
// the EnsureWritable check enforce.
type Deps struct {
	// Budgets enforces + charges the per-key send budget. nil => no
	// send-budget enforcement.
	Budgets budgets.Checker
	// Quotas is advisory for MCP while NativeMCPPerToolQuotaReleased is false.
	// Other surfaces retain their existing behavior.
	Quotas QuotaChecker
	// Approvals gates destructive tools behind human approval. nil => no
	// approval gate (destructive tools would run immediately).
	Approvals *approvals.Service
	// Pool backs the cross-surface audit_log emission. nil => no audit.
	Pool *db.Pool
}

// Governor implements agenttools.Governor.
type Governor struct {
	d   Deps
	now func() time.Time
}

// New builds the production governor.
func New(d Deps) *Governor { return &Governor{d: d, now: time.Now} }

var _ agenttools.Governor = (*Governor)(nil)

// CheckQuota enforces per-tool quota only on surfaces whose recorder can
// authoritatively attribute the same invocation name. Native MCP is held until
// a server-owned atomic reservation replaces the asynchronous/coarse HTTP row.
func (g *Governor) CheckQuota(ctx context.Context, c agenttools.Caller, tool *agenttools.ToolSpec) error {
	if c.Surface == agenttools.SurfaceMCP && !NativeMCPPerToolQuotaReleased {
		return nil
	}
	if g.d.Quotas == nil || c.TenantID == "" {
		return nil
	}
	exceeded, _, _, err := g.d.Quotas.CheckQuota(ctx, c.TenantID, tool.Name)
	if err != nil {
		return fmt.Errorf("agentgov: quota check for %q: %w", tool.Name, err)
	}
	if exceeded {
		return agenttools.ErrQuotaExceeded
	}
	return nil
}

// AuthorizeSend pre-flights the per-key send budget for send-charging
// tools (the actual charge happens in Audit on success, mirroring the
// REST middleware's check-before / increment-on-2xx pattern). This is
// what makes send-budget enforcement work on the MCP path, which the
// URL-path classifier silently skipped.
func (g *Governor) AuthorizeSend(ctx context.Context, c agenttools.Caller, _ *agenttools.ToolSpec) error {
	if g.d.Budgets == nil || c.APIKeyID == "" {
		return nil
	}
	if err := budgets.Check(ctx, g.d.Budgets, c.APIKeyID, budgets.ResourceSends, 1); err != nil {
		if _, ok := budgets.IsBudgetExceeded(err); ok {
			return agenttools.ErrBudgetExceeded
		}
		return fmt.Errorf("agentgov: send budget check: %w", err)
	}
	return nil
}

// RequireApproval queues a destructive tool for human approval and
// reports pending=true so the chokepoint does not execute it now. With
// no approvals service wired the tool runs immediately (dev only).
func (g *Governor) RequireApproval(ctx context.Context, c agenttools.Caller, tool *agenttools.ToolSpec, _ json.RawMessage) (bool, string, error) {
	if g.d.Approvals == nil || c.TenantID == "" {
		return false, "", nil
	}
	var keyID *string
	if c.APIKeyID != "" {
		keyID = &c.APIKeyID
	}
	appr, err := g.d.Approvals.Request(ctx, c.TenantID,
		approvals.Resource{Type: resourceTypeFor(tool), ID: tool.Name},
		approvals.Actor{Type: firstNonEmpty(c.ActorType, "agent"), Label: c.ActorLabel, APIKeyID: keyID})
	if err != nil {
		return false, "", fmt.Errorf("agentgov: request approval for %q: %w", tool.Name, err)
	}
	return true, appr.ID, nil
}

// LLMResultProtectionReady marks this production governor as carrying the
// conservative result privacy firewall used by every model-facing tool call.
func (g *Governor) LLMResultProtectionReady() bool { return g != nil }

// ScrubResult removes direct/contact PII and arbitrary profile/event payloads
// before a tool result reaches an external or in-app model. API-key scopes
// authorize the server-side query; they are not consent to copy raw subscriber
// PII into a third-party model context.
func (g *Governor) ScrubResult(_ context.Context, c agenttools.Caller, _ *agenttools.ToolSpec, result any) (any, error) {
	if c.TenantID == "" {
		return nil, errors.New("agentgov: result scrub requires tenant")
	}
	return scrubLLMResult(result)
}

// Audit charges the send budget on a successful send-tool, then emits the
// per-tool cross-surface audit_log row (giving the audit trail per-tool
// granularity, which mcp_server_call_log alone lacked). Best-effort: a
// failed audit write is logged by EmitOrLog, never blocks the call.
func (g *Governor) Audit(ctx context.Context, c agenttools.Caller, tool *agenttools.ToolSpec, outcome agenttools.Outcome, latencyMs int) error {
	if outcome == agenttools.OutcomeOK && tool.ChargesSend && g.d.Budgets != nil && c.APIKeyID != "" {
		if b, err := g.d.Budgets.LoadBudget(ctx, c.APIKeyID); err == nil && b != nil {
			_ = g.d.Budgets.IncrementUsage(ctx, b, budgets.ResourceSends, 1, g.now().UTC())
		}
	}
	if g.d.Pool != nil {
		// The outcome blob goes in the metadata slot (last arg), not the
		// before/after slots which are for resource state diffs.
		audit.EmitOrLog(ctx, g.d.Pool,
			"agent.tool."+tool.Name, "agent_tool", tool.Name,
			nil, nil,
			map[string]any{
				"outcome":    string(outcome),
				"latency_ms": latencyMs,
				"surface":    string(c.Surface),
				"write_tier": tool.WriteTier,
				"sandbox":    c.Sandbox,
			})
	}
	return nil
}

// resourceTypeFor maps a tool's category onto the closest approvals
// ResourceType. Campaign-class tools map to campaign; everything else to
// the generic automation_send gate.
func resourceTypeFor(tool *agenttools.ToolSpec) approvals.ResourceType {
	switch tool.Category {
	case agenttools.CategoryCampaigns:
		return approvals.ResourceCampaign
	case agenttools.CategoryAutomation:
		return approvals.ResourceAutomationSend
	default:
		return approvals.ResourceAutomationSend
	}
}

func firstNonEmpty(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}
