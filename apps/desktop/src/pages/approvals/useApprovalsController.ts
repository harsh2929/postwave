import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "../../components/Toast";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { type ApprovalRow, api } from "../../lib/api-client";
import type { ApiResult } from "../../lib/api/result";
import { decisionErrorMessage } from "../../lib/approvals-errors";
import {
  APPROVAL_LIST_CAP,
  type DecodedApproval,
  decodeApprovalDetail,
  decodeApprovalList,
} from "../../lib/approvals-helpers";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../../lib/deep-link";
import {
  getDesktopRoute,
  navigateDesktopRoute,
  requestDesktopRouteBackNavigation,
  requestDesktopRouteNavigation,
  serializeDesktopRoute,
  useDesktopRouteSnapshot,
  useDesktopRouteTab,
} from "../../lib/desktop-router";
import type { RemoteLoadResult } from "../../hooks/useRemoteResource";
import type { RemoteResourceController } from "../../hooks/useRemoteResource";
import {
  APPROVAL_WORKSPACE_TABS,
  type ApprovalHistoryStatus,
  type ApprovalRouteView,
  type ApprovalSort,
  type ApprovalWorkspaceTab,
  approvalDetailRouteId,
  approvalRouteViewFromRoute,
  normalizedApprovalId,
  routeWithApprovalDetail,
  routeWithApprovalView,
  routeWithoutApprovalDetail,
} from "./approvals-route";
import {
  decodedApprovalAsRow,
  canRejectApproval,
  deriveApprovalWindowStats,
  visibleApprovalRows,
} from "./approvals-view-model";

export const REJECTION_REASON_LIMIT = 500;
const APPROVAL_REFRESH_INTERVAL_MS = 60_000;
const DECISION_RECONCILIATION_TIMEOUT_MS = 8_000;

interface DetailHistoryEntry {
  baseCanonicalUrl: string;
  detailCanonicalUrl: string;
}

type RejectionPreflight =
  | { kind: "verified"; row: DecodedApproval }
  | { kind: "terminal"; message: string }
  | { kind: "unavailable" };

function boundedReconciliation<T>(promise: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, DECISION_RECONCILIATION_TIMEOUT_MS);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function loadApprovalWindow(
  includeResolved: boolean,
): Promise<RemoteLoadResult<DecodedApproval[]>> {
  const response = await api.listApprovals({
    includeResolved,
    limit: APPROVAL_LIST_CAP,
  });
  if (response.error) return { error: response.error };
  const decoded = decodeApprovalList(response.data);
  if (!decoded.ok) {
    return {
      error: {
        kind: "parse",
        code: `approval_contract_${decoded.reason}`,
        message: "The approval response did not match the reviewed contract.",
      },
    };
  }
  if (
    !includeResolved &&
    decoded.data.approvals.some((row) => row.status !== "pending")
  ) {
    return {
      error: {
        kind: "parse",
        code: "approval_contract_pending_scope",
        message: "The pending approval response contained an unverified state.",
      },
    };
  }
  return { data: decoded.data.approvals };
}

function detailSnapshot(
  id: string | null,
  pending: readonly DecodedApproval[] | null,
  history: readonly DecodedApproval[] | null,
): ApprovalRow | null {
  if (!id) return null;
  const row = [...(history ?? []), ...(pending ?? [])].find(
    (candidate) => candidate.id === id,
  );
  return row ? decodedApprovalAsRow(row) : { id, status: "unverified" };
}

function sameApprovalIdentity(
  row: DecodedApproval,
  target: DecodedApproval,
): boolean {
  return (
    row.id === target.id &&
    row.resourceId === target.resourceId &&
    row.resourceType === target.resourceType &&
    row.requestedAt === target.requestedAt
  );
}

async function verifyRejectionTarget(
  target: DecodedApproval,
): Promise<RejectionPreflight> {
  try {
    const result = await api.getApproval(target.id);
    if (result.error) return { kind: "unavailable" };
    const decoded = decodeApprovalDetail(result.data);
    if (!decoded.ok || !sameApprovalIdentity(decoded.data, target)) {
      return { kind: "unavailable" };
    }
    if (decoded.data.status !== "pending") {
      return {
        kind: "terminal",
        message: `The request is now ${decoded.data.statusLabel.toLocaleLowerCase()}. No rejection was sent.`,
      };
    }
    if (!canRejectApproval(decoded.data)) {
      return {
        kind: "terminal",
        message:
          "The review window is no longer eligible for rejection. No decision was sent.",
      };
    }
    return { kind: "verified", row: decoded.data };
  } catch {
    return { kind: "unavailable" };
  }
}

