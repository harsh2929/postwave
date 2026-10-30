// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-38 — Group by dimension → grouped timeseries. Asserted by the
// request each choice makes (group_by / metric / days), the series it draws,
// the dimensions it shows as unavailable (never hides), and the honest state
// for each failure.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupedBreakdownCard } from "@/components/analytics/grouped-breakdown-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function points(values: number[]) {
  return values.map((value, i) => ({
    date: `2026-09-0${i + 1}`,
    value,
  }));
}

const SERIES = {
  series: [
    { key: "c-1", label: "Launch", points: points([5, 10, 15]) },
    { key: "c-2", label: "Launch", points: points([1, 2, 3]) },
    { key: "other", label: "Other", points: points([0, 1, 0]) },
  ],
  classification_filter: "all",
};

type Reply = { status: number; body: unknown };
let reply: (url: URL) => Reply;
let transport: ReturnType<typeof stub>;

function stub() {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const { status, body } = reply(new URL(raw, "http://localhost"));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function timeseriesRequests(): URL[] {
  return transport.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((url) => url.pathname === "/api/v1/analytics/timeseries");
}

let root: Root | null = null;

async function flush() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

async function render(search = "") {
  window.history.replaceState(null, "", `/app/analytics${search}`);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(GroupedBreakdownCard, {
          tenantId: TENANT,
          role: "viewer",
          userId: "user-1",
          range: "30d",
        }),
      ),
    );
  });
  await act(async () => flush());
  return container;
}

function groupBy(): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Group by"]',
  );
  if (!el) throw new Error("no group-by select");
  return el;
}

async function choose(value: string) {
  await act(async () => {
    const select = groupBy();
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function chip(group: string, label: string): HTMLButtonElement {
  const found = document
    .querySelector(`[role="group"][aria-label="${group}"]`)
    ?.querySelectorAll("button");
  const match = [...(found ?? [])].find((b) => b.textContent === label);
  if (!match) throw new Error(`no ${group} chip ${label}`);
  return match as HTMLButtonElement;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  reply = () => ({ status: 200, body: SERIES });
  transport = stub();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("Group by → grouped timeseries (analytics-38)", () => {
  it("lists every dimension, disabling (not hiding) the ones the server cannot chart, with the reason", async () => {
    await render();
    const options = [...groupBy().options];
    expect(options.map((o) => o.value)).toEqual([
      "none",
      "campaign",
      "domain",
      "list",
      "segment",
      "country",
      "mail-client",
      "device",
    ]);
    const disabled = options.filter((o) => o.disabled).map((o) => o.value);
    expect(disabled).toEqual([
      "list",
      "segment",
      "country",
      "mail-client",
      "device",
    ]);
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "List is unavailable: events carry no list attribution",
    );
    expect(text).toContain(
      "Segment, Country, Mail client and Device are unavailable",
    );
    // Aggregate view makes no grouped request.
    expect(timeseriesRequests()).toHaveLength(0);
    expect(text).toContain("Choose Campaign or Domain");
  });

  it("choosing Campaign fetches that breakdown and draws one line per group", async () => {
    await render();
    await choose("campaign");
    await waitFor(() => expect(timeseriesRequests()).toHaveLength(1));
    const [request] = timeseriesRequests();
    expect(request.searchParams.get("group_by")).toBe("campaign");
    expect(request.searchParams.get("metric")).toBe("opens");
    expect(request.searchParams.get("days")).toBe("30");
    // The dimension is carried in the URL so Copy link reproduces it.
    expect(new URLSearchParams(window.location.search).get("group_by")).toBe(
      "campaign",
    );

    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="grouped-series"]'),
      ).toHaveLength(3),
    );
    const rows = [
      ...document.querySelectorAll('[data-testid="grouped-series"]'),
    ].map((row) => row.textContent);
    // Duplicate names are disambiguated; totals are the series sums.
    expect(rows).toEqual(["Launch30", "Launch (c-2)6", "Other1"]);
    expect(document.querySelectorAll('svg[role="img"] path')).toHaveLength(3);
  });

  it("the metric and window chips re-query with metric= and days=", async () => {
    await render();
    await choose("domain");
    await waitFor(() => expect(timeseriesRequests()).toHaveLength(1));
    await act(async () => {
      chip("Metric", "Clicks").click();
    });
    await waitFor(() => expect(timeseriesRequests()).toHaveLength(2));
    expect(timeseriesRequests()[1].searchParams.get("metric")).toBe("clicks");
    expect(timeseriesRequests()[1].searchParams.get("group_by")).toBe("domain");

    await act(async () => {
      chip("Window", "7d").click();
    });
    await waitFor(() => expect(timeseriesRequests()).toHaveLength(3));
    expect(timeseriesRequests()[2].searchParams.get("days")).toBe("7");
    expect(chip("Window", "7d").getAttribute("aria-pressed")).toBe("true");
    expect(
      new URLSearchParams(window.location.search).get("breakdown_metric"),
    ).toBe("clicks");
    expect(
      new URLSearchParams(window.location.search).get("breakdown_days"),
    ).toBe("7");
  });

  it("restores the metric and independent window from a shared chart link", async () => {
    await render(
      "?range=90d&group_by=domain&breakdown_metric=bounces&breakdown_days=7",
    );
    await waitFor(() => expect(timeseriesRequests()).toHaveLength(1));
    expect(timeseriesRequests()[0].searchParams.get("metric")).toBe("bounces");
    expect(timeseriesRequests()[0].searchParams.get("days")).toBe("7");
    expect(chip("Metric", "Bounces").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Window", "7d").getAttribute("aria-pressed")).toBe("true");
  });

  it("an unavailable dimension cannot be selected and makes no request", async () => {
    await render();
    await choose("segment");
    await act(async () => flush());
    expect(timeseriesRequests()).toHaveLength(0);
    expect(window.location.search).not.toContain("group_by");
  });

  it("restores the dimension from a shared link", async () => {
    await render("?group_by=domain&focus=grouped-breakdown");
    await waitFor(() => expect(timeseriesRequests()).toHaveLength(1));
    expect(timeseriesRequests()[0].searchParams.get("group_by")).toBe("domain");
    expect(groupBy().value).toBe("domain");
    const card = document.querySelector(
      '[data-analytics-focus="grouped-breakdown"]',
    );
    expect(card?.getAttribute("data-focused")).toBe("true");
  });

  it("says a refused dimension is not available on this server", async () => {
    reply = () => ({
      status: 400,
      body: {
        error: {
          code: "unsupported_dimension",
          message: "group_by=list needs per-event list attribution",
        },
      },
    });
    await render("?group_by=campaign");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "aren't available on this server",
      ),
    );
  });

  it("renders the server's sentence and retries on any other failure", async () => {
    let calls = 0;
    reply = () => {
      calls += 1;
      return calls === 1
        ? {
            status: 400,
            body: {
              error: {
                code: "bad_metric",
                message: "metric must be one of opens, clicks, bounces",
              },
            },
          }
        : { status: 200, body: SERIES };
    };
    await render("?group_by=campaign");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "metric must be one of opens, clicks, bounces",
      ),
    );
    const retry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry",
    );
    await act(async () => {
      retry?.click();
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="grouped-series"]'),
      ).toHaveLength(3),
    );
  });

  it("an all-zero window says nothing was recorded rather than drawing flat lines", async () => {
    reply = () => ({
      status: 200,
      body: {
        series: [{ key: "c-1", label: "Launch", points: points([0, 0]) }],
      },
    });
    await render("?group_by=campaign");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No opens recorded in the last 30 days.",
      ),
    );
  });
});
