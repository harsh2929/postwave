// SPDX-License-Identifier: AGPL-3.0-only
//
// Tag listing route (MKTN-011). Lists every published post carrying a tag.
// Statically generated from the tag catalog so only tags that actually have
// posts get an indexable page — no empty, thin, or fabricated tag pages.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import {
  formatBlogDate,
  getPostsByTag,
  isValidBlogTag,
  listBlogTags,
  tagToSlug,
} from "@/lib/blog";
import { publicSiteOrigin } from "@/lib/site-url";

const SITE = publicSiteOrigin();

interface RouteParams {
  tag: string;
}

interface PageProps {
  params: Promise<RouteParams>;
}

export async function generateStaticParams(): Promise<RouteParams[]> {
  const tags = await listBlogTags();
  return tags.map((t) => ({ tag: t.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { tag } = await params;
  const tags = await listBlogTags();
  const found = tags.find((t) => t.slug === tag);
  if (!found) {
    return {
      title: "Tag not found | Moosewave blog",
      description: "This blog tag has no posts.",
      robots: { index: false, follow: true },
    };
  }
  const url = `${SITE}/blog/tag/${tag}`;
  const description = `Moosewave blog posts tagged “${found.label}”.`;
  return {
    title: `${found.label} — Moosewave blog`,
    description,
    alternates: {
      canonical: url,
      types: { "application/rss+xml": `${SITE}/blog/rss.xml` },
    },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      url,
      title: `Posts tagged “${found.label}”`,
      description,
      siteName: "Moosewave",
      locale: "en_US",
    },
  };
}

export default async function BlogTagPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { tag } = await params;
  if (!isValidBlogTag(tag)) notFound();

  const posts = await getPostsByTag(tag);
  if (posts.length === 0) notFound();

  const tags = await listBlogTags();
  const label = tags.find((t) => t.slug === tag)?.label ?? tag;
  const url = `${SITE}/blog/tag/${tag}`;

  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: SITE },
    { name: "Blog", url: `${SITE}/blog` },
    { name: label, url },
  ]);

  const itemList: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: posts.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE}/blog/${p.slug}`,
      name: p.title,
    })),
  };

  return (
    <div className="bg-pw-paper">
      <JsonLd data={[itemList, breadcrumbs]} id={`tag-jsonld-${tag}`} />

      {/* === Hero === */}
      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-4xl mx-auto px-6 pt-16 pb-14 md:pt-20 md:pb-16">
          <nav aria-label="Breadcrumb" className="text-xs text-pw-muted-on-ink">
            <Link href="/blog" className="hover:text-white transition-colors">
              ← Back to blog
            </Link>
          </nav>
          <div className="mt-6 text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
            Tag
          </div>
          <h1 className="mt-3 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            {label}
          </h1>
          <p className="mt-5 text-lg text-pw-muted-on-ink">
            {posts.length} {posts.length === 1 ? "post" : "posts"} tagged{" "}
            <span className="font-mono">{label}</span>.
          </p>
        </div>
      </section>

      {/* === Posts === */}
      <section className="bg-pw-paper">
        <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
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
                    <ul aria-label="Tags" className="mt-4 flex flex-wrap gap-2">
                      {post.tags.map((t) => {
                        const active = tagToSlug(t) === tag;
                        return (
                          <li key={t}>
                            <Link
                              href={`/blog/tag/${tagToSlug(t)}`}
                              aria-current={active ? "true" : undefined}
                              className={
                                active
                                  ? "inline-flex rounded-full border border-pw-ember-500 bg-pw-ember-500/10 px-2.5 py-0.5 text-[11px] font-mono text-pw-ember-700"
                                  : "inline-flex rounded-full border border-pw-ink2/10 bg-pw-surface px-2.5 py-0.5 text-[11px] font-mono text-pw-ink2/70 hover:border-pw-ember-500 hover:text-pw-ember-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                              }
                            >
                              {t}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>

          <div className="mt-12 border-t border-pw-surface pt-6 text-sm">
            <Link
              href="/blog"
              className="inline-flex items-center font-medium text-pw-ember-700 hover:text-pw-ember-800 transition-colors"
            >
              ← All posts
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
