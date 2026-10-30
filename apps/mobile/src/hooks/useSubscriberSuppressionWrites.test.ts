/**
 * Suppress and its undo, run through their real hook bodies.
 *
 * TESTS-6. No runner executed these: jest's react-query stub never calls a
 * `mutationFn`, `onMutate` or `onSettled`, and no vitest file imported this
 * module. The pair's whole reason to live in one file is an invariant —
 * suppressing writes a deliverability row AND blocklists the person, so the
 * undo must revert both — and nothing held it: dropping the restore PATCH (the
 * person stays blocklisted and silently un-mailable), restoring a
 * `blocklisted` status, or no longer refreshing the `["suppressions"]` root
 * (the profile card keeps saying "clean") all shipped green.
 *
 * WHAT IS REAL. lib/serialQueue, lib/subscriberQueryCache and
 * lib/subscriberQueryKeys are real, and so is a TanStack QueryClient: the
 * optimistic projection and its rollback run against a real cache. Only the
 * SDK client, the conditional PATCH and the online gate are stand-ins.
 */
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import {
  subscriberDetailKey,
  subscriberMutationInvalidationKeys,
  subscriberTimelineKey,
} from "@/lib/subscriberQueryKeys";

type Context = { previous: [QueryKey, unknown][] };

type MutationOptions = {
  mutationFn: (input: unknown) => Promise<unknown>;
  onMutate: (input: unknown) => Promise<Context>;
  onError: (err: unknown, input: unknown, context: Context | undefined) => void;
  onSettled: (data: unknown, err: unknown, input: unknown) => void;
};

const TENANT = "11111111-1111-4111-8111-111111111111";

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
  client: null as unknown,
  mutations: [] as unknown[],
  suppress: vi.fn(),
  request: vi.fn(),
  updateConditionally: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMutation: (options: unknown) => {
    m.mutations.push(options);
    return { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() };
  },
  useQueryClient: () => m.client,
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
    client: { subscribers: { suppress: m.suppress }, request: m.request },
  }),
}));

vi.mock("@/api/subscriberConditionalWrite", () => ({
  updateSubscriberConditionally: m.updateConditionally,
}));

// eslint-disable-next-line import/first
import {
  useSuppressSubscriber,
  useUnsuppressSubscriber,
} from "./useSubscriberSuppressionWrites";

let queryClient: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

/** Run a mutation hook's body and hand back the options it registered. */
function mutationOf(hook: () => unknown): MutationOptions {
  m.mutations.length = 0;
  hook();
  const [registered] = m.mutations;
  if (!registered) throw new Error("the hook registered no mutation");
  return registered as MutationOptions;
}

function invalidatedKeys(): unknown[] {
  return invalidate.mock.calls.map((call) => call[0]?.queryKey);
}

/** A mounted detail variant: the real query appends segments after the id. */
const DETAIL_KEY = [...subscriberDetailKey(TENANT, "s1"), "network"];
const TIMELINE_KEY = subscriberTimelineKey(TENANT, "s1");

function seedRow(status: string): void {
  queryClient.setQueryData(DETAIL_KEY, { id: "s1", email: "a@b.co", status });
  queryClient.setQueryData(TIMELINE_KEY, {
    pages: [{ page: { stats: { current_status: status } } }],
    pageParams: [null],
  });
}

function shownStatus(): { detail: unknown; timeline: unknown } {
  const detail = queryClient.getQueryData<{ status: string }>(DETAIL_KEY);
  const timeline = queryClient.getQueryData<{
    pages: { page: { stats: { current_status: string } } }[];
  }>(TIMELINE_KEY);
  return {
    detail: detail?.status,
    timeline: timeline?.pages[0]?.page.stats.current_status,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.mutations.length = 0;
  m.gate.tenantId = TENANT;
  queryClient = new QueryClient();
  m.client = queryClient;
  invalidate = vi.spyOn(queryClient, "invalidateQueries");
  m.suppress.mockResolvedValue({ suppressed: true });
  m.request.mockResolvedValue({ deleted: true });
  m.updateConditionally.mockResolvedValue({ kind: "applied" });
});

