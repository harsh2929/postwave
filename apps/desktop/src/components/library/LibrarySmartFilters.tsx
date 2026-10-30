/**
 * LibrarySmartFilters — chip row with backend-computed counts.
 *
 *   All (47) · Recently used (12) · Reported uses (8) · No reported use (5) · Large (3)
 *
 * Active chip uses --pw-accent; counts are tabular-nums for visual
 * stability as the user types in the search box and totals shift.
 */

import { type ReactElement } from "react";

import {
  type AssetCounts,
  type AssetFilter,
} from "../../lib/api-client";
import { ChoiceGroup } from "../ChoiceGroup";

interface Props {
  active: AssetFilter;
  counts: AssetCounts | undefined;
  onChange: (filter: AssetFilter) => void;
}

const CHIPS: {
  value: AssetFilter;
  label: string;
  key: keyof AssetCounts;
  hint?: string;
}[] = [
  { value: "all", label: "All", key: "all" },
  {
    value: "recent",
    label: "Recently used",
    key: "recent",
    hint: "Uploaded or referenced by a current campaign, template, or form in the last 30 days.",
  },
  {
    value: "in-use",
    label: "Reported uses",
    key: "inUse",
    hint: "A current campaign, tenant template, or draft/published form reference was reported.",
  },
  {
    value: "unused",
    label: "No reported use",
    key: "unused",
    hint: "No current campaign, template, or form reference was reported. Verify before deleting because usage can change.",
  },
  {
    value: "large",
    label: "Large",
    key: "large",
    hint: "Over 1 MB. Worth checking — large hero images slow inbox previews.",
  },
];

export function LibrarySmartFilters({
  active,
  counts,
  onChange,
}: Props): ReactElement {
  const options = CHIPS.map((chip) => {
    const count = counts ? counts[chip.key] : undefined;
    return {
      value: chip.value,
      className: active === chip.value ? "is-active" : undefined,
      description: active === chip.value ? chip.hint : undefined,
      label: (
        <>
          <span>{chip.label}</span>
          {typeof count === "number" ? (
            <span
              className="lib-count"
              aria-label={`${count.toLocaleString()} assets`}
            >
              ({count.toLocaleString()})
            </span>
          ) : null}
        </>
      ),
    };
  });
  return (
    <ChoiceGroup
      legend="Smart filters"
      value={active}
      options={options}
      onChange={onChange}
      className="lib-filter-chips"
      optionClassName="lib-filter-chip"
    />
  );
}
