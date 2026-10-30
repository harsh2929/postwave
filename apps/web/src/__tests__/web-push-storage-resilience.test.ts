// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: web-push used localStorage unguarded, and kept the endpoint cache
// write inside the same try as the backend registration. Storage throws for real
// — QuotaExceededError when full, SecurityError when a policy blocks site
// storage (Safari private mode, storage partitioning) — and that produced two
// user-visible failures:
//
//   * subscribe: setItem threw AFTER api.post had already committed the
//     server-side registration, so the catch rolled the subscription back with
//     sub.unsubscribe() and reported an error for an operation that succeeded;
//   * unsubscribe: removeItem threw before sub.unsubscribe() could run, so
//     unsubscribing was impossible whenever storage was blocked.
//
// The endpoint record is only a local cache of "did we register", so losing it
// must degrade the UI, never fail the operation.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post },
}));

interface FakeSub {
  endpoint: string;
  expirationTime: number | null;
  toJSON: () => unknown;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeSubscription(): FakeSub {
  return {
    endpoint: "https://push.example/abc",
    expirationTime: null,
    toJSON: () => ({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "PKEY", auth: "AUTH" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
}

/** Stub just enough of a push-capable browser for webPushSupport() to pass. */
function stubBrowser(sub: FakeSub, existingSubscription: boolean) {
  const subscribe = vi.fn(async () => sub);
  const getSubscription = vi.fn(async () =>
    existingSubscription ? sub : null,
  );
  vi.stubGlobal("PushManager", class PushManager {});
  vi.stubGlobal("Notification", {
    permission: "granted",
    requestPermission: vi.fn(async () => "granted"),
  });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }),
    },
  });
  return { subscribe, getSubscription };
}

function blockStorage(method: "setItem" | "removeItem"): void {
  vi.spyOn(window.localStorage, method).mockImplementation(() => {
    throw new DOMException("storage blocked", "SecurityError");
  });
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("web push storage resilience", () => {
  it("keeps a committed subscription when caching the endpoint fails", async () => {
    const sub = fakeSubscription();
    stubBrowser(sub, false);
    mocks.get.mockResolvedValue({ enabled: true, public_key: "aGVsbG8" });
    mocks.post.mockResolvedValue({});
    blockStorage("setItem");

    const { subscribeToWebPush } = await import("@/lib/web-push");
    const result = await subscribeToWebPush();

    // The backend registration succeeded, so this must report success...
    expect(result.status).toBe("subscribed");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    // ...and must NOT have rolled back the subscription it just created.
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it("still rolls back when the backend registration itself fails", async () => {
    const sub = fakeSubscription();
    stubBrowser(sub, false);
    mocks.get.mockResolvedValue({ enabled: true, public_key: "aGVsbG8" });
    mocks.post.mockRejectedValue(new Error("backend down"));

    const { subscribeToWebPush } = await import("@/lib/web-push");
    const result = await subscribeToWebPush();

    // A browser-only subscription is undeliverable; the rollback must remain.
    expect(result.status).toBe("error");
    expect(result.message).toBe("backend down");
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes even when clearing the endpoint cache throws", async () => {
    const sub = fakeSubscription();
    stubBrowser(sub, true);
    mocks.post.mockResolvedValue({});
    blockStorage("removeItem");

    const { unsubscribeFromWebPush } = await import("@/lib/web-push");
    await expect(unsubscribeFromWebPush()).resolves.toBeUndefined();

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/notifications/web-push/unsubscribe",
      { endpoint: "https://push.example/abc" },
    );
  });

  it("reports not-subscribed rather than throwing when storage is unreadable", async () => {
    const sub = fakeSubscription();
    stubBrowser(sub, true);
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("storage blocked", "SecurityError");
    });

    const { isSubscribed } = await import("@/lib/web-push");
    await expect(isSubscribed()).resolves.toBe(false);
  });
});
