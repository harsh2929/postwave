// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Search / sort / reset over the LOADED approvals window (desktop parity:
// pages/approvals/ApprovalsWorkspace.tsx ApprovalFilters +
// approvals-view-model.ts visibleApprovalRows). Purely client-side: no request
// is made, and the copy says the result covers only the rows already loaded.

import { useMemo, useState } from "react";
import { RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  requesterLabel,
  resourceTypeLabel,
  type Approval,
} from "@/lib/approvals-api";

export type ApprovalSort =
  | "newest"
  | "oldest"
  | "resource"
  | "requester"
  | "status";

export interface ApprovalsView {
  query: string;
  sort: ApprovalSort;
}

export const DEFAULT_APPROVALS_VIEW: ApprovalsView = {
  query: "",
  sort: "newest",
};

const SORT_OPTIONS: ReadonlyArray<{ value: ApprovalSort; label: string }> = [
  { value: "newest", label: "Newest request" },
  { value: "oldest", label: "Oldest request" },
  { value: "resource", label: "Resource" },
  { value: "requester", label: "Requester" },
  { value: "status", label: "Status" },
];
const SORT_VALUES = new Set<string>(SORT_OPTIONS.map((option) => option.value));
const QUERY_MAX = 120;

function searchable(approval: Approval): string {
  return [
    resourceTypeLabel(approval.resourceType),
    approval.resourceId,
    approval.status,
    requesterLabel(approval),
    approval.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

/** Filters then sorts the loaded rows; never mutates the input. */
export function visibleApprovals(
  rows: readonly Approval[],
  view: ApprovalsView,
): Approval[] {
  const query = view.query.trim().toLocaleLowerCase();
  const scoped = query
    ? rows.filter((approval) => searchable(approval).includes(query))
    : [...rows];
  return scoped.sort((left, right) => {
    switch (view.sort) {
      case "oldest":
        return Date.parse(left.requestedAt) - Date.parse(right.requestedAt);
      case "resource":
        return compareText(
          `${resourceTypeLabel(left.resourceType)} ${left.resourceId}`,
          `${resourceTypeLabel(right.resourceType)} ${right.resourceId}`,
        );
      case "requester":
        return compareText(requesterLabel(left), requesterLabel(right));
      case "status":
        return compareText(left.status, right.status);
      default:
        return Date.parse(right.requestedAt) - Date.parse(left.requestedAt);
    }
  });
}

export function isFilteredView(view: ApprovalsView): boolean {
  return view.query.trim() !== "" || view.sort !== "newest";
}

/** Local view state + the derived rows for one loaded approvals window. */
export function useApprovalsSearchSort(rows: readonly Approval[]) {
  const [view, setView] = useState<ApprovalsView>(DEFAULT_APPROVALS_VIEW);
  const visible = useMemo(() => visibleApprovals(rows, view), [rows, view]);
  return {
    view,
    visible,
    barProps: {
      view,
      loadedCount: rows.length,
      visibleCount: visible.length,
      onQueryChange: (query: string) =>
        setView((current) => ({ ...current, query: query.slice(0, QUERY_MAX) })),
      onSortChange: (sort: ApprovalSort) =>
        setView((current) => ({ ...current, sort })),
      onReset: () => setView(DEFAULT_APPROVALS_VIEW),
    },
  };
}

export interface ApprovalsSearchSortBarProps {
  view: ApprovalsView;
  loadedCount: number;
  visibleCount: number;
  onQueryChange: (query: string) => void;
  onSortChange: (sort: ApprovalSort) => void;
  onReset: () => void;
}

export function ApprovalsSearchSortBar({
  view,
  loadedCount,
  visibleCount,
  onQueryChange,
  onSortChange,
  onReset,
}: ApprovalsSearchSortBarProps) {
  const filtered = isFilteredView(view);
  return (
    <form
      role="search"
      aria-label="Search loaded approvals"
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="min-w-0 flex-1 space-y-1.5 sm:min-w-56">
        <Label htmlFor="approvals-search">Search loaded records</Label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="approvals-search"
            type="search"
            className="pl-8"
            value={view.query}
            maxLength={QUERY_MAX}
            placeholder="Resource, requester, status, or reason"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5 sm:w-48">
        <Label htmlFor="approvals-sort">Sort</Label>
        <Select
          id="approvals-sort"
          value={view.sort}
          onChange={(event) => {
            const next = event.target.value;
            if (SORT_VALUES.has(next)) onSortChange(next as ApprovalSort);
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {filtered ? (
        <Button type="button" variant="ghost" onClick={onReset}>
          <RotateCcw aria-hidden />
          Reset
        </Button>
      ) : null}
      <p
        role="status"
        aria-live="polite"
        className="basis-full text-xs text-muted-foreground"
      >
        Showing {visibleCount} of {loadedCount} loaded approval
        {loadedCount === 1 ? "" : "s"}. Search and sort apply to this loaded
        window only.
      </p>
    </form>
  );
}
