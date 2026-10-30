/**
 * api/queuedWriteConflict.ts — the one read the offline conflict sheet makes.
 *
 * Desktop's ConflictModal fetches the record's current copy through its
 * canonical request layer (apps/desktop/src/components/ConflictModal.tsx,
 * `apiRequest(item.path, { method: "GET", cache: "no-store" })`) so "your
 * version" can sit beside "server version". This is the mobile twin: the
 * path is the queued write's own path, already vetted by
 * lib/offlineConflict.serverCopyPath against the routes the manifest mounts.
 *
 * No new server route. Every path this can be handed is a viewer-level
 * `GET /api/v1/<entity>/{id}` that mobile already reads elsewhere.
 */
import { rawRequest, type AIApiResult } from "./request";

export async function fetchServerCopy(
  path: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("GET", path);
}
