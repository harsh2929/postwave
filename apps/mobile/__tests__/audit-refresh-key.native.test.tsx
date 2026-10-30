/**
 * Pull-to-refresh on the audit tab must refresh the query it is about to USE.
 *
 * `since` is pinned to a window anchor, and refreshing re-pins that anchor —
 * which mints a NEW query key for both the log (`["audit", …, since, …]`) and
 * the summary (`["audit-stats", …, since]`). The old code re-pinned the anchor
 * AND called `refetch()` on the same commit, so the refetch ran against the key
 * it had just abandoned. `useAuditLog` is an infinite query, so TanStack
 * refetched EVERY loaded page: an operator six pages into an incident paid six
 * of the most expensive reads in the product for responses that were dropped on
 * the floor, while the newly-keyed query fetched page one anyway.
 *
 * The refresh that matters is the mount of the new key. What this pins is that
 * the retired key is not re-fetched — and that when the anchor move does NOT
 * retire the key (the "all" window has no `since`), the refetch still happens,
 * so the fix is not "stop refreshing".
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";

const queryHooks = require("./mocks/queryHooks.cjs");
const reactQuery = require("./mocks/reactQuery.cjs");

// eslint-disable-next-line import/first -- must follow the mock require.
import { useAuditScreen } from "@/hooks/useAuditScreen";

function queryResult() {
  return {
    data: undefined,
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

let audit = queryResult();
let stats = queryResult();
let anomalies = queryResult();
let checkpoint = queryResult();
let clock = 1_760_000_000_000;

beforeEach(() => {
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  audit = queryResult();
  stats = queryResult();
  anomalies = queryResult();
  checkpoint = queryResult();
  queryHooks.__setHookResultForTests("useAuditLog", audit);
  queryHooks.__setHookResultForTests("useAuditStats", stats);
  queryHooks.__setHookResultForTests("useRecentAuditAnomalies", anomalies);
  queryHooks.__setHookResultForTests("useAuditCheckpoint", checkpoint);
});

afterEach(() => {
  reactQuery.__resetQueryResultForTests();
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("audit pull-to-refresh", () => {
  it("does not refetch the key the anchor move retires", async () => {
    const hook = await renderHook(() => useAuditScreen());
    // The default 7d window sends a `since`, so the anchor is in the key.
    const before = hook.result.current.since;
    expect(before).toBeTruthy();

    // A minute of reading before the pull, so the re-pinned anchor really does
    // produce a different `since`.
    clock += 60_000;
    await act(async () => {
      hook.result.current.refresh.onRefresh();
    });
    await waitFor(() =>
      expect(hook.result.current.since).not.toBe(before),
    );

    expect(audit.refetch).not.toHaveBeenCalled();
    expect(stats.refetch).not.toHaveBeenCalled();
    // The queries whose keys survive the anchor move are still refreshed, so
    // the gesture is not a no-op.
    expect(anomalies.refetch).toHaveBeenCalled();
    expect(checkpoint.refetch).toHaveBeenCalled();
  });

  it("still refetches when the anchor move leaves the key alone", async () => {
    const hook = await renderHook(() => useAuditScreen({ windowKey: "all" }));
    expect(hook.result.current.since).toBeUndefined();

    clock += 60_000;
    await act(async () => {
      hook.result.current.refresh.onRefresh();
    });

    await waitFor(() => expect(audit.refetch).toHaveBeenCalled());
    expect(stats.refetch).toHaveBeenCalled();
    expect(hook.result.current.since).toBeUndefined();
  });

  /**
   * The "all" window is the ONE path that still reaches `refetch()`, and that
   * is the path where an infinite query re-requests every loaded page. The
   * screen collapses the cache to page one first (lib/infiniteQueryRefresh),
   * so the gesture costs one request there too — the same thing the other
   * windows get for free by mounting a newly-keyed query at page one.
   */
  it("collapses the loaded pages before the 'all' window refetches", async () => {
    // The tenant id has to be the one the shared online-gate mock reports, or
    // the prefix matches nothing and the assertion measures the test.
    const auditKey = [
      "audit",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "owner",
      50,
    ];
    reactQuery.__setCachedQueriesForTests([
      [auditKey, { pages: [["a"], ["b"], ["c"]], pageParams: [null, "c1", "c2"] }],
    ]);
    const hook = await renderHook(() => useAuditScreen({ windowKey: "all" }));

    await act(async () => {
      hook.result.current.refresh.onRefresh();
    });

    await waitFor(() => expect(audit.refetch).toHaveBeenCalled());
    const [, collapsed] = reactQuery.__getCachedQueriesForTests()[0];
    expect(collapsed).toEqual({ pages: [["a"]], pageParams: [null] });
  });
});
