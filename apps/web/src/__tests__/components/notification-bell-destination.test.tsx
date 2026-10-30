// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The bell renders the feed rows the server sends, and one of the things a row
// carries is a server-authored `deep_link`. For content-light topics that link
// is not trustworthy as a client route: an `sms.received` notification arrives
// with the sender's number (and sometimes the message) inside the path and
// query, so following it verbatim writes recipient PII into the browser
// history, the referrer, and every route-derived analytics key.
//
// `notificationFeedDestination` already decides this correctly and is covered
// on its own in src/__tests__/notification-destination.test.ts. What was NOT
// covered is that the bell ASKS it — the component previously read
// `item.deep_link` directly, and reverting it to that leaves the helper's own
// tests entirely green. This file pins the wiring, not the rule.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

import { NotificationBell } from "@/components/notification-bell";
import type { NotificationFeedResponse } from "@/lib/notification-feed-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markSeen: vi.fn(),
  markReadAll: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock("@/lib/notification-feed-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notification-feed-api")>();
  return {
    ...actual,
    notificationFeedApi: {
      list: mocks.list,
      markSeen: mocks.markSeen,
      markReadAll: mocks.markReadAll,
      markRead: mocks.markRead,
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const RAW_PHONE = "+14155550123";

const FEED: NotificationFeedResponse = {
  unread_count: 2,
  items: [
    {
      id: "ntf_sms",
      kind: "sms.received",
      title: "New SMS reply",
      // Exactly the shape the server sends: the number in the path, the
      // message body in the query.
      deep_link: `/app/sms/${RAW_PHONE}?body=my%20private%20message`,
      created_at: "2026-08-20T10:00:00.000Z",
    },
    {
      id: "ntf_campaign",
      kind: "campaign.sent",
      title: "Campaign sent",
      deep_link: "/app/campaigns/campaign-1",
      created_at: "2026-08-20T09:00:00.000Z",
    },
  ],
};

afterEach(() => {
  unmountRoots();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { container: HTMLElement; root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { container, root };
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
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

async function openPanel(): Promise<HTMLElement> {
  mocks.list.mockResolvedValue(FEED);
  mocks.markSeen.mockResolvedValue({ ok: true as const });
  mocks.markRead.mockResolvedValue({ ok: true as const });
  const { container } = render(
    createElement(NotificationBell, { tenantId: "tnt_1", role: "admin" }),
  );
  const bell = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => {
    bell.click();
    await flush();
  });
  await waitFor(() => {
    expect(container.querySelectorAll("li a").length).toBeGreaterThan(0);
  });
  return container;
}

function hrefFor(container: HTMLElement, title: string): string | null {
  const link = [...container.querySelectorAll<HTMLAnchorElement>("li a")].find(
    (a) => a.textContent?.includes(title),
  );
  return link ? link.getAttribute("href") : null;
}

describe("NotificationBell destination", () => {
  it("routes an SMS row through the canonical route, not the PII-bearing deep link", async () => {
    const container = await openPanel();

    // Fails when the bell reads item.deep_link directly: the href is then
    // "/app/sms/+14155550123?body=my%20private%20message".
    expect(hrefFor(container, "New SMS reply")).toBe("/app/sms?tab=inbox");
    expect(container.innerHTML).not.toContain(RAW_PHONE);
    expect(container.innerHTML).not.toContain("private");
  });

  it("still follows a bounded relative deep link for every other topic", async () => {
    const container = await openPanel();

    // The fix must not become a blanket rewrite — a campaign row has no
    // content-light rule and keeps the server's own destination.
    expect(hrefFor(container, "Campaign sent")).toBe("/app/campaigns/campaign-1");
  });
});
