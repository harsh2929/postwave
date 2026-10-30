// SPDX-License-Identifier: AGPL-3.0-only
//
// The blog generates four families of static pages — post, tag, author, and
// paginated index — and every one addresses by a slug derived from free text.
// `tagToSlug` and `authorSlug` both lowercase and collapse every non-alphanumeric
// run to a dash, which is lossy by design: "A/B testing" and "A B testing"
// produce the same slug, as do "Reply-To" and "reply to".
//
// That is exactly how /docs/api ended up rendering two sections with id="sms"
// — the spec carried "SMS" and "Sms" as distinct tags, both lowercased to the
// same thing, and one group became unreachable. Here the consequence is worse
// than unreachable: generateStaticParams would emit the slug twice, one page
// would win, and its listing would silently show only one of the two tags'
// posts while claiming to be both.
//
// Three posts and ten tags today, all clean. This is what keeps it that way as
// content is written by people who are not thinking about slug collisions.
import { describe, expect, it } from "vitest";

import {
  isValidBlogSlug,
  isValidBlogTag,
  listBlogPosts,
  listBlogTags,
  tagToSlug,
} from "@/lib/blog";
import { isValidAuthorSlug, listBlogAuthors } from "@/lib/blog-authors";

describe("blog slug integrity", () => {
  it("reads the content", async () => {
    // Guard the guard: an empty corpus makes every uniqueness check vacuous.
    const posts = await listBlogPosts();
    expect(posts.length).toBeGreaterThan(0);
    expect((await listBlogTags()).length).toBeGreaterThan(0);
    expect((await listBlogAuthors()).length).toBeGreaterThan(0);
  });

  it("gives every post a distinct, routable slug", async () => {
    const posts = await listBlogPosts();
    const bySlug = new Map<string, string[]>();
    for (const post of posts) {
      bySlug.set(post.slug, [...(bySlug.get(post.slug) ?? []), post.title]);
    }
    const collisions = [...bySlug.entries()]
      .filter(([, titles]) => titles.length > 1)
      .map(([slug, titles]) => `${slug}: ${titles.join(" | ")}`);
    expect(collisions.sort()).toEqual([]);
    // The route guard has to accept what the loader produced, or the page
    // 404s on a post that exists.
    expect(posts.filter((p) => !isValidBlogSlug(p.slug)).map((p) => p.slug)).toEqual(
      [],
    );
  });

  it("never collapses two tag names onto one slug", async () => {
    const posts = await listBlogPosts();
    const byslug = new Map<string, Set<string>>();
    for (const post of posts) {
      for (const tag of post.tags ?? []) {
        const slug = tagToSlug(tag);
        byslug.set(slug, (byslug.get(slug) ?? new Set()).add(tag));
      }
    }
    const merged = [...byslug.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([slug, names]) => `${slug}: ${[...names].join(" | ")}`);
    expect(merged.sort()).toEqual([]);
  });

  it("produces no empty or unroutable tag slug", async () => {
    // A tag of only punctuation slugs to "" and would route to /blog/tag/.
    const posts = await listBlogPosts();
    const bad = [...new Set(posts.flatMap((p) => p.tags ?? []))]
      .map((tag) => ({ tag, slug: tagToSlug(tag) }))
      .filter(({ slug }) => !slug || !isValidBlogTag(slug))
      .map(({ tag, slug }) => `${tag} -> ${JSON.stringify(slug)}`);
    expect(bad.sort()).toEqual([]);
  });

  it("gives every author a distinct, routable slug", async () => {
    const authors = await listBlogAuthors();
    const slugs = authors.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.filter((s) => !isValidAuthorSlug(s))).toEqual([]);
  });

  it("lists every tag a published post carries", async () => {
    // A tag on a post but missing from listBlogTags is a tag with no listing
    // page, reachable only from the post that mentions it.
    const posts = await listBlogPosts();
    const listed = new Set((await listBlogTags()).map((t) => t.slug));
    const missing = [
      ...new Set(posts.flatMap((p) => (p.tags ?? []).map(tagToSlug))),
    ]
      .filter((slug) => !listed.has(slug))
      .sort();
    expect(missing).toEqual([]);
  });
});
