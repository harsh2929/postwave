/**
 * Agent-mandate revoke, run through its real transport seam.
 *
 * TESTS-2. The revoke's `mutationFn` executed on no runner, so dropping its
 * `unwrapMobileResult` — which turns the `{data,error}` envelope into a
 * rejection — shipped green: a refused revoke would RESOLVE, and the operator
 * would believe an agent's authority was dead while it kept authorising calls.
 *
 * api/ops.ts and api/request.ts are real; only the SDK client is a stand-in
 * (vitest mocks by resolved id, so it also replaces ops.ts's relative
 * `./sdkClient` import). The invalidated key is read off the REAL
 * `useAgentMandates()` query, never retyped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = {
  mutationFn: (input: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, variables: unknown) => void;
};

type QueryOptions = {
  queryKey: readonly unknown[];
  enabled: boolean;
  queryFn: () => Promise<unknown>;
};

const m = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "owner",
    credentialScope: "session",
    canReadOfflineSnapshots: false,
  },
  mutation: undefined as MutationOptions | undefined,
  query: undefined as QueryOptions | undefined,
  invalidateQueries: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
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
}));

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({
    client: { agentMandates: { list: m.list, revoke: m.revoke } },
  }),
}));

// eslint-disable-next-line import/first
import { useAgentMandates, useRevokeAgentMandate } from "./useAgentMandates";

/** Render a hook's body and hand back the options it registered. */
function mutationOf(hook: () => unknown): MutationOptions {
  m.mutation = undefined;
  hook();
  // Re-read after the call: TS keeps the `undefined` narrowing across it.
  const registered = m.mutation as MutationOptions | undefined;
  if (!registered) throw new Error("the hook registered no mutation");
  return registered;
}

function queryOf(hook: () => unknown): QueryOptions {
  m.query = undefined;
  hook();
  const registered = m.query as QueryOptions | undefined;
  if (!registered) throw new Error("the hook registered no query");
  return registered;
}

const revokeOptions = () => mutationOf(useRevokeAgentMandate);
const listOptions = () => queryOf(useAgentMandates);

beforeEach(() => {
  vi.clearAllMocks();
  m.mutation = undefined;
  m.query = undefined;
});

describe("useRevokeAgentMandate", () => {
  it("revokes the named mandate and refreshes the roster", async () => {
    m.revoke.mockResolvedValue({ revoked: true });
    const options = revokeOptions();

    await expect(options.mutationFn("m_1")).resolves.toBeUndefined();
    expect(m.revoke).toHaveBeenCalledWith("m_1");

    options.onSuccess?.(undefined, "m_1");
    expect(m.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(m.invalidateQueries).toHaveBeenCalledWith({
      queryKey: listOptions().queryKey,
    });
  });

  it("REJECTS a refused revoke with the server's message", async () => {
    m.revoke.mockRejectedValue(
      Object.assign(new Error("Session required to revoke a mandate."), {
        status: 403,
        code: "session_required",
      }),
    );
    const options = revokeOptions();

    await expect(options.mutationFn("m_1")).rejects.toThrow(
      "Session required to revoke a mandate.",
    );
  });
});

describe("useAgentMandates", () => {
  it("reads the roster, revoked and expired rows included", async () => {
    const rows = [
      { id: "m_1", revoked_at: null },
      { id: "m_2", revoked_at: "2026-09-01T00:00:00Z" },
    ];
    m.list.mockResolvedValue({ data: rows });
    const options = listOptions();

    expect(options.enabled).toBe(true);
    await expect(options.queryFn()).resolves.toEqual(rows);
  });

  it("fails the read instead of rendering a refused list as empty", async () => {
    m.list.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403, code: "forbidden" }),
    );

    await expect(listOptions().queryFn()).rejects.toThrow("Forbidden");
  });
});
