// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-17 — "Explain anomaly". Asserted by the request the verb makes
// (method, path, body) and what the dialog then renders, never by the mere
// presence of a button.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnomalyHistoryCard } from "@/components/dashboard/anomaly-history-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ANOMALIES = {
  items: [
    {
      id: "a1",
      metric: "bounces",
      dayBucket: "2026-09-10T00:00:00Z",
      value: 140,
      mean: 20.4,
      zScore: 4.1,
      rangeUsed: "30d",
      detectedAt: "2026-09-10T06:00:00Z",
    },
    {
      id: "a2",
      metric: "subscribers",
      dayBucket: "2026-09-09T00:00:00Z",
      value: 3,
      mean: 40,
      zScore: -3.2,
      rangeUsed: "7d",
      detectedAt: "2026-09-09T06:00:00Z",
    },
  ],
};

function brief(metric = "bounces", windowDays = 30) {
  return {
    metric,
    window_days: windowDays,
    summary: "Bounces rose after the Sept import.",
    probable_causes: ["A purchased list segment was imported."],
    suggested_actions: ["Suppress the imported segment and re-verify it."],
    aggregates: {
      metric,
      window_days: windowDays,
      current_total: 300,
      previous_total: 100,
      daily: [
        { day: "2026-09-09", value: 160 },
        { day: "2026-09-10", value: 140 },
      ],
      top_campaigns: [
        { campaign_id: CAMPAIGN, campaign_name: "September promo", value: 120 },
      ],
    },
    trace: { generated_at: "2026-09-10T07:00:00Z" },
  };
}

type Handler = (
  method: string,
  path: string,
  init?: RequestInit,
) => { status: number; body: unknown };

let handler: Handler;
let transport: ReturnType<typeof stubTransport>;

