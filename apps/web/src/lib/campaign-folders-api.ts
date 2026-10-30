// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/campaign-folders-api.ts — campaign folders and organization tags.
 *
 * Two small server surfaces the campaigns list uses to group campaigns:
 *
 *  - Folders (apps/api/internal/campaigns/folders.go). A flat, per-workspace
 *    list; a campaign lives in zero or one folder, and "uncategorised" is just
 *    `folder_id IS NULL`. Create is idempotent ON THE NAME: posting a name that
 *    already exists returns the existing folder rather than a second one.
 *  - Organization tags (apps/api/internal/campaigns/org_tags.go). Free-text
 *    labels for grouping, distinct from the SUBSCRIBER tags a campaign targets.
 *    The server trims, lowercases and caps a tag at 40 bytes; the bulk route
 *    takes 1..500 campaign ids in ONE transaction and reports how many rows it
 *    inserted — a campaign that already carries the tag is not counted.
 *
 * Kept apart from campaigns-api.ts: nothing here needs that module's ETag
 * ledger or mock fallbacks. Every write refuses the offline queue, because the
 * list screen reports the server's answer per campaign and a queued write has
 * no answer to report.
 */
import { api } from "@/lib/api";
import type { Campaign } from "@/lib/campaigns-api";
import { base, type RoleKey } from "@/lib/query-keys";

/** Folder filter value for "every campaign, filed or not". */
export const ALL_FOLDERS = "";
/** Folder filter value for campaigns filed in no folder. */
export const UNCATEGORISED_FOLDER = "__uncategorised";

/** Server cap (org_tags.go `orgTagMaxLen`), measured in UTF-8 bytes. */
export const CAMPAIGN_ORG_TAG_MAX_BYTES = 40;
/** Server cap on one bulk-tag request (org_tags.go `bulkOrgTag`). */
export const CAMPAIGN_BULK_TAG_MAX_IDS = 500;

export interface CampaignFolder {
  id: string;
  name: string;
  /** Campaigns currently filed in this folder (server-computed). */
  campaign_count: number;
  created_at?: string;
  updated_at?: string;
}

export interface CampaignBulkTagResult {
  /** The tag as the server stored it (normalized). */
  tag: string;
  /** Rows the server inserted; campaigns already tagged are not counted. */
  tagged: number;
}

/**
 * Folders sit under the `campaigns` resource on purpose: moving a campaign
 * changes both the list rows and the folder counts, and the one
 * `invalidateQueries({ queryKey: base("campaigns", …) })` the list page
 * already issues after a write refreshes both.
 */
export const campaignFolderKeys = {
  list: (tenantId: string, role: RoleKey) =>
    [...base("campaigns", tenantId, role), "folders"] as const,
};

function toFolder(row: unknown): CampaignFolder | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name : "";
  // A folder with no id cannot be filtered on or moved into; one with no name
  // would render as a blank option. Neither is a usable row.
  if (id === "" || name.trim() === "") return null;
  const count = record.campaign_count;
  return {
    id,
    name,
    campaign_count:
      typeof count === "number" && Number.isFinite(count) && count >= 0
        ? Math.floor(count)
        : 0,
    ...(typeof record.created_at === "string"
      ? { created_at: record.created_at }
      : {}),
    ...(typeof record.updated_at === "string"
      ? { updated_at: record.updated_at }
      : {}),
  };
}

/** GET /api/v1/campaigns/folders — `{items: Folder[]}`, ordered by name. */
export async function listCampaignFolders(): Promise<CampaignFolder[]> {
  const res = await api.get<{ items?: unknown }>("/api/v1/campaigns/folders");
  const rows = Array.isArray(res?.items) ? res.items : [];
  return rows
    .map(toFolder)
    .filter((folder): folder is CampaignFolder => folder !== null);
}

