// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { DashboardStats } from "@/lib/analytics-api";
import { computeDelta, deriveRecommendations } from "@/lib/dashboard-insights";

function stats(partial: Partial<DashboardStats>): DashboardStats {
  return {
    subscribers_total: 0,
    subscribers_added_30d: 0,
    subscribers_unsubbed_30d: 0,
    campaigns_sent_30d: 0,
    opens_total_30d: 0,
    clicks_total_30d: 0,
    bounces_total_30d: 0,
    ...partial,
  };
}

describe("computeDelta", () => {
  it("computes an upward percentage change", () => {
    expect(computeDelta(120, 100)).toMatchObject({
      direction: "up",
      pct: 20,
      absolute: 20,
      label: "+20%",
    });
  });

  it("computes a downward percentage change", () => {
    expect(computeDelta(80, 100)).toMatchObject({
      direction: "down",
      pct: -20,
      label: "-20%",
    });
  });

  it("falls back to a signed absolute when there is no baseline", () => {
    expect(computeDelta(5, 0)).toMatchObject({
      direction: "up",
      pct: null,
      label: "+5",
    });
  });

  it("reports flat when unchanged", () => {
    expect(computeDelta(0, 0)).toMatchObject({ direction: "flat", label: "0" });
  });
});

describe("deriveRecommendations", () => {
  it("returns nothing without stats", () => {
    expect(deriveRecommendations(null)).toEqual([]);
    expect(deriveRecommendations(undefined)).toEqual([]);
  });

  it("surfaces a deliverability action when inbox health is low", () => {
    const recs = deriveRecommendations(
      stats({ opens_total_30d: 10, inbox_health: { score: 42, state: "poor" } }),
    );
    expect(recs[0]).toMatchObject({
      id: "deliverability",
      tone: "warn",
      href: "/app/inbox-reality",
    });
  });

  it("flags a material click-rate decline against a sufficiently sized prior window", () => {
    const recs = deriveRecommendations(
      stats({
        unique_clicks_30d: 10,
        unique_delivered_30d: 200,
        previous: { unique_clicks: 30, unique_delivered: 200 },
        inbox_health: { score: 95, state: "good" },
      }),
    );
    expect(recs.find((r) => r.id === "engagement")?.detail).toContain("5.0%");
  });

  it("does not infer falling engagement from raw opens or tiny cohorts", () => {
    expect(deriveRecommendations(stats({
      opens_total_30d: 5,
      previous: { opens_total: 100 },
    })).some((r) => r.id === "engagement")).toBe(false);
    expect(deriveRecommendations(stats({
      unique_clicks_30d: 1,
      unique_delivered_30d: 10,
      previous: { unique_clicks: 7, unique_delivered: 10 },
    })).some((r) => r.id === "engagement")).toBe(false);
    expect(deriveRecommendations(stats({
      unique_clicks_30d: 101,
      unique_delivered_30d: 100,
      previous: { unique_clicks: 30, unique_delivered: 200 },
    })).some((r) => r.id === "engagement")).toBe(false);
  });

  it("flags audience churn when unsubscribes outpace sign-ups", () => {
    const recs = deriveRecommendations(
      stats({ subscribers_added_30d: 2, subscribers_unsubbed_30d: 9 }),
    );
    expect(recs.some((r) => r.id === "growth")).toBe(true);
  });

  it("states the limits of its evidence instead of certifying health", () => {
    const recs = deriveRecommendations(
      stats({ campaigns_sent_30d: 1, opens_total_30d: 500, inbox_health: { score: 98, state: "good" } }),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ id: "no-urgent-signal", tone: "info" });
    expect(recs[0].detail).toContain("cannot certify overall performance");
  });

  it("caps the number of recommendations", () => {
    const recs = deriveRecommendations(
      stats({
        unique_clicks_30d: 10,
        unique_delivered_30d: 200,
        previous: { unique_clicks: 30, unique_delivered: 200 },
        subscribers_added_30d: 1,
        subscribers_unsubbed_30d: 8,
        inbox_health: { score: 30, state: "critical" },
      }),
      2,
    );
    expect(recs).toHaveLength(2);
  });
});
