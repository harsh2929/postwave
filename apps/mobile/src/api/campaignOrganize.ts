/**
 * api/campaignOrganize.ts — folders, org-tags and the side-by-side compare.
 *
 * Every route below was read off the chi mounts and the handlers themselves,
 * NOT off openapi.json or the routeauth manifest:
 *
 *   GET   /api/v1/campaigns/folders          read:campaigns
 *                                            → { items: Folder[] }
 *                                            (campaigns/folders.go:70, :83-96)
 *   PATCH /api/v1/campaigns/{id}/folder      write:campaigns
 *                                            body { folder_id } — "" means
 *                                            uncategorised (folders.go:78, :53-56)
 *   POST  /api/v1/campaigns/org-tags/bulk    write:campaigns
 *                                            body { campaign_ids[], tag }
 *                                            → { ok, tag, tagged }
 *                                            (campaigns/org_tags.go:51, :153)
 *   GET   /api/v1/analytics/campaigns/compare?ids=a,b   read:reports
 *                                            → CompareRow[]
 *                                            (analytics/handlers.go:66, :353)
 *
 * THE SCOPES ARE ROLE GATES ON THE SESSION PATH. `apikeys.RequireScope` with
 * `read:campaigns` / `read:reports` is in the read-only scope set, so every
 * authenticated user passes; `write:campaigns` resolves through
 * `sessionRoleAllowsScopes` and admits owner/admin/editor. That is why the
 * screen gates the write verbs on `canAccessMinimumRole("editor", …)` rather
 * than discovering the boundary as a 403 after a destructive confirm.
 *
 * TWO WIRE FACTS THE UI HAS TO RESPECT
 *   1. `bulkOrgTag` runs its inserts in ONE transaction and returns
 *      `tagged` = rows actually inserted. Re-tagging campaigns that already
 *      carry the tag is `ON CONFLICT DO NOTHING`, so `tagged` can legitimately
 *      be lower than the number sent — that is "already tagged", not a
 *      failure, and the toast says so.
 *   2. `Compare` returns a ZERO-FILLED row for an id with no events
 *      (service.go:627 `CompareRow{CampaignID: id}`) rather than omitting it.
 *      `total_recipients === 0` therefore means NO DATA, not a 0% open rate,
 *      and lib/campaignCompare turns that into em-dashes.
 *
 * Parsing lives in lib/campaignCompare + lib/campaignFolders so it stays
 * unit-testable in the node vitest environment; this module is URLs and
 * envelopes only.
 */
import {
  parseCampaignFolder,
  parseCampaignFolders,
  type CampaignFolder,
} from "@/lib/campaignFolders";
import { parseCompareRows, type CampaignCompareRow } from "@/lib/campaignCompare";

import { checkedApiResult, rawRequest } from "./request";

/** GET /api/v1/campaigns/folders */
export async function listCampaignFolders(): Promise<CampaignFolder[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", "/api/v1/campaigns/folders"),
  );
  return parseCampaignFolders(res.data);
}

/**
 * POST /api/v1/campaigns/folders — write:campaigns (editor floor), mounted at
 * campaigns/folders.go:73. The body is `{name}` (trimmed server-side, 422 when
 * empty) and the answer is the bare Folder row, 201.
 *
 * The insert is `ON CONFLICT (tenant_id, name) DO UPDATE … RETURNING id`
 * (folders.go:249-253), so creating a name that already exists REUSES that
 * folder rather than erroring — the caller gets the existing id back and the
 * move that follows files into it. That is also why this stays ONLINE-ONLY and
 * press-driven rather than queued through the offline outbox: the returned id
 * is consumed immediately by the folder move, and a create replayed hours
 * later would have nothing left to file.
 */
export async function createCampaignFolder(
  name: string,
): Promise<CampaignFolder> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", "/api/v1/campaigns/folders", { name }),
  );
  const folder = parseCampaignFolder(res.data);
  if (!folder) {
    // A 201 whose body cannot be read is a create the UI cannot act on: there
    // is no id to move the selection into. Surfaced as a failure rather than
    // silently succeeding at half the operation.
    throw new Error(
      "The folder may have been created, but the server's answer couldn't be read. Pull to refresh the folder list.",
    );
  }
  return folder;
}

/**
 * PATCH /api/v1/campaigns/{id}/folder
 *
 * `folderId: null` files the campaign back under "uncategorised" — the server
 * treats the empty string that way (MoveFolderInput, folders.go:53-56).
 */
export async function moveCampaignToFolder(
  campaignId: string,
  folderId: string | null,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "PATCH",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/folder`,
      { folder_id: folderId ?? "" },
    ),
  );
}

export interface BulkTagResult {
  tag: string;
  /** Rows actually inserted; lower than the request when some already had it. */
  tagged: number;
}

/** POST /api/v1/campaigns/org-tags/bulk */
export async function bulkTagCampaigns(
  campaignIds: readonly string[],
  tag: string,
): Promise<BulkTagResult> {
  const res = await checkedApiResult(
    rawRequest<{ tag?: unknown; tagged?: unknown }>(
      "POST",
      "/api/v1/campaigns/org-tags/bulk",
      { campaign_ids: [...campaignIds], tag },
    ),
  );
  const body = res.data;
  return {
    tag: typeof body?.tag === "string" ? body.tag : tag,
    tagged: typeof body?.tagged === "number" ? body.tagged : 0,
  };
}

/** GET /api/v1/analytics/campaigns/compare?ids=… */
export async function compareCampaigns(
  ids: readonly string[],
): Promise<CampaignCompareRow[]> {
  const query = ids.map((id) => encodeURIComponent(id)).join(",");
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "GET",
      `/api/v1/analytics/campaigns/compare?ids=${query}`,
    ),
  );
  return parseCompareRows(res.data);
}
