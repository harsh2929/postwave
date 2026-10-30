import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  discountDeleteActionLabel,
  discountDeleteConfirmCopy,
} from "@/components/discounts/discountDeleteCopy";

import Discounts from "../app/(tabs)/discounts";

/**
 * The Discounts screen's riskiest behaviour is not the list — it is what the
 * drawer promises. Three of its affordances were once built against routes the
 * API had withdrawn and the screen kept offering them; the A1 release
 * (2026-08-18) then mounted four routes and the screen kept NOT offering one of
 * them; and the A1 release was then reversed. Three moves, one failure mode, so
 * all of it is pinned here:
 *
 *  1. NO VERDICT WITHOUT A PROBE. The pill is DERIVED from a list payload that
 *     may be a twelve-hour offline snapshot, so the drawer states its
 *     provenance in words rather than letting the pill borrow the authority of
 *     a verdict nobody issued.
 *  2. AN UNREACHABLE MUTATION IS ABSENT, NOT DISABLED — for an OWNER too, not
 *     merely for the roles that could never use it. A disabled-looking button
 *     on a phone is a promise you cannot keep.
 *  3. THE ONE ABSENCE THAT IS SPOKEN. Extend and Export just vanish, and that is
 *     right — nobody opens this drawer hoping to export a CSV. The kill switch
 *     is different: COMMERCE#11 and MAP#24 exist because someone opens this
 *     screen at 2am with a leaked code, and an empty row of buttons lets them
 *     conclude they already stopped it. So its absence is a sentence.
 *
 * `src/lib/discountMutationBoundary.test.ts` is the other half of this: it
 * parses the Go mount list, so if any of these routes come back, that test
 * fails and sends someone here.
 *
 * `useDiscountOps` is mocked here rather than in the shared queryHooks proxy
 * because the payload SHAPES matter: the catalogue resolves to a
 * SnapshotBacked envelope (`{value, fromSnapshot, capturedAt}`) and the probe
 * to a bare `DiscountCheck`. A proxy that returned one generic query object for
 * both would let every assertion below pass on an error path.
 */

const mockCatalogue = { current: undefined as unknown };
const mockRedemptions = { current: undefined as unknown };
const mockCheck = { current: undefined as unknown };

/**
 * The kill switch's transport, captured rather than executed.
 *
 * Nothing on the screen can reach it any more — DELETE is unmounted, so
 * `useDiscountsScreen` hands the drawer a null `onDelete`. This mock is
 * therefore not here to record a call; it is here so that a call would be
 * RECORDED rather than swallowed, which is what lets the cases below assert
 * that no interaction on this screen sends one. Without it, "no DELETE was
 * sent" would be true of a screen that never had the hook wired at all.
 *
 * `useConfirm()` outside a `ConfirmProvider` resolves TRUE immediately
 * (components/ConfirmSheet), so if the affordance ever came back un-gated, a
 * single press would land straight here and these assertions would fail.
 */
const mockDeleteCalls: string[] = [];

jest.mock("@/hooks/useDiscountOps", () => ({
  REDEMPTION_PAGE_SIZE: 10,
  useDiscounts: () => mockCatalogue.current,
  useDiscountRedemptions: () => mockRedemptions.current,
  useDiscountCheck: () => mockCheck.current,
  useExportDiscountRedemptions: () => ({ isPending: false, mutate: jest.fn() }),
  useUpdateDiscount: () => ({ isPending: false, mutateAsync: jest.fn() }),
  useDeleteDiscount: () => ({
    isPending: false,
    mutateAsync: async (code: string) => {
      mockDeleteCalls.push(code);
      return { ok: true };
    },
  }),
}));


const queryHooks = require("./mocks/queryHooks.cjs");

/** The real `useQuery` result shape, so every branch the screen reads exists. */
function queryResult<T>(over: Record<string, unknown> & { data?: T }) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

const EXPIRING = {
  id: "d1",
  code: "BLACKFRIDAY",
  percent_off: 20,
  max_redemptions: 500,
  times_redeemed: 42,
  expires_at: "2099-01-01T00:00:00.000Z",
};

function redemptionRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    discount_id: "d1",
    discount_code: "BLACKFRIDAY",
    subscriber_email: `u${i}@example.test`,
    redeemed_at: "2026-07-20T10:00:00.000Z",
  }));
}

function renderScreen() {
  return render(React.createElement(Discounts), {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

type View = Awaited<ReturnType<typeof renderScreen>>;

async function expandFirstRow(view: View) {
  await fireEvent.press(
    view.getByLabelText("Show recent redemptions for BLACKFRIDAY"),
  );
}

/**
 * The kill switch's spoken label (components/discounts/discountDeleteCopy).
 *
 * Derived from the copy module rather than typed out, so the cases asserting
 * its ABSENCE cannot silently start passing because someone reworded the label
 * — which would leave the screen offering an unreachable DELETE under a name
 * this file no longer looks for.
 */
const DELETE_LABEL = discountDeleteActionLabel("BLACKFRIDAY");

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  mockCatalogue.current = undefined;
  mockRedemptions.current = undefined;
  mockCheck.current = undefined;
  mockDeleteCalls.length = 0;
});

function seed(
  over: {
    checkData?: Record<string, unknown> | undefined;
    checkOver?: Record<string, unknown>;
    rows?: number;
  } = {},
) {
  mockCatalogue.current = queryResult({
    data: { value: [EXPIRING], fromSnapshot: false, capturedAt: null },
  });
  mockRedemptions.current = queryResult({
    data: redemptionRows(over.rows ?? 2),
  });
  mockCheck.current = queryResult({
    data: over.checkData,
    ...(over.checkOver ?? {}),
  });
}

describe("discounts screen", () => {
  it("lists a code with its derived status and lifetime totals", async () => {
    seed({ checkData: { currently_redeemable: true } });
    const view = await renderScreen();
    expect(view.getByText("BLACKFRIDAY")).toBeTruthy();
    // The chip counts are totals over the whole catalogue, spoken exactly.
    expect(view.getByLabelText("Active discounts, 1")).toBeTruthy();
  });

  it("says the deployment has no live probe, and where the status came from", async () => {
    // /check is unmounted, so there is no verdict to show. The provenance line
    // is what stops the derived pill above from reading as server-confirmed.
    seed({ checkData: undefined });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(view.getByText("No live re-check on this deployment")).toBeTruthy();
    expect(
      view.getByText(/derived from the code list, which can be up to a refresh old/),
    ).toBeTruthy();
  });

  it("will not render a verdict even when one is handed to it", async () => {
    // THE POINT OF THIS CASE. `useDiscountCheck` is mocked here, so it can be
    // made to resolve a perfectly good verdict regardless of what the server
    // mounts — which is exactly the shape of a cached answer surviving a
    // boundary change, or of a future refactor dropping the `enabled` gate.
    // DiscountRedeemability answers the boundary FIRST, before it looks at the
    // data, so a verdict from an unmounted probe cannot reach the screen.
    seed({ checkData: { currently_redeemable: true } });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(view.queryByText("Redeemable right now")).toBeNull();
    expect(view.getByText("No live re-check on this deployment")).toBeTruthy();
  });

  it("never turns a FAILED probe into a verdict", async () => {
    // The route exists now, so blaming the network is honest when it fails —
    // but the failure must still never be rendered as a redeemability verdict.
    // That half was always the point and does not change with the gate.
    seed({
      checkData: undefined,
      checkOver: { isError: true, error: new Error("network down") },
    });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(view.queryByText("Redeemable right now")).toBeNull();
  });

  it("hides Extend from a session whose role cannot PATCH", async () => {
    // EDITOR, stated out loud. PATCH carries ScopeAdmin, so editor is the
    // HIGHEST role that must not be offered this — the exact boundary, and the
    // only session shape where getting the gate wrong is plausible.
    //
    // The shared OPEN_GATE fixture defaults to `effectiveRole: "owner"`, so
    // leaving the role unset here does not produce a fail-closed session; it
    // produces the most privileged one there is, and this assertion would then
    // be asking an owner to be denied.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "editor" });
    seed({ checkData: { currently_redeemable: true } });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(
      view.queryByLabelText(
        "Extend the expiry or raise the redemption limit for BLACKFRIDAY",
      ),
    ).toBeNull();
  });

  it("hides Extend from an OWNER too, because the ROUTE gate binds", async () => {
    // The sibling above could pass on the role gate alone. This one cannot:
    // owner is the most privileged session there is, so the only thing that can
    // still hide Extend is `DISCOUNT_PATCH_MOUNTED`. Delete the route gate from
    // useDiscountsScreen and this is the case that goes red.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    seed({ checkData: undefined });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(
      view.queryByLabelText(
        "Extend the expiry or raise the redemption limit for BLACKFRIDAY",
      ),
    ).toBeNull();
    // Absent, not disabled: there is no such control in the tree at all.
    expect(view.queryByText("Extend")).toBeNull();
  });

  /**
   * The catalogue is VAULT-BACKED, and the vault is not shape-checked on read.
   *
   * `useDiscounts` resolves through `loadSnapshotBacked`, whose `readSnapshot`
   * accepts any blob with a numeric `capturedAt` and hands `cached.value`
   * straight back as `T` — no `Array.isArray`, no per-row parse
   * (lib/deliverabilitySnapshots.ts:117-126). So the value the screen renders on
   * a cold offline launch is whatever a PREVIOUS build of the app wrote to
   * SecureStore, and `discounts.data?.value ?? []` is a NULLISH guard that lets
   * `{}` and `{items: []}` through to `all.filter(...)` / `all.some(...)`.
   *
   * That is the api-keys "Invalid attempt to spread non-iterable instance"
   * crash with a different verb, and unlike a wire-shape drift it needs no
   * server change to reach: a stale blob on disk is enough.
   */
  // One `it()` per payload rather than a loop: RNTL's cleanup runs per test,
  // and four renders inside a single case leave the later assertions querying a
  // tree the framework has already torn down (the same trap the billing screen
  // test documents at its "separate it() rather than a rerender" comment).
  it.each([
    ["a bare object", {}],
    ["an enveloped list", { items: [] }],
    ["a string", "nope"],
    ["a number", 42],
  ])(
    "survives a vault snapshot whose value is %s, not an array",
    async (_label, hostile) => {
      mockCatalogue.current = queryResult({
        data: { value: hostile, fromSnapshot: false, capturedAt: 1 },
      });
      mockRedemptions.current = queryResult({ data: [] });
      mockCheck.current = queryResult({ data: undefined });

      // Mounting at all is the assertion: before the Array.isArray guard this
      // threw "all.some is not a function" out of useDiscountsScreen.
      const view = await renderScreen();
      expect(view.getByText("Discounts")).toBeTruthy();
      // And it degrades to "no codes", never to a half-rendered row.
      expect(view.queryByText("BLACKFRIDAY")).toBeNull();
      expect(view.getByLabelText("Active discounts, 0")).toBeTruthy();
    },
  );

  it("keeps Load more — the one drawer action backed by a mounted route", async () => {
    seed({ checkData: undefined, rows: 10 });
    const view = await renderScreen();
    await expandFirstRow(view);
    // 42 lifetime redemptions, 10 shown → 32 not shown, spoken exactly.
    expect(
      view.getByLabelText("Load more redemptions. 32 not shown."),
    ).toBeTruthy();
  });

  it("drops the CSV export while redemptions.csv is unmounted", async () => {
    // Owner session and 42 lifetime redemptions — every condition the export
    // needs except the route. "Load more" is asserted present in the sibling
    // above under the same fixture, so this is the route gate being read and
    // not the drawer failing to render its action row.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    seed({ checkData: undefined, rows: 10 });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(
      view.queryByLabelText(
        "Export every redemption of BLACKFRIDAY as a spreadsheet",
      ),
    ).toBeNull();
    expect(
      view.getByLabelText("Load more redemptions. 32 not shown."),
    ).toBeTruthy();
  });

  it("does not offer Load more when the window is not full", async () => {
    seed({ checkData: undefined, rows: 2 });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(view.queryByLabelText(/Load more redemptions/)).toBeNull();
  });

  /* ── the kill switch (DELETE /api/v1/discounts/{code}) ───────────────────
   *
   * This is the only verb on the screen that would STOP something, and it is
   * the one the boundary module was written around: "this code is on Reddit,
   * disable it from my phone at 2am". It is unmounted, and on this deployment
   * it could not have worked anyway — apps/api composes `discounts.Deps` with
   * no Stripe bridge, so `Repo.Delete` fails closed before it reads a row.
   *
   * So the cases below are about the absence being COMPLETE (no role reaches
   * it, no interaction sends the request) and being SPOKEN (the operator who
   * came here for this is told, and told where it can actually be done).
   * ------------------------------------------------------------------- */

  it("hides the kill switch from a session whose role cannot DELETE", async () => {
    // Kept from when the route was mounted, because it is still the sharper
    // half of the pair: editor is the highest role that must never see this, so
    // if the route ever comes back this case keeps guarding the role gate.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "editor" });
    seed({ checkData: { currently_redeemable: true } });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(view.queryByLabelText(DELETE_LABEL)).toBeNull();
  });

  it("hides the kill switch from an OWNER too, because the ROUTE gate binds", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    seed({ checkData: undefined });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(view.queryByLabelText(DELETE_LABEL)).toBeNull();
    expect(view.queryByText("Delete code")).toBeNull();
  });

  it("says out loud that the code cannot be withdrawn, and where it can", async () => {
    // The absence is not left as silence. An operator who opened this drawer
    // because a code leaked must not read a missing button as "already handled"
    // — and must be given the one place the coupon can actually be pulled.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    seed({ checkData: undefined });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(
      view.getByText("This code cannot be withdrawn from Moosewave"),
    ).toBeTruthy();
    expect(view.getByText(/no Moosewave surface exposes it/)).toBeTruthy();
    expect(view.getByText(/delete the coupon in Stripe/)).toBeTruthy();
    // Spoken as ONE stop, so VoiceOver does not read "cannot be withdrawn"
    // without the sentence that says what to do instead.
    expect(
      view.getByLabelText(
        /This code cannot be withdrawn from Moosewave\..*delete the coupon in Stripe\./s,
      ),
    ).toBeTruthy();
  });

  it("tells an EDITOR the same thing it tells an owner", async () => {
    // The notice is about the DEPLOYMENT, not about this session's privileges.
    // Wording it as "you do not have permission" would send an editor to ask an
    // admin who also cannot do it.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "editor" });
    seed({ checkData: undefined });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(
      view.getByText("This code cannot be withdrawn from Moosewave"),
    ).toBeTruthy();
  });

  it("sends no DELETE, whatever is pressed on the expanded row", async () => {
    // The transport mock records any call that reaches it, and `useConfirm()`
    // outside a ConfirmProvider resolves TRUE — so a kill switch that came back
    // un-gated would fire on the first press and land here. Pressing everything
    // the drawer still offers proves the request is not merely un-labelled.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    seed({ checkData: undefined, rows: 10 });
    const view = await renderScreen();
    await expandFirstRow(view);
    await fireEvent.press(
      view.getByLabelText("Load more redemptions. 32 not shown."),
    );
    await fireEvent.press(view.getByLabelText("Share code BLACKFRIDAY"));
    expect(mockDeleteCalls).toEqual([]);
    // And the row is still there: nothing optimistically removed a code that
    // was never withdrawn.
    expect(view.getByText("BLACKFRIDAY")).toBeTruthy();
  });

  it("keeps the typed-phrase copy ready for the day the route returns", async () => {
    // The confirm gate is not deleted with the button. `discountDeleteCopy`
    // still names the code and the 42 redemptions that would stop working, and
    // `discountDeleteCopy.test.ts` still asserts that wording without a
    // renderer — so remounting DELETE is a one-line change at the boundary, not
    // a rebuild of the destructive-confirm story.
    const copy = discountDeleteConfirmCopy({ code: "BLACKFRIDAY", used: 42 });
    expect(copy.confirmPhrase).toBe("BLACKFRIDAY");
    expect(copy.consequence).toContain("42");
    // ...and it is nowhere on the screen, because there is nothing to confirm.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    seed({ checkData: undefined });
    const view = await renderScreen();
    await expandFirstRow(view);
    expect(view.queryByText(copy.title)).toBeNull();
  });
});
