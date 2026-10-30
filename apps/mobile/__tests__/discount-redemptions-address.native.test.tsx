import { renderHook } from "@testing-library/react-native";
import { afterEach, describe, expect, it } from "@jest/globals";

import {
  DiscountReleaseHeldError,
  REDEMPTION_MAX_LIMIT,
  REDEMPTION_PAGE_SIZE,
  useDeleteDiscount,
  useDiscountRedemptions,
  useExportDiscountRedemptions,
  useUpdateDiscount,
} from "@/hooks/useDiscountOps";

const {
  request,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/apiRuntime.cjs");
const {
  __getLastMutationOptionsForTests,
  __getQueryOptionsForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/reactQuery.cjs");

/**
 * HOW MOBILE ADDRESSES THE ONE DETAIL ROUTE IT STILL HAS.
 *
 * The discount boundary moved twice, and the second move changed something a
 * mount FLAG cannot express: the redemptions route went from `{code}` to
 * `{record_id}` and now refuses anything that is not a canonical UUID
 * (`canonicalArchiveUUID`, pinned Go-side by
 * `TestListRedemptionsRejectsRedeemableCodePathValue`). Mobile kept sending
 * redeemable codes, so the ONE route it was still allowed to call answered 400
 * while every capability constant in `discountMutationBoundary` was correct.
 *
 * That is the gap these cases close, and none of them can be satisfied by
 * asserting on a stub: the real `queryFn` runs and the assertion is on the URL
 * that reached the transport.
 */

/**
 * The last options object `useQuery` was handed.
 *
 * The shared mock APPENDS and never clears, so `.at(-1)` — not `[0]` — is the
 * render this case just performed. Reading the first entry would assert against
 * whichever test ran earliest in the file.
 *
 * And every `renderHook` below is AWAITED. RNTL 14 returns a promise from it,
 * so an un-awaited render leaves this reading the PREVIOUS test\'s options —
 * which does not throw, it just quietly asserts the wrong thing, one case out
 * of step. That is exactly how this file failed the first time it was run.
 */
function lastQueryOptions() {
  const entry = __getQueryOptionsForTests()
    .filter((candidate: { kind: string }) => candidate.kind === "query")
    .at(-1);
  if (!entry) throw new Error("no useQuery options were registered");
  return entry.options as {
    enabled: boolean;
    queryKey: unknown[];
    queryFn: () => Promise<unknown[]>;
  };
}

const RECORD_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  request.mockClear();
});

