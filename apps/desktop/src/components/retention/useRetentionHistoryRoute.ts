import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RetentionOfferHistoryRow } from "../../lib/retention-offers-contract";
import type {
  RetentionDiscountFilter,
  RetentionEvidenceFilter,
  RetentionHistorySort,
  RetentionStatusFilter,
} from "../../lib/retention-offers-view-model";
import {
  getDesktopRoute,
  requestDesktopRouteBackNavigation,
  requestDesktopRouteNavigation,
  serializeDesktopRoute,
  type DesktopRoute,
  type DesktopRouteSnapshot,
  type DesktopNavigateOptions,
  useDesktopRouteSnapshot,
} from "../../lib/desktop-router";
import {
  canonicalRetentionHistoryRoute,
  isCanonicalRetentionHistoryRoute,
  retentionHistoryViewFromRoute,
  retentionOfferDetailRouteId,
  routeWithRetentionHistoryView,
  routeWithRetentionOfferDetail,
  routeWithoutRetentionOfferDetail,
  type RetentionHistoryRouteView,
  type RetentionHistoryTab,
} from "./retention-history-route";

interface RetentionHistoryRouteOptions {
  rows: readonly RetentionOfferHistoryRow[];
  rowsReady: boolean;
  rowsStale?: boolean;
  identityScope: string;
}

interface BlockedRouteRepair {
  originCanonicalUrl: string;
  target: DesktopRoute;
}

export interface RetentionHistoryRouteController {
  view: RetentionHistoryRouteView;
  selectedRow: RetentionOfferHistoryRow | null;
  announcement: string;
  repairBlocked: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  setTab: (tab: RetentionHistoryTab) => void;
  setQuery: (query: string) => void;
  setStatus: (status: RetentionStatusFilter) => void;
  setDiscount: (discount: RetentionDiscountFilter) => void;
  setEvidence: (evidence: RetentionEvidenceFilter) => void;
  setSort: (sort: RetentionHistorySort) => void;
  setPage: (page: number) => void;
  replacePage: (page: number) => void;
  retryBlockedRepair: () => void;
  openOffer: (
    row: RetentionOfferHistoryRow,
    invoker: HTMLElement | null,
  ) => void;
  closeOffer: () => void;
}

type RouteAnnouncement = (message: string) => void;
type RouteRequester = (
  route: DesktopRoute,
  options?: DesktopNavigateOptions,
) => ReturnType<typeof requestDesktopRouteNavigation>;

interface BoundRouteIntent {
  isLatest: () => boolean;
  isStillCurrent: () => boolean;
}

interface RouteIntentRequest {
  canHandleResult: () => boolean;
  result: ReturnType<typeof requestDesktopRouteNavigation>;
}

type RouteIntentRequester = (
  route: DesktopRoute,
  options?: DesktopNavigateOptions,
) => RouteIntentRequest;

interface RouteAnnouncementState {
  announcement: string;
  announce: RouteAnnouncement;
  mountedRef: RefObject<boolean>;
}

interface IdentityBoundRouteNavigation {
  identityScopeRef: RefObject<string>;
  invalidateRouteIntents: () => void;
  beginRouteIntent: () => BoundRouteIntent;
  requestNavigation: RouteRequester;
  requestNavigationWithIntent: RouteIntentRequester;
}

interface LocalRetentionHistory {
  baseCanonicalUrl: string;
  detailCanonicalUrl: string;
}

function stillOwnsLocalRetentionHistory(
  localHistory: LocalRetentionHistory,
  previousCanonicalUrl: string,
  currentCanonicalUrl: string,
  source: DesktopRouteSnapshot["source"],
): boolean {
  const remainsAtOwnedEndpoint =
    currentCanonicalUrl === localHistory.baseCanonicalUrl ||
    currentCanonicalUrl === localHistory.detailCanonicalUrl;
  if (!remainsAtOwnedEndpoint) return false;
  if (previousCanonicalUrl === currentCanonicalUrl) return true;
  if (source !== "history") return false;
  return (
    (previousCanonicalUrl === localHistory.detailCanonicalUrl &&
      currentCanonicalUrl === localHistory.baseCanonicalUrl) ||
    (previousCanonicalUrl === localHistory.baseCanonicalUrl &&
      currentCanonicalUrl === localHistory.detailCanonicalUrl)
  );
}

interface RetentionDetailActionOptions {
  announce: RouteAnnouncement;
  beginRouteIntent: () => BoundRouteIntent;
  closeInFlightRef: RefObject<boolean>;
  identityScopeRef: RefObject<string>;
  localHistoryRef: RefObject<LocalRetentionHistory | null>;
  mountedRef: RefObject<boolean>;
  requestNavigation: RouteRequester;
  returnFocusRef: RefObject<HTMLElement | null>;
}

