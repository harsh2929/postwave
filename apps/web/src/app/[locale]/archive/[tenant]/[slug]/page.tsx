// SPDX-License-Identifier: AGPL-3.0-only
//
// Public archive issue page — the rendered HTML of a single
// campaign that an operator has flipped `archive_public=true`.
//
// Three concerns layered:
//
//   1. RSC fetch + hard-failure handling (missing / unavailable).
//   2. SEO metadata generated from the per-issue archive_*
//      columns (title, description, og:image), falling back to the
//      tenant-level pretty name when unset.
//   3. A 1x1 tracking pixel placed at the bottom of the article.
//      The backend dedupes per-visitor per-day so the pixel
//      counting model is "page renders, humans only, salted
//      anon-id". See apps/api/internal/archive/views.go.
//
// HTML body safety: the operator-authored body passes through
// `sanitizeArchiveHTML` server-side before injection — strips
// <script>/<iframe>/event handlers/javascript: URLs.

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";

import {
  archiveTrackingPixelURL,
  fetchArchiveIssue,
  type ArchiveIssueDetail,
} from "@/lib/archive-api";
import { sanitizeArchiveHTML } from "@/lib/sanitize-html";
import { asRoute } from "@/lib/typed-routes";
import { compactProse } from "@/styles/compact-prose";
import archiveStyles from "./archive-body.module.css";

interface PageProps {
  params: Promise<{ tenant: string; slug: string; locale: string }>;
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { tenant, slug } = await props.params;
  const r = await fetchArchiveIssue(tenant, slug);
  if (r.kind !== "ok") {
    return { title: "Archive — Moosewave" };
  }
  const issue = r.data;
  const desc = issue.metaDescription || issue.excerpt || undefined;
  return {
    title: `${issue.subject} — ${prettyTenant(tenant)}`,
    description: desc,
    alternates: issue.canonicalUrl
      ? { canonical: issue.canonicalUrl }
      : undefined,
    openGraph: {
      type: "article",
      title: issue.subject,
      description: desc,
      images: issue.ogImage ? [{ url: issue.ogImage }] : undefined,
      publishedTime: issue.publishedAt,
      authors: issue.authorName ? [issue.authorName] : undefined,
    },
    twitter: {
      card: issue.ogImage ? "summary_large_image" : "summary",
      title: issue.subject,
      description: desc,
      images: issue.ogImage ? [issue.ogImage] : undefined,
    },
  };
}

function prettyTenant(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function ArchiveIssuePage(props: PageProps) {
  const { tenant, slug, locale } = await props.params;
  setRequestLocale(locale);
  const [t, result] = await Promise.all([
    getTranslations("archive"),
    fetchArchiveIssue(tenant, slug),
  ]);

  if (result.kind === "missing") {
    return <Card title={t("not_found_title")} body={t("not_found_body")} />;
  }
  if (result.kind === "unavailable") {
    return <Card title={t("unavailable_title")} body={t("unavailable_body")} />;
  }

  const tenantName = prettyTenant(tenant);
  const readMinutes = estimateReadMinutes(result.data.htmlBody);
  return (
    <IssueArticle
      tenant={tenant}
      locale={locale}
      issue={result.data}
      readMinutes={readMinutes}
      breadcrumbLabel={t("breadcrumb_label")}
      archiveLabel={t("back_to_archive", { tenant: tenantName })}
      readMinutesLabel={
        readMinutes > 0 ? t("read_minutes", { count: readMinutes }) : undefined
      }
    />
  );
}

function IssueArticle({
  tenant,
  locale,
  issue,
  readMinutes,
  breadcrumbLabel,
  archiveLabel,
  readMinutesLabel,
}: {
  tenant: string;
  locale: string;
  issue: ArchiveIssueDetail;
  readMinutes: number;
  breadcrumbLabel: string;
  archiveLabel: string;
  readMinutesLabel?: string;
}) {
  const pixelURL = archiveTrackingPixelURL(tenant, issue.slug);
  const indexURL = `/${locale}/archive/${encodeURIComponent(tenant)}`;
  // Sanitize server-side; the call is cheap and the result lands in
  // the SSR'd HTML payload directly. See lib/sanitize-html.ts for
  // the threat model + allowlist.
  const safeBody = sanitizeArchiveHTML(issue.htmlBody);

  return (
    <article className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      <nav
        aria-label={breadcrumbLabel}
        className="text-sm text-muted-foreground"
      >
        <Link
          href={asRoute(indexURL)}
          className="inline-flex min-h-11 items-center rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span aria-hidden="true">←&nbsp;</span>
          {archiveLabel}
        </Link>
      </nav>

      <header className="space-y-3 border-b pb-6">
        <h1 className="break-words text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">
          {issue.subject}
        </h1>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
          <time dateTime={issue.publishedAt}>
            {formatArchiveDate(issue.publishedAt, locale)}
          </time>
          {issue.authorName ? (
            <span className="break-words [overflow-wrap:anywhere]">
              <span aria-hidden="true">· </span>
              {issue.authorName}
            </span>
          ) : null}
          {readMinutes > 0 && readMinutesLabel ? (
            <span>
              <span aria-hidden="true">· </span>
              {readMinutesLabel}
            </span>
          ) : null}
        </div>
      </header>

      {issue.heroImage ? (
        // Operator-supplied hero image. Standard <img> tag because
        // Next's Image component requires allowlisting every
        // operator-controlled host, impractical for a multi-tenant
        // SaaS surface. It is the largest above-the-fold element, so it is
        // the LCP element: eager + fetchPriority="high" so the browser
        // requests it ahead of the render-blocking stylesheets rather than
        // discovering it at default priority behind them.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={issue.heroImage}
          alt=""
          loading="eager"
          fetchPriority="high"
          decoding="async"
          className="aspect-[16/9] w-full rounded-xl border object-cover shadow-sm"
        />
      ) : null}

      <div
        className={`${archiveStyles.root} ${compactProse.root} ${compactProse.small} ${compactProse.invertDark} max-w-none break-words [overflow-wrap:anywhere]`}
        dangerouslySetInnerHTML={{ __html: safeBody }}
      />

      <footer className="space-y-2 border-t pt-5 text-sm text-muted-foreground">
        <p className="m-0">
          <Link
            href={asRoute(indexURL)}
            className="inline-flex min-h-11 items-center rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">←&nbsp;</span>
            {archiveLabel}
          </Link>
        </p>
      </footer>

      {/* Tracking pixel. Native <img> so the browser fires the
          request even before JS hydrates. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={pixelURL}
        alt=""
        width={1}
        height={1}
        loading="lazy"
        decoding="async"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
        aria-hidden="true"
      />
    </article>
  );
}

/**
 * 225 wpm read estimate. Strips HTML before counting so a body that
 * happens to mention `<table>` thirty times doesn't inflate the
 * estimate. Returns 0 for bodies under 30s of reading (we don't
 * surface trivially short estimates).
 */
function estimateReadMinutes(html: string): number {
  if (!html) return 0;
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.split(" ").filter(Boolean).length;
  const minutes = Math.round(words / 225);
  return minutes < 1 ? 0 : minutes;
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

function formatArchiveDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

// No route-segment `revalidate` here on purpose. It governs the Full Route
// Cache, which the root layout's `connection()` call makes unreachable for
// every route in this app — declaring it made the route look protected in
// review while every hit was still a cold render plus two upstream calls.
// The 60s window now lives where it actually takes effect: the Data Cache,
// via PUBLIC_ARCHIVE_READ in lib/archive-api.ts. Restore a segment-level
// export only alongside a change that lets this route prerender.
