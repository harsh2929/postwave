// SPDX-License-Identifier: AGPL-3.0-only
package mandate

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
)

// ToolGate authorises a tool call against the caller's mandate.
//
// It satisfies `agenttools.MandateGovernor`, so the bounded grant becomes one
// more step in the governance gauntlet every surface already runs, rather than a
// second enforcement path beside it. That matters more than it sounds: the
// package doc for agenttools exists because governance used to be wired
// per-surface and the native MCP write path would have inherited none of it.
type ToolGate struct{ Repo *Repo }

// CheckMandate denies unless the mandate names this tool, and spends a use.
//
// The RESOURCE is the tool's own name-spaced identity, not an argument.
// Extracting a resource id from tool arguments would mean parsing every tool's
// schema here — and getting it wrong on one tool would silently widen the
// mandate for that tool only. A mandate therefore bounds WHICH TOOLS an agent
// may run and how often; bounding which rows a tool touches is the tool's own
// job, and saying so plainly is better than implying a guarantee this cannot
// make.
func (g *ToolGate) CheckMandate(ctx context.Context, c agenttools.Caller, tool *agenttools.ToolSpec) error {
	if g == nil || g.Repo == nil {
		// A gate that cannot check is not a gate that passes. The caller
		// presented a mandate, so it expects to be bounded; running unbounded
		// because the store is unwired is the failure this whole row is about.
		return fmt.Errorf("%w: mandate store unavailable", agenttools.ErrMandateDenied)
	}
	if tool == nil || strings.TrimSpace(c.Mandate) == "" {
		return fmt.Errorf("%w: no mandate presented", agenttools.ErrMandateDenied)
	}
	authorised, err := g.Repo.Authorise(ctx, c.Mandate, tool.Name, "tool:"+tool.Name)
	if errors.Is(err, ErrDenied) {
		return fmt.Errorf("%w", agenttools.ErrMandateDenied)
	}
	if err != nil {
		// Infrastructure, not policy. Execute distinguishes them: this refuses
		// the call without recording it as a denial the agent could learn from.
		return err
	}
	if authorised.TenantID != c.TenantID {
		// The mandate belongs to another tenant. Reachable only through a
		// wiring mistake, and it must fail rather than execute cross-tenant.
		return fmt.Errorf("%w", agenttools.ErrMandateDenied)
	}
	return nil
}