interface BlockedRouteRepairRetryOptions {
  announce: RouteAnnouncement;
  blockedRepair: BlockedRouteRepair | null;
  identityScopeRef: RefObject<string>;
  mountedRef: RefObject<boolean>;
  requestNavigationWithIntent: RouteIntentRequester;
  setBlockedRepair: (repair: BlockedRouteRepair | null) => void;
}

function useRouteAnnouncement(): RouteAnnouncementState {
  const [announcement, setAnnouncement] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const announce = useCallback((message: string): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAnnouncement(message);
    if (!message) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (mountedRef.current) setAnnouncement("");
    }, 8_000);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return { announcement, announce, mountedRef };
}

function useIdentityBoundRouteNavigation(
  identityScope: string,
  mountedRef: RefObject<boolean>,
): IdentityBoundRouteNavigation {
  const identityScopeRef = useRef(identityScope);
  identityScopeRef.current = identityScope;
  const routeIntentRef = useRef(0);
  const invalidateRouteIntents = useCallback((): void => {
    routeIntentRef.current += 1;
  }, []);
  const beginRouteIntent = useCallback(() => {
    const initiatingIdentity = identityScopeRef.current;
    const initiatingCanonicalUrl = serializeDesktopRoute(getDesktopRoute());
    const intent = ++routeIntentRef.current;
    const isLatest = (): boolean =>
      mountedRef.current &&
      identityScopeRef.current === initiatingIdentity &&
      routeIntentRef.current === intent;
    return {
      isLatest,
      isStillCurrent: (): boolean =>
        isLatest() &&
        serializeDesktopRoute(getDesktopRoute()) === initiatingCanonicalUrl,
    };
  }, [mountedRef]);
  const requestNavigationWithIntent = useCallback<RouteIntentRequester>(
    (route, options) => {
      const intent = beginRouteIntent();
      const callerGuard = options?.isStillCurrent;
      const canHandleResult = (): boolean =>
        intent.isLatest() && callerGuard?.() !== false;
      const result = requestDesktopRouteNavigation(route, {
        ...options,
        isStillCurrent: () =>
          intent.isStillCurrent() && callerGuard?.() !== false,
      });
      return { canHandleResult, result };
    },
    [beginRouteIntent],
  );
  const requestNavigation = useCallback<RouteRequester>(
    (route, options) => requestNavigationWithIntent(route, options).result,
    [requestNavigationWithIntent],
  );

  return {
    identityScopeRef,
    invalidateRouteIntents,
    beginRouteIntent,
    requestNavigation,
    requestNavigationWithIntent,
  };
}

function useRetentionHistoryViewMutators(
  announce: RouteAnnouncement,
  requestNavigation: RouteRequester,
): Pick<
  RetentionHistoryRouteController,
  | "setTab"
  | "setQuery"
  | "setStatus"
  | "setDiscount"
  | "setEvidence"
  | "setSort"
  | "setPage"
  | "replacePage"
> {
  const commitView = useCallback(
    (
      update: (current: RetentionHistoryRouteView) => RetentionHistoryRouteView,
      replace = false,
    ): void => {
      announce("");
      const currentRoute = getDesktopRoute();
      const currentView = retentionHistoryViewFromRoute(currentRoute);
      void requestNavigation(
        routeWithRetentionHistoryView(currentRoute, update(currentView)),
        { replace, source: "navigation" },
      );
    },
    [announce, requestNavigation],
  );

  const setTab = useCallback(
    (tab: RetentionHistoryTab): void => {
      commitView((current) => ({ ...current, tab }));
    },
    [commitView],
  );
  const setQuery = useCallback(
    (query: string): void => {
      commitView((current) => ({ ...current, query, page: 1 }), true);
    },
    [commitView],
  );
  const setStatus = useCallback(
    (status: RetentionStatusFilter): void => {
      commitView((current) => ({ ...current, status, page: 1 }));
    },
    [commitView],
  );
  const setDiscount = useCallback(
    (discount: RetentionDiscountFilter): void => {
      commitView((current) => ({ ...current, discount, page: 1 }));
    },
    [commitView],
  );
  const setEvidence = useCallback(
    (evidence: RetentionEvidenceFilter): void => {
      commitView((current) => ({ ...current, evidence, page: 1 }));
    },
    [commitView],
  );
  const setSort = useCallback(
    (sort: RetentionHistorySort): void => {
      commitView((current) => ({ ...current, sort, page: 1 }));
    },
    [commitView],
  );
  const setPage = useCallback(
    (page: number): void => {
      commitView((current) => ({ ...current, page }));
    },
    [commitView],
  );
  const replacePage = useCallback(
    (page: number): void => {
      commitView((current) => ({ ...current, page }), true);
    },
    [commitView],
  );

  return {
    setTab,
    setQuery,
    setStatus,
    setDiscount,
    setEvidence,
    setSort,
    setPage,
    replacePage,
  };
}

