import { describe, expect, it } from "vitest";

import type { DashboardStatsResponse } from "../../lib/api-client";
import {
  buildDashboardSnapshot,
  canBuildDashboardSnapshot,
} from "../../pages/dashboard/dashboard-snapshot";

describe("buildDashboardSnapshot", () => {
  it("uses unique recipient evidence and preserves denominator-parity deltas", () => {
    const stats: DashboardStatsResponse = {
      subscribers_total: 1250,
      subscribers_added_30d: 150,
      // Deliberately contradictory gross counts: snapshots must ignore them.
      opens_total_30d: 9_999,
      clicks_total_30d: 8_888,
      bounces_total_30d: 7_777,
      emails_sent_30d: 1,
      unique_opens_30d: 200,
      unique_clicks_30d: 30,
      unique_bounces_30d: 10,
      unique_delivered_30d: 1_000,
      unique_sent_30d: 1_000,
      previous: {
        subscribers_added: 100,
        opens_total: 9_999,
        clicks_total: 9_999,
        bounces_total: 9_999,
        emails_sent: 1,
        unique_opens: 180,
        unique_clicks: 20,
        unique_bounces: 20,
        unique_delivered: 1_000,
        unique_sent: 1_000,
      },
    };

    const snapshot = buildDashboardSnapshot(stats, "30d");
    expect(canBuildDashboardSnapshot(stats)).toBe(true);
    expect(snapshot).toContain("Moosewave — Last 30 days");
    expect(snapshot).toContain("Subscribers:");
    expect(snapshot).toContain("1,250");
    expect(snapshot).toContain("+50");
    expect(snapshot).toContain("20.0%");
    expect(snapshot).toContain("+2.0pt");
    expect(snapshot).toContain("3.0%");
    expect(snapshot).toContain("+1.0pt");
    expect(snapshot).toContain("1.0%");
    expect(snapshot).toContain("-1.0pt");
    expect(snapshot).not.toContain("999900");
    expect(snapshot).toContain(
      "_Rates use unique campaign-recipient evidence; opens/clicks prefer delivered with sent fallback, bounces use sent._",
    );
  });

  it("falls back to unique sent for partial delivery events and never exceeds 100%", () => {
    const fallback = buildDashboardSnapshot(
      {
        subscribers_total: 10,
        subscribers_added_30d: 1,
        unique_opens_30d: 90,
        unique_clicks_30d: 20,
        unique_bounces_30d: 2,
        unique_delivered_30d: 10,
        unique_sent_30d: 100,
        previous: {
          subscribers_added: 1,
          unique_opens: 80,
          unique_clicks: 10,
          unique_bounces: 4,
          unique_delivered: 5,
          unique_sent: 100,
        },
      },
      "30d",
    );
    expect(fallback).toMatch(/Open rate:\s+90\.0%/);
    expect(fallback).toContain("+10.0pt");
    expect(fallback).toMatch(/Click rate:\s+20\.0%/);
    expect(fallback).toMatch(/Bounce rate:\s+2\.0%/);

    const impossible = buildDashboardSnapshot(
      {
        unique_opens_30d: 101,
        unique_clicks_30d: 101,
        unique_bounces_30d: 101,
        unique_delivered_30d: 50,
        unique_sent_30d: 100,
      },
      "30d",
    );
    expect(impossible).toMatch(/Open rate:\s+—/);
    expect(impossible).toMatch(/Click rate:\s+—/);
    expect(impossible).toMatch(/Bounce rate:\s+—/);
    expect(impossible).not.toContain("101.0%");
  });

  it("renders unavailable rates instead of inventing a denominator", () => {
    const snapshot = buildDashboardSnapshot(
      {
        opens_total_30d: 12,
        clicks_total_30d: 4,
        bounces_total_30d: 1,
      },
      "7d",
    );

    expect(snapshot).toContain("Moosewave — Last 7 days");
    expect(snapshot).toMatch(/Subscribers:\s+—/);
    expect(snapshot).toMatch(/Open rate:\s+—/);
    expect(snapshot).toMatch(/Click rate:\s+—/);
    expect(snapshot).toMatch(/Bounce rate:\s+—/);
    expect(snapshot).not.toContain("NaN");
    expect(snapshot).not.toMatch(/Subscribers:\s+0/);
    expect(
      canBuildDashboardSnapshot({
        opens_total_30d: 12,
        clicks_total_30d: 4,
        bounces_total_30d: 1,
      }),
    ).toBe(false);
  });

  it("rejects malformed shared snapshots", () => {
    expect(
      canBuildDashboardSnapshot({
        subscribers_total: 10,
        subscribers_added_30d: 2,
        unique_opens_30d: -1,
        unique_clicks_30d: 1,
        unique_bounces_30d: 0,
        unique_delivered_30d: 5,
        unique_sent_30d: 5,
      }),
    ).toBe(false);
    expect(
      canBuildDashboardSnapshot({
        subscribers_total: Number.NaN,
        subscribers_added_30d: 2,
        unique_opens_30d: 0,
        unique_clicks_30d: 0,
        unique_bounces_30d: 0,
        unique_delivered_30d: 0,
        unique_sent_30d: 0,
      }),
    ).toBe(false);
    expect(
      canBuildDashboardSnapshot({
        subscribers_total: 10,
        subscribers_added_30d: 2,
        unique_opens_30d: 1.5,
        unique_clicks_30d: 1,
        unique_bounces_30d: 0,
        unique_delivered_30d: 5,
        unique_sent_30d: 5,
      }),
    ).toBe(false);
  });
});
