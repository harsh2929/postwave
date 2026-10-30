import { useMemo } from "react";

import type { StatCell } from "../../components/StatStrip";
import type { Campaign } from "../../lib/api-client";
import {
  CAMPAIGN_PAGE_SIZE,
  type CampaignFilter,
  type CampaignSortKey,
  campaignRowId,
  formatCampaignPercent,
} from "./campaigns-page-utils";
import type { CampaignsState } from "./useCampaignsState";

export interface CampaignStats {
  avgClick: number | null;
  avgOpen: number | null;
  sentThisMonth: number;
  total: number;
}

export interface CampaignFilterOptions {
  filter: CampaignFilter;
  folderFilter: string;
  query: string;
}

export function filterCampaignRows(
  rows: Campaign[] | null,
  options: CampaignFilterOptions,
): Campaign[] {
  if (!rows) return [];
  let filtered = rows;
  if (options.filter !== "all") {
    filtered = filtered.filter((campaign) => {
      const status = (campaign.status ?? "draft").toLowerCase();
      if (options.filter === "sent")
        return status === "sent" || status === "running";
      return status === options.filter;
    });
  }
  if (options.folderFilter) {
    filtered =
      options.folderFilter === "__uncategorised"
        ? filtered.filter((campaign) => !campaign.folder_id)
        : filtered.filter(
            (campaign) => campaign.folder_id === options.folderFilter,
          );
  }
  const query = options.query.trim().toLowerCase();
  if (query) {
    filtered = filtered.filter(
      (campaign) =>
        (campaign.name ?? "").toLowerCase().includes(query) ||
        (campaign.subject ?? "").toLowerCase().includes(query),
    );
  }
  return filtered;
}

function campaignSortValue(
  campaign: Campaign,
  sortBy: CampaignSortKey,
): string | number {
  switch (sortBy) {
    case "name":
      return (campaign.name ?? campaign.subject ?? "").toLowerCase();
    case "status":
      return (campaign.status ?? "").toLowerCase();
    case "sent":
      return Date.parse(campaign.sent_at ?? campaign.created_at ?? "") || 0;
    case "open":
      return campaign.open_rate ?? -1;
    case "click":
      return campaign.click_rate ?? -1;
  }
}

export function sortCampaignRows(
  rows: Campaign[],
  sortBy: CampaignSortKey | null,
  sortDir: "asc" | "desc",
): Campaign[] {
  if (!sortBy) return rows;
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = campaignSortValue(left, sortBy);
    const rightValue = campaignSortValue(right, sortBy);
    if (leftValue < rightValue) return -direction;
    if (leftValue > rightValue) return direction;
    return 0;
  });
}

export function calculateCampaignStats(
  rows: Campaign[] | null,
  now = new Date(),
): CampaignStats {
  const list = rows ?? [];
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let sentThisMonth = 0;
  let openSum = 0;
  let openCount = 0;
  let clickSum = 0;
  let clickCount = 0;
  for (const campaign of list) {
    const status = (campaign.status ?? "").toLowerCase();
    const sentAt = campaign.sent_at ?? campaign.created_at;
    if ((status === "sent" || status === "running") && sentAt) {
      const timestamp = new Date(sentAt).getTime();
      if (!Number.isNaN(timestamp) && timestamp >= monthStart)
        sentThisMonth += 1;
    }
    if (typeof campaign.open_rate === "number") {
      openSum += campaign.open_rate;
      openCount += 1;
    }
    if (typeof campaign.click_rate === "number") {
      clickSum += campaign.click_rate;
      clickCount += 1;
    }
  }
  return {
    total: list.length,
    sentThisMonth,
    avgOpen: openCount > 0 ? openSum / openCount : null,
    avgClick: clickCount > 0 ? clickSum / clickCount : null,
  };
}

export function buildCampaignStatCells(
  stats: CampaignStats,
  loading: boolean,
  hasRowsState: boolean,
): StatCell[] {
  const placeholder = loading && !hasRowsState;
  return [
    {
      label: "Total campaigns",
      value: placeholder ? "—" : stats.total.toLocaleString(),
      hint: "All campaigns in the complete verified workspace snapshot.",
    },
    {
      label: "Sent this month",
      value: placeholder ? "—" : stats.sentThisMonth.toLocaleString(),
      hint: "Campaigns that finished sending since the 1st of this month.",
    },
    {
      label: "Avg open rate",
      value: placeholder
        ? "—"
        : formatCampaignPercent(stats.avgOpen ?? undefined),
      hint: "Mean open rate across campaigns with measured rates in the complete verified snapshot.",
    },
    {
      label: "Avg click rate",
      value: placeholder
        ? "—"
        : formatCampaignPercent(stats.avgClick ?? undefined),
      hint: "Mean click rate across campaigns with measured rates in the complete verified snapshot.",
    },
  ];
}

export function useCampaignsViewModel(state: CampaignsState) {
  const filtered = useMemo(
    () =>
      filterCampaignRows(state.rows, {
        filter: state.filter,
        folderFilter: state.folderFilter,
        query: state.query,
      }),
    [state.filter, state.folderFilter, state.query, state.rows],
  );
  const sorted = useMemo(
    () => sortCampaignRows(filtered, state.sortBy, state.sortDir),
    [filtered, state.sortBy, state.sortDir],
  );
  const stats = useMemo(() => calculateCampaignStats(state.rows), [state.rows]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / CAMPAIGN_PAGE_SIZE));
  const pageRows = sorted.slice(
    (state.page - 1) * CAMPAIGN_PAGE_SIZE,
    state.page * CAMPAIGN_PAGE_SIZE,
  );
  const allPageSelected =
    pageRows.length > 0 &&
    pageRows.every((campaign) =>
      state.selectedIds.has(campaignRowId(campaign)),
    );
  return {
    allPageSelected,
    filtered,
    pageRows,
    sorted,
    statCells: buildCampaignStatCells(
      stats,
      state.loading,
      state.rows !== null,
    ),
    stats,
    totalPages,
  };
}

export type CampaignsViewModel = ReturnType<typeof useCampaignsViewModel>;
