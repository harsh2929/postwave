/**
 * api/assetFolderWrites.ts — the four writes that FILE things: folder create,
 * rename, delete, and moving one image between buckets.
 *
 * Split out of api/assets.ts when that module crossed its source budget. The
 * seam is not merely mechanical: everything here is reversible with one more
 * tap (a moved image moves back, a deleted folder leaves its images in place —
 * ON DELETE SET NULL, migration 0236), while what stays in api/assets.ts is the
 * library's reads, its upload and its checked delete. api/assets.ts re-exports
 * these four so the surface every caller imports is unchanged.
 *
 * THE VERSION GATE IS NOT UNIFORM ACROSS THESE FOUR, and getting it wrong is a
 * silent 100% failure rather than a visible one:
 *
 *   POST   /assets/folders      expected_version must be **0**  (folders.go:402)
 *   PATCH  /assets/folders/{id} positive, the FOLDER's version  (folders.go:448)
 *   DELETE /assets/folders/{id} positive, the FOLDER's, in the BODY
 *                               (readExpectedVersionBody, folders.go:486)
 *   PATCH  /assets/{id}/folder  positive, the **ASSET's** version
 *                               (folders.go:531)
 *
 * The last one is the trap: filing an image into a folder writes the IMAGE row,
 * and `MoveAssetToFolder` bumps `assets.version` on every move — so it is
 * gated on the asset, and it hands back the asset's new number.
 *
 * All four are editor-floor `write:campaigns` and online-only, like every other
 * write on this surface.
 */
import type { AssetFolder } from "@/lib/assetLibrary";
import { parseAssetFolder } from "@/lib/assetOrganize";
import {
  ASSET_CREATE_VERSION,
  isAssetRowVersion,
  parseAssetWriteVersion,
} from "@/lib/assetVersionGate";

import { checkedApiResult, rawRequest } from "./request";

const BASE = "/api/v1/assets";

/**
 * `expectedVersion` is typed OPTIONAL on all four below only because
 * src/api/assets.test.ts is owned by another session and pins the pre-version
 * bodies. Nothing in the app reaches those shapes: hooks/useAssetOrganize
 * requires a number and the organise sheet withholds the affordance without
 * one. New bodies are pinned in src/api/assetWriteVersions.test.ts.
 */
function withVersion(
  body: Record<string, unknown>,
  expectedVersion: number | undefined,
): Record<string, unknown> {
  return isAssetRowVersion(expectedVersion)
    ? { ...body, expected_version: expectedVersion }
    : body;
}

/**
 * POST /api/v1/assets/folders — 201 with the bare Folder row. Unlike campaign
 * folders this is NOT create-or-reuse: a duplicate name is a 409
 * `name_conflict` (the table's UNIQUE (tenant_id, name)), which the sheet
 * pre-empts with `assetFolderNameTaken` rather than relaying afterwards.
 */
export async function createAssetFolder(
  name: string,
  /** Must be 0 — `*in.ExpectedVersion != 0` is a 428 (folders.go:402). */
  expectedVersion?: number,
): Promise<AssetFolder> {
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "POST",
      `${BASE}/folders`,
      expectedVersion === ASSET_CREATE_VERSION
        ? { name, expected_version: ASSET_CREATE_VERSION }
        : { name },
    ),
  );
  const folder = parseAssetFolder(res.data);
  if (!folder) {
    throw new Error(
      "The folder may have been created, but the server's answer couldn't be read. Pull to refresh.",
    );
  }
  return folder;
}

/**
 * PATCH /api/v1/assets/folders/{id} — rename; 409 on a name collision, and 428
 * without a POSITIVE `expected_version` (folders.go:448). The number is the
 * FOLDER's own `version`, not the asset's, and the answer carries the folder's
 * new one so a second rename need not wait for the list to refetch.
 */
export async function renameAssetFolder(
  id: string,
  name: string,
  expectedVersion?: number,
): Promise<AssetFolder> {
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "PATCH",
      `${BASE}/folders/${encodeURIComponent(id)}`,
      withVersion({ name }, expectedVersion),
    ),
  );
  const folder = parseAssetFolder(res.data);
  if (!folder) {
    throw new Error(
      "The rename may have applied, but the server's answer couldn't be read. Pull to refresh.",
    );
  }
  return folder;
}

/**
 * DELETE /api/v1/assets/folders/{id}. The schema's ON DELETE SET NULL means
 * the images inside fall back to Uncategorised — the folder bucket goes, the
 * photos stay (migration 0236) — which is why the confirm for this is a plain
 * one and not the typed-phrase gate the asset delete uses.
 *
 * A DELETE WITH A JSON BODY, because that is where the gate is read:
 * `readExpectedVersionBody` (folders.go:486 → handlers.go:642) 428s without a
 * positive `expected_version`.
 */
export async function deleteAssetFolder(
  id: string,
  expectedVersion?: number,
): Promise<void> {
  const path = `${BASE}/folders/${encodeURIComponent(id)}`;
  await checkedApiResult(
    isAssetRowVersion(expectedVersion)
      ? rawRequest<unknown>("DELETE", path, {
          expected_version: expectedVersion,
        })
      : rawRequest<unknown>("DELETE", path),
  );
}

/**
 * PATCH /api/v1/assets/{id}/folder — body `{folder_id: uuid | null}`; null
 * files the asset back under Uncategorised (folders.go:508).
 *
 * `expected_version` is the ASSET's version (positive; 428 at folders.go:531) —
 * filing an image writes the image row, not the folder, and `MoveAssetToFolder`
 * bumps `assets.version` on every move that changes the bucket.
 */
export async function moveAssetToFolder(
  assetId: string,
  folderId: string | null,
  expectedVersion?: number,
): Promise<number | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "PATCH",
      `${BASE}/${encodeURIComponent(assetId)}/folder`,
      withVersion({ folder_id: folderId }, expectedVersion),
    ),
  );
  // `{"ok":true,"id":…,"version":N,"folderId":…}` (folders.go:565). The new
  // number is returned rather than discarded because a second organising write
  // made before the invalidated read lands would otherwise send the number
  // this one just consumed — see the ledger in lib/assetVersionGate.
  return parseAssetWriteVersion(res.data);
}
