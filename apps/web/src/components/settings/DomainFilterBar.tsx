// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Search / ownership-status filter / sort over the custom-domain ownership
 * rows the page has already fetched and tenant-checked from the
 * custom-domains list endpoint. Desktop parity: pages/CustomDomains.tsx
 * FILTERS/SORTS (36-49),
 * search input (461-465), status chips (483-491), Clear filters (552-557).
 *
 * Purely client-side: no request is made here, so nothing about the
 * registry's authority changes. Rows are never re-fetched or mutated, and the
 * "no matching hostnames" state names the size of the underlying registry so
 * a narrowed view is never mistaken for an empty one.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import { Search, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  CustomDomain,
  CustomDomainPurpose,
} from "@/lib/custom-domains-api";
import { cn } from "@/lib/utils";

export type CustomDomainFilter = "all" | "verified" | "pending";
export type CustomDomainSort = "newest" | "oldest" | "domain" | "status";

export const CUSTOM_DOMAIN_FILTERS: ReadonlyArray<{
  value: CustomDomainFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "verified", label: "Last check passed" },
  { value: "pending", label: "Needs DNS" },
];

export const CUSTOM_DOMAIN_SORTS: ReadonlyArray<{
  value: CustomDomainSort;
  label: string;
}> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "domain", label: "Hostname A–Z" },
  { value: "status", label: "Needs action first" },
];

const PURPOSE_SEARCH_LABELS: Record<CustomDomainPurpose, string> = {
  forms: "Hosted forms",
  links: "Short links",
  web: "Public archive / site",
  tracking: "Open tracking",
};

function createdTime(row: CustomDomain): number {
  const parsed = Date.parse(row.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function filterAndSortCustomDomains(
  rows: readonly CustomDomain[],
  query: string,
  filter: CustomDomainFilter,
  sort: CustomDomainSort,
): CustomDomain[] {
  const needle = query.trim().toLocaleLowerCase().slice(0, 253);
  const visible = rows.filter((row) => {
    if (filter === "verified" && !row.verified) return false;
    if (filter === "pending" && row.verified) return false;
    return (
      !needle ||
      row.domain.toLocaleLowerCase().includes(needle) ||
      PURPOSE_SEARCH_LABELS[row.purpose].toLocaleLowerCase().includes(needle)
    );
  });
  return visible.sort((left, right) => {
    if (sort === "domain") return left.domain.localeCompare(right.domain);
    if (sort === "status") {
      return (
        Number(left.verified) - Number(right.verified) ||
        left.domain.localeCompare(right.domain)
      );
    }
    const delta = createdTime(left) - createdTime(right);
    return sort === "oldest" ? delta : -delta;
  });
}

function filterCount(
  filter: CustomDomainFilter,
  rows: readonly CustomDomain[],
): number {
  if (filter === "verified") return rows.filter((row) => row.verified).length;
  if (filter === "pending") return rows.filter((row) => !row.verified).length;
  return rows.length;
}

/**
 * Renders the toolbar and hands the visible rows to `children`. When the
 * narrowing matches nothing it renders its own "no matching hostnames" state
 * with a Clear filters action instead of calling `children` with [].
 */
export function DomainFilterBar({
  domains,
  children,
}: {
  domains: readonly CustomDomain[];
  children: (visible: CustomDomain[]) => ReactNode;
}) {
  const searchId = useId();
  const sortId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CustomDomainFilter>("all");
  const [sort, setSort] = useState<CustomDomainSort>("newest");
  const visible = useMemo(
    () => filterAndSortCustomDomains(domains, query, filter, sort),
    [domains, filter, query, sort],
  );
  const narrowed = query.trim() !== "" || filter !== "all";
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor={searchId} className="sr-only">
            Search registered domains
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Search hostname or registration intent"
              autoComplete="off"
              spellCheck={false}
              className={cn("pl-8", query ? "pr-16" : undefined)}
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2"
                aria-label="Clear domain search"
                onClick={() => setQuery("")}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        <div
          role="group"
          aria-label="Filter domains by ownership status"
          className="flex flex-wrap gap-2"
        >
          {CUSTOM_DOMAIN_FILTERS.map((item) => {
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(item.value)}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{item.label}</span>
                <strong className="tabular-nums">
                  {filterCount(item.value, domains).toLocaleString()}
                </strong>
              </button>
            );
          })}
        </div>
        <div className="space-y-1.5 lg:w-48">
          <label
            htmlFor={sortId}
            className="text-xs font-medium text-muted-foreground"
          >
            Sort
          </label>
          <Select
            id={sortId}
            value={sort}
            onChange={(event) =>
              setSort(event.target.value as CustomDomainSort)
            }
          >
            {CUSTOM_DOMAIN_SORTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        Showing {visible.length.toLocaleString()} of{" "}
        {domains.length.toLocaleString()} registered domains.
      </p>

      {visible.length === 0 && domains.length > 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-6 text-center">
          <SearchX className="size-5 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">No matching hostnames</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No domain matches this search and ownership filter. The underlying
              registry has {domains.length.toLocaleString()} row
              {domains.length === 1 ? "" : "s"}.
            </p>
          </div>
          {narrowed ? (
            <Button type="button" variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : (
        children(visible)
      )}
    </div>
  );
}
