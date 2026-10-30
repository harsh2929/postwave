// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/budgets"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
)

// SelfInfoResult is what the `whoami` MCP tool and GET /api/v1/api-keys/me
// return: an agent's own identity and limits, so it can self-limit before
// attempting an action. Budget fields are pointers — nil means "unlimited
// / not configured", distinct from a zero remaining balance.
type SelfInfoResult struct {
	TenantID        string   `json:"tenant_id"`
	TenantSlug      string   `json:"tenant_slug,omitempty"`
	Scopes          []string `json:"scopes"`
	SandboxOnly     bool     `json:"sandbox_only"`
	Actor           string   `json:"actor,omitempty"`
	MCPWriteEnabled bool     `json:"mcp_write_enabled"`

	SendsPerDay    *int `json:"sends_per_day,omitempty"`
	SendsUsedToday *int `json:"sends_used_today,omitempty"`
	SendsRemaining *int `json:"sends_remaining,omitempty"`

	CostCentsPerMonth  *int `json:"cost_cents_per_month,omitempty"`
	CostCentsUsed      *int `json:"cost_cents_used,omitempty"`
	CostCentsRemaining *int `json:"cost_cents_remaining,omitempty"`
}

// SelfInfo describes the calling key: tenant, granted scopes, sandbox
// flag, whether MCP write-tier is enabled for the tenant, and (when a
// budget reader is wired) the remaining send + cost budget. It reads
// identity from the context the apikeys middleware populated, so it
// reflects exactly what the chokepoint will enforce.
func (d *Deps) SelfInfo(ctx context.Context) SelfInfoResult {
	var info SelfInfoResult
	info.Scopes = []string{} // never null — agents branch on this

	if t, ok := middleware.TenantFromContext(ctx); ok && t != nil {
		info.TenantID = t.ID
		info.TenantSlug = t.Slug
	}
	for _, s := range apikeys.ScopesFromContext(ctx) {
		info.Scopes = append(info.Scopes, string(s))
	}
	info.SandboxOnly = sandbox.IsFlagged(ctx)
	if at, al := middleware.ActorFromContext(ctx); at != "" || al != "" {
		info.Actor = strings.TrimSpace(at + " " + al)
	}
	if info.TenantID != "" && d.Pool != nil {
		if s, err := d.loadOrInitSettings(ctx, info.TenantID); err == nil {
			info.MCPWriteEnabled = nativeWriteTierEnabled(s)
		}
	}

	keyID := middleware.APIKeyIDFromContext(ctx)
	if d.Budgets == nil || keyID == "" {
		return info
	}
	b, err := d.Budgets.LoadBudget(ctx, keyID)
	if err != nil || b == nil {
		return info
	}
	now := time.Now().UTC()
	// When a limit is configured we always populate *Remaining so a
	// consumer can never misread a missing field as "unlimited". On a
	// usage-read failure we fail safe to 0 remaining (assume exhausted)
	// rather than leaving it nil.
	if b.SendsPerDay != nil {
		info.SendsPerDay = b.SendsPerDay
		rem := 0
		if u, err := d.Budgets.LoadUsage(ctx, keyID, budgets.PeriodFor(budgets.ResourceSends, now)); err == nil && u != nil {
			used := u.Sends
			rem = *b.SendsPerDay - used
			if rem < 0 {
				rem = 0
			}
			info.SendsUsedToday = &used
		}
		info.SendsRemaining = &rem
	}
	if b.DollarsPerMonthCents != nil {
		info.CostCentsPerMonth = b.DollarsPerMonthCents
		rem := 0
		if u, err := d.Budgets.LoadUsage(ctx, keyID, budgets.PeriodFor(budgets.ResourceCost, now)); err == nil && u != nil {
			used := u.CostCents
			rem = *b.DollarsPerMonthCents - used
			if rem < 0 {
				rem = 0
			}
			info.CostCentsUsed = &used
		}
		info.CostCentsRemaining = &rem
	}
	return info
}

// handleWhoami is the registry handler backing the `whoami` tool.
func handleWhoami(ctx context.Context, d *Deps, _ json.RawMessage) (any, error) {
	return d.SelfInfo(ctx), nil
}