function useApprovalDetailNavigation(
  pending: readonly DecodedApproval[] | null,
  history: readonly DecodedApproval[] | null,
) {
  const snapshot = useDesktopRouteSnapshot();
  const routedId = approvalDetailRouteId(snapshot.route);
  const previousIdRef = useRef<string | null>(routedId);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const localHistoryRef = useRef<DetailHistoryEntry | null>(null);
  const closeInFlightRef = useRef(false);
  const routeIntentRef = useRef(0);
  const detail = useMemo(
    () => detailSnapshot(routedId, pending, history),
    [history, pending, routedId],
  );

  useEffect(() => {
    const previous = previousIdRef.current;
    previousIdRef.current = routedId;
    if (routedId) {
      closeInFlightRef.current = false;
      return;
    }
    if (!previous) return;
    const returnTarget = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!returnTarget?.isConnected) return;
    const frame = window.requestAnimationFrame(() => {
      if (returnTarget.isConnected) returnTarget.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [routedId]);

  useEffect(() => {
    const accept = (target: { section: string; id: string } | null): void => {
      if (!target || target.section !== "approvals") return;
      const id = normalizedApprovalId(target.id);
      if (!id) {
        toast.error("That approval link is not a valid record reference.");
        return;
      }
      const next = routeWithApprovalDetail(getDesktopRoute(), id);
      if (!next) return;
      localHistoryRef.current = null;
      navigateDesktopRoute(next, { replace: true, source: "deep-link" });
    };
    accept(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "approvals") return;
      consumePendingDeepLinkTarget();
      accept(target);
    });
  }, []);

  const openDetail = useCallback((row: DecodedApproval): void => {
    const current = getDesktopRoute();
    const next = routeWithApprovalDetail(current, row.id);
    if (!next) {
      toast.error(
        "This approval cannot be opened because its reference is invalid.",
      );
      return;
    }
    const invocationTarget =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const historyEntry = {
      baseCanonicalUrl: serializeDesktopRoute(current),
      detailCanonicalUrl: serializeDesktopRoute(next),
    };
    const intent = ++routeIntentRef.current;
    const isStillCurrent = (): boolean => {
      if (routeIntentRef.current !== intent) return false;
      const currentUrl = serializeDesktopRoute(getDesktopRoute());
      return (
        currentUrl === historyEntry.baseCanonicalUrl ||
        currentUrl === historyEntry.detailCanonicalUrl
      );
    };
    void requestDesktopRouteNavigation(next, {
      source: "navigation",
      isStillCurrent,
    }).then((result) => {
      if (
        result !== "proceeded" ||
        !isStillCurrent() ||
        approvalDetailRouteId(getDesktopRoute()) !== row.id
      ) {
        return;
      }
      localHistoryRef.current = historyEntry;
      returnFocusRef.current = invocationTarget;
    });
  }, []);

  const closeDetail = useCallback((): void => {
    if (closeInFlightRef.current) return;
    const current = getDesktopRoute();
    if (!approvalDetailRouteId(current)) return;
    const next = routeWithoutApprovalDetail(current);
    const localHistory = localHistoryRef.current;
    const ownsPushedEntry = Boolean(
      localHistory &&
      localHistory.detailCanonicalUrl === serializeDesktopRoute(current) &&
      localHistory.baseCanonicalUrl === serializeDesktopRoute(next),
    );
    const detailCanonicalUrl = serializeDesktopRoute(current);
    const targetCanonicalUrl = serializeDesktopRoute(next);
    const intent = ++routeIntentRef.current;
    const isStillCurrent = (): boolean => {
      if (routeIntentRef.current !== intent) return false;
      const currentUrl = serializeDesktopRoute(getDesktopRoute());
      return (
        currentUrl === detailCanonicalUrl || currentUrl === targetCanonicalUrl
      );
    };
    closeInFlightRef.current = true;
    void (async () => {
      let result = ownsPushedEntry
        ? await requestDesktopRouteBackNavigation(next, isStillCurrent)
        : await requestDesktopRouteNavigation(next, {
            replace: true,
            source: "navigation",
            isStillCurrent,
          });
      if (result === "failed" && ownsPushedEntry && isStillCurrent()) {
        result = await requestDesktopRouteNavigation(next, {
          replace: true,
          source: "navigation",
          isStillCurrent,
        });
      }
      if (result !== "proceeded" || !isStillCurrent()) {
        closeInFlightRef.current = false;
      }
    })();
  }, []);

  return { detail, routedId, openDetail, closeDetail };
}

