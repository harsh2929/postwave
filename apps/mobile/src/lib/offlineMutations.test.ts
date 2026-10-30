import { beforeEach, describe, expect, it, vi } from "vitest";

const { request, createSequence, updateSequence } = vi.hoisted(() => ({
  request: vi.fn(async (_method: string, _path: string, options: unknown) => ({
    options,
  })),
  createSequence: vi.fn(async (input: { name: string }) => ({
    data: { id: 42, name: input.name },
  })),
  updateSequence: vi.fn(
    async (id: string, patch: { steps: unknown[] }, options: unknown) => ({
      data: { id, steps: patch.steps, version: 10, options },
    }),
  ),
}));
const track = vi.hoisted(() => vi.fn());

const currentClient = {
  baseUrl: "https://api.moosewave.com",
  tenantId: "tenant_1",
};
const currentAuthScope = {
  ...currentClient,
  principalId: "user_1",
  role: "editor",
  queuedAt: Date.now(),
  expiresAt: Date.now() + 2 * 60 * 60 * 1000,
};

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({
    ...currentClient,
    client: { request },
  }),
}));

vi.mock("@/api/sequences", () => ({
  createSequence,
  updateSequence,
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
}));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      mode: "session",
      apiKey: null,
      session: {
        userId: "user_1",
        effectiveRole: "editor",
      },
    }),
  },
}));

vi.mock("./offlineMutationFailures", () => ({
  recordOfflineMutationFailure: vi.fn(async () => undefined),
}));
vi.mock("./telemetry", () => ({ track }));

// eslint-disable-next-line import/first
import { QueryClient } from "@tanstack/react-query";
// eslint-disable-next-line import/first
import {
  acceptFetchedSequenceVersion,
  newOfflineOperationId,
  OFFLINE_MUTATION_KEYS,
  registerOfflineMutationDefaults,
  resetSequenceSaveAuthorityForTests,
} from "./offlineMutations";

