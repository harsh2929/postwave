// SPDX-License-Identifier: AGPL-3.0-only
//
// Substantive mock state for explicit local/demo mode only
// (NEXT_PUBLIC_USE_MOCKS=1 outside production).

import type {
  BillingState,
  BillingPlanSummary,
  BillingTier,
  Invoice,
  LimitsUsageResponse,
  UsagePoint,
} from "./billing-types";

// Local-only mutable overage preference so the toggle round-trips in mock mode.
let mockOverageEnabled = false;
let mockOverageCap: number | null = null;

export const billingMocks = {
  getState(): BillingState {
    const monthlyCap = 100_000;
    const used = 62_840;
    return {
      tier: "growth",
      startedAt: "2026-01-08",
      sendingAddon: {
        monthlyCap,
        used,
        daysRemaining: 11,
        overageEnabled: mockOverageEnabled,
        overageUnits: Math.max(0, used - monthlyCap),
        overageCap: mockOverageCap,
        // No live Stripe in mock mode → never configured/chargeable.
        overageChargeable: false,
        overageBillingConfigured: false,
      },
      card: { brand: "Visa", last4: "4242" },
    };
  },

  setOverage(enabled: boolean, cap?: number | null): BillingState {
    mockOverageEnabled = enabled;
    mockOverageCap = cap ?? null;
    return this.getState();
  },

  getInvoices(): Invoice[] {
    return [
      {
        id: "inv_2026_04",
        date: "2026-04-08",
        amount: "$25.14",
        status: "paid",
        downloadUrl: "#",
      },
      {
        id: "inv_2026_03",
        date: "2026-03-08",
        amount: "$18.72",
        status: "paid",
        downloadUrl: "#",
      },
      {
        id: "inv_2026_02",
        date: "2026-02-08",
        amount: "$22.40",
        status: "paid",
        downloadUrl: "#",
      },
      {
        id: "inv_2026_01_growth",
        date: "2026-01-08",
        amount: "$99.00",
        status: "paid",
        downloadUrl: "#",
      },
    ];
  },

  getUsage(): UsagePoint[] {
    // 365 deterministic days ending today. Keeping the fixture relative means
    // every range control remains demonstrable as the calendar advances;
    // avoiding Math.random means a refetch never rewrites the same day.
    const out: UsagePoint[] = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let i = 364; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      // weekly send pattern with ramps.
      const dow = d.getDay();
      const base = dow === 2 || dow === 4 ? 4200 : 180;
      const noise = Math.round(
        Math.sin(i / 5) * 800 + ((i * 97 + dow * 53) % 401),
      );
      out.push({
        date: d.toISOString().slice(0, 10),
        sent: Math.max(0, base + noise),
      });
    }
    return out;
  },

  getPlanSummary(): BillingPlanSummary {
    const resources = [
      { resource: "contacts", current: 8_420, limit: 10_000 },
      { resource: "campaigns", current: 14, limit: 100 },
      { resource: "automations", current: 7, limit: 25 },
      { resource: "landing_pages", current: 4, limit: 20 },
      { resource: "monthly_sends", current: 62_840, limit: 100_000 },
      { resource: "seats", current: 3, limit: 5 },
      { resource: "assurance_runs", current: 16, limit: 25 },
      { resource: "ai_credits", current: 184, limit: 1_250 },
      { resource: "automation_executions", current: 18_430, limit: 250_000 },
      { resource: "tracked_events", current: 124_800, limit: 1_000_000 },
      { resource: "api_operations", current: 42_700, limit: 500_000 },
      { resource: "asset_storage", current: 740, limit: 10_240 },
    ].map((row) => ({
      ...row,
      percent: (row.current / row.limit) * 100,
      exceeded: row.current > row.limit,
    }));
    const renewal = new Date();
    renewal.setDate(renewal.getDate() + 11);
    return {
      tier: "growth",
      current_period_end: renewal.toISOString(),
      resources,
      sends_projection: {
        current: 62_840,
        limit: 100_000,
        as_of: new Date().toISOString(),
        period_start: new Date(Date.now() - 19 * 86_400_000).toISOString(),
        period_end: renewal.toISOString(),
        avg_per_day: 3_307,
        days_elapsed: 19,
        days_in_period: 30,
        projected_end_of_period: 99_210,
        projected_exceed_date: null,
        on_track_to_exceed: false,
      },
    };
  },

  getLimitsUsage(): LimitsUsageResponse {
    const plan = this.getPlanSummary();
    return { tier: plan.tier, rows: plan.resources };
  },

  createCheckoutSession(tier: BillingTier): { url: string } {
    return {
      url: `https://checkout.dodo.example/cs_mock_${tier}_${Date.now()}`,
    };
  },

  getStripePortalURL(): { url: string } {
    return { url: "https://billing.dodo.example/p/mock_portal_session" };
  },
};
