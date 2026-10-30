// SPDX-License-Identifier: AGPL-3.0-only
//
// Topic slug helpers (SETA-019): derive a kebab-case slug from a display name,
// validate the format client-side, and detect duplicates against the loaded
// topic list — so users get immediate feedback instead of a round-trip server
// error. Pure + dependency-free for node unit tests. The server remains
// authoritative on uniqueness.

/** Kebab-case a free-text name: lowercase, strip accents, non-alnum → `-`. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** A valid slug is non-empty kebab-case: lowercase alnum groups joined by `-`. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * True when `slug` already exists among `existing`, ignoring a topic with
 * `ignoreId` (so editing a topic doesn't flag its own slug). Comparison is
 * trimmed + case-insensitive.
 */
export function isDuplicateSlug(
  slug: string,
  existing: readonly { id: string; slug: string }[],
  ignoreId?: string,
): boolean {
  const target = slug.trim().toLowerCase();
  if (!target) return false;
  return existing.some(
    (t) => t.id !== ignoreId && t.slug.trim().toLowerCase() === target,
  );
}
