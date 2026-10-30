// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Local-state filters for the historical discount archive. Desktop parity:
 * components/discounts/DiscountHistoryWorkspace.tsx FILTERS (37-46), chip
 * group + Reset (526-548), clickable summary cells (413-419) and the
 * "Review data issues" integrity banner (1209).
 *
 * Client-side over the archive page the host already loaded — no request is
 * made. Every state comes from `discountHistoryState` in lib/discounts-api,
 * which evaluates only the STORED expiry and counters; nothing here speaks
 * for provider, checkout, or entitlement availability, and the copy says
 * "on this page" because the archive is paginated.
 */
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  discountHistoryState,
  type DiscountHistoryRecord,
} from "@/lib/discounts-api";
import { cn } from "@/lib/utils";

export type DiscountRecordFilter =
  | "all"
  | "within_stored_rules"
  | "closed"
  | "expired"
  | "cap_reached"
  | "data_issue";

export const DISCOUNT_RECORD_FILTERS: ReadonlyArray<{
  id: DiscountRecordFilter;
  label: string;
}> = [
  { id: "all", label: "All records" },
  { id: "within_stored_rules", label: "Within stored rules" },
  { id: "closed", label: "Closed by stored rules" },
  { id: "expired", label: "Expired" },
  { id: "cap_reached", label: "Cap reached" },
  { id: "data_issue", label: "Data issues" },
];

type FilterableRecord = Pick<
  DiscountHistoryRecord,
  "times_redeemed" | "max_redemptions" | "expires_at" | "issues"
>;

export function discountRecordMatchesFilter(
  record: FilterableRecord,
  filter: DiscountRecordFilter,
  now: number = Date.now(),
): boolean {
  if (filter === "all") return true;
  const state = discountHistoryState(record, now);
  if (filter === "closed")
    return state === "expired" || state === "cap_reached";
  return state === filter;
}

export type DiscountRecordCounts = Record<DiscountRecordFilter, number> & {
  recordedUses: number;
};

export function discountRecordFilterCounts(
  records: readonly FilterableRecord[],
  now: number = Date.now(),
): DiscountRecordCounts {
  const counts: DiscountRecordCounts = {
    all: records.length,
    within_stored_rules: 0,
    closed: 0,
    expired: 0,
    cap_reached: 0,
    data_issue: 0,
    recordedUses: 0,
  };
  for (const record of records) {
    const state = discountHistoryState(record, now);
    counts[state] += 1;
    if (state === "expired" || state === "cap_reached") counts.closed += 1;
    counts.recordedUses += Number.isFinite(record.times_redeemed)
      ? record.times_redeemed
      : 0;
  }
  return counts;
}

export function DiscountRecordFilters({
  records,
  filter,
  onFilterChange,
  search = "",
  onClearSearch,
  now,
}: {
  records: readonly FilterableRecord[];
  filter: DiscountRecordFilter;
  onFilterChange: (filter: DiscountRecordFilter) => void;
  search?: string;
  onClearSearch?: () => void;
  /** Evaluation instant; defaults to the render time. */
  now?: number;
}) {
  const counts = discountRecordFilterCounts(records, now);
  const narrowed = filter !== "all" || search.trim() !== "";
  const summaryCells: Array<{
    label: string;
    value: number;
    detail: string;
    filter?: DiscountRecordFilter;
  }> = [
    {
      label: "Records on page",
      value: counts.all,
      detail: "Every record in this archive page.",
      filter: "all",
    },
    {
      label: "Within stored rules",
      value: counts.within_stored_rules,
      detail: "No local expiry or cap closure detected.",
      filter: "within_stored_rules",
    },
    {
      label: "Stored-rule closures",
      value: counts.closed,
      detail: "Expired or at the recorded cap.",
      filter: "closed",
    },
    {
      label: "Recorded uses",
      value: counts.recordedUses,
      detail: "Sum of local counters; not a revenue total.",
    },
  ];

  return (
    <div className="space-y-3">
      <section
        aria-label="Archive page summary"
        className="grid grid-cols-2 gap-2 lg:grid-cols-4"
      >
        {summaryCells.map((cell) => {
          const content = (
            <>
              <span className="block text-xs text-muted-foreground">
                {cell.label}
              </span>
              <strong className="mt-1 block font-medium tabular-nums">
                {cell.value.toLocaleString()}
              </strong>
              <small className="mt-0.5 block text-xs text-muted-foreground">
                {cell.detail}
              </small>
            </>
          );
          return cell.filter ? (
            <button
              key={cell.label}
              type="button"
              onClick={() => onFilterChange(cell.filter!)}
              aria-pressed={filter === cell.filter}
              aria-label={`${cell.label}: ${cell.value.toLocaleString()}. Filter records.`}
              className={cn(
                "min-h-11 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === cell.filter && "border-primary bg-primary/5",
              )}
            >
              {content}
            </button>
          ) : (
            <div key={cell.label} className="rounded-md border px-3 py-2">
              {content}
            </div>
          );
        })}
      </section>

      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">
          Filter discount history on this page
        </legend>
        {DISCOUNT_RECORD_FILTERS.map((item) => {
          const active = filter === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(item.id)}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{item.label}</span>
              <strong className="tabular-nums">
                {counts[item.id].toLocaleString()}
              </strong>
            </button>
          );
        })}
        {narrowed ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onClearSearch?.();
              onFilterChange("all");
            }}
          >
            Reset
          </Button>
        ) : null}
      </fieldset>

      {counts.data_issue > 0 ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex items-start gap-2">
            <ShieldAlert
              className="mt-0.5 size-4 shrink-0 text-warning-emphasis"
              aria-hidden
            />
            <span>
              {counts.data_issue.toLocaleString()}{" "}
              {counts.data_issue === 1
                ? "record on this page has"
                : "records on this page have"}{" "}
              field integrity warnings. Nothing has been silently classified as
              usable.
            </span>
          </span>
          {filter !== "data_issue" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onFilterChange("data_issue")}
            >
              Review data issues
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
