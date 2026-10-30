/**
 * lib/assetOrganize.ts — the pure half of asset organising: folder-name and
 * tag normalisation mirrors, plus the single-row parses the write endpoints
 * answer with.
 *
 * A sibling of lib/assetLibrary rather than an extension of it (that module is
 * at its source budget), and import-free beyond its types so everything here
 * runs in the node vitest environment.
 *
 * WHY THE NORMALISERS EXIST CLIENT-SIDE AT ALL: the server rewrites what it
 * stores (`normalizeFolderName`, folders.go:62; `normalizeTag`, tags.go:56),
 * and a field that lets someone type "Q3 Launch!" and then shows "q3 launch-"
 * on seven assets is a surprise the tag sheet on campaigns already refuses to
 * spring (CampaignBulkSheets.normalizeOrgTag). These are previews of the
 * server's behaviour, not a second policy — each mirrors its Go source
 * line-for-line and is pinned to it by tests.
 */

import type { AssetFolder } from "@/lib/assetLibrary";
import { isAssetRowVersion } from "@/lib/assetVersionGate";

/** `maxFolderNameLen` (assets/folders.go:56). */
export const ASSET_FOLDER_NAME_MAX = 128;

/** `maxTagLen` (assets/tags.go:50). */
export const ASSET_TAG_MAX = 64;

/**
 * Mirror of `normalizeFolderName` (folders.go:62): trim, reject anything over
 * 128 runes (the handler 400s it before the repo ever runs), and collapse
 * internal whitespace runs. Returns "" for a name the server would refuse or
 * erase.
 */
export function normalizeAssetFolderName(raw: string): string {
  const trimmed = raw.trim();
  if ([...trimmed].length > ASSET_FOLDER_NAME_MAX) return "";
  return trimmed.split(/\s+/u).filter(Boolean).join(" ");
}

/**
 * Mirror of `normalizeTag` (tags.go:56): lowercase + trim; reject over 64
 * runes; keep Unicode letters, numbers and combining marks plus `-`, `_` and
 * space; every other character becomes a dash; whitespace runs collapse; and
 * leading/trailing dashes and spaces are stripped. "" means the server would
 * refuse it (`validTagInput`).
 */
export function normalizeAssetTag(raw: string): string {
  const t = raw.trim().toLowerCase();
  if ([...t].length > ASSET_TAG_MAX) return "";
  let mapped = "";
  for (const ch of t) {
    mapped += /[\p{L}\p{N}\p{M}\-_ ]/u.test(ch) ? ch : "-";
  }
  const collapsed = mapped.split(/\s+/u).filter(Boolean).join(" ");
  return collapsed.replace(/^[- ]+|[- ]+$/gu, "");
}

/**
 * One folder off the wire — the bare `Folder` body `POST /assets/folders`
 * (201) and `PATCH /assets/folders/{id}` (200) answer with. Same
 * drop-if-unidentifiable rule as the list parse in lib/assetLibrary.
 */
export function parseAssetFolder(raw: unknown): AssetFolder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!id || !name) return null;
  const createdAt = row.createdAt;
  const count = row.assetCount;
  // The folder's OWN optimistic-concurrency version — the number a later
  // rename or delete of this folder must send. Omitted, never nulled, when the
  // body did not carry one: absence is what makes the sheet withhold those two
  // verbs (see AssetFolder.version).
  const version = row.version;
  return {
    id,
    name,
    createdAt:
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt
        : null,
    assetCount:
      typeof count === "number" && Number.isFinite(count) && count >= 0
        ? count
        : 0,
    ...(isAssetRowVersion(version) ? { version } : {}),
  };
}

/**
 * `{"tags": ["a", "b"]}` — what `GET /assets/{id}/tags` and
 * `POST /assets/{id}/tags` both answer with (tags.go GetTags/AddTags).
 * Non-string rows are dropped, not stringified.
 */
export function parseAssetTagList(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const rows = (raw as Record<string, unknown>).tags;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (tag): tag is string => typeof tag === "string" && tag.trim() !== "",
  );
}

/**
 * Would creating `name` collide with an existing folder? The server's unique
 * index is exact-string per tenant and answers 409 `name_conflict` — unlike
 * campaign folders there is no create-or-reuse — so the field says it before
 * the tap instead of relaying the refusal after it.
 */
export function assetFolderNameTaken(
  folders: readonly AssetFolder[],
  name: string,
): boolean {
  const normalized = normalizeAssetFolderName(name);
  return normalized !== "" && folders.some((f) => f.name === normalized);
}

/** The folder row behind an asset's folderId, or null (Uncategorised). */
export function assetFolderById(
  folders: readonly AssetFolder[],
  folderId: string | null,
): AssetFolder | null {
  if (!folderId) return null;
  return folders.find((f) => f.id === folderId) ?? null;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code.trim();
  }
  return "";
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 0;
}

/**
 * One sentence for a refused organising write. The codes are the handlers'
 * own (folders.go / tags.go); a 403 must read as the permission rule it is,
 * never as a generic failure.
 */
export function assetOrganizeErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const code = errorCode(error);
  if (code === "name_conflict") {
    return "A folder with that name already exists.";
  }
  if (code === "missing_name" || code === "invalid_name") {
    return "Folder names must be 1 to 128 characters.";
  }
  if (code === "invalid_tag") {
    return "Tags must be 1 to 64 characters.";
  }
  if (code === "folder_not_found") {
    return "That folder no longer exists — pull to refresh the list.";
  }
  const status = errorStatus(error);
  if (status === 401) return "Your session expired. Sign in and try again.";
  if (status === 403) {
    return "Organising the library needs an editor role on this workspace.";
  }
  if (status === 404) {
    return "That no longer exists in this workspace — pull to refresh.";
  }
  if (status >= 500) return "The server couldn't apply that change. Try again.";
  const raw = error instanceof Error ? error.message.trim() : "";
  return raw || fallback;
}