function useAutomaticApprovalRefresh(
  enabled: boolean,
  refresh: () => Promise<void>,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === "visible") void refreshRef.current();
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      APPROVAL_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled]);
}

export interface ApprovalsController {
  tab: ApprovalWorkspaceTab;
  setTab: (tab: ApprovalWorkspaceTab) => void;
  view: ApprovalRouteView;
  queryDraft: string;
  setQueryDraft: (value: string) => void;
  applyQuery: () => void;
  setStatus: (status: ApprovalHistoryStatus) => void;
  setSort: (sort: ApprovalSort) => void;
  resetFilters: () => void;
  pendingResource: RemoteResourceController<DecodedApproval[]>;
  historyResource: RemoteResourceController<DecodedApproval[]>;
  activeResource: RemoteResourceController<DecodedApproval[]>;
  visibleRows: DecodedApproval[];
  pendingWindowCount: number | null;
  historyWindowCount: number | null;
  stats: ReturnType<typeof deriveApprovalWindowStats>;
  refreshing: boolean;
  refreshAll: () => Promise<void>;
  detail: ApprovalRow | null;
  openDetail: (row: DecodedApproval) => void;
  closeDetail: () => void;
  rejectFor: DecodedApproval | null;
  rejectionReason: string;
  rejectionError: string | null;
  decisionBusy: boolean;
  openReject: (row: ApprovalRow) => void;
  closeReject: () => void;
  setRejectionReason: (value: string) => void;
  submitRejection: () => Promise<void>;
}

type ApprovalRejectionController = Pick<
  ApprovalsController,
  | "rejectFor"
  | "rejectionReason"
  | "rejectionError"
  | "decisionBusy"
  | "openReject"
  | "closeReject"
  | "setRejectionReason"
  | "submitRejection"
>;

