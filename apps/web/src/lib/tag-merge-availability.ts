// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tag-merge release policy.
 *
 * Keep this synchronized with:
 *   - apps/desktop/src/pages/tags/tagPageModel.ts (TAG_MERGE_UNAVAILABLE_REASON)
 *   - apps/api/internal/tag_taxonomy/tag_taxonomy.go (Merge → 409
 *     unsafe_mutation_disabled)
 *
 * POST /api/v1/tag-taxonomy/merge is mounted, but the server validates the
 * envelope and then refuses every merge until it can plan and commit the
 * membership projection atomically with an idempotent receipt. Desktop keeps
 * its Merge control permanently disabled with the reason below; web mirrors
 * that here so the control and the transport read the same policy.
 */
export const TAG_MERGE_AVAILABLE: boolean = false;

export const TAG_MERGE_UNAVAILABLE_REASON =
  "Merge is paused until the server can plan and commit every membership projection atomically with an idempotent receipt.";

export class TagMergeUnavailableError extends Error {
  readonly code = "tag_merge_unavailable";
  readonly status = 409;
  readonly retryable = false;

  constructor() {
    super(TAG_MERGE_UNAVAILABLE_REASON);
    this.name = "TagMergeUnavailableError";
  }
}

/** Throws before any request leaves the client while merge is held. */
export function requireTagMergeAvailable(): void {
  if (!TAG_MERGE_AVAILABLE) throw new TagMergeUnavailableError();
}
