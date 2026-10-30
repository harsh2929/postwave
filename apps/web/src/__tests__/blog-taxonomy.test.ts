// SPDX-License-Identifier: AGPL-3.0-only
//
// Covers the blog taxonomy + pagination + author helpers that back the tag,
// author, and paginated-index routes (MKTN-011 / MKTN-018).

import { describe, expect, it } from "vitest";

import {
  BLOG_PAGE_SIZE,
  getPostsByTag,
  isValidBlogTag,
  listBlogPosts,
  listBlogTags,
  paginatePosts,
  parsePageParam,
  tagToSlug,
  type BlogPostSummary,
} from "@/lib/blog";
import {
  authorInitials,
  authorSlug,
  getAuthor,
  getPostsByAuthor,
  isValidAuthorSlug,
  listBlogAuthors,
} from "@/lib/blog-authors";

function fakePosts(n: number): BlogPostSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `post-${i}`,
    title: `Post ${i}`,
    description: "d",
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    author: "The Moosewave team",
    tags: [],
    readingTime: "1 min read",
  }));
}

describe("tagToSlug", () => {
  it("normalizes spaces, case, and punctuation", () => {
    expect(tagToSlug("Voice AI")).toBe("voice-ai");
    expect(tagToSlug("GDPR")).toBe("gdpr");
    expect(tagToSlug("  Multi -- Word  ")).toBe("multi-word");
    expect(tagToSlug("already-slug")).toBe("already-slug");
  });
});

describe("isValidBlogTag", () => {
  it("accepts slug-shaped tags and rejects path-like input", () => {
    expect(isValidBlogTag("mailchimp")).toBe(true);
    expect(isValidBlogTag("voice-ai")).toBe(true);
    expect(isValidBlogTag("../secret")).toBe(false);
    expect(isValidBlogTag("Bad Tag")).toBe(false);
  });
});

describe("listBlogTags / getPostsByTag", () => {
  it("aggregates real content tags with counts", async () => {
    const tags = await listBlogTags();
    const slugs = tags.map((t) => t.slug);
    expect(slugs).toContain("mailchimp");
    expect(slugs).toContain("voice-ai");
    expect(slugs).toContain("gdpr");
    // "engineering" appears on more than one post.
    const engineering = tags.find((t) => t.slug === "engineering");
    expect(engineering?.count).toBeGreaterThanOrEqual(2);
    // Alphabetized by label.
    const labels = tags.map((t) => t.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
  });

  it("returns the matching post(s) for a tag", async () => {
    const posts = await getPostsByTag("mailchimp");
    expect(posts.length).toBeGreaterThan(0);
    expect(
      posts.every((p) => p.tags.map(tagToSlug).includes("mailchimp")),
    ).toBe(true);
    expect(await getPostsByTag("no-such-tag-xyz")).toEqual([]);
  });
});

describe("paginatePosts", () => {
  it("bounds the page and clamps out-of-range requests", () => {
    const posts = fakePosts(25);
    const first = paginatePosts(posts, 1, 10);
    expect(first.posts).toHaveLength(10);
    expect(first.totalPages).toBe(3);
    expect(first.total).toBe(25);

    const last = paginatePosts(posts, 3, 10);
    expect(last.posts).toHaveLength(5);
    expect(last.page).toBe(3);

    // Over/under-range clamps rather than throwing.
    expect(paginatePosts(posts, 99, 10).page).toBe(3);
    expect(paginatePosts(posts, 0, 10).page).toBe(1);
    expect(paginatePosts(posts, Number.NaN, 10).page).toBe(1);
  });

  it("always reports at least one page for an empty list", () => {
    expect(paginatePosts([], 1).totalPages).toBe(1);
  });

  it("defaults to the exported page size", () => {
    const posts = fakePosts(BLOG_PAGE_SIZE + 1);
    expect(paginatePosts(posts, 1).posts).toHaveLength(BLOG_PAGE_SIZE);
  });
});

describe("parsePageParam", () => {
  it("parses positive integers and defaults to 1", () => {
    expect(parsePageParam("2")).toBe(2);
    expect(parsePageParam(["3", "4"])).toBe(3);
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("-5")).toBe(1);
  });
});

describe("author model", () => {
  it("slugifies and derives initials", () => {
    expect(authorSlug("The Moosewave team")).toBe("the-moosewave-team");
    expect(authorInitials("The Moosewave team")).toBe("TM");
    expect(authorInitials("Ada")).toBe("AD");
    expect(isValidAuthorSlug("the-moosewave-team")).toBe(true);
    expect(isValidAuthorSlug("../x")).toBe(false);
  });

  it("returns curated role/bio for known authors and generic for others", () => {
    const known = getAuthor("The Moosewave team");
    expect(known.role).toBe("Engineering & Product");
    expect(known.bio).toMatch(/building Moosewave/i);

    const generic = getAuthor("Jane Doe");
    expect(generic.role).toBe("Contributor");
    // Honest generic bio — no fabricated biography.
    expect(generic.bio).toBe("Jane Doe writes for the Moosewave blog.");
  });

  it("lists authors and resolves their posts from real content", async () => {
    const authors = await listBlogAuthors();
    expect(authors.length).toBeGreaterThan(0);
    const team = authors.find((a) => a.slug === "the-moosewave-team");
    expect(team).toBeDefined();

    const all = await listBlogPosts();
    const byTeam = await getPostsByAuthor("the-moosewave-team");
    expect(byTeam.length).toBe(
      all.filter((p) => authorSlug(p.author) === "the-moosewave-team").length,
    );
  });
});
