// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// /dmarc sending sources → per-source aggregate evidence (parity row
// deliverability-10). Desktop: DmarcTopSourcesTable onSelect →
// DmarcSourceSlideover → GET /api/v1/deliverability/dmarc-sources.
//
// Requests are asserted at the stubbed fetch with the FULL query key set:
// the server allow-lists `ip`, `domain`, `days` and rejects any other name
// (and an empty `domain=`), so an extra or empty key is a defect.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/dmarc",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const NOW = new Date("2026-09-05T12:00:00.000Z");
const SNAPSHOT_AT = "2026-09-05T11:59:58.000Z";
const REPORTS_PATH = "/api/v1/deliverability/dmarc-reports";
const INSIGHTS_PATH = "/api/v1/deliverability/dmarc-insights";
const SOURCES_PATH = "/api/v1/deliverability/dmarc-sources";

const V4 = "192.0.2.10";
const V6 = "2001:db8::1";

function sourceRow(ip: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceIp: ip,
    messages: 120,
    dkimPass: 90,
    spfPass: 70,
    bothPass: 60,
    alignedPct: 100 / 120,
    primaryDisposition: "quarantine",
    quarantined: 20,
    rejected: 0,
    envelopeFromDomain: "bounce.example.com",
    ...overrides,
  };
}

type SourceMode = "ok" | "partial" | "denied" | "mismatch";
let sourceMode: SourceMode = "ok";

function urlOf(input: RequestInfo | URL): URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return new URL(raw, "http://postwave.test");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function insightsFor(url: URL) {
  return {
    domain: url.searchParams.get("domain") ?? "",
    periodDays: Number(url.searchParams.get("days") ?? "30"),
    reportCount: 3,
    totalMessages: 400,
    sourceCount: 5,
    sourceListTruncated: true,
    reportingDays: 2,
    alignment: {
      bothPass: 150,
      dkimOnlyPass: 30,
      spfOnlyPass: 20,
      neitherPass: 20,
      alignedPct: 0.9,
    },
    suggestions: [],
    // The third row names no source IP: it cannot be opened, so it must not
    // be rendered as a drill-down.
    topSources: [
      sourceRow(V4, { primaryDisposition: "none", quarantined: 0 }),
      sourceRow(V6),
      { messages: 3 },
    ],
    topFailingSources: [sourceRow(V6)],
    generatedAt: SNAPSHOT_AT,
  };
}

function reportsFor() {
  return {
    items: [],
    meta: {
      generatedAt: SNAPSHOT_AT,
      limit: 500,
      returned: 0,
      totalReports: 0,
      hasMore: false,
      availableDomains: ["example.com"],
      domainInventoryTruncated: false,
      scope: {},
    },
  };
}

function sourceFor(url: URL) {
  const ip = url.searchParams.get("ip") ?? "";
  const days = Number(url.searchParams.get("days") ?? "30");
  const domain = url.searchParams.get("domain");
  const perReport = [
    {
      reportId: "0f4c9a2e-1111-4111-8111-aaaaaaaaaaaa",
      orgName: "google.com",
      dateBegin: "2026-09-01T00:00:00Z",
      dateEnd: "2026-09-01T23:59:59Z",
      messages: 80,
      dkimPass: 60,
      spfPass: 50,
      bothPass: 40,
      alignedPct: 70 / 80,
      primaryDisposition: "none",
    },
    {
      reportId: "0f4c9a2e-2222-4222-8222-bbbbbbbbbbbb",
      orgName: "Yahoo",
      dateBegin: "2026-08-30T00:00:00Z",
      dateEnd: "2026-08-30T23:59:59Z",
      messages: 40,
      dkimPass: 30,
      spfPass: 20,
      bothPass: 20,
      alignedPct: 30 / 40,
      primaryDisposition: "quarantine",
    },
  ];
  return {
    sourceIp: sourceMode === "mismatch" ? "198.51.100.7" : ip,
    periodDays: days,
    ...(domain ? { domain } : {}),
    generatedAt: SNAPSHOT_AT,
    windowStart: new Date(
      Date.parse(SNAPSHOT_AT) - days * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    windowEnd: SNAPSHOT_AT,
    hasMore: sourceMode === "partial",
    summary: sourceRow(ip),
    perReport,
  };
}

function stubTransport(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = urlOf(input);
      if (url.pathname === REPORTS_PATH) return json(reportsFor());
      if (url.pathname === INSIGHTS_PATH) return json(insightsFor(url));
      if (url.pathname === SOURCES_PATH) {
        if (sourceMode === "denied") {
          return json(
            {
              error: {
                code: "invalid_ip",
                message: "ip must be a valid IPv4 or IPv6 address",
              },
            },
            400,
          );
        }
        return json(sourceFor(url));
      }
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
}

function requests(pathname: string): Array<{ url: URL; method: string }> {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input, init]) => ({
      url: urlOf(input),
      method: (init?.method ?? "GET").toUpperCase(),
    }))
    .filter((call) => call.url.pathname === pathname);
}

