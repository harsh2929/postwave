/**
 * The Campaign Assurance verbs a phone performs, run through their real hook
 * bodies.
 *
 * TESTS-6. No runner executed these: jest maps CampaignAssuranceCard to null
 * and its react-query stub never calls a `mutationFn`, and no vitest file
 * imported this module. So `request_id = campaignId`, swapped `cancelRun`
 * arguments, an invalidation predicate that ignored the campaign, or a card
 * whose Cancel button STARTED a second run all shipped green.
 *
 * WHAT IS REAL. lib/campaignAssuranceGate (which control the card offers),
 * lib/mobileRouteManifest (the editor floor) and lib/campaignErrors (the toast
 * copy) are real. The transports under the hooks are stand-ins, and so is
 * `newOfflineOperationId`, which hands out a counter so two starts are
 * distinguishable. React's `useCallback` is a passthrough so the controls hook
 * can be called outside a render; the callback it wraps is what is driven.
 *
 * The invalidation predicate is checked against the keys the REAL read hooks
 * register (useCampaignAssurance, useCampaignAssuranceStatus), never against a
 * retyped literal.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type QueryOptions = { queryKey: readonly unknown[] };

type MutationOptions = {
  mutationFn: (input?: unknown) => Promise<unknown>;
  onSuccess?: () => void;
};

type MutationCallbacks = {
  onSuccess: () => void;
  onError: (err: unknown) => void;
};

type Registered = {
  options: MutationOptions;
  result: { isPending: boolean; mutate: Mock };
};

type InvalidateFilter = {
  predicate: (query: { queryKey: readonly unknown[] }) => boolean;
};

const m = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "editor" as string | null,
    credentialScope: "session",
    canReadOfflineSnapshots: false,
  },
  queries: [] as QueryOptions[],
  mutations: [] as Registered[],
  /** isPending for the Nth useMutation call of one render, by index. */
  pending: [] as boolean[],
  operationIds: 0,
  invalidateQueries: vi.fn(),
  createRun: vi.fn(),
  cancelRun: vi.fn(),
  recordOverride: vi.fn(),
  tap: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCallback: <T>(callback: T): T => callback,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    m.queries.push(options);
    return options;
  },
  useMutation: (options: MutationOptions) => {
    const result = {
      isPending: m.pending[m.mutations.length] ?? false,
      mutate: vi.fn(),
    };
    m.mutations.push({ options, result });
    return result;
  },
  useQueryClient: () => ({ invalidateQueries: m.invalidateQueries }),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => m.gate,
}));

// @/api/request (under every api module) otherwise reaches react-native.
vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ client: { request: vi.fn() } }),
}));

vi.mock("@/api/client", () => ({
  getClient: () => ({
    client: {
      campaignAssurance: { createRun: m.createRun, cancelRun: m.cancelRun },
    },
  }),
}));

vi.mock("@/api/campaignAssuranceOverride", () => ({
  recordCampaignAssuranceOverride: m.recordOverride,
}));

vi.mock("@/lib/offlineMutations", () => ({
  newOfflineOperationId: () => {
    m.operationIds += 1;
    return `op-${m.operationIds}`;
  },
}));

vi.mock("@/lib/haptics", () => ({
  haptics: {
    tap: m.tap,
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    impact: vi.fn(),
  },
}));

// eslint-disable-next-line import/first
import { MOBILE_ASSURANCE_RUN_PROFILE } from "@/lib/campaignAssuranceGate";

// eslint-disable-next-line import/first
import {
  useCampaignAssurance,
  useCampaignAssuranceStatus,
} from "./useCampaignAssurance";
// eslint-disable-next-line import/first
import {
  useAssuranceRunControls,
  useCancelAssuranceRun,
  useOverrideAssuranceFinding,
  useStartAssuranceRun,
} from "./useCampaignAssuranceActions";

/** Run a mutation hook's body and hand back the options it registered. */
function mutationOf(hook: () => unknown): MutationOptions {
  m.mutations.length = 0;
  hook();
  const [registered] = m.mutations;
  if (!registered) throw new Error("the hook registered no mutation");
  return registered.options;
}

/** The key a REAL read hook registers — the one a write must refresh. */
function readKeyOf(hook: () => unknown): readonly unknown[] {
  m.queries.length = 0;
  hook();
  const [registered] = m.queries;
  if (!registered) throw new Error("the hook registered no query");
  return registered.queryKey;
}

