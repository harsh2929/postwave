/**
 * hooks/useDiscountOps.ts — the discount catalogue and its redemptions.
 *
 * Split out of hooks/useOps.ts, which is a residual "ops surface" module
 * explicitly asking each remaining resource family to leave when its screen is
 * next touched. Adding the offline snapshot (COMMERCE#15) pushed that file
 * past its source budget, and growing a catch-all is the wrong way to pay for
 * a feature: one endpoint family per module, parsing its payload at the
 * boundary, is the shape the rest of the deliverability split already has.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  REFERENCE_SNAPSHOT_MAX_BYTES,
  capRowsForVault,
  loadSnapshotBacked,
  snapshotScope,
  type SnapshotBacked,
} from "@/lib/deliverabilitySnapshots";
import {
  parseDiscountCheck,
  type DiscountCheck,
  type DiscountPatch,
} from "@/lib/discountEdit";
import { discountRedemptionsCsvPath } from "@/lib/discountExport";
import {
  DISCOUNT_DELETE_MOUNTED,
  DISCOUNT_LIVE_CHECK_MOUNTED,
  DISCOUNT_PATCH_MOUNTED,
  DISCOUNT_REDEMPTIONS_CSV_MOUNTED,
  discountArchiveRecordId,
} from "@/lib/discountMutationBoundary";

export interface DiscountRow {
  id: string;
  code: string;
  percent_off?: number | null;
  amount_off_cents?: number | null;
  currency?: string;
  max_redemptions?: number | null;
  times_redeemed: number;
  expires_at?: string | null;
  applies_to?: string;
  created_at?: string;
}

export interface DiscountRedemptionRow {
  id: string;
  discount_id?: string;
  discount_code?: string;
  subscriber_id?: string;
  subscriber_email?: string;
  /**
   * The archive's linkage bit. The mounted timeline returns whether the event
   * was tied to a subscriber and NEVER which one, so this is the only thing
   * that can be said about the actor without inventing an identity.
   */
  subscriber_linked?: boolean;
  redeemed_at: string;
}

/**
 * The discount catalogue, readable offline (COMMERCE#15).
 *
 * This was a plain gated query while its two siblings on the same screen
 * family (suppressions, inbound webhooks) both had snapshots, which is why
 * discounts.tsx had to render an apologetic "Discount codes aren't cached for
 * offline use" banner. A discount code is exactly the thing you need at a
 * conference stand with no signal, and the catalogue is small and slow-moving.
 *
 * The rows are capped before they reach the vault: `vaultSetJSON` silently
 * drops anything over 24 KB, so an uncapped write on a large catalogue would
 * cache NOTHING and say nothing about it.
 */
