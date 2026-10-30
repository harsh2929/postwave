/**
 * The referral reads and admin writes, run through their real hook bodies.
 *
 * TESTS-6. The screen suites load this module but jest's react-query stub
 * never calls a `mutationFn` or a `queryFn`, and no vitest file imported it.
 * So a payout advance that refreshed a `"payout"` key (matching nothing), or a
 * programme save that went out while offline, shipped green.
 *
 * WHAT IS REAL. lib/referralAdmin (the payout PATCH's exact path and body),
 * lib/referrals (the parsers and the runtime gate) and lib/mobileRouteManifest
 * (the admin floor) are real. Only the SDK client's `request`, the auth store
 * and the online gate are stand-ins.
 *
 * The invalidation keys are READ OFF THE REAL READ HOOKS (useReferralPayouts,
 * useReferralProgram), never retyped here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryOptions = {
  queryKey: readonly unknown[];
  enabled: boolean;
  retry?: (failureCount: number, error: unknown) => boolean;
  queryFn: () => Promise<unknown>;
};

type MutationOptions = {
  mutationFn: (input: unknown) => Promise<unknown>;
  onSuccess?: (data?: unknown, variables?: unknown) => void;
};

const m = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "11111111-1111-4111-8111-111111111111" as string | null,
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "admin" as string | null,
    credentialScope: "session",
    canReadOfflineSnapshots: false,
  },
  mode: "session" as "session" | "api_key" | null,
  online: true,
  queries: [] as QueryOptions[],
  mutations: [] as MutationOptions[],
  invalidateQueries: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    m.queries.push(options);
    return options;
  },
  useMutation: (options: MutationOptions) => {
    m.mutations.push(options);
    return { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() };
  },
  useQueryClient: () => ({ invalidateQueries: m.invalidateQueries }),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => m.gate,
}));

vi.mock("@/lib/connectivity", () => ({
  isProbablyOnline: () => m.online,
}));

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ client: { request: m.request } }),
}));

vi.mock("@/store/auth", () => ({
  useAuthStore: <T>(select: (state: { mode: typeof m.mode }) => T): T =>
    select({ mode: m.mode }),
}));

// eslint-disable-next-line import/first
import { REFERRAL_RUNTIME_AVAILABLE } from "@/lib/referrals";

// eslint-disable-next-line import/first
import {
  ReferralsOfflineError,
  useAdvanceReferralPayout,
  useCanMintSubscriberReferral,
  useReferralLeaderboard,
  useReferralPayouts,
  useReferralProgram,
  useReferralStats,
  useReferralVariants,
  useSetReferralProgram,
  useSubscriberReferral,
} from "./useReferrals";

/** Run a mutation hook's body and hand back the options it registered. */
function mutationOf(hook: () => unknown): MutationOptions {
  m.mutations.length = 0;
  hook();
  const [registered] = m.mutations;
  if (!registered) throw new Error("the hook registered no mutation");
  return registered;
}

/** The query a REAL read hook registers — its key is what a write refreshes. */
function queryOf(hook: () => unknown): QueryOptions {
  m.queries.length = 0;
  hook();
  const [registered] = m.queries;
  if (!registered) throw new Error("the hook registered no query");
  return registered;
}

function invalidatedKeys(): unknown[] {
  return m.invalidateQueries.mock.calls.map(
    (call) => (call[0] as { queryKey: unknown }).queryKey,
  );
}

const PROGRAM_BODY = {
  milestones: [{ count: 3, reward_label: "Free month" }],
  referee_reward_kind: "discount",
  referee_reward_label: "10% off",
  referee_reward_image_asset_id: "",
  reward_value_cents: 0,
  reward_currency: "",
  reward_sku: "",
  verification_window_days: 14,
  expected_program_id: "prog_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.queries.length = 0;
  m.mutations.length = 0;
  m.online = true;
  m.mode = "session";
  m.gate.enabled = true;
  m.gate.tenantId = "11111111-1111-4111-8111-111111111111";
  m.gate.effectiveRole = "admin";
});

