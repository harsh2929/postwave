// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The Core Web Vitals reporter, driven through the real page-lifecycle
// events it listens for.
//
// Staging logged 264 HTTP 429s from POST /api/internal/web-vitals in a
// four-browser run, dozens per session: the reporter sent one request per
// metric — including Next's own markers on every client-side navigation —
// against an endpoint that allows 100 events per minute per IP, and kept
// sending into the 429s. On hosted form pages (forms.<domain>) every load
// also posted cross-origin to an endpoint that does not allow that origin,
// and the browser refused it.
//
// What must hold:
//   - nothing is sent while the page is visible; one batch goes out when it
//     is hidden (visibilitychange) or unloaded (pagehide);
//   - the batch carries each Core Web Vital once, at its latest value, and
//     none of Next's markers;
//   - a 429 is never retried, and the tab stays quiet until the back-off
//     passes, across page loads;
//   - hosted form pages on their own origin send nothing cross-origin;
//   - telemetry never throws into the page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebVitalsMetric } from "@/lib/web-vitals";

const ENDPOINT = "/api/internal/web-vitals";
const CROSS_ORIGIN_ENDPOINT =
  "https://api.example.test/api/internal/web-vitals";

type Reporter = (metric: WebVitalsMetric) => void;

interface Sent {
  via: "fetch" | "beacon";
  url: string;
  init?: RequestInit;
  body: string;
}

let sent: Sent[] = [];
let fetchStatus = 204;
let visibility: DocumentVisibilityState = "visible";
const added: Array<[string, EventListenerOrEventListenerObject]> = [];

function metric(
  name: string,
  value: number,
  label: WebVitalsMetric["label"] = "web-vital",
): WebVitalsMetric {
  return { id: `v4-${name}-${value}`, name, label, value, rating: "good" };
}

async function loadReporter(): Promise<Reporter> {
  // A fresh module per test: the reporter keeps per-page state.
  vi.resetModules();
  return (await import("@/lib/web-vitals")).reportWebVitals;
}

function setLocation(url: string): void {
  const happyDOM = (
    window as unknown as { happyDOM?: { setURL(u: string): void } }
  ).happyDOM;
  if (!happyDOM) throw new Error("happy-dom URL control unavailable");
  happyDOM.setURL(url);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function hidePage(): Promise<void> {
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  await settle();
}

async function showPage(): Promise<void> {
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  await settle();
}

function batch(index: number): Array<{ name: string; value: number }> {
  return JSON.parse(sent[index].body) as Array<{ name: string; value: number }>;
}

beforeEach(() => {
  sent = [];
  fetchStatus = 204;
  visibility = "visible";
  setLocation("https://app.example.test/app/campaigns");
  window.sessionStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_WEB_VITALS_ENDPOINT", ENDPOINT);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  // Track the reporter's window listeners so each test starts clean.
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: EventListenerOrEventListenerObject, options?) => {
      added.push([type, listener]);
      original(type, listener, options);
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ via: "fetch", url, init, body: String(init.body) });
      return new Response(null, {
        status: fetchStatus,
        headers: fetchStatus === 429 ? { "Retry-After": "60" } : {},
      });
    }),
  );
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body: string) => {
      sent.push({ via: "beacon", url, body: String(body) });
      return true;
    },
  });
});