describe("offline mutation defaults", () => {
  const operationId = "operation-00000001";

  beforeEach(() => {
    vi.clearAllMocks();
    resetSequenceSaveAuthorityForTests();
  });

  it("mints operation IDs from native cryptographic randomness", () => {
    expect(newOfflineOperationId()).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("registers a resumable mutationFn for campaign-subject updates", async () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);

    const defaults = qc.getMutationDefaults(
      OFFLINE_MUTATION_KEYS.campaignUpdate,
    );
    // Without this, resumePausedMutations rejects with "No mutationFn found"
    // and the persisted offline edit is silently lost.
    expect(typeof defaults.mutationFn).toBe("function");

    const fn = defaults.mutationFn as (v: unknown) => Promise<unknown>;
    const res = await fn({
      auth: currentAuthScope,
      operationId,
      id: "c1",
      subject: "Hello",
    });
    expect(request).toHaveBeenCalledWith("PATCH", "/api/v1/campaigns/c1", {
      body: { subject: "Hello" },
      idempotencyKey: operationId,
    });
    expect(res).toEqual({
      options: {
        body: { subject: "Hello" },
        idempotencyKey: operationId,
      },
    });
    await defaults.onSuccess?.(
      res,
      { auth: currentAuthScope, operationId, id: "c1", subject: "Hello" },
      undefined,
      {
        client: qc,
        meta: undefined,
        mutationKey: OFFLINE_MUTATION_KEYS.campaignUpdate,
      },
    );
    expect(track).toHaveBeenCalledWith(
      "mobile.offline_replay_completed",
      expect.objectContaining({
        source: "campaign_update",
        outcome: "success",
        duration_ms: expect.any(Number),
      }),
    );
  });

  it("registers a resumable mutationFn for sequence creation", async () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);

    const defaults = qc.getMutationDefaults(
      OFFLINE_MUTATION_KEYS.sequenceCreate,
    );
    expect(typeof defaults.mutationFn).toBe("function");

    const fn = defaults.mutationFn as (v: unknown) => Promise<unknown>;
    const res = await fn({
      auth: currentAuthScope,
      operationId,
      name: "Untitled sequence",
    });
    expect(createSequence).toHaveBeenCalledWith(
      { name: "Untitled sequence" },
      { idempotencyKey: operationId },
    );
    expect(res).toEqual({ data: { id: 42, name: "Untitled sequence" } });
  });

  it("registers a resumable mutationFn for sequence-builder saves", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    registerOfflineMutationDefaults(qc);

    const defaults = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.sequenceSave);
    expect(typeof defaults.mutationFn).toBe("function");
    expect(defaults.scope).toEqual({ id: "postwave:sequence-save" });

    const steps = [{ id: "s1", kind: "email" }];
    const fn = defaults.mutationFn as (v: unknown) => Promise<unknown>;
    const res = await fn({
      auth: currentAuthScope,
      operationId,
      id: "seq1",
      baseVersion: 9,
      steps,
    });
    expect(updateSequence).toHaveBeenCalledWith(
      "seq1",
      { steps },
      { idempotencyKey: operationId, expectedVersion: 9 },
    );
    expect(res).toEqual({
      confirmedBaseVersion: 9,
      data: {
        id: "seq1",
        steps,
        version: 10,
        options: { idempotencyKey: operationId, expectedVersion: 9 },
      },
      error: null,
    });

    const vars = {
      auth: currentAuthScope,
      operationId,
      id: "seq1",
      baseVersion: 9,
      steps,
    };
    await defaults.onSuccess?.(res, vars, undefined, {
      client: qc,
      meta: undefined,
      mutationKey: OFFLINE_MUTATION_KEYS.sequenceSave,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["sequence", "tenant_1", "seq1"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sequences"] });
  });

  it("chains the exact confirmed revision across queued snapshots authored from one base", async () => {
    updateSequence
      .mockResolvedValueOnce({
        data: {
          id: "seq1",
          steps: [{ id: "first" }],
          version: 10,
          options: {},
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "seq1",
          steps: [{ id: "second" }],
          version: 11,
          options: {},
        },
      });
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    const fn = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.sequenceSave)
      .mutationFn as (v: unknown) => Promise<unknown>;

    await fn({
      auth: currentAuthScope,
      operationId: "operation-queued-01",
      id: "seq1",
      baseVersion: 9,
      steps: [{ id: "first" }],
    });
    await fn({
      auth: currentAuthScope,
      operationId: "operation-queued-02",
      id: "seq1",
      baseVersion: 9,
      steps: [{ id: "second" }],
    });

    expect(updateSequence).toHaveBeenNthCalledWith(
      1,
      "seq1",
      { steps: [{ id: "first" }] },
      expect.objectContaining({ expectedVersion: 9 }),
    );
    expect(updateSequence).toHaveBeenNthCalledWith(
      2,
      "seq1",
      { steps: [{ id: "second" }] },
      expect.objectContaining({ expectedVersion: 10 }),
    );
  });

  it("never lets a late stale detail fetch move confirmed save authority backwards", async () => {
    acceptFetchedSequenceVersion(currentAuthScope, "seq1", 12);
    acceptFetchedSequenceVersion(currentAuthScope, "seq1", 10);
    updateSequence.mockResolvedValueOnce({
      data: { id: "seq1", steps: [], version: 13, options: {} },
    });
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    const fn = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.sequenceSave)
      .mutationFn as (v: unknown) => Promise<unknown>;

    await fn({
      auth: currentAuthScope,
      operationId: "operation-stale-get-01",
      id: "seq1",
      baseVersion: 9,
      steps: [],
    });

    expect(updateSequence).toHaveBeenCalledWith(
      "seq1",
      { steps: [] },
      expect.objectContaining({ expectedVersion: 12 }),
    );
  });

  it("blocks further replay when a 2xx response does not confirm identity and the exact next version", async () => {
    updateSequence.mockResolvedValueOnce({
      data: { id: "another-sequence", steps: [], version: 10, options: {} },
    });
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    const fn = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.sequenceSave)
      .mutationFn as (v: unknown) => Promise<unknown>;
    const vars = {
      auth: currentAuthScope,
      operationId: "operation-invalid-01",
      id: "seq1",
      baseVersion: 9,
      steps: [],
    };

    await expect(fn(vars)).rejects.toThrow(/did not confirm/i);
    await expect(
      fn({ ...vars, operationId: "operation-invalid-02" }),
    ).rejects.toThrow(/saving is locked/i);
    expect(updateSequence).toHaveBeenCalledTimes(1);
  });

  it("rejects queued mutations from another workspace before replaying", async () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);

    const defaults = qc.getMutationDefaults(
      OFFLINE_MUTATION_KEYS.campaignUpdate,
    );
    const fn = defaults.mutationFn as (v: unknown) => Promise<unknown>;

    await expect(
      fn({
        auth: { ...currentAuthScope, tenantId: "tenant_2" },
        operationId,
        id: "c2",
        subject: "Blocked",
      }),
    ).rejects.toThrow(/different user, role, or workspace/i);
    expect(request).not.toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/campaigns/c2",
      expect.anything(),
    );
  });

  it("throws wrapper errors so failed sequence replays are not dropped", async () => {
    updateSequence.mockResolvedValueOnce({
      data: null,
      error: { status: 500, message: "boom" },
    } as unknown as Awaited<ReturnType<typeof updateSequence>>);
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);

    const defaults = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.sequenceSave);
    const fn = defaults.mutationFn as (v: unknown) => Promise<unknown>;

    await expect(
      fn({
        auth: currentAuthScope,
        operationId,
        id: "seq1",
        baseVersion: 9,
        steps: [],
      }),
    ).rejects.toThrow("boom");
  });

  it("expires queued content instead of replaying it indefinitely", async () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    const defaults = qc.getMutationDefaults(
      OFFLINE_MUTATION_KEYS.campaignUpdate,
    );
    const fn = defaults.mutationFn as (v: unknown) => Promise<unknown>;

    await expect(
      fn({
        auth: {
          ...currentAuthScope,
          queuedAt: Date.now() - 3 * 60 * 60 * 1000,
          expiresAt: Date.now() - 60_000,
        },
        operationId,
        id: "c-expired",
        subject: "Expired",
      }),
    ).rejects.toThrow(/expired/i);
    expect(request).not.toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/campaigns/c-expired",
      expect.anything(),
    );
  });
});

describe("generic entity-write registration (NATIVE#1)", () => {
  it("registerOfflineMutationDefaults also arms the generic queue", async () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);

    // The three bespoke keys are no longer the whole queue: any allowlisted
    // route shape now has a resumable mutationFn after a process restart.
    const defaults = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.entityWrite);
    expect(typeof defaults.mutationFn).toBe("function");

    const now = Date.now();
    await (defaults.mutationFn as (v: unknown) => Promise<unknown>)({
      auth: {
        baseUrl: "https://api.moosewave.com",
        tenantId: "tenant_1",
        principalId: "user_1",
        role: "editor",
        queuedAt: now,
        expiresAt: now + 60 * 60 * 1000,
      },
      operationId: "00000000-0000-4000-8000-000000000001",
      method: "PATCH",
      path: "/api/v1/segments/12",
      body: { name: "Renamed" },
    });
    expect(request).toHaveBeenCalledWith("PATCH", "/api/v1/segments/12", {
      body: { name: "Renamed" },
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    });
  });
});
