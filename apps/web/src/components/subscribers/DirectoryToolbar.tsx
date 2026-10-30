// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { memo } from "react";
import { Bookmark, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";

import { DirectoryLiveBanner } from "./DirectoryLiveBanner";
import { DirectorySortControl } from "./DirectorySortControl";
import { DirectoryStatusChips } from "./DirectoryStatusChips";
import { RefreshDirectoryButton, ResetViewButton } from "./DirectoryViewActions";

// The subscribers page keeps secondary analytics and closed forms off the
// list's critical graph (see heavy-route-lazy-boundaries.test.ts). The same
// rule applies here: the filter/sort controls load with the list, while the
// insights figures and the two dialog tools load on their own.
const LazyInsightsStatStrip = dynamic(
  () => import("./InsightsStatStrip").then((module) => module.InsightsStatStrip),
  {
    ssr: false,
    loading: () => (
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        Loading directory insights…
      </p>
    ),
  },
);
const LazySavedViewsMenu = dynamic(
  () => import("./SavedViewsMenu").then((module) => module.SavedViewsMenu),
  {
    ssr: false,
    loading: () => (
      <Button type="button" variant="outline" size="sm" className="h-9" disabled>
        <Bookmark aria-hidden className="h-4 w-4" />
        Saved views
      </Button>
    ),
  },
);
const LazyLookalikeDialog = dynamic(
  () => import("./LookalikeDialog").then((module) => module.LookalikeDialog),
  {
    ssr: false,
    loading: () => (
      <Button type="button" variant="outline" size="sm" className="h-9" disabled>
        <UsersRound aria-hidden className="h-4 w-4" />
        Lookalike
      </Button>
    ),
  },
);

/**
 * The directory's browse toolbar (desktop SubscribersBrowsePanel's header):
 * insights, live-addition notice, status chips, server sort, saved views,
 * lookalike generation, refresh and reset. Every control reads and writes the
 * page's own URL state, so it needs no props — and is memoised so the search
 * box's per-keystroke state never re-renders it.
 */
export const DirectoryToolbar = memo(function DirectoryToolbar() {
  return (
    <section aria-label="Directory view" className="space-y-2">
      <LazyInsightsStatStrip />
      <DirectoryLiveBanner />
      <div className="flex flex-wrap items-center gap-2">
        <DirectoryStatusChips />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DirectorySortControl />
          <LazySavedViewsMenu />
          <LazyLookalikeDialog />
          <RefreshDirectoryButton />
          <ResetViewButton />
        </div>
      </div>
    </section>
  );
});
