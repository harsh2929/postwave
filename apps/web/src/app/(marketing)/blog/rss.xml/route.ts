// SPDX-License-Identifier: AGPL-3.0-only
//
// Blog RSS 2.0 feed (MKTN-012). Generated from the filesystem-backed post
// index so it never drifts from what /blog renders. Mirrors the changelog
// Atom feed's escaping/caching shape, but emits RSS 2.0 (type
// application/rss+xml) to match the alternate <link> advertised in blog
// metadata and what feed readers expect at /blog/rss.xml.

import { listBlogPosts } from "@/lib/blog";
import { publicSiteOrigin } from "@/lib/site-url";

export const runtime = "nodejs";
// Reads MDX from disk at request time; keep it fresh across redeploys.
export const dynamic = "force-dynamic";

const SITE_URL = publicSiteOrigin();
const FEED_URL = `${SITE_URL}/blog/rss.xml`;
const BLOG_URL = `${SITE_URL}/blog`;
const FEED_DESCRIPTION =
  "Engineering, product, migration, and production-qualification writeups from the team building Moosewave.";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** RSS pubDate/lastBuildDate must be RFC-822. */
function toRfc822(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

async function renderFeed(): Promise<string> {
  const posts = await listBlogPosts();
  const lastBuild = posts[0] ? toRfc822(posts[0].date) : new Date().toUTCString();

  const items = posts
    .map((post) => {
      const url = `${BLOG_URL}/${post.slug}`;
      const categories = post.tags
        .map((t) => `      <category>${escapeXml(t)}</category>`)
        .join("\n");
      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${toRfc822(post.date)}</pubDate>
      <dc:creator>${escapeXml(post.author)}</dc:creator>
      <description>${escapeXml(post.description)}</description>${
        categories ? `\n${categories}` : ""
      }
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Moosewave Blog</title>
    <link>${escapeXml(BLOG_URL)}</link>
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${escapeXml(FEED_URL)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

export async function GET(): Promise<Response> {
  return new Response(await renderFeed(), {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=600, stale-while-revalidate=86400",
    },
  });
}