/** The single invalidation filter a success registered. */
function invalidationFilter(): InvalidateFilter {
  expect(m.invalidateQueries).toHaveBeenCalledTimes(1);
  return m.invalidateQueries.mock.calls[0]?.[0] as InvalidateFilter;
}

/** The mutation callbacks a press handed to `mutate`. */
function callbacksOf(mutate: Mock): MutationCallbacks {
  return mutate.mock.calls[0]?.[1] as MutationCallbacks;
}

const RUN_CONTROLS = {
  campaignId: "c1",
  effectiveRole: "editor",
  runId: "r1",
  runState: "running",
  hasReceipt: true,
} as const;

type RunControlsInput = Parameters<typeof useAssuranceRunControls>[0];

/**
 * Call the card's action surface; start and cancel in registration order.
 * Named as a hook because it is one: it calls useAssuranceRunControls.
 */
function useRunControlsUnderTest(overrides: Partial<RunControlsInput> = {}) {
  m.mutations.length = 0;
  const controls = useAssuranceRunControls({
    ...RUN_CONTROLS,
    toast: m.toast,
    ...overrides,
  });
  const [start, cancel] = m.mutations;
  if (!start || !cancel) throw new Error("expected start and cancel");
  return { controls, start: start.result, cancel: cancel.result };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.queries.length = 0;
  m.mutations.length = 0;
  m.pending = [];
  m.operationIds = 0;
  m.gate.effectiveRole = "editor";
  m.createRun.mockResolvedValue({ data: { id: "r9" } });
  m.cancelRun.mockResolvedValue({ data: { id: "r1" } });
  m.recordOverride.mockResolvedValue(undefined);
});

describe("useStartAssuranceRun", () => {
  it("starts a phone-profile run with a fresh request_id per start, never the campaign id", async () => {
    const options = mutationOf(() => useStartAssuranceRun("c1"));

    await options.mutationFn();
    await options.mutationFn();
    expect(m.createRun.mock.calls).toEqual([
      ["c1", { profile: MOBILE_ASSURANCE_RUN_PROFILE, request_id: "op-1" }],
      ["c1", { profile: MOBILE_ASSURANCE_RUN_PROFILE, request_id: "op-2" }],
    ]);
    const ids = m.createRun.mock.calls.map(
      (call) => (call[1] as { request_id: string }).request_id,
    );
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("c1");
  });
});

describe("useCancelAssuranceRun", () => {
  it("cancels (campaignId, runId) in that order", async () => {
    const options = mutationOf(() => useCancelAssuranceRun("c1"));

    await options.mutationFn("r1");
    expect(m.cancelRun.mock.calls).toEqual([["c1", "r1"]]);
  });
});

describe("useOverrideAssuranceFinding", () => {
  it("records the receipt for this campaign with the caller's whole input", async () => {
    const options = mutationOf(() => useOverrideAssuranceFinding("c1"));
    const input = {
      runId: "r1",
      findingId: "f1",
      decision: "allow_send",
      reason: "Legal approved the claim.",
    };

    await options.mutationFn(input);
    expect(m.recordOverride.mock.calls).toEqual([
      [{ campaignId: "c1", ...input }],
    ]);
  });
});

const VERBS = [
  { verb: "start", hook: useStartAssuranceRun, input: undefined },
  { verb: "cancel", hook: useCancelAssuranceRun, input: "r1" },
  {
    verb: "override",
    hook: useOverrideAssuranceFinding,
    input: {
      runId: "r1",
      findingId: "f1",
      decision: "reject",
      reason: "Not cleared.",
    },
  },
];

describe("without a campaign there is no request", () => {
  it.each(VERBS)(
    "$verb rejects before any transport is called",
    async ({ hook, input }) => {
      const options = mutationOf(() => hook(undefined));

      await expect(options.mutationFn(input)).rejects.toThrow("no campaign");
      expect(m.createRun).not.toHaveBeenCalled();
      expect(m.cancelRun).not.toHaveBeenCalled();
      expect(m.recordOverride).not.toHaveBeenCalled();
    },
  );
});

