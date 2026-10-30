import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import { toast } from "../../components/Toast";
import type { Subscriber } from "../../lib/api-client";
import {
  getDesktopRoute,
  requestDesktopRouteBackNavigation,
  requestDesktopRouteNavigation,
  serializeDesktopRoute,
  useDesktopRouteSnapshot,
} from "../../lib/desktop-router";
import type { LifecycleTransitionResult } from "../../lib/lifecycle-coordinator";
import {
  routeWithSubscriberDetail,
  routeWithoutSubscriberDetail,
  subscriberDetailRouteId,
} from "./subscriber-detail-route";
import { subscriberKey } from "./subscribers-page-utils";

interface DetailRouteNavigationOptions {
  selected: Subscriber | null;
  setSelected: (subscriber: Subscriber | null) => void;
  setPendingDeepLinkId: (id: string | null) => void;
  setRouteOpenError: (error: string | null) => void;
  identityScope: string | null;
}

interface DetailRouteNavigationController {
  desktopRoute: ReturnType<typeof useDesktopRouteSnapshot>["route"];
  routedDetailId: string | null;
  mountedRef: MutableRefObject<boolean>;
  markRouteAsExternal: () => void;
  openSubscriber: (subscriber: Subscriber) => void;
  navigateSubscriber: (
    subscriber: Subscriber,
  ) => Promise<LifecycleTransitionResult>;
  closeSubscriber: () => void;
}

