// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// React binding for lib/analytics-view-params: reads ?metric / ?focus /
// ?compare / ?group_by from the live URL after mount (so SSR output stays
// stable), follows back/forward, and writes changes with replaceState so a
// toggle never adds a history entry. Every instance on the page resyncs on
// one custom event, so the compare toggle and the tiles it governs agree.

import { useCallback, useEffect, useState, type RefObject } from "react";

import {
  parseAnalyticsView,
  withAnalyticsParam,
  type AnalyticsView,
} from "@/lib/analytics-view-params";

const VIEW_EVENT = "postwave:analytics-view";

const DEFAULT_VIEW: AnalyticsView = {
  metric: null,
  focus: null,
  compare: true,
  groupBy: null,
};

export function useAnalyticsView(): {
  view: AnalyticsView;
  mounted: boolean;
  setParam: (key: string, value: string | null) => void;
} {
  const [view, setView] = useState<AnalyticsView>(DEFAULT_VIEW);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const sync = () => setView(parseAnalyticsView(window.location.search));
    setMounted(true);
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener(VIEW_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(VIEW_EVENT, sync);
    };
  }, []);

  const setParam = useCallback((key: string, value: string | null) => {
    const next = withAnalyticsParam(window.location.href, key, value);
    window.history.replaceState(window.history.state, "", next);
    window.dispatchEvent(new Event(VIEW_EVENT));
  }, []);

  return { view, mounted, setParam };
}

/**
 * Scroll a deep-linked element into view when the URL names it. The caller
 * renders the highlight itself. The jump is instant (no smooth scroll), so
 * there is no motion to reduce.
 */
export function useScrollToTarget(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView?.({ block: "center" });
  }, [active, ref]);
}
