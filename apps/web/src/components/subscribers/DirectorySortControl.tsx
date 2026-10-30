// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { DirectorySortKey } from "@/lib/subscriber-directory-api";

import { useDirectoryUrlState } from "./directory-context";

// Every option is a server sort the list endpoint's `normalizeSort` accepts,
// so the order applies across ALL pages, not just the 50 rows on screen.
// Desktop's page-only sorts (full name, display name) are deliberately absent:
// they reorder one page and would read as a directory-wide ordering here.
export const DIRECTORY_SORT_OPTIONS: { value: DirectorySortKey; label: string }[] =
  [
    { value: "updated_at", label: "Last updated" },
    { value: "created_at", label: "Joined" },
    { value: "email", label: "Email" },
    { value: "status", label: "Status" },
    { value: "engagement", label: "Engagement" },
    { value: "rating", label: "Rating" },
    { value: "churn", label: "Churn score" },
    { value: "first_name", label: "First name" },
    { value: "last_name", label: "Last name" },
  ];

export function DirectorySortControl() {
  const { view, setState } = useDirectoryUrlState();
  const searching = view.q.trim().length > 0;
  const descending = view.order === "desc";
  const reason = searching
    ? "Search results are ranked by relevance; clear the search to sort."
    : undefined;
  return (
    <div className="flex items-center gap-1">
      <Select
        aria-label="Sort subscribers by"
        value={view.sort}
        disabled={searching}
        title={reason}
        onChange={(event) =>
          setState({
            sort: event.target.value as DirectorySortKey,
            order: "desc",
            page: 1,
          })
        }
        className="h-9 w-40"
      >
        {DIRECTORY_SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9"
        disabled={searching}
        title={reason}
        aria-label={descending ? "Sorted descending — switch to ascending" : "Sorted ascending — switch to descending"}
        onClick={() =>
          setState({ order: descending ? "asc" : "desc", page: 1 })
        }
      >
        {descending ? (
          <ArrowDownWideNarrow aria-hidden className="h-4 w-4" />
        ) : (
          <ArrowUpNarrowWide aria-hidden className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}
