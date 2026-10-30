/**
 * The governance write verbs, run through their real transport seam.
 *
 * TESTS-2. None of these hooks had a test on any runner: jest's react-query
 * stub never calls a `mutationFn`, and no vitest file imported this module or
 * the api/ops.ts transports under it. The exposure that made that matter:
 * `useRevokeScimToken` without `checkedApiResult` RESOLVES on a refused revoke,
 * and scim.tsx then toasts "Revoked …" while the bearer is still live.
 *
 * WHAT IS REAL. api/ops.ts and api/request.ts (`checkedApiResult`, `sdkResult`,
 * `rawRequest`) are real, so the envelope-to-rejection path is the one under
 * test. Only the SDK client underneath them is a stand-in; vitest mocks by
 * resolved id, so this one mock also replaces the relative `./sdkClient`
 * imports inside ops.ts and request.ts. api/auditSinks.ts is mocked because
 * its wire shape is already pinned by src/api/auditSinks.test.ts.
 *
 * The invalidation keys are READ OFF THE REAL READ HOOKS (useScimOps,
 * useAuditSinkOps, useMigrations), never retyped here: an assertion against a
 * copied literal would pass on exactly the drift it exists to catch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = {
  mutationFn: (input: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, variables: unknown) => void;
};

type QueryOptions = { queryKey: readonly unknown[] };

const m = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "admin",
    credentialScope: "session",
    canReadOfflineSnapshots: false,
  },
  mutation: undefined as MutationOptions | undefined,
  query: undefined as QueryOptions | undefined,
  invalidateQueries: vi.fn(),
  revokeToken: vi.fn(),
  circuitReset: vi.fn(),
  dlqReplay: vi.fn(),
  testExisting: vi.fn(),
  request: vi.fn(),
  setAuditSinkEnabled: vi.fn(),
  deleteAuditSink: vi.fn(),
  startAuditSinkReplay: vi.fn(),
  cancelAuditSinkReplayJob: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: MutationOptions) => {
    m.mutation = options;
    return { isPending: false, mutateAsync: vi.fn() };
  },
  useQuery: (options: QueryOptions) => {
    m.query = options;
    return options;
  },
  useQueryClient: () => ({ invalidateQueries: m.invalidateQueries }),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => m.gate,
  onlineQueryAuthorityOwner: (gate: typeof m.gate) =>
    JSON.stringify([
      gate.baseUrl,
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      gate.credentialScope,
    ]),
  canRunOnlineOrSnapshotQuery: (gate: typeof m.gate) =>
    gate.enabled || gate.canReadOfflineSnapshots,
}));

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({
    client: {
      scim: { revokeToken: m.revokeToken },
      auditSinks: {
        circuitReset: m.circuitReset,
        dlqReplay: m.dlqReplay,
        testExisting: m.testExisting,
      },
      request: m.request,
    },
  }),
}));

vi.mock("@/api/auditSinks", () => ({
  setAuditSinkEnabled: m.setAuditSinkEnabled,
  deleteAuditSink: m.deleteAuditSink,
  startAuditSinkReplay: m.startAuditSinkReplay,
  cancelAuditSinkReplayJob: m.cancelAuditSinkReplayJob,
  fetchAuditSinkReplayJobs: vi.fn(),
}));

// eslint-disable-next-line import/first
import {
  useMobileAuditSinkDlq,
  useMobileAuditSinks,
  useSinkReplayJobs,
} from "./useAuditSinkOps";
// eslint-disable-next-line import/first
import {
  useCancelMigration,
  useCancelSinkReplay,
  useDeleteSink,
  useReplayDlqEntry,
  useResetSinkCircuit,
  useRevokeScimToken,
  useSetSinkEnabled,
  useStartSinkReplay,
  useTestSink,
} from "./useGovernanceOps";
// eslint-disable-next-line import/first
import { useMobileMigrations } from "./useMigrations";
// eslint-disable-next-line import/first
import { useMobileScimTokens } from "./useScimOps";

/** Render a mutation hook's body and hand back the options it registered. */
function mutationOf(hook: () => unknown): MutationOptions {
  m.mutation = undefined;
  hook();
  // Re-read after the call: TS keeps the `undefined` narrowing across it.
  const registered = m.mutation as MutationOptions | undefined;
  if (!registered) throw new Error("the hook registered no mutation");
  return registered;
}

