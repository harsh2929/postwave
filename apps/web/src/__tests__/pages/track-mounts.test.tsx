// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Mount reachability for /app/track's shared investigation scope:
//   analytics-72 — picking an event name in the catalogue (or the feed's event
//     cell) scopes the feed read, shows a removable scope token, and clears
//   analytics-74 — the subscriber picker resolves an ID into the feed scope
//   analytics-79 — "View details" opens the event slideover with the
//     sequence-draft handoff
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
  typeInto,
} from "./_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/track",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

// The live tail is an EventSource; its frames are live-streams-api's concern.
vi.mock("@/lib/live-streams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/live-streams-api")>()),
  subscribeTrackStream: vi.fn(() => () => undefined),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const SUBSCRIBER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

function catalog() {
  const asOf = new Date().toISOString();
  const firstSeen = new Date(Date.now() - 3_600_000).toISOString();
  const item = (eventName: string) => ({
    eventName,
    count: 5,
    uniqueSubscribers: 2,
    firstSeen,
    lastSeen: firstSeen,
    daily: [{ date: asOf.slice(0, 10), count: 1 }],
  });
  return {
    items: [item("checkout_started"), item("signup")],
    totalDistinctEventNames: 2,
    periodDays: 30,
    dailySeriesPeriodDays: 1,
    eventBoundsScope: "period",
    timeZone: "UTC",
    asOf,
  };
}

function events(eventName: string | null, subscriberId: string | null) {
  const rows = [
    { id: 12, eventName: "signup", subscriberId: OTHER, ago: 60_000 },
    { id: 11, eventName: "checkout_started", subscriberId: SUBSCRIBER, ago: 120_000 },
  ]
    .filter((r) => !eventName || r.eventName === eventName)
    .filter((r) => !subscriberId || r.subscriberId === subscriberId);
  return {
    items: rows.map((r) => ({
      id: r.id,
      tenantId: WHOAMI.tenant_id,
      subscriberId: r.subscriberId,
      eventName: r.eventName,
      properties: { synthetic: true },
      occurredAt: new Date(Date.now() - r.ago).toISOString(),
      receivedAt: new Date(Date.now() - r.ago + 1_000).toISOString(),
    })),
  };
}

// The event browser is a next/dynamic chunk; a cold import can take longer
// than a fixed number of macrotask turns, so this waits on wall-clock time.
async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  if (!check()) throw new Error("waitFor: condition never held");
}

async function mount() {
  const transport = recordingTransport((req) => {
    if (req.method !== "GET") return undefined;
    if (req.path === "/api/v1/track/catalog") return { body: catalog() };
    if (req.path === "/api/v1/track/events") {
      return {
        body: events(req.query.get("event_name"), req.query.get("subscriber_id")),
      };
    }
    if (req.path === "/api/v1/subscribers") return { body: { items: [] } };
    return undefined;
  });
  const Page = (await import("@/app/(dashboard)/app/track/page")).default;
  const rendered = await renderPage(Page);
  await waitFor(
    () =>
      rendered.container.querySelector('[aria-label="Recent product events"]') !==
      null,
  );
  const feedReads = () =>
    transport.calls
      .filter((c) => c.path === "/api/v1/track/events")
      .map((c) => ({
        event: c.query.get("event_name"),
        subscriber: c.query.get("subscriber_id"),
      }));
  return { ...rendered, ...transport, feedReads };
}

const feedEventNames = (container: HTMLElement) =>
  [
    ...container.querySelectorAll('[aria-label="Recent product events"] tbody tr'),
  ].map((tr) => tr.querySelector("td:nth-child(2) code")?.textContent);

describe("track — shared investigation scope", () => {
  it("scopes the feed from the catalogue and the feed's event cell (analytics-72)", async () => {
    const { container, root, feedReads } = await mount();
    try {
      expect(feedReads().at(-1)).toEqual({ event: null, subscriber: null });
      const catalogue = container.querySelector('[aria-label="Event catalogue"]')!;
      expect(catalogue).not.toBeNull();

      await clickEl(buttonByText(catalogue, "Filter events to checkout_started"));
      await settle();
      expect(feedReads().at(-1)).toEqual({ event: "checkout_started", subscriber: null });
      expect(feedEventNames(container)).toEqual(["checkout_started"]);
      const scopeGroup = container.querySelector(
        '[aria-label="Active product event investigation scope"]',
      )!;
      const token = buttonByText(scopeGroup, "Remove the checkout_started event-name scope");
      expect(token).toBeDefined();
      expect(
        container.querySelector<HTMLInputElement>("#track-feed-event-name")!.value,
      ).toBe("checkout_started");

      // Removing the token clears the scope for catalogue and feed alike.
      await clickEl(token);
      await settle();
      expect(feedReads().at(-1)).toEqual({ event: null, subscriber: null });
      expect(feedEventNames(container)).toEqual(["signup", "checkout_started"]);

      // The feed's own event cell scopes too.
      const table = container.querySelector('[aria-label="Recent product events"]')!;
      await clickEl(buttonByText(table, "Filter events to signup"));
      await settle();
      expect(feedReads().at(-1)).toEqual({ event: "signup", subscriber: null });
      expect(
        buttonByText(catalogue, "Remove the signup event filter"),
      ).toBeDefined();
    } finally {
      unmount(root);
    }
  });

  it("resolves a subscriber ID into the feed scope (analytics-74)", async () => {
    const { container, root, feedReads } = await mount();
    try {
      const label = [...container.querySelectorAll("label")].find(
        (l) => l.textContent?.trim() === "Subscriber ID or email",
      )!;
      expect(container.querySelector("#track-feed-subscriber")).toBeNull();
      await typeInto(
        container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!,
        SUBSCRIBER,
      );
      await clickEl(buttonByText(container, "Load events"));
      await settle();
      expect(feedReads().at(-1)).toEqual({ event: null, subscriber: SUBSCRIBER });
      expect(feedEventNames(container)).toEqual(["checkout_started"]);
      expect(
        buttonByText(container, `Remove the ${SUBSCRIBER} subscriber scope`),
      ).toBeDefined();
    } finally {
      unmount(root);
    }
  });

  it("opens the event slideover with the sequence-draft handoff (analytics-79)", async () => {
    const { container, root } = await mount();
    try {
      await clickEl(buttonByText(container, "View details"));
      await settle(2);
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain("Product event details");
      expect(dialog?.textContent).toContain('"synthetic": true');
      expect(buttonByText(dialog!, "Create sequence draft")).toBeDefined();
    } finally {
      unmount(root);
    }
  });
});
