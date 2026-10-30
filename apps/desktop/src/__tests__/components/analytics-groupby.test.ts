// Group-by wiring on the Analytics page (desktop audit gap A19).
//
// The page mounts GroupByMenu in the header toolbar and swaps the
// Engagement-velocity chart for GroupedTimeseriesChart when the user
// picks campaign or domain. These tests pin the page-level policy that
// drives that swap (it lives in grouped-series.ts — a pure .ts module —
// so the node-environment suite can import it without a JSX transform):
//
//   - groupedChartDimension maps menu selections onto the grouped
//     chart's dimension (only campaign/domain chart; everything else
//     keeps the default ungrouped view), and
//   - ANALYTICS_GROUPBY_UNAVAILABLE + the menu's always-disabled `list`
//     row together cover EXACTLY the dimensions the page can't offer —
//     so every enabled menu row is genuinely actionable.

import { describe, expect, it } from "vitest";

// Type-only import — erased at compile time, so the .tsx menu component
// never enters the node test run.
import type { GroupByDimension } from "../../components/analytics/GroupByMenu";
import {
  ANALYTICS_GROUPBY_UNAVAILABLE,
  groupedChartDimension,
} from "../../components/analytics/grouped-series";

const ALL_DIMENSIONS: GroupByDimension[] = [
  "none",
  "campaign",
  "domain",
  "list",
  "segment",
  "country",
  "mail-client",
  "device",
];

describe("groupedChartDimension", () => {
  it("charts campaign and domain", () => {
    expect(groupedChartDimension("campaign")).toBe("campaign");
    expect(groupedChartDimension("domain")).toBe("domain");
  });

  it("keeps the default ungrouped view for every other selection", () => {
    for (const d of ALL_DIMENSIONS) {
      if (d === "campaign" || d === "domain") continue;
      expect(groupedChartDimension(d)).toBeNull();
    }
  });
});

describe("ANALYTICS_GROUPBY_UNAVAILABLE coherence", () => {
  it("disables exactly the dimensions the page cannot chart", () => {
    // The page offers: none (default) + campaign/domain (grouped chart).
    // `list` is always disabled inside the menu itself. Everything else
    // must be listed as unavailable — no enabled-but-dead rows.
    const offered = new Set<GroupByDimension>(["none", "campaign", "domain"]);
    const alwaysDisabledInMenu = new Set<GroupByDimension>(["list"]);
    for (const d of ALL_DIMENSIONS) {
      const expectUnavailable =
        !offered.has(d) && !alwaysDisabledInMenu.has(d);
      expect(ANALYTICS_GROUPBY_UNAVAILABLE.includes(d)).toBe(
        expectUnavailable,
      );
    }
  });

  it("never disables a dimension the grouped chart can render", () => {
    for (const d of ANALYTICS_GROUPBY_UNAVAILABLE) {
      expect(groupedChartDimension(d)).toBeNull();
    }
  });
});