/** The query key a REAL read hook registers — the one a write must refresh. */
function readKeyOf(hook: () => unknown): readonly unknown[] {
  m.query = undefined;
  hook();
  const registered = m.query as QueryOptions | undefined;
  if (!registered) throw new Error("the hook registered no query");
  return registered.queryKey;
}

/** How the SDK fails: a thrown error carrying the server status and code. */
function sdkFailure(status: number, code: string) {
  return Object.assign(new Error(code), { status, code });
}

function invalidatedKeys(): unknown[] {
  return m.invalidateQueries.mock.calls.map(
    (call) => (call[0] as { queryKey: unknown }).queryKey,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.mutation = undefined;
  m.query = undefined;
});

describe("useRevokeScimToken", () => {
  it("revokes the named token and refreshes the token list", async () => {
    m.revokeToken.mockResolvedValue({ revoked: true });
    const options = mutationOf(useRevokeScimToken);

    await expect(options.mutationFn("tok_1")).resolves.toEqual({
      data: { revoked: true },
      error: null,
    });
    expect(m.revokeToken).toHaveBeenCalledWith("tok_1");

    options.onSuccess?.(undefined, "tok_1");
    expect(invalidatedKeys()).toEqual([readKeyOf(useMobileScimTokens)]);
  });

  it("REJECTS a refused revoke, so the screen cannot report it as done", async () => {
    m.revokeToken.mockRejectedValue(sdkFailure(403, "not_authorized"));
    const options = mutationOf(useRevokeScimToken);

    await expect(options.mutationFn("tok_1")).rejects.toMatchObject({
      status: 403,
      code: "not_authorized",
    });
  });
});

describe("useResetSinkCircuit", () => {
  it("resets the breaker (never probes it) and refreshes sinks and the DLQ", async () => {
    m.circuitReset.mockResolvedValue({ reset: true });
    const options = mutationOf(useResetSinkCircuit);

    await options.mutationFn("sink_1");
    expect(m.circuitReset).toHaveBeenCalledWith("sink_1");
    expect(m.testExisting).not.toHaveBeenCalled();

    options.onSuccess?.(undefined, "sink_1");
    expect(invalidatedKeys()).toEqual([
      readKeyOf(useMobileAuditSinks),
      readKeyOf(useMobileAuditSinkDlq),
    ]);
  });

  it("rejects a 409 with its status attached", async () => {
    m.circuitReset.mockRejectedValue(sdkFailure(409, "circuit_closed"));
    const options = mutationOf(useResetSinkCircuit);

    await expect(options.mutationFn("sink_1")).rejects.toMatchObject({
      status: 409,
      code: "circuit_closed",
    });
  });
});

describe("useTestSink", () => {
  it("probes the named sink and refreshes the sink list", async () => {
    m.testExisting.mockResolvedValue({
      delivered: true,
      kind: "http",
      action: "audit.sink.test",
    });
    const options = mutationOf(useTestSink);

    await options.mutationFn("sink_2");
    expect(m.testExisting).toHaveBeenCalledWith("sink_2");
    expect(m.circuitReset).not.toHaveBeenCalled();

    options.onSuccess?.(undefined, "sink_2");
    expect(invalidatedKeys()).toEqual([readKeyOf(useMobileAuditSinks)]);
  });

  it("rejects a failed probe", async () => {
    m.testExisting.mockRejectedValue(sdkFailure(502, "sink_unreachable"));
    const options = mutationOf(useTestSink);

    await expect(options.mutationFn("sink_2")).rejects.toMatchObject({
      status: 502,
      code: "sink_unreachable",
    });
  });
});

