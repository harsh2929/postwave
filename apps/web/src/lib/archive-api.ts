// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the PUBLIC archive endpoints. Mirrors
// apps/api/internal/archive/archive.go — no admin endpoints reachable
// from this module.
//
// All three calls are unauthenticated; the tenant slug in the URL is
// the scoping primary key (resolved server-side via
// tenant_public_settings.tenant_archive_slug).

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

const USE_MOCKS = isMockModeEnabled();

export interface ArchiveIssueSummary {
  slug: string;
  subject: string;
  excerpt: string;
  publishedAt: string;
  pinned?: boolean;
}

export interface ArchiveIssueDetail {
  slug: string;
  subject: string;
  /** Sanitised HTML body. Renderer should still treat as untrusted. */
  htmlBody: string;
  publishedAt: string;
  pinned?: boolean;
  metaDescription?: string;
  ogImage?: string;
  heroImage?: string;
  authorName?: string;
  canonicalUrl?: string;
  excerpt?: string;
}

export interface ArchiveListPage {
  items: ArchiveIssueSummary[];
  nextCursor?: string;
}

/**
 * Result discriminator so the page can switch on a single union
 * type. Mirrors gifts-api / preferences-api conventions.
 */
export type ArchiveListResult =
  | { kind: "ok"; data: ArchiveListPage }
  | { kind: "missing" }
  | { kind: "unavailable" };

export type ArchiveDetailResult =
  | { kind: "ok"; data: ArchiveIssueDetail }
  | { kind: "missing" }
  | { kind: "unavailable" };

/**
 * Caching for the two public read paths.
 *
 * The archive pages declared a route-segment `revalidate = 60`, but that
 * governs the Full Route Cache, which the root layout's `connection()` call
 * puts out of reach for every route in the app. The Data Cache is a separate
 * layer and is still reachable — but only if the call opts out of the
 * server-side `cache: "no-store"` that `api.get` applies by default (see
 * lib/api.ts). `force-cache` + `revalidate` is what actually turns "one
 * upstream call per view" into "one per URL per minute"; a popular issue
 * linked from a newsletter otherwise re-renders and re-fetches per visitor.
 *
 * Safe here and nowhere else in this module: these two endpoints are
 * unauthenticated (`credentials: "omit"`), tenant-scoped by the URL, and
 * serve content the operator has explicitly published.
 */
const PUBLIC_ARCHIVE_READ = {
  credentials: "omit",
  cache: "force-cache",
  next: { revalidate: 60 },
} as const;

export async function fetchArchiveIndex(
  tenantSlug: string,
  opts: { cursor?: string; limit?: number; query?: string } = {},
): Promise<ArchiveListResult> {
  if (USE_MOCKS) return mockArchiveIndex(tenantSlug, opts.cursor);
  try {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.query) params.set("query", opts.query);
    const qs = params.toString();
    const path = `/api/public/archive/${encodeURIComponent(tenantSlug)}${qs ? `?${qs}` : ""}`;
    const data = await api.get<ArchiveListPage>(path, PUBLIC_ARCHIVE_READ);
    return {
      kind: "ok",
      data: { items: data.items ?? [], nextCursor: data.nextCursor },
    };
  } catch (err) {
    if (String(err).includes("404")) return { kind: "missing" };
    return { kind: "unavailable" };
  }
}

export async function fetchArchiveIssue(
  tenantSlug: string,
  campaignSlug: string,
): Promise<ArchiveDetailResult> {
  if (USE_MOCKS) return mockArchiveIssue(tenantSlug, campaignSlug);
  try {
    const data = await api.get<ArchiveIssueDetail>(
      `/api/public/archive/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(campaignSlug)}`,
      PUBLIC_ARCHIVE_READ,
    );
    return { kind: "ok", data };
  } catch (err) {
    if (String(err).includes("404")) return { kind: "missing" };
    return { kind: "unavailable" };
  }
}

/**
 * Public URL for the 1x1 tracking pixel. The image element fires
 * once per page render; the backend dedupes per visitor per day via
 * the salted anon-id (see apps/api/internal/archive/views.go).
 *
 * Returned as a fully-qualified URL when NEXT_PUBLIC_API_URL is set
 * so the browser can request it regardless of the apps/web origin.
 */
