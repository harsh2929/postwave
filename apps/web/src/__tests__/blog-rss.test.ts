// SPDX-License-Identifier: AGPL-3.0-only
//
// Verifies the blog RSS 2.0 feed (MKTN-012) is well-formed and generated from
// the real post index.

import { describe, expect, it } from "vitest";

import { GET } from "@/app/(marketing)/blog/rss.xml/route";
import { listBlogPosts } from "@/lib/blog";

describe("blog RSS feed", () => {
  it("returns valid RSS 2.0 for every published post", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/rss+xml",
    );

    const xml = await response.text();
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<channel>");
    expect(xml).toContain("<title>Moosewave Blog</title>");
    // Self-referential atom:link advertises the feed's own URL.
    expect(xml).toContain('rel="self"');
    expect(xml).toContain("/blog/rss.xml");

    const posts = await listBlogPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(xml).toContain(`/blog/${post.slug}</link>`);
    }

    // pubDate is RFC-822 (feed-reader requirement), not a bare ISO date.
    expect(xml).toMatch(/<pubDate>[^<]+GMT<\/pubDate>/);
    expect(xml).not.toMatch(/<pubDate>\d{4}-\d{2}-\d{2}<\/pubDate>/);
  });
});
