import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { bucketDailyEngagement } from "../../lib/engagement-helpers";
import { useEventSubscription } from "../../lib/event-bus";
import { isTextInputTarget } from "../../lib/keyboard-shortcuts";
import {
  responseIdentityMatches,
  responseIdentityMismatch,
} from "../../lib/api/subscriber-response-integrity";
import {
  api,
  getSubscriberTimeline,
  listSubscriberHistory,
  type ContactHistoryEvent,
  type Subscriber,
  type SubscriberActivity,
  type SubscriberDetail,
  type SubscriberEngagementResult,
  type SubscriberTimeline,
} from "../../lib/api-client";
import type {
  SubscriberDetailProps,
  SubscriberDetailTabId,
} from "../subscriber-detail-types";

type ContactPerformanceState = "idle" | "loading" | "loaded" | "unavailable";
type LazyRequestState = "idle" | "loading" | "loaded" | "unavailable";

export interface SubscriberNavigationState {
  enabled: boolean;
  canPrev: boolean;
  canNext: boolean;
  setInteractionBlocked?: (blocked: boolean) => void;
}

export interface SubscriberDetailDataController {
  id: Subscriber["id"];
  detail: SubscriberDetail;
  setDetail: Dispatch<SetStateAction<SubscriberDetail>>;
  loadingDetail: boolean;
  detailError: string | null;
  reloadDetail: () => void;
  timeline: SubscriberTimeline | null;
  timelineUnavailable: boolean;
  setTimelineUnavailable: Dispatch<SetStateAction<boolean>>;
  timelineLoading: boolean;
  legacyActivity: SubscriberActivity[] | null;
  legacyActivityLoading: boolean;
  tab: SubscriberDetailTabId;
  setTab: Dispatch<SetStateAction<SubscriberDetailTabId>>;
  attrHistoryUnavailable: boolean;
  setAttrHistoryUnavailable: Dispatch<SetStateAction<boolean>>;
  customObjectsUnavailable: boolean;
  setCustomObjectsUnavailable: Dispatch<SetStateAction<boolean>>;
  piiFindingsUnavailable: boolean;
  setPiiFindingsUnavailable: Dispatch<SetStateAction<boolean>>;
  decisionsUnavailable: boolean;
  setDecisionsUnavailable: Dispatch<SetStateAction<boolean>>;
  channelMode: "all" | "email";
  setChannelMode: Dispatch<SetStateAction<"all" | "email">>;
  crossChannelUnavailable: boolean;
  setCrossChannelUnavailable: Dispatch<SetStateAction<boolean>>;
  contactPerf: SubscriberEngagementResult | null;
  contactPerfState: ContactPerformanceState;
  reloadContactPerformance: () => void;
  sparkPoints: ReturnType<typeof bucketDailyEngagement>;
  history: ContactHistoryEvent[] | null;
  historyLoading: boolean;
  historyError: string | null;
  reloadHistory: () => void;
  historyHasMore: boolean;
  historyLoadingMore: boolean;
  historyLoadMoreError: string | null;
  loadMoreHistory: () => Promise<void>;
  replaceHistory: (events: ContactHistoryEvent[], nextCursor?: string) => void;
}

export function useSubscriberNavigation({
  navIndex,
  navTotal,
  onNavigate,
  blocked = false,
}: Pick<SubscriberDetailProps, "navIndex" | "navTotal" | "onNavigate"> & {
  blocked?: boolean;
}): SubscriberNavigationState {
  const interactionBlockedRef = useRef(blocked);
  interactionBlockedRef.current = blocked;
  const enabled =
    typeof onNavigate === "function" &&
    typeof navIndex === "number" &&
    typeof navTotal === "number" &&
    navTotal > 1;
  const canPrev = enabled && (navIndex as number) > 0;
  const canNext = enabled && (navIndex as number) < (navTotal as number) - 1;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (interactionBlockedRef.current) return;
      if (isTextInputTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft" && canPrev) {
        event.preventDefault();
        onNavigate?.(-1);
      } else if (event.key === "ArrowRight" && canNext) {
        event.preventDefault();
        onNavigate?.(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canNext, canPrev, enabled, onNavigate]);

  return {
    enabled,
    canPrev,
    canNext,
    setInteractionBlocked: (next) => {
      interactionBlockedRef.current = next;
    },
  };
}

