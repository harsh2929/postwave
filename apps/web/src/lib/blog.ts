// SPDX-License-Identifier: AGPL-3.0-only
//
// Filesystem-backed blog index. Reads MDX frontmatter from
// `apps/web/content/blog/*.mdx` at build time so server components can list
// and resolve posts without a runtime DB round-trip.
//
// Posts are MDX. Frontmatter is parsed by gray-matter; the body string is
// passed to <MDXRemote /> on the post page. We do NOT pre-compile MDX here —
// that happens at render time inside the RSC tree (which is fine for the
// post counts we expect; we'll revisit if the index grows past a few dozen).

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import matter from "gray-matter";
import { cache } from "react";

const CONTENT_DIR = join(process.cwd(), "content", "blog");
const BLOG_MDX_MAX_BYTES = 512 * 1024;
const BLOG_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Same shape as a slug — tag URL segments are slugified before matching. */
const BLOG_TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** How many posts render per page on the index before pagination kicks in. */
export const BLOG_PAGE_SIZE = 10;

export interface BlogFrontmatter {
  title: string;
  description: string;
  date: string;
  author: string;
  tags: string[];
  readingTime: string;
}

export interface BlogPostSummary extends BlogFrontmatter {
  slug: string;
}

export interface BlogPost extends BlogPostSummary {
  /** Raw MDX body, frontmatter stripped. Pass straight to <MDXRemote source={…}/>. */
  content: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function isValidBlogSlug(slug: string): boolean {
  return BLOG_SLUG_RE.test(slug);
}

async function readBlogMdx(slug: string): Promise<string> {
  if (!isValidBlogSlug(slug)) {
    throw new Error(`invalid blog slug "${slug}"`);
  }
  const filePath = join(CONTENT_DIR, `${slug}.mdx`);
  const info = await stat(filePath);
  if (info.size > BLOG_MDX_MAX_BYTES) {
    throw new Error(`blog post "${slug}" exceeds ${BLOG_MDX_MAX_BYTES} bytes`);
  }
  return readFile(filePath, "utf8");
}

function asFrontmatter(data: Record<string, unknown>): BlogFrontmatter {
  const {
    title,
    description,
    date,
    author,
    tags,
    readingTime,
  } = data;

  if (typeof title !== "string") {
    throw new Error("blog post missing string `title`");
  }
  if (typeof description !== "string") {
    throw new Error(`blog post "${title}" missing string \`description\``);
  }
  if (typeof date !== "string") {
    throw new Error(`blog post "${title}" missing string \`date\``);
  }
  if (typeof author !== "string") {
    throw new Error(`blog post "${title}" missing string \`author\``);
  }
  if (!isStringArray(tags)) {
    throw new Error(`blog post "${title}" missing string[] \`tags\``);
  }
  if (typeof readingTime !== "string") {
    throw new Error(`blog post "${title}" missing string \`readingTime\``);
  }

  return { title, description, date, author, tags, readingTime };
}

/**
 * Read every MDX file in the blog content dir and return summaries
 * (frontmatter + slug, no body). Sorted newest first.
 *
 * Wrapped in React `cache()` because several call sites fan out within one
 * render — /sitemap.xml alone reaches it through listBlogPosts(),
 * listBlogTags() and listBlogAuthors(), and the sitemap is force-dynamic, so
 * each crawler fetch would otherwise redo the readdir plus one readFile and
 * gray-matter parse per post, per call site. Deduped per request; a new
 * request still sees new content on disk.
 */
export const listBlogPosts = cache(async (): Promise<BlogPostSummary[]> => {
  const entries = await readdir(CONTENT_DIR, { withFileTypes: true });
  const slugs = entries
    .filter((e) => e.isFile() && e.name.endsWith(".mdx"))
    .map((e) => e.name.replace(/\.mdx$/, ""))
    .filter(isValidBlogSlug);

  const summaries = await Promise.all(
    slugs.map(async (slug) => {
      const raw = await readBlogMdx(slug);
      const parsed = matter(raw);
      const fm = asFrontmatter(parsed.data);
      const summary: BlogPostSummary = { slug, ...fm };
      return summary;
    }),
  );

  summaries.sort((a, b) => (a.date < b.date ? 1 : -1));
  return summaries;
});

/**
 * Read a single post by slug. Throws if the file isn't there — callers should
 * `notFound()` on a missing post rather than catching here.
 */
export async function getBlogPost(slug: string): Promise<BlogPost> {
  const raw = await readBlogMdx(slug);
  const parsed = matter(raw);
  const fm = asFrontmatter(parsed.data);
  return { slug, ...fm, content: parsed.content };
}

export interface AdjacentPosts {
  prev: BlogPostSummary | null;
  next: BlogPostSummary | null;
}

/**
 * Return the (newer, older) neighbors of a slug in the date-sorted list.
 * `prev` is the older post (the one you'd read after this one); `next` is
 * the newer post. Naming convention matches typical blog UI ("← Prev" goes
 * older, "Next →" goes newer) — adjust the labels in the renderer if you
 * disagree with the convention; the data here is unambiguous either way.
 */
export async function getAdjacentPosts(
  slug: string,
): Promise<AdjacentPosts> {
  const all = await listBlogPosts();
  const idx = all.findIndex((p) => p.slug === slug);
  if (idx === -1) return { prev: null, next: null };
  const next = idx > 0 ? all[idx - 1] : null;
  const prev = idx < all.length - 1 ? all[idx + 1] : null;
  return { prev: prev ?? null, next: next ?? null };
}

/**
 * Format a date string ("2026-04-22") for display ("April 22, 2026").
 * Centralized so every blog surface formats the same way.
 */
export function formatBlogDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ── Tags (MKTN-011) ─────────────────────────────────────────────────────────

/**
 * Slugify a frontmatter tag into a URL-safe segment. Today's tags are already
 * lowercase and dash-free-of-spaces ("voice-ai", "gdpr"), but this normalizes
 * anything a future post might write ("Voice AI" → "voice-ai") so the pill
 * link, the route param, and the sitemap entry never drift.
 */
export function tagToSlug(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Route-param guard for `/blog/tag/[tag]` — mirrors the slug guard. */
export function isValidBlogTag(tag: string): boolean {
  return BLOG_TAG_RE.test(tag);
}

export interface BlogTagSummary {
  /** URL segment. */
  slug: string;
  /** Human label as authored in frontmatter (first occurrence wins). */
  label: string;
  /** Number of published posts carrying the tag. */
  count: number;
}

/**
 * All distinct tags across published posts, alphabetized by label, each with a
 * post count. Two frontmatter spellings that slugify identically collapse to
 * one entry (the first spelling seen becomes the label).
 */
export async function listBlogTags(): Promise<BlogTagSummary[]> {
  const posts = await listBlogPosts();
  const bySlug = new Map<string, { label: string; count: number }>();
  for (const post of posts) {
    for (const tag of post.tags) {
      const slug = tagToSlug(tag);
      if (!slug) continue;
      const existing = bySlug.get(slug);
      if (existing) existing.count += 1;
      else bySlug.set(slug, { label: tag, count: 1 });
    }
  }
  return [...bySlug.entries()]
    .map(([slug, v]) => ({ slug, label: v.label, count: v.count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Published posts (newest first) carrying a tag whose slug matches `tagSlug`. */
export async function getPostsByTag(
  tagSlug: string,
): Promise<BlogPostSummary[]> {
  const posts = await listBlogPosts();
  return posts.filter((p) => p.tags.some((t) => tagToSlug(t) === tagSlug));
}

// ── Pagination (MKTN-011) ───────────────────────────────────────────────────

export interface PaginatedPosts {
  /** The slice of posts for the requested page. */
  posts: BlogPostSummary[];
  /** 1-based page number after clamping into range. */
  page: number;
  /** Total number of pages (>= 1, even when there are no posts). */
  totalPages: number;
  /** Total post count across all pages. */
  total: number;
}

/**
 * Slice a post list into a bounded page. `page` is 1-based; out-of-range or
 * non-numeric input is clamped into `[1, totalPages]`. Keeps the index bounded
 * as the archive grows instead of rendering the whole list forever.
 */
export function paginatePosts(
  posts: BlogPostSummary[],
  page: number,
  pageSize: number = BLOG_PAGE_SIZE,
): PaginatedPosts {
  const size = pageSize > 0 ? Math.floor(pageSize) : BLOG_PAGE_SIZE;
  const total = posts.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const requested = Number.isFinite(page) ? Math.floor(page) : 1;
  const clamped = Math.min(Math.max(1, requested), totalPages);
  const start = (clamped - 1) * size;
  return {
    posts: posts.slice(start, start + size),
    page: clamped,
    totalPages,
    total,
  };
}

/** Parse a `?page=` search param into a positive integer, defaulting to 1. */
export function parsePageParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