export function archiveTrackingPixelURL(
  tenantSlug: string,
  campaignSlug: string,
): string {
  if (USE_MOCKS) {
    return "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  }
  const origin = process.env.NEXT_PUBLIC_API_URL ?? "";
  const path = `/api/public/archive/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(campaignSlug)}/pixel.gif`;
  if (!origin) return path;
  return origin.replace(/\/$/, "") + path;
}

/** Fully-qualified URL for the public RSS feed (newsletter_feed package). */
export function archiveRSSURL(tenantSlug: string): string {
  const origin = process.env.NEXT_PUBLIC_API_URL ?? "";
  const path = `/api/public/archive/${encodeURIComponent(tenantSlug)}/feed.xml`;
  if (!origin) return path;
  return origin.replace(/\/$/, "") + path;
}

/**
 * Fully-qualified URL for the public archive sitemap.
 *
 * Mounted next to the index by `archive.MountPublicRenderRoutes`
 * (`/api/public/archive/{tenant_slug}/sitemap.xml`). Built the same way as
 * `archiveRSSURL` so the two share one origin rule; both live on the API
 * origin rather than the web origin because the API renders the XML.
 */
export function archiveSitemapURL(tenantSlug: string): string {
  const origin = process.env.NEXT_PUBLIC_API_URL ?? "";
  const path = `/api/public/archive/${encodeURIComponent(tenantSlug)}/sitemap.xml`;
  if (!origin) return path;
  return origin.replace(/\/$/, "") + path;
}

/**
 * Archive statistics.
 *
 * `/api/v1/archive/stats` was reached by desktop and by no web file.
 *
 * The two traffic figures cover a 30-DAY window while the two issue counts are
 * all-time. Rendering the four side by side without saying so invites the
 * reader to compare them as though they shared a period — the field names are
 * the only thing carrying that distinction, so the type keeps them.
 */
export interface ArchiveStats {
  totalIssues: number;
  pinnedIssues: number;
  /** Last 30 days, unlike the issue counts above. */
  views30d: number;
  uniqueVisitors30d: number;
}

export async function getArchiveStats(): Promise<ArchiveStats> {
  const res = await api.get<ArchiveStats>("/api/v1/archive/stats");
  const n = (v: unknown) => (Number.isFinite(v) ? Number(v) : 0);
  return {
    totalIssues: n(res?.totalIssues),
    pinnedIssues: n(res?.pinnedIssues),
    views30d: n(res?.views30d),
    uniqueVisitors30d: n(res?.uniqueVisitors30d),
  };
}

const MOCK_ARCHIVE_ISSUES: ArchiveIssueDetail[] = [
  {
    slug: "welcome-to-the-signal",
    subject: "Welcome to The Signal Brief",
    excerpt:
      "Why this newsletter exists, what you can expect, and how we will respect your time.",
    htmlBody: `<p>Thanks for joining <strong>The Signal Brief</strong>.</p><h2>What lands here</h2><p>One practical idea, the evidence behind it, and a clear way to use it. No filler and no artificial urgency.</p><blockquote><p>A useful email should earn the next open.</p></blockquote><p>We will keep the format concise, link to primary sources, and make leaving as easy as joining.</p>`,
    publishedAt: "2026-08-20T09:00:00Z",
    pinned: true,
    authorName: "Maya Chen",
    metaDescription: "An introduction to The Signal Brief newsletter.",
  },
  {
    slug: "designing-for-the-inbox",
    subject: "Designing for the inbox people actually have",
    excerpt:
      "A field guide to scannable structure, useful restraint, and links that survive narrow screens.",
    htmlBody: `<p>Email is a constrained canvas. That is a feature.</p><h2>Start with hierarchy</h2><p>Give every section one job, keep paragraphs short, and let the primary action look primary.</p><h3>Test the extremes</h3><ul><li>A 320-pixel viewport</li><li>A very long unbroken URL such as https://example.com/research/a-deliberately-long-path-that-must-wrap-without-breaking-the-reader-layout</li><li>Keyboard-only navigation</li></ul><pre><code>subject = useful + specific + honest</code></pre>`,
    publishedAt: "2026-08-13T09:00:00Z",
    authorName: "Maya Chen",
  },
  {
    slug: "measurement-without-the-theater",
    subject: "Measurement without the theater",
    excerpt:
      "A small scorecard for separating decision-grade signals from impressive-looking noise.",
    htmlBody: `<p>Metrics help when they change a decision.</p><table><thead><tr><th>Signal</th><th>Question</th><th>Action</th></tr></thead><tbody><tr><td>Replies</td><td>Did the idea resonate?</td><td>Follow up</td></tr><tr><td>Conversions</td><td>Did the promise match?</td><td>Refine the offer</td></tr></tbody></table><p>Track less, inspect it more carefully, and write down the decision each measure informs.</p>`,
    publishedAt: "2026-08-06T09:00:00Z",
    authorName: "Jon Bell",
  },
  {
    slug: "a-quiet-launch-checklist",
    subject: "A quiet launch checklist for small teams",
    excerpt:
      "The handful of checks that keep a modest launch calm, legible, and reversible.",
    htmlBody: `<p>A launch does not need a control room.</p><ol><li>Verify the audience and suppression list.</li><li>Open every link on a phone.</li><li>Write down the rollback threshold.</li><li>Have one person watch replies.</li></ol><p>Calm systems make good judgment easier.</p>`,
    publishedAt: "2026-07-30T09:00:00Z",
    authorName: "Maya Chen",
  },
];

function mockArchiveIndex(
  tenantSlug: string,
  cursor?: string,
): ArchiveListResult {
  if (tenantSlug === "missing-letter") return { kind: "missing" };
  if (tenantSlug === "unavailable-letter") return { kind: "unavailable" };
  if (tenantSlug === "empty-letter") {
    return { kind: "ok", data: { items: [] } };
  }
  if (tenantSlug !== "demo-letter") return { kind: "missing" };

  const page = cursor
    ? MOCK_ARCHIVE_ISSUES.slice(3)
    : MOCK_ARCHIVE_ISSUES.slice(0, 3);
  return {
    kind: "ok",
    data: {
      items: page.map((issue) => ({
        slug: issue.slug,
        subject: issue.subject,
        excerpt: issue.excerpt ?? "",
        publishedAt: issue.publishedAt,
        pinned: issue.pinned,
      })),
      ...(!cursor ? { nextCursor: "demo-page-2" } : {}),
    },
  };
}

function mockArchiveIssue(
  tenantSlug: string,
  campaignSlug: string,
): ArchiveDetailResult {
  if (tenantSlug === "unavailable-letter" || campaignSlug === "unavailable") {
    return { kind: "unavailable" };
  }
  if (tenantSlug !== "demo-letter") return { kind: "missing" };
  const issue = MOCK_ARCHIVE_ISSUES.find(
    (candidate) => candidate.slug === campaignSlug,
  );
  return issue ? { kind: "ok", data: issue } : { kind: "missing" };
}
