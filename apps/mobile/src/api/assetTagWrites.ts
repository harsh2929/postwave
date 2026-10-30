/**
 * api/assetTagWrites.ts — the two per-asset TAG writes, in the shape the
 * organise sheet actually needs: the tag list AND the asset's new version.
 *
 * WHY THIS IS NOT IN api/assets.ts. `addAssetTag` there resolves to a bare
 * `string[]`, and that resolved shape is pinned by a test another session owns
 * (src/api/assets.test.ts:159). The version cannot be carried by an array, so
 * the versioned call lives here and `addAssetTag` is now a thin wrapper over
 * it — one request, one parse, no second code path to drift.
 *
 * WHY THE VERSION MATTERS ON THE WAY BACK, not just on the way out.
 * `AddTagsToAsset` bumps `assets.version` even though the tag itself lands in a
 * join table, and `RemoveTagFromAsset` does the same (tags.go). So adding two
 * tags in a row with the same number is a guaranteed 412 on the second — the
 * server answers each write with the row's NEW version (`{"tags":[…],
 * "version":N}`, tags.go:398; `{"ok":true,"id":…,"version":N}`, tags.go:429)
 * precisely so the next write can send it. The caller keeps it in the ledger in
 * lib/assetVersionGate.
 *
 * Both routes are editor-floor `write:campaigns` and online-only, like every
 * other write on this surface.
 */
import { parseAssetTagList } from "@/lib/assetOrganize";
import {
  isAssetRowVersion,
  parseAssetWriteVersion,
} from "@/lib/assetVersionGate";

import { checkedApiResult, rawRequest } from "./request";

/**
 * Not imported from ./assets: that module imports `addAssetTag` from HERE, and
 * a path constant is not worth an import cycle to share.
 */
function tagsPath(assetId: string): string {
  return `/api/v1/assets/${encodeURIComponent(assetId)}/tags`;
}

export interface AssetTagWriteResult {
  /** The asset's full tag list after the write (add), or [] (remove). */
  tags: string[];
  /** The row's NEW version, or null when the body did not carry one. */
  version: number | null;
}

/**
 * POST /api/v1/assets/{id}/tags — body `{tag, expected_version}`.
 *
 * `expected_version` must be a POSITIVE integer (428
 * `expected_version_required`, tags.go:364) and is the ASSET's version, not the
 * tag's. It is typed optional only so the pre-version call in api/assets.ts
 * keeps its pinned body; the app always threads a number read off the row.
 */
export async function addAssetTagVersioned(
  assetId: string,
  tag: string,
  expectedVersion?: number,
): Promise<AssetTagWriteResult> {
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "POST",
      tagsPath(assetId),
      isAssetRowVersion(expectedVersion)
        ? { tag, expected_version: expectedVersion }
        : { tag },
    ),
  );
  return {
    tags: parseAssetTagList(res.data),
    version: parseAssetWriteVersion(res.data),
  };
}

/**
 * DELETE /api/v1/assets/{id}/tags/{tag} — the tag is in the PATH and the
 * version is in the BODY (`readExpectedVersionBody`, tags.go:415 →
 * handlers.go:642), which is why this is a DELETE that carries one at all.
 */
export async function removeAssetTagVersioned(
  assetId: string,
  tag: string,
  expectedVersion?: number,
): Promise<number | null> {
  const path = `${tagsPath(assetId)}/${encodeURIComponent(tag)}`;
  const res = await checkedApiResult(
    isAssetRowVersion(expectedVersion)
      ? rawRequest<unknown>("DELETE", path, {
          expected_version: expectedVersion,
        })
      : rawRequest<unknown>("DELETE", path),
  );
  return parseAssetWriteVersion(res.data);
}
