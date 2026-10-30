// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-47 — Campaign compare card: hand-pick campaigns (up to six),
// compare rates with z-test confidence, reload. Asserted by the request each
// selection makes (GET /api/v1/analytics/campaigns/compare?ids=…), the
// confidence label each column's leader gets, the limit that blocks a
// seventh pick, and the server's sentence on a refusal.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CampaignCompareCard,
  compareColumnVerdicts,
} from "@/components/analytics/campaign-compare-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function campaign(id: string, name: string, status = "sent") {
  return { id, tenant_id: TENANT, name, subject: `${name} subject`, status };
}

let campaigns = [
  campaign("c1", "Spring launch"),
  campaign("c2", "Promo"),
  campaign("draft-1", "Unsent draft", "draft"),
  campaign("c3", "Newsletter"),
  campaign("c4", "Winback", "sending"),
];

interface Row {
  campaign_id: string;
  total_recipients: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
  unsub_rate: number;
}

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    campaign_id: id,
    total_recipients: 1000,
    open_rate: 0.2,
    click_rate: 0.05,
    bounce_rate: 0.01,
    complaint_rate: 0.001,
    unsub_rate: 0.002,
    ...over,
  };
}

let compareReply: (ids: string[]) => { status: number; body: unknown };
let transport: ReturnType<typeof vi.fn>;

function stub() {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(raw, "http://localhost");
    let status = 200;
    let body: unknown = {};
    if (url.pathname === "/api/v1/campaigns") {
      body = campaigns;
    } else if (url.pathname === "/api/v1/analytics/campaigns/compare") {
      ({ status, body } = compareReply(
        (url.searchParams.get("ids") ?? "").split(","),
      ));
    } else {
      status = 404;
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function compareRequests(): string[] {
  return transport.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((url) => url.pathname === "/api/v1/analytics/campaigns/compare")
    .map((url) => url.searchParams.get("ids") ?? "");
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

async function render() {
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
        createElement(CampaignCompareCard, {
          tenantId: TENANT,
          role: "viewer",
          userId: "user-1",
        }),
      ),
    );
  });
  await act(async () => flush());
}

function pill(name: string): HTMLButtonElement {
  const group = document.querySelector(
    '[role="group"][aria-label="Campaigns included in the comparison"]',
  );
  const match = [...(group?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!match) throw new Error(`no pill ${name}`);
  return match as HTMLButtonElement;
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!match) throw new Error(`no button ${name}`);
  return match as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await act(async () => flush());
}

/** Cell text for a campaign row + rate column index (0 = Recipients). */
function cell(campaignName: string, column: string): string {
  const table = document.querySelector("table");
  const headers = [...(table?.querySelectorAll("thead th") ?? [])].map(
    (th) => th.textContent ?? "",
  );
  const index = headers.findIndex((h) => h.startsWith(column));
  const tr = [...(table?.querySelectorAll("tbody tr") ?? [])].find(
    (r) => r.querySelector("th")?.textContent === campaignName,
  );
  if (!tr || index < 0) throw new Error(`no cell ${campaignName}/${column}`);
  return tr.children[index]?.textContent ?? "";
}

