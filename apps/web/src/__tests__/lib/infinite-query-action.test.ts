// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canLoadNextQueryPage,
  loadNextQueryPage,
  type InfiniteQueryPageAction,
} from "@/lib/infinite-query-action";
import { setOnlineStatusForTest } from "@/lib/online-manager";

function query(
  overrides: Partial<InfiniteQueryPageAction> = {},
): InfiniteQueryPageAction {
  return {
    isEnabled: true,
    hasNextPage: true,
    isFetching: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

afterEach(() => setOnlineStatusForTest("connecting"));

describe("imperative infinite-query continuation guard", () => {
  it("requires live online, authority, enabled, cursor, and idle state", () => {
    const ready = query();
    expect(canLoadNextQueryPage(ready, true, "online")).toBe(true);
    expect(canLoadNextQueryPage(ready, false, "online")).toBe(false);
    expect(canLoadNextQueryPage(ready, true, "connecting")).toBe(false);
    expect(canLoadNextQueryPage(ready, true, "offline")).toBe(false);
    expect(
      canLoadNextQueryPage(query({ isEnabled: false }), true, "online"),
    ).toBe(false);
    expect(
      canLoadNextQueryPage(query({ hasNextPage: false }), true, "online"),
    ).toBe(false);
    expect(
      canLoadNextQueryPage(query({ isFetching: true }), true, "online"),
    ).toBe(false);
    expect(
      canLoadNextQueryPage(query({ isFetchingNextPage: true }), true, "online"),
    ).toBe(false);
  });

  it("single-flights activation before rendered busy state catches up", async () => {
    setOnlineStatusForTest("online");
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = query({ fetchNextPage: vi.fn(() => deferred) });

    const first = loadNextQueryPage(value, true);
    const second = loadNextQueryPage(value, true);
    expect(value.fetchNextPage).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(value.fetchNextPage).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it("releases its synchronous lock after a failed page request", async () => {
    setOnlineStatusForTest("online");
    const value = query({
      fetchNextPage: vi
        .fn()
        .mockRejectedValueOnce(new Error("network failed"))
        .mockResolvedValueOnce({}),
    });
    await expect(loadNextQueryPage(value, true)).rejects.toThrow(
      "network failed",
    );
    await expect(loadNextQueryPage(value, true)).resolves.toBe(true);
    expect(value.fetchNextPage).toHaveBeenCalledTimes(2);
  });
});