/** POST /api/v1/campaigns/folders — returns the created (or existing) folder. */
export async function createCampaignFolder(
  name: string,
): Promise<CampaignFolder> {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("Name the folder before creating it.");
  }
  const res = await api.post<unknown>(
    "/api/v1/campaigns/folders",
    { name: trimmed },
    { requireOnline: true },
  );
  const folder = toFolder(res);
  if (!folder) {
    throw new Error(
      "The server accepted the folder but did not return it. Refresh the folder list to confirm it exists.",
    );
  }
  return folder;
}

/**
 * PATCH /api/v1/campaigns/{id}/folder — file a campaign into a folder, or
 * back into "uncategorised" with an empty folder id.
 */
export async function moveCampaignToFolder(
  campaignId: string,
  folderId: string,
): Promise<{ folder_id: string }> {
  const target = folderId.trim();
  const res = await api.patch<{ ok?: unknown; folder_id?: unknown }>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/folder`,
    { folder_id: target },
    { requireOnline: true },
  );
  return {
    folder_id: typeof res?.folder_id === "string" ? res.folder_id : target,
  };
}

/** The tag exactly as the server will store it: trimmed and lowercased. */
export function normalizeCampaignOrgTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Why a tag cannot be sent, or null when it can. The server silently
 * TRUNCATES an over-long tag (and does so by byte, so it can split a
 * character); refusing here is the only way the operator learns it before a
 * different tag than the one they typed lands on every selected campaign.
 */
export function campaignOrgTagProblem(raw: string): string | null {
  const tag = normalizeCampaignOrgTag(raw);
  if (tag === "") return "Enter a tag.";
  if (new TextEncoder().encode(tag).length > CAMPAIGN_ORG_TAG_MAX_BYTES) {
    return `Keep the tag to ${CAMPAIGN_ORG_TAG_MAX_BYTES} characters or fewer — the server cuts longer tags short.`;
  }
  return null;
}

/** POST /api/v1/campaigns/org-tags/bulk — one tag onto many campaigns. */
export async function bulkTagCampaigns(
  campaignIds: readonly string[],
  rawTag: string,
): Promise<CampaignBulkTagResult> {
  const ids = Array.from(
    new Set(campaignIds.map((id) => id.trim()).filter((id) => id !== "")),
  );
  if (ids.length === 0) throw new Error("Select at least one campaign to tag.");
  if (ids.length > CAMPAIGN_BULK_TAG_MAX_IDS) {
    throw new Error(
      `Tag at most ${CAMPAIGN_BULK_TAG_MAX_IDS} campaigns at once — the server refuses larger batches.`,
    );
  }
  const problem = campaignOrgTagProblem(rawTag);
  if (problem) throw new Error(problem);
  const tag = normalizeCampaignOrgTag(rawTag);
  const res = await api.post<{ tag?: unknown; tagged?: unknown }>(
    "/api/v1/campaigns/org-tags/bulk",
    { campaign_ids: ids, tag },
    { requireOnline: true },
  );
  return {
    tag: typeof res?.tag === "string" && res.tag !== "" ? res.tag : tag,
    tagged:
      typeof res?.tagged === "number" && Number.isFinite(res.tagged)
        ? res.tagged
        : 0,
  };
}

/**
 * The folder a list row is filed in, or "" when uncategorised.
 *
 * The list endpoint sends `folder_id` (omitempty) on every row, but the shared
 * `Campaign` type predates folders, so it is read defensively here rather than
 * widened there.
 */
export function campaignFolderId(campaign: Campaign): string {
  const value = (campaign as Campaign & { folder_id?: unknown }).folder_id;
  return typeof value === "string" ? value.trim() : "";
}

/** Apply a folder filter (`ALL_FOLDERS`, `UNCATEGORISED_FOLDER`, or an id). */
export function filterCampaignsByFolder<T extends Campaign>(
  campaigns: readonly T[],
  folder: string,
): T[] {
  if (folder === ALL_FOLDERS) return [...campaigns];
  if (folder === UNCATEGORISED_FOLDER) {
    return campaigns.filter((campaign) => campaignFolderId(campaign) === "");
  }
  return campaigns.filter((campaign) => campaignFolderId(campaign) === folder);
}