describe("useReplayDlqEntry", () => {
  it("coerces a string id to the integer the SDK takes", async () => {
    m.dlqReplay.mockResolvedValue({ replayed: true, rows: 3 });
    const options = mutationOf(useReplayDlqEntry);

    await options.mutationFn(" 42 ");
    await options.mutationFn(7);
    expect(m.dlqReplay.mock.calls).toEqual([[42], [7]]);

    options.onSuccess?.(undefined, 42);
    expect(invalidatedKeys()).toEqual([
      readKeyOf(useMobileAuditSinkDlq),
      readKeyOf(useMobileAuditSinks),
    ]);
  });

  it.each(["4.5", "12abc"])(
    "refuses %j locally instead of pasting it into a URL",
    async (id) => {
      const options = mutationOf(useReplayDlqEntry);

      await expect(options.mutationFn(id)).rejects.toThrow(
        "Invalid dead-letter entry id.",
      );
      expect(m.dlqReplay).not.toHaveBeenCalled();
    },
  );

  it("rejects a 409 already-replayed entry", async () => {
    m.dlqReplay.mockRejectedValue(sdkFailure(409, "already_replayed"));
    const options = mutationOf(useReplayDlqEntry);

    await expect(options.mutationFn(42)).rejects.toMatchObject({
      status: 409,
      code: "already_replayed",
    });
  });
});

describe("useCancelMigration", () => {
  it("DELETEs the id-encoded job path and refreshes the job list", async () => {
    m.request.mockResolvedValue({ cancelled: true });
    const options = mutationOf(useCancelMigration);

    await options.mutationFn("job/1");
    expect(m.request).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/migrations/job%2F1",
      {},
    );

    options.onSuccess?.(undefined, "job/1");
    expect(invalidatedKeys()).toEqual([readKeyOf(useMobileMigrations)]);
  });

  it("rejects a 409 for a job that already finished", async () => {
    m.request.mockRejectedValue(sdkFailure(409, "job_not_running"));
    const options = mutationOf(useCancelMigration);

    await expect(options.mutationFn("job_1")).rejects.toMatchObject({
      status: 409,
      code: "job_not_running",
    });
  });
});

describe("audit-sink admin verbs", () => {
  it("disables a sink with exactly (id, enabled) and refreshes the sink list", async () => {
    m.setAuditSinkEnabled.mockResolvedValue(undefined);
    const options = mutationOf(useSetSinkEnabled);

    await options.mutationFn({ id: "sink_1", enabled: false });
    expect(m.setAuditSinkEnabled).toHaveBeenCalledWith("sink_1", false);

    options.onSuccess?.(undefined, { id: "sink_1", enabled: false });
    expect(invalidatedKeys()).toEqual([readKeyOf(useMobileAuditSinks)]);
  });

  it("deletes a sink and refreshes both the sinks and the orphaned DLQ", async () => {
    m.deleteAuditSink.mockResolvedValue(undefined);
    const options = mutationOf(useDeleteSink);

    await options.mutationFn("sink_1");
    expect(m.deleteAuditSink).toHaveBeenCalledWith("sink_1");

    options.onSuccess?.(undefined, "sink_1");
    expect(invalidatedKeys()).toEqual([
      readKeyOf(useMobileAuditSinks),
      readKeyOf(useMobileAuditSinkDlq),
    ]);
  });

  it("starts a range replay and refreshes that sink's replay jobs", async () => {
    m.startAuditSinkReplay.mockResolvedValue({ id: "job_1" });
    const options = mutationOf(useStartSinkReplay);
    const range = { fromId: 10, toId: 20 };

    await options.mutationFn({ id: "sink_1", range });
    expect(m.startAuditSinkReplay).toHaveBeenCalledWith("sink_1", range);

    options.onSuccess?.({ id: "job_1" }, { id: "sink_1", range });
    expect(invalidatedKeys()).toEqual([
      readKeyOf(() => useSinkReplayJobs("sink_1")),
    ]);
  });

  it("cancels a replay job and refreshes that sink's replay jobs", async () => {
    m.cancelAuditSinkReplayJob.mockResolvedValue(undefined);
    const options = mutationOf(useCancelSinkReplay);

    await options.mutationFn({ id: "sink_1", jobId: "job_1" });
    expect(m.cancelAuditSinkReplayJob).toHaveBeenCalledWith("sink_1", "job_1");

    options.onSuccess?.(undefined, { id: "sink_1", jobId: "job_1" });
    expect(invalidatedKeys()).toEqual([
      readKeyOf(() => useSinkReplayJobs("sink_1")),
    ]);
  });
});