export function useSubscriberDetailRouteNavigation({
  selected,
  setSelected,
  setPendingDeepLinkId,
  setRouteOpenError,
  identityScope,
}: DetailRouteNavigationOptions): DetailRouteNavigationController {
  const snapshot = useDesktopRouteSnapshot();
  const desktopRoute = snapshot.route;
  const routedDetailId = subscriberDetailRouteId(desktopRoute);
  const previousRoutedIdRef = useRef<string | null>(null);
  const previousIdentityRef = useRef(identityScope);
  const mountedRef = useRef(true);
  const closeInFlightRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusFrameRef = useRef<number | null>(null);
  const localDetailHistoryRef = useRef<{
    baseCanonicalUrl: string;
    detailCanonicalUrl: string;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (returnFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(returnFocusFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const previous = previousRoutedIdRef.current;
    const identityChanged = previousIdentityRef.current !== identityScope;
    previousRoutedIdRef.current = routedDetailId;
    previousIdentityRef.current = identityScope;
    if (identityChanged) {
      localDetailHistoryRef.current = null;
      returnFocusRef.current = null;
      closeInFlightRef.current = false;
    }
    setRouteOpenError(null);
    if (routedDetailId) {
      const localHistory = localDetailHistoryRef.current;
      if (
        localHistory &&
        snapshot.canonicalUrl !== localHistory.detailCanonicalUrl
      ) {
        const baseCanonicalUrl = serializeDesktopRoute(
          routeWithoutSubscriberDetail(desktopRoute),
        );
        if (baseCanonicalUrl !== localHistory.baseCanonicalUrl) {
          localDetailHistoryRef.current = null;
        }
      }
      const currentKey = selected ? subscriberKey(selected) : "";
      if (
        (!identityChanged && currentKey === routedDetailId) ||
        (!identityChanged &&
          selected?.email?.toLowerCase() === routedDetailId.toLowerCase())
      ) {
        setPendingDeepLinkId(null);
        return;
      }
      setSelected(null);
      setPendingDeepLinkId(routedDetailId);
      return;
    }
    if (previous) {
      closeInFlightRef.current = false;
      setPendingDeepLinkId(null);
      setSelected(null);
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnTarget?.isConnected) {
        if (returnFocusFrameRef.current !== null) {
          window.cancelAnimationFrame(returnFocusFrameRef.current);
        }
        returnFocusFrameRef.current = window.requestAnimationFrame(() => {
          returnFocusFrameRef.current = null;
          if (returnTarget.isConnected) returnTarget.focus();
        });
      }
    }
    const localHistory = localDetailHistoryRef.current;
    if (
      localHistory &&
      snapshot.canonicalUrl !== localHistory.baseCanonicalUrl
    ) {
      localDetailHistoryRef.current = null;
    }
  }, [
    desktopRoute,
    identityScope,
    routedDetailId,
    selected,
    setPendingDeepLinkId,
    setRouteOpenError,
    setSelected,
    snapshot.canonicalUrl,
  ]);

  const openSubscriber = useCallback(
    (subscriber: Subscriber): void => {
      const id = subscriberKey(subscriber).trim();
      if (!id) {
        toast.error(
          "This subscriber cannot be opened because its identity is missing.",
        );
        return;
      }
      const invocationTarget =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const currentRoute = getDesktopRoute();
      const targetRoute = routeWithSubscriberDetail(currentRoute, id);
      const localHistory = {
        baseCanonicalUrl: serializeDesktopRoute(currentRoute),
        detailCanonicalUrl: serializeDesktopRoute(targetRoute),
      };
      void requestDesktopRouteNavigation(targetRoute, {
        source: "navigation",
      }).then((result) => {
        if (
          !mountedRef.current ||
          result !== "proceeded" ||
          subscriberDetailRouteId(getDesktopRoute()) !== id
        ) {
          return;
        }
        localDetailHistoryRef.current = localHistory;
        returnFocusRef.current = invocationTarget;
        setRouteOpenError(null);
        setPendingDeepLinkId(null);
        setSelected(subscriber);
      });
    },
    [setPendingDeepLinkId, setRouteOpenError, setSelected],
  );

  const navigateSubscriber = useCallback(
    async (subscriber: Subscriber): Promise<LifecycleTransitionResult> => {
      const id = subscriberKey(subscriber).trim();
      if (!id) return "failed";
      const currentRoute = getDesktopRoute();
      const targetRoute = routeWithSubscriberDetail(currentRoute, id);
      const result = await requestDesktopRouteNavigation(targetRoute, {
        replace: true,
        source: "navigation",
      });
      if (result !== "proceeded") return result;
      if (
        !mountedRef.current ||
        subscriberDetailRouteId(getDesktopRoute()) !== id
      ) {
        return "failed";
      }
      const localHistory = localDetailHistoryRef.current;
      if (
        localHistory &&
        serializeDesktopRoute(routeWithoutSubscriberDetail(targetRoute)) ===
          localHistory.baseCanonicalUrl
      ) {
        localDetailHistoryRef.current = {
          ...localHistory,
          detailCanonicalUrl: serializeDesktopRoute(targetRoute),
        };
      }
      setRouteOpenError(null);
      setPendingDeepLinkId(null);
      setSelected(subscriber);
      return "proceeded";
    },
    [setPendingDeepLinkId, setRouteOpenError, setSelected],
  );

  const closeSubscriber = useCallback((): void => {
    if (closeInFlightRef.current) return;
    const currentRoute = getDesktopRoute();
    if (!subscriberDetailRouteId(currentRoute)) return;
    const targetRoute = routeWithoutSubscriberDetail(currentRoute);
    const localHistory = localDetailHistoryRef.current;
    const ownsPushedEntry = Boolean(
      localHistory &&
      localHistory.detailCanonicalUrl === serializeDesktopRoute(currentRoute) &&
      localHistory.baseCanonicalUrl === serializeDesktopRoute(targetRoute),
    );
    closeInFlightRef.current = true;
    void (async () => {
      let result = ownsPushedEntry
        ? await requestDesktopRouteBackNavigation(targetRoute)
        : await requestDesktopRouteNavigation(targetRoute, {
            replace: true,
            source: "navigation",
          });
      if (result === "failed" && ownsPushedEntry) {
        result = await requestDesktopRouteNavigation(targetRoute, {
          replace: true,
          source: "navigation",
        });
      }
      if (!mountedRef.current) return;
      if (result !== "proceeded") {
        closeInFlightRef.current = false;
        return;
      }
      setRouteOpenError(null);
      setPendingDeepLinkId(null);
    })();
  }, [setPendingDeepLinkId, setRouteOpenError]);

  const markRouteAsExternal = useCallback((): void => {
    localDetailHistoryRef.current = null;
  }, []);

  return {
    desktopRoute,
    routedDetailId,
    mountedRef,
    markRouteAsExternal,
    openSubscriber,
    navigateSubscriber,
    closeSubscriber,
  };
}