function useSelectedRetentionRow(
  rows: readonly RetentionOfferHistoryRow[],
  routedId: string | null,
): RetentionOfferHistoryRow | null {
  return useMemo(
    () =>
      routedId === null
        ? null
        : (rows.find((row) => row.offer.id === routedId) ?? null),
    [routedId, rows],
  );
}

function useBlockedRouteRepairRetry({
  announce,
  blockedRepair,
  identityScopeRef,
  mountedRef,
  requestNavigationWithIntent,
  setBlockedRepair,
}: BlockedRouteRepairRetryOptions): () => void {
  return useCallback((): void => {
    if (blockedRepair === null) return;
    const pendingRepair = blockedRepair;
    if (
      serializeDesktopRoute(getDesktopRoute()) !==
      pendingRepair.originCanonicalUrl
    ) {
      setBlockedRepair(null);
      return;
    }
    const initiatingIdentity = identityScopeRef.current;
    setBlockedRepair(null);
    announce("Retrying the blocked retention route repair.");
    const navigation = requestNavigationWithIntent(pendingRepair.target, {
      replace: true,
      source: "navigation",
    });
    void navigation.result.then((result) => {
      if (
        !navigation.canHandleResult() ||
        !mountedRef.current ||
        identityScopeRef.current !== initiatingIdentity
      ) {
        return;
      }
      if (result === "proceeded") {
        if (
          serializeDesktopRoute(getDesktopRoute()) ===
          serializeDesktopRoute(pendingRepair.target)
        ) {
          announce("The retention route repair completed.");
        }
        return;
      }
      if (
        serializeDesktopRoute(getDesktopRoute()) !==
        pendingRepair.originCanonicalUrl
      ) {
        return;
      }
      setBlockedRepair(pendingRepair);
      announce(
        "The retention route repair is still blocked and can be retried.",
      );
    });
  }, [
    announce,
    blockedRepair,
    identityScopeRef,
    mountedRef,
    requestNavigationWithIntent,
    setBlockedRepair,
  ]);
}

function useRetentionDetailActions({
  announce,
  beginRouteIntent,
  closeInFlightRef,
  identityScopeRef,
  localHistoryRef,
  mountedRef,
  requestNavigation,
  returnFocusRef,
}: RetentionDetailActionOptions): Pick<
  RetentionHistoryRouteController,
  "openOffer" | "closeOffer"
> {
  const openOffer = useCallback(
    (row: RetentionOfferHistoryRow, invoker: HTMLElement | null): void => {
      const initiatingIdentity = identityScopeRef.current;
      const id = row.offer.id.trim().toLowerCase();
      const currentRoute = canonicalRetentionHistoryRoute(getDesktopRoute());
      const baseRoute = routeWithoutRetentionOfferDetail(currentRoute);
      const targetRoute = routeWithRetentionOfferDetail(baseRoute, id);
      if (retentionOfferDetailRouteId(targetRoute) !== id) {
        announce(
          "This retention record cannot be opened because its reference is invalid.",
        );
        return;
      }
      const localHistory = {
        baseCanonicalUrl: serializeDesktopRoute(baseRoute),
        detailCanonicalUrl: serializeDesktopRoute(targetRoute),
      };
      returnFocusRef.current = invoker;
      announce("");
      void requestNavigation(targetRoute, { source: "navigation" }).then(
        (result) => {
          if (
            !mountedRef.current ||
            identityScopeRef.current !== initiatingIdentity ||
            result !== "proceeded" ||
            retentionOfferDetailRouteId(getDesktopRoute()) !== id
          ) {
            if (returnFocusRef.current === invoker) {
              returnFocusRef.current = null;
            }
            return;
          }
          localHistoryRef.current = localHistory;
        },
      );
    },
    [
      announce,
      identityScopeRef,
      localHistoryRef,
      mountedRef,
      requestNavigation,
      returnFocusRef,
    ],
  );

  const closeOffer = useCallback((): void => {
    announce("");
    if (closeInFlightRef.current) return;
    const currentRoute = getDesktopRoute();
    if (!retentionOfferDetailRouteId(currentRoute)) return;
    const targetRoute = routeWithoutRetentionOfferDetail(currentRoute);
    const localHistory = localHistoryRef.current;
    const ownsPushedEntry = Boolean(
      localHistory &&
      localHistory.detailCanonicalUrl === serializeDesktopRoute(currentRoute) &&
      localHistory.baseCanonicalUrl === serializeDesktopRoute(targetRoute),
    );
    closeInFlightRef.current = true;
    const routeIntent = beginRouteIntent();
    const { isStillCurrent } = routeIntent;
    void (async () => {
      let result = ownsPushedEntry
        ? await requestDesktopRouteBackNavigation(targetRoute, isStillCurrent)
        : await requestDesktopRouteNavigation(targetRoute, {
            replace: true,
            source: "navigation",
            isStillCurrent,
          });
      if (result === "failed" && ownsPushedEntry && isStillCurrent()) {
        result = await requestDesktopRouteNavigation(targetRoute, {
          replace: true,
          source: "navigation",
          isStillCurrent,
        });
      }
      if (!routeIntent.isLatest() || result !== "proceeded") {
        closeInFlightRef.current = false;
      }
    })();
  }, [announce, beginRouteIntent, closeInFlightRef, localHistoryRef]);

  return { openOffer, closeOffer };
}

