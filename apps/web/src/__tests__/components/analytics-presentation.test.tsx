// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-35 (compare with prior period), analytics-15 (?metric= focus
// target) and analytics-43 (Copy chart link). Each verb is asserted by its
// consequence: the deltas that appear or vanish, the URL it writes, the tile
// it scrolls to, and the exact link that reaches the clipboard.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

import { AnalyticsPresentation } from "@/components/analytics/analytics-presentation";
import type { DashboardStats } from "@/lib/analytics-api";
import {
  analyticsMetricHref,
  buildAnalyticsChartLink,
  parseAnalyticsView,
} from "@/lib/analytics-view-params";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STATS: DashboardStats = {
  subscribers_total: 5000,
  subscribers_added_30d: 150,
  subscribers_unsubbed_30d: 10,
  campaigns_sent_30d: 4,
  opens_total_30d: 900,
  clicks_total_30d: 120,
  bounces_total_30d: 20,
  unique_opens_30d: 300,
  unique_clicks_30d: 50,
  unique_bounces_30d: 20,
  unique_delivered_30d: 1000,
  unique_sent_30d: 1000,
  previous: {
    subscribers_added: 100,
    subscribers_unsubbed: 10,
    unique_opens: 200,
    unique_clicks: 50,
    unique_bounces: 30,
    unique_delivered: 1000,
    unique_sent: 1000,
  },
};

let root: Root | null = null;
const scrolled: Element[] = [];

async function flush() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function render(search: string, stats: DashboardStats = STATS) {
  window.history.replaceState(null, "", `/app/analytics${search}`);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(AnalyticsPresentation, { stats, range: "7d" }));
  });
  await act(async () => flush());
  return container;
}

function tile(metric: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    `[data-testid="analytics-rate-tile"][data-metric="${metric}"]`,
  );
  if (!el) throw new Error(`no tile ${metric}`);
  return el;
}

function compareBox(): HTMLInputElement {
  const box = [...document.querySelectorAll("label")]
    .find((l) => l.textContent?.includes("Compare with prior period"))
    ?.querySelector("input");
  if (!box) throw new Error("no compare toggle");
  return box as HTMLInputElement;
}

function buttonByName(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found as HTMLButtonElement;
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this as Element);
  };
  writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

describe("Compare with prior period (analytics-35)", () => {
  it("shows the prior-period deltas by default, in percentage points for rates", async () => {
    await render("?range=7d");
    expect(compareBox().checked).toBe(true);
    // 300/1000 = 30.0% vs 200/1000 = 20.0% → +10.0 pts.
    expect(tile("opens").textContent).toContain("30.0%");
    expect(tile("opens").textContent).toContain("+10.0 pts");
    // Bounce rate fell 3.0% → 2.0%.
    expect(tile("bounces").textContent).toContain("−1.0 pts");
    // Subscribers compare the added count: 150 vs 100.
    expect(tile("subscribers").textContent).toContain("+50%");
  });

  it("turning it off hides every delta and writes ?compare=off; turning it on restores them", async () => {
    await render("?range=7d");
    await act(async () => {
      compareBox().click();
    });
    expect(window.location.search).toContain("compare=off");
    expect(window.location.search).toContain("range=7d");
    for (const metric of ["subscribers", "opens", "clicks", "bounces"]) {
      expect(tile(metric).textContent).not.toMatch(/pts|\+50%/);
    }
    expect(tile("opens").textContent).not.toContain("+10.0 pts");
    expect(document.body.textContent).toContain(
      "Prior-period comparison is hidden.",
    );

    await act(async () => {
      compareBox().click();
    });
    expect(window.location.search).not.toContain("compare");
    expect(tile("opens").textContent).toContain("+10.0 pts");
  });

  it("honours ?compare=off from a shared link", async () => {
    await render("?compare=off");
    expect(compareBox().checked).toBe(false);
    expect(tile("opens").textContent).not.toContain("+10.0 pts");
  });

  it("says so when the server returned no prior window instead of showing zeros", async () => {
    await render("", { ...STATS, previous: null });
    expect(document.body.textContent).toContain(
      "No prior-period figures were returned",
    );
    expect(tile("opens").textContent).not.toContain("pts");
  });
});

describe("Metric focus deep link (analytics-15)", () => {
  it("builds the drill-down href the home tiles and anomaly rows use", () => {
    expect(analyticsMetricHref("opens", "7d")).toBe(
      "/app/analytics?range=7d&metric=opens",
    );
    expect(analyticsMetricHref("clicks", "30d")).toBe(
      "/app/analytics?metric=clicks",
    );
    expect(parseAnalyticsView("?metric=open_rate").metric).toBe("opens");
    expect(parseAnalyticsView("?metric=subs").metric).toBe("subscribers");
    expect(parseAnalyticsView("?metric=nonsense").metric).toBeNull();
  });

  it("?metric= focuses and scrolls to that KPI", async () => {
    await render("?range=7d&metric=open_rate");
    const opens = tile("opens");
    expect(opens.getAttribute("aria-pressed")).toBe("true");
    expect(opens.getAttribute("aria-label")).toContain("(focused)");
    expect(opens.textContent).toContain("Focused");
    expect(scrolled).toContain(opens);
    expect(tile("clicks").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking a tile focuses it in the URL; Clear focus drops it", async () => {
    await render("?range=7d");
    await act(async () => {
      tile("clicks").click();
    });
    expect(new URLSearchParams(window.location.search).get("metric")).toBe(
      "clicks",
    );
    expect(tile("clicks").getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      buttonByName("Clear focus").click();
    });
    expect(window.location.search).not.toContain("metric");
    expect(tile("clicks").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Copy chart deep link (analytics-43)", () => {
  it("copies an absolute /app/analytics link with the range, the focused metric and focus=<chart>", async () => {
    await render("?range=7d&metric=opens");
    await act(async () => {
      buttonByName("More actions for Rates vs prior period").click();
    });
    await act(async () => {
      buttonByName("Copy link").click();
    });
    await act(async () => flush());
    const expected = `${window.location.origin}/app/analytics?range=7d&metric=opens&focus=key-rates`;
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(toastMocks.success).toHaveBeenCalledWith("Chart link copied.");
  });

  it("reports a rejected clipboard write", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    await render("?range=7d");
    await act(async () => {
      buttonByName("More actions for Rates vs prior period").click();
    });
    await act(async () => {
      buttonByName("Copy link").click();
    });
    await act(async () => flush());
    expect(toastMocks.error).toHaveBeenCalledWith(
      "The link couldn't be copied to your clipboard.",
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("a copied link, opened, scrolls to and highlights that chart", async () => {
    const link = buildAnalyticsChartLink(
      window.location.origin,
      "?range=7d",
      "key-rates",
    );
    const url = new URL(link);
    expect(url.pathname).toBe("/app/analytics");
    await render(url.search);
    const card = document.querySelector('[data-analytics-focus="key-rates"]');
    expect(card?.getAttribute("data-focused")).toBe("true");
    expect(scrolled).toContain(card);
  });
});
