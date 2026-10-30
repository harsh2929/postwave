import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(() => ({
  received: [] as ((n: unknown) => void)[],
  token: [] as ((t: unknown) => void)[],
  removed: 0,
}));
const badge = vi.hoisted(() => ({
  set: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  refresh: vi.fn(() => Promise.resolve(0)),
}));
const invalidateQueries = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const dismissAllNotificationsAsync = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

vi.mock("expo-notifications", () => ({
  dismissAllNotificationsAsync,
  addNotificationReceivedListener: (fn: (n: unknown) => void) => {
    listeners.received.push(fn);
    return {
      remove: () => {
        listeners.removed += 1;
      },
    };
  },
  addPushTokenListener: (fn: (t: unknown) => void) => {
    listeners.token.push(fn);
    return {
      remove: () => {
        listeners.removed += 1;
      },
    };
  },
}));

vi.mock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries } }));
vi.mock("@/lib/appBadge", () => ({
  clearAppBadge: badge.clear,
  refreshAppBadge: badge.refresh,
  setAppBadge: badge.set,
}));

// eslint-disable-next-line import/first
import {
  handleDeliveredPush,
  startPushLifecycle,
  stopPushLifecycle,
  teardownPushPresence,
} from "./pushLifecycle";

beforeEach(() => {
  stopPushLifecycle();
  listeners.received.length = 0;
  listeners.token.length = 0;
  listeners.removed = 0;
  badge.clear.mockClear();
  badge.refresh.mockClear();
  invalidateQueries.mockClear();
  dismissAllNotificationsAsync.mockClear();
  dismissAllNotificationsAsync.mockResolvedValue(undefined);
});

describe("foreground push arrival (NATIVE#64)", () => {
  it("installs a received-listener that invalidates and re-badges", () => {
    startPushLifecycle({ onTokenRotated: vi.fn(async () => undefined) });
    expect(listeners.received).toHaveLength(1);

    listeners.received[0]?.({
      request: { content: { data: { entity: "approval", id: "a1" } } },
    });

    // Independent of SSE: a delivered banner now dirties the cache on its own.
    expect(invalidateQueries).toHaveBeenCalled();
    expect(badge.refresh).toHaveBeenCalled();
  });

  it("survives a payload with no data at all", () => {
    expect(() => handleDeliveredPush(undefined)).not.toThrow();
    expect(badge.refresh).toHaveBeenCalled();
  });
});

describe("push token rotation (NATIVE#48)", () => {
  it("re-registers with the rotated token", () => {
    const onTokenRotated = vi.fn(async () => undefined);
    startPushLifecycle({ onTokenRotated });
    listeners.token[0]?.({ data: "ExponentPushToken[rotated]" });
    expect(onTokenRotated).toHaveBeenCalledWith("ExponentPushToken[rotated]");
  });

  it("ignores an empty or malformed token rather than re-registering", () => {
    const onTokenRotated = vi.fn(async () => undefined);
    startPushLifecycle({ onTokenRotated });
    listeners.token[0]?.({ data: "" });
    listeners.token[0]?.({});
    expect(onTokenRotated).not.toHaveBeenCalled();
  });

  it("does not reject when re-registration fails", () => {
    const onTokenRotated = vi.fn(async () => {
      throw new Error("offline");
    });
    startPushLifecycle({ onTokenRotated });
    expect(() =>
      listeners.token[0]?.({ data: "ExponentPushToken[x]" }),
    ).not.toThrow();
  });

  it("is idempotent — a second launch-time call adds no second listener", () => {
    startPushLifecycle({ onTokenRotated: vi.fn(async () => undefined) });
    startPushLifecycle({ onTokenRotated: vi.fn(async () => undefined) });
    expect(listeners.received).toHaveLength(1);
    expect(listeners.token).toHaveLength(1);
  });
});

describe("teardownPushPresence (NATIVE#11)", () => {
  it("clears the icon badge and removes both listeners on sign-out", async () => {
    startPushLifecycle({ onTokenRotated: vi.fn(async () => undefined) });
    await teardownPushPresence();
    expect(badge.clear).toHaveBeenCalledTimes(1);
    expect(listeners.removed).toBe(2);
  });

  it("empties the notification tray, which holds campaign and customer text", async () => {
    // The badge was cleared but the banners were not: "Summer Sale finished
    // sending" and an inbound SMS preview stayed in Notification Center for
    // whoever holds the phone after sign-out.
    startPushLifecycle({ onTokenRotated: vi.fn(async () => undefined) });
    await teardownPushPresence();
    expect(dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it("still clears the badge when the tray refuses to be dismissed", async () => {
    dismissAllNotificationsAsync.mockRejectedValueOnce(
      new Error("not supported"),
    );
    await expect(teardownPushPresence()).resolves.toBeUndefined();
    expect(badge.clear).toHaveBeenCalledTimes(1);
  });

  it("re-arms cleanly for the next session", async () => {
    startPushLifecycle({ onTokenRotated: vi.fn(async () => undefined) });
    await teardownPushPresence();
    startPushLifecycle({ onTokenRotated: vi.fn(async () => undefined) });
    expect(listeners.received).toHaveLength(2);
  });
});
