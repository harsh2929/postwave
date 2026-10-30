/**
 * InboxFilters — filter chips + sort picker for the SMS inbox list.
 * Refined SMS Inbox PR 1.
 *
 * Chips: All / Unread / Unknown subscriber. Each carries a badge
 * count fed from the server-computed totals (unreadTotal /
 * unknownTotal / totalConversations), so the badges stay stable when
 * the active chip changes — the count reflects the inbox, not the
 * current view.
 *
 * Sort: Most recent (default chat order) vs Oldest unread first (the
 * inbox-zero triage view). Two options is the right number — more
 * and operators stop reading the dropdown.
 */

import { type ReactElement, useId } from "react";

import type {
  SMSConversationFilter,
  SMSConversationSort,
} from "../../lib/api-client";

interface Props {
  filter: SMSConversationFilter;
  sort: SMSConversationSort;
  totals: {
    total: number;
    unread: number;
    unknown: number;
  };
  onFilterChange: (f: SMSConversationFilter) => void;
  onSortChange: (s: SMSConversationSort) => void;
}

const FILTER_CHIPS: Array<{
  id: SMSConversationFilter;
  label: string;
  badgeKey: keyof Props["totals"];
}> = [
  { id: "all", label: "All", badgeKey: "total" },
  { id: "unread", label: "Unread", badgeKey: "unread" },
  { id: "unknown", label: "Unknown subscriber", badgeKey: "unknown" },
];

export function InboxFilters({
  filter,
  sort,
  totals,
  onFilterChange,
  onSortChange,
}: Props): ReactElement {
  const filterDescriptionId = useId();
  const sortId = useId();
  return (
    <div className="sms-inbox-filters">
      <div
        className="chips"
        role="group"
        aria-label="Conversation filter"
        aria-describedby={filterDescriptionId}
      >
        {FILTER_CHIPS.map((c) => {
          const count = totals[c.badgeKey];
          const isActive = filter === c.id;
          return (
            <button
              key={c.id}
              type="button"
              className={`chip${isActive ? " is-active" : ""}`}
              onClick={() => onFilterChange(c.id)}
              aria-pressed={isActive}
            >
              {c.label}
              {count > 0 ? (
                <span className="sms-chip-count tabular">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <label className="sms-inbox-sort-label" htmlFor={sortId}>
        <span className="muted small">Sort</span>
        <select
          id={sortId}
          className="input sms-inbox-sort"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SMSConversationSort)}
        >
          <option value="recent">Most recent</option>
          <option value="oldest_unread">Oldest unread first</option>
        </select>
      </label>
      <span
        id={filterDescriptionId}
        className="muted small sms-inbox-filter-description"
      >
        Unknown subscribers are phone numbers with no matched subscriber record.
        {sort === "oldest_unread"
          ? " Oldest unread uses the earliest unread inbound record at the loaded message-created cutoff; later receipts and late commits can change the order after refresh."
          : ""}
      </span>
    </div>
  );
}
