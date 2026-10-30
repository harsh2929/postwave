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
// react-native, whose Flow syntax the node test environment cannot parse. This
// is the same reason src/lib modules are kept free of react-native imports.
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

/**
 * A queued write must not resurrect a record the user deleted.
 *
 * Mobile is the device most often offline, so it is the one most likely to
 * replay a write against a record that was deleted elsewhere in the meantime.
 * `@postwave/offline-outbox` has owned this rule since it was written and no
 * engine called it.
 */

const QUEUED_AT = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const DELETED_AT = new Date(Date.now() - 60 * 60_000).toISOString();

function vars(over: Record<string, unknown> = {}) {
  return {
    auth: {} as never,
    operationId: "op-1",
    method: "PATCH" as const,
    // A segment, not a subscriber: the subscriber PATCH is online-only (it
    // needs If-Match), so it would be refused before this rule is reached.
    path: "/api/v1/segments/seg-1",
    body: { name: "Ada" },
    queuedAt: QUEUED_AT,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getItem.mockResolvedValue(
    JSON.stringify([
      { resource: "segments", id: "seg-1", deletedAt: DELETED_AT },
    ]),
  );
  request.mockResolvedValue({ ok: true });
});

describe("replay respects a deletion", () => {
  it("refuses a write queued before the delete", async () => {
    await expect(executeEntityWrite(vars() as never)).rejects.toMatchObject({
      code: "target_deleted",
    });
    expect(request, "the write reached the server and recreated the record").not.toHaveBeenCalled();
  });

  it("sends a write queued after the delete", async () => {
    // A deliberate recreation. Dropping it would be the mirror failure, and
    // harder to notice — the user is looking at the thing they just made.
    await executeEntityWrite(
      vars({ queuedAt: new Date(Date.now() - 30 * 60_000).toISOString() }) as never,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a write for a DIFFERENT record", async () => {
    // The tombstone names seg-1. An edit to seg-2 has nothing to do with it,
    // and suppressing it would silently drop unrelated work.
    //
    // (A collection-level POST would be the other case worth asserting, but
    // mobile's queue-safety allowlist refuses those for its own reasons, so it
    // never reaches this rule. The shared package covers it directly.)
    await executeEntityWrite(
      vars({ path: "/api/v1/segments/seg-2" }) as never,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends a record persisted by an older build", async () => {
    // No queuedAt: the rule needs the comparison and cannot make it. Suppressing
    // on a guess would silently drop work; this gap drains with the queue.
    await executeEntityWrite(vars({ queuedAt: undefined }) as never);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
