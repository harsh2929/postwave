// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure client-side search / status-filter / sort for the flows index
// (FLOW-001). The list endpoint pages by keyset with no server-side search or
// sort, so — mirroring the campaigns list — we fetch the window and reduce it
// here. Kept DOM-free so the ordering/filtering rules unit-test in node.

import type { Flow } from "./flows-api";

export const FLOW_STATUS_FILTERS = [
  "all",
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export type FlowStatusFilter = (typeof FLOW_STATUS_FILTERS)[number];

export const FLOW_SORT_KEYS = ["updated", "name"] as const;
export type FlowSortKey = (typeof FLOW_SORT_KEYS)[number];

export type SortOrder = "asc" | "desc";

export interface FlowListQuery {
  q: string;
  status: FlowStatusFilter;
  sort: FlowSortKey;
  order: SortOrder;
}

export function filterSortFlows(
  flows: Flow[],
  { q, status, sort, order }: FlowListQuery,
): Flow[] {
  const needle = q.trim().toLowerCase();
  const filtered = flows.filter((f) => {
    if (status !== "all" && f.status !== status) return false;
    if (needle && !(f.name ?? "").toLowerCase().includes(needle)) return false;
    return true;
  });

  const dir = order === "asc" ? 1 : -1;
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "name") {
      return (
        dir *
        (a.name ?? "").localeCompare(b.name ?? "", undefined, {
          sensitivity: "base",
        })
      );
    }
    // "updated" — newest first when order is desc.
    const at = Date.parse(a.updated_at ?? "") || 0;
    const bt = Date.parse(b.updated_at ?? "") || 0;
    return dir * (at - bt);
  });
  return sorted;
}

/** Count of flows per status, for filter-chip counts. */
export function countFlowStatuses(flows: Flow[]): Record<string, number> {
  const counts: Record<string, number> = {
    all: flows.length,
    draft: 0,
    active: 0,
    paused: 0,
    archived: 0,
  };
  for (const f of flows) {
    counts[f.status] = (counts[f.status] ?? 0) + 1;
  }
  return counts;
}