beforeEach(() => {
  campaigns = [
    campaign("c1", "Spring launch"),
    campaign("c2", "Promo"),
    campaign("draft-1", "Unsent draft", "draft"),
    campaign("c3", "Newsletter"),
    campaign("c4", "Winback", "sending"),
  ];
  compareReply = (ids) => ({ status: 200, body: ids.map((id) => row(id)) });
  transport = stub();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Campaign compare card (analytics-47)", () => {
  it("offers only delivered campaigns and compares the three most recent by default", async () => {
    await render();
    await waitFor(() => expect(compareRequests()).toEqual(["c1,c2,c3"]));
    const names = [
      ...document.querySelectorAll(
        '[role="group"][aria-label="Campaigns included in the comparison"] button',
      ),
    ].map((b) => b.textContent?.trim());
    expect(names).toEqual(["Spring launch", "Promo", "Newsletter", "Winback"]);
    expect(pill("Spring launch").getAttribute("aria-pressed")).toBe("true");
    expect(pill("Winback").getAttribute("aria-pressed")).toBe("false");
    expect(document.body.textContent).toContain("3 of 6 selected.");
  });

  it("hand-picking toggles campaigns in and out of the compare request", async () => {
    await render();
    await waitFor(() => expect(compareRequests()).toHaveLength(1));
    await click(pill("Newsletter"));
    await waitFor(() =>
      expect(compareRequests()).toEqual(["c1,c2,c3", "c1,c2"]),
    );
    await click(pill("Winback"));
    await waitFor(() =>
      expect(compareRequests()).toEqual(["c1,c2,c3", "c1,c2", "c1,c2,c4"]),
    );
    expect(pill("Winback").getAttribute("aria-pressed")).toBe("true");

    // Below two there is nothing to compare: no request, and it says so.
    await click(pill("Spring launch"));
    await click(pill("Promo"));
    await act(async () => flush());
    expect(compareRequests()).toHaveLength(4); // c2,c4 only
    expect(compareRequests()[3]).toBe("c2,c4");
    expect(document.body.textContent).toContain(
      "Select at least two campaigns to compare",
    );
  });

  it("stops at six: the seventh is disabled with the limit named, and makes no request", async () => {
    campaigns = Array.from({ length: 8 }, (_, i) =>
      campaign(`c${i + 1}`, `Campaign ${i + 1}`),
    );
    await render();
    await waitFor(() => expect(compareRequests()).toHaveLength(1));
    for (const n of [4, 5, 6]) await click(pill(`Campaign ${n}`));
    await waitFor(() =>
      expect(compareRequests().at(-1)).toBe("c1,c2,c3,c4,c5,c6"),
    );
    const seventh = pill("Campaign 7");
    expect(seventh.getAttribute("aria-disabled")).toBe("true");
    const notice = document.getElementById(
      seventh.getAttribute("aria-describedby") ?? "",
    );
    expect(notice?.textContent).toContain("Comparison limit reached (6)");
    const before = compareRequests().length;
    await click(seventh);
    expect(seventh.getAttribute("aria-pressed")).toBe("false");
    expect(compareRequests()).toHaveLength(before);
  });

  it("labels each column's leader by z-test confidence — best only when significant", async () => {
    compareReply = () => ({
      status: 200,
      body: [
        // Opens: 30% vs 20% over 1,000 each → p ≪ 0.01.
        row("c1", { open_rate: 0.3, click_rate: 0.051 }),
        // Clicks: 5.1% vs 5.0% → not significant.
        row("c2", { open_rate: 0.2, click_rate: 0.05 }),
        // Bounce (lower is better): a tiny list leads → low sample.
        row("c3", {
          total_recipients: 40,
          open_rate: 0.1,
          click_rate: 0.01,
          bounce_rate: 0,
        }),
      ],
    });
    await render();
    await waitFor(() => expect(document.querySelector("table")).not.toBeNull());
    expect(cell("Spring launch", "Open")).toBe("30.0%Best · 99%");
    expect(cell("Promo", "Open")).toBe("20.0%");
    expect(cell("Spring launch", "Click")).toBe("5.1%leads — not significant");
    expect(cell("Newsletter", "Bounce")).toBe("0.0%leads — low sample");
    expect(cell("Newsletter", "Recipients")).toBe("40");
    expect(document.body.textContent).not.toContain("Best · 95%");
  });

  it("Reload re-reads the comparison", async () => {
    await render();
    await waitFor(() => expect(compareRequests()).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("table")).not.toBeNull());
    await click(button("Reload"));
    await waitFor(() =>
      expect(compareRequests()).toEqual(["c1,c2,c3", "c1,c2,c3"]),
    );
  });

  it("a refused comparison renders the server's sentence with Retry", async () => {
    compareReply = () => ({
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: "Your role cannot read campaign reports.",
        },
      },
    });
    await render();
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Comparison failed: Your role cannot read campaign reports.",
      ),
    );
    expect(document.querySelector("table")).toBeNull();
    compareReply = (ids) => ({ status: 200, body: ids.map((id) => row(id)) });
    await click(button("Retry"));
    await waitFor(() => expect(document.querySelector("table")).not.toBeNull());
  });

  it("with fewer than two delivered campaigns it says why instead of comparing", async () => {
    campaigns = [campaign("c1", "Only one"), campaign("d", "Draft", "draft")];
    await render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Send at least two campaigns to compare them side by side.",
      ),
    );
    expect(compareRequests()).toHaveLength(0);
  });
});

it("does not assign a leader to campaigns with no measured recipients", () => {
  expect(
    compareColumnVerdicts([
      row("empty-a", { total_recipients: 0 }),
      row("empty-b", { total_recipients: 0 }),
    ]).size,
  ).toBe(0);
  expect(
    compareColumnVerdicts([
      row("measured"),
      row("empty", { total_recipients: 0 }),
    ]).size,
  ).toBe(0);
});
