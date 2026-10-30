// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Tab registry for the Commerce workspace.
 *
 * To add a tab: append its id to `COMMERCE_TAB_IDS` (commerce-context.ts) and
 * its entry to `REGISTRY` below. The `Record<CommerceTabId, …>` type makes a
 * missing entry a typecheck error, and the ordered list is derived from the
 * id list so tab order lives in exactly one place.
 */

import type { ComponentType } from "react";
import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

import { CatalogsTab } from "./catalogs-tab";
import {
  COMMERCE_TAB_IDS,
  type CommerceTabId,
  type CommerceWorkspaceContext,
} from "./commerce-context";

/** Placeholder while a deferred tab's module loads; mirrors the rows each
 *  tab shows while its own first query is pending. */
function TabLoading({ label }: { label: string }) {
  return (
    <div
      className="space-y-2"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

// Catalogs is the default tab and stays in the route graph. The other tabs
// only mount when selected, so their modules load on demand and the page
// stays under the dashboard bundle budget without changing what each shows.
const FeedsTab = dynamic(
  () => import("./feeds-tab").then((module) => module.FeedsTab),
  { loading: () => <TabLoading label="Loading feeds" /> },
);
const StoreDataTab = dynamic(
  () => import("./store-data-tab").then((module) => module.StoreDataTab),
  { loading: () => <TabLoading label="Loading store data" /> },
);
const RecoveryTab = dynamic(
  () => import("./recovery-tab").then((module) => module.RecoveryTab),
  { loading: () => <TabLoading label="Loading recovery and alerts" /> },
);
const LifecycleTab = dynamic(
  () => import("./lifecycle-tab").then((module) => module.LifecycleTab),
  { loading: () => <TabLoading label="Loading lifecycle health" /> },
);

export interface CommerceTabDefinition {
  id: CommerceTabId;
  label: string;
  Component: ComponentType<{ ctx: CommerceWorkspaceContext }>;
}

const REGISTRY: Record<CommerceTabId, Omit<CommerceTabDefinition, "id">> = {
  catalogs: { label: "Catalogs", Component: CatalogsTab },
  feeds: { label: "Feeds", Component: FeedsTab },
  stores: { label: "Store data", Component: StoreDataTab },
  recovery: { label: "Recovery & alerts", Component: RecoveryTab },
  lifecycle: { label: "Lifecycle", Component: LifecycleTab },
};

export const COMMERCE_TABS: readonly CommerceTabDefinition[] =
  COMMERCE_TAB_IDS.map((id) => ({ id, ...REGISTRY[id] }));
