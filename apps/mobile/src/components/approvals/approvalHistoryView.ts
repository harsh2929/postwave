/**
 * approvalHistoryView — slicing and ordering the loaded approvals window.
 *
 * Desktop's history tab has a resolved-status select and a sort select
 * (ApprovalsWorkspace.tsx:395/:413, comparators in approvals-view-model.ts);
 * mobile had only Pending/All chips, so a phone approver auditing past
 * decisions could not slice the loaded history by resolved state or reorder
 * it. This module is the pure half of that parity gap.
 *
 * Two deliberate translations rather than copies:
 *
 *  - NO "unverified" STATUS CHIP. Desktop's `unverified` is a synthetic
 *    decode-failure state its own decoder mints (`{ id, status: "unverified" }`
 *    in useApprovalsController.ts:130); mobile's normalizer has no such state,
 *    so a chip for it could only ever show an empty list and would read as
 *    a broken filter.
 *  - THE STATUS SLICE APPLIES TO THE "All" WINDOW ONLY. The Pending chip IS
 *    a status filter already; stacking a second one under it would offer two
 *    controls that can contradict each other.
 *
 * Everything here narrows/reorders the LOADED window (the same rows the
 * search box sees) — the server list has no status/sort params, and desktop
 * slices client-side over its window too.
 *
 * Import-free of react-native, asserted under node vitest.
 */
import type { ApprovalStatus } from "@/hooks/useApprovals";

import { resourceLabel } from "./approvalPresentation";

/** The row shape the slicer needs — structural, like approvalSearch's. */
export interface ApprovalHistoryRow {
  resourceType: string;
  resourceId?: string | null;
  requestedByActorLabel?: string | null;
  requestedAt: string;
  status: ApprovalStatus;
}

export type ApprovalStatusFilter = "all" | "approved" | "rejected" | "expired";

export const APPROVAL_STATUS_FILTERS: readonly {
  key: ApprovalStatusFilter;
  label: string;
}[] = [
  { key: "all", label: "Any status" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "expired", label: "Expired" },
];

/** Same option set as desktop's sort select (status omitted on Pending). */
export type ApprovalSortKey =
  | "newest"
  | "oldest"
  | "resource"
  | "requester"
  | "status";

export const APPROVAL_SORTS: readonly {
  key: ApprovalSortKey;
  label: string;
  /** Status ordering is meaningless on an all-pending window. */
  historyOnly?: boolean;
}[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "resource", label: "Resource" },
  { key: "requester", label: "Requester" },
  { key: "status", label: "Status", historyOnly: true },
];

export function narrowApprovalsByStatus<T extends ApprovalHistoryRow>(
  rows: readonly T[],
  status: ApprovalStatusFilter,
): T[] {
  if (status === "all") return rows as T[];
  return rows.filter((row) => row.status === status);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function requestedMs(row: ApprovalHistoryRow): number {
  const ms = Date.parse(row.requestedAt);
  // An unparseable timestamp sorts to the OLD end in both directions rather
  // than jumping the queue: a row whose age is unknown must not present
  // itself as the newest thing to decide.
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Same comparators as desktop's `sortedApprovals` (approvals-view-model.ts),
 * matching the HUMAN-READABLE resource label the rows actually display —
 * ordering by the wire value would interleave "Campaign send" under `c`.
 */
export function sortApprovals<T extends ApprovalHistoryRow>(
  rows: readonly T[],
  sort: ApprovalSortKey,
): T[] {
  return [...rows].sort((left, right) => {
    if (sort === "oldest") return requestedMs(left) - requestedMs(right);
    if (sort === "resource") {
      return compareText(
        `${resourceLabel(left.resourceType)} ${left.resourceId ?? ""}`,
        `${resourceLabel(right.resourceType)} ${right.resourceId ?? ""}`,
      );
    }
    if (sort === "requester") {
      return compareText(
        left.requestedByActorLabel ?? "",
        right.requestedByActorLabel ?? "",
      );
    }
    if (sort === "status") return compareText(left.status, right.status);
    return requestedMs(right) - requestedMs(left);
  });
}

/**
 * One pass: status slice, then order. The search predicate runs BEFORE this
 * (the count chip discloses search results), so the pipeline in the screen is
 * search → status → sort.
 */
export function applyApprovalHistoryView<T extends ApprovalHistoryRow>(
  rows: readonly T[],
  view: { status: ApprovalStatusFilter; sort: ApprovalSortKey },
  pendingOnly: boolean,
): T[] {
  const sliced = pendingOnly ? (rows as T[]) : narrowApprovalsByStatus(rows, view.status);
  return sortApprovals(sliced, view.sort);
}
