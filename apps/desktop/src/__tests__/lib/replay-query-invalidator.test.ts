import { describe, expect, it, vi } from "vitest";

import {
  installReplayedQueryInvalidator,
  invalidateReplayedQueryPrefix,
} from "../../lib/replay-query-invalidator";

describe("replay query invalidation boundary", () => {
  it("is a no-op before the query layer boots", () => {
    expect(() => invalidateReplayedQueryPrefix("campaigns")).not.toThrow();
  });

  it("dispatches prefixes and detaches the installed callback", () => {
    const invalidate = vi.fn();
    const dispose = installReplayedQueryInvalidator(invalidate);

    invalidateReplayedQueryPrefix("campaigns");
    invalidateReplayedQueryPrefix("campaign");
    expect(invalidate.mock.calls).toEqual([["campaigns"], ["campaign"]]);

    dispose();
    invalidateReplayedQueryPrefix("subscribers");
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("does not let stale disposal clear a replacement", () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = installReplayedQueryInvalidator(first);
    const disposeSecond = installReplayedQueryInvalidator(second);

    disposeFirst();
    invalidateReplayedQueryPrefix("lists");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("lists");

    disposeSecond();
  });

  it("contains invalidator failures after replay already succeeded", () => {
    const dispose = installReplayedQueryInvalidator(() => {
      throw new Error("cache unavailable");
    });
    expect(() => invalidateReplayedQueryPrefix("tags")).not.toThrow();
    dispose();
  });
});
