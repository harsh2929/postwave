/**
 * What the cache-provenance record costs per API call.
 *
 * `wireContextEpochCacheReset` subscribes to EVERY observation of the server's
 * context epoch, and every authenticated response carries one. The epoch itself
 * is stable for the life of a context, so all but the first response of a launch
 * re-persisted an identical value — a native storage write per API call, on top
 * of the read that the provenance check genuinely needs.
 *
 * These cases pin the write to the only thing it is for: recording a value that
 * actually changed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storage,
}));

// eslint-disable-next-line import/first
import {
  observeContextEpoch,
  resetContextEpoch,
  wireContextEpochCacheReset,
} from "./contextEpoch";

const KEY = "postwave.mobile.cache-epoch.v1";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function memStore() {
  const map = new Map<string, string>();
  storage.getItem.mockImplementation(async (k) => map.get(k) ?? null);
  storage.setItem.mockImplementation(async (k, v) => {
    map.set(k, v);
  });
  return map;
}

/** A client whose cache the reset path can operate on without react-query. */
const client = { getQueryCache: () => ({ clear: () => undefined }) };

beforeEach(() => {
  resetContextEpoch();
  storage.getItem.mockReset();
  storage.setItem.mockReset();
});

describe("provenance is written only when it moves", () => {
  it("does not rewrite a record that already matches the live epoch", async () => {
    const map = memStore();
    map.set(KEY, "ce1-steady");
    wireContextEpochCacheReset(client, storage);

    observeContextEpoch("ce1-steady");
    await settle();

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("writes once per launch, not once per authenticated response", async () => {
    memStore();
    wireContextEpochCacheReset(client, storage);

    // The first sighting has no record to compare against and must be written.
    observeContextEpoch("ce1-launch");
    await settle();
    // Everything the app does afterwards observes the same epoch again.
    for (let i = 0; i < 25; i += 1) observeContextEpoch("ce1-launch");
    await settle();

    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("still records a context that genuinely changed", async () => {
    // The floor under the two cases above: a skip that also skipped real moves
    // would leave the next launch judging against a retired epoch.
    const map = memStore();
    map.set(KEY, "ce1-before");
    wireContextEpochCacheReset(client, storage);

    observeContextEpoch("ce1-after");
    await settle();

    expect(storage.setItem).toHaveBeenCalledWith(KEY, "ce1-after");
    expect(map.get(KEY)).toBe("ce1-after");
  });
});
