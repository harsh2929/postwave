// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useState } from "react";

export const LANDING_PAGE_EDITOR_TABS = [
  "content",
  "seo",
  "settings",
  "preview",
  "variants",
  "history",
] as const;

export type LandingPageEditorTab =
  (typeof LANDING_PAGE_EDITOR_TABS)[number];

export function parseLandingPageEditorTab(
  value: string | null,
): LandingPageEditorTab {
  return (
    LANDING_PAGE_EDITOR_TABS.find((tabValue) => tabValue === value) ??
    "content"
  );
}

function tabFromLocation(): LandingPageEditorTab {
  return parseLandingPageEditorTab(
    new URLSearchParams(window.location.search).get("tab"),
  );
}

export function useLandingPageEditorTab(
  initialValue: string | null,
): readonly [LandingPageEditorTab, (value: string) => void] {
  const [activeTab, setActiveTab] = useState(() =>
    parseLandingPageEditorTab(initialValue),
  );

  useEffect(() => {
    const syncFromLocation = () => setActiveTab(tabFromLocation());

    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);

  // `useSearchParams` updates for App Router navigations that can reuse this
  // mounted editor, while the popstate listener above covers native history
  // traversal immediately.
  useEffect(() => {
    setActiveTab(parseLandingPageEditorTab(initialValue));
  }, [initialValue]);

  const changeTab = useCallback((value: string) => {
    const nextTab = parseLandingPageEditorTab(value);
    setActiveTab(nextTab);

    const url = new URL(window.location.href);
    if (nextTab === "content") url.searchParams.delete("tab");
    else url.searchParams.set("tab", nextTab);

    const href = `${url.pathname}${url.search}${url.hash}`;
    const currentHref =
      `${window.location.pathname}${window.location.search}` +
      window.location.hash;
    if (href !== currentHref) {
      // Preserve Next.js' private history metadata so Back/Forward remains an
      // App Router transition rather than degrading into a document reload.
      window.history.pushState(window.history.state, "", href);
    }
  }, []);

  return [activeTab, changeTab] as const;
}