describe("useAdvanceReferralPayout", () => {
  it.each(["approved", "paid"] as const)(
    "PATCHes the encoded payout id to %s and nothing else",
    async (status) => {
      m.request.mockResolvedValue({ id: "p/1", status });
      const options = mutationOf(useAdvanceReferralPayout);

      await expect(options.mutationFn({ id: "p/1", status })).resolves.toEqual({
        id: "p/1",
        status,
      });
      expect(m.request.mock.calls).toEqual([
        ["PATCH", "/api/v1/referrals/payouts/p%2F1", { body: { status } }],
      ]);
    },
  );

  it("refreshes the payout ledger the screen reads, not the programme", () => {
    const payoutsKey = queryOf(useReferralPayouts).queryKey;
    const programKey = queryOf(useReferralProgram).queryKey;
    const options = mutationOf(useAdvanceReferralPayout);

    options.onSuccess?.(undefined, { id: "p1", status: "paid" });
    expect(invalidatedKeys()).toEqual([payoutsKey]);
    expect(invalidatedKeys()).not.toContainEqual(programKey);
  });
});

describe("useSetReferralProgram", () => {
  it("POSTs the full-replace body verbatim", async () => {
    m.request.mockResolvedValue({ id: "prog_1" });
    const options = mutationOf(useSetReferralProgram);

    await expect(options.mutationFn(PROGRAM_BODY)).resolves.toEqual({
      id: "prog_1",
    });
    expect(m.request.mock.calls).toEqual([
      ["POST", "/api/v1/referral-programs", { body: PROGRAM_BODY }],
    ]);
  });

  it("refreshes the programme the card reads, not the payouts", () => {
    const programKey = queryOf(useReferralProgram).queryKey;
    const payoutsKey = queryOf(useReferralPayouts).queryKey;
    const options = mutationOf(useSetReferralProgram);

    options.onSuccess?.(undefined, PROGRAM_BODY);
    expect(invalidatedKeys()).toEqual([programKey]);
    expect(invalidatedKeys()).not.toContainEqual(payoutsKey);
  });
});

describe("offline, both admin writes refuse at the tap", () => {
  it.each([
    {
      verb: "payout advance",
      hook: useAdvanceReferralPayout,
      input: { id: "p1", status: "approved" },
      action: "Advancing a payout",
    },
    {
      verb: "programme save",
      hook: useSetReferralProgram,
      input: PROGRAM_BODY,
      action: "Saving the programme",
    },
  ])(
    "$verb rejects offline_write_refused and sends nothing",
    async ({ hook, input, action }) => {
      m.online = false;
      const options = mutationOf(hook);

      const refusal = options.mutationFn(input);
      await expect(refusal).rejects.toBeInstanceOf(ReferralsOfflineError);
      await expect(refusal).rejects.toMatchObject({
        code: "offline_write_refused",
        message: `${action} needs a connection. Reconnect and try again.`,
      });
      expect(m.request).not.toHaveBeenCalled();
    },
  );
});

