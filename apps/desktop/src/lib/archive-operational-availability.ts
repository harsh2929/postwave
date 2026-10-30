/**
 * Archive activation boundaries.
 *
 * The issue-management surface is useful in authenticated, read-only mode,
 * but public delivery and the adjacent community/feed controls still have
 * unresolved cross-service security and routing dependencies. Keeping these
 * compile-time fail-closed makes the renderer truthful in every environment;
 * release qualification must deliberately flip each boundary after its
 * backend, infrastructure, privacy, and browser evidence is complete.
 */
export const ARCHIVE_PUBLIC_DELIVERY_AVAILABLE = false;
export const ARCHIVE_COMMENTS_AVAILABLE = false;
export const ARCHIVE_PRIVATE_PODCAST_AVAILABLE = false;

export const ARCHIVE_PUBLIC_DELIVERY_UNAVAILABLE_REASON =
  "New publication, catalog edits, pinning, public copy, open, RSS, and sitemap actions are review-gated while the archive web route and delivery host are converged. Admin safety-unpublishing remains available.";

export const ARCHIVE_COMMENTS_UNAVAILABLE_REASON =
  "Reader comments are review-gated while tenant binding, abuse controls, privacy projections, pagination, and moderation history are completed.";

export const ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON =
  "Private feeds are review-gated while one-time secret storage, tenant-scoped resolution, entitlement, media access, and revocation are release-qualified.";