export function useDiscounts() {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  return useQuery({
    queryKey: [
      "discounts",
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      (gate.enabled && Boolean(gate.tenantId)) ||
      (gate.canReadOfflineSnapshots && Boolean(scope)),
    networkMode: "always",
    queryFn: (): Promise<SnapshotBacked<DiscountRow[]>> =>
      loadSnapshotBacked<DiscountRow[]>({
        resource: "discounts",
        scope,
        canUseNetwork: gate.enabled && Boolean(gate.tenantId),
        unavailableMessage:
          "You're offline and no discount snapshot has been saved yet.",
        loadNetwork: async () => {
          const { client } = getClient();
          // The SDK types this as DiscountListPage ({items, has_more}), so
          // a direct cast to "array or {items}" no longer overlaps and tsc
          // rejects it. Widen through unknown and keep BOTH shapes handled:
          // the typed page is what ships, and the bare-array branch stays as
          // the defensive read for a server answering the older shape.
          const res = (await client.discounts.list()) as unknown as
            | { items?: DiscountRow[] }
            | DiscountRow[];
          return Array.isArray(res)
            ? res
            : Array.isArray(res.items)
              ? res.items
              : [];
        },
        minimizeForSnapshot: (rows) =>
          capRowsForVault(rows, REFERENCE_SNAPSHOT_MAX_BYTES).rows,
      }),
  });
}

/** Rows in the first page of the drawer, and how many each "Load more" adds. */
export const REDEMPTION_PAGE_SIZE = 10;

/**
 * The server's own ceiling on `limit` for the archive timeline.
 * `archiveIntParam(r, "limit", 50, 1, 100)` REJECTS anything above it with a
 * 400 `invalid_pagination` rather than clamping, so a client that asks for more
 * gets no rows at all. This used to read 10,000, which is what the old
 * `intParam` tolerated.
 */
export const REDEMPTION_MAX_LIMIT = 100;

/**
 * Recent redemption EVENTS for one archive record.
 *
 * ADDRESSED BY RECORD ID, NOT BY CODE. The route moved to
 * `/api/v1/discounts/{record_id}/redemptions` and `canonicalArchiveUUID`
 * refuses anything that is not a canonical UUID — a redeemable code in that
 * slot is a 400, pinned by `TestListRedemptionsRejectsRedeemableCodePathValue`.
 * The catalogue is vault-backed, so a cold offline launch can replay rows an
 * older build wrote, and those carry a code where this now needs an ID.
 * `discountArchiveRecordId` answers that BEFORE a request is made, so an
 * unaddressable row leaves the query disabled instead of spending a round trip
 * on a guaranteed refusal.
 *
 * `limit` GROWS rather than paging with an offset: the rows are ordered
 * newest-first off a live table, so an offset page fetched after a new
 * redemption lands re-reads a row already on screen and silently drops the one
 * that shifted past the boundary. Re-asking for a bigger window is the same
 * number of round trips and cannot duplicate or skip.
 */
export function useDiscountRedemptions(
  recordId: string | null,
  limit: number = REDEMPTION_PAGE_SIZE,
) {
  const gate = useOnlineQueryGate();
  const canonical = discountArchiveRecordId(recordId);
  const bounded = Math.max(
    REDEMPTION_PAGE_SIZE,
    Math.min(REDEMPTION_MAX_LIMIT, Math.trunc(limit) || REDEMPTION_PAGE_SIZE),
  );
  return useQuery({
    queryKey: ["discount-redemptions", gate.tenantId, canonical, bounded],
    enabled: gate.enabled && Boolean(gate.tenantId && canonical),
    // Holding the previous window while a larger one loads is what makes
    // "Load more" read as growth rather than as the drawer emptying and
    // refilling: without it the rows unmount, the skeleton flashes, and the
    // scroll position the operator was reading from is lost.
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<DiscountRedemptionRow[]> => {
      if (!canonical) return [];
      const { client } = getClient();
      const res = await client.request<
        | DiscountRedemptionRow[]
        | { items?: DiscountRedemptionRow[]; data?: DiscountRedemptionRow[] }
      >(
        "GET",
        `/api/v1/discounts/${encodeURIComponent(canonical)}/redemptions?limit=${bounded}`,
      );
      const rows = Array.isArray(res) ? res : (res.items ?? res.data ?? []);
      // The archive event has no `id` — it is `{redeemed_at, subscriber_linked}`
      // and nothing else. The drawer keys its list on `id`, and `undefined` for
      // every row is one React key repeated N times, which reconciles the wrong
      // rows on a "Load more". Index-in-window is stable here precisely because
      // the window only ever GROWS from the newest end.
      return rows.map((row, index) => ({
        ...row,
        id: row.id ?? `${canonical}:${index}`,
      }));
    },
  });
}

/**
 * The live redeemability probe — GET /api/v1/discounts/{code}/check.
 *
 * The screen's own `statusOf()` derives expired/exhausted/active from the
 * `expires_at` and `max_redemptions` on the LIST row, which may have come out
 * of a twelve-hour offline snapshot. This route re-reads the row server-side
 * and runs `CheckRedeemable` — the same function the redeem path runs — so it
 * answers the actual support question ("the customer says it doesn't work")
 * rather than restating what the list already showed.
 *
 * Fetched only while a card is EXPANDED: a list of 200 codes must not fire
 * 200 probes to render a summary nobody asked to see.
 *
 * `retry: false` because the interesting failure is a 404 (the code no longer
 * exists for this tenant), and retrying it three times only delays saying so.
 */
export function useDiscountCheck(code: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["discount-check", gate.tenantId, code],
    // The probe route is NOT mounted, so this constant is false and the query
    // never runs. Unconditional, it would fire a guaranteed 404 on every card
    // expansion and render "Couldn't re-check this code" as if the network were
    // at fault. `DiscountRedeemability` renders the unavailable notice in its
    // place, so the silence is stated rather than left for the derived pill to
    // fill. See lib/discountMutationBoundary.
    enabled:
      DISCOUNT_LIVE_CHECK_MOUNTED &&
      gate.enabled &&
      Boolean(gate.tenantId && code),
    retry: false,
    // The whole value of this probe is that it is fresh; a cached answer is
    // exactly the stale list reading it exists to contradict.
    staleTime: 0,
    gcTime: 60_000,
    queryFn: async (): Promise<DiscountCheck> => {
      if (!code) return {};
      const { client } = getClient();
      return parseDiscountCheck(
        await client.request<unknown>(
          "GET",
          `/api/v1/discounts/${encodeURIComponent(code)}/check`,
        ),
      );
    },
  });
}

/**
 * Writes here are online-only and never queued.
 *
 * The offline mutation queue exists for writes whose meaning survives the
 * delay. This one's does not: "extend the expiry by seven days" is computed
 * against the expiry the row had when the sheet was open, and the server
 * rejects an `expires_at` earlier than the current one. Replayed an hour
 * later against a row someone else already extended, the queued patch is
 * either a no-op or a 400 nobody is watching for. An honest refusal at the
 * moment of the tap is the better failure.
 */
export class DiscountOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor(action: string) {
    super(`${action} needs a connection. Reconnect and try again.`);
    this.name = "DiscountOfflineError";
  }
}

