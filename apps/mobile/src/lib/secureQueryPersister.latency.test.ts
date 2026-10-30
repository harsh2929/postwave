/**
 * Boot-path latency guard for the persisted query cache.
 *
 * restoreSecureClient runs on the launch path — PersistQueryClientProvider
 * holds `isRestoring` true until it resolves, and TanStack starts no fetch
 * while that is true — so the SHAPE of its storage I/O is time before the
 * first screen has data, not an implementation detail.
 *
 * WHAT IS MEASURED, AND WHY IT IS ROUND TRIPS AND NOT MILLISECONDS.
 * expo-modules-core dispatches every AsyncFunction onto ONE serial queue
 * (`DispatchQueue(label: "expo.modules.AsyncFunctionQueue", qos: .userInitiated)`
 * — no `.concurrent` attribute), so Keychain calls never execute in parallel
 * no matter how they are issued from JS. What Promise.all removes is the
 * ROUND TRIP: ops issued in one JS turn drain back-to-back on the native queue
 * and wake the JS thread once, instead of once per op. On a cold start the JS
 * thread is also evaluating the module graph and running React's first render,
 * so each of those wake-ups is a reschedule behind that work.
 *
 * A "wave" below = a group of storage ops that were in flight together, i.e.
 * one JS -> native -> JS round trip. The previous version of this file timed
 * `getItemAsync` — the MOCK — in a loop, which is self-referential: it would
 * have passed unchanged if restoreSecureClient had gone fully serial. This one
 * drives the real function.
 *
 * MEASURED 2026-09-03, before -> after collapsing the preamble:
 *   populated cache (26 chunks, 29 ops):  4 waves -> 2 waves
 *   no cache at all  (3 ops):             3 waves -> 1 wave
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

const probe = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  async: new Map<string, string>(),
  ops: [] as { key: string; wave: number }[],
  inflight: 0,
  waves: 0,
  recording: false,
}));

/**
 * Every mocked storage call takes a real (tiny) timer, so "issued in the same
 * JS turn" is unambiguous: concurrent issues share a wave, a sequential
 * `await` cannot.
 */
function op<T>(key: string, run: () => T): Promise<T> {
  if (!probe.recording) return Promise.resolve(run());
  if (probe.inflight === 0) probe.waves += 1;
  probe.inflight += 1;
  probe.ops.push({ key, wave: probe.waves });
  return new Promise<T>((resolve) => {
    setTimeout(() => {
      probe.inflight -= 1;
      resolve(run());
    }, 1);
  });
}

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn((key: string) =>
    op(key, () => probe.secure.get(key) ?? null),
  ),
  setItemAsync: vi.fn((key: string, value: string) =>
    op(key, () => {
      probe.secure.set(key, value);
    }),
  ),
  deleteItemAsync: vi.fn((key: string) =>
    op(key, () => {
      probe.secure.delete(key);
    }),
  ),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => op(key, () => probe.async.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) =>
      op(key, () => {
        probe.async.set(key, value);
      }),
    ),
    removeItem: vi.fn((key: string) =>
      op(key, () => {
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

const identity = {
  baseUrl: "https://api.moosewave.com",
  tenantId: "tenant-1",
  principalId: "user-1",
  role: "editor",
};

/** A paused mutation big enough to need many chunks, like a real queue. */
function persisted(blobBytes: number): PersistedClient {
  return {
    timestamp: Date.now(),
    buster: "postwave-mobile-encrypted-v5",
    clientState: {
      queries: [],
      mutations: [
        {
          mutationKey: ["latency-guard"],
          state: {
            context: undefined,
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: "pending",
            variables: { blob: "x".repeat(blobBytes) },
            submittedAt: Date.now(),
          },
        },
      ],
    },
  } as unknown as PersistedClient;
}

async function record<T>(run: () => Promise<T>): Promise<{
  result: T;
  ops: string[];
  waves: number;
  waveOf: (needle: string) => number | undefined;
}> {
  probe.ops.length = 0;
  probe.inflight = 0;
  probe.waves = 0;
  probe.recording = true;
  const result = await run();
  probe.recording = false;
  return {
    result,
    ops: probe.ops.map((entry) => entry.key),
    waves: probe.waves,
    waveOf: (needle) => probe.ops.find((e) => e.key.endsWith(needle))?.wave,
  };
}

describe("restoreSecureClient boot-path I/O shape", () => {
  beforeEach(() => {
    probe.secure.clear();
    probe.async.clear();
    probe.recording = false;
  });

  it("issues the whole preamble in ONE round trip", async () => {
    configureQueryPersistenceScope(identity);
    const run = await record(() => queryPersister.restoreClient());

    // Legacy purge + cleanup-journal probe + manifest read. Independent keys,
    // so they belong in one wave. Serial awaits would make this 3.
    expect(run.ops).toHaveLength(3);
    expect(run.waves).toBe(1);
  });

  it("adds exactly one more round trip for a populated cache, whatever the chunk count", async () => {
    configureQueryPersistenceScope(identity);
    await queryPersister.persistClient(persisted(46_000));
    const run = await record(() => queryPersister.restoreClient());

    expect(run.result).toBeTruthy();
    const chunks = run.ops.filter((key) => key.includes(".slot."));
    // A payload this size genuinely needs many Keychain items; the point of
    // the guard is that their COUNT does not drive the round-trip count.
    expect(chunks.length).toBeGreaterThan(10);

    // Wave 1: the preamble. Wave 2: every chunk. Nothing else.
    expect(run.waves).toBe(2);
    expect(run.waveOf(".manifest")).toBe(1);
    expect(run.waveOf(".cleanup-pending")).toBe(1);
    expect(run.waveOf("query-cache.v1")).toBe(1);
    for (const key of run.ops) {
      if (key.includes(".slot.")) expect(run.waveOf(key)).toBe(2);
    }
  });

  it("still lets the cleanup journal win over a manifest read that raced it", async () => {
    // The preamble now reads the manifest concurrently with the journal probe.
    // The journal must still veto the restore — that is a fail-closed rule
    // about another identity's data, not a performance detail.
    configureQueryPersistenceScope(identity);
    await queryPersister.persistClient(persisted(4_000));
    probe.secure.set(
      "postwave.mobile.query-cache.v2.cleanup-pending",
      String(Date.now()),
    );

    await expect(queryPersister.restoreClient()).resolves.toBeUndefined();
    // ...and the pending cleanup was carried out rather than merely reported.
    expect(
      probe.secure.has("postwave.mobile.query-cache.v2.manifest"),
    ).toBe(false);
  });

  it("still deletes the retired plaintext cache on every restore", async () => {
    configureQueryPersistenceScope(identity);
    probe.async.set("postwave.mobile.query-cache.v1", "{}");
    await queryPersister.restoreClient();
    expect(probe.async.has("postwave.mobile.query-cache.v1")).toBe(false);
  });
});
