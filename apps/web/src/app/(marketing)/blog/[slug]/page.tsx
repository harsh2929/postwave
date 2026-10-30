// SPDX-License-Identifier: AGPL-3.0-only
//
// Individual blog post route. Reads the post's MDX from the filesystem,
// extracts H2 headings for a table of contents, and renders the MDX body
// via next-mdx-remote/rsc inside a server component. JSON-LD covers
// BlogPosting + BreadcrumbList.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import type { ComponentPropsWithoutRef } from "react";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import styles from "./blog-prose.module.css";

import {
  JsonLd,
  articleSchema,
  breadcrumbSchema,
} from "@/components/seo/json-ld";
import { SectionNav } from "@/components/marketing/section-nav";
import {
  formatBlogDate,
  getAdjacentPosts,
  getBlogPost,
  listBlogPosts,
  tagToSlug,
} from "@/lib/blog";
import { getAuthor } from "@/lib/blog-authors";
import { publicSiteOrigin } from "@/lib/site-url";

interface RouteParams {
  slug: string;
}

interface PageProps {
  params: Promise<RouteParams>;
}

const SITE = publicSiteOrigin();

// MDX emits raw <pre> elements. On a phone these code samples overflow by
// design, so they must themselves be keyboard-focusable for Safari users who
// cannot pan them with a pointer.
const BLOG_MDX_COMPONENTS = {
  pre: ({ className, ...props }: ComponentPropsWithoutRef<"pre">) => (
    <pre
      {...props}
      tabIndex={0}
      role="group"
      aria-label="Scrollable code example"
      className={`${className ?? ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500`}
    />
  ),
};

