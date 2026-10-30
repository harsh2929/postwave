/**
 * The landing-page write verbs, run through their real hook bodies.
 *
 * TESTS-6. Nothing executed these `mutationFn`s on either runner: jest's
 * react-query stub records the options and hands back a `jest.fn` mutate, and
 * no vitest file imported this module. api/landingPages.test.ts pins the wire
 * shape one layer down, so what was unguarded is the HOOK layer — which
 * arguments reach the transport, the offline refusal in front of it, and which
 * cache a success refreshes. An inverted publish status or a dropped offline
 * guard shipped green.
 *
 * The invalidation key is READ OFF THE REAL READ HOOKS (useLandingPages,
 * useLandingLeads), never retyped here: an assertion against a copied literal
 * would pass on exactly the drift it exists to catch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryOptions = {
  queryKey: readonly unknown[];
  enabled: boolean;
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
    effectiveRole: "admin",
    credentialScope: "session",
    canReadOfflineSnapshots: false,
  },
  online: true,
  queries: [] as QueryOptions[],
  mutations: [] as MutationOptions[],
  invalidateQueries: vi.fn(),
  fetchLandingPages: vi.fn(),
  fetchLandingLeads: vi.fn(),
  updateLandingPageStatus: vi.fn(),
  createLandingPage: vi.fn(),
  archiveLandingPage: vi.fn(),
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

// @/api/request (under every api module) otherwise reaches react-native.
vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ client: { request: vi.fn() } }),
}));

vi.mock("@/api/landingPages", () => ({
  fetchLandingPages: m.fetchLandingPages,
  fetchLandingLeads: m.fetchLandingLeads,
  updateLandingPageStatus: m.updateLandingPageStatus,
  createLandingPage: m.createLandingPage,
  archiveLandingPage: m.archiveLandingPage,
}));

// eslint-disable-next-line import/first
import {
  LandingOfflineError,
  landingPagesQueryKey,
  useArchiveLandingPage,
  useCreateLandingPage,
  useLandingLeads,
  useLandingPages,
  useUpdateLandingPageStatus,
} from "./useLandingPages";

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

const PAGE = { id: "lp_1", slug: "spring", name: "Spring", status: "draft" };

beforeEach(() => {
  vi.clearAllMocks();
  m.queries.length = 0;
  m.mutations.length = 0;
  m.online = true;
  m.gate.enabled = true;
  m.gate.tenantId = "11111111-1111-4111-8111-111111111111";
});

describe("the reads a landing-page write refreshes", () => {
  it("keys the list by tenant and fetches it only once a tenant is bound", async () => {
    m.fetchLandingPages.mockResolvedValue([PAGE]);
    const list = queryOf(useLandingPages);

    expect(list.queryKey).toEqual(landingPagesQueryKey(m.gate.tenantId));
    expect(list.enabled).toBe(true);
    await expect(list.queryFn()).resolves.toEqual([PAGE]);
    expect(m.fetchLandingPages).toHaveBeenCalledTimes(1);

    m.gate.tenantId = null;
    expect(queryOf(useLandingPages).enabled).toBe(false);
  });

  it("never asks for the leads of a page literally named null", async () => {
    const closed = queryOf(() => useLandingLeads(null));

    expect(closed.enabled).toBe(false);
    await expect(closed.queryFn()).resolves.toEqual([]);
    expect(m.fetchLandingLeads).not.toHaveBeenCalled();

    m.fetchLandingLeads.mockResolvedValue([{ id: "lead_1" }]);
    const open = queryOf(() => useLandingLeads("lp_1"));
    expect(open.enabled).toBe(true);
    await expect(open.queryFn()).resolves.toEqual([{ id: "lead_1" }]);
    expect(m.fetchLandingLeads).toHaveBeenCalledWith("lp_1");
  });
});

describe("useUpdateLandingPageStatus", () => {
  it.each([
    ["lp_1", "published"],
    ["lp_2", "draft"],
  ] as const)(
    "sends %s the status %s exactly as asked, never its inverse",
    async (id, status) => {
      m.updateLandingPageStatus.mockResolvedValue({ ...PAGE, id, status });
      const options = mutationOf(useUpdateLandingPageStatus);

      await expect(options.mutationFn({ id, status })).resolves.toMatchObject({
        id,
        status,
      });
      expect(m.updateLandingPageStatus.mock.calls).toEqual([[id, status]]);
    },
  );
});

describe("useCreateLandingPage", () => {
  it("hands the name and slug to the transport unchanged", async () => {
    m.createLandingPage.mockResolvedValue(PAGE);
    const options = mutationOf(useCreateLandingPage);

    await expect(
      options.mutationFn({ name: "Spring", slug: "spring" }),
    ).resolves.toEqual(PAGE);
    expect(m.createLandingPage.mock.calls).toEqual([
      [{ name: "Spring", slug: "spring" }],
    ]);
  });
});

describe("useArchiveLandingPage", () => {
  it("archives exactly the page it was given", async () => {
    m.archiveLandingPage.mockResolvedValue(undefined);
    const options = mutationOf(useArchiveLandingPage);

    await options.mutationFn("lp_1");
    expect(m.archiveLandingPage.mock.calls).toEqual([["lp_1"]]);
  });
});

const WRITES = [
  {
    verb: "status",
    hook: useUpdateLandingPageStatus,
    input: { id: "lp_1", status: "published" },
    transport: m.updateLandingPageStatus,
    action: "Changing what the public is served",
  },
  {
    verb: "create",
    hook: useCreateLandingPage,
    input: { name: "Spring", slug: "spring" },
    transport: m.createLandingPage,
    action: "Creating a page",
  },
  {
    verb: "archive",
    hook: useArchiveLandingPage,
    input: "lp_1",
    transport: m.archiveLandingPage,
    action: "Archiving a page",
  },
];

describe("offline, every write refuses at the tap", () => {
  it.each(WRITES)(
    "$verb rejects offline_write_refused and never reaches the transport",
    async ({ hook, input, transport, action }) => {
      m.online = false;
      const options = mutationOf(hook);

      const refusal = options.mutationFn(input);
      await expect(refusal).rejects.toBeInstanceOf(LandingOfflineError);
      await expect(refusal).rejects.toMatchObject({
        code: "offline_write_refused",
        message: `${action} needs a connection. Reconnect and try again.`,
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

describe("a successful write refreshes the list, and only the list", () => {
  it.each(WRITES)(
    "$verb invalidates useLandingPages()'s key and never a leads key",
    ({ hook, input }) => {
      const listKey = queryOf(useLandingPages).queryKey;
      const leadsKey = queryOf(() => useLandingLeads("lp_1")).queryKey;
      const options = mutationOf(hook);

      options.onSuccess?.(undefined, input);
      expect(invalidatedKeys()).toEqual([listKey]);
      expect(invalidatedKeys()).not.toContainEqual(leadsKey);
    },
  );
});
