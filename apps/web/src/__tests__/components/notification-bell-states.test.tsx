// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationBell } from "@/components/notification-bell";
import type { NotificationFeedResponse } from "@/lib/notification-feed-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markSeen: vi.fn(),
  markReadAll: vi.fn(),
  markRead: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/notification-feed-api", () => ({
  notificationFeedApi: {
    list: mocks.list,
    markSeen: mocks.markSeen,
    markReadAll: mocks.markReadAll,
    markRead: mocks.markRead,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
  },
}));

const EMPTY: NotificationFeedResponse = { items: [], unread_count: 0 };
const UNREAD: NotificationFeedResponse = {
  unread_count: 1,
  items: [
    {
      id: "notification-1",
      kind: "campaign",
      title: "Campaign sent",
      deep_link: "/app/campaigns/campaign-1",
      created_at: "2026-08-27T10:00:00.000Z",
    },
  ],
};
const READ: NotificationFeedResponse = {
  unread_count: 0,
  items: [
    {
      id: "notification-read",
      kind: "system",
      title: "Certification ready",
      body: "Review the certification result.",
      deep_link: "/app/settings/offline",
      created_at: "2026-08-27T10:00:00.000Z",
      read_at: "2026-08-27T10:05:00.000Z",
    },
  ],
};

const roots: Root[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function render(ui: ReactNode): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return container;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(flush);
    }
  }
  throw lastError;
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.markSeen.mockReset();
  mocks.markReadAll.mockReset();
  mocks.markRead.mockReset();
  mocks.markSeen.mockResolvedValue({ ok: true });
  mocks.markReadAll.mockResolvedValue({ ok: true });
  mocks.markRead.mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("NotificationBell states", () => {
  it("distinguishes the initial pending state from a resolved empty feed", async () => {
    const request = deferred<NotificationFeedResponse>();
    mocks.list.mockReturnValue(request.promise);
    const container = render(
      createElement(NotificationBell, { tenantId: "tenant-1", role: "owner" }),
    );
    const bell = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      bell.click();
      await flush();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading notifications",
    );
    expect(container.textContent).not.toContain("No notifications yet.");

    await act(async () => {
      request.resolve(EMPTY);
      await flush();
    });
    await waitFor(() =>
      expect(container.textContent).toContain("No notifications yet."),
    );
    expect(container.textContent).not.toContain("Loading notifications");
  });

  it("offers a single-flight retry after the feed fails", async () => {
    const retry = deferred<NotificationFeedResponse>();
    mocks.list
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockReturnValueOnce(retry.promise);
    const container = render(
      createElement(NotificationBell, { tenantId: "tenant-1", role: "owner" }),
    );
    const bell = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      bell.click();
      await flush();
    });
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be loaded",
      ),
    );
    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    )!;

    await act(async () => {
      retryButton.click();
      await flush();
    });
    await waitFor(() =>
      expect(container.textContent).toMatch(/Loading notifications|Retrying…/),
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);

    await act(async () => {
      retry.resolve(EMPTY);
      await flush();
    });
    await waitFor(() =>
      expect(container.textContent).toContain("No notifications yet."),
    );
    expect(
      Array.from(container.querySelectorAll("a")).find(
        (link) => link.textContent?.trim() === "View all",
      ),
    ).toBe(document.activeElement);
  });

  it("deduplicates mark-all while the first receipt is pending", async () => {
    const markAll = deferred<{ ok: true }>();
    mocks.list.mockResolvedValueOnce(UNREAD).mockResolvedValue(EMPTY);
    mocks.markSeen.mockReturnValue(new Promise(() => undefined));
    mocks.markReadAll.mockReturnValue(markAll.promise);
    const container = render(
      createElement(NotificationBell, { tenantId: "tenant-1", role: "owner" }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('button[aria-label*="1 unread"]'),
      ).not.toBeNull(),
    );
    const bell = container.querySelector(
      'button[aria-label*="1 unread"]',
    ) as HTMLButtonElement;
    await act(async () => {
      bell.click();
      await flush();
    });
    const markButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Mark all read"),
    )!;
    markButton.focus();

    await act(async () => {
      markButton.click();
      markButton.click();
      await Promise.resolve();
    });
    expect(mocks.markReadAll).toHaveBeenCalledTimes(1);
    expect(markButton.disabled).toBe(true);
    expect(markButton.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      markAll.resolve({ ok: true });
      await flush();
    });
    await waitFor(() =>
      expect(container.textContent).not.toContain("Mark all read"),
    );
    expect(
      Array.from(container.querySelectorAll("a")).find(
        (link) => link.textContent?.trim() === "View all",
      ),
    ).toBe(document.activeElement);
  });

  it("keeps read notification copy fully opaque and contrast-safe", async () => {
    mocks.list.mockResolvedValue(READ);
    const container = render(
      createElement(NotificationBell, { tenantId: "tenant-1", role: "owner" }),
    );
    const bell = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      bell.click();
      await flush();
    });
    await waitFor(() =>
      expect(container.textContent).toContain("Certification ready"),
    );

    const row = container.querySelector("li a") as HTMLAnchorElement;
    expect(row.classList.contains("opacity-70")).toBe(false);
    expect(
      Array.from(row.querySelectorAll<HTMLElement>("[class]")).some((node) =>
        node.className.includes("text-muted-foreground/"),
      ),
    ).toBe(false);
  });
});
