// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/budgets"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
)

type fakeBudgetReader struct {
	budget *budgets.Budget
	usage  *budgets.Usage
}

func (f fakeBudgetReader) LoadBudget(context.Context, string) (*budgets.Budget, error) {
	return f.budget, nil
}
func (f fakeBudgetReader) LoadUsage(context.Context, string, time.Time) (*budgets.Usage, error) {
	if f.usage == nil {
		return &budgets.Usage{}, nil
	}
	return f.usage, nil
}
func (f fakeBudgetReader) IncrementUsage(context.Context, *budgets.Budget, budgets.Resource, int, time.Time) error {
	return nil
}

func bptr(i int) *int { return &i }

func TestSelfInfo(t *testing.T) {
	limit := 100
	d := &Deps{Budgets: fakeBudgetReader{
		budget: &budgets.Budget{SendsPerDay: &limit},
		usage:  &budgets.Usage{Sends: 30},
	}}

	ctx := context.Background()
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "t1", Slug: "acme"})
	ctx = middleware.WithAPIKeyID(ctx, "k1")
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadSubscribers, apikeys.ScopeReadReports})
	ctx = sandbox.WithFlag(ctx)

	info := d.SelfInfo(ctx)

	if info.TenantID != "t1" || info.TenantSlug != "acme" {
		t.Fatalf("tenant not reported: %+v", info)
	}
	if len(info.Scopes) != 2 || info.Scopes[0] != "read:subscribers" {
		t.Fatalf("scopes not reported: %v", info.Scopes)
	}
	if !info.SandboxOnly {
		t.Fatal("sandbox flag from ctx should be reported")
	}
	if info.SendsPerDay == nil || *info.SendsPerDay != 100 {
		t.Fatalf("sends_per_day not reported: %+v", info.SendsPerDay)
	}
	if info.SendsRemaining == nil || *info.SendsRemaining != 70 {
		t.Fatalf("sends_remaining should be 70 (100-30), got %v", info.SendsRemaining)
	}
}

func TestSelfInfo_noBudgetOmitsFields(t *testing.T) {
	d := &Deps{} // no Budgets reader
	ctx := apikeys.WithScopes(context.Background(), []apikeys.Scope{apikeys.ScopeMCP})
	info := d.SelfInfo(ctx)
	if info.SendsRemaining != nil || info.SendsPerDay != nil {
		t.Fatal("budget fields must be omitted when no reader is wired")
	}
	if info.Scopes == nil {
		t.Fatal("scopes must never be nil (agents branch on it)")
	}
}