describe("the referral reads", () => {
  it("reads the stats once and derives the funnel and the top-referrer rows from it", async () => {
    m.request.mockResolvedValue({
      funnel: {
        conversions_7d: 3,
        conversions_30d: 10,
        conversions_90d: 20,
        clicks_total: 140,
        fraud_filtered_count: 1,
      },
      top_referrers: [
        { subscriber_id: "s1", count: 4, last_at: "2026-09-01T00:00:00Z" },
      ],
    });
    const stats = queryOf(useReferralStats);

    expect(stats.enabled).toBe(true);
    await expect(stats.queryFn()).resolves.toEqual({
      funnel: {
        conversions7d: 3,
        conversions30d: 10,
        conversions90d: 20,
        clicksTotal: 140,
        fraudFilteredCount: 1,
      },
      topReferrerCount: 1,
      topReferrers: [
        { subscriberId: "s1", count: 4, lastAt: "2026-09-01T00:00:00Z" },
      ],
    });
    expect(m.request.mock.calls).toEqual([["GET", "/api/v1/referrals/stats"]]);
  });

  it("encodes the leaderboard window and stays idle without one", async () => {
    m.request.mockResolvedValue({ window_days: 90, items: [] });
    const board = queryOf(() => useReferralLeaderboard("90 d&x"));

    expect(board.enabled).toBe(true);
    await expect(board.queryFn()).resolves.toEqual({
      windowDays: 90,
      rows: [],
    });
    expect(m.request.mock.calls).toEqual([
      ["GET", "/api/v1/referrals/leaderboard?window=90%20d%26x&limit=20"],
    ]);
    expect(queryOf(() => useReferralLeaderboard("")).enabled).toBe(false);
  });

  it("answers a 404 programme read as 'nothing configured', without retrying it", async () => {
    const program = queryOf(useReferralProgram);

    m.request.mockRejectedValueOnce({ status: 404 });
    await expect(program.queryFn()).resolves.toBeNull();
    expect(m.request.mock.calls).toEqual([
      ["GET", "/api/v1/referral-programs/current"],
    ]);

    const outage = { status: 503 };
    m.request.mockRejectedValueOnce(outage);
    await expect(program.queryFn()).rejects.toBe(outage);

    m.request.mockResolvedValueOnce({ id: "prog_1", active: true });
    await expect(program.queryFn()).resolves.toMatchObject({
      id: "prog_1",
      active: true,
    });

    expect(program.retry?.(0, { status: 404 })).toBe(false);
    expect(program.retry?.(1, { status: 503 })).toBe(true);
    expect(program.retry?.(2, { status: 503 })).toBe(false);
  });

  it("fires the runtime-gated payout and variant reads only when the server mounts them", async () => {
    const payouts = queryOf(useReferralPayouts);
    const variants = queryOf(useReferralVariants);
    expect(payouts.enabled).toBe(REFERRAL_RUNTIME_AVAILABLE);
    expect(variants.enabled).toBe(REFERRAL_RUNTIME_AVAILABLE);

    m.gate.enabled = false;
    expect(queryOf(useReferralPayouts).enabled).toBe(false);
    expect(queryOf(useReferralVariants).enabled).toBe(false);

    m.request.mockResolvedValueOnce({
      items: [{ id: "p1", status: "pending", reward_label: "Free month" }],
      total: 7,
    });
    await expect(payouts.queryFn()).resolves.toMatchObject({
      rows: [{ id: "p1", status: "pending", rewardLabel: "Free month" }],
      total: 7,
    });
    m.request.mockResolvedValueOnce({
      items: [{ id: "v1", variant_key: "A", allocation_pct: 50 }],
    });
    await expect(variants.queryFn()).resolves.toMatchObject([
      { id: "v1", key: "A", allocationPct: 50 },
    ]);
    expect(m.request.mock.calls).toEqual([
      ["GET", "/api/v1/referrals/payouts?limit=50"],
      ["GET", "/api/v1/referrals/variants"],
    ]);
  });

  it("asks for a referrer's link at the encoded subscriber path, and never with no subscriber", async () => {
    m.request.mockResolvedValue({
      ref_code: "ABC",
      share_url: "https://r.example/ABC",
    });
    const link = queryOf(() => useSubscriberReferral("s/1"));

    await expect(link.queryFn()).resolves.toMatchObject({
      refCode: "ABC",
      shareUrl: "https://r.example/ABC",
    });
    expect(m.request.mock.calls).toEqual([
      ["GET", "/api/v1/subscribers/s%2F1/referral"],
    ]);
    expect(queryOf(() => useSubscriberReferral(null)).enabled).toBe(false);
  });
});

describe("useCanMintSubscriberReferral", () => {
  it.each([
    ["session", "admin", true],
    ["session", "owner", true],
    ["session", "editor", false],
    ["session", null, false],
    ["api_key", "admin", false],
  ] as const)(
    "a %s principal with role %s may mint: %s",
    (mode, role, expected) => {
      m.mode = mode;
      m.gate.effectiveRole = role;
      expect(useCanMintSubscriberReferral()).toBe(expected);
    },
  );
});
