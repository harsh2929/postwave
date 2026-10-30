// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-42 — Chart actions → Download PNG. Driven through the grouped
// breakdown card (whose ChartActions receives the card element). Asserted by
// consequence: the file handed to lib/download (name + image/png blob), the
// SVG that is rasterized (the chart's lines, with computed colours inlined —
// not the menu's own icon), and the reported outcome when there is nothing
// to capture or the capture fails.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

const downloads = vi.hoisted(() => ({
  downloadBlobFile: vi.fn((_filename: string, _blob: Blob) => {}),
  downloadTextFile: vi.fn(),
}));
vi.mock("@/lib/download", () => downloads);

import { ChartActions } from "@/components/analytics/chart-actions";
import { GroupedBreakdownCard } from "@/components/analytics/grouped-breakdown-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SERIES = {
  series: [
    {
      key: "c-1",
      label: "Launch",
      points: [
        { date: "2026-09-01", value: 5 },
        { date: "2026-09-02", value: 9 },
      ],
    },
    {
      key: "c-2",
      label: "Promo",
      points: [
        { date: "2026-09-01", value: 2 },
        { date: "2026-09-02", value: 4 },
      ],
    },
  ],
  classification_filter: "all",
};

let root: Root | null = null;
let drawn: Array<{ src: string }> = [];
let blobOut: Blob | null;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private value = "";
  set src(v: string) {
    this.value = v;
    drawn.push({ src: v });
    queueMicrotask(() => this.onload?.());
  }
  get src() {
    return this.value;
  }
}

const ctx = {
  scale: vi.fn(),
  fillRect: vi.fn(),
  drawImage: vi.fn(),
  fillStyle: "",
};

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

async function renderCard(search: string) {
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
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  );
  if (!match) throw new Error(`no button ${name}`);
  return match as HTMLButtonElement;
}

async function choose(item: string) {
  await act(async () => {
    button("More actions for Engagement breakdown").click();
  });
  await act(async () => {
    button(item).click();
  });
  await act(async () => flush());
  await act(async () => flush());
}

function decodedSvg(): string {
  const src = drawn[0]?.src ?? "";
  expect(src.startsWith("data:image/svg+xml;base64,")).toBe(true);
  const bytes = Uint8Array.from(
    atob(src.slice("data:image/svg+xml;base64,".length)),
    (c) => c.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

/**
 * happy-dom computes no SVG presentation styles, so stand in for the browser:
 * chart paths resolve their theme colour, and the card paints a dark ground.
 */
function stubComputedStyles() {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const real = original(el, pseudo);
    const isPath = el.tagName.toLowerCase() === "path";
    const isCard = el.getAttribute("data-slot") === "card";
    if (!isPath && !isCard) return real;
    return {
      backgroundColor: isCard ? "rgb(20, 20, 20)" : real.backgroundColor,
      getPropertyValue: (property: string) =>
        isPath && property === "stroke"
          ? "rgb(200, 16, 46)"
          : real.getPropertyValue(property),
    } as unknown as CSSStyleDeclaration;
  });
}

beforeEach(() => {
  drawn = [];
  ctx.fillStyle = "";
  stubComputedStyles();
  blobOut = new Blob(["png-bytes"], { type: "image/png" });
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  vi.stubGlobal("Image", FakeImage);
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctx,
  ) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    callback: BlobCallback,
  ) {
    callback(blobOut);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(SERIES), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("Download PNG (analytics-42)", () => {
  it("rasterizes the chart's own SVG and downloads it as <chart>-<window>.png", async () => {
    await renderCard("?group_by=campaign");
    await waitFor(() =>
      expect(document.querySelectorAll('svg[role="img"] path')).toHaveLength(2),
    );
    await choose("Download PNG");

    await waitFor(() =>
      expect(downloads.downloadBlobFile).toHaveBeenCalledTimes(1),
    );
    const [filename, blob] = downloads.downloadBlobFile.mock.calls[0];
    expect(filename).toBe("engagement-breakdown-30d.png");
    expect(blob).toBe(blobOut);
    expect(blob.type).toBe("image/png");
    expect(toastMocks.success).toHaveBeenCalledWith("Chart image downloaded.");

    // What was drawn is the chart (two series paths, standalone SVG with
    // explicit size and inlined stroke), not the menu's lucide icon.
    const svg = decodedSvg();
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/role="img"/);
    expect(svg.match(/<path/g)).toHaveLength(2);
    expect(svg).not.toContain("lucide");
    expect(svg).toMatch(/width="\d+"/);
    // The theme colour is resolved onto each path: a detached SVG has no
    // stylesheet, so var(--chart-*) alone would paint black.
    expect(svg.match(/stroke: rgb\(200, 16, 46\)/g)).toHaveLength(2);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    // The card's own background is painted first, so a dark-theme chart
    // isn't a transparent PNG.
    expect(ctx.fillStyle).toBe("rgb(20, 20, 20)");
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("with no chart on the card, says so and downloads nothing", async () => {
    // Aggregate view: the card holds only icons, no chart SVG.
    await renderCard("");
    expect(document.querySelector('svg[role="img"]')).toBeNull();
    expect(document.querySelectorAll("svg").length).toBeGreaterThan(0);
    await choose("Download PNG");
    expect(toastMocks.info).toHaveBeenCalledWith(
      "There's no chart to capture yet.",
    );
    expect(downloads.downloadBlobFile).not.toHaveBeenCalled();
  });

  it("a failed capture is reported, never silent", async () => {
    blobOut = null;
    await renderCard("?group_by=domain");
    await waitFor(() =>
      expect(document.querySelectorAll('svg[role="img"] path')).toHaveLength(2),
    );
    await choose("Download PNG");
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "The chart image couldn't be created. Take a screenshot instead.",
      ),
    );
    expect(downloads.downloadBlobFile).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("charts that pass no element keep a Copy-link-only menu", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(ChartActions, { chartId: "key-rates", chartName: "Rates" }),
      );
    });
    await act(async () => {
      button("More actions for Rates").click();
    });
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
        i.textContent?.trim(),
      ),
    ).toEqual(["Copy link"]);
  });
});
