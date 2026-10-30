// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Track-event investigation tools (desktop parity rows analytics-72/74/79).
//
// Every assertion is on the WIRE: requests go through the real clients and
// the real `api` transport to a stubbed fetch, so a wrong path, a dropped
// `event_name`/`subscriber_id`, or a changed sequence body fails here rather
// than against the server.
//
// The scope probe below composes the free components exactly the way the
// track page / event browser mounts them: one useTrackInvestigationScope()
// owner whose eventName + subscriber.id drive the feed query.
import { act, createElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EventCatalog,
  EventNameFilterButton,
} from "@/components/track/EventCatalog";
import { SubscriberScopePicker } from "@/components/track/SubscriberScopePicker";
import { TrackScopeTokens } from "@/components/track/TrackScopeTokens";
import { useTrackInvestigationScope } from "@/components/track/use-track-scope";
import { TrackEventSlideover } from "@/components/TrackEventSlideover";
import type { MeResponse } from "@/lib/auth-api";
import {
  listTrackEvents,
  type TrackCatalogItem,
  type TrackEvent,
} from "@/lib/track-api";

import { renderPage, unmount, WHOAMI } from "../pages/_harness";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: { children: ReactNode; href: string } & Record<string, unknown>) =>
    createElement("a", { href, ...props }, children),
}));

interface Recorded {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}

let requests: Recorded[] = [];
let identity: MeResponse = WHOAMI as unknown as MeResponse;
let sequenceResponse: () => Response;

const SUBSCRIBER_ID = "33333333-3333-4333-8333-333333333333";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function trackRow(eventName = "checkout_started") {
  return {
    id: 10,
    tenantId: WHOAMI.tenant_id,
    subscriberId: SUBSCRIBER_ID,
    eventName,
    properties: { synthetic: true },
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 59_000).toISOString(),
  };
}

function route(method: string, path: string, params: URLSearchParams) {
  if (method === "GET" && path === "/api/v1/track/events") {
    return json({ items: [trackRow()] });
  }
  if (method === "GET" && path === "/api/v1/subscribers") {
    if (params.has("q")) {
      return json({
        items: [
          { id: "sub-adam", email: "adam@example.com" },
          { id: "sub-ada", email: "ada@example.com" },
        ],
        total: 2,
        page: 1,
        per_page: 5,
      });
    }
    return json({
      items: [
        { id: "sub-grace", email: "grace@example.com" },
        { id: "sub-linus", email: "linus@example.com" },
      ],
      total: 2,
      page: 1,
      per_page: 8,
    });
  }
  if (method === "GET" && path === "/api/v1/auth/me") return json(identity);
  if (method === "POST" && path === "/api/v1/voice/sequences") {
    return sequenceResponse();
  }
  return json({ error: { code: "not_found", message: "" } }, 404);
}