describe("a success refreshes this campaign's assurance reads, and only those", () => {
  it.each(VERBS)(
    "$verb matches c1's latest and status reads under any role, never c2's or the campaign row",
    ({ hook }) => {
      const latest = readKeyOf(() => useCampaignAssurance("c1"));
      const status = readKeyOf(() => useCampaignAssuranceStatus("c1"));
      const otherCampaign = readKeyOf(() => useCampaignAssurance("c2"));
      m.gate.effectiveRole = "owner";
      const afterRoleChange = readKeyOf(() => useCampaignAssurance("c1"));
      m.gate.effectiveRole = "editor";

      mutationOf(() => hook("c1")).onSuccess?.();
      const { predicate } = invalidationFilter();

      expect(predicate({ queryKey: latest })).toBe(true);
      expect(predicate({ queryKey: status })).toBe(true);
      expect(predicate({ queryKey: afterRoleChange })).toBe(true);
      expect(predicate({ queryKey: otherCampaign })).toBe(false);
      expect(
        predicate({ queryKey: ["campaigns", m.gate.tenantId, "c1"] }),
      ).toBe(false);
    },
  );
});

describe("useAssuranceRunControls", () => {
  it("registers the start mutation first and the cancel mutation second", async () => {
    const { start, cancel } = useRunControlsUnderTest();
    const [startOptions, cancelOptions] = m.mutations.map((r) => r.options);

    expect(start).toBe(m.mutations[0]?.result);
    expect(cancel).toBe(m.mutations[1]?.result);
    await startOptions?.mutationFn();
    await cancelOptions?.mutationFn("r1");
    expect(m.createRun).toHaveBeenCalledTimes(1);
    expect(m.cancelRun.mock.calls).toEqual([["c1", "r1"]]);
  });

  it("offers Cancel on a running run, and pressing it cancels that run without starting another", () => {
    const { controls, start, cancel } = useRunControlsUnderTest();

    expect(controls.control).toBe("cancel");
    controls.press();

    expect(m.tap).toHaveBeenCalledTimes(1);
    expect(start.mutate).not.toHaveBeenCalled();
    expect(cancel.mutate).toHaveBeenCalledTimes(1);
    expect(cancel.mutate).toHaveBeenCalledWith("r1", {
      onSuccess: expect.any(Function),
      onError: expect.any(Function),
    });

    const callbacks = callbacksOf(cancel.mutate);
    callbacks.onSuccess();
    expect(m.toast).toHaveBeenLastCalledWith({
      kind: "success",
      message: "Run cancelled.",
    });
    callbacks.onError({ status: 422 });
    expect(m.toast).toHaveBeenLastCalledWith({
      kind: "error",
      message:
        "Couldn't cancel the run. The campaign isn't in a state that allows it.",
    });
  });

  it("does nothing when Cancel is offered but no run id is known", () => {
    const { controls, start, cancel } = useRunControlsUnderTest({
      runId: undefined,
    });

    expect(controls.control).toBe("cancel");
    controls.press();
    expect(cancel.mutate).not.toHaveBeenCalled();
    expect(start.mutate).not.toHaveBeenCalled();
  });

  it("offers Start with no receipt, and pressing it starts a run", () => {
    const { controls, start, cancel } = useRunControlsUnderTest({
      runId: undefined,
      runState: undefined,
      hasReceipt: false,
    });

    expect(controls.control).toBe("start");
    controls.press();

    expect(cancel.mutate).not.toHaveBeenCalled();
    expect(start.mutate).toHaveBeenCalledTimes(1);
    expect(start.mutate).toHaveBeenCalledWith(undefined, {
      onSuccess: expect.any(Function),
      onError: expect.any(Function),
    });

    const callbacks = callbacksOf(start.mutate);
    callbacks.onSuccess();
    expect(m.toast).toHaveBeenLastCalledWith({
      kind: "success",
      message: "Campaign Assurance started.",
    });
    callbacks.onError({ status: 422 });
    expect(m.toast).toHaveBeenLastCalledWith({
      kind: "error",
      message:
        "Couldn't start Campaign Assurance. The campaign isn't in a state that allows it.",
    });
  });

  it("offers a re-run on a finished run through the start path", () => {
    const { controls, start, cancel } = useRunControlsUnderTest({
      runState: "complete",
    });

    expect(controls.control).toBe("rerun");
    controls.press();
    expect(start.mutate).toHaveBeenCalledTimes(1);
    expect(cancel.mutate).not.toHaveBeenCalled();
  });

  it.each(["viewer", null])(
    "offers a %s no control at all",
    (effectiveRole) => {
      expect(useRunControlsUnderTest({ effectiveRole }).controls.control).toBe(
        "none",
      );
    },
  );

  it.each([
    [[false, false], false],
    [[true, false], true],
    [[false, true], true],
  ] as const)("reports pending %j as %s", (pending, expected) => {
    m.pending = [...pending];
    expect(useRunControlsUnderTest().controls.pending).toBe(expected);
  });
});
