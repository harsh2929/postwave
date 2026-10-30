/**
 * ApprovalHistoryControls — the queue's window chips (Pending/All), plus the
 * status slice and sort order that give the phone desktop's history controls
 * (ApprovalsWorkspace status/sort selects), as chip rows.
 *
 * The status row renders only on the All window — Pending IS a status filter,
 * and two stacked status controls could contradict each other. Switching back
 * to Pending resets a status sort exactly as desktop does: ordering an
 * all-pending window by status is meaningless. The pure slicing/ordering
 * lives in approvalHistoryView.ts.
 *
 * Every change animates via `animateLayout`, which carries the Reduce Motion
 * decision with it — swapping the whole queue in one frame reads as a glitch,
 * not as a filter.
 */
import { View } from "react-native";

import { Chip } from "@/components/Chip";
import { useMotion } from "@/lib/motion";

import type { FilterKey } from "./approvalPresentation";
import {
  APPROVAL_SORTS,
  APPROVAL_STATUS_FILTERS,
  type ApprovalSortKey,
  type ApprovalStatusFilter,
} from "./approvalHistoryView";

export interface ApprovalHistoryControlsProps {
  filter: FilterKey;
  onFilterChange: (next: FilterKey) => void;
  status: ApprovalStatusFilter;
  onStatusChange: (next: ApprovalStatusFilter) => void;
  sort: ApprovalSortKey;
  onSortChange: (next: ApprovalSortKey) => void;
}

export function ApprovalHistoryControls({
  filter,
  onFilterChange,
  status,
  onStatusChange,
  sort,
  onSortChange,
}: ApprovalHistoryControlsProps) {
  const { animateLayout } = useMotion();
  const pendingOnly = filter === "pending";
  return (
    <View style={{ gap: 6, marginTop: 10 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip
          label="Pending"
          active={pendingOnly}
          onPress={() => {
            animateLayout("enter");
            onFilterChange("pending");
            // Desktop resets a status sort when leaving history: ordering
            // an all-pending window by status is meaningless.
            if (sort === "status") onSortChange("newest");
          }}
        />
        <Chip
          label="All"
          active={filter === "all"}
          onPress={() => {
            animateLayout("enter");
            onFilterChange("all");
          }}
        />
      </View>
      {pendingOnly ? null : (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {APPROVAL_STATUS_FILTERS.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              active={status === option.key}
              accessibilityLabel={
                option.key === "all"
                  ? "Show every loaded approval regardless of outcome"
                  : `Show only ${option.label.toLowerCase()} approvals`
              }
              onPress={() => {
                animateLayout("enter");
                onStatusChange(option.key);
              }}
            />
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {APPROVAL_SORTS.filter(
          (option) => !(option.historyOnly && pendingOnly),
        ).map((option) => (
          <Chip
            key={option.key}
            label={sort === option.key ? `Sort: ${option.label}` : option.label}
            active={sort === option.key}
            accessibilityLabel={`Sort the queue by ${option.label.toLowerCase()}`}
            onPress={() => {
              animateLayout("enter");
              onSortChange(option.key);
            }}
          />
        ))}
      </View>
    </View>
  );
}