/**
 * Refusal for a route this deployment does not mount.
 *
 * The screen already omits every affordance whose route is unmounted, so in
 * the shipped UI these mutations are unreachable. This is the second lock, and
 * it is not ceremony: these hooks are exported, the boundary is a compile-time
 * constant that CAN be flipped by hand, and the failure mode of getting it
 * wrong is a DELETE that answers 404 while the operator believes a leaked code
 * has been withdrawn. A dormant caller has to fail loudly, at the boundary,
 * before the request — the same shape `releaseHeldError` gives the web client
 * for coupon pools (apps/web/src/lib/discounts-api.ts).
 */
export class DiscountReleaseHeldError extends Error {
  readonly code = "route_not_mounted";

  constructor(capability: string) {
    super(
      `${capability} is not available on this deployment. The API does not mount this route.`,
    );
    this.name = "DiscountReleaseHeldError";
  }
}

/**
 * PATCH /api/v1/discounts/{code} — the additive-only edit. NOT MOUNTED: the
 * archive is read-only and the Go boundary test fails on any non-GET route.
 * Retained because the boundary has moved twice already and the mirror, not a
 * deletion, is what made each move safe — but it refuses before the request.
 *
 * Were it mounted it would carry `RequireScope(ScopeAdmin)`, which on the
 * session path maps onto an owner|admin ROLE check
 * (apps/api/internal/apikeys/middleware.go), so the caller would still need
 * `canAccessMinimumRole("admin", role, mode)` on top of the route gate.
 */
export function useUpdateDiscount() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { code: string; patch: DiscountPatch }) => {
      if (!DISCOUNT_PATCH_MOUNTED) {
        throw new DiscountReleaseHeldError("Editing a discount");
      }
      if (!isProbablyOnline()) throw new DiscountOfflineError("Editing a code");
      const { client } = getClient();
      return client.request<unknown>(
        "PATCH",
        `/api/v1/discounts/${encodeURIComponent(input.code)}`,
        { body: input.patch },
      );
    },
    onSuccess: (_data, input) => {
      // The catalogue carries the edited fields, and the probe's whole
      // premise is freshness — both have to be re-read, not patched in place.
      void queryClient.invalidateQueries({ queryKey: ["discounts", tenantId] });
      void queryClient.invalidateQueries({
        queryKey: ["discount-check", tenantId, input.code],
      });
    },
  });
}

/**
 * GET /api/v1/discounts/{code}/redemptions.csv, as text for the share sheet.
 * NOT MOUNTED: the whole-set CSV carries subscriber emails, which is precisely
 * what the mounted `{redeemed_at, subscriber_linked}` projection withholds.
 */
export function useExportDiscountRedemptions() {
  return useMutation({
    mutationFn: async (code: string): Promise<string> => {
      if (!DISCOUNT_REDEMPTIONS_CSV_MOUNTED) {
        throw new DiscountReleaseHeldError("Exporting redemptions");
      }
      if (!isProbablyOnline()) {
        throw new DiscountOfflineError("Exporting redemptions");
      }
      const { client } = getClient();
      return await client.request<string>(
        "GET",
        discountRedemptionsCsvPath(code),
        { asText: true },
      );
    },
  });
}


/**
 * DELETE /api/v1/discounts/{code} — the leaked-code kill switch. NOT MOUNTED,
 * and it is the one whose absence is worth stating out loud rather than merely
 * omitting a button for.
 *
 * IT IS THE ONE VERB THAT WOULD STOP SOMETHING. PATCH could not do it even
 * mounted: the server's edit is additive-only by rule (the cap cannot drop
 * below `times_redeemed`, the expiry cannot move earlier), so no amount of
 * editing takes a code circulating on Reddit out of circulation.
 *
 * IT COULD NOT COMPLETE ON THIS DEPLOYMENT ANYWAY. `Repo.Delete` returns
 * `ErrStripeBridgeUnavailable` when its bridge is nil, and `apps/api/main.go`
 * composes `&discounts.Deps{Repo: discountsRepo}` with no bridge at all. So the
 * honest client behaviour is not a hopeful request — it is
 * `DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE` in the drawer, naming the payment
 * provider as the only place the coupon can actually be withdrawn.
 *
 * Retained rather than deleted for the same reason as its siblings: this
 * boundary has moved twice, and the mirror is what made each move safe.
 */
export function useDeleteDiscount() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (code: string) => {
      if (!DISCOUNT_DELETE_MOUNTED) {
        throw new DiscountReleaseHeldError("Deleting a discount");
      }
      if (!isProbablyOnline()) throw new DiscountOfflineError("Deleting a code");
      const { client } = getClient();
      return client.request<unknown>(
        "DELETE",
        `/api/v1/discounts/${encodeURIComponent(code)}`,
      );
    },
    onSuccess: (_data, code) => {
      // The catalogue must lose the row; the per-code reads must be DROPPED
      // rather than invalidated, because refetching either one now is a
      // guaranteed 404 against a code that no longer exists.
      void queryClient.invalidateQueries({ queryKey: ["discounts", tenantId] });
      queryClient.removeQueries({
        queryKey: ["discount-check", tenantId, code],
      });
      queryClient.removeQueries({
        queryKey: ["discount-redemptions", tenantId, code],
      });
    },
  });
}
