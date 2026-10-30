import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSequence,
  getSequence,
  listSequenceParticipants,
  listStuckParticipants,
  normalizeSequenceListResponse,
  sequenceStepCount,
  updateSequence,
} from "./sequences";
import { rawRequest, sdkResource } from "./request";

vi.mock("./request", () => ({ rawRequest: vi.fn(), sdkResource: vi.fn() }));

/**
 * A stand-in for the typed SDK client, so a test can assert WHICH resource
 * method a read reaches for and with what arguments — which is the whole point
 * of routing these through the SDK rather than through a hand-written URL.
 */
function fakeClient() {
  return {
    sequences: {
      get: vi.fn(async () => ({ id: "seq-1", version: 3 })),
      participants: vi.fn(async () => ({
        items: [],
        total: 0,
        page: 1,
        per_page: 25,
      })),
      funnel: vi.fn(async () => ({ sequence_id: "seq-1", steps: [] })),
      stuck: vi.fn(async () => ({ items: [], threshold_days: 7 })),
    },
  };
}

/** Run whatever `sdkResource` was handed, against the fake client. */
function runThroughFakeClient(client: ReturnType<typeof fakeClient>) {
  vi.mocked(sdkResource).mockImplementation(
    async (call: (c: never) => Promise<unknown>) => ({
      data: await call(client as never),
      error: null,
    }),
  );
}

describe("sequence list response normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts the Voice service's bare array response", () => {
    const rows = [{ id: "seq-1", name: "Welcome", steps: [] }];
    expect(normalizeSequenceListResponse(rows)).toEqual(rows);
  });

  it("derives counts from nested steps and legacy emails", () => {
    expect(
      sequenceStepCount({
        id: "seq-1",
        steps: [{ type: "exit", position: 1 }],
      }),
    ).toBe(1);
    expect(sequenceStepCount({ id: "seq-2", emails: [{}, {}] })).toBe(2);
  });

  it("sends the captured server version on every sequence update", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: { id: "seq-1", version: 8 },
      error: null,
    });

    await expect(
      updateSequence(
        "seq-1",
        { steps: [{ type: "exit", position: 1 }] },
        { expectedVersion: 7, idempotencyKey: "save-1" },
      ),
    ).resolves.toMatchObject({ data: { version: 8 } });
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/voice/sequences/seq-1",
      { steps: [{ type: "exit", position: 1 }] },
      {
        idempotencyKey: "save-1",
        headers: { "If-Match": '"7"' },
      },
    );
  });

  it("fails closed before transport when no fresh version is available", async () => {
    await expect(
      updateSequence("seq-1", { name: "Unsafe" }, { expectedVersion: 0 }),
    ).resolves.toMatchObject({
      error: { status: 0, message: expect.stringMatching(/fresh sequence version/i) },
    });
    expect(rawRequest).not.toHaveBeenCalled();
  });

  /**
   * The version guard uses the SDK's own `isSequenceVersion`, the same
   * predicate `sequenceIfMatch` enforces — so these can never disagree about
   * what the Voice handler will accept, and neither can reach the network with
   * a value that is a guaranteed 400.
   */
  it("fails closed on DELETE too, for every shape the server would reject", async () => {
    for (const bad of [0, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        deleteSequence("seq-1", { expectedVersion: bad }),
      ).resolves.toMatchObject({
        error: {
          status: 0,
          message: expect.stringMatching(/fresh sequence version/i),
        },
      });
    }
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("sends the SDK-canonical If-Match on delete", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({ data: null, error: null });

    await deleteSequence("seq-1", { expectedVersion: 4, idempotencyKey: "d1" });

    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/voice/sequences/seq-1",
      undefined,
      { idempotencyKey: "d1", headers: { "If-Match": '"4"' } },
    );
  });
});

/**
 * These reads used to be hand-written URLs here. They are now the SDK's typed
 * resource, which is the only copy of the path, the query-parameter names and
 * the id encoding.
 */
describe("sequence reads go through the typed SDK resource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the resource for one sequence rather than building a path", async () => {
    const client = fakeClient();
    runThroughFakeClient(client);

    await expect(getSequence("seq/a")).resolves.toMatchObject({
      data: { id: "seq-1" },
    });
    expect(client.sequences.get).toHaveBeenCalledWith("seq/a");
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("passes participant filters through, and omits the ones nobody set", async () => {
    const client = fakeClient();
    runThroughFakeClient(client);

    await listSequenceParticipants("seq-1", { status: "active", page: 2 });
    expect(client.sequences.participants).toHaveBeenCalledWith("seq-1", {
      status: "active",
      page: 2,
    });

    // exactOptionalPropertyTypes: an explicit `undefined` is a type error AND
    // would show up as a key in the query builder, so an unset filter must not
    // appear at all.
    await listSequenceParticipants("seq-1");
    expect(client.sequences.participants).toHaveBeenLastCalledWith("seq-1", {});
  });

  it("passes a stuck-threshold override through, and absence as absence", async () => {
    const client = fakeClient();
    runThroughFakeClient(client);

    await listStuckParticipants("seq-1", 14);
    expect(client.sequences.stuck).toHaveBeenCalledWith("seq-1", 14);

    await listStuckParticipants("seq-1");
    expect(client.sequences.stuck).toHaveBeenLastCalledWith("seq-1", undefined);
  });
});
