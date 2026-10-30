// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

const mocks = vi.hoisted(() => ({
  getTimeline: vi.fn(),
}));

vi.mock("@/lib/subscriber-timeline-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/subscriber-timeline-api")>()),
  getSubscriberTimeline: mocks.getTimeline,
}));

import { useSubscriberTimeline } from "@/app/(dashboard)/app/subscribers/[id]/use-subscriber-timeline";
import type {
  SubscriberTimeline,
  SubscriberTimelineEvent,
} from "@/lib/subscriber-timeline-api";

let root: Root | null = null;
let queryClient: QueryClient | null = null;
let latest: ReturnType<typeof useSubscriberTimeline> | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  mocks.getTimeline.mockReset();
  latest = null;
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  if (root) act(() => root?.unmount());
  queryClient?.clear();
  root = null;
  queryClient = null;
  latest = null;
  document.body.replaceChildren();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function event(type: string, id: string): SubscriberTimelineEvent {
  return {
    type,
    occurred_at: `2026-08-${id === "new" ? "26" : "25"}T12:00:00Z`,
    source: "subscriber_events",
    subject_id: id,
  };
}

function page({
  events,
  hasMore = false,
  id = "subscriber-a",
  nextCursor,
}: {
  events: SubscriberTimelineEvent[];
  hasMore?: boolean;
  id?: string;
  nextCursor?: string;
}): SubscriberTimeline {
  return {
    subscriber_id: id,
    email: `${id}@example.test`,
    events,
    pagination: {
      has_more: hasMore,
      limit: 50,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    },
    stats: {
      bounced_count: 0,
      click_rate: 0,
      clicked_count: 0,
      current_status: "active",
      engagement_score: 0,
      open_rate: 0,
      opened_count: 0,
      replied_count: 0,
      sent_count: 0,
      subscribed_at: "2026-08-01T00:00:00Z",
    },
  };
}

type HarnessProps = Parameters<typeof useSubscriberTimeline>[0];

function Harness(props: HarnessProps) {
  latest = useSubscriberTimeline(props);
  return null;
}

function renderHook(
  overrides: Partial<HarnessProps> = {},
): (next: Partial<HarnessProps>) => void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    // Match the production client's retry policy. The timeline hook must
    // override it because its visible Retry controls own recovery.
    defaultOptions: { queries: { gcTime: Infinity, retry: 2, retryDelay: 0 } },
  });
  const props: HarnessProps = {
    enabled: true,
    id: "subscriber-a",
    role: "editor",
    tenantId: "tenant-a",
    category: "all",
    ...overrides,
  };
  const paint = (next: Partial<HarnessProps> = {}) => {
    Object.assign(props, next);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient! },
          createElement(Harness, { ...props }),
        ),
      );
    });
  };
  paint();
  return paint;
}

