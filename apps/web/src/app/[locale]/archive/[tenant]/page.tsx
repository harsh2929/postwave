// SPDX-License-Identifier: AGPL-3.0-only
//
// Public archive index for a tenant — the list of every campaign
// the operator has flipped `archive_public=true`. Server-rendered,
// no auth, SEO-ready.
//
// Two terminal states (missing tenant / API unavailable) render
// their own card; the happy path is the issue list with pinned
// items floated to the top.

import { Metadata } from "next";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";

import {
  archiveRSSURL,
  fetchArchiveIndex,
  type ArchiveIssueSummary,
} from "@/lib/archive-api";
import { asRoute } from "@/lib/typed-routes";

interface PageProps {
  params: Promise<{ tenant: string; locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
}

/**
 * Per-tenant `<head>` metadata. Tenant slug populates the title;
 * the description falls back to a generic blurb when we can't fetch
 * the tenant's display name (no point making the metadata builder
 * fail just because the API is slow).
 */
export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { tenant, locale } = await props.params;
  setRequestLocale(locale);
  const t = await getTranslations("archive");
  const tenantName = prettyTenant(tenant);
  return {
    title: t("metadata_title", { tenant: tenantName }),
    description: t("metadata_description", { tenant: tenantName }),
    alternates: {
      types: {
        "application/rss+xml": archiveRSSURL(tenant),
      },
    },
    openGraph: {
      title: t("metadata_title", { tenant: tenantName }),
      type: "website",
    },
  };
}

function prettyTenant(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function ArchiveIndexPage(props: PageProps) {
  const { tenant, locale } = await props.params;
  const { cursor } = await props.searchParams;
  setRequestLocale(locale);
  const [t, result] = await Promise.all([
    getTranslations("archive"),
    fetchArchiveIndex(tenant, { cursor, limit: 50 }),
  ]);

  if (result.kind === "missing") {
    return <Card title={t("not_found_title")} body={t("not_found_body")} />;
  }
  if (result.kind === "unavailable") {
    return <Card title={t("unavailable_title")} body={t("unavailable_body")} />;
  }

  const issues = result.data.items;
  if (issues.length === 0) {
    return <Card title={t("empty_title")} body={t("empty_body")} />;
  }

  // Group rendering so pinned items get a visual separator without
  // forcing the API to split the response. Pinned come first courtesy
  // of `ORDER BY archive_pinned DESC` on the server.
  const pinned = issues.filter((i) => i.pinned);
  const rest = issues.filter((i) => !i.pinned);

  return (
    <article className="mx-auto max-w-2xl space-y-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="space-y-2 border-b pb-6">
        <h1 className="break-words text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">
          {prettyTenant(tenant)}
        </h1>
        <p className="break-words text-sm leading-6 text-muted-foreground">
          {t("index_intro")}
        </p>
        <div className="flex gap-3 pt-1 text-sm text-muted-foreground">
          <a
            href={archiveRSSURL(tenant)}
            rel="alternate"
            type="application/rss+xml"
            className="inline-flex min-h-11 items-center rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t("rss_link")}
          </a>
        </div>
      </header>

      {pinned.length > 0 ? (
        <section className="space-y-3" aria-label={t("pinned_section")}>
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t("pinned_section")}
          </h2>
          <ul className="space-y-4">
            {pinned.map((issue) => (
              <IssueLink
                key={issue.slug}
                tenant={tenant}
                locale={locale}
                issue={issue}
                featured
              />
            ))}
          </ul>
        </section>
      ) : null}

      {rest.length > 0 ? (
        <section className="space-y-3">
          {pinned.length > 0 ? (
            <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {t("recent_section")}
            </h2>
          ) : null}
          <ul className="space-y-4">
            {rest.map((issue) => (
              <IssueLink
                key={issue.slug}
                tenant={tenant}
                locale={locale}
                issue={issue}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {result.data.nextCursor ? (
        <nav className="border-t pt-6" aria-label={t("pagination_label")}>
          <Link
            href={asRoute(
              `/${locale}/archive/${encodeURIComponent(tenant)}?cursor=${encodeURIComponent(result.data.nextCursor)}`,
            )}
            rel="next"
            className="inline-flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t("older_issues")}
          </Link>
        </nav>
      ) : null}
    </article>
  );
}

interface IssueLinkProps {
  tenant: string;
  locale: string;
  issue: ArchiveIssueSummary;
  featured?: boolean;
}

function IssueLink({
  tenant,
  locale,
  issue,
  featured = false,
}: IssueLinkProps) {
  return (
    <li>
      <Link
        href={asRoute(
          `/${locale}/archive/${encodeURIComponent(tenant)}/${encodeURIComponent(issue.slug)}`,
        )}
        className={`group block min-w-0 space-y-2 rounded-xl border p-4 transition-[background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-muted/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:hover:translate-y-0 ${featured ? "bg-primary/[0.035]" : "bg-card"}`}
      >
        <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <h3
            className={
              featured
                ? "break-words text-lg font-semibold underline-offset-2 group-hover:underline [overflow-wrap:anywhere]"
                : "break-words text-base font-medium underline-offset-2 group-hover:underline [overflow-wrap:anywhere]"
            }
          >
            {issue.subject}
          </h3>
          <time
            dateTime={issue.publishedAt}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {formatArchiveDate(issue.publishedAt, locale, "short")}
          </time>
        </div>
        {issue.excerpt ? (
          <p className="break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            {issue.excerpt}
          </p>
        ) : null}
      </Link>
    </li>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-md space-y-3 px-5 py-16 text-center sm:px-8">
      <h1 className="break-words text-xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="break-words text-sm leading-6 text-muted-foreground">
        {body}
      </p>
    </div>
  );
}

function formatArchiveDate(
  value: string,
  locale: string,
  month: "short" | "long",
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month,
    day: "numeric",
    year: "numeric",
  }).format(date);
}

// A freshly published issue still surfaces within 60s, but the window lives
// in the Data Cache (PUBLIC_ARCHIVE_READ in lib/archive-api.ts), not in a
// route-segment `revalidate`: the latter governs the Full Route Cache, which
// the root layout's `connection()` call makes unreachable for every route in
// this app. Declaring it here read as protection while every hit was a cold
// render. Restore it alongside a change that lets this route prerender.
