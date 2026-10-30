// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Group-by picker for the Analytics page (desktop GroupByMenu). Eight entries:
// None, Campaign and Domain are chartable; List, Segment, Country, Mail client
// and Device are listed DISABLED with the reason, never hidden, so the
// affordance is the same for every reader and nobody is shown a fabricated
// breakdown. The reasons are the server's own contract:
//   * list  — GET /api/v1/analytics/timeseries 400s `unsupported_dimension`
//             (events carry no list attribution);
//   * the rest — the grouped endpoint only accepts campaign | domain.
// A native <select> keeps keyboard, type-ahead and mobile pickers accessible.

import { useId } from "react";

import { Select } from "@/components/ui/select";

export type GroupByDimension =
  | "none"
  | "campaign"
  | "domain"
  | "list"
  | "segment"
  | "country"
  | "mail-client"
  | "device";

interface GroupByOption {
  value: GroupByDimension;
  label: string;
  hint: string;
  /** Set when the dimension cannot be charted; shown verbatim. */
  unavailable?: string;
}

const ENDPOINT_LIMIT =
  "the grouped time-series endpoint only breaks engagement down by campaign or recipient domain.";

export const GROUP_BY_OPTIONS: readonly GroupByOption[] = [
  { value: "none", label: "None", hint: "Aggregate view" },
  { value: "campaign", label: "Campaign", hint: "One series per campaign" },
  { value: "domain", label: "Domain", hint: "One series per recipient domain" },
  {
    value: "list",
    label: "List",
    hint: "Audience container",
    unavailable:
      "events carry no list attribution, so engagement can't be broken down by list.",
  },
  {
    value: "segment",
    label: "Segment",
    hint: "Saved filter",
    unavailable: ENDPOINT_LIMIT,
  },
  {
    value: "country",
    label: "Country",
    hint: "Opens by geography",
    unavailable: ENDPOINT_LIMIT,
  },
  {
    value: "mail-client",
    label: "Mail client",
    hint: "Gmail vs Outlook etc.",
    unavailable: ENDPOINT_LIMIT,
  },
  {
    value: "device",
    label: "Device",
    hint: "Mobile vs desktop",
    unavailable: ENDPOINT_LIMIT,
  },
];

export function groupByLabel(value: GroupByDimension): string {
  return GROUP_BY_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function isGroupByDimension(value: string): value is GroupByDimension {
  return GROUP_BY_OPTIONS.some((o) => o.value === value);
}

export function GroupByMenu({
  value,
  onChange,
  disabled = false,
}: {
  value: GroupByDimension;
  onChange: (next: GroupByDimension) => void;
  disabled?: boolean;
}) {
  const reasonsId = useId();
  // One line per distinct reason, naming every dimension it covers.
  const byReason = new Map<string, string[]>();
  for (const option of GROUP_BY_OPTIONS) {
    if (!option.unavailable) continue;
    byReason.set(option.unavailable, [
      ...(byReason.get(option.unavailable) ?? []),
      option.label,
    ]);
  }
  return (
    <div className="space-y-1.5">
      <Select
        aria-label="Group by"
        aria-describedby={reasonsId}
        className="w-48"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          const option = GROUP_BY_OPTIONS.find((o) => o.value === next);
          if (!isGroupByDimension(next) || !option || option.unavailable) {
            return;
          }
          onChange(next);
        }}
      >
        {GROUP_BY_OPTIONS.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={Boolean(option.unavailable)}
          >
            {option.value === "none" ? "Group by: none" : option.label}
            {option.unavailable ? " — unavailable" : ` — ${option.hint}`}
          </option>
        ))}
      </Select>
      <ul id={reasonsId} className="space-y-0.5 text-xs text-muted-foreground">
        {[...byReason].map(([reason, labels]) => (
          <li key={reason}>
            <span className="font-medium">{joinLabels(labels)}</span>{" "}
            {labels.length === 1 ? "is" : "are"} unavailable: {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