export async function generateStaticParams(): Promise<RouteParams[]> {
  const posts = await listBlogPosts();
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  let post;
  try {
    post = await getBlogPost(slug);
  } catch {
    return {
      title: "Post not found | Moosewave",
      description: "This blog post doesn't exist.",
    };
  }

  const url = `${SITE}/blog/${slug}`;
  return {
    title: `${post.title} | Moosewave blog`,
    description: post.description,
    alternates: {
      canonical: url,
      types: { "application/rss+xml": `${SITE}/blog/rss.xml` },
    },
    robots: { index: true, follow: true },
    authors: [{ name: post.author }],
    openGraph: {
      type: "article",
      url,
      title: post.title,
      description: post.description,
      siteName: "Moosewave",
      locale: "en_US",
      publishedTime: post.date,
      authors: [post.author],
      tags: post.tags,
      images: [
        {
          url: `/blog/${slug}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: post.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      creator: "@moosewave",
    },
  };
}

interface TocEntry {
  id: string;
  text: string;
}

/**
 * Pull H2 headings out of an MDX body and produce { id, text } pairs that
 * match the slugs rehype-slug will assign at render time. Deliberately
 * small parser — only handles ATX `## Heading` lines (which is what every
 * Moosewave post uses today) and ignores anything inside a fenced code
 * block. If a future post uses Setext (`====`) headings, extend here.
 */
function extractToc(body: string): TocEntry[] {
  const out: TocEntry[] = [];
  let inCodeFence = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/[`*_]/g, "").trim();
    out.push({ id: slugify(text), text });
  }
  return out;
}

/**
 * Mirror of github-slugger's algorithm at the level rehype-slug uses it.
 * Lowercase, strip non-word chars, collapse whitespace to dashes. Duplicates
 * are rare in our content and if one ever shows up, the TOC link will land
 * on the first occurrence (rehype-slug suffixes the second), which is
 * acceptable for now.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export default async function BlogPostPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { slug } = await params;

  let post;
  try {
    post = await getBlogPost(slug);
  } catch {
    notFound();
  }

  const { prev, next } = await getAdjacentPosts(slug);
  const toc = extractToc(post.content);
  const author = getAuthor(post.author);
  const url = `${SITE}/blog/${slug}`;

  const article = articleSchema({
    headline: post.title,
    description: post.description,
    url,
    image: `${SITE}/blog/${slug}/opengraph-image`,
    datePublished: post.date,
    authorName: post.author,
    publisherName: "Moosewave",
    publisherLogo: `${SITE}/icon.png`,
    variant: "BlogPosting",
  });

  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: SITE },
    { name: "Blog", url: `${SITE}/blog` },
    { name: post.title, url },
  ]);

  return (
    <div className="bg-pw-paper">
      <JsonLd data={[article, breadcrumbs]} id={`post-jsonld-${slug}`} />

      <article>
        {/* === Header === */}
        <header className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
          <div className="max-w-3xl mx-auto px-6 pt-14 pb-12 md:pt-20 md:pb-16">
            <nav
              aria-label="Breadcrumb"
              className="text-xs text-pw-muted-on-ink"
            >
              <Link href="/blog" className="hover:text-white transition-colors">
                ← Back to blog
              </Link>
            </nav>
            <ul
              aria-label="Tags"
              className="mt-6 flex flex-wrap gap-2 text-[11px] font-mono text-pw-muted-on-ink"
            >
              {post.tags.map((t) => (
                <li key={t}>
                  <Link
                    href={`/blog/tag/${tagToSlug(t)}`}
                    className="inline-flex rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-0.5 hover:border-pw-ember-400 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-400"
                  >
                    {t}
                  </Link>
                </li>
              ))}
            </ul>
            <h1 className="mt-5 text-3xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
              {post.title}
            </h1>
            <p className="mt-5 text-base md:text-lg text-pw-muted-on-ink max-w-2xl">
              {post.description}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-4 text-sm text-pw-muted-on-ink">
              <span>
                By{" "}
                <Link
                  href={`/blog/author/${author.slug}`}
                  className="text-white hover:text-pw-ember-400 transition-colors"
                >
                  {author.name}
                </Link>
              </span>
              <span aria-hidden>·</span>
              <time dateTime={post.date} className="font-mono">
                {formatBlogDate(post.date)}
              </time>
              <span aria-hidden>·</span>
              <span>{post.readingTime}</span>
            </div>
          </div>
        </header>

        {/* === Body + TOC === */}
        <div className="max-w-5xl mx-auto px-6 py-14 md:py-20 grid gap-12 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className={`min-w-0 ${styles.root}`}>
            <MDXRemote
              source={post.content}
              components={BLOG_MDX_COMPONENTS}
              options={{
                mdxOptions: {
                  remarkPlugins: [remarkGfm],
                  rehypePlugins: [
                    rehypeSlug,
                    [rehypeAutolinkHeadings, { behavior: "wrap" }],
                  ],
                },
              }}
            />
          </div>

          {toc.length > 0 ? (
            <aside
              aria-label="Table of contents"
              className="hidden md:block border-l border-pw-surface pl-6 text-sm self-start sticky top-20"
            >
              <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper mb-3">
                Contents
              </div>
              <SectionNav
                variant="rail"
                ariaLabel="On this page"
                items={toc.map((entry) => ({
                  id: entry.id,
                  label: entry.text,
                }))}
              />
            </aside>
          ) : null}
        </div>

        {/* === Author byline card === */}
        <section className="border-t border-pw-surface bg-pw-paper">
          <div className="max-w-3xl mx-auto px-6 py-10">
            <div className="flex items-start gap-4 rounded-xl border border-pw-ink2/10 bg-pw-surface/40 p-5">
              <span
                aria-hidden
                className="flex h-12 w-12 shrink-0 select-none items-center justify-center rounded-full bg-pw-ink text-sm font-semibold uppercase tracking-wide text-white"
              >
                {author.initials}
              </span>
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
                  Written by
                </div>
                <Link
                  href={`/blog/author/${author.slug}`}
                  className="mt-1 inline-block text-base font-semibold text-pw-ink2 hover:text-pw-ember-700 transition-colors"
                >
                  {author.name}
                </Link>
                <div className="text-sm text-pw-muted-on-paper">
                  {author.role}
                </div>
                <p className="mt-2 text-sm text-pw-ink2/80 leading-relaxed">
                  {author.bio}
                </p>
                <Link
                  href={`/blog/author/${author.slug}`}
                  className="mt-3 inline-flex items-center text-sm font-medium text-pw-ember-700 hover:text-pw-ember-800 transition-colors"
                >
                  More from {author.name} →
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* === Prev / next === */}
        {prev || next ? (
          <nav
            aria-label="More posts"
            className="border-t border-pw-surface bg-pw-surface/40"
          >
            <div className="max-w-3xl mx-auto px-6 py-10 grid gap-6 sm:grid-cols-2">
              <div>
                {prev ? (
                  <Link
                    href={`/blog/${prev.slug}`}
                    className="block rounded-lg border border-pw-ink2/10 bg-pw-paper p-5 hover:border-pw-ember-500 transition-colors"
                  >
                    <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
                      ← Older
                    </div>
                    <div className="mt-2 font-semibold text-pw-ink2">
                      {prev.title}
                    </div>
                  </Link>
                ) : null}
              </div>
              <div className="sm:text-right">
                {next ? (
                  <Link
                    href={`/blog/${next.slug}`}
                    className="block rounded-lg border border-pw-ink2/10 bg-pw-paper p-5 hover:border-pw-ember-500 transition-colors"
                  >
                    <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
                      Newer →
                    </div>
                    <div className="mt-2 font-semibold text-pw-ink2">
                      {next.title}
                    </div>
                  </Link>
                ) : null}
              </div>
            </div>
          </nav>
        ) : null}

        {/* === Closer / internal links === */}
        <section className="border-t border-pw-surface bg-pw-paper">
          <div className="max-w-3xl mx-auto px-6 py-12 text-sm text-pw-muted-on-paper">
            <p>
              Want the rest of the platform? See{" "}
              <Link
                href="/features"
                className="rounded text-pw-ember-700 underline decoration-1 underline-offset-2 transition-colors hover:text-pw-ember-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                features
              </Link>
              ,{" "}
              <Link
                href="/migrations"
                className="rounded text-pw-ember-700 underline decoration-1 underline-offset-2 transition-colors hover:text-pw-ember-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                migrations
              </Link>
              , or the{" "}
              <Link
                href="/security"
                className="rounded text-pw-ember-700 underline decoration-1 underline-offset-2 transition-colors hover:text-pw-ember-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                security page
              </Link>
              .
            </p>
          </div>
        </section>
      </article>
    </div>
  );
}
