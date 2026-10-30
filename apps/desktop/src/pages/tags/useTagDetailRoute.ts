import { useCallback, useEffect, useRef } from "react";

import { toast } from "../../components/Toast";
import type { Tag } from "../../lib/api-client";
import {
  getDesktopRoute,
  requestDesktopRouteBackNavigation,
  requestDesktopRouteNavigation,
  serializeDesktopRoute,
  useDesktopRouteSnapshot,
} from "../../lib/desktop-router";
import {
  routeWithTagDetail,
  routeWithoutTagDetail,
  tagDetailRouteId,
} from "./tagRouteState";

interface Options {
  rows: Tag[] | null;
  loading: boolean;
  detailTag: Tag | null;
  setDetailTag: (tag: Tag | null) => void;
}

export function useTagDetailRoute({
  rows,
  loading,
  detailTag,
  setDetailTag,
}: Options) {
  const snapshot = useDesktopRouteSnapshot();
  const routedId = tagDetailRouteId(snapshot.route);
  const mountedRef = useRef(true);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const previousRoutedIdRef = useRef<string | null>(null);
  const closeInFlightRef = useRef(false);
  const missingNoticeRef = useRef<string | null>(null);
  const localHistoryRef = useRef<{
    baseCanonicalUrl: string;
    detailCanonicalUrl: string;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const previousRoutedId = previousRoutedIdRef.current;
    previousRoutedIdRef.current = routedId;
    if (routedId) {
      closeInFlightRef.current = false;
      const match = rows?.find((row) => row.id === routedId);
      if (match) {
        missingNoticeRef.current = null;
        if (detailTag?.id !== match.id || detailTag !== match) {
          setDetailTag(match);
        }
        return;
      }
      if (rows !== null && !loading && missingNoticeRef.current !== routedId) {
        missingNoticeRef.current = routedId;
        toast.error("That tag no longer exists or is outside this catalogue.");
        void requestDesktopRouteNavigation(
          routeWithoutTagDetail(snapshot.route),
          { replace: true, source: "navigation" },
        );
      }
      return;
    }
    if (detailTag) setDetailTag(null);
    if (!previousRoutedId) return;
    closeInFlightRef.current = false;
    const returnTarget = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!returnTarget?.isConnected) return;
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (returnTarget.isConnected) returnTarget.focus();
    });
  }, [detailTag, loading, routedId, rows, setDetailTag, snapshot.route]);

  const openDetail = useCallback(
    (tag: Tag): void => {
      const id = tag.id.trim();
      if (!id) {
        toast.error(
          "This tag cannot be opened because its identity is missing.",
        );
        return;
      }
      const invocationTarget =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const currentRoute = getDesktopRoute();
      const targetRoute = routeWithTagDetail(currentRoute, id);
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
          tagDetailRouteId(getDesktopRoute()) !== id
        ) {
          return;
        }
        localHistoryRef.current = localHistory;
        returnFocusRef.current = invocationTarget;
        setDetailTag(tag);
      });
    },
    [setDetailTag],
  );

  const closeDetail = useCallback((): void => {
    if (closeInFlightRef.current) return;
    const currentRoute = getDesktopRoute();
    if (!tagDetailRouteId(currentRoute)) return;
    const targetRoute = routeWithoutTagDetail(currentRoute);
    const localHistory = localHistoryRef.current;
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
      if (!mountedRef.current || result === "proceeded") return;
      closeInFlightRef.current = false;
    })();
  }, []);

  return { routedId, openDetail, closeDetail };
}

export type TagDetailRouteController = ReturnType<typeof useTagDetailRoute>;
