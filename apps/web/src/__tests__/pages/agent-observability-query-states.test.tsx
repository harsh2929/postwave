// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clickEveryControl, renderPage, unmount, WHOAMI } from "./_harness";

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

function dailySeries(days: number, total: number) {
  return Array.from({ length: days }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 30 - (days - 1 - index)))
      .toISOString()
      .slice(0, 10),
    count: index === 0 ? total - (days - 1) : 1,
  }));
}

const LOADED: Record<string, unknown> = {
  "/api/v1/agent-routines": {
    items: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Weekly deliverability review",
        prompt: "Review deliverability evidence and prepare an inert draft.",
        kind: "draft_campaign",
        schedule: "weekly",
        schedule_detail: {},
        target_list_id: null,
        target_segment_id: null,
        require_approval: true,
        enabled: true,
        has_active_run: false,
        last_run_at: null,
        created_by: "owner@example.test",
        created_at: "2026-08-20T10:00:00Z",
        updated_at: "2026-08-20T10:00:00Z",
        version: "2026-08-20T10:00:00Z",
      },
    ],
  },
  "/api/v1/segments": [],
  "/api/v1/mcp/catalog": [
    {
      name: "segments.create_from_rules",
      category: "audience-management",
      description: "Create a segment from explicit subscriber rules.",
    },
    {
      name: "campaigns.schedule",
      category: "campaign-delivery",
      description: "Schedule a reviewed campaign for delivery.",
    },
    {
      name: "campaigns.preview",
      category: "campaign-delivery",
      description: "Render a campaign preview without sending.",
    },
  ],
  "/api/v1/mcp/quotas": {
    quotas: [{ key: "writes_per_hour", limit: 10 }],
    enforcementMode: "advisory_unverified",
    authoritative: false,
    releaseHold: "mcp_quota_enforcement_release_held_with_a_long_identifier",
  },
  "/api/v1/track/stats": {
    periodDays: 30,
    totalEvents: 100,
    uniqueSubscribers: 20,
    uniqueEventNames: 2,
    daily: dailySeries(30, 100),
    timeZone: "UTC",
    asOf: "2026-08-30T10:00:00Z",
  },
  "/api/v1/track/catalog": {
    items: [
      {
        eventName: "pricing_page_viewed",
        count: 70,
        uniqueSubscribers: 18,
        firstSeen: "2026-08-02T10:00:00Z",
        lastSeen: "2026-08-30T09:00:00Z",
        daily: dailySeries(7, 70),
      },
      {
        eventName: "checkout_started_with_a_long_event_name",
        count: 30,
        uniqueSubscribers: 12,
        firstSeen: "2026-08-04T10:00:00Z",
        lastSeen: "2026-08-29T09:00:00Z",
        daily: dailySeries(7, 30),
      },
    ],
    totalDistinctEventNames: 2,
    periodDays: 30,
    dailySeriesPeriodDays: 7,
    timeZone: "UTC",
    eventBoundsScope: "period",
    asOf: "2026-08-30T10:00:00Z",
  },
  "/api/v1/track/events": {
    items: [
      {
        id: 101,
        tenantId: WHOAMI.tenant_id,
        subscriberId: "33333333-3333-4333-8333-333333333333",
        eventName: "checkout_started_with_a_long_event_name",
        properties: { source: "test" },
        occurredAt: "2026-08-29T12:00:00Z",
        receivedAt: "2026-08-29T12:00:01Z",
      },
    ],
  },
  "/api/v1/conversions": [
    {
      id: 9,
      tenant_id: WHOAMI.tenant_id,
      subscriber_email: "synthetic@example.invalid",
      event_name: "purchase",
      amount_cents: 4900,
      currency: "USD",
      attributed_via: "none",
      properties: { source: "test" },
      occurred_at: "2026-08-29T12:00:00Z",
    },
  ],
  "/api/v1/conversions/keys": [],
  "/api/v1/conversions/ingest-secrets": { items: [] },
  // The Track subscriber-scope picker lists recent subscribers on mount.
  "/api/v1/subscribers": {
    items: [{ id: "sub-1", email: "ada@example.com" }],
  },
};

const EMPTY: Record<string, unknown> = {
  "/api/v1/subscribers": { items: [] },
  "/api/v1/agent-routines": { items: [] },
  "/api/v1/segments": [],
  "/api/v1/mcp/catalog": [],
  "/api/v1/mcp/quotas": {
    quotas: [],
    enforcementMode: "advisory_unverified",
    authoritative: false,
    releaseHold: "release_held",
  },
  "/api/v1/track/stats": {
    periodDays: 30,
    totalEvents: 0,
    uniqueSubscribers: 0,
    uniqueEventNames: 0,
    daily: dailySeries(30, 29).map((point) => ({ ...point, count: 0 })),
    timeZone: "UTC",
    asOf: "2026-08-30T10:00:00Z",
  },
  "/api/v1/track/catalog": {
    items: [],
    totalDistinctEventNames: 0,
    periodDays: 30,
    dailySeriesPeriodDays: 7,
    timeZone: "UTC",
    eventBoundsScope: "period",
    asOf: "2026-08-30T10:00:00Z",
  },
  "/api/v1/track/events": { items: [] },
  "/api/v1/conversions": [],
  "/api/v1/conversions/keys": [],
  "/api/v1/conversions/ingest-secrets": { items: [] },
};

