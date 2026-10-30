import {
  conformanceCases,
  partitionByShape,
  SHAPES_NO_ENGINE_QUEUES,
  type ConformanceBinding,
} from "@postwave/offline-outbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getItem, setItem, removeItem, request } = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem, setItem, removeItem },
}));
// Mocked WITHOUT importing the original: the real module's import chain reaches
// react-native, whose Flow syntax the node test environment cannot parse. Same
// reason src/lib modules are kept free of react-native imports.
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

const { executeEntityWrite } = await import("./offlineEntityWrite");
const { isQueueableMutation } = await import("./offlineQueueSafety");

/**
 * Mobile's replay path, run against the SHARED conformance fixture.
 *
 * Mobile's call site differs from web's and desktop's in a way that matters:
 * it builds the candidate inline as `{ method, path, queuedAt }` and passes NO
 * `resource`, relying entirely on the rule deriving one from the path. That is
 * a legitimate choice and an untested one — the package's own tests always pass
 * a `resource`, so nothing anywhere exercised the fallback through a real
 * caller. This does.
 *
 * SCOPE, and a correction. This file first said the fixture's injected-failure
 * scenarios "have no counterpart here" because mobile replays through
 * react-query rather than a per-resource FIFO loop. That was wrong, and wrong
 * in the direction that matters: the ORDERING REQUIREMENT has a counterpart on
 * every surface, and mobile was failing it. `resumePausedMutations()` fires the
 * whole paused set through `Promise.all`, and an unscoped mutation's `canRun()`
 * returns true unconditionally, so two queued edits to one record raced on
 * reconnect and the loser was silently overwritten. Recording that as "out of
 * scope" is exactly how a conformance suite launders a failing requirement.
 *
 * The requirement is now enforced — `scope.id` in the mutation defaults — and
 * covered by offlineEntityWriteSerial.test.ts, which drives the real mutation
 * cache and fails if the scope is removed. What genuinely has no counterpart
 * here is the SHAPE of the fixture's scenarios (seed a queue, drain it, count
 * totals), because there is no drain function to call; the property they assert
 * is tested against mobile's own machinery instead.
 */

const BINDING: ConformanceBinding = { resource: "forms", otherResource: "segments" };

function vars(over: Record<string, unknown> = {}) {
  return {
    auth: {} as never,
    operationId: "op-1",
    method: "PATCH" as const,
    path: "/api/v1/forms/forms-1",
    body: { name: "Ada" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ ok: true });
});

describe("mobile conformance: tombstone suppression", () => {
  const cases = conformanceCases(Date.now(), BINDING);
  const { runnable, skippedShapes } = partitionByShape(cases, (method, path) =>
    isQueueableMutation(method, path, { name: "Ada" }),
  );

  it("skips exactly the shapes mobile's allowlist cannot express, and no others", () => {
    expect(skippedShapes).toEqual(SHAPES_NO_ENGINE_QUEUES);
    expect(runnable.length, "the runnable set changed size").toBe(
      cases.length - SHAPES_NO_ENGINE_QUEUES.length,
    );
  });

  for (const c of runnable) {
    it(`${c.name} → ${c.suppressed ? "refused" : "sent"}`, async () => {
      getItem.mockResolvedValue(JSON.stringify(c.tombstones));

      const run = executeEntityWrite(
        vars({
          method: c.mutation.method,
          path: c.mutation.path,
          queuedAt: c.mutation.queuedAt,
        }) as never,
      );

      if (c.suppressed) {
        // The code matters as much as the refusal: the UI shows a "record was
        // deleted" outcome for `target_deleted` and a retryable error for
        // anything else, so a refusal with the wrong code is surfaced to the
        // user as a sync failure for something that went exactly as they wanted.
        await expect(run, c.why).rejects.toMatchObject({ code: "target_deleted" });
        expect(request, c.why).not.toHaveBeenCalled();
      } else {
        await expect(run, c.why).resolves.toBeDefined();
        expect(request, c.why).toHaveBeenCalledTimes(1);
      }
    });
  }
});
