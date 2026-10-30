// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-tenant isolation tests for the win-back worker's churn-source
// selection. Verifies that (a) the commerce-vs-engagement routing is
// decided per tenant, and (b) the engagement fallback only ever returns
// the queried tenant's subscribers — a fake ChurnSource keyed by tenant
// stands in for the DB so this runs with no Postgres.

package retention_offers

import (
	"context"
	"testing"
)

// tenantScopedChurnSource is a fake ChurnSource that partitions its data
// by tenant id. If EngagementChurnCrossers is ever called with the wrong
// tenant it returns that tenant's slice — so a test asserting tenant A's
// emails proves the worker never bled tenant B's rows in.
type tenantScopedChurnSource struct {
	hasCommerce map[string]bool
	crossers    map[string][]ChurnCrosser
	// calls records (tenant) for every EngagementChurnCrossers call to
	// prove the worker queried per tenant.
	engagementCalls []string
}

func (s *tenantScopedChurnSource) HasCommerceChurn(_ context.Context, tenantID string) (bool, error) {
	return s.hasCommerce[tenantID], nil
}

func (s *tenantScopedChurnSource) EngagementChurnCrossers(_ context.Context, tenantID string, _ float64, _ int) ([]ChurnCrosser, error) {
	s.engagementCalls = append(s.engagementCalls, tenantID)
	return s.crossers[tenantID], nil
}

func TestEngagementFallbackPerTenantIsolation(t *testing.T) {
	t.Parallel()
	src := &tenantScopedChurnSource{
		hasCommerce: map[string]bool{"t_commerce": true, "t_newsletter": false},
		crossers: map[string][]ChurnCrosser{
			"t_newsletter": {{Email: "n1@example.com", Source: "engagement", Risk: 0.9}},
			// Tenant B's data; must NEVER surface for tenant A's query.
			"t_commerce": {{Email: "SHOULD_NOT_APPEAR@example.com", Source: "engagement", Risk: 0.9}},
		},
	}
	w := &WinbackWorker{ChurnSource: src}

	// Newsletter tenant (no commerce churn) routes to engagement and gets
	// ONLY its own crosser — querying with t_newsletter must never return
	// t_commerce's row.
	got, err := w.selectCrossers(context.Background(), "t_newsletter", "off_n", 0.7)
	if err != nil {
		t.Fatalf("selectCrossers: %v", err)
	}
	if len(got) != 1 || got[0].Email != "n1@example.com" || got[0].Source != "engagement" {
		t.Fatalf("newsletter crossers = %+v, want one engagement crosser n1@example.com", got)
	}
	if len(src.engagementCalls) != 1 || src.engagementCalls[0] != "t_newsletter" {
		t.Fatalf("engagement queried for %v, want exactly [t_newsletter]", src.engagementCalls)
	}
}

func TestUseCommerceChurnRouting(t *testing.T) {
	t.Parallel()
	src := &tenantScopedChurnSource{
		hasCommerce: map[string]bool{"t_commerce": true, "t_newsletter": false},
	}
	w := &WinbackWorker{ChurnSource: src}

	// Commerce tenant -> commerce path (no engagement fallback).
	commerce, err := w.useCommerceChurn(context.Background(), "t_commerce")
	if err != nil || !commerce {
		t.Fatalf("t_commerce useCommerceChurn = (%v, %v), want (true, nil)", commerce, err)
	}
	// Newsletter tenant -> engagement fallback.
	news, err := w.useCommerceChurn(context.Background(), "t_newsletter")
	if err != nil || news {
		t.Fatalf("t_newsletter useCommerceChurn = (%v, %v), want (false, nil)", news, err)
	}
	// The routing decision must not have queried engagement crossers.
	if len(src.engagementCalls) != 0 {
		t.Fatalf("routing made engagement calls: %v", src.engagementCalls)
	}
}

func TestUseCommerceChurnNilSourceStaysCommerceOnly(t *testing.T) {
	t.Parallel()
	// A nil ChurnSource keeps legacy commerce-only behaviour.
	w := &WinbackWorker{}
	got, err := w.useCommerceChurn(context.Background(), "t1")
	if err != nil || !got {
		t.Fatalf("nil ChurnSource useCommerceChurn = (%v, %v), want (true, nil)", got, err)
	}
}
