// SPDX-License-Identifier: AGPL-3.0-only
//
// Author model for the blog (MKTN-018). Frontmatter still stores `author` as a
// bare string for backward compatibility; this module derives a richer view
// (role, bio, initials avatar, listing slug) from that string.
//
// We do NOT fabricate real people's bios. Known authors get honest, curated
// role/bio text; anything else falls back to a generic, truthful description
// derived from the author string itself.

import { listBlogPosts, type BlogPostSummary } from "@/lib/blog";

export interface BlogAuthor {
  /** Display name exactly as authored in frontmatter. */
  name: string;
  /** URL segment for `/blog/author/[author]`. */
  slug: string;
  /** Short role line under the name. */
  role: string;
  /** One- or two-sentence bio. Honest/generic unless curated. */
  bio: string;
  /** 1–2 letters for the initials-in-a-circle avatar (no external images). */
  initials: string;
}

/**
 * Curated entries for authors we can describe accurately. Keyed by the
 * lowercased, trimmed author string. Keep this honest — only add entries whose
 * role/bio we can stand behind.
 */
const KNOWN_AUTHORS: Record<string, { role: string; bio: string }> = {
  "the moosewave team": {
    role: "Engineering & Product",
    bio: "The people building Moosewave — engineering, product, and infrastructure — writing up what we ship and why.",
  },
};

/** Slugify an author name into a URL-safe segment. */
export function authorSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Route-param guard for `/blog/author/[author]`. */
export function isValidAuthorSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

/**
 * Derive up to two uppercase initials from an author name for the avatar.
 * Uses the first letters of the first two words; single-word names use the
 * first two letters. Always returns at least one character.
 */
export function authorInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return "?";
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Resolve a frontmatter author string into a full author record. Curated
 * authors get their real role/bio; everything else gets an honest generic
 * description rather than an invented biography.
 */
export function getAuthor(name: string): BlogAuthor {
  const trimmed = name.trim();
  const known = KNOWN_AUTHORS[trimmed.toLowerCase()];
  return {
    name: trimmed,
    slug: authorSlug(trimmed),
    initials: authorInitials(trimmed),
    role: known?.role ?? "Contributor",
    bio: known?.bio ?? `${trimmed} writes for the Moosewave blog.`,
  };
}

/** Published posts (newest first) whose author slug matches `slug`. */
export async function getPostsByAuthor(
  slug: string,
): Promise<BlogPostSummary[]> {
  const posts = await listBlogPosts();
  return posts.filter((p) => authorSlug(p.author) === slug);
}

export interface BlogAuthorSummary extends BlogAuthor {
  /** Number of published posts by this author. */
  count: number;
}

/** Every distinct author across published posts, with a post count. */
export async function listBlogAuthors(): Promise<BlogAuthorSummary[]> {
  const posts = await listBlogPosts();
  const bySlug = new Map<string, { name: string; count: number }>();
  for (const post of posts) {
    const slug = authorSlug(post.author);
    if (!slug) continue;
    const existing = bySlug.get(slug);
    if (existing) existing.count += 1;
    else bySlug.set(slug, { name: post.author, count: 1 });
  }
  return [...bySlug.values()]
    .map(({ name, count }) => ({ ...getAuthor(name), count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
