import { describe, expect, it } from "vitest";

import {
  buildDashboardSnapshot,
  canBuildDashboardSnapshot,
} from "./dashboardSnapshot";
import type { DashboardStats } from "./dashboardStatsSchema";

const complete: DashboardStats = {
  subscribers_total: 12345,
  subscribers_added_30d: 400,
  subscribers_unsubbed_30d: 120,
  campaigns_sent_30d: 6,
  unique_opens_30d: 2500,
  unique_clicks_30d: 400,
  unique_bounces_30d: 50,
  unique_delivered_30d: 10000,
  unique_sent_30d: 10050,
};

describe("canBuildDashboardSnapshot", () => {
  it("requires the full recipient contract", () => {
    expect(canBuildDashboardSnapshot(complete)).toBe(true);
    expect(canBuildDashboardSnapshot(undefined)).toBe(false);
    const { unique_delivered_30d: _omitted, ...missing } = complete;
    expect(canBuildDashboardSnapshot(missing)).toBe(false);
  });

  it("rejects impossible counts rather than sharing them", () => {
    expect(
      canBuildDashboardSnapshot({ ...complete, unique_sent_30d: -1 }),
    ).toBe(false);
  });
});

describe("buildDashboardSnapshot", () => {
  const body = buildDashboardSnapshot(complete, {
    workspace: "  Acme  ",
    rangeLabel: "Last 30 days",
  });

  it("leads with the workspace and window", () => {
    expect(body.split("\n")[0]).toBe("Acme — Last 30 days");
  });

  it("reports the NET subscriber change, not gross adds", () => {
    expect(body).toContain("Subscribers: 12,345 (+280)");
  });

  it("computes rates from unique recipients", () => {
    expect(body).toContain("Open rate: 25.0%");
    expect(body).toContain("Click rate: 4.0%");
    // Bounces divide by SENT, never delivered.
    expect(body).toContain("Bounce rate: 0.5%");
  });

  it("carries its own methodology so a pasted number cannot be misread", () => {
    expect(body).toContain("unique campaign recipients");
  });

  it("falls back to the product name with no workspace", () => {
    const anonymous = buildDashboardSnapshot(complete, {
      workspace: "   ",
      rangeLabel: "Last 7 days",
    });
    expect(anonymous.split("\n")[0]).toBe("Moosewave — Last 7 days");
  });

  it("renders an em-dash rather than a fabricated rate when counts are unusable", () => {
    const broken = buildDashboardSnapshot(
      { ...complete, unique_sent_30d: 0, unique_delivered_30d: 0 },
      { rangeLabel: "Last 30 days" },
    );
    expect(broken).toContain("Open rate: —");
    expect(broken).toContain("Bounce rate: —");
  });
});