function stubTransport() {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    const { status, body } = handler(method, path, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function briefCalls() {
  return transport.mock.calls.filter(([input, init]) => {
    const url = typeof input === "string" ? input : String(input);
    return url.includes("/api/v1/analytics/anomaly-brief") && init?.method;
  });
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

async function render(role: "admin" | "viewer" = "viewer") {
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
        createElement(AnomalyHistoryCard, {
          tenantId: TENANT,
          role,
          userId: "user-1",
        }),
      ),
    );
  });
  await act(async () => flush());
  return container;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  handler = (method, path) => {
    if (method === "GET" && path === "/api/v1/dashboard/anomalies") {
      return { status: 200, body: ANOMALIES };
    }
    if (method === "POST" && path === "/api/v1/analytics/anomaly-brief") {
      return { status: 200, body: brief() };
    }
    return { status: 404, body: { error: { code: "not_found", message: "" } } };
  };
  transport = stubTransport();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AnomalyHistoryCard → Explain", () => {
  it("offers Explain only for metrics the brief can explain, and links each metric to a focused Analytics view", async () => {
    await render();
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="anomaly-history-row"]'),
      ).toHaveLength(2),
    );
    // bounces is on the brief whitelist; subscribers is not (it would 422).
    expect(() => button("Ask AI to explain the Bounces anomaly")).not.toThrow();
    expect(() =>
      button("Ask AI to explain the Subscribers anomaly"),
    ).toThrow();
    // The metric opens Analytics focused on it, over the detection window.
    const bounceLink = document.querySelector(
      'a[aria-label="Open Analytics focused on Bounces"]',
    );
    expect(bounceLink?.getAttribute("href")).toBe(
      "/app/analytics?metric=bounces",
    );
    const subsLink = document.querySelector(
      'a[aria-label="Open Analytics focused on Subscribers"]',
    );
    expect(subsLink?.getAttribute("href")).toBe(
      "/app/analytics?range=7d&metric=subscribers",
    );
  });

  it("POSTs the metric and detection window, then renders the brief and its evidence (any role — read:reports)", async () => {
    await render("viewer");
    await waitFor(() =>
      button("Ask AI to explain the Bounces anomaly"),
    );
    await act(async () => {
      button("Ask AI to explain the Bounces anomaly").click();
    });

    await waitFor(() => expect(briefCalls()).toHaveLength(1));
    const [, init] = briefCalls()[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      metric: "bounces",
      window_days: 30,
    });

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Bounces rose after the Sept import.",
      ),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Explain the bounce anomaly");
    expect(text).toContain("A purchased list segment was imported.");
    expect(text).toContain("Suppress the imported segment and re-verify it.");
    // Deterministic evidence: totals and the honest change.
    expect(text).toContain("+200% vs previous 30 days");
    const campaign = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "September promo",
    );
    expect(campaign?.getAttribute("href")).toBe(`/app/campaigns/${CAMPAIGN}`);
  });

  it("says AI is unavailable (without guessing a remedy) when the provider is not configured", async () => {
    handler = (method) =>
      method === "POST"
        ? {
            status: 503,
            body: {
              error: {
                code: "nlq_unavailable",
                message: "anomaly briefs are not configured.",
              },
            },
          }
        : { status: 200, body: ANOMALIES };
    await render();
    await waitFor(() => button("Ask AI to explain the Bounces anomaly"));
    await act(async () => {
      button("Ask AI to explain the Bounces anomaly").click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "AI features are not responding for this workspace",
      ),
    );
    expect(document.body.textContent).not.toContain("Try again");
  });

  it("renders the server's sentence for a refusal and retries on request", async () => {
    let posts = 0;
    handler = (method) => {
      if (method !== "POST") return { status: 200, body: ANOMALIES };
      posts += 1;
      return posts === 1
        ? {
            status: 429,
            body: {
              error: {
                code: "cost_cap_exceeded",
                message:
                  "daily NLQ token budget exhausted for this tenant; resets at UTC midnight",
              },
            },
          }
        : { status: 200, body: brief() };
    };
    await render();
    await waitFor(() => button("Ask AI to explain the Bounces anomaly"));
    await act(async () => {
      button("Ask AI to explain the Bounces anomaly").click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "daily NLQ token budget exhausted for this tenant",
      ),
    );
    await act(async () => {
      button("Try again").click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Bounces rose after the Sept import.",
      ),
    );
    expect(briefCalls()).toHaveLength(2);
  });

  it("redacts emails, links, profile ids and credentials the model echoes, before they reach the page", async () => {
    // The model reads raw events, so its prose can quote a subscriber or a
    // pasted secret. Desktop redacts before display; so must web.
    handler = (method) =>
      method === "POST"
        ? {
            status: 200,
            body: {
              ...brief(),
              summary:
                "Bounces spiked for ada@example.com after https://evil.example/x was linked.",
              probable_causes: ["subscriber_id: 8f3a2b1c9d imported with api_key=sk_live_ABCDEF123456"],
              suggested_actions: ["Call +1 (415) 555-0100 and suppress the segment."],
            },
          }
        : { status: 200, body: ANOMALIES };
    await render();
    await waitFor(() => button("Ask AI to explain the Bounces anomaly"));
    await act(async () => {
      button("Ask AI to explain the Bounces anomaly").click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("[email redacted]"),
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("8f3a2b1c9d");
    expect(text).not.toContain("sk_live_ABCDEF123456");
    expect(text).not.toContain("555-0100");
    expect(text).toContain("[link redacted]");
    expect(text).toContain("[profile identifier redacted]");
    expect(text).toContain("[credential redacted]");
    expect(text).toContain("[phone redacted]");
  });

  it("refuses a brief whose metric does not match the question", async () => {
    handler = (method) =>
      method === "POST"
        ? { status: 200, body: brief("opens", 30) }
        : { status: 200, body: ANOMALIES };
    await render();
    await waitFor(() => button("Ask AI to explain the Bounces anomaly"));
    await act(async () => {
      button("Ask AI to explain the Bounces anomaly").click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "was for a different metric or window",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "Bounces rose after the Sept import.",
    );
  });

  it("reports a failed anomaly read instead of hiding the card", async () => {
    // A 4xx is not retried by the transport, so the failure lands at once.
    handler = () => ({
      status: 403,
      body: { error: { code: "forbidden", message: "Not allowed." } },
    });
    await render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Recent anomalies couldn't be loaded.",
      ),
    );
  });
});