function stubObservabilityTransport(mode: "loaded" | "empty" | "error") {
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const path = new URL(raw, "http://postwave.test").pathname;
    if (mode === "error") {
      return new Response(
        JSON.stringify({ error: { code: "bad_request", message: "Failed" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify((mode === "loaded" ? LOADED : EMPTY)[path] ?? {}),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", transport);
  return transport;
}

// `retries` is counted separately from `alerts` because not every failed
// read offers the same word: the recent-agent-activity strip on the routines
// page says "Retry now" (desktop's label), while GovernanceError says "Retry".
// Collapsing the two would have hidden which control the page actually shows.
const PAGES = [
  {
    name: "agent routines",
    load: () => import("@/app/(dashboard)/app/agent-routines/page"),
    loaded: ["Weekly deliverability review", "Enabled", "Every 7 days"],
    empty: "No routines are configured",
    alerts: 2,
    retries: 1,
  },
  {
    name: "agent tools",
    load: () => import("@/app/(dashboard)/app/agent-tools/page"),
    loaded: ["Not enforced", "3 tools", "campaign delivery"],
    empty: "No agent tools reported",
    alerts: 3,
    retries: 3,
  },
  {
    name: "product events",
    load: () => import("@/app/(dashboard)/app/track/page"),
    loaded: ["100", "UTC", "checkout_started_with_a_long_event_name"],
    empty: "no loaded row matched this range and filter scope",
    // +1 each: the subscriber-scope picker's recent-subscribers read.
    alerts: 7,
    retries: 7,
  },
] as const;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  readonly listeners = new Map<string, EventListener[]>();
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  // Both Moosewave SSE streams NAME every frame they emit, so a consumer binds
  // named listeners as well as onmessage. A fake without addEventListener
  // throws on subscribe.
  addEventListener(name: string, listener: EventListener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  emit(name: string, data: unknown) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent(name, { data: JSON.stringify(data) }));
    }
  }

  close() {
    this.closed = true;
  }
}

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
}

describe("agent and event observability", () => {
  for (const page of PAGES) {
    it(`${page.name} renders seeded data and refreshes`, async () => {
      const transport = stubObservabilityTransport("loaded");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        for (const marker of page.loaded) {
          expect(container.textContent).toContain(marker);
        }
        const initialRequests = transport.mock.calls.length;
        const { failures } = await clickEveryControl(container);
        expect(failures).toEqual([]);
        expect(transport.mock.calls.length).toBeGreaterThan(initialRequests);
      } finally {
        unmount(root);
      }
    });

    it(`${page.name} renders a genuine empty state`, async () => {
      stubObservabilityTransport("empty");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        await eventually(() =>
          expect(container.textContent).toContain(page.empty),
        );
        expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      } finally {
        unmount(root);
      }
    });

    it(`${page.name} exposes failed reads and retry controls`, async () => {
      stubObservabilityTransport("error");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        // Each failed read settles on its own query; under load the last
        // alert can land after renderPage returns, so wait for the full set.
        await eventually(() =>
          expect(container.querySelectorAll('[role="alert"]')).toHaveLength(
            page.alerts,
          ),
        );
        expect(
          [...container.querySelectorAll("button")].filter((button) =>
            /^retry$/i.test(button.textContent?.trim() ?? ""),
          ),
        ).toHaveLength(page.retries);
      } finally {
        unmount(root);
      }
    });
  }

  it("filters the tool catalogue across names, categories, and descriptions", async () => {
    stubObservabilityTransport("loaded");
    const Page = (await import("@/app/(dashboard)/app/agent-tools/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const search =
        container.querySelector<HTMLInputElement>("#mcp-tool-search");
      expect(search).not.toBeNull();
      await setInput(search as HTMLInputElement, "subscriber rules");
      expect(container.textContent).toContain("1 matching tool");
      expect(container.textContent).toContain("segments.create_from_rules");
      expect(container.textContent).not.toContain("campaigns.schedule");

      await setInput(search as HTMLInputElement, "no-such-capability");
      expect(container.textContent).toContain(
        "No tools match “no-such-capability”",
      );
    } finally {
      unmount(root);
    }
  });

  it("filters event names without hiding the catalogue scope", async () => {
    stubObservabilityTransport("loaded");
    const Page = (await import("@/app/(dashboard)/app/track/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const search = container.querySelector<HTMLInputElement>(
        "#track-event-search",
      );
      expect(search).not.toBeNull();
      await setInput(search as HTMLInputElement, "checkout");
      expect(container.textContent).toContain("1 shown");
      expect(container.textContent).toContain(
        "checkout_started_with_a_long_event_name",
      );
      expect(container.textContent).not.toContain("pricing_page_viewed");
      expect(container.textContent).toContain("2 distinct event names");
    } finally {
      unmount(root);
    }
  });

  it("reports connected and idle separately from a received stream event", async () => {
    stubObservabilityTransport("loaded");
    vi.stubGlobal(
      "EventSource",
      FakeEventSource as unknown as typeof EventSource,
    );
    const Page = (await import("@/app/(dashboard)/app/agent-tools/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0]?.url).toBe(
        "/api/v1/mcp/executions/stream",
      );
      await act(async () => {
        FakeEventSource.instances[0]?.onopen?.(new Event("open"));
      });
      expect(container.textContent).toContain(
        "No agent tool has run since this page opened",
      );

      // The server writes `event: execution` on every row frame, so an
      // unnamed `message` frame is not what this page will ever receive.
      // Emitting the real frame name is the only version of this assertion
      // that would have caught the counter never moving in production.
      await act(async () => {
        FakeEventSource.instances[0]?.emit("execution", {
          id: 7,
          toolName: "campaigns.preview",
        });
      });
      expect(container.textContent).toContain(
        "1 execution since this page opened",
      );
    } finally {
      unmount(root);
    }
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});
