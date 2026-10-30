/**
 * lib/campaignFolders.ts — parsing and filtering for campaign folders.
 *
 * A workspace that files 400 campaigns into folders on desktop
 * (apps/desktop/src/pages/campaigns/CampaignsTopPanels.tsx:123) saw one flat
 * list on a phone. The server has had folders since migration 0227:
 * `campaign_folders` per tenant, `campaigns.folder_id` nullable, and
 * `folder_id` is projected onto every list row (`campaignColumns`,
 * apps/api/internal/campaigns/repo.go:762), so the phone already receives the
 * grouping — it just never used it.
 *
 * THE ONE CONSTRAINT THAT SHAPES THE UI. `GET /api/v1/campaigns` accepts
 * `query`, `page`, `per_page`, `limit` and `source_template_id` and NOTHING
 * ELSE (handlers.go:237-275) — there is no server-side folder filter. So a
 * folder filter on a phone can only narrow the rows already fetched, exactly
 * like the sort axis above it, and it must SAY SO when pages remain. Claiming
 * "Newsletters (3)" while 800 rows are still on the server would be worse
 * than not filtering at all.
 *
 * Pure and import-free so it is testable in the node vitest environment.
 */

export interface CampaignFolder {
  id: string;
  name: string;
  /** Denormalised by the server so a chip can show a count (folders.go:41). */
  campaignCount: number;
}

/** Sentinel for the "no folder" bucket — `folder_id IS NULL` server-side. */
export const UNCATEGORISED_FOLDER = "__uncategorised__";

/** The filter value: a folder id, the uncategorised sentinel, or "all". */
export type CampaignFolderFilter = string;

export const ALL_FOLDERS = "all";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `{ items: Folder[] }` → the mobile shape. Rows without an id or a name are
 * dropped rather than rendered as a blank chip nobody can identify.
 */
export function parseCampaignFolders(raw: unknown): CampaignFolder[] {
  const items =
    raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items ?? [])
      : Array.isArray(raw)
        ? raw
        : [];
  const out: CampaignFolder[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = str(row.id).trim();
    const name = str(row.name).trim();
    if (!id || !name) continue;
    const count = row.campaign_count;
    out.push({
      id,
      name,
      campaignCount:
        typeof count === "number" && Number.isFinite(count) && count > 0
          ? Math.floor(count)
          : 0,
    });
  }
  return out;
}

/**
 * One folder off the wire — the bare `Folder` body `POST /campaigns/folders`
 * answers with (201, folders.go:120). Same drop-if-unidentifiable rule as the
 * list parse: a create that comes back without an id is a create the UI cannot
 * file anything into, and pretending otherwise would move campaigns nowhere.
 */
export function parseCampaignFolder(raw: unknown): CampaignFolder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id).trim();
  const name = str(row.name).trim();
  if (!id || !name) return null;
  const count = row.campaign_count;
  return {
    id,
    name,
    campaignCount:
      typeof count === "number" && Number.isFinite(count) && count > 0
        ? Math.floor(count)
        : 0,
  };
}

/**
 * Mirror of the server's only normalisation for a campaign-folder name:
 * `strings.TrimSpace`, then reject empty (folders.go:109-113). No case-fold,
 * no length clamp — previewing anything stricter would promise a rename the
 * server never performs.
 */
export function normalizeCampaignFolderName(raw: string): string {
  return raw.trim();
}

/**
 * What creating `name` would actually do, given the folders already listed.
 *
 * The insert is `ON CONFLICT (tenant_id, name) DO UPDATE` (folders.go:251) —
 * an EXACT-string conflict. So "newsletters" again reuses the existing folder
 * ("exact"), while "Newsletters" mints a second, differently-cased folder
 * ("case") — the quiet taxonomy split the create field must warn about
 * instead of performing silently.
 */
export function campaignFolderNameConflict(
  folders: readonly CampaignFolder[],
  name: string,
): "exact" | "case" | null {
  const trimmed = normalizeCampaignFolderName(name);
  if (!trimmed) return null;
  if (folders.some((f) => f.name === trimmed)) return "exact";
  const lower = trimmed.toLowerCase();
  if (folders.some((f) => f.name.toLowerCase() === lower)) return "case";
  return null;
}

export interface FolderedCampaign {
  folder_id?: string | undefined;
}

/**
 * Does a row belong in the selected folder bucket?
 *
 * The server projects `COALESCE(folder_id::text, '')`, so "uncategorised" is
 * the EMPTY STRING on the wire, not null — a `== null` test would put every
 * uncategorised campaign in no bucket at all.
 */
export function matchesCampaignFolder(
  campaign: FolderedCampaign,
  filter: CampaignFolderFilter,
): boolean {
  if (filter === ALL_FOLDERS) return true;
  const folderId = (campaign.folder_id ?? "").trim();
  if (filter === UNCATEGORISED_FOLDER) return folderId === "";
  return folderId === filter;
}

export interface FolderOption {
  value: CampaignFolderFilter;
  label: string;
  accessibilityLabel: string;
}

/**
 * The chip row. "All" first, then the workspace's folders in server order,
 * then Uncategorised last — the bucket you file OUT of belongs at the end.
 *
 * `active` is passed so a filter the operator is currently standing in never
 * disappears because a refetch dropped the folder; a control that vanishes
 * mid-use strands them with no way back to "All".
 */
export function campaignFolderOptions(
  folders: readonly CampaignFolder[],
  active: CampaignFolderFilter,
): FolderOption[] {
  const options: FolderOption[] = [
    {
      value: ALL_FOLDERS,
      label: "All folders",
      accessibilityLabel: "Show campaigns in every folder",
    },
  ];
  for (const folder of folders) {
    options.push({
      value: folder.id,
      label:
        folder.campaignCount > 0
          ? `${folder.name} ${folder.campaignCount}`
          : folder.name,
      accessibilityLabel:
        folder.campaignCount > 0
          ? `Show only the ${folder.name} folder, ${folder.campaignCount} campaign${folder.campaignCount === 1 ? "" : "s"}`
          : `Show only the ${folder.name} folder`,
    });
  }
  options.push({
    value: UNCATEGORISED_FOLDER,
    label: "Uncategorised",
    accessibilityLabel: "Show only campaigns that are not in a folder",
  });
  if (!options.some((o) => o.value === active)) {
    options.push({
      value: active,
      label: "Selected folder",
      accessibilityLabel:
        "The folder currently filtered to, which is no longer in the workspace list",
    });
  }
  return options;
}

/**
 * The sentence under the chips when the filter can only see part of the list.
 *
 * Returns null when there is nothing to qualify — a caveat that is always on
 * screen stops being read.
 */
export function campaignFolderCaveat(
  filter: CampaignFolderFilter,
  hasMorePages: boolean,
  loadedCount: number,
): string | null {
  if (filter === ALL_FOLDERS) return null;
  if (!hasMorePages) return null;
  return `Folders are matched against the ${loadedCount} campaigns loaded so far — the list has more pages, and this workspace's API filters folders only on the client. Scroll to load more, or filter on the web app.`;
}

/** The folder a campaign is currently in, or null for uncategorised. */
export function currentFolderId(campaign: FolderedCampaign): string | null {
  const id = (campaign.folder_id ?? "").trim();
  return id === "" ? null : id;
}