function current(): ReturnType<typeof useSubscriberTimeline> {
  if (!latest) throw new Error("Timeline hook has not rendered.");
  return latest;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

describe("useSubscriberTimeline", () => {
  it("waits for identity enablement and makes one request for a same-tick double activation", async () => {
    const secondPage = deferred<SubscriberTimeline>();
    mocks.getTimeline
      .mockResolvedValueOnce(
        page({
          events: [event("opened", "old")],
          hasMore: true,
          nextCursor: "cursor-1",
        }),
      )
      .mockReturnValueOnce(secondPage.promise);

    const rerender = renderHook({ enabled: false });
    await act(async () => flush());
    expect(mocks.getTimeline).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(current().timeline?.events).toHaveLength(1));
    expect(mocks.getTimeline).toHaveBeenCalledTimes(1);
    expect(mocks.getTimeline.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        cursor: undefined,
        limit: 50,
        signal: expect.any(AbortSignal),
      }),
    );

    let firstAttempt!: Promise<void>;
    let duplicateAttempt!: Promise<void>;
    act(() => {
      firstAttempt = current().loadMore();
      duplicateAttempt = current().loadMore();
    });
    await waitFor(() => expect(mocks.getTimeline).toHaveBeenCalledTimes(2));
    await duplicateAttempt;
    expect(mocks.getTimeline).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondPage.resolve(
        page({ events: [event("clicked", "new")], id: "subscriber-a" }),
      );
      await firstAttempt;
      await flush();
    });
    await waitFor(() => expect(current().timeline?.events).toHaveLength(2));
    expect(mocks.getTimeline.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ cursor: "cursor-1" }),
    );
    expect(current().timelineQuery.hasNextPage).toBe(false);
  });

  it("keeps loaded pages through a failure and retries the same cursor cleanly", async () => {
    mocks.getTimeline
      .mockResolvedValueOnce(
        page({
          events: [event("opened", "old")],
          hasMore: true,
          nextCursor: "cursor-retry",
        }),
      )
      .mockRejectedValueOnce(new Error("page service unavailable"))
      .mockResolvedValueOnce(
        page({ events: [event("clicked", "new")], id: "subscriber-a" }),
      );
    renderHook();
    await waitFor(() => expect(current().timeline?.events).toHaveLength(1));

    await act(async () => current().loadMore());
    await waitFor(() =>
      expect(current().loadMoreError).toBe("page service unavailable"),
    );
    expect(current().timeline?.events).toHaveLength(1);

    await act(async () => current().loadMore());
    await waitFor(() => expect(current().timeline?.events).toHaveLength(2));
    expect(current().loadMoreError).toBeNull();
    expect(
      mocks.getTimeline.mock.calls.slice(1).map((call) => call[1]?.cursor),
    ).toEqual(["cursor-retry", "cursor-retry"]);
  });

  it("surfaces a missing-cursor contract error and repairs it by refreshing", async () => {
    mocks.getTimeline
      .mockResolvedValueOnce(
        page({ events: [event("opened", "old")], hasMore: true }),
      )
      .mockResolvedValueOnce(
        page({
          events: [event("opened", "old")],
          hasMore: true,
          nextCursor: "recovered-cursor",
        }),
      )
      .mockResolvedValueOnce(
        page({ events: [event("clicked", "new")], id: "subscriber-a" }),
      );
    renderHook();
    await waitFor(() => expect(current().timeline?.events).toHaveLength(1));

    expect(current().hasMore).toBe(true);
    expect(current().loadMoreError).toContain("next-page cursor");

    await act(async () => current().loadMore());
    await waitFor(() => expect(current().loadMoreError).toBeNull());
    expect(mocks.getTimeline.mock.calls[1]?.[1]?.cursor).toBeUndefined();
    expect(current().hasMore).toBe(true);

    await act(async () => current().loadMore());
    await waitFor(() => expect(current().timeline?.events).toHaveLength(2));
    expect(mocks.getTimeline.mock.calls[2]?.[1]?.cursor).toBe(
      "recovered-cursor",
    );
    expect(current().hasMore).toBe(false);
  });

  it("aborts an old subscriber page and cannot leak its late error into the new key", async () => {
    const oldPage = deferred<SubscriberTimeline>();
    mocks.getTimeline.mockImplementation(
      (id: string, options: { cursor?: string }) => {
        if (id === "subscriber-a" && !options.cursor) {
          return Promise.resolve(
            page({
              events: [event("opened", "old")],
              hasMore: true,
              nextCursor: "old-cursor",
            }),
          );
        }
        if (id === "subscriber-a") return oldPage.promise;
        return Promise.resolve(
          page({
            events: [event("clicked", "new")],
            id: "subscriber-b",
          }),
        );
      },
    );
    const rerender = renderHook();
    await waitFor(() =>
      expect(current().timeline?.subscriber_id).toBe("subscriber-a"),
    );

    let oldAttempt!: Promise<void>;
    act(() => {
      oldAttempt = current().loadMore();
    });
    await waitFor(() => expect(mocks.getTimeline).toHaveBeenCalledTimes(2));
    const oldSignal = (
      mocks.getTimeline.mock.calls[1]?.[1] as { signal?: AbortSignal }
    ).signal;

    rerender({ id: "subscriber-b" });
    await waitFor(() =>
      expect(current().timeline?.subscriber_id).toBe("subscriber-b"),
    );
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      oldPage.reject(new Error("late old-subscriber failure"));
      await oldAttempt;
      await flush();
    });
    expect(current().timeline?.subscriber_id).toBe("subscriber-b");
    expect(current().loadMoreError).toBeNull();
  });
});
