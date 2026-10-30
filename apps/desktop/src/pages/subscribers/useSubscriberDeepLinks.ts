import { useEffect, useState } from "react";

import { toast } from "../../components/Toast";
import { useWriteDesktopTaskIntent } from "../../hooks/useDesktopTaskIntent";
import type { Subscriber } from "../../lib/api-client";
import { api } from "../../lib/api-client";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../../lib/deep-link";
import {
  getDesktopRoute,
  requestDesktopRouteNavigation,
} from "../../lib/desktop-router";
import {
  routeWithSubscriberDetail,
  routeWithoutSubscriberDetail,
  subscriberDetailRouteId,
} from "./subscriber-detail-route";
import { useSubscriberDetailRouteNavigation } from "./useSubscriberDetailRouteNavigation";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersPageState } from "./useSubscribersPageState";

export function useSubscriberDeepLinks(options: {
  state: SubscribersPageState;
  data: SubscribersData;
  canMutate: boolean;
  canImport: boolean;
  identityScope: string | null;
  openCreate: () => void;
}) {
  const { state, data, canMutate, canImport, identityScope, openCreate } =
    options;
  const [pendingDeepLinkId, setPendingDeepLinkId] = useState<string | null>(
    null,
  );
  const [lookupNonce, setLookupNonce] = useState(0);
  const [routeOpenError, setRouteOpenError] = useState<string | null>(null);
  const detailRouteNavigation = useSubscriberDetailRouteNavigation({
    selected: state.selected,
    setSelected: state.setSelected,
    setPendingDeepLinkId,
    setRouteOpenError,
    identityScope,
  });
  const { desktopRoute, markRouteAsExternal, mountedRef } =
    detailRouteNavigation;
  const pendingDeepLinkMatch = pendingDeepLinkId
    ? data.rows?.find((row) => {
        const target = pendingDeepLinkId.toLowerCase();
        return (
          (row.email ?? "").toLowerCase() === target ||
          String(row.id ?? "") === pendingDeepLinkId
        );
      })
    : undefined;

  useEffect(() => {
    const accept = (target: { section: string; id: string } | null): void => {
      if (target && target.section === "subscribers" && target.id) {
        const currentRoute = getDesktopRoute();
        if (subscriberDetailRouteId(currentRoute) === target.id) {
          state.setSelected(null);
          setRouteOpenError(null);
          setPendingDeepLinkId(target.id);
          return;
        }
        void requestDesktopRouteNavigation(
          routeWithSubscriberDetail(currentRoute, target.id),
          { replace: true, source: "deep-link" },
        ).then((result) => {
          if (!mountedRef.current || result !== "proceeded") return;
          markRouteAsExternal();
          state.setSelected(null);
          setRouteOpenError(null);
          setPendingDeepLinkId(target.id);
        });
      }
    };
    accept(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "subscribers") return;
      consumePendingDeepLinkTarget();
      accept(target);
    });
  }, [markRouteAsExternal, mountedRef, state.setSelected]);

  useWriteDesktopTaskIntent({
    intent: "import-subscribers",
    open: state.importOpen,
    canMutate: canImport,
    onOpen: () => state.setImportOpen(true),
    onRouteExit: () => state.setImportOpen(false),
  });

  useEffect(() => {
    if (desktopRoute.section !== "subscribers") return;
    const overlay = desktopRoute.overlay?.name;
    if (overlay !== "create") return;
    if (!canMutate) {
      toast.error("A write role is required to start this subscriber task.");
    }
    void requestDesktopRouteNavigation(
      { ...desktopRoute, overlay: undefined },
      { replace: true, source: "navigation" },
    ).then((result) => {
      if (!mountedRef.current || result !== "proceeded" || !canMutate) return;
      openCreate();
    });
  }, [canMutate, desktopRoute, openCreate]);

  useEffect(() => {
    if (!pendingDeepLinkId || !pendingDeepLinkMatch) return;
    setRouteOpenError(null);
    state.setSelected(pendingDeepLinkMatch);
    setPendingDeepLinkId((current) =>
      current === pendingDeepLinkId ? null : current,
    );
  }, [pendingDeepLinkId, pendingDeepLinkMatch, state.setSelected]);

  useEffect(() => {
    if (!pendingDeepLinkId || pendingDeepLinkMatch || data.loading) return;
    let cancelled = false;
    const controller = new AbortController();
    const id = pendingDeepLinkId;
    void (async () => {
      const response = await api.getSubscriber(id, {
        signal: controller.signal,
      });
      if (cancelled) return;
      if (response.data) {
        setPendingDeepLinkId((current) => (current === id ? null : current));
        setRouteOpenError(null);
        state.setSelected(response.data as Subscriber);
        return;
      }
      const status =
        response.error.kind === "http" ? response.error.status : undefined;
      if (status === 404) {
        const currentRoute = getDesktopRoute();
        let closeResult: Awaited<
          ReturnType<typeof requestDesktopRouteNavigation>
        > = "proceeded";
        if (subscriberDetailRouteId(currentRoute) === id) {
          closeResult = await requestDesktopRouteNavigation(
            routeWithoutSubscriberDetail(currentRoute),
            { replace: true, source: "navigation" },
          );
        }
        if (cancelled) return;
        if (closeResult !== "proceeded") {
          setRouteOpenError(
            "This subscriber no longer exists. Close the detail route after resolving the active task.",
          );
          return;
        }
        setPendingDeepLinkId((current) => (current === id ? null : current));
        toast.error(
          id.includes("@")
            ? `No subscriber found for "${id}".`
            : "Subscriber not found — it may have been deleted.",
        );
      } else if (response.error.kind === "parse") {
        setRouteOpenError(
          "Subscriber details could not be verified. The directory view was kept unchanged.",
        );
        toast.error(
          "Subscriber details couldn't be verified. Refresh the directory and try again.",
        );
      } else {
        setRouteOpenError(
          "Subscriber details are temporarily unavailable. Check the connection and retry.",
        );
        toast.error(
          "Couldn't open the subscriber. Check your connection and try again.",
        );
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    data.loading,
    identityScope,
    lookupNonce,
    pendingDeepLinkId,
    pendingDeepLinkMatch,
    state.setSelected,
  ]);

  return {
    routeOpenError,
    retryRouteOpen: () => setLookupNonce((nonce) => nonce + 1),
    openSubscriber: detailRouteNavigation.openSubscriber,
    navigateSubscriber: detailRouteNavigation.navigateSubscriber,
    closeSubscriber: detailRouteNavigation.closeSubscriber,
  };
}