function useApprovalRejectionController({
  closeDetail,
  pendingReload,
  pendingReloadResult,
  historyReload,
  historyReloadResult,
}: {
  closeDetail: () => void;
  pendingReload: () => Promise<void>;
  pendingReloadResult: () => Promise<RemoteLoadResult<
    DecodedApproval[]
  > | null>;
  historyReload: () => Promise<void>;
  historyReloadResult: () => Promise<RemoteLoadResult<
    DecodedApproval[]
  > | null>;
}): ApprovalRejectionController {
  const [rejectFor, setRejectFor] = useState<DecodedApproval | null>(null);
  const [rejectionReason, setRejectionReasonState] = useState("");
  const [rejectionError, setRejectionError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const decisionInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const closeReject = useCallback((): void => {
    if (decisionBusy) return;
    setRejectFor(null);
    setRejectionReasonState("");
    setRejectionError(null);
  }, [decisionBusy]);
  const openReject = useCallback(
    (row: ApprovalRow): void => {
      const decoded = decodeApprovalDetail(row);
      if (!decoded.ok || !canRejectApproval(decoded.data) || decisionBusy) {
        return;
      }
      setRejectFor(decoded.data);
      setRejectionReasonState("");
      setRejectionError(null);
    },
    [decisionBusy],
  );
  const setRejectionReason = useCallback((value: string): void => {
    setRejectionReasonState(value.slice(0, REJECTION_REASON_LIMIT));
    setRejectionError(null);
  }, []);
  const submitRejection = useCallback(async (): Promise<void> => {
    if (!rejectFor || decisionInFlightRef.current) return;
    const reason = rejectionReason.trim();
    if (!reason) {
      setRejectionError("Add a reason so the requester can correct the gate.");
      return;
    }
    decisionInFlightRef.current = true;
    setDecisionBusy(true);
    setRejectionError(null);
    const target = rejectFor;
    const preflight = await verifyRejectionTarget(target);
    if (!mountedRef.current) {
      decisionInFlightRef.current = false;
      return;
    }
    if (preflight.kind !== "verified") {
      decisionInFlightRef.current = false;
      setDecisionBusy(false);
      void Promise.all([pendingReload(), historyReload()]);
      if (preflight.kind === "terminal") {
        setRejectFor(null);
        setRejectionReasonState("");
        if (approvalDetailRouteId(getDesktopRoute()) === target.id) {
          closeDetail();
        }
        toast.error(preflight.message);
      } else {
        toast.error(
          "The latest approval state could not be verified. No rejection was sent.",
        );
      }
      return;
    }
    const result: ApiResult<ApprovalRow> = await api
      .decideApproval(target.id, "reject", reason)
      .catch(() => ({
        error: {
          kind: "network" as const,
          message: "The decision request did not return a response.",
        },
      }));
    const decodedResult = result.data
      ? decodeApprovalDetail(result.data)
      : null;
    const responseVerified = Boolean(
      decodedResult?.ok &&
      decodedResult.data.id === target.id &&
      decodedResult.data.resourceId === target.resourceId &&
      decodedResult.data.resourceType === target.resourceType &&
      decodedResult.data.requestedAt === target.requestedAt &&
      decodedResult.data.status === "rejected",
    );
    if (!mountedRef.current) {
      decisionInFlightRef.current = false;
      return;
    }
    const finishVerifiedRejection = (): void => {
      decisionInFlightRef.current = false;
      if (!mountedRef.current) return;
      setDecisionBusy(false);
      setRejectFor(null);
      setRejectionReasonState("");
      if (approvalDetailRouteId(getDesktopRoute()) === target.id) closeDetail();
      toast.success(
        "Rejection decision recorded. Downstream notification status is not yet verified.",
      );
    };
    if (responseVerified) {
      finishVerifiedRejection();
      void Promise.all([pendingReload(), historyReload()]);
      return;
    }
    void pendingReloadResult();
    const historyRefresh = await boundedReconciliation(historyReloadResult());
    decisionInFlightRef.current = false;
    if (!mountedRef.current) return;
    setDecisionBusy(false);
    const reconciledRow =
      historyRefresh &&
      "data" in historyRefresh &&
      Array.isArray(historyRefresh.data)
        ? historyRefresh.data.find(
            (row) =>
              row.id === target.id &&
              row.resourceId === target.resourceId &&
              row.resourceType === target.resourceType &&
              row.requestedAt === target.requestedAt,
          )
        : undefined;
    const rejectionVerified =
      responseVerified || reconciledRow?.status === "rejected";
    if (
      !rejectionVerified &&
      reconciledRow &&
      reconciledRow.status !== "pending"
    ) {
      setRejectFor(null);
      setRejectionReasonState("");
      toast.error(
        `The request is now ${reconciledRow.statusLabel.toLocaleLowerCase()}. The latest verified state replaced this decision form.`,
      );
      return;
    }
    if (!rejectionVerified && result.error) {
      toast.error(
        decisionErrorMessage(
          "reject",
          result.error.code,
          result.error.message,
          result.error.requestId,
        ),
      );
      return;
    }
    if (!rejectionVerified) {
      toast.error(
        "The rejection response could not be verified. The queue was refreshed before another action is allowed.",
      );
      return;
    }
    finishVerifiedRejection();
  }, [
    closeDetail,
    decisionBusy,
    historyReloadResult,
    historyReload,
    pendingReloadResult,
    pendingReload,
    rejectFor,
    rejectionReason,
  ]);

  return {
    rejectFor,
    rejectionReason,
    rejectionError,
    decisionBusy,
    openReject,
    closeReject,
    setRejectionReason,
    submitRejection,
  };
}

export function useApprovalsController(): ApprovalsController {
  const snapshot = useDesktopRouteSnapshot();
  const [tab] = useDesktopRouteTab<ApprovalWorkspaceTab>(
    "approvals",
    APPROVAL_WORKSPACE_TABS,
    "pending",
  );
  const view = approvalRouteViewFromRoute(snapshot.route);
  const loadEnabled =
    tab !== "governance" || Boolean(approvalDetailRouteId(snapshot.route));
  const pendingResource = useRemoteResource(() => loadApprovalWindow(false), {
    identity: "approvals:pending:bounded-v2",
    auto: loadEnabled,
  });
  const historyResource = useRemoteResource(() => loadApprovalWindow(true), {
    identity: "approvals:history:bounded-v2",
    auto: loadEnabled,
  });
  const [queryDraft, setQueryDraft] = useState(view.query);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const pendingReload = pendingResource.reload;
  const pendingReloadResult = pendingResource.reloadResult;
  const historyReload = historyResource.reload;
  const historyReloadResult = historyResource.reloadResult;
  const refreshAll = useCallback((): Promise<void> => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const refresh = Promise.all([pendingReload(), historyReload()])
      .then(() => undefined)
      .finally(() => {
        if (refreshInFlightRef.current === refresh) {
          refreshInFlightRef.current = null;
        }
      });
    refreshInFlightRef.current = refresh;
    return refresh;
  }, [historyReload, pendingReload]);
  const { detail, openDetail, closeDetail } = useApprovalDetailNavigation(
    pendingResource.data,
    historyResource.data,
  );
  const rejection = useApprovalRejectionController({
    closeDetail,
    pendingReload,
    pendingReloadResult,
    historyReload,
    historyReloadResult,
  });

  useEffect(() => setQueryDraft(view.query), [view.query]);
  useEffect(() => {
    if (tab !== "pending") return;
    const hasHistoryStatus = snapshot.route.filters?.some(
      (filter) => filter.key === "status",
    );
    const hasHistorySort = snapshot.route.sort?.field === "status";
    if (!hasHistoryStatus && !hasHistorySort) return;
    navigateDesktopRoute(
      routeWithApprovalView(snapshot.route, {
        status: "all",
        sort: view.sort,
      }),
      { replace: true, source: "navigation" },
    );
  }, [snapshot.route, tab, view.sort]);
  useAutomaticApprovalRefresh(
    loadEnabled && !rejection.decisionBusy,
    refreshAll,
  );

  const navigateView = useCallback(
    (update: Partial<Pick<ApprovalRouteView, "query" | "status" | "sort">>) => {
      navigateDesktopRoute(routeWithApprovalView(getDesktopRoute(), update));
    },
    [],
  );
  const setTab = useCallback((next: ApprovalWorkspaceTab): void => {
    if (!APPROVAL_WORKSPACE_TABS.includes(next)) return;
    const current = getDesktopRoute();
    const currentView = approvalRouteViewFromRoute(current);
    const normalized =
      next === "pending"
        ? routeWithApprovalView(current, {
            status: "all",
            sort: currentView.sort === "status" ? "newest" : currentView.sort,
          })
        : current;
    navigateDesktopRoute({
      ...normalized,
      ...(next === "pending" ? { tab: undefined } : { tab: next }),
    });
  }, []);
  const applyQuery = useCallback(
    () => navigateView({ query: queryDraft }),
    [navigateView, queryDraft],
  );
  const setStatus = useCallback(
    (status: ApprovalHistoryStatus) => navigateView({ status }),
    [navigateView],
  );
  const setSort = useCallback(
    (sort: ApprovalSort) => navigateView({ sort }),
    [navigateView],
  );
  const resetFilters = useCallback(() => {
    setQueryDraft("");
    navigateView({ query: "", status: "all", sort: "newest" });
  }, [navigateView]);

  const activeResource = tab === "pending" ? pendingResource : historyResource;
  const activeRows = activeResource.data ?? [];
  const visibleRows = useMemo(
    () => visibleApprovalRows(activeRows, tab, { ...view, tab }),
    [activeRows, tab, view],
  );
  const stats = useMemo(
    () => deriveApprovalWindowStats(historyResource.data ?? []),
    [historyResource.data],
  );

  return {
    tab,
    setTab,
    view: { ...view, tab },
    queryDraft,
    setQueryDraft,
    applyQuery,
    setStatus,
    setSort,
    resetFilters,
    pendingResource,
    historyResource,
    activeResource,
    visibleRows,
    pendingWindowCount:
      pendingResource.data?.filter((row) => row.status === "pending").length ??
      null,
    historyWindowCount:
      historyResource.data?.filter((row) => row.status !== "pending").length ??
      null,
    stats,
    refreshing:
      rejection.decisionBusy ||
      pendingResource.transport === "loading" ||
      historyResource.transport === "loading",
    refreshAll,
    detail,
    openDetail,
    closeDetail,
    ...rejection,
  };
}
