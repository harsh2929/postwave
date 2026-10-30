import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Subscriber } from "../../lib/api-client";
import {
  useEventBus,
  useEventSubscription,
  type EventBusStatus,
} from "../../lib/event-bus";
import { useOnline, type OnlineStatus } from "../../lib/online-manager";
import {
  SUBSCRIBER_RELOAD_DEBOUNCE_MS,
  isSubscribersLiveEligible,
  subscriberKey,
} from "./subscribers-page-utils";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersPageState } from "./useSubscribersPageState";

const MAX_BUFFERED_IDENTITIES = 1_000;
const MAX_RELOAD_BURST_MS = 15_000;
const EMPTY_BUFFER = { items: [] as Subscriber[], overflow: false };

export type SubscriberLiveStatus =
  | "live"
  | "paused"
  | "offline"
  | "connecting"
  | "reconnecting";

function liveStatus(input: {
  visible: boolean;
  online: OnlineStatus;
  stream: EventBusStatus;
}): SubscriberLiveStatus {
  if (!input.visible) return "paused";
  if (input.online === "offline") return "offline";
  if (input.online === "connecting") return "connecting";
  if (input.stream === "open") return "live";
  return input.stream === "reconnecting" ? "reconnecting" : "connecting";
}

export function useSubscriberLiveUpdates(
  state: SubscribersPageState,
  data: SubscribersData,
  onAudienceMutation: () => void = () => undefined,
) {
  const [buffer, setBuffer] = useState(EMPTY_BUFFER);
  const bufferedNew = buffer.items;
  const bufferOverflow = buffer.overflow;
  const [listScrolled, setListScrolled] = useState(false);
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const [reconciliationRequired, setReconciliationRequired] = useState(false);
  const online = useOnline();
  const { status: streamStatus } = useEventBus();
  const listScrolledRef = useRef(false);
  const liveEligibleRef = useRef(false);
  const runnableRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const reloadTimerRef = useRef<number | null>(null);
  const reloadBurstStartedAtRef = useRef<number | null>(null);

  const status = liveStatus({
    visible,
    online,
    stream: streamStatus,
  });
  const runnable = status === "live";
  runnableRef.current = runnable;

  const requireReconciliation = useCallback((): void => {
    setReconciliationRequired(true);
  }, []);

  const clearReloadTimer = useCallback((): void => {
    if (reloadTimerRef.current != null) {
      window.clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }
    reloadBurstStartedAtRef.current = null;
  }, []);

  const liveEligible = useMemo(
    () =>
      isSubscribersLiveEligible({
        filter: state.filter,
        debouncedQuery: state.debouncedQuery,
        page: state.page,
        sortColumn: state.sortColumn,
        sortOrder: state.sortOrder,
        showArchived: state.showArchived,
      }),
    [
      state.filter,
      state.debouncedQuery,
      state.page,
      state.sortColumn,
      state.sortOrder,
      state.showArchived,
    ],
  );

  useEffect(() => {
    liveEligibleRef.current = liveEligible;
    if (!liveEligible && (bufferedNew.length > 0 || bufferOverflow)) {
      setBuffer(EMPTY_BUFFER);
    }
  }, [bufferOverflow, bufferedNew.length, liveEligible]);

  useEffect(() => {
    const onVisibility = (): void => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    // Any interval without both transport signals can miss subscriber events,
    // including the first SSE connection while the initial page is loading.
    if (!visible || online !== "online" || streamStatus !== "open") {
      requireReconciliation();
    }
    if (!runnable) clearReloadTimer();
  }, [
    clearReloadTimer,
    online,
    requireReconciliation,
    runnable,
    streamStatus,
    visible,
  ]);

  useEffect(() => {
    if (
      !runnable ||
      !reconciliationRequired ||
      data.loading ||
      data.refreshing
    ) {
      return;
    }
    setReconciliationRequired(false);
    setBuffer(EMPTY_BUFFER);
    data.backgroundReloadRef.current = true;
    data.reload();
  }, [
    data.backgroundReloadRef,
    data.loading,
    data.refreshing,
    data.reload,
    reconciliationRequired,
    runnable,
  ]);

  const flushBufferedNew = useCallback((): void => {
    if (bufferedNew.length === 0 && !bufferOverflow) return;
    if (!runnableRef.current) {
      requireReconciliation();
      return;
    }
    setBuffer(EMPTY_BUFFER);
    // Live event payloads are identifiers, not complete directory rows. Load
    // one authoritative page instead of inserting event-shaped guesses.
    data.backgroundReloadRef.current = true;
    data.reload();
    const list = listRef.current;
    const owner = list?.closest<HTMLElement>(".content");
    if (list && owner) {
      const ownerBox = owner.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      owner.scrollTo({
        top: Math.max(0, owner.scrollTop + listBox.top - ownerBox.top),
        behavior: "smooth",
      });
    } else {
      list?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
  }, [
    bufferOverflow,
    bufferedNew.length,
    data.backgroundReloadRef,
    data.reload,
    requireReconciliation,
  ]);

  useEffect(() => {
    const compute = (): boolean => {
      const element = listRef.current;
      if (!element) return false;
      const owner = element.closest<HTMLElement>(".content");
      const ownerTop = owner?.getBoundingClientRect().top ?? 0;
      return element.getBoundingClientRect().top < ownerTop - 8;
    };
    const onScroll = (): void => {
      const scrolled = compute();
      listScrolledRef.current = scrolled;
      setListScrolled(scrolled);
      if (!scrolled) flushBufferedNew();
    };
    onScroll();
    const owner = listRef.current?.closest<HTMLElement>(".content");
    const scrollTarget: HTMLElement | Window = owner ?? window;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollTarget.removeEventListener("scroll", onScroll);
  }, [data.rows, flushBufferedNew]);

  const scheduleAuthoritativeReload = useCallback((): void => {
    if (!runnableRef.current) {
      requireReconciliation();
      return;
    }
    const now = Date.now();
    reloadBurstStartedAtRef.current ??= now;
    const elapsed = now - reloadBurstStartedAtRef.current;
    const wait = Math.max(
      0,
      Math.min(SUBSCRIBER_RELOAD_DEBOUNCE_MS, MAX_RELOAD_BURST_MS - elapsed),
    );
    if (reloadTimerRef.current != null) {
      window.clearTimeout(reloadTimerRef.current);
    }
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null;
      reloadBurstStartedAtRef.current = null;
      if (!runnableRef.current) {
        requireReconciliation();
        return;
      }
      data.backgroundReloadRef.current = true;
      data.reload();
    }, wait);
  }, [data.backgroundReloadRef, data.reload, requireReconciliation]);

  useEventSubscription<{
    id?: string | number;
    email?: string;
    status?: string;
  }>("subscriber.added", (event) => {
    if (!runnableRef.current) {
      requireReconciliation();
      return;
    }
    if (!liveEligibleRef.current || !listScrolledRef.current) return;
    const payload = event.payload;
    if (!payload || (payload.id == null && !payload.email)) return;
    const stub: Subscriber = {
      ...(payload.id != null ? { id: payload.id } : {}),
      email: typeof payload.email === "string" ? payload.email : "",
      ...(typeof payload.status === "string" ? { status: payload.status } : {}),
    } as Subscriber;
    const key = subscriberKey(stub);
    if (!key) return;
    setBuffer((current) => {
      if (current.items.some((row) => subscriberKey(row) === key)) {
        return current;
      }
      if ((data.rows ?? []).some((row) => subscriberKey(row) === key)) {
        return current;
      }
      if (current.items.length >= MAX_BUFFERED_IDENTITIES) {
        return current.overflow ? current : { ...current, overflow: true };
      }
      return { ...current, items: [stub, ...current.items] };
    });
  });

  useEventSubscription("subscriber.*", (event) => {
    onAudienceMutation();
    if (!runnableRef.current) {
      requireReconciliation();
      return;
    }
    if (
      event.topic === "subscriber.added" &&
      liveEligibleRef.current &&
      listScrolledRef.current
    ) {
      return;
    }
    scheduleAuthoritativeReload();
  });

  useEffect(() => clearReloadTimer, [clearReloadTimer]);

  return {
    bufferedNew,
    bufferOverflow,
    listScrolled,
    listRef,
    liveEligible,
    status,
    reconciliationRequired,
    flushBufferedNew,
  };
}

export type SubscriberLiveUpdates = ReturnType<typeof useSubscriberLiveUpdates>;
