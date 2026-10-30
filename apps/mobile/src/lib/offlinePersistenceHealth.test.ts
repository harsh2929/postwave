import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getOfflinePersistenceHealth,
  reportOfflinePersistenceEviction,
  reportOfflinePersistenceOverflow,
  resetOfflinePersistenceHealth,
  subscribeOfflinePersistenceHealth,
  trimPersistedMutations,
} from "./offlinePersistenceHealth";

beforeEach(() => {
  resetOfflinePersistenceHealth();
});

describe("trimPersistedMutations", () => {
  const measure = (kept: readonly number[]) => kept.length * 10;

  it("keeps everything when it already fits", () => {
    expect(trimPersistedMutations([1, 2, 3], measure, 100)).toEqual({
      kept: [1, 2, 3],
      dropped: 0,
    });
  });

  it("evicts oldest-first until the payload fits", () => {
    expect(trimPersistedMutations([1, 2, 3, 4, 5], measure, 25)).toEqual({
      kept: [4, 5],
      dropped: 3,
    });
  });

  it("stops at empty rather than looping when nothing can fit", () => {
    expect(trimPersistedMutations([1, 2], measure, 0)).toEqual({
      kept: [],
      dropped: 2,
    });
  });

  it("handles an already-empty queue", () => {
    expect(trimPersistedMutations([], measure, 0)).toEqual({
      kept: [],
      dropped: 0,
    });
  });

  it("does not mutate the input array", () => {
    const input = [1, 2, 3];
    trimPersistedMutations(input, measure, 10);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe("offline persistence health", () => {
  it("starts clean", () => {
    expect(getOfflinePersistenceHealth()).toEqual({
      droppedMutations: 0,
      overflows: 0,
      lastBytes: 0,
      limitBytes: 0,
      lastAt: null,
    });
  });

  it("accumulates evictions and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOfflinePersistenceHealth(listener);
    reportOfflinePersistenceEviction({
      dropped: 2,
      bytes: 80_000,
      limitBytes: 72_000,
      now: 10,
    });
    reportOfflinePersistenceEviction({
      dropped: 1,
      bytes: 75_000,
      limitBytes: 72_000,
      now: 20,
    });
    expect(getOfflinePersistenceHealth()).toMatchObject({
      droppedMutations: 3,
      lastBytes: 75_000,
      lastAt: 20,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("ignores a zero-eviction report", () => {
    const listener = vi.fn();
    subscribeOfflinePersistenceHealth(listener);
    reportOfflinePersistenceEviction({
      dropped: 0,
      bytes: 1,
      limitBytes: 2,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(getOfflinePersistenceHealth().droppedMutations).toBe(0);
  });

  it("counts hard overflows separately from evictions", () => {
    reportOfflinePersistenceOverflow({
      bytes: 90_000,
      limitBytes: 72_000,
      now: 5,
    });
    expect(getOfflinePersistenceHealth()).toMatchObject({
      overflows: 1,
      droppedMutations: 0,
      lastBytes: 90_000,
      lastAt: 5,
    });
  });
});
