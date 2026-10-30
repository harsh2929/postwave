// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Reachability of the home-dashboard parity components FROM THE PAGE
// (app/(dashboard)/app/page.tsx). Each component has its own unit test; this
// file proves a user on /app actually gets them:
//
//   analytics-15  Opens / Clicks tiles drill into Analytics focused on the KPI
//   analytics-13  "Share snapshot" copies the stats the page loaded
//   analytics-27  the subscriber forecast renders from the same stats payload
//   analytics-29  the live bar opens GET /api/v1/dashboard/live, and its frames
//                 replace the page's cached stats
//
// EventSource: happy-dom has none, so every page test that does not stub it
// takes the "no SSE" branch (stream reported closed, polling stays the source
// of truth). That default is asserted here too, because it is what keeps the
// other home-page tests from opening a stream.
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
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

/** A complete stats payload: every distinct-recipient field the snapshot needs. */
const STATS = {
  subscribers_total: 12481,
  subscribers_added_30d: 300,
  subscribers_unsubbed_30d: 12,
  campaigns_sent_30d: 4,
  opens_total_30d: 9000,
  clicks_total_30d: 700,
  bounces_total_30d: 50,
  unique_opens_30d: 224,
  unique_clicks_30d: 31,
  unique_bounces_30d: 8,
  unique_delivered_30d: 1000,
  unique_sent_30d: 1000,
  // A flat 100/day over 14 days projects the 25,000 milestone ~126 days out.
  sparklines: { subscribers: Array.from({ length: 14 }, () => 100) },
  previous: {
    subscribers_added: 152,
    unique_opens: 212,
    unique_clicks: 31,
    unique_bounces: 11,
    unique_delivered: 1000,
    unique_sent: 1000,
  },
};

const requested: string[] = [];

function stubTransport(): void {
  requested.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      requested.push(path);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path.startsWith("/api/v1/dashboard/stats")) return json(STATS);
      if (path.startsWith("/api/v1/auth/me")) return json(WHOAMI);
      if (path.startsWith("/api/v1/campaigns/count")) {
        return json({ total: 3, by_status: { sent: 2 } });
      }
      if (path.startsWith("/api/v1/campaigns?")) {
        return json([
          { id: "cmp_live", name: "Autumn launch", status: "sending" },
        ]);
      }
      if (path.startsWith("/api/v1/subscribers?")) {
        return json({ total: 12481, items: [] });
      }
      if (path === "/api/health") return json({ ok: true });
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  /** Browser semantics: a named frame reaches only listeners for that name. */
  emit(name: string, data: string): void {
    this.dispatchEvent(new MessageEvent(name, { data }));
  }

  close(): void {
    this.closed = true;
  }
}

const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  stubTransport();
  FakeEventSource.instances = [];
  writeText.mockReset();
  writeText.mockImplementation(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function renderHome() {
  const Page = (await import("@/app/(dashboard)/app/page")).default;
  return renderPage(Page);
}

async function flush(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("home dashboard mounts", () => {
  it("opens campaign creation directly from the New campaign quick action", async () => {
    const { container, root } = await renderHome();
    try {
      const action = [
        ...container.querySelectorAll<HTMLAnchorElement>("a"),
      ].find((link) => link.textContent?.trim() === "New campaign");
      expect(action?.getAttribute("href")).toBe("/app/campaigns?create=1");
    } finally {
      unmount(root);
    }
  });

  it("drills the Opens and Clicks tiles into Analytics focused on that KPI (analytics-15)", async () => {
    const { container, root } = await renderHome();
    try {
      const tiles = [
        ...container.querySelectorAll<HTMLAnchorElement>(
          '[data-testid="perf-stat"]',
        ),
      ];
      const hrefOf = (label: string) =>
        tiles
          .find((tile) => tile.textContent?.startsWith(label))
          ?.getAttribute("href");
      expect(hrefOf("Opens")).toBe("/app/analytics?metric=opens");
      expect(hrefOf("Clicks")).toBe("/app/analytics?metric=clicks");
      // The other tiles keep their own destinations.
      expect(hrefOf("Contacts added")).toBe("/app/subscribers");
    } finally {
      unmount(root);
    }
  });

  it("offers Share snapshot beside Refresh and copies the stats the page loaded (analytics-13)", async () => {
    const { container, root } = await renderHome();
    try {
      expect(
        requested.some((p) => p.startsWith("/api/v1/dashboard/stats")),
      ).toBe(true);
      const share = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Share snapshot",
      );
      expect(share).toBeDefined();
      // Enabled only because the page's own stats payload is complete.
      expect(share?.disabled).toBe(false);

      await act(async () => {
        share?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      const copied = writeText.mock.calls[0]?.[0] ?? "";
      expect(copied).toContain("12,481");
      // 224 unique opens / 1,000 delivered from the page's stats response.
      expect(copied).toContain("22.4%");
      expect(container.textContent).toContain("Copied");
    } finally {
      unmount(root);
    }
  });

  it("renders the subscriber forecast from the page's stats payload (analytics-27)", async () => {
    const { container, root } = await renderHome();
    try {
      const forecast = container.querySelector(
        '[data-testid="subscriber-forecast"]',
      );
      expect(forecast).not.toBeNull();
      expect(forecast?.textContent).toContain("25,000");
      expect(forecast?.textContent).toContain("over the last 14 days");
    } finally {
      unmount(root);
    }
  });

  it("without EventSource opens no stream and reports polling (analytics-29 default)", async () => {
    // The environment every other page test runs in.
    expect(typeof (globalThis as { EventSource?: unknown }).EventSource).toBe(
      "undefined",
    );
    const { container, root } = await renderHome();
    try {
      const indicator = container.querySelector(
        '[data-testid="dashboard-live-indicator"]',
      );
      expect(indicator?.getAttribute("data-live-status")).toBe("closed");
      expect(indicator?.textContent).toContain("Polling every 60s");
      // Chip + active-send strip still render from the page's HTTP reads.
      expect(
        container.querySelector('[data-testid="live-subs-chip"]')?.textContent,
      ).toContain("12,481");
      expect(
        container
          .querySelector('[data-testid="active-send-strip"]')
          ?.getAttribute("href"),
      ).toBe("/app/campaigns/cmp_live");
      expect(requested.some((p) => p.includes("/dashboard/live"))).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("opens GET /api/v1/dashboard/live and lets a stats frame replace the tiles (analytics-29)", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { container, root } = await renderHome();
    let unmounted = false;
    try {
      const streams = FakeEventSource.instances.filter(
        (source) => source.url === "/api/v1/dashboard/live",
      );
      expect(streams.length).toBeGreaterThanOrEqual(1);
      const source = streams[streams.length - 1]!;
      expect(source.init?.withCredentials).toBe(true);
      expect(source.closed).toBe(false);

      await act(async () => {
        source.open();
      });
      const indicator = () =>
        container.querySelector('[data-testid="dashboard-live-indicator"]');
      expect(indicator()?.getAttribute("data-live-status")).toBe("open");
      expect(indicator()?.textContent).toContain("Live updates on");

      await act(async () => {
        source.emit(
          "stats",
          JSON.stringify({ ...STATS, subscribers_total: 13007 }),
        );
      });
      await flush();
      expect(
        container.querySelector('[data-testid="live-subs-chip"]')?.textContent,
      ).toContain("13,007");
      // Leaving the page tears the stream down.
      unmount(root);
      unmounted = true;
      expect(source.closed).toBe(true);
    } finally {
      if (!unmounted) unmount(root);
    }
  });
});
