// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "Moosewave blog", "newsletter platform engineering blog",
// "mailchimp migration writeup", and long-tail technical newsletter queries.
// Server component. MDX frontmatter is read at build/render time on the server.
import type { Metadata } from "next";
import Link from "next/link";

import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import {
  BLOG_PAGE_SIZE,
  formatBlogDate,
  listBlogPosts,
  listBlogTags,
  paginatePosts,
  parsePageParam,
  tagToSlug,
} from "@/lib/blog";
import { publicSiteOrigin } from "@/lib/site-url";

const SITE_URL = publicSiteOrigin();
const PAGE_URL = `${SITE_URL}/blog`;
const FEED_URL = `${SITE_URL}/blog/rss.xml`;
const PAGE_DESCRIPTION =
  "Engineering, product, migration, and production-qualification writeups from the team building Moosewave.";

interface PageProps {
  searchParams?: Promise<{ page?: string | string[] }>;
}

// Static index metadata. Pagination is expressed with ?page= in the component
// below; the canonical intentionally stays /blog so paginated views don't
// splinter the index's ranking signal, and the RSS alternate advertises the
// blog feed (MKTN-012).
export const metadata: Metadata = {
  title: "Blog | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: {
    canonical: PAGE_URL,
    types: { "application/rss+xml": FEED_URL },
  },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave blog",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/blog/opengraph-image",
        width: 1200,
        height: 630,
        alt: "The Moosewave blog",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave blog",
    description: PAGE_DESCRIPTION,
  },
};

export default async function BlogIndexPage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const requestedPage = parsePageParam((await searchParams)?.page);
  const allPosts = await listBlogPosts();
  const { posts, page, totalPages } = paginatePosts(allPosts, requestedPage);
  const tags = await listBlogTags();
  const pageStart = (page - 1) * BLOG_PAGE_SIZE;

  const blogSchema: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "The Moosewave blog",
    description: PAGE_DESCRIPTION,
    url: PAGE_URL,
    publisher: {
      "@type": "Organization",
      name: "Moosewave",
      url: SITE_URL,
    },
  };

  const itemListSchema: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: posts.map((p, i) => ({
      "@type": "ListItem",
      position: pageStart + i + 1,
      url: `${SITE_URL}/blog/${p.slug}`,
      name: p.title,
    })),
  };

  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: SITE_URL },
    { name: "Blog", url: PAGE_URL },
  ]);

  return (
    <div className="bg-pw-paper">
      <JsonLd
        data={[blogSchema, itemListSchema, breadcrumbs]}
        id="blog-jsonld"
      />

      {/* === Hero === */}
      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-4xl mx-auto px-6 pt-16 pb-14 md:pt-20 md:pb-16">
          <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
            Blog
          </div>
          <h1 className="mt-3 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Notes from the team.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Migrations, deliverability, voice AI, and the unglamorous
            infrastructure that makes them work. Written by the people building
            Moosewave.
          </p>
        </div>
      </section>

      {/* === Posts === */}
      <section className="bg-pw-paper">
        <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
          {posts.length === 0 ? (
            <p className="text-pw-muted-on-paper">
              The first posts ship soon. Check back, or read the{" "}
              <Link
                href="/changelog"
                className="text-pw-ember-700 hover:text-pw-ember-800 transition-colors"
              >
                changelog
              </Link>{" "}
              in the meantime.
            </p>
          ) : (
            <ul className="divide-y divide-pw-surface">
              {posts.map((post) => (
                <li key={post.slug} className="py-8 first:pt-0">
                  <article>
                    <div className="flex items-center gap-3 text-xs text-pw-muted-on-paper">
                      <time dateTime={post.date} className="font-mono">
                        {formatBlogDate(post.date)}
                      </time>
                      <span aria-hidden>·</span>
                      <span>{post.readingTime}</span>
                    </div>
                    <h2 className="mt-3 text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2 leading-tight">
                      <Link
                        href={`/blog/${post.slug}`}
                        className="hover:text-pw-ember-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 rounded"
                      >
                        {post.title}
                      </Link>
                    </h2>
                    <p className="mt-3 text-pw-muted-on-paper leading-relaxed">
                      {post.description}
                    </p>
                    {post.tags.length > 0 ? (
                      <ul
                        aria-label="Tags"
                        className="mt-4 flex flex-wrap gap-2"
                      >
                        {post.tags.map((t) => (
                          <li key={t}>
                            <Link
                              href={`/blog/tag/${tagToSlug(t)}`}
                              className="inline-flex rounded-full border border-pw-ink2/10 bg-pw-surface px-2.5 py-0.5 text-[11px] font-mono text-pw-ink2/70 hover:border-pw-ember-500 hover:text-pw-ember-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                            >
                              {t}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-5">
                      <Link
                        href={`/blog/${post.slug}`}
                        className="inline-flex items-center text-sm font-medium text-pw-ember-700 hover:text-pw-ember-800 transition-colors"
                        aria-label={`Read: ${post.title}`}
                      >
                        Read post →
                      </Link>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}

          {/* Pagination — only renders once the archive exceeds one page. */}
          {totalPages > 1 ? (
            <nav
              aria-label="Blog pagination"
              className="mt-12 flex items-center justify-between border-t border-pw-surface pt-6 text-sm"
            >
              {page > 1 ? (
                <Link
                  href={page - 1 === 1 ? "/blog" : `/blog?page=${page - 1}`}
                  rel="prev"
                  className="inline-flex items-center font-medium text-pw-ember-700 hover:text-pw-ember-800 transition-colors"
                >
                  ← Newer posts
                </Link>
              ) : (
                <span />
              )}
              <span className="text-pw-muted-on-paper font-mono text-xs">
                Page {page} of {totalPages}
              </span>
              {page < totalPages ? (
                <Link
                  href={`/blog?page=${page + 1}`}
                  rel="next"
                  className="inline-flex items-center font-medium text-pw-ember-700 hover:text-pw-ember-800 transition-colors"
                >
                  Older posts →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}

          {/* Browse by tag — makes the taxonomy discoverable from the index. */}
          {tags.length > 0 ? (
            <div className="mt-14 border-t border-pw-surface pt-8">
              <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
                Browse by tag
              </div>
              <ul className="mt-4 flex flex-wrap gap-2">
                {tags.map((t) => (
                  <li key={t.slug}>
                    <Link
                      href={`/blog/tag/${t.slug}`}
                      className="inline-flex items-center gap-1 rounded-full border border-pw-ink2/10 bg-pw-surface px-3 py-1 text-xs font-mono text-pw-ink2/70 hover:border-pw-ember-500 hover:text-pw-ember-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                    >
                      {t.label}
                      <span className="text-pw-muted-on-paper">{t.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      {/* === Internal-link footer === */}
      <section className="border-t border-pw-surface bg-pw-surface/40">
        <div className="max-w-4xl mx-auto px-6 py-12 grid gap-8 md:grid-cols-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              Switching?
            </div>
            <Link
              href="/migrations"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              See how migrations work →
            </Link>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              Read the features
            </div>
            <Link
              href="/features"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              All three pillars in detail →
            </Link>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              Compare
            </div>
            <Link
              href="/vs"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              Moosewave vs other platforms →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
