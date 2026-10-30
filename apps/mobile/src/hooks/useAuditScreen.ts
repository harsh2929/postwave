/**
 * hooks/useAuditScreen.ts — the audit tab's filter state and everything
 * derived from it.
 *
 * Extracted from app/(tabs)/audit.tsx when the screen gained saved views, a
 * Security lens and a live tail: the screen file was heading past the 450-line
 * source budget, and — more usefully — the narrowing rules are now a thing
 * worth naming. Two of them are load-bearing and easy to get backwards:
 *
 *  - `since` IS PINNED TO A WINDOW ANCHOR, NOT TO NOW. A `Date.now()` inside
 *    the query key mints a new key on every render and refetches forever. The
 *    anchor only moves when the operator changes the window or refreshes.
 *  - THE ACTOR CHIP IS DROPPED WHEN THE GATE IS CLOSED. An actor filter on
 *    the wire disqualifies the offline vault snapshot; the chip is re-applied
 *    client-side either way, so the visible result is identical and the
 *    difference is a cached log instead of an error.
 */
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  anomalyIndex,
  useAuditCheckpoint,
  useAuditLog,
  useAuditStats,
  useRecentAuditAnomalies,
  type AuditRow,
} from "@/hooks/useAudit";
import {
  EMPTY_AUDIT_ADVANCED_FILTERS,
  hasAuditAdvancedFilters,
  normalizeAuditAdvancedFilters,
  type AuditAdvancedFilters,
} from "@/lib/auditAdvancedFilters";
import { useAuditTail } from "@/hooks/useAuditTail";
import { useDebounced } from "@/hooks/useDebounced";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { newestAuditId } from "@/lib/auditTail";
import { collapseInfiniteQueriesToFirstPage } from "@/lib/infiniteQueryRefresh";
import {
  auditWindowDescription,
  auditWindowSince,
  groupAuditRowsByDay,
  type AuditListItem,
} from "@/lib/auditGrouping";
import {
  classifyAction,
  matchesAuditActor,
  serverActorTypeFor,
} from "@/lib/auditSeverity";
import { auditActivitySummary } from "@/lib/auditStats";
import {
  DEFAULT_AUDIT_VIEW,
  isSecurityAction,
  type AuditViewState,
} from "@/lib/auditViews";

const PAGE_SIZE = 100;

/**
 * `initialView` seeds the filter set for a deep link that names a lens — e.g.
 * Settings' security-activity card handing off with `?lens=security`. It is an
 * INITIAL value only: it seeds `useState` and never re-applies, so a later
 * chip press is not clobbered by the URL the screen was opened with.
 */
