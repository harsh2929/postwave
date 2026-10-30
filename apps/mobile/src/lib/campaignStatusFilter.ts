/**
 * lib/campaignStatusFilter.ts — the campaign list's status buckets.
 *
 * The previous bucketing filed failed and cancelled campaigns under a chip
 * labelled "Sent" (its arm was `s !== "draft" && s !== "scheduled"`, chosen so
 * nothing could be stranded behind "All"). The consequence: the most urgent
 * campaign state on a phone — a send that FAILED — was the one the UI
 * camouflaged as success.
 *
 * The buckets here stay TOTAL: every backend status lands in exactly one
 * non-"all" bucket, which `campaignStatusFilter.test.ts` asserts against the
 * documented status list so a new backend state can never be stranded.
 */
import { CAMPAIGN_STATUSES } from "@/lib/campaignFormat";

export type CampaignStatusFilter =
  | "all"
  | "draft"
  | "scheduled"
  | "sent"
  | "attention";

export interface CampaignStatusFilterSpec {
  key: CampaignStatusFilter;
  label: string;
  /** Chip tone when the bucket is non-empty. */
  tone?: "danger";
}

export const CAMPAIGN_STATUS_FILTERS: readonly CampaignStatusFilterSpec[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "scheduled", label: "Scheduled" },
  { key: "sent", label: "Sent" },
  { key: "attention", label: "Needs attention", tone: "danger" },
];

function normalize(status: string | null | undefined): string {
  const s = (status ?? "").trim().toLowerCase();
  return s.length > 0 ? s : "draft";
}

/** True when a campaign belongs to the given bucket. */
export function matchesCampaignStatus(
  status: string | null | undefined,
  filter: CampaignStatusFilter,
): boolean {
  if (filter === "all") return true;
  const s = normalize(status);
  switch (filter) {
    case "draft":
      return s === "draft";
    case "scheduled":
      return s === "scheduled";
    case "attention":
      return s === "failed" || s === "cancelled" || s === "paused";
    case "sent":
      // Everything that isn't a draft, isn't merely scheduled, and isn't
      // in the needs-attention bucket. Written as an explicit negation so
      // an unrecognised future status still lands here rather than nowhere.
      return !(
        s === "draft" ||
        s === "scheduled" ||
        s === "failed" ||
        s === "cancelled" ||
        s === "paused"
      );
    default:
      return false;
  }
}

/** The non-"all" buckets, in chip order. */
export const CAMPAIGN_STATUS_BUCKETS: readonly Exclude<
  CampaignStatusFilter,
  "all"
>[] = ["draft", "scheduled", "sent", "attention"];

export type CampaignStatusCounts = Record<CampaignStatusFilter, number>;

/**
 * Project the server's `{total, by_status}` (GET /api/v1/campaigns/count)
 * onto the same buckets the chips use, so the chip number is the WORKSPACE
 * number rather than a count of the pages fetched so far.
 */
export function bucketCounts(
  byStatus: Readonly<Record<string, number>> | null | undefined,
  total: number | null | undefined,
): CampaignStatusCounts {
  const counts: CampaignStatusCounts = {
    all: 0,
    draft: 0,
    scheduled: 0,
    sent: 0,
    attention: 0,
  };
  let summed = 0;
  for (const [status, raw] of Object.entries(byStatus ?? {})) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    summed += n;
    for (const bucket of CAMPAIGN_STATUS_BUCKETS) {
      if (matchesCampaignStatus(status, bucket)) {
        counts[bucket] += n;
        break;
      }
    }
  }
  const declared = Number(total);
  counts.all = Number.isFinite(declared) && declared > 0 ? declared : summed;
  return counts;
}

/** Bucket counts derived from a locally-loaded page window. */
export function bucketCountsFromRows(
  rows: readonly { status?: string | undefined }[],
): CampaignStatusCounts {
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    const key = normalize(row.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  return bucketCounts(byStatus, rows.length);
}

/**
 * True when the server counts prove a bucket is genuinely empty, which lets
 * the list skip draining every remaining page looking for a match.
 */
export function bucketIsProvenEmpty(
  counts: CampaignStatusCounts | null | undefined,
  filter: CampaignStatusFilter,
): boolean {
  if (!counts) return false;
  if (filter === "all") return false;
  return counts[filter] === 0;
}

/** Exported for the partition test; not used by views. */
export const ALL_KNOWN_CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;
