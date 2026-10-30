/**
 * Subscriber notes (SUB-097), run through their real hook bodies.
 *
 * TESTS-6. No runner executed these: jest's react-query stub never calls a
 * `mutationFn`, and no vitest file imported this module. A delete aimed at the
 * SUBSCRIBER id instead of the note id — a DELETE that 404s at best and removes
 * the wrong row at worst — shipped green, as did an untrimmed body.
 *
 * WHAT IS REAL. lib/subscriberNotes (parse and order) is real; only the SDK
 * client's `request` and the online gate are stand-ins. The invalidation key is
 * READ OFF THE REAL READ HOOK (useSubscriberNotes), never retyped here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryOptions = {
  queryKey: readonly unknown[];
  enabled: boolean;
  queryFn: () => Promise<unknown>;
};

type MutationOptions = {
  mutationFn: (input: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, variables: unknown) => void;
};

const m = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "11111111-1111-4111-8111-111111111111" as string | null,
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "editor",
    credentialScope: "session",
    canReadOfflineSnapshots: false,
  },
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

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ client: { request: m.request } }),
}));

// eslint-disable-next-line import/first
import {
  useCreateSubscriberNote,
  useDeleteSubscriberNote,
  useSubscriberNotes,
} from "./useSubscriberNotes";

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

beforeEach(() => {
  vi.clearAllMocks();
  m.queries.length = 0;
  m.mutations.length = 0;
  m.gate.enabled = true;
  m.gate.tenantId = "11111111-1111-4111-8111-111111111111";
});

describe("useSubscriberNotes", () => {
  it("reads the encoded subscriber's notes, pinned first then newest first", async () => {
    m.request.mockResolvedValue({
      notes: [
        {
          id: "n1",
          markdown_body: "older",
          created_at: "2026-09-01T00:00:00Z",
        },
        { id: "n2", body: "newer", created_at: "2026-09-10T00:00:00Z" },
        {
          id: "n3",
          markdown_body: "pinned",
          pinned: true,
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const notes = queryOf(() => useSubscriberNotes("s/1"));

    expect(notes.enabled).toBe(true);
    const rows = (await notes.queryFn()) as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(["n3", "n2", "n1"]);
    expect(m.request.mock.calls).toEqual([
      ["GET", "/api/v1/subscribers/s%2F1/notes"],
    ]);
  });

  it("stays idle with no subscriber or no tenant", () => {
    expect(queryOf(() => useSubscriberNotes(undefined)).enabled).toBe(false);
    m.gate.tenantId = null;
    expect(queryOf(() => useSubscriberNotes("s1")).enabled).toBe(false);
  });
});

describe("useCreateSubscriberNote", () => {
  it("POSTs the trimmed body as markdown_body to the encoded subscriber", async () => {
    m.request.mockResolvedValue({ id: "n9" });
    const options = mutationOf(useCreateSubscriberNote);

    await expect(
      options.mutationFn({ id: "s/1", body: "  met at SaaStr\n" }),
    ).resolves.toEqual({ id: "n9" });
    expect(m.request.mock.calls).toEqual([
      [
        "POST",
        "/api/v1/subscribers/s%2F1/notes",
        { body: { markdown_body: "met at SaaStr" } },
      ],
    ]);
  });
});

describe("useDeleteSubscriberNote", () => {
  it("DELETEs the encoded NOTE under its subscriber, never the subscriber id", async () => {
    m.request.mockResolvedValue(undefined);
    const options = mutationOf(useDeleteSubscriberNote);

    await options.mutationFn({ id: "s1", noteId: "n/1" });
    expect(m.request.mock.calls).toEqual([
      ["DELETE", "/api/v1/subscribers/s1/notes/n%2F1"],
    ]);
  });
});

describe("a note write refreshes that subscriber's notes", () => {
  it.each([
    {
      verb: "create",
      hook: useCreateSubscriberNote,
      input: { id: "s1", body: "memo" },
    },
    {
      verb: "delete",
      hook: useDeleteSubscriberNote,
      input: { id: "s1", noteId: "n1" },
    },
  ])("$verb invalidates useSubscriberNotes('s1')'s key", ({ hook, input }) => {
    const notesKey = queryOf(() => useSubscriberNotes("s1")).queryKey;
    const otherKey = queryOf(() => useSubscriberNotes("s2")).queryKey;
    const options = mutationOf(hook);

    options.onSuccess?.(undefined, input);
    expect(invalidatedKeys()).toEqual([notesKey]);
    expect(invalidatedKeys()).not.toContainEqual(otherKey);
  });
});