export function useAuditScreen(initialView?: Partial<AuditViewState>) {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<AuditViewState>(() => ({
    ...DEFAULT_AUDIT_VIEW,
    ...(initialView ?? {}),
  }));
  const [liveTail, setLiveTail] = useState(false);
  const [windowAnchor, setWindowAnchor] = useState(() => Date.now());
  // The four extra server facets (action / resource type / resource id /
  // actor label). NOT part of AuditViewState on purpose: a saved view is a
  // recallable investigation shared with desktop, whereas these are the
  // transient "chase one resource right now" narrowing — and putting them in
  // the saved-view blob would change what desktop reads back.
  const [advanced, setAdvanced] = useState<AuditAdvancedFilters>(
    EMPTY_AUDIT_ADVANCED_FILTERS,
  );
  const debouncedQ = useDebounced(view.query, 200);

  const since = useMemo(
    () => auditWindowSince(view.windowKey, windowAnchor),
    [view.windowKey, windowAnchor],
  );
  const serverActorType = gate.enabled
    ? serverActorTypeFor(view.actor)
    : undefined;

  const filters = useMemo(() => {
    const adv = normalizeAuditAdvancedFilters(advanced);
    return {
      ...(serverActorType ? { actorType: serverActorType } : {}),
      ...(since ? { since } : {}),
      ...(adv.action ? { action: adv.action } : {}),
      ...(adv.resourceType ? { resourceType: adv.resourceType } : {}),
      ...(adv.resourceId ? { resourceId: adv.resourceId } : {}),
      ...(adv.actorLabel ? { actorLabel: adv.actorLabel } : {}),
    };
  }, [serverActorType, since, advanced]);

  const audit = useAuditLog(PAGE_SIZE, filters, { snapshotKey: view.windowKey });
  const anomalies = useRecentAuditAnomalies();
  const checkpoint = useAuditCheckpoint();
  const stats = useAuditStats(since);

  // The SAME `since` the list sends, so the summary and the feed can never
  // describe different windows.
  const activity = useMemo(
    () =>
      auditActivitySummary(stats.data, auditWindowDescription(view.windowKey)),
    [stats.data, view.windowKey],
  );

  const allRows: AuditRow[] = useMemo(
    () => (Array.isArray(audit.data?.pages) ? audit.data?.pages : []).flatMap((page) => page.rows),
    [audit.data],
  );
  const risks = useMemo(() => anomalyIndex(anomalies.data), [anomalies.data]);

  const filtered: AuditRow[] = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase();
    return allRows.filter((r) => {
      if (!matchesAuditActor(view.actor, r.actorType)) return false;
      if (view.destructiveOnly && classifyAction(r.action) !== "destructive") {
        return false;
      }
      if (view.securityOnly && !isSecurityAction(r.action)) return false;
      if (!needle) return true;
      return [
        r.action,
        r.resourceType ?? "",
        r.resourceId ?? "",
        r.actorType,
        r.actorLabel ?? "",
        r.ip ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [allRows, view.actor, view.destructiveOnly, view.securityOnly, debouncedQ]);

  const items: AuditListItem<AuditRow>[] = useMemo(
    () =>
      groupAuditRowsByDay(filtered, Date.now(), (row, index) =>
        row.id != null ? `row-${row.id}` : `row-idx-${index}`,
      ),
    [filtered],
  );

  const refresh = useManualRefresh(
    [
      () => {
        // Re-pinning the anchor moves `since`, and `since` is IN the key of
        // both the log and the stats query — so the same commit that refreshes
        // the window also retires the queries it was reading. The old version
        // re-pinned and then called `refetch()` on those retired queries:
        // `useAuditLog` is an infinite query, so TanStack refetched every
        // loaded page, meaning an operator six pages into an incident issued
        // six of the most expensive reads in the product for responses nothing
        // would ever render. The refresh they actually see is the newly-keyed
        // query mounting and fetching page one.
        //
        // Only the "all" window has no `since`; there the anchor move leaves
        // the key alone, so the explicit refetch IS the refresh and must stay.
        const nextAnchor = Date.now();
        const keyIsRetired =
          auditWindowSince(view.windowKey, nextAnchor) !== since;
        setWindowAnchor(nextAnchor);
        if (keyIsRetired) return Promise.resolve();
        // The "all" window falls through to an explicit refetch, and that is
        // the one path where the per-page cost above is still paid in full.
        // Collapsing to page one first makes the gesture cost one request —
        // the same thing the newly-keyed windows get for free by mounting at
        // page one (lib/infiniteQueryRefresh).
        collapseInfiniteQueriesToFirstPage(queryClient, ["audit", gate.tenantId]);
        return Promise.all([audit.refetch(), stats.refetch()]);
      },
      anomalies.refetch,
      checkpoint.refetch,
    ],
    { enabled: gate.enabled },
  );

  const tail = useAuditTail({
    enabled: liveTail,
    newestId: newestAuditId(allRows),
    filters,
  });

  /**
   * Replace the whole filter set at once (loading a saved view). The window
   * anchor is re-pinned in the same commit: a recalled view asking for "the
   * last 24 hours" must mean 24 hours from NOW, not from whenever this screen
   * was opened.
   */
  const applyView = useCallback((next: AuditViewState) => {
    setWindowAnchor(Date.now());
    setView(next);
    // A recalled view names its whole filter set. Leaving a transient
    // resource/actor facet applied underneath it would silently narrow the
    // view a colleague saved into something it never claimed to be.
    setAdvanced(EMPTY_AUDIT_ADVANCED_FILTERS);
  }, []);

  const patchView = useCallback(
    (patch: Partial<AuditViewState>) => {
      if (patch.windowKey !== undefined) setWindowAnchor(Date.now());
      setView((cur) => ({ ...cur, ...patch }));
    },
    [],
  );

  return {
    gate,
    view,
    applyView,
    patchView,
    advanced,
    setAdvanced,
    liveTail,
    setLiveTail,
    tail,
    filters,
    since,
    windowDescription: auditWindowDescription(view.windowKey),
    debouncedQ,
    audit,
    stats,
    activity,
    checkpoint,
    risks,
    allRows,
    filtered,
    items,
    refresh,
    isNarrowed:
      Boolean(debouncedQ.trim()) ||
      view.actor !== "all" ||
      view.destructiveOnly ||
      view.securityOnly ||
      hasAuditAdvancedFilters(advanced),
  };
}

export type AuditScreenController = ReturnType<typeof useAuditScreen>;

/**
 * The export controller's input, derived from the screen's own filter state —
 * in one place so the CSV can never quietly diverge from the screen that
 * launched it. Window + actor + the four advanced facets are REAL server
 * facets of the export job (exportAsyncReq); query/destructive/security ride
 * along only so the sheet can DISCLOSE the client-side narrowing the file
 * will not have.
 */
export function auditExportInputFromScreen(screen: AuditScreenController) {
  const actorType = serverActorTypeFor(screen.view.actor);
  return {
    ...(actorType ? { actorType } : {}),
    ...(screen.since ? { since: screen.since } : {}),
    ...(screen.filters.action ? { action: screen.filters.action } : {}),
    ...(screen.filters.resourceType
      ? { resourceType: screen.filters.resourceType }
      : {}),
    ...(screen.filters.resourceId
      ? { resourceId: screen.filters.resourceId }
      : {}),
    ...(screen.filters.actorLabel
      ? { actorLabel: screen.filters.actorLabel }
      : {}),
    windowDescription: auditWindowDescription(screen.view.windowKey),
    query: screen.debouncedQ,
    destructiveOnly: screen.view.destructiveOnly,
    securityOnly: screen.view.securityOnly,
  };
}