afterEach(() => {
  for (const [type, listener] of added.splice(0)) {
    window.removeEventListener(type, listener);
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("one batch per page view", () => {
  it("sends nothing while the page is visible, then one batch when it is hidden", async () => {
    const report = await loadReporter();
    report(metric("TTFB", 120));
    report(metric("FCP", 800));
    report(metric("LCP", 2400));
    report(metric("CLS", 0.02));
    await settle();
    expect(sent).toEqual([]);

    await hidePage();

    expect(sent).toHaveLength(1);
    expect(sent[0].via).toBe("fetch");
    expect(sent[0].url).toBe(ENDPOINT);
    expect(
      batch(0)
        .map((e) => e.name)
        .sort(),
    ).toEqual(["CLS", "FCP", "LCP", "TTFB"]);
    const init = sent[0].init as RequestInit & { keepalive?: boolean };
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
    // CORS-simple: no preflight for a cross-origin ingest endpoint.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "text/plain;charset=UTF-8",
    );
  });

  it("carries each metric once, at its latest value", async () => {
    const report = await loadReporter();
    report(metric("CLS", 0.01));
    report(metric("CLS", 0.07));
    report(metric("INP", 90));
    report(metric("INP", 180));
    await hidePage();

    expect(sent).toHaveLength(1);
    const events = batch(0);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.name === "CLS")?.value).toBe(0.07);
    expect(events.find((e) => e.name === "INP")?.value).toBe(180);
  });

  it("drops Next's own markers, which are not web vitals", async () => {
    const report = await loadReporter();
    report(metric("Next.js-hydration", 40, "custom"));
    report(metric("Next.js-route-change-to-render", 12, "custom"));
    report(metric("Next.js-render", 9, "custom"));
    await hidePage();
    expect(sent).toEqual([]);

    report(metric("LCP", 1800));
    report(metric("Next.js-render", 9, "custom"));
    await showPage();
    await hidePage();
    expect(sent).toHaveLength(1);
    expect(batch(0).map((e) => e.name)).toEqual(["LCP"]);
  });

  it("sends a final value that arrives after the hide in the same batch cycle", async () => {
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    expect(sent).toHaveLength(1);

    // The library reports CLS from its own hidden listener, after ours.
    report(metric("CLS", 0.03));
    await settle();
    expect(sent).toHaveLength(2);
    expect(batch(1).map((e) => e.name)).toEqual(["CLS"]);
  });

  it("uses sendBeacon on pagehide and sends nothing twice", async () => {
    const report = await loadReporter();
    report(metric("LCP", 1800));
    window.dispatchEvent(new Event("pagehide"));
    await hidePage();

    expect(sent).toHaveLength(1);
    expect(sent[0].via).toBe("beacon");
    expect(batch(0).map((e) => e.name)).toEqual(["LCP"]);
  });

  it("keeps one anonymous session id across the batch and redacts capability paths", async () => {
    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    setLocation(`https://app.example.test/en/preferences/${token}?t=1#x`);
    const report = await loadReporter();
    report(metric("LCP", 1800));
    report(metric("FCP", 600));
    await hidePage();

    const events = JSON.parse(sent[0].body) as Array<{
      id: string;
      session_id: string;
      page: string;
      href?: string;
      tenant_id?: string;
    }>;
    expect(events[0].session_id).toBeTruthy();
    expect(events[0].session_id).toBe(events[1].session_id);
    expect(events[0].session_id).not.toBe(events[0].id);
    expect(events[0].page).toBe("/en/preferences/[redacted]");
    expect(sent[0].body).not.toContain(token);
    expect(events[0].href).toBeUndefined();
    expect(events[0].tenant_id).toBeUndefined();
  });
});

describe("rate limiting", () => {
  it("never retries a 429 and stays quiet for the back-off, across page loads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
    fetchStatus = 429;
    let report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    expect(sent).toHaveLength(1);

    // Same tab, next page view: still inside the server's window.
    fetchStatus = 204;
    report = await loadReporter();
    await showPage();
    report(metric("LCP", 1700));
    report(metric("CLS", 0.01));
    await hidePage();
    expect(sent).toHaveLength(1);

    // The dropped batch is gone, not queued for later.
    vi.setSystemTime(new Date("2026-09-19T12:01:01Z"));
    await showPage();
    await hidePage();
    expect(sent).toHaveLength(1);

    // After the window, a new page view reports again — once.
    report(metric("FCP", 500));
    await showPage();
    await hidePage();
    expect(sent).toHaveLength(2);
    expect(batch(1).map((e) => e.name)).toEqual(["FCP"]);
  });
});

describe("origins", () => {
  it("does not post cross-origin from a hosted form page", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VITALS_ENDPOINT", CROSS_ORIGIN_ENDPOINT);
    setLocation("https://forms.example.test/forms/newsletter");
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    window.dispatchEvent(new Event("pagehide"));
    expect(sent).toEqual([]);
  });

  it("posts cross-origin from the app origin the endpoint allows", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VITALS_ENDPOINT", CROSS_ORIGIN_ENDPOINT);
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    expect(sent.map((s) => s.url)).toEqual([CROSS_ORIGIN_ENDPOINT]);
  });

  it("reports from a hosted form page when the endpoint is on its own origin", async () => {
    setLocation("https://forms.example.test/forms/newsletter");
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    expect(sent).toHaveLength(1);
  });
});

describe("configuration and failures", () => {
  it("is a no-op when no endpoint is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VITALS_ENDPOINT", "");
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    expect(sent).toEqual([]);
  });

  it("drops unsafe endpoints", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VITALS_ENDPOINT", "javascript:alert(1)");
    const report = await loadReporter();
    expect(() => report(metric("LCP", 1800))).not.toThrow();
    await hidePage();
    expect(sent).toEqual([]);
  });

  it("normalizes absolute endpoints without fragments", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_WEB_VITALS_ENDPOINT",
      "https://app.example.test/ingest#secret",
    );
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    expect(sent[0].url).toBe("https://app.example.test/ingest");
  });

  it("falls back to sendBeacon when fetch throws, and never throws itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new TypeError("fetch blocked");
      }),
    );
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await expect(hidePage()).resolves.toBeUndefined();
    expect(sent.map((s) => s.via)).toEqual(["beacon"]);
  });

  it("swallows a rejected request without resending it", async () => {
    const rejected = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", rejected);
    const report = await loadReporter();
    report(metric("LCP", 1800));
    await hidePage();
    await showPage();
    await hidePage();
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});
