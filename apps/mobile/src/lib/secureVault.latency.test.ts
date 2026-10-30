/**
 * Concurrency-shape guard for the offline vault purge.
 *
 * `vaultClear` runs in two places where a person is waiting: the sign-out
 * sweep (store/authCleanup.ts runs it as one of the parallel cleanup tasks, so
 * it is the tail that decides how long "Sign out" spins), and — more sharply —
 * the FIRST thing `runHydrate` does on a cold launch, where
 * `vaultRecoverPendingCleanup` retries an interrupted purge before `hydrated`
 * flips and anything can paint.
 *
 * Every entry in a manifest is an independent Keychain item. Deleting them one
 * `await` at a time made the cost linear in the number of cached rows: a
 * 40-entry manifest cost 40 sequential native round trips, ~80-120ms at a
 * realistic 2-3ms per SecureStore call, purely from ordering that carries no
 * meaning.
 *
 * This test measures the SHAPE rather than the clock. Each mocked native call
 * records the window it occupied; `waves()` then counts how many times the
 * store went idle between calls, which is the number of sequential round trips
 * on the critical path. Serial code produces one wave per op; batched code
 * produces a small constant. The op COUNT is asserted too, so a "fix" that
 * merely stopped deleting things fails just as loudly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PER_OP_MS = 4;

const state = vi.hoisted(() => ({
  data: new Map<string, string>(),
  ops: [] as { kind: string; key: string; start: number; end: number }[],
  failDeleteKey: null as string | null,
}));

function record<T>(kind: string, key: string, run: () => T): Promise<T> {
  const start = performance.now();
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      state.ops.push({ kind, key, start, end: performance.now() });
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
  setItemAsync: vi.fn((key: string, value: string) =>
    record("set", key, () => {
      state.data.set(key, value);
    }),
  ),
  getItemAsync: vi.fn((key: string) =>
    record("get", key, () => state.data.get(key) ?? null),
  ),
  deleteItemAsync: vi.fn((key: string) =>
    record("delete", key, () => {
      if (state.failDeleteKey === key) throw new Error("delete failed");
      state.data.delete(key);
    }),
  ),
}));

// eslint-disable-next-line import/first
import { vaultClear, vaultSetJSON, vaultScopeForClient } from "./secureVault";

/**
 * Sequential round trips on the critical path: walk the recorded ops in start
 * order and count each moment the store had gone idle first. Ops dispatched
 * together overlap and collapse into one wave; ops awaited one at a time each
 * open their own.
 */
function waves(): number {
  const sorted = [...state.ops].sort((a, b) => a.start - b.start);
  let count = 0;
  let frontier = -Infinity;
  for (const op of sorted) {
    if (op.start >= frontier) count += 1;
    frontier = Math.max(frontier, op.end);
  }
  return count;
}

const scope = vaultScopeForClient({
  baseUrl: "https://api.moosewave.com",
  tenantId: "tenant-a",
  userId: "user-a",
  role: "editor",
});

async function seed(entries: number): Promise<void> {
  for (let index = 0; index < entries; index += 1) {
    await vaultSetJSON("subscriber", `sub_${index}`, { index }, { scope });
  }
}

describe("vaultClear dispatches its deletions concurrently", () => {
  beforeEach(() => {
    state.data.clear();
    state.ops = [];
    state.failDeleteKey = null;
  });

  it("a 40-entry purge costs a constant number of round trips, not 40", async () => {
    await seed(40);
    state.ops = [];

    await vaultClear();

    const deletes = state.ops.filter((op) => op.kind === "delete");
    // Every entry is still deleted: 40 payloads + the v3 manifest + two legacy
    // manifests + the cleanup marker.
    expect(deletes).toHaveLength(44);
    expect(state.data.size).toBe(0);

    // Serial deletion of 40 entries produced 48 waves. The batched shape is
    // the marker write, then the three manifest reads, then the entry
    // deletions, then the manifest deletions, then the marker deletion. The
    // ceiling is deliberately loose enough not to encode the exact interleave
    // and far below anything a per-entry `await` could reach.
    expect(waves()).toBeLessThanOrEqual(8);
  });

  it("scales with the number of manifests, not the number of entries", async () => {
    await seed(8);
    state.ops = [];
    await vaultClear();
    const small = waves();

    state.data.clear();
    state.ops = [];
    await seed(40);
    state.ops = [];
    await vaultClear();
    const large = waves();

    // Five times the entries must not cost five times the round trips. A
    // serial loop makes `large - small` about 32; a batch makes it 0.
    expect(large - small).toBeLessThanOrEqual(2);
  });

  it("still reports and retains a failed entry deletion", async () => {
    await seed(3);
    const stuck = [...state.data.keys()].find((key) =>
      key.includes(".subscriber.sub_1"),
    );
    expect(stuck).toBeDefined();
    state.failDeleteKey = stuck ?? null;
    state.ops = [];

    // Batching must not swallow a per-key failure: the purge still rejects,
    // the marker survives for a retry, and the failed key stays enumerable.
    await expect(vaultClear()).rejects.toThrow(/incomplete/i);
    expect(state.data.has("postwave.mobile.vault.v3.__cleanup_pending")).toBe(
      true,
    );
    expect(state.data.get("postwave.mobile.vault.v3.__manifest")).toContain(
      stuck,
    );
    // The other two entries were deleted anyway — one rejection must not
    // cancel its siblings the way `Promise.all` would.
    expect(
      [...state.data.keys()].filter((key) => key.includes(".subscriber.")),
    ).toEqual([stuck]);
  });
});
