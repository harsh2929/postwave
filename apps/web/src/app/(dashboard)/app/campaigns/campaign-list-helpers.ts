// SPDX-License-Identifier: AGPL-3.0-only

import {
  ALL_FOLDERS,
  filterCampaignsByFolder,
} from "@/lib/campaign-folders-api";
import type { Campaign, CampaignStatus } from "@/lib/campaigns-api";

export type CampaignStatusBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning";

export const DEFAULT_CAMPAIGN_BODY_HTML =
  '<p></p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>';

export function countCampaignStatuses(
  campaigns: readonly Pick<Campaign, "status">[],
): { drafts: number; scheduled: number; sent: number } {
  return campaigns.reduce(
    (stats, campaign) => {
      if (campaign.status === "draft") stats.drafts += 1;
      if (campaign.status === "scheduled") stats.scheduled += 1;
      if (campaign.status === "sent") stats.sent += 1;
      return stats;
    },
    { drafts: 0, scheduled: 0, sent: 0 },
  );
}

export function campaignStatusVariant(
  status: Campaign["status"],
): CampaignStatusBadgeVariant {
  if (status === "sent") return "success";
  if (status === "scheduled" || status === "sending") return "secondary";
  if (status === "paused") return "warning";
	if (status === "failed" || status === "cancelled") return "destructive";
  return "outline";
}

