/**
 * MEASURED guard for the list-catalogue cache policy.
 *
 * The picker (AddToListModal, the subscriber bulk sheets, the list detail
 * header) mounts a FRESH observer on this key every time it opens, so the
 * policy decides whether opening a sheet is instant or costs a blocking round
 * trip. The assertions count queryFn invocations against a real QueryClient —
 * the shape that regresses — rather than wall-clock.
 *
 * The correctness half is asserted too: a longer staleTime must not be able to
 * hold a stale catalogue past a mutation, because the freshness of this entry
 * comes from invalidation (six mutation sites, the `list.*` event root and the
 * reconnect roots), not from the clock.
 */
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  LIST_CATALOGUE_GC_MS,
  LIST_CATALOGUE_STALE_MS,
} from "@/lib/listCataloguePolicy";

/** The client-wide defaults this query used to inherit (lib/queryClient.ts). */
const INHERITED_STALE_MS = 30_000;
const INHERITED_GC_MS = 2 * 60 * 1000;

const KEY = ["lists", "t1", "options", "u1", "admin", "network"];

/**
 * Open the picker at each of `opensAtMs`, closing it in between, and return
 * how many network reads that cost.
 *
 * "Open" is a fresh QueryObserver + subscribe; "close" is unsubscribe. That is
 * exactly what a sheet mount/unmount does to TanStack, which is why the policy
 * — not the screen — decides the request count.
 */
async function pickerOpens(
  policy: { staleTime: number; gcTime: number },
  opensAtMs: readonly number[],
): Promise<number> {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  let reads = 0;
  let now = 0;
  for (const at of opensAtMs) {
    await vi.advanceTimersByTimeAsync(at - now);
    now = at;
    const observer = new QueryObserver(client, {
      queryKey: KEY,
      queryFn: async () => {
        reads += 1;
        return { rows: [{ id: "1", name: "Weekly" }], total: 1 };
      },
      staleTime: policy.staleTime,
      gcTime: policy.gcTime,
      networkMode: "always",
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(1);
    unsubscribe();
  }
  client.clear();
  vi.useRealTimers();
  return reads;
}

// A realistic sheet session: open the picker, close it, work for a bit, open
// it again, and again a few minutes later.
const SESSION = [0, 45_000, 130_000, 240_000];

describe("MEASURED: list-catalogue reads across one picker session", () => {
  it("BEFORE — the inherited feed defaults refetch on every open", async () => {
    expect(
      await pickerOpens(
        { staleTime: INHERITED_STALE_MS, gcTime: INHERITED_GC_MS },
        SESSION,
      ),
    ).toBe(4);
  });

  it("AFTER — the reference tier answers three of the four from cache", async () => {
    expect(
      await pickerOpens(
        { staleTime: LIST_CATALOGUE_STALE_MS, gcTime: LIST_CATALOGUE_GC_MS },
        SESSION,
      ),
    ).toBe(1);
  });

  it("the gcTime outlives the staleTime, so a reopen never starts from nothing", () => {
    expect(LIST_CATALOGUE_GC_MS).toBeGreaterThan(LIST_CATALOGUE_STALE_MS);
  });
});

describe("CORRECTNESS: freshness comes from invalidation, not the clock", () => {
  it("an invalidation of the catalogue prefix refetches immediately", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 0 } },
    });
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: KEY,
      queryFn: async () => {
        reads += 1;
        return { rows: [], total: 0 };
      },
      staleTime: LIST_CATALOGUE_STALE_MS,
      gcTime: LIST_CATALOGUE_GC_MS,
      networkMode: "always",
    });
    const unsubscribe = observer.subscribe(() => {});
    // Wait for the fetch to SETTLE, not just to start: `invalidateQueries`
    // dedupes against an in-flight fetch, so asserting on the read counter
    // alone measures the test's own race instead of the policy.
    await vi.waitFor(() => {
      expect(
        client.getQueryCache().find({ queryKey: KEY })?.state.fetchStatus,
      ).toBe("idle");
    });
    expect(reads).toBe(1);

    // What useCreateList / useListManage / useListMembership / the `list.*`
    // event root all do: invalidate the catalogue PREFIX.
    await client.invalidateQueries({ queryKey: ["lists", "t1"] });
    await vi.waitFor(() => expect(reads).toBe(2));

    unsubscribe();
    client.clear();
  });
});
