/**
 * Concurrency-shape guard for the encrypted-cache teardown.
 *
 * `removeSecureClient` is the tail of two waits a person sees:
 *
 *  - SIGN OUT. store/authCleanup.ts runs `queryPersister.removeClient()` as one
 *    of the parallel cleanup tasks, so the slowest task decides how long the
 *    sign-out sits there.
 *  - COLD LAUNCH. `restoreSecureClient` calls it whenever the cleanup journal
 *    is set, a chunk is missing, or the checksum does not match — before the
 *    persistence provider stops gating and the first screen can fetch.
 *
 * After the tombstone is written, every remaining step is a DELETION of a key
 * nothing else in the function reads: the manifest, slot a, slot b, and the
 * retired plaintext AsyncStorage entry. Awaiting them in a line cost one native
 * round trip per step (6 of them, since each slot's meta read and chunk deletes
 * are their own trips) to enforce an order that carries no meaning.
 *
 * Measured with the harness below, 2026-09-03: 8 waves -> 4 waves for a
 * two-slot teardown, at an unchanged 8 storage ops.
 *
 * The ORDER that does matter is still asserted: the tombstone is written before
 * any deletion and cleared only after all of them, because that marker is what
 * a launch after a half-finished wipe reads to refuse the previous identity.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

const PER_OP_MS = 3;

const probe = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  async: new Map<string, string>(),
  ops: [] as { kind: string; key: string; start: number; end: number }[],
  recording: false,
  failKey: null as string | null,
}));

function op<T>(kind: string, key: string, run: () => T): Promise<T> {
  if (!probe.recording) return Promise.resolve(run());
  const start = performance.now();
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      probe.ops.push({ kind, key, start, end: performance.now() });
      if (probe.failKey === key) {
        reject(new Error("storage failed"));
        return;
      }
      try {
        resolve(run());
      } catch (error) {
        reject(error);
      }
    }, PER_OP_MS);
  });
}

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn((key: string) =>
    op("get", key, () => probe.secure.get(key) ?? null),
  ),
  setItemAsync: vi.fn((key: string, value: string) =>
    op("set", key, () => {
      probe.secure.set(key, value);
    }),
  ),
  deleteItemAsync: vi.fn((key: string) =>
    op("delete", key, () => {
      probe.secure.delete(key);
    }),
  ),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) =>
      op("get", key, () => probe.async.get(key) ?? null),
    ),
    setItem: vi.fn((key: string, value: string) =>
      op("set", key, () => {
        probe.async.set(key, value);
      }),
    ),
    removeItem: vi.fn((key: string) =>
      op("delete", key, () => {
        probe.async.delete(key);
      }),
    ),
  },
}));

// eslint-disable-next-line import/first
import {
  configureQueryPersistenceScope,
  queryPersister,
} from "./secureQueryPersister";

const CLEANUP_KEY = "postwave.mobile.query-cache.v2.cleanup-pending";

/**
 * Sequential round trips on the critical path: ops that were in flight
 * together collapse into one wave, ops awaited one at a time each open their
 * own. Independent of how fast the machine is.
 */
function waves(): number {
  const sorted = [...probe.ops].sort((a, b) => a.start - b.start);
  let count = 0;
  let frontier = -Infinity;
  for (const entry of sorted) {
    if (entry.start >= frontier) count += 1;
    frontier = Math.max(frontier, entry.end);
  }
  return count;
}

function firstIndexOf(needle: string): number {
  return [...probe.ops]
    .sort((a, b) => a.start - b.start)
    .findIndex((entry) => entry.key.endsWith(needle));
}

function lastIndexOf(needle: string): number {
  const sorted = [...probe.ops].sort((a, b) => a.start - b.start);
  let index = -1;
  sorted.forEach((entry, position) => {
    if (entry.key.endsWith(needle)) index = position;
  });
  return index;
}

function persisted(marker: string): PersistedClient {
  return {
    timestamp: Date.now(),
    buster: "postwave-mobile-encrypted-v5",
    clientState: {
      queries: [],
      mutations: [
        {
          mutationKey: ["teardown-guard", marker],
          state: {
            context: undefined,
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: "pending",
            variables: { blob: marker.repeat(400) },
            submittedAt: Date.now(),
          },
        },
      ],
    },
  } as unknown as PersistedClient;
}

const identity = {
  baseUrl: "https://api.moosewave.com",
  tenantId: "tenant-1",
  principalId: "user-1",
  role: "editor",
};

/** Two persists so slot a AND slot b both hold data to tear down. */
async function seedBothSlots(): Promise<void> {
  configureQueryPersistenceScope(identity);
  await queryPersister.persistClient(persisted("a"));
  await queryPersister.persistClient(persisted("b"));
}

describe("removeSecureClient teardown I/O shape", () => {
  beforeEach(() => {
    probe.secure.clear();
    probe.async.clear();
    probe.ops.length = 0;
    probe.recording = false;
    probe.failKey = null;
    configureQueryPersistenceScope(null);
  });

  it("tears both slots down in a constant number of round trips", async () => {
    await seedBothSlots();
    probe.ops.length = 0;
    probe.recording = true;
    await queryPersister.removeClient();
    probe.recording = false;

    // The tombstone, one wave of independent deletions (manifest + both slot
    // metas), the chunk/meta deletions those reads unlock, then the tombstone
    // removal. Serialising the branches again pushes this to 8.
    expect(waves()).toBeLessThanOrEqual(5);
    expect(probe.secure.size).toBe(0);
    expect(probe.async.size).toBe(0);
  });

  it("keeps the tombstone first and last", async () => {
    await seedBothSlots();
    probe.ops.length = 0;
    probe.recording = true;
    await queryPersister.removeClient();
    probe.recording = false;

    // Written before anything is destroyed...
    expect(firstIndexOf("cleanup-pending")).toBe(0);
    // ...and removed only once every deletion has been issued. A launch that
    // finds this marker refuses to restore the previous identity, so batching
    // must never let it be cleared alongside the work it covers.
    expect(lastIndexOf("cleanup-pending")).toBe(probe.ops.length - 1);
  });

  it("keeps the tombstone when any one branch fails", async () => {
    await seedBothSlots();
    probe.ops.length = 0;
    probe.failKey = "postwave.mobile.query-cache.v2.manifest";
    probe.recording = true;
    await expect(queryPersister.removeClient()).rejects.toThrow(/incomplete/i);
    probe.recording = false;

    // `allSettled`, not `all`: the failing manifest delete must not cancel the
    // slot teardown, and the marker must survive for the next launch to retry.
    expect(probe.secure.has(CLEANUP_KEY)).toBe(true);
    expect(
      [...probe.secure.keys()].filter((key) => key.includes(".slot.")),
    ).toEqual([]);
  });
});
