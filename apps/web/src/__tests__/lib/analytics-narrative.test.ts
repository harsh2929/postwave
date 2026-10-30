// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from "vitest";
import type { DashboardStats } from "@/lib/analytics-api";
import { analyticsNarrativeText } from "@/lib/analytics-narrative";

const stats: DashboardStats = {
  subscribers_total: 50,
  subscribers_added_30d: 10,
  subscribers_unsubbed_30d: 0,
  campaigns_sent_30d: 1,
  opens_total_30d: 31,
  clicks_total_30d: 8,
  bounces_total_30d: 1,
};
it("renders measured facts instead of the compatibility builder's prompt echo", () => {
  const text = analyticsNarrativeText(stats, "7d", {
    provider_mode: "deterministic_with_provider_slot",
    text: "Summarize this dashboard. Make the value clear and personalize with FNAME.",
  });
  expect(text).toContain("last 7 days");
  expect(text).toContain("31 opens, 8 clicks and 1 bounce");
  expect(text).toContain("Prior-period engagement counts are unavailable");
  expect(text).not.toContain("FNAME");
  expect(text).not.toContain("Make the value clear");
});
it("keeps a real provider summary and reports an empty result honestly", () => {
  expect(
    analyticsNarrativeText(stats, "30d", {
      provider_mode: "external",
      text: "Engagement rose.",
    }),
  ).toBe("Engagement rose.");
  expect(
    analyticsNarrativeText(stats, "30d", {
      provider_mode: "external",
      text: " ",
    }),
  ).toBe("No summary was returned.");
});