describe("useDiscountRedemptions addressing", () => {
  it("puts the archive record ID in the path the server actually mounts", async () => {
    await renderHook(() => useDiscountRedemptions(RECORD_ID));
    const options = lastQueryOptions();
    expect(options.enabled).toBe(true);

    request.mockResolvedValueOnce({ items: [], has_more: false });
    await options.queryFn();

    expect(request).toHaveBeenCalledWith(
      "GET",
      `/api/v1/discounts/${RECORD_ID}/redemptions?limit=${REDEMPTION_PAGE_SIZE}`,
    );
  });

  it("lowercases a non-canonical UUID rather than letting the server reject it", async () => {
    await renderHook(() =>
      useDiscountRedemptions("11111111-2222-4333-8444-55555555555A"),
    );
    request.mockResolvedValueOnce({ items: [], has_more: false });
    await lastQueryOptions().queryFn();

    // The Go side compares `parsedID.String() != recordID`, so an upper-cased
    // UUID is a 400 there and a 200 here only because it is normalised first.
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/discounts/11111111-2222-4333-8444-55555555555a/redemptions?limit=10",
    );
  });

  it("never sends a redeemable code into the {record_id} slot", async () => {
    // The catalogue is vault-backed and the vault is not shape-checked, so a
    // cold offline launch can replay rows an OLDER build wrote — and those
    // carry a code where this now needs an ID. Spending a round trip on a
    // guaranteed 400 would surface to the operator as "the server is broken".
    await renderHook(() => useDiscountRedemptions("BLACKFRIDAY"));
    const options = lastQueryOptions();

    expect(options.enabled).toBe(false);
    // Belt and braces: even called directly, it must not reach the transport.
    await expect(options.queryFn()).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("keys the cache on the canonical ID, so a code cannot poison a record's entry", async () => {
    await renderHook(() => useDiscountRedemptions("BLACKFRIDAY"));
    expect(lastQueryOptions().queryKey).not.toContain("BLACKFRIDAY");
  });

  it("clamps Load more to the server's ceiling instead of asking for a 400", async () => {
    // `archiveIntParam(r, "limit", 50, 1, 100)` REJECTS an over-range limit
    // rather than clamping it, so an unbounded "Load more" turns a working
    // drawer into an empty one at the eleventh page. The old bound was 10,000,
    // which the previous `intParam` tolerated.
    await renderHook(() => useDiscountRedemptions(RECORD_ID, 10_000));
    request.mockResolvedValueOnce({ items: [], has_more: false });
    await lastQueryOptions().queryFn();

    expect(request).toHaveBeenCalledWith(
      "GET",
      `/api/v1/discounts/${RECORD_ID}/redemptions?limit=${REDEMPTION_MAX_LIMIT}`,
    );
    expect(REDEMPTION_MAX_LIMIT).toBe(100);
  });

  it("gives every archive event a distinct key, since the payload carries none", async () => {
    // `HistoricalRedemptionEvent` is `{redeemed_at, subscriber_linked}` — no
    // id. The drawer keys its list on `id`, and `undefined` repeated N times is
    // one React key for every row, which reconciles the wrong nodes the moment
    // "Load more" grows the window.
    await renderHook(() => useDiscountRedemptions(RECORD_ID));
    request.mockResolvedValueOnce({
      items: [
        { redeemed_at: "2026-09-01T10:00:00Z", subscriber_linked: true },
        { redeemed_at: "2026-09-01T09:00:00Z", subscriber_linked: false },
      ],
      has_more: false,
    });

    const rows = (await lastQueryOptions().queryFn()) as { id: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.every((row) => typeof row.id === "string" && row.id)).toBe(true);
  });

  it("leaves a server-supplied id alone", async () => {
    // Older payloads did carry one, and a synthesised key would detach the row
    // from its own identity across a refetch.
    await renderHook(() => useDiscountRedemptions(RECORD_ID));
    request.mockResolvedValueOnce({
      items: [{ id: "77", redeemed_at: "2026-09-01T10:00:00Z" }],
      has_more: false,
    });

    const rows = (await lastQueryOptions().queryFn()) as { id: string }[];
    expect(rows[0]!.id).toBe("77");
  });
});

/**
 * THE SECOND LOCK ON AN UNMOUNTED MUTATION.
 *
 * The screen already omits every affordance whose route is unmounted, so in the
 * shipped UI these three cannot be reached. That is one lock, and it lives in
 * `useDiscountsScreen`. These cases pin the other one, in the hook itself.
 *
 * Why two: the hooks are exported, the boundary is a compile-time constant a
 * hand can flip, and the failure mode of getting it wrong is a DELETE that
 * answers 404 while an operator believes a leaked code has been withdrawn. A
 * dormant caller has to fail LOUDLY, before the request, with a message naming
 * the deployment rather than the network — the same shape `releaseHeldError`
 * gives the web client for coupon pools.
 *
 * The assertion is on the CONSEQUENCE, not on the throw: nothing reaches the
 * transport. A hook that threw after issuing the request would still be a hook
 * that hit an unmounted route.
 */
describe("release-held discount mutations", () => {
  const cases: [string, () => { mutationFn: (input: never) => Promise<unknown> }, unknown][] =
    [
      [
        "Deleting a discount",
        useDeleteDiscount as never,
        "BLACKFRIDAY" as never,
      ],
      [
        "Exporting redemptions",
        useExportDiscountRedemptions as never,
        "BLACKFRIDAY" as never,
      ],
      [
        "Editing a discount",
        useUpdateDiscount as never,
        { code: "BLACKFRIDAY", patch: { max_redemptions: 900 } } as never,
      ],
    ];

  it.each(cases)(
    "refuses %s before it reaches the transport",
    async (capability, useHook, input) => {
      await renderHook(() => useHook());
      const options = __getLastMutationOptionsForTests();

      await expect(options.mutationFn(input)).rejects.toThrow(
        DiscountReleaseHeldError,
      );
      // Names the deployment, not the connection: "try again later" would send
      // the operator back to a control that will never work.
      await expect(options.mutationFn(input)).rejects.toThrow(
        `${capability} is not available on this deployment`,
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("refuses regardless of connectivity", async () => {
    // The route gate is checked BEFORE the offline gate. Reversed, an online
    // operator would get "not available on this deployment" while an offline
    // one got "reconnect and try again" — a promise the reconnection cannot
    // keep.
    await renderHook(() => useDeleteDiscount());
    const options = __getLastMutationOptionsForTests();
    await expect(options.mutationFn("BLACKFRIDAY")).rejects.toThrow(
      /not available on this deployment/,
    );
    await expect(options.mutationFn("BLACKFRIDAY")).rejects.not.toThrow(
      /Reconnect/,
    );
  });
});
