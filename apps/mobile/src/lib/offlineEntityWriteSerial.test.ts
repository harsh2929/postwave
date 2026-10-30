import { MutationCache, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const { getItem, setItem, removeItem, request } = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem, setItem, removeItem },
}));
vi.mock("./offlineMutationScope", () => ({
  assertCurrentAuthScope: () => ({ client: { request } }),
  assertOperationId: () => undefined,
  OfflineMutationReplayError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./offlineReplayTelemetry", () => ({ trackOfflineReplay: vi.fn() }));
vi.mock("./offlineMutationFailures", () => ({
  recordOfflineMutationFailure: vi.fn(),
}));

const { registerEntityWriteMutationDefaults } = await import("./offlineEntityWrite");
const { OFFLINE_MUTATION_KEYS } = await import("./offlineMutationContract");

/**
 * Queued writes must replay ONE AT A TIME.
 *
 * Mobile has no drain loop, so it has no per-resource FIFO bucket either. What
 * it has is `resumePausedMutations()`, which fires the whole paused set through
 * `Promise.all` — and an UNSCOPED mutation's `canRun()` returns true
 * unconditionally, so every queued write goes at once. Two edits to the same
 * record queued offline then race on reconnect and the loser is silently
 * overwritten.
 *
 * This is the case the shared conformance fixture calls "a transient failure
 * parks the rest of its own bucket" on web and desktop. It was recorded here as
 * "no counterpart on mobile" — which was wrong. There is a counterpart; mobile
 * failed it.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("offline entity writes replay serially", () => {
  it("does not start the second write until the first has finished", async () => {
    const qc = new QueryClient({ mutationCache: new MutationCache() });
    registerEntityWriteMutationDefaults(qc);

    const started: string[] = [];
    const finished: string[] = [];
    const gate = deferred<void>();

    // The transport is the observation point: `request` is what actually talks
    // to the server, so ordering here is ordering as the server sees it.
    request.mockImplementation(async (_m: string, path: string) => {
      started.push(path);
      if (path.endsWith("/f1")) await gate.promise;
      finished.push(path);
      return { ok: true };
    });

    const vars = (id: string) => ({
      auth: {} as never,
      operationId: `op-${id}`,
      method: "PATCH" as const,
      path: `/api/v1/forms/${id}`,
      body: { name: id },
    });

    const first = qc
      .getMutationCache()
      .build(qc, { mutationKey: OFFLINE_MUTATION_KEYS.entityWrite })
      .execute(vars("f1") as never);
    const second = qc
      .getMutationCache()
      .build(qc, { mutationKey: OFFLINE_MUTATION_KEYS.entityWrite })
      .execute(vars("f2") as never);

    // Let both mutations get as far as they are going to get.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(
      started,
      "the second write was sent while the first was still in flight — two " +
        "queued edits to one record race and the loser is silently overwritten",
    ).toEqual(["/api/v1/forms/f1"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(started).toEqual(["/api/v1/forms/f1", "/api/v1/forms/f2"]);
    expect(finished, "writes landed out of order").toEqual([
      "/api/v1/forms/f1",
      "/api/v1/forms/f2",
    ]);
  });
});
