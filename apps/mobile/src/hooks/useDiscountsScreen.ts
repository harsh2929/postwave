/**
 * hooks/useDiscountsScreen.ts — everything the Discounts screen decides,
 * lifted out of `app/(tabs)/discounts.tsx`.
 *
 * The screen went from one query to four (catalogue, redemptions, live
 * redeemability probe, CSV export) plus an edit sheet, and folding that into
 * the component body pushed it past the 300-line FUNCTION budget. Splitting
 * along the state/JSX seam rather than carving the JSX into fragments is the
 * honest cut: this file owns what the screen KNOWS, the component owns what it
 * LOOKS LIKE, and neither reaches into the other.
 *
 * THE SEARCH FILTER IS CLIENT-SIDE, AND NO LONGER BY PREFERENCE. `List` now
 * REJECTS `?q=` outright — `archiveQueryKeys(r, "limit", "offset", "record_id")`
 * answers 400 `invalid_query` for any other key, because searching the archive
 * by redeemable code would recreate a code-existence oracle. Sending the needle
 * to the server is therefore not an option to weigh; it is a 400. Filtering a
 * list the client already holds also keeps search working from the offline
 * snapshot and keeps the per-status chip counts totals over the WHOLE catalogue
 * rather than over the current result.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Share } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useDebounced } from "@/hooks/useDebounced";
import {
  REDEMPTION_PAGE_SIZE,
  useDeleteDiscount,
  useDiscountCheck,
  useDiscountRedemptions,
  useDiscounts,
  useExportDiscountRedemptions,
  type DiscountRow,
} from "@/hooks/useDiscountOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import {
  discountDeleteConfirmCopy,
  discountDeletedMessage,
} from "@/components/discounts/discountDeleteCopy";
import {
  redeemedCount,
  statusOf,
  type DiscountStatusLabel,
} from "@/components/discounts/discountStatus";
import {
  discountExportNotice,
  discountRedemptionsCsv,
} from "@/lib/discountExport";
import {
  DISCOUNT_PATCH_MOUNTED,
  DISCOUNT_REDEMPTIONS_CSV_MOUNTED,
  discountKillSwitchAvailable,
} from "@/lib/discountMutationBoundary";
import { errorPresentation } from "@/lib/errorCopy";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

export type DiscountStatusFilter = "all" | DiscountStatusLabel;

type ToastFn = (options: {
  kind: "success" | "error" | "warning" | "info";
  message: string;
}) => void;

export function useDiscountsScreen(toast: ToastFn) {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const confirm = useConfirm();
  const discounts = useDiscounts();

  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 200);
  const [filter, setFilter] = useState<DiscountStatusFilter>("all");
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(
    null,
  );
  const [redemptionLimit, setRedemptionLimit] = useState(REDEMPTION_PAGE_SIZE);
  const [editCode, setEditCode] = useState<string | null>(null);

  /**
   * KEYED ON THE ARCHIVE RECORD ID, NOT ON THE CODE. The mounted timeline is
   * `/api/v1/discounts/{record_id}/redemptions` and refuses a redeemable code
   * in that slot with a 400. `id` is the one identifier present in BOTH the
   * archive projection and the older snapshot rows still in the vault, so it is
   * the only key that can address the route at all.
   */
  const redemptions = useDiscountRedemptions(expandedRecordId, redemptionLimit);
  /**
   * The probe is unmounted, so this never runs. Note for whoever remounts it:
   * `/check` is `{code}`-addressed and the archive serializes no code, so a
   * green mirror is NOT on its own enough to make this work again.
   */
  const check = useDiscountCheck(expandedRecordId);
  const exportCsv = useExportDiscountRedemptions();
  const removeDiscount = useDeleteDiscount();

  /**
   * COMMERCE#40: `statusOf` compares `expires_at` against the clock DURING
   * render, and nothing used to schedule a render at the expiry boundary — so
   * a code that lapsed while the screen sat open kept its green "active" pill
   * until something else happened to re-render. The ticker runs only while
   * there is an expiry still in the future to cross; on a catalogue where
   * everything has already expired (or nothing expires at all) it never starts.
   */
  /**
   * `Array.isArray`, not `?? []`. This catalogue is VAULT-BACKED: `useDiscounts`
   * resolves through `loadSnapshotBacked`, whose `readSnapshot` accepts any
   * stored blob with a numeric `capturedAt` and returns `cached.value` as `T`
   * without checking its shape (lib/deliverabilitySnapshots.ts:117-126). So on a
   * cold offline launch `value` is whatever a PREVIOUS build of the app wrote to
   * SecureStore, and a nullish guard passes `{}` / `{items: []}` straight into
   * `all.some(...)` and `all.filter(...)` below — the api-keys "Invalid attempt
   * to spread non-iterable instance" crash with a different verb, reachable
   * with no server change at all.
   */
  const all: DiscountRow[] = useMemo(
    () => (Array.isArray(discounts.data?.value) ? discounts.data.value : []),
    [discounts.data],
  );
  const hasPendingExpiry = useMemo(
    () => all.some((d) => statusOf(d).label === "active" && Boolean(d.expires_at)),
    [all],
  );
  /**
   * BUCKETED TO THE MINUTE, deliberately. The hook's default runs at 1 Hz
   * because that is what a "3 seconds ago" badge needs; an expiry is a
   * minute-scale boundary. Feeding a raw tick into the filter would re-filter
   * the whole catalogue every second AND change `now`'s value on every
   * memoised card, re-rendering every visible row once a second for a fact
   * that changes once. The cost is that a code lapsing at 12:00:30 flips at
   * 12:01:00.
   *
   * Bucketing inside the hook (this was `Math.floor(tick / 60_000)` here) also
   * suppresses the state update on the 59 ticks a minute that cannot change a
   * character, so the SCREEN stops re-rendering too: 60/min → 1.
   */
  const now = useTickingNow(hasPendingExpiry, MINUTE_MS);

  const rows: DiscountRow[] = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase();
    return all.filter((d) => {
      if (filter !== "all" && statusOf(d, now).label !== filter) return false;
      if (!needle) return true;
      return (d.code ?? "").toLowerCase().includes(needle);
    });
  }, [all, debouncedQ, filter, now]);

  // Collapse a stale expansion: if the expanded row gets filtered/searched out
  // of view, stop fetching its redemptions and its probe.
  useEffect(() => {
    if (expandedRecordId && !rows.some((d) => d.id === expandedRecordId)) {
      setExpandedRecordId(null);
    }
  }, [rows, expandedRecordId]);

  // Per-status counts + lifetime redemptions, over the FULL list rather than
  // the filtered view, so each chip shows its own total bucket.
  const summary = useMemo(() => {
    const c = { all: all.length, active: 0, exhausted: 0, expired: 0 };
    let redeemed = 0;
    for (const d of all) {
      c[statusOf(d, now).label] += 1;
      redeemed += redeemedCount(d);
    }
    return { ...c, redemptions: redeemed };
  }, [all, now]);

  const editRow = useMemo(
    () => all.find((d) => d.code === editCode) ?? null,
    [all, editCode],
  );

  const onToggle = useCallback((recordId: string) => {
    // A fresh expansion starts at page one; carrying a grown window across
    // records would make the next drawer request 200 rows nobody asked for.
    setRedemptionLimit(REDEMPTION_PAGE_SIZE);
    setExpandedRecordId((current) => (current === recordId ? null : recordId));
  }, []);

  const onLoadMore = useCallback(() => {
    haptics.tap();
    setRedemptionLimit((n) => n + REDEMPTION_PAGE_SIZE);
  }, []);

  const onShare = useCallback(
    (code: string) => {
      void Share.share({ message: code }).catch(() => {
        // A failed share is a RESULT, not a question: it belongs in the toast
        // lane, not in an OS dialog that costs a tap to dismiss.
        toast({ kind: "error", message: "Couldn't open the share sheet." });
      });
    },
    [toast],
  );

  /**
   * The CSV export. The server's own writer does not neutralise a leading
   * `=`/`+`/`-`/`@`, and a subscriber's email local part legitimately begins
   * with `+`, so the text is parsed and re-emitted through `discountExportRows`
   * before it reaches a spreadsheet. `total` comes from the row, so the notice
   * can say what fraction was shared instead of implying completeness.
   */
  const onExport = useCallback(
    (code: string, total: number) => {
      exportCsv.mutate(code, {
        onSuccess: (raw) => {
          const result = discountRedemptionsCsv(raw, { code, total });
          const notice = discountExportNotice(result);
          if (result.included === 0) {
            toast({ kind: "info", message: notice });
            return;
          }
          void Share.share({ message: result.body, title: result.title })
            .then(() => toast({ kind: "success", message: notice }))
            .catch(() =>
              toast({ kind: "error", message: "Couldn't open the share sheet." }),
            );
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({ kind: "error", message: errorPresentation(e).message });
        },
      });
    },
    [exportCsv, toast],
  );

  const onEdit = useCallback((code: string) => setEditCode(code), []);
  const closeEdit = useCallback(() => setEditCode(null), []);

  /**
   * The kill switch. DELETE /api/v1/discounts/{code}.
   *
   * The confirm is not ceremony. This is the only verb on the screen that
   * cannot be walked back — the server drops the row AND the Stripe coupon —
   * and it is reached from a list where the neighbouring control is "Extend",
   * so the phrase gate is what separates "stop this leak" from a mis-tap on a
   * moving bus. `discountDeleteConfirmCopy` owns the words; the collapse below
   * is what makes the row disappear from under the drawer that asked for it.
   */
  const onDelete = useCallback(
    async (code: string, used: number) => {
      const ok = await confirm(discountDeleteConfirmCopy({ code, used }));
      if (!ok) return;
      try {
        await removeDiscount.mutateAsync(code);
        haptics.success();
        // The expanded drawer is a window onto a code that no longer exists;
        // leaving it open would keep a dead probe and a dead redemptions read
        // on screen under a row the catalogue refetch is about to remove.
        setExpandedRecordId((current) => (current === code ? null : current));
        setEditCode((current) => (current === code ? null : current));
        toast({ kind: "success", message: discountDeletedMessage(code) });
      } catch (e: unknown) {
        // A failure here is a REAL outcome, not a transport hiccup: the
        // handler answers ErrStripeBridgeUnavailable when the provider bridge
        // is absent, so "it didn't work" has to survive as "it didn't work"
        // rather than as an optimistic row disappearing.
        haptics.error();
        toast({ kind: "error", message: errorPresentation(e).message });
      }
    },
    [confirm, removeDiscount, toast],
  );

  /**
   * TWO INDEPENDENT GATES PER MUTATION, and both have to pass.
   *
   * The ROLE gate: PATCH and DELETE both carry ScopeAdmin, which on the
   * session path is an owner|admin ROLE check, so an editor would get a 403
   * after a hopeful-looking sheet.
   *
   * The ROUTE gate: `lib/discountMutationBoundary` mirrors what `MountRoutes`
   * actually registers, and its guard test parses the Go source, so a route
   * that goes away takes its affordance with it instead of leaving a button
   * that 404s. PATCH and DELETE are BOTH unmounted today — the A1 release that
   * opened them (2026-08-18) was reversed — so the route gate is the binding
   * one for both and no role can reach them.
   *
   * The kill switch is asked for as a QUESTION rather than read as a flag —
   * `discountKillSwitchAvailable()` — because the capability is "can some
   * route take a leaked code out of circulation", and PATCH is not an answer
   * to it: the server's edit is additive-only by rule (the cap cannot drop
   * below `times_redeemed`, the expiry cannot move earlier), so only DELETE
   * stops a code that is already circulating.
   *
   * Affordances that fail either gate arrive at the drawer as null and are
   * omitted rather than disabled: a disabled button on a phone is a promise
   * you cannot keep.
   */
  const isAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const canEdit = DISCOUNT_PATCH_MOUNTED && isAdmin;
  const canDelete = discountKillSwitchAvailable() && isAdmin;
  const loadedRedemptions = redemptions.data?.length ?? 0;

  return {
    gate,
    discounts,
    all,
    rows,
    summary,
    q,
    setQ,
    debouncedQ,
    filter,
    setFilter,
    expandedRecordId,
    onToggle,
    redemptions,
    check,
    editRow,
    closeEdit,
    onShare,
    onExport: DISCOUNT_REDEMPTIONS_CSV_MOUNTED ? onExport : null,
    onLoadMore,
    /** A full page back means the server may hold more; the empty case is exact. */
    canLoadMore: loadedRedemptions > 0 && loadedRedemptions >= redemptionLimit,
    /** Growth, not a cold load: `placeholderData` keeps the previous window. */
    loadingMore: redemptions.isFetching && loadedRedemptions > 0,
    exporting: exportCsv.isPending,
    onEdit: canEdit ? onEdit : null,
    onDelete: canDelete ? onDelete : null,
    deleting: removeDiscount.isPending,
    hasFilter: debouncedQ.trim().length > 0 || filter !== "all",
    /**
     * The SAME clock the chip counts were computed against. Without it the
     * card derives its pill from `Date.now()` inside a memoised render that
     * nothing invalidates, so a code that lapsed while the screen sat open
     * kept a green "active" pill under an "Expired 1" chip.
     */
    now,
  };
}
