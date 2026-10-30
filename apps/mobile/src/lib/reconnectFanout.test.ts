/**
 * The reconnect fan-out has a SHAPE, and this pins it.
 *
 * When the radio comes back, two things want to refetch the same queries:
 *
 *   1. TanStack itself. `refetchOnReconnect` is true for every query in this
 *      client, so `onlineManager` flipping online makes `queryCache.onOnline()`
 *      refetch every STALE active query.
 *   2. `invalidatePrimaryDataOnReconnect`, which the reconnect handler in
 *      `hooks/useAppBootstrap.ts` runs a beat later (it awaits
 *      `revalidateSession()` first).
 *
 * `invalidateQueries` defaults to `cancelRefetch: true`. That made (2) ABORT
 * the request (1) already had in flight and issue a second one for the same
 * key — the most expensive requests the app ever makes, because they go out the
 * instant a flaky radio came back. Measured against the app's real client with
 * 6 plain queries and a 10-page infinite subscriber list mounted: 21 requests
 * with 5 killed mid-flight, where 16 requests do the same work.
 *
 * The second case is the one that keeps the invalidation honest: a user offline
 * for LESS than `staleTime` leaves the primary roots fresh, TanStack skips them
 * entirely, and only the explicit invalidation refreshes them. That behaviour
 * must survive any change to the first.
 *
 * Node-run: no react-native imports.
 */
import {
  InfiniteQueryObserver,
  QueryObserver,
  onlineManager,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import { invalidatePrimaryDataOnReconnect, queryClient } from "./queryClient";

/** Four primary reconnect roots plus two domains that are deliberately not. */
const PRIMARY = ["dashboard-stats", "dashboard-anomalies", "approvals", "campaigns"];
const SECONDARY = ["audit", "integrations"];

const RESPONSE_MS = 20;
const REVALIDATE_MS = 10;
/** The whole client's `staleTime` is 30s; these sit either side of it. */
const LONG_OUTAGE_MS = 60_000;
const SHORT_OUTAGE_MS = 5_000;
const PAGES_LOADED = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Reconnect = {
  /** queryFn invocations, by query-key root. */
  perKey: Record<string, number>;
  /** Requests that were cancelled after they had already gone out. */
  abortedMidFlight: number;
};

/**
 * Drive one full offline→online cycle through the app's real QueryClient and
 * the real reconnect handler body, counting what goes on the wire.
 */
async function reconnectAfter(offlineForMs: number): Promise<Reconnect> {
  const calls: string[] = [];
  const aborted: string[] = [];
  const unsubscribes: (() => void)[] = [];

  const track = (name: string, signal: AbortSignal): void => {
    calls.push(name);
    signal.addEventListener("abort", () => aborted.push(name));
  };

  for (const root of [...PRIMARY, ...SECONDARY]) {
    const observer = new QueryObserver(queryClient, {
      queryKey: [root, "tenant"],
      queryFn: async ({ signal }) => {
        track(root, signal);
        await sleep(RESPONSE_MS);
        if (signal.aborted) throw new Error("aborted");
        return { ok: true };
      },
    });
    unsubscribes.push(observer.subscribe(() => undefined));
  }

  // The subscriber list is an INFINITE query, and a refetch re-requests every
  // loaded page sequentially — so a cancel-and-restart costs a page, not a
  // request.
  const paged = new InfiniteQueryObserver(queryClient, {
    queryKey: ["subs", "tenant", "paged"],
    initialPageParam: 1,
    getNextPageParam: (_page: unknown, _all: unknown[], last: number) =>
      last < PAGES_LOADED ? last + 1 : undefined,
    queryFn: async ({ signal }) => {
      track("subs:paged", signal);
      await sleep(RESPONSE_MS);
      if (signal.aborted) throw new Error("aborted");
      return { ok: true };
    },
  });
  unsubscribes.push(paged.subscribe(() => undefined));
  await sleep(RESPONSE_MS * 2);
  for (let page = 1; page < PAGES_LOADED; page += 1) {
    await paged.fetchNextPage();
  }

  queryClient.mount();
  await sleep(RESPONSE_MS * 3);

  onlineManager.setOnline(false);
  const realNow = Date.now();
  vi.setSystemTime(realNow + offlineForMs);

  calls.length = 0;
  aborted.length = 0;

  // The radio comes back…
  onlineManager.setOnline(true);
  // …and hooks/useAppBootstrap's onOnline handler runs its body.
  await sleep(REVALIDATE_MS); // revalidateSession() round trip
  void queryClient.resumePausedMutations();
  void invalidatePrimaryDataOnReconnect(queryClient);
  await sleep(RESPONSE_MS * PAGES_LOADED * 6);

  const perKey: Record<string, number> = {};
  for (const name of calls) perKey[name] = (perKey[name] ?? 0) + 1;

  vi.setSystemTime(realNow);
  for (const unsubscribe of unsubscribes) unsubscribe();
  queryClient.unmount();
  queryClient.clear();
  return { perKey, abortedMidFlight: aborted.length };
}

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe("reconnect fan-out", () => {
  it("asks for each primary domain once, and cancels nothing mid-flight", async () => {
    const { perKey, abortedMidFlight } = await reconnectAfter(LONG_OUTAGE_MS);

    for (const root of PRIMARY) {
      expect(
        perKey[root],
        `${root} went out more than once on a single reconnect — invalidatePrimaryDataOnReconnect is racing TanStack's own refetchOnReconnect instead of joining it`,
      ).toBe(1);
    }
    for (const root of SECONDARY) {
      expect(perKey[root]).toBe(1);
    }
    expect(
      perKey["subs:paged"],
      "the infinite list refetched a page twice; a cancel-and-restart on an infinite query re-walks pages",
    ).toBe(PAGES_LOADED);
    expect(
      abortedMidFlight,
      "a request was aborted after it had already gone out — that is a round trip paid for and thrown away on a radio that just came back",
    ).toBe(0);
  }, 30_000);

  it("still refreshes the primary domains after an outage shorter than staleTime", async () => {
    // Inside `staleTime` TanStack considers the data fresh and refetches
    // NOTHING on reconnect. Forcing the primary domains is the whole reason
    // this invalidation exists, so it has to survive.
    const { perKey, abortedMidFlight } = await reconnectAfter(SHORT_OUTAGE_MS);

    for (const root of PRIMARY) {
      expect(
        perKey[root],
        `${root} was not refreshed after a short outage — the reconnect invalidation has stopped doing its job`,
      ).toBe(1);
    }
    expect(perKey["subs:paged"]).toBe(PAGES_LOADED);
    for (const root of SECONDARY) {
      expect(
        perKey[root],
        `${root} is not a primary reconnect root and must not be woken by one`,
      ).toBeUndefined();
    }
    expect(abortedMidFlight).toBe(0);
  }, 30_000);
});
