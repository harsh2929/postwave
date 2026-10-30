/**
 * api/archiveComments.ts — transport for archive-comment moderation.
 *
 * Every route below was read off the chi mount in
 * `apps/api/internal/archive_comments/archive_comments.go::MountAdminRoutes`
 * (:189-195), mounted in `apps/api/main.go:2924-2927` as
 *
 *     .MountAdminRoutes(r.With(apikeys.RequireScope(apikeys.ScopeAdmin)))
 *
 *   GET    /api/v1/archive/comments?status=&campaignId=&limit=  → {items,total}
 *   POST   /api/v1/archive/comments/{id}/moderate  {status}     → {ok:true}
 *   POST   /api/v1/archive/comments/{id}/pin                    → {ok,pinned}
 *   POST   /api/v1/archive/comments/{id}/unpin                  → {ok,pinned}
 *   DELETE /api/v1/archive/comments/{id}                        → {ok:true}
 *
 * AUTHORIZATION — ONE GATE, NOT TWO. Unlike reviews (read:reports to read,
 * admin to act), the WHOLE surface is behind `ScopeAdmin`. On the
 * session-cookie path `apikeys.RequireScope` maps that to owner|admin, because
 * `ScopeAdmin` is absent from `readOnlyScopes`
 * (apps/api/internal/apikeys/middleware.go:332-337) so
 * `requireAdminRoleForScopes` is true and `sessionRoleAllowsScopes` admits only
 * owner/admin (plus a custom role explicitly granted the scope). So a viewer
 * cannot even LIST here — the screen says that instead of rendering an empty
 * queue over a 403.
 *
 * None of these routes appears in openapi.json, so none exists on the
 * generated SDK surface; they go through `client.request` like the rest of the
 * archive admin surface does.
 *
 * Parsing lives in lib/archiveCommentQueue so it is unit-testable in the node
 * vitest environment; this module is only URLs and envelopes.
 */
import {
  ARCHIVE_COMMENT_LIST_CAP,
  parseArchiveCommentPage,
  type ArchiveCommentFilter,
  type ArchiveCommentPage,
  type ArchiveCommentStatus,
} from "@/lib/archiveCommentQueue";

import { checkedApiResult, rawRequest } from "./request";

export function archiveCommentsPath(filter: ArchiveCommentFilter): string {
  // `limit` is clamped server-side: anything <= 0 or > 200 silently becomes
  // 50, so 200 is the largest value that means what it says.
  return `/api/v1/archive/comments?status=${encodeURIComponent(filter)}&limit=${ARCHIVE_COMMENT_LIST_CAP}`;
}

function commentPath(id: string): string {
  return `/api/v1/archive/comments/${encodeURIComponent(id)}`;
}

export async function fetchArchiveComments(
  filter: ArchiveCommentFilter,
): Promise<ArchiveCommentPage> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", archiveCommentsPath(filter)),
  );
  return parseArchiveCommentPage(res.data);
}

/**
 * Flip a comment's moderation status. The handler 400s on anything outside
 * {visible, pending, hidden, spam}, which is why the caller may only pass an
 * `ArchiveCommentStatus`.
 */
export async function moderateArchiveComment(
  id: string,
  status: ArchiveCommentStatus,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("POST", `${commentPath(id)}/moderate`, { status }),
  );
}

export async function setArchiveCommentPinned(
  id: string,
  pinned: boolean,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "POST",
      `${commentPath(id)}/${pinned ? "pin" : "unpin"}`,
    ),
  );
}

/**
 * HARD delete. `Repo.Delete` runs a plain `DELETE FROM archive_comments` and
 * the FK cascade removes the votes AND every reply beneath it — the Go comment
 * names hiding as the way to keep the thread. The confirm copy in
 * lib/archiveCommentQueue says so before this is ever called.
 */
export async function deleteArchiveComment(id: string): Promise<void> {
  await checkedApiResult(rawRequest<unknown>("DELETE", commentPath(id)));
}