export function useSubscriberDetailData(
  subscriber: Subscriber,
): SubscriberDetailDataController {
  const id = subscriber.id;
  const [detail, setDetail] = useState<SubscriberDetail>(() => ({
    ...subscriber,
  }));
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [timeline, setTimeline] = useState<SubscriberTimeline | null>(null);
  const [timelineUnavailable, setTimelineUnavailable] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [legacyActivity, setLegacyActivity] = useState<
    SubscriberActivity[] | null
  >(null);
  const [legacyActivityState, setLegacyActivityState] =
    useState<LazyRequestState>("idle");
  const [tab, setTab] = useState<SubscriberDetailTabId>("timeline");
  const [attrHistoryUnavailable, setAttrHistoryUnavailable] = useState(false);
  const [customObjectsUnavailable, setCustomObjectsUnavailable] =
    useState(false);
  const [piiFindingsUnavailable, setPiiFindingsUnavailable] = useState(false);
  const [decisionsUnavailable, setDecisionsUnavailable] = useState(false);
  const [channelMode, setChannelMode] = useState<"all" | "email">("all");
  const [crossChannelUnavailable, setCrossChannelUnavailable] = useState(false);
  const [contactPerf, setContactPerf] =
    useState<SubscriberEngagementResult | null>(null);
  const [contactPerfState, setContactPerfState] =
    useState<ContactPerformanceState>("idle");
  const [contactPerfReloadNonce, setContactPerfReloadNonce] = useState(0);
  const [history, setHistory] = useState<ContactHistoryEvent[] | null>(null);
  const [historyState, setHistoryState] = useState<LazyRequestState>("idle");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyReloadNonce, setHistoryReloadNonce] = useState(0);
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(
    null,
  );
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyLoadMoreError, setHistoryLoadMoreError] = useState<
    string | null
  >(null);
  const historyMoreInFlightRef = useRef(false);
  const historyMoreControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setContactPerf(null);
    setContactPerfState("idle");
    setLegacyActivity(null);
    setLegacyActivityState("idle");
    setHistory(null);
    setHistoryState("idle");
    setHistoryError(null);
    setHistoryNextCursor(null);
    setHistoryLoadMoreError(null);
    setHistoryLoadingMore(false);
    historyMoreControllerRef.current?.abort();
    historyMoreInFlightRef.current = false;
    setCrossChannelUnavailable(false);
    return () => {
      historyMoreControllerRef.current?.abort();
      historyMoreInFlightRef.current = false;
    };
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingDetail(true);
    setTimelineLoading(true);
    setDetailError(null);
    if (id == null) {
      setLoadingDetail(false);
      setTimelineLoading(false);
      return () => controller.abort();
    }
    setAttrHistoryUnavailable(false);
    setCustomObjectsUnavailable(false);
    setPiiFindingsUnavailable(false);
    setDecisionsUnavailable(false);
    void (async () => {
      const [detailSettled, timelineSettled] = await Promise.allSettled([
        api.getSubscriber(id, { signal: controller.signal }),
        getSubscriberTimeline(id, {
          limit: 50,
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return;
      try {
        const failures: string[] = [];
        if (detailSettled.status === "fulfilled") {
          const detailResult = detailSettled.value;
          if (detailResult.data) setDetail(detailResult.data);
          else if (detailResult.error)
            failures.push(detailResult.error.message);
        } else {
          failures.push(
            detailSettled.reason instanceof Error &&
              detailSettled.reason.message.trim()
              ? detailSettled.reason.message
              : "Subscriber profile request failed unexpectedly",
          );
        }
        if (timelineSettled.status === "fulfilled") {
          const timelineResult = timelineSettled.value;
          if (
            timelineResult.data &&
            responseIdentityMatches(id, timelineResult.data.subscriber_id)
          ) {
            setTimeline(timelineResult.data);
            setTimelineUnavailable(false);
          } else if (timelineResult.data) {
            failures.push(responseIdentityMismatch("subscriber").error.message);
          } else if (timelineResult.error?.status === 404) {
            setTimelineUnavailable(true);
          } else if (timelineResult.error) {
            failures.push(timelineResult.error.message);
          }
        } else {
          failures.push(
            timelineSettled.reason instanceof Error &&
              timelineSettled.reason.message.trim()
              ? timelineSettled.reason.message
              : "Subscriber timeline request failed unexpectedly",
          );
        }
        setDetailError([...new Set(failures)].join(" · ") || null);
      } catch (error) {
        if (!controller.signal.aborted) {
          setDetailError(
            error instanceof Error && error.message.trim()
              ? error.message
              : "Unexpected request failure",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingDetail(false);
          setTimelineLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [id, reloadNonce]);

  useEffect(() => {
    if (
      id == null ||
      legacyActivityState !== "idle" ||
      (tab !== "engagement" && !timelineUnavailable)
    ) {
      return;
    }
    const controller = new AbortController();
    setLegacyActivityState("loading");
    void (async () => {
      try {
        const result = await api.getSubscriberActivity(id, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.error || !Array.isArray(result.data)) {
          setLegacyActivityState("unavailable");
          return;
        }
        setLegacyActivity(result.data);
        setLegacyActivityState("loaded");
      } catch {
        if (!controller.signal.aborted) setLegacyActivityState("unavailable");
      }
    })();
    return () => controller.abort();
    // State is deliberately read as a gate rather than a dependency: changing
    // idle → loading must not abort the request that owns that transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tab, timelineUnavailable]);

  useEffect(() => {
    if (id == null || tab !== "history" || historyState !== "idle") return;
    const controller = new AbortController();
    setHistoryState("loading");
    setHistoryError(null);
    void (async () => {
      try {
        const result = await listSubscriberHistory(id, {
          limit: 50,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.error || !Array.isArray(result.data?.items)) {
          setHistoryError(
            result.error?.message ??
              "The subscriber history response was incomplete.",
          );
          setHistoryState("unavailable");
          return;
        }
        setHistory(result.data.items);
        setHistoryNextCursor(result.data.next_cursor ?? null);
        setHistoryState("loaded");
      } catch {
        if (!controller.signal.aborted) {
          setHistoryError(
            "Couldn't load subscriber history. Check your connection and retry.",
          );
          setHistoryState("unavailable");
        }
      }
    })();
    return () => controller.abort();
    // See the lazy-request ownership note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyReloadNonce, id, tab]);

  useEffect(() => {
    if (tab !== "engagement" || id == null || contactPerfState !== "idle") {
      return;
    }
    const controller = new AbortController();
    setContactPerfState("loading");
    void (async () => {
      try {
        const result = await api.getSubscriberEngagement(id, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.error) {
          setContactPerfState("unavailable");
          return;
        }
        setContactPerf(result.data);
        setContactPerfState("loaded");
      } catch {
        if (!controller.signal.aborted) setContactPerfState("unavailable");
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactPerfReloadNonce, id, tab]);

  const loadMoreHistory = async (): Promise<void> => {
    const before = historyNextCursor;
    if (
      id == null ||
      !before ||
      historyMoreInFlightRef.current ||
      historyState !== "loaded"
    ) {
      return;
    }
    historyMoreInFlightRef.current = true;
    historyMoreControllerRef.current?.abort();
    const controller = new AbortController();
    historyMoreControllerRef.current = controller;
    setHistoryLoadingMore(true);
    setHistoryLoadMoreError(null);
    try {
      const result = await listSubscriberHistory(id, {
        limit: 50,
        before,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.error || !Array.isArray(result.data?.items)) {
        setHistoryLoadMoreError(
          "Couldn't load older history events. Check your connection and retry.",
        );
        return;
      }
      if (result.data.next_cursor === before) {
        setHistoryLoadMoreError(
          "The history service returned a repeated page. Retry after refreshing the record.",
        );
        return;
      }
      setHistory((current) => {
        const known = new Set((current ?? []).map((event) => event.id));
        const added = result.data.items.filter((event) => !known.has(event.id));
        return [...(current ?? []), ...added];
      });
      setHistoryNextCursor(result.data.next_cursor ?? null);
    } catch {
      if (!controller.signal.aborted) {
        setHistoryLoadMoreError(
          "Couldn't load older history events. Check your connection and retry.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setHistoryLoadingMore(false);
      if (historyMoreControllerRef.current === controller) {
        historyMoreControllerRef.current = null;
        historyMoreInFlightRef.current = false;
      }
    }
  };

  const replaceHistory = (
    events: ContactHistoryEvent[],
    nextCursor?: string,
  ): void => {
    historyMoreControllerRef.current?.abort();
    historyMoreControllerRef.current = null;
    historyMoreInFlightRef.current = false;
    setHistoryLoadingMore(false);
    setHistoryLoadMoreError(null);
    setHistory(events);
    setHistoryNextCursor(nextCursor ?? null);
    setHistoryState("loaded");
  };

  useEventSubscription<{
    subscriber_id?: string | number;
    email?: string;
    event_type?: string;
    sends?: number;
    opens?: number;
    clicks?: number;
  }>("subscriber.engagement_updated", (event) => {
    const payload = event.payload;
    if (!payload) return;
    const payloadHasId = payload.subscriber_id != null;
    const matchesId =
      payloadHasId &&
      id != null &&
      String(payload.subscriber_id) === String(id);
    const matchesEmail =
      !!detail.email &&
      typeof payload.email === "string" &&
      payload.email.toLowerCase() === detail.email.toLowerCase();
    if (payloadHasId ? !matchesId : !matchesEmail) return;
    const safeCount = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
    setContactPerf((current) =>
      current
        ? {
            ...current,
            counts: {
              ...current.counts,
              ...(safeCount(payload.sends) !== undefined
                ? { sends: safeCount(payload.sends)! }
                : {}),
              ...(safeCount(payload.opens) !== undefined
                ? { opens: safeCount(payload.opens)! }
                : {}),
              ...(safeCount(payload.clicks) !== undefined
                ? { clicks: safeCount(payload.clicks)! }
                : {}),
            },
          }
        : current,
    );
    if (payload.event_type === "opened" || payload.event_type === "clicked") {
      setLegacyActivity((current) => [
        {
          type: payload.event_type as "opened" | "clicked",
          at: new Date().toISOString(),
        },
        ...(current ?? []),
      ]);
    }
  });

  const sparkPoints = useMemo(
    () => bucketDailyEngagement(legacyActivity),
    [legacyActivity],
  );

  return {
    id,
    detail,
    setDetail,
    loadingDetail,
    detailError,
    reloadDetail: () => setReloadNonce((current) => current + 1),
    timeline,
    timelineUnavailable,
    setTimelineUnavailable,
    timelineLoading,
    legacyActivity,
    legacyActivityLoading: legacyActivityState === "loading",
    tab,
    setTab,
    attrHistoryUnavailable,
    setAttrHistoryUnavailable,
    customObjectsUnavailable,
    setCustomObjectsUnavailable,
    piiFindingsUnavailable,
    setPiiFindingsUnavailable,
    decisionsUnavailable,
    setDecisionsUnavailable,
    channelMode,
    setChannelMode,
    crossChannelUnavailable,
    setCrossChannelUnavailable,
    contactPerf,
    contactPerfState,
    reloadContactPerformance: () => {
      setContactPerfState("idle");
      setContactPerfReloadNonce((current) => current + 1);
    },
    sparkPoints,
    history,
    historyLoading: historyState === "loading",
    historyError,
    historyHasMore: Boolean(historyNextCursor),
    historyLoadingMore,
    historyLoadMoreError,
    loadMoreHistory,
    reloadHistory: () => {
      historyMoreControllerRef.current?.abort();
      historyMoreControllerRef.current = null;
      historyMoreInFlightRef.current = false;
      setHistory(null);
      setHistoryNextCursor(null);
      setHistoryLoadMoreError(null);
      setHistoryLoadingMore(false);
      setHistoryState("idle");
      setHistoryReloadNonce((current) => current + 1);
    },
    replaceHistory,
  };
}
