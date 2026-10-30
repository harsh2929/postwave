// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Filter chips + sort picker for the SMS conversation list (desktop
// components/sms/InboxFilters.tsx). Chips: All / Unread / Unknown subscriber,
// each carrying the server-computed inbox total (totalConversations /
// unreadTotal / unknownTotal) so a badge describes the inbox, not the current
// view. Sort: Most recent vs Oldest unread first.
//
// Pure presentation: the owner passes `filter` and `sort` straight to
// listSmsConversations({ filter, sort, ... }) — GET
// /api/v1/sms/conversations?filter=&sort= — and into its query key, so a
// changed chip is a new server query, never a client-side re-filter.

import { useId } from "react";

import { Button } from "@/components/ui/button";

export type SmsInboxFilter = "all" | "unread" | "unknown";
export type SmsInboxSort = "recent" | "oldest_unread";

export const SMS_INBOX_FILTER_CHIPS: ReadonlyArray<{
  id: SmsInboxFilter;
  label: string;
  total: "total" | "unread" | "unknown";
}> = [
  { id: "all", label: "All", total: "total" },
  { id: "unread", label: "Unread", total: "unread" },
  { id: "unknown", label: "Unknown subscriber", total: "unknown" },
];

export function SmsInboxFilters({
  filter,
  sort,
  totals,
  disabled = false,
  onFilterChange,
  onSortChange,
}: {
  filter: SmsInboxFilter;
  sort: SmsInboxSort;
  /** Server totals from the loaded page; null until a page has verified. */
  totals: { total: number; unread: number; unknown: number } | null;
  disabled?: boolean;
  onFilterChange: (filter: SmsInboxFilter) => void;
  onSortChange: (sort: SmsInboxSort) => void;
}) {
  const descriptionId = useId();
  const sortId = useId();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Conversation filter"
          aria-describedby={descriptionId}
        >
          {SMS_INBOX_FILTER_CHIPS.map((chip) => {
            const active = filter === chip.id;
            const count = totals ? totals[chip.total] : null;
            return (
              <Button
                key={chip.id}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                className="min-h-11"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => {
                  if (!active) onFilterChange(chip.id);
                }}
              >
                {count !== null ? `${chip.label} (${count})` : chip.label}
              </Button>
            );
          })}
        </div>
        <label
          htmlFor={sortId}
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          Sort
          <select
            id={sortId}
            className="min-h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={sort}
            disabled={disabled}
            onChange={(event) =>
              onSortChange(
                event.target.value === "oldest_unread"
                  ? "oldest_unread"
                  : "recent",
              )
            }
          >
            <option value="recent">Most recent</option>
            <option value="oldest_unread">Oldest unread first</option>
          </select>
        </label>
      </div>
      <p id={descriptionId} className="text-xs text-muted-foreground">
        Unknown subscribers are phone numbers with no matched subscriber
        record.
        {sort === "oldest_unread"
          ? " Oldest unread orders by the earliest unread inbound record at the response cutoff; later receipts can change the order after refresh."
          : ""}
      </p>
    </div>
  );
}