beforeEach(() => {
  requests = [];
  identity = WHOAMI as unknown as MeResponse;
  sequenceResponse = () =>
    json(
      { id: "seq-1", name: "Follow up: checkout_started", status: "draft" },
      201,
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(raw, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({
        method,
        path: url.pathname,
        params: url.searchParams,
        body,
      });
      return route(method, url.pathname, url.searchParams);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function byLabel(
  label: string,
  root: ParentNode = document,
): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Missing button labelled: ${label}`);
  return found;
}

function byText(text: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function feedRequests(): Recorded[] {
  return requests.filter(
    (request) =>
      request.method === "GET" && request.path === "/api/v1/track/events",
  );
}

const CATALOG: TrackCatalogItem[] = [
  {
    eventName: "checkout_started",
    count: 12,
    uniqueSubscribers: 4,
    firstSeen: "2026-09-01T00:00:00Z",
    lastSeen: "2026-09-11T00:00:00Z",
    daily: [],
  },
  {
    eventName: "trial_started",
    count: 3,
    uniqueSubscribers: 3,
    firstSeen: "2026-09-02T00:00:00Z",
    lastSeen: "2026-09-10T00:00:00Z",
    daily: [],
  },
];
const KEY_BASE = ["track", WHOAMI.tenant_id, "owner", "principal"];

function ScopeProbe() {
  const scope = useTrackInvestigationScope();
  const events = useQuery({
    queryKey: [
      ...KEY_BASE,
      "events",
      {
        eventName: scope.eventName || null,
        subscriberId: scope.subscriber?.id ?? null,
      },
    ],
    queryFn: ({ signal }) =>
      listTrackEvents({
        tenantId: WHOAMI.tenant_id,
        filters: {
          eventName: scope.eventName || undefined,
          subscriberId: scope.subscriber?.id,
          limit: 200,
        },
        signal,
      }),
  });
  const rows = Array.isArray(events.data?.items) ? events.data.items : [];
  return (
    <div>
      <TrackScopeTokens
        rangeLabel="Last 30 days"
        eventName={scope.eventName}
        subscriber={scope.subscriber}
        onClearEventName={scope.clearEventName}
        onClearSubscriber={scope.clearSubscriber}
      />
      <EventCatalog
        items={CATALOG}
        selectedEvent={scope.eventName}
        onPick={scope.pickEventName}
      />
      <SubscriberScopePicker
        queryKeyBase={KEY_BASE}
        value={scope.subscriber}
        onChange={scope.setSubscriber}
      />
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-feed-row="">
              <td>
                <EventNameFilterButton
                  eventName={row.eventName}
                  selectedEvent={scope.eventName}
                  onPick={scope.pickEventName}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

describe("analytics-72: event-name scope from the catalogue and the feed", () => {
  it("scopes the feed request to the picked event name and clears it", async () => {
    const { container, root } = await renderPage(ScopeProbe);
    try {
      expect(feedRequests().at(-1)?.params.has("event_name")).toBe(false);
      expect(container.textContent).toContain("All event names");

      await click(byLabel("Filter events to trial_started", container));
      expect(feedRequests().at(-1)?.params.get("event_name")).toBe(
        "trial_started",
      );
      expect(feedRequests().at(-1)?.params.get("limit")).toBe("200");
      const selected = byLabel(
        "Remove the trial_started event filter",
        container,
      );
      expect(selected.getAttribute("aria-pressed")).toBe("true");
      expect(selected.textContent).toContain("Selected");
      expect(
        container.querySelector(
          'button[aria-label="Remove the trial_started event-name scope"]',
        )?.textContent,
      ).toContain("trial_started");

      // The scope token clears the scope and the feed re-reads unscoped.
      const before = feedRequests().length;
      await click(
        byLabel("Remove the trial_started event-name scope", container),
      );
      expect(feedRequests().length).toBeGreaterThan(before);
      expect(feedRequests().at(-1)?.params.has("event_name")).toBe(false);
      expect(container.textContent).toContain("All event names");

      // The catalogue's "Showing only" control clears it too.
      await click(byLabel("Filter events to trial_started", container));
      expect(feedRequests().at(-1)?.params.get("event_name")).toBe(
        "trial_started",
      );
      await click(
        byLabel(
          "Show all event names instead of only trial_started",
          container,
        ),
      );
      expect(feedRequests().at(-1)?.params.has("event_name")).toBe(false);

      // The feed's own event cell scopes to that row's event name...
      const feedCell = container.querySelector<HTMLButtonElement>(
        '[data-feed-row] button[aria-label="Filter events to checkout_started"]',
      );
      expect(feedCell).not.toBeNull();
      await click(feedCell as HTMLButtonElement);
      expect(feedRequests().at(-1)?.params.get("event_name")).toBe(
        "checkout_started",
      );
      // ...and picking it again toggles the scope off.
      await click(
        container.querySelector<HTMLButtonElement>(
          '[data-feed-row] button[aria-label="Clear the checkout_started event filter"]',
        ) as HTMLButtonElement,
      );
      expect(feedRequests().at(-1)?.params.has("event_name")).toBe(false);
    } finally {
      unmount(root);
    }
  });
});

describe("analytics-74: subscriber scope by email, ID, or recent pick", () => {
  it("loads recent subscribers and scopes the feed to a picked one", async () => {
    const { container, root } = await renderPage(ScopeProbe);
    try {
      const recent = requests.find(
        (request) =>
          request.path === "/api/v1/subscribers" && !request.params.has("q"),
      );
      expect(recent?.method).toBe("GET");
      expect([...(recent?.params.entries() ?? [])]).toEqual([
        ["per_page", "8"],
      ]);

      await click(byText("grace@example.com", container));
      expect(feedRequests().at(-1)?.params.get("subscriber_id")).toBe(
        "sub-grace",
      );
      expect(
        byText("grace@example.com", container).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(container.textContent).toContain(
        "Feed, live tail, and export are scoped to grace@example.com.",
      );

      await click(
        byLabel("Remove the grace@example.com subscriber scope", container),
      );
      expect(feedRequests().at(-1)?.params.has("subscriber_id")).toBe(false);
      expect(container.textContent).toContain("All subscribers");
    } finally {
      unmount(root);
    }
  });

  it("resolves an email by exact match, uses an ID as-is, and reports a miss", async () => {
    const { container, root } = await renderPage(ScopeProbe);
    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[placeholder="subscriber@example.com or subscriber ID"]',
      ) as HTMLInputElement;

      await setInput(input, "Ada@Example.com");
      await click(byText("Load events", container));
      const lookup = requests.find(
        (request) =>
          request.path === "/api/v1/subscribers" && request.params.has("q"),
      );
      expect(lookup?.method).toBe("GET");
      expect([...(lookup?.params.entries() ?? [])]).toEqual([
        ["q", "Ada@Example.com"],
        ["per_page", "5"],
      ]);
      // adam@example.com is the FIRST hit; only the exact match may scope.
      expect(feedRequests().at(-1)?.params.get("subscriber_id")).toBe(
        "sub-ada",
      );

      await setInput(input, "nobody@example.com");
      await click(byText("Load events", container));
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "No subscriber matched that email address. Check the spelling or enter a subscriber ID.",
      );
      // A miss leaves the previous scope in place.
      expect(feedRequests().at(-1)?.params.get("subscriber_id")).toBe(
        "sub-ada",
      );

      const lookupsBefore = requests.filter((r) => r.params.has("q")).length;
      await setInput(input, SUBSCRIBER_ID);
      await click(byText("Load events", container));
      expect(requests.filter((r) => r.params.has("q")).length).toBe(
        lookupsBefore,
      );
      expect(feedRequests().at(-1)?.params.get("subscriber_id")).toBe(
        SUBSCRIBER_ID,
      );
    } finally {
      unmount(root);
    }
  });
});

const EVENT: TrackEvent = {
  id: 10,
  tenantId: WHOAMI.tenant_id,
  subscriberId: SUBSCRIBER_ID,
  eventName: "checkout_started",
  properties: { synthetic: true },
  occurredAt: "2026-09-12T10:00:00Z",
  receivedAt: "2026-09-12T10:00:01Z",
};

function sequencePosts(): Recorded[] {
  return requests.filter(
    (request) =>
      request.method === "POST" && request.path === "/api/v1/voice/sequences",
  );
}

async function renderSlideover(event: TrackEvent = EVENT) {
  const onClose = vi.fn(() => undefined);
  const view = await renderPage(TrackEventSlideover, {
    event,
    identity,
    onClose,
  });
  return { ...view, onClose };
}

describe("analytics-79: create a sequence draft triggered by this event", () => {
  it("re-reads authority, then POSTs one inactive product_event draft and links to it", async () => {
    const { root } = await renderSlideover();
    try {
      expect(document.body.textContent).toContain("Product event details");
      await click(byText("Create sequence draft"));

      const authIndex = requests.findIndex(
        (request) => request.path === "/api/v1/auth/me",
      );
      const postIndex = requests.findIndex(
        (request) =>
          request.method === "POST" &&
          request.path === "/api/v1/voice/sequences",
      );
      expect(authIndex).toBeGreaterThanOrEqual(0);
      expect(postIndex).toBeGreaterThan(authIndex);
      expect(sequencePosts()).toHaveLength(1);
      expect(sequencePosts()[0].body).toEqual({
        name: "Follow up: checkout_started",
        description: "",
        status: "draft",
        steps: [
          {
            type: "condition",
            position: 1,
            condition: {
              predicate: "product_event",
              value: "checkout_started",
              yes_branch: [],
              no_branch: [],
            },
          },
        ],
      });
      expect(document.body.textContent).toContain(
        "Sequence draft seq-1 created with a checkout_started product-event condition.",
      );
      const link = [...document.querySelectorAll("a")].find(
        (anchor) => anchor.textContent === "Open sequence draft",
      );
      expect(link?.getAttribute("href")).toBe("/app/sequences/seq-1");
      // A created draft cannot be created twice from the same panel.
      expect(byText("Create sequence draft").disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("withholds the action from a viewer with the reason, and sends nothing", async () => {
    identity = {
      ...(WHOAMI as unknown as MeResponse),
      role: "viewer",
      effective_role: "viewer",
    } as MeResponse;
    const { root } = await renderSlideover();
    try {
      const button = byText("Create sequence draft");
      expect(button.disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Campaign-write access (owner, admin, or editor outside viewer mode) is required to create a sequence draft.",
      );
      await click(button);
      expect(sequencePosts()).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("renders a certain refusal verbatim and still allows a retry", async () => {
    sequenceResponse = () =>
      json(
        {
          error: {
            code: "invalid_request",
            message: "condition value required for product_event",
          },
        },
        400,
      );
    const { root } = await renderSlideover();
    try {
      await click(byText("Create sequence draft"));
      expect(
        document.body.querySelector('[role="alert"]')?.textContent,
      ).toContain("condition value required for product_event");
      expect(byText("Create sequence draft").disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("blocks a blind retry when the outcome is uncertain", async () => {
    sequenceResponse = () => json({ id: "", status: "draft" }, 201);
    const { root } = await renderSlideover();
    try {
      await click(byText("Create sequence draft"));
      expect(sequencePosts()).toHaveLength(1);
      expect(document.body.textContent).toContain(
        "Retry is withheld to prevent a duplicate draft.",
      );
      expect(byText("Create sequence draft").disabled).toBe(true);
      const verify = [...document.querySelectorAll("a")].find(
        (anchor) => anchor.textContent === "Open Sequences to verify",
      );
      expect(verify?.getAttribute("href")).toBe("/app/sequences");
    } finally {
      unmount(root);
    }
  });

  it("cannot automate an event name the sequence trigger would reject", async () => {
    const { root } = await renderSlideover({
      ...EVENT,
      eventName: "Checkout Started",
    });
    try {
      expect(byText("Create sequence draft").disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "This event has no valid event name, so an automation trigger cannot be created.",
      );
    } finally {
      unmount(root);
    }
  });
});
