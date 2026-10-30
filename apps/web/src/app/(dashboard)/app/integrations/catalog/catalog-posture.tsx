// SPDX-License-Identifier: AGPL-3.0-only
//
// The posture-aware parts of the integration catalog: workspace-state and
// customer-stack narrowing, and the readiness / coverage / stacks / recipes
// panels. They ride the lifecycle client, so the catalog page loads this
// module after first paint; the page's own search, category, status and
// capability filters stay in the static graph.
//
// Those posture reads are admin reads. The page renders these components only
// after it has resolved an owner/admin principal — never for a viewer.
"use client";

import type { ReactNode } from "react";

import {
  CatalogFilters,
  CatalogPosturePanels,
  useCatalogPosture,
} from "@/components/integrations/catalog-filters";
import type { CatalogItem } from "@/lib/integrations-catalog-api";
import {
  EMPTY_POSTURE_FILTER,
  filterCatalogByPosture,
  type CatalogPostureFilter,
  type WorkspaceStateFilter,
} from "@/lib/integrations-lifecycle-api";

export { CatalogPosturePanels };

/** Workspace-state and customer-stack controls, fed by the posture reads. */
export function CatalogPostureFilters({
  value,
  onChange,
  categories,
}: {
  value: CatalogPostureFilter;
  onChange: (next: CatalogPostureFilter) => void;
  categories: readonly { key: string; label: string }[];
}) {
  const posture = useCatalogPosture();
  return (
    <CatalogFilters
      value={value}
      onChange={onChange}
      categories={categories}
      posture={posture}
      postureOnly
    />
  );
}

/**
 * Narrows the page-filtered items by workspace state and customer stack.
 * Search and category were applied by the page with its own semantics;
 * posture adds only state and stack.
 */
export function CatalogPostureResults({
  items,
  state,
  stack,
  children,
}: {
  items: readonly CatalogItem[];
  state: WorkspaceStateFilter;
  stack: string;
  children: (filtered: CatalogItem[]) => ReactNode;
}) {
  const posture = useCatalogPosture();
  const filtered = filterCatalogByPosture(
    items,
    { ...EMPTY_POSTURE_FILTER, state, stack },
    posture.connections,
    posture.stacks,
  );
  return <>{children(filtered)}</>;
}
