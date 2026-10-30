// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-27: the subscriber forecast strip (desktop
// components/dashboard/ForecastStrip.tsx:30 + lib/dashboard-helpers.ts
// forecastNextMilestone). The input is the `sparklines.subscribers` series and
// `subscribers_total` from GET /api/v1/dashboard/stats (daily NEW subscribers,
// per analytics.go dashboardSubscriberSparklineSQL). Asserts the projected
// milestone and date that are rendered, and that the strip stays silent when
// the evidence does not support a projection.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  forecastNextMilestone,
  nextRoundMilestone,
} from "@/lib/dashboard-forecast";
import { ForecastStrip } from "@/components/dashboard/forecast-strip";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = new Date(2026, 8, 12, 12, 0, 0);
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(sparkline: unknown[] | undefined, currentTotal: unknown) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(ForecastStrip, { sparkline, currentTotal, today: TODAY }),
    ),
  );
  return host;
}

describe("forecastNextMilestone", () => {
  it("walks a steady 10/day trend to the next round milestone", () => {
    const fc = forecastNextMilestone(Array(14).fill(10), 900, TODAY);
    expect(fc).not.toBeNull();
    expect(fc?.target).toBe(1000);
    expect(fc?.daysAway).toBe(10);
    expect(fc?.crossesAt.getDate()).toBe(22);
    expect(fc?.crossesAt.getMonth()).toBe(8);
  });

  it("projects from the fitted trend, not the plain average", () => {
    // 0..13 new subscribers a day (slope 1, intercept 0): the fitted line at
    // x = n + 15 = 29 gives 29/day, where the plain average is only 6.5/day.
    const rising = Array.from({ length: 14 }, (_, i) => i);
    const fc = forecastNextMilestone(rising, 2_300, TODAY);
    expect(fc?.target).toBe(2_500);
    expect(fc?.projectedDailyAdds).toBeCloseTo(29, 5);
    expect(fc?.daysAway).toBe(7);
  });

  it("declines when the evidence cannot support a projection", () => {
    expect(forecastNextMilestone(Array(6).fill(10), 900, TODAY)).toBeNull();
    // Shrinking trend: never predicted.
    const falling = Array.from({ length: 14 }, (_, i) => 13 - i);
    expect(forecastNextMilestone(falling, 900, TODAY)).toBeNull();
    // Past the 180-day horizon.
    expect(forecastNextMilestone(Array(14).fill(1), 9_000, TODAY)).toBeNull();
    // A mangled point, or an unknown total.
    expect(
      forecastNextMilestone([10, 10, "x", 10, 10, 10, 10], 900, TODAY),
    ).toBeNull();
    expect(forecastNextMilestone(Array(14).fill(10), undefined, TODAY)).toBeNull();
  });

  it("uses the round-number ladder", () => {
    expect(nextRoundMilestone(0)).toBe(100);
    expect(nextRoundMilestone(1_000)).toBe(2_500);
    expect(nextRoundMilestone(20_000_000)).toBeNull();
  });
});

describe("ForecastStrip", () => {
  it("renders the milestone and the projected date", () => {
    const el = render(Array(14).fill(10), 900);
    const note = el.querySelector('[role="note"]');
    expect(note?.getAttribute("aria-label")).toBe("Subscriber forecast");
    const expectedDate = new Date(2026, 8, 22).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(note?.textContent).toContain(
      `At this rate, you'll cross 1,000 subscribers around ${expectedDate}.`,
    );
    expect(note?.textContent).toContain("over the last 14 days");
  });

  it("renders nothing without enough signal", () => {
    const el = render(Array(5).fill(10), 900);
    expect(el.querySelector('[role="note"]')).toBeNull();
    expect(el.textContent).toBe("");
  });
});