describe("useSuppressSubscriber", () => {
  it("suppresses exactly the subscriber it was given", async () => {
    const options = mutationOf(useSuppressSubscriber);

    await expect(options.mutationFn("s1")).resolves.toEqual({
      suppressed: true,
    });
    expect(m.suppress.mock.calls).toEqual([["s1"]]);
  });

  it("shows the row blocklisted at once, and puts it back when the write fails", async () => {
    seedRow("enabled");
    const options = mutationOf(useSuppressSubscriber);

    const context = await options.onMutate("s1");
    expect(shownStatus()).toEqual({
      detail: "blocklisted",
      timeline: "blocklisted",
    });

    options.onError(new Error("refused"), "s1", context);
    expect(shownStatus()).toEqual({ detail: "enabled", timeline: "enabled" });
  });

  it("refreshes the suppressions root and every subscriber key once settled", () => {
    const options = mutationOf(useSuppressSubscriber);

    options.onSettled(undefined, null, "s1");
    expect(invalidatedKeys()).toEqual([
      ["suppressions"],
      ...subscriberMutationInvalidationKeys(TENANT, "s1"),
    ]);
  });

  it("still refreshes the suppressions root with no tenant bound", () => {
    m.gate.tenantId = null;
    const options = mutationOf(useSuppressSubscriber);

    options.onSettled(undefined, null, "s1");
    expect(invalidatedKeys()).toEqual([["suppressions"]]);
  });
});

describe("useUnsuppressSubscriber", () => {
  it("deletes the suppression by encoded email, THEN restores the status it replaced", async () => {
    const options = mutationOf(useUnsuppressSubscriber);

    await expect(
      options.mutationFn({
        id: "s1",
        email: "a@b.co",
        restoreStatus: "enabled",
      }),
    ).resolves.toEqual({ deleted: true });

    expect(m.request.mock.calls).toEqual([
      ["DELETE", "/api/v1/deliverability/suppressions/a%40b.co"],
    ]);
    expect(m.updateConditionally.mock.calls).toEqual([
      ["s1", { status: "enabled" }],
    ]);
    expect(m.request.mock.invocationCallOrder[0]).toBeLessThan(
      m.updateConditionally.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each(["blocklisted", undefined])(
    "with restoreStatus %s only lifts the suppression — it never invents a status",
    async (restoreStatus) => {
      const options = mutationOf(useUnsuppressSubscriber);

      await options.mutationFn({ id: "s1", email: "a@b.co", restoreStatus });
      expect(m.request).toHaveBeenCalledTimes(1);
      expect(m.updateConditionally).not.toHaveBeenCalled();
    },
  );

  it("queues the restore behind a suppress still in flight for the same row", async () => {
    let finishSuppress: (value: unknown) => void = () => undefined;
    m.suppress.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSuppress = resolve;
      }),
    );
    const suppress = mutationOf(useSuppressSubscriber).mutationFn("s1");
    const undo = mutationOf(useUnsuppressSubscriber).mutationFn({
      id: "s1",
      email: "a@b.co",
      restoreStatus: "enabled",
    });

    // A macrotask drains every pending microtask: had the restore not been
    // queued behind the suppress, it would have gone out by now.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.request).toHaveBeenCalledTimes(1);
    expect(m.updateConditionally).not.toHaveBeenCalled();

    finishSuppress({ suppressed: true });
    await Promise.all([suppress, undo]);
    expect(m.updateConditionally.mock.calls).toEqual([
      ["s1", { status: "enabled" }],
    ]);
  });

  it("projects the restored status at once, and rolls it back on failure", async () => {
    seedRow("blocklisted");
    const options = mutationOf(useUnsuppressSubscriber);
    const input = { id: "s1", email: "a@b.co", restoreStatus: "enabled" };

    const context = await options.onMutate(input);
    expect(shownStatus()).toEqual({ detail: "enabled", timeline: "enabled" });

    options.onError(new Error("refused"), input, context);
    expect(shownStatus()).toEqual({
      detail: "blocklisted",
      timeline: "blocklisted",
    });
  });

  it("projects nothing when there is no status to restore to", async () => {
    seedRow("blocklisted");
    const options = mutationOf(useUnsuppressSubscriber);

    await expect(
      options.onMutate({
        id: "s1",
        email: "a@b.co",
        restoreStatus: "blocklisted",
      }),
    ).resolves.toEqual({ previous: [] });
    expect(shownStatus()).toEqual({
      detail: "blocklisted",
      timeline: "blocklisted",
    });
  });

  it("refreshes the suppressions root and every subscriber key once settled", () => {
    const options = mutationOf(useUnsuppressSubscriber);

    options.onSettled(undefined, null, { id: "s1", email: "a@b.co" });
    expect(invalidatedKeys()).toEqual([
      ["suppressions"],
      ...subscriberMutationInvalidationKeys(TENANT, "s1"),
    ]);
  });
});
