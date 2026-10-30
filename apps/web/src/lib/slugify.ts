// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Slugify a free-form name into a URL-safe slug.
 *
 * Lives in its own module so routes that only need the slug helper (landing
 * pages) do not pull the whole forms schema module into their eager chunk.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
