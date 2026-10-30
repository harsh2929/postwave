// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SubscriberTimeline } from "@/app/(dashboard)/app/subscribers/[id]/_timeline";
import type { SubscriberTimelineEvent } from "@/lib/subscriber-timeline-api";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function event(
  type: string,
  occurredAt: string,
  patch: Partial<SubscriberTimelineEvent> = {},
): SubscriberTimelineEvent {
  return {
    type,
    occurred_at: occurredAt,
    source: "subscriber_events",
    ...patch,
  };
}

type Props = Parameters<typeof SubscriberTimeline>[0];

function renderTimeline(
  overrides: Partial<Props> = {},
): (next: Partial<Props>) => void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const props: Props = {
    events: [event("opened", "2026-08-26T12:00:00Z")],
    hasMore: false,
    loadMoreError: null,
    loadingMore: false,
    onLoadMore: vi.fn(),
    ...overrides,
  };
  const paint = (next: Partial<Props> = {}) => {
    Object.assign(props, next);
    act(() => root?.render(createElement(SubscriberTimeline, { ...props })));
  };
  paint();
  return paint;
}

function button(): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent === "Load more" ||
      candidate.textContent === "Retry" ||
      candidate.textContent === "Loading…",
  );
}

describe("SubscriberTimeline pagination states", () => {
  it("keeps loaded events visible beside a scoped, actionable page error", () => {
    const onLoadMore = vi.fn();
    renderTimeline({
      events: [
        event("opened", "2026-08-25T12:00:00Z"),
        event("sent", "2026-08-26T12:00:00Z"),
      ],
      hasMore: true,
      loadMoreError:
        "A very long pagination failure identifier that must wrap instead of widening the profile.",
      onLoadMore,
    });

    const events = document.querySelectorAll('[data-testid="timeline-event"]');
    expect(events).toHaveLength(2);
    expect(events[0]?.getAttribute("data-timestamp")).toBe(
      "2026-08-26T12:00:00Z",
    );
    const retry = button();
    expect(retry?.textContent).toBe("Retry");
    expect(retry?.classList.contains("min-h-11")).toBe(true);
    const errorId = retry?.getAttribute("aria-describedby");
    const error = errorId ? document.getElementById(errorId) : null;
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.classList.contains("break-words")).toBe(true);
    expect(error?.classList.contains("text-destructive-emphasis")).toBe(true);

    act(() => retry?.click());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(
      document.querySelectorAll('[data-testid="timeline-event"]'),
    ).toHaveLength(2);
  });

  it("announces and disables the in-flight retry without hiding prior events", () => {
    const onLoadMore = vi.fn();
    renderTimeline({
      hasMore: true,
      loadMoreError: "Temporary failure",
      loadingMore: true,
      onLoadMore,
    });

    const loading = button();
    expect(loading?.textContent).toBe("Loading…");
    expect(loading?.disabled).toBe(true);
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(
      document
        .querySelector('[data-testid="subscriber-timeline"]')
        ?.getAttribute("aria-busy"),
    ).toBe("true");

    act(() => loading?.click());
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="timeline-event"]'),
    ).toBeTruthy();
  });

  it("keeps pagination reachable for an anomalous empty page", () => {
    const onLoadMore = vi.fn();
    renderTimeline({ events: [], hasMore: true, onLoadMore });

    const status = document.querySelector('[role="status"]');
    expect(status?.textContent).toContain("No activity loaded");
    const loadMore = button();
    expect(loadMore?.textContent).toBe("Load more");
    expect(loadMore?.getAttribute("aria-controls")).toBe(status?.id);

    act(() => loadMore?.click());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("renders a stable empty timeline without a dead pagination control", () => {
    renderTimeline({ events: [], hasMore: false });

    expect(
      document.querySelector('[data-testid="subscriber-timeline"]'),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(
      "No activity recorded for this subscriber.",
    );
    expect(button()).toBeUndefined();
  });

  it("wraps long event content and safely encodes campaign destinations", () => {
    renderTimeline({
      events: [
        event("clicked", "2026-08-26T12:00:00Z", {
          campaign_id: "campaign/with spaces",
          detail: {
            link_url:
              "https://example.test/a/very/long/unbroken/path/that/needs/to/wrap/on/mobile",
          },
          subject: "A long campaign subject that remains readable",
        }),
      ],
    });

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href^="/app/campaigns/"]',
    );
    expect(link?.getAttribute("href")).toBe(
      "/app/campaigns/campaign%2Fwith%20spaces",
    );
    expect(link?.classList.contains("break-words")).toBe(true);
    const detail = Array.from(document.querySelectorAll("span")).find(
      (candidate) => candidate.title.startsWith("https://example.test/"),
    );
    expect(detail?.classList.contains("break-all")).toBe(true);
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-08-26T12:00:00Z",
    );
  });
});
