// SPDX-License-Identifier: AGPL-3.0-only
//
// Author listing route (MKTN-018). Lists every published post by an author and
// shows the author byline card. Statically generated from the author catalog
// so only authors with posts get an indexable page.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { formatBlogDate, tagToSlug } from "@/lib/blog";
import {
  getAuthor,
  getPostsByAuthor,
  isValidAuthorSlug,
  listBlogAuthors,
} from "@/lib/blog-authors";
import { publicSiteOrigin } from "@/lib/site-url";

const SITE = publicSiteOrigin();

interface RouteParams {
  author: string;
}

interface PageProps {
  params: Promise<RouteParams>;
}

export async function generateStaticParams(): Promise<RouteParams[]> {
  const authors = await listBlogAuthors();
  return authors.map((a) => ({ author: a.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { author: authorSlugParam } = await params;
  const authors = await listBlogAuthors();
  const found = authors.find((a) => a.slug === authorSlugParam);
  if (!found) {
    return {
      title: "Author not found | Moosewave blog",
      description: "This author has no posts.",
      robots: { index: false, follow: true },
    };
  }
  const url = `${SITE}/blog/author/${authorSlugParam}`;
  return {
    title: `${found.name} — Moosewave blog`,
    description: found.bio,
    alternates: {
      canonical: url,
      types: { "application/rss+xml": `${SITE}/blog/rss.xml` },
    },
    robots: { index: true, follow: true },
    openGraph: {
      type: "profile",
      url,
      title: `${found.name} — Moosewave blog`,
      description: found.bio,
      siteName: "Moosewave",
      locale: "en_US",
    },
  };
}

export default async function BlogAuthorPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { author: authorSlugParam } = await params;
  if (!isValidAuthorSlug(authorSlugParam)) notFound();

  const posts = await getPostsByAuthor(authorSlugParam);
  if (posts.length === 0) notFound();

  const author = getAuthor(posts[0].author);
  const url = `${SITE}/blog/author/${authorSlugParam}`;

  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: SITE },
    { name: "Blog", url: `${SITE}/blog` },
    { name: author.name, url },
  ]);

  const personSchema: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: author.name,
    description: author.bio,
    jobTitle: author.role,
    url,
  };

  return (
    <div className="bg-pw-paper">
      <JsonLd
        data={[personSchema, breadcrumbs]}
        id={`author-jsonld-${authorSlugParam}`}
      />

      {/* === Hero === */}
      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-4xl mx-auto px-6 pt-16 pb-14 md:pt-20 md:pb-16">
          <nav aria-label="Breadcrumb" className="text-xs text-pw-muted-on-ink">
            <Link href="/blog" className="hover:text-white transition-colors">
              ← Back to blog
            </Link>
          </nav>
          <div className="mt-6 flex items-start gap-4">
            <span
              aria-hidden
              className="flex h-14 w-14 shrink-0 select-none items-center justify-center rounded-full bg-white/10 text-base font-semibold uppercase tracking-wide text-white"
            >
              {author.initials}
            </span>
            <div>
              <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
                Author
              </div>
              <h1 className="mt-2 text-3xl md:text-5xl font-semibold tracking-tight leading-[1.05]">
                {author.name}
              </h1>
              <div className="mt-1 text-sm text-pw-muted-on-ink">
                {author.role}
              </div>
            </div>
          </div>
          <p className="mt-5 text-lg text-pw-muted-on-ink max-w-2xl">
            {author.bio}
          </p>
        </div>
      </section>

      {/* === Posts === */}
      <section className="bg-pw-paper">
        <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
          <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
            {posts.length} {posts.length === 1 ? "post" : "posts"}
          </div>
          <ul className="mt-6 divide-y divide-pw-surface">
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