export function useRetentionHistoryRoute({
  rows,
  rowsReady,
  rowsStale = false,
  identityScope,
}: RetentionHistoryRouteOptions): RetentionHistoryRouteController {
  const snapshot = useDesktopRouteSnapshot();
  const view = retentionHistoryViewFromRoute(snapshot.route);
  const routedId = retentionOfferDetailRouteId(snapshot.route);
  const selectedRow = useSelectedRetentionRow(rows, routedId);
  const { announcement, announce, mountedRef } = useRouteAnnouncement();
  const [blockedRepair, setBlockedRepair] = useState<BlockedRouteRepair | null>(
    null,
  );
  const {
    identityScopeRef,
    invalidateRouteIntents,
    beginRouteIntent,
    requestNavigation,
    requestNavigationWithIntent,
  } = useIdentityBoundRouteNavigation(identityScope, mountedRef);
  const closeInFlightRef = useRef(false);
  const missingRepairRef = useRef<string | null>(null);
  const previousCanonicalUrlRef = useRef(snapshot.canonicalUrl);
  const previousIdentityRef = useRef(identityScope);
  const previousRoutedIdRef = useRef<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const localHistoryRef = useRef<LocalRetentionHistory | null>(null);

  useEffect(() => {
    if (isCanonicalRetentionHistoryRoute(snapshot.route)) {
      setBlockedRepair((current) =>
        current !== null && current.originCanonicalUrl !== snapshot.canonicalUrl
          ? null
          : current,
      );
      return;
    }
    const hadInvalidDetailIntent =
      (snapshot.route.overlay?.name === "retention-offer-detail" ||
        snapshot.route.resourceId !== undefined) &&
      routedId === null;
    const canonicalRoute = canonicalRetentionHistoryRoute(snapshot.route);
    const originCanonicalUrl = snapshot.canonicalUrl;
    const targetCanonicalUrl = serializeDesktopRoute(canonicalRoute);
    const initiatingIdentity = identityScope;
    const navigation = requestNavigationWithIntent(canonicalRoute, {
      replace: true,
      source: "navigation",
    });
    void navigation.result.then((result) => {
      if (
        !navigation.canHandleResult() ||
        !mountedRef.current ||
        identityScopeRef.current !== initiatingIdentity
      ) {
        return;
      }
      if (result === "proceeded") {
        if (serializeDesktopRoute(getDesktopRoute()) !== targetCanonicalUrl) {
          return;
        }
        setBlockedRepair(null);
        if (hadInvalidDetailIntent) {
          announce(
            "The requested retention record reference was invalid and has been removed.",
          );
        }
        return;
      }
      if (serializeDesktopRoute(getDesktopRoute()) !== originCanonicalUrl) {
        return;
      }
      setBlockedRepair({
        originCanonicalUrl,
        target: canonicalRoute,
      });
      announce(
        "The invalid retention route could not be repaired because navigation was blocked.",
      );
    });
  }, [
    announce,
    identityScope,
    requestNavigationWithIntent,
    routedId,
    snapshot.canonicalUrl,
    snapshot.route,
  ]);

  useEffect(() => {
    const identityChanged = previousIdentityRef.current !== identityScope;
    previousIdentityRef.current = identityScope;
    const previousCanonicalUrl = previousCanonicalUrlRef.current;
    previousCanonicalUrlRef.current = snapshot.canonicalUrl;
    const previousRoutedId = previousRoutedIdRef.current;
    previousRoutedIdRef.current = routedId;
    if (identityChanged) {
      invalidateRouteIntents();
      closeInFlightRef.current = false;
      localHistoryRef.current = null;
      missingRepairRef.current = null;
      returnFocusRef.current = null;
      setBlockedRepair(null);
      announce("");
    }

    if (previousRoutedId && previousRoutedId !== routedId) {
      closeInFlightRef.current = false;
      missingRepairRef.current = null;
    }

    const localHistory = localHistoryRef.current;
    if (
      localHistory &&
      !stillOwnsLocalRetentionHistory(
        localHistory,
        previousCanonicalUrl,
        snapshot.canonicalUrl,
        snapshot.source,
      )
    ) {
      localHistoryRef.current = null;
    }

    if (routedId) return;

    if (previousRoutedId) {
      closeInFlightRef.current = false;
      missingRepairRef.current = null;
    }
  }, [
    announce,
    identityScope,
    invalidateRouteIntents,
    routedId,
    snapshot.canonicalUrl,
    snapshot.route,
    snapshot.source,
  ]);

  useEffect(() => {
    if (!routedId || !selectedRow) return;
    missingRepairRef.current = null;
    announce("");
  }, [announce, routedId, selectedRow]);

  useEffect(() => {
    if (
      !rowsReady ||
      !routedId ||
      selectedRow ||
      missingRepairRef.current === routedId
    ) {
      return;
    }
    missingRepairRef.current = routedId;
    closeInFlightRef.current = false;
    localHistoryRef.current = null;
    const snapshotLabel = rowsStale
      ? "last verified offer-row response"
      : "current verified offer-row response";
    announce(
      `The requested retention record is not present in the ${snapshotLabel} and is being closed.`,
    );
    const currentRoute = getDesktopRoute();
    if (retentionOfferDetailRouteId(currentRoute) !== routedId) return;
    const originCanonicalUrl = serializeDesktopRoute(currentRoute);
    const targetRoute = routeWithoutRetentionOfferDetail(currentRoute);
    const targetCanonicalUrl = serializeDesktopRoute(targetRoute);
    const initiatingIdentity = identityScope;
    const navigation = requestNavigationWithIntent(targetRoute, {
      replace: true,
      source: "navigation",
    });
    void navigation.result.then((result) => {
      if (
        !navigation.canHandleResult() ||
        !mountedRef.current ||
        identityScopeRef.current !== initiatingIdentity
      ) {
        return;
      }
      if (result === "proceeded") {
        if (serializeDesktopRoute(getDesktopRoute()) !== targetCanonicalUrl) {
          return;
        }
        setBlockedRepair(null);
        announce(
          `The requested retention record was not present in the ${snapshotLabel} and has been closed.`,
        );
        return;
      }
      if (serializeDesktopRoute(getDesktopRoute()) !== originCanonicalUrl) {
        missingRepairRef.current = null;
        return;
      }
      missingRepairRef.current = null;
      setBlockedRepair({
        originCanonicalUrl,
        target: targetRoute,
      });
      announce(
        "The missing retention record could not be closed because navigation was blocked.",
      );
    });
  }, [
    announce,
    identityScope,
    requestNavigationWithIntent,
    routedId,
    rowsReady,
    rowsStale,
    selectedRow,
    snapshot.canonicalUrl,
  ]);

  const retryBlockedRepair = useBlockedRouteRepairRetry({
    announce,
    blockedRepair,
    identityScopeRef,
    mountedRef,
    requestNavigationWithIntent,
    setBlockedRepair,
  });

  const {
    setTab,
    setQuery,
    setStatus,
    setDiscount,
    setEvidence,
    setSort,
    setPage,
    replacePage,
  } = useRetentionHistoryViewMutators(announce, requestNavigation);

  const { openOffer, closeOffer } = useRetentionDetailActions({
    announce,
    beginRouteIntent,
    closeInFlightRef,
    identityScopeRef,
    localHistoryRef,
    mountedRef,
    requestNavigation,
    returnFocusRef,
  });

  return {
    view,
    selectedRow,
    announcement,
    repairBlocked: blockedRepair !== null,
    returnFocusRef,
    setTab,
    setQuery,
    setStatus,
    setDiscount,
    setEvidence,
    setSort,
    setPage,
    replacePage,
    retryBlockedRepair,
    openOffer,
    closeOffer,
  };
}
