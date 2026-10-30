// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTrackInvestigationScope } from "@/components/track/use-track-scope";
import type { MeResponse } from "@/lib/auth-api";
import {
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "../pages/_harness";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  exportCsv: vi.fn(),
  download: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  verifyPrincipal: vi.fn(),
}));

vi.mock("@/lib/track-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/track-api")>()),
  listTrackEvents: mocks.list,
  exportTrackEventsCsv: mocks.exportCsv,
}));

vi.mock("@/lib/download", () => ({ downloadTextFile: mocks.download }));
vi.mock("@/lib/live-streams-api", () => ({
  subscribeTrackStream: mocks.subscribe,
}));
vi.mock("@/lib/exact-principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exact-principal")>()),
  verifyFreshExactPrincipal: mocks.verifyPrincipal,
}));

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findButton(
  label: string,
  root: ParentNode = document,
): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function row() {
  return {
    id: 10,
    tenantId: WHOAMI.tenant_id,
    subscriberId: "33333333-3333-4333-8333-333333333333",
    eventName: "checkout_started",
    properties: { synthetic: true },
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 59_000).toISOString(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("TrackEventBrowser", () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue({
      items: [row()],
      requestedLimit: 200,
      atLimit: false,
    });
    mocks.subscribe.mockImplementation(
      (handlers: { onStatus?: (status: string) => void }) => {
        handlers.onStatus?.("open");
        return mocks.unsubscribe;
      },
    );
    mocks.exportCsv.mockResolvedValue({
      csv: "id,occurred_at,received_at,subscriber_id,event_name,properties_json\n",
      truncated: false,
      serverLimit: 10_000,
    });
    mocks.verifyPrincipal.mockResolvedValue(WHOAMI);
    // The subscriber scope picker reads recent subscribers; unrecorded paths
    // answer 404, which the picker renders as its own retryable state.
    stubFixtureTransport();
  });

  it("wires filters, detail inspection, live pause, and authenticated CSV download", async () => {
    const { TrackEventBrowser } = await import(
      "@/app/(dashboard)/app/track/track-event-browser"
    );
    // The page owns the investigation scope; this stands in for it.
    function Component(props: { identity: MeResponse; queryKeyBase: QueryKey }) {
      const scope = useTrackInvestigationScope();
      return createElement(TrackEventBrowser, { ...props, scope });
    }
    const { container, root } = await renderPage(Component, {
      identity: WHOAMI,
      queryKeyBase: ["track", WHOAMI.tenant_id, "owner"],
    });
    try {
      expect(container.textContent).toContain("checkout_started");
      await click(findButton("View details", container));
      expect(document.body.textContent).toContain("Product event details");
      expect(document.body.textContent).toContain('"synthetic": true');

      const eventName = container.querySelector<HTMLInputElement>(
        "#track-feed-event-name",
      );
      // The subscriber is scoped through the picker (an ID resolves as-is).
      const subscriberLabel = [...container.querySelectorAll("label")].find(
        (label) => label.textContent?.trim() === "Subscriber ID or email",
      );
      const subscriber = container.querySelector<HTMLInputElement>(
        `#${CSS.escape(subscriberLabel?.htmlFor ?? "")}`,
      );
      await setInput(eventName as HTMLInputElement, "checkout_started");
      await click(findButton("Apply filters", container));
      // Resolving a subscriber applies it immediately (no Apply needed).
      await setInput(
        subscriber as HTMLInputElement,
        "33333333-3333-4333-8333-333333333333",
      );
      await click(findButton("Load events", container));
      expect(mocks.list.mock.calls.at(-1)?.[0].filters).toMatchObject({
        eventName: "checkout_started",
        subscriberId: "33333333-3333-4333-8333-333333333333",
      });

      await click(findButton("Pause live tail", container));
      expect(mocks.unsubscribe).toHaveBeenCalled();
      expect(container.textContent).toContain("Live tail is paused");

      await click(findButton("Export CSV", container));
      expect(mocks.exportCsv).toHaveBeenCalledWith({
        filters: expect.objectContaining({
          eventName: "checkout_started",
          subscriberId: "33333333-3333-4333-8333-333333333333",
          limit: 10_000,
        }),
        signal: expect.any(AbortSignal),
      });
      expect(mocks.download).toHaveBeenCalledWith(
        expect.stringMatching(
          /^postwave-product-events-\d{4}-\d{2}-\d{2}\.csv$/,
        ),
        expect.stringContaining("properties_json"),
        "text/csv;charset=utf-8",
      );
    } finally {
      unmount(root);
    }
  });
});