// Current local time formatted as `YYYY-MM-DDTHH:mm` for a datetime-local
// `min`. Built from local components (not toISOString, which is UTC) so the
// floor matches what the native picker shows the user in their own timezone.
export function localDateTimeMin(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

/**
 * Human-facing label for a campaign lifecycle status. Statuses are stored as
 * lowercase enums; the UI should never show the raw enum. (CAMP-048/049)
 */
export function campaignStatusLabel(status: CampaignStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Humanize an underscored enum ("plain_text" -> "Plain Text"). */
export function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Grammatical count phrase — "1 campaign" vs "12 campaigns". `count` is
 * pre-formatted for the digits so the caller controls thousands separators.
 * (CAMP-048)
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count.toLocaleString()} ${word}`;
}

/* ---- List filtering / sorting (client-side; the campaigns list endpoint
   only supports free-text search + pagination, so status/type filtering and
   column sort are applied over the fetched window). CAMP-012 / CAMP-035. --- */

export type CampaignStatusFilter = "all" | CampaignStatus;

export const CAMPAIGN_STATUS_FILTERS: readonly CampaignStatusFilter[] = [
  "all",
  "draft",
  "scheduled",
  "sending",
  "sent",
  "paused",
  "cancelled",
  "failed",
];

export type CampaignTypeFilter = "all" | NonNullable<Campaign["campaign_type"]>;

export const CAMPAIGN_TYPE_FILTERS: readonly CampaignTypeFilter[] = [
  "all",
  "regular",
  "plain_text",
  "ab_test",
  "rss",
  "automated",
  "transactional",
];

export type CampaignRateKey = "open_rate" | "click_rate";
export type CampaignSortKey =
  | "name"
  | "status"
  | "subject"
  | "updated_at"
  | CampaignRateKey;
export type SortOrder = "asc" | "desc";

export const CAMPAIGN_SORT_KEYS: readonly CampaignSortKey[] = [
  "name",
  "status",
  "subject",
  "updated_at",
  "open_rate",
  "click_rate",
];

/**
 * A list row's open or click rate as the 0..1 fraction the list endpoint sends
 * (apps/api campaigns/repo.go attachListRates), or null when the server sent
 * none — which it does for every campaign with no delivered/sent denominator,
 * so "no rate yet" and "0%" stay distinguishable. The shared `Campaign` type
 * predates these fields, so they are read defensively rather than widened.
 */
export function campaignRate(
  campaign: Campaign,
  key: CampaignRateKey,
): number | null {
  const value = (campaign as Campaign & Partial<Record<CampaignRateKey, unknown>>)[
    key
  ];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Next sort state when a column header is clicked: toggle order on the active
 * column, else switch column and start descending. Pure — unit-tested.
 */
export function nextCampaignSort(
  current: { sort: CampaignSortKey; order: SortOrder },
  clicked: CampaignSortKey,
): { sort: CampaignSortKey; order: SortOrder } {
  if (current.sort === clicked) {
    return { sort: clicked, order: current.order === "asc" ? "desc" : "asc" };
  }
  return { sort: clicked, order: "desc" };
}

function compareCampaigns(
  a: Campaign,
  b: Campaign,
  sort: CampaignSortKey,
): number {
  if (sort === "updated_at") {
    return (
      new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );
  }
  if (sort === "open_rate" || sort === "click_rate") {
    // Only reached for two rows that BOTH carry a rate; rows without one are
    // placed after the rated rows before this comparator runs.
    return (campaignRate(a, sort) ?? 0) - (campaignRate(b, sort) ?? 0);
  }
  const av = String(a[sort] ?? "").toLowerCase();
  const bv = String(b[sort] ?? "").toLowerCase();
  return av.localeCompare(bv);
}

/**
 * Sort by open or click rate. A campaign with no rate yet (a draft, or a send
 * with no delivered/sent denominator) goes LAST in both directions: ranking
 * "not measured" as 0% would put every draft at the top of an ascending sort
 * and bury the campaign that actually performed worst.
 */
function sortByCampaignRate(
  campaigns: readonly Campaign[],
  key: CampaignRateKey,
  order: SortOrder,
): Campaign[] {
  const rated = campaigns.filter((c) => campaignRate(c, key) !== null);
  const unrated = campaigns.filter((c) => campaignRate(c, key) === null);
  const sorted = [...rated].sort((a, b) => compareCampaigns(a, b, key));
  if (order === "desc") sorted.reverse();
  return [...sorted, ...unrated];
}

/**
 * Apply status/type filters and a column sort to a fetched campaign window.
 * Pure and stable (the sort is applied to a copy). CAMP-012 / CAMP-035.
 */
export function filterAndSortCampaigns(
  campaigns: readonly Campaign[],
  opts: {
    query?: string;
    status: CampaignStatusFilter;
    type: CampaignTypeFilter;
    sort: CampaignSortKey;
    order: SortOrder;
    /** `ALL_FOLDERS` (default), `UNCATEGORISED_FOLDER`, or a folder id. */
    folder?: string;
  },
): Campaign[] {
  const query = opts.query?.trim().toLowerCase() ?? "";
  const inFolder = filterCampaignsByFolder(
    campaigns,
    opts.folder ?? ALL_FOLDERS,
  );
  const filtered = inFolder.filter((campaign) => {
    if (
      query &&
      !campaign.name.toLowerCase().includes(query) &&
      !campaign.subject.toLowerCase().includes(query)
    ) {
      return false;
    }
    if (opts.status !== "all" && campaign.status !== opts.status) return false;
    if (
      opts.type !== "all" &&
      (campaign.campaign_type ?? "regular") !== opts.type
    ) {
      return false;
    }
    return true;
  });
  if (opts.sort === "open_rate" || opts.sort === "click_rate") {
    return sortByCampaignRate(filtered, opts.sort, opts.order);
  }
  const sorted = [...filtered].sort((a, b) => compareCampaigns(a, b, opts.sort));
  if (opts.order === "desc") sorted.reverse();
  return sorted;
}

/** IANA timezone label for the current browser (e.g. "America/New_York"),
 *  or a soft fallback. Client-only. CAMP-018. */
export function localTimezoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "your local time";
  } catch {
    return "your local time";
  }
}

/** Human-readable absolute echo of a datetime-local value (e.g.
 *  "Friday, May 1, 2026 at 9:30 AM"), "" when unparseable. Client-only. CAMP-018. */
export function resolvedSendTime(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "short",
  });
}

/** Map a simple recurrence choice to a cron expression the `/recurrence`
 *  endpoint accepts (defaulting to 9am send). CAMP-010. */
export function recurrenceToCron(
  option: "daily" | "weekly" | "monthly",
): string {
  switch (option) {
    case "daily":
      return "0 9 * * *";
    case "weekly":
      return "0 9 * * 1";
    case "monthly":
      return "0 9 1 * *";
  }
}