function sortedEntries(url: URL): Array<[string, string]> {
  return [...url.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

function sourceButtons(container: HTMLElement, ip?: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (candidate) => {
      const label = candidate.getAttribute("aria-label") ?? "";
      return ip
        ? label === `Open aggregate evidence for source ${ip}`
        : label.startsWith("Open aggregate evidence for source ");
    },
  );
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? "";
}

async function mount() {
  const Page = (await import("@/app/(dashboard)/app/dmarc/page")).default;
  return renderPage(Page);
}

beforeEach(() => {
  vi.clearAllMocks();
  sourceMode = "ok";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubTransport();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dmarc sending sources", () => {
  it("renders the server ranking and says it is partial", async () => {
    const { container, root } = await mount();
    try {
      const section = container.querySelector(
        '[aria-labelledby="dm-sources"]',
      );
      expect(section).not.toBeNull();
      const text = section!.textContent ?? "";
      expect(text).toContain(
        "5 source IPs observed. This is the server's top 2, not a complete source inventory.",
      );
      expect(text).toContain("Sources needing investigation");
      // 83.3% aligned, quarantine as the primary action.
      expect(text).toContain("83.3%");
      expect(text).toContain("Quarantine");
      expect(text).toContain("bounce.example.com");
      // Failing table (V6) + top table (V4, V6); the IP-less row is dropped.
      expect(sourceButtons(container, V4)).toHaveLength(1);
      expect(sourceButtons(container, V6)).toHaveLength(2);
      expect(sourceButtons(container)).toHaveLength(3);
      expect(text).not.toContain("undefined");
      expect(requests(SOURCES_PATH)).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("opens a source's evidence with GET dmarc-sources for the ranked scope", async () => {
    const { container, root } = await mount();
    try {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await click(sourceButtons(container, V4)[0]!);

      const calls = requests(SOURCES_PATH);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("GET");
      // Tenant-wide 30-day default: no `domain` key at all.
      expect(sortedEntries(calls[0]!.url)).toEqual([
        ["days", "30"],
        ["ip", V4],
      ]);

      const detail = dialogText();
      expect(detail).toContain("Source evidence");
      expect(detail).toContain(V4);
      expect(detail).toContain("All available domains · 30-day window");
      expect(detail).toContain("do not identify the sender");
      // Summary: 120 messages, 90+70−60 = 100 aligned (83.3%).
      expect(detail).toContain("120");
      expect(detail).toContain("83.3%");
      expect(detail).toContain("100 messages");
      expect(detail).toContain("20 quarantine · 0 reject");
      expect(detail).toContain("Envelope-from domain");
      // Per-report rows, newest first, with their own alignment.
      expect(detail).toContain("Complete list");
      expect(detail).toContain("google.com");
      expect(detail).toContain("87.5%");
      expect(detail).toContain("Yahoo");
      expect(detail).toContain("75.0%");
      expect(detail).not.toContain("not a complete per-report inventory");
    } finally {
      unmount(root);
    }
  });

  it("carries the selected domain and window, and marks a partial breakdown", async () => {
    sourceMode = "partial";
    const { container, root } = await mount();
    try {
      const select = container.querySelector<HTMLSelectElement>(
        "select#dmarc-domain",
      );
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        setter?.call(select, "example.com");
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
      const ninety = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "90 days",
      );
      await click(ninety!);

      await click(sourceButtons(container, V6)[0]!);

      const calls = requests(SOURCES_PATH);
      expect(calls).toHaveLength(1);
      expect(sortedEntries(calls[calls.length - 1]!.url)).toEqual([
        ["days", "90"],
        ["domain", "example.com"],
        ["ip", V6],
      ]);
      const detail = dialogText();
      expect(detail).toContain("example.com · 90-day window");
      expect(detail).toContain("Partial list");
      expect(detail).toContain(
        "There is no continuation cursor, so it is not a complete per-report inventory.",
      );
    } finally {
      unmount(root);
    }
  });

  it("renders the server's denial verbatim and retries on request", async () => {
    sourceMode = "denied";
    const { container, root } = await mount();
    try {
      await click(sourceButtons(container, V4)[0]!);
      const alert = document.querySelector('[role="dialog"] [role="alert"]');
      expect(alert?.textContent).toContain(
        "ip must be a valid IPv4 or IPv6 address",
      );
      expect(alert?.textContent).toContain(
        "No source metrics have been inferred.",
      );
      expect(dialogText()).not.toContain("Per-report breakdown");

      const before = requests(SOURCES_PATH).length;
      const retry = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ].find((candidate) => candidate.textContent?.trim() === "Retry");
      expect(retry).toBeDefined();
      sourceMode = "ok";
      await click(retry!);
      expect(requests(SOURCES_PATH)).toHaveLength(before + 1);
      expect(dialogText()).toContain("Per-report breakdown");
      expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("withholds a response that answers for a different source", async () => {
    sourceMode = "mismatch";
    const { container, root } = await mount();
    try {
      await click(sourceButtons(container, V4)[0]!);
      const alert = document.querySelector('[role="dialog"] [role="alert"]');
      expect(alert?.textContent).toContain(
        "did not match the requested source and window",
      );
      expect(dialogText()).not.toContain("198.51.100.7");
      expect(dialogText()).not.toContain("Per-report breakdown");
    } finally {
      unmount(root);
    }
  });
});
