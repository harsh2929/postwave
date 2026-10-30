// SPDX-License-Identifier: AGPL-3.0-only
//
// Marketing sitemap. Reconciled against the actual app/(marketing) routes on
// disk plus the routes the wave-2 SEO agent will create
// (/blog, /customers, /security, /integrations/*).
//
// Priority guidance (Google ignores the absolute number but the relative
// hierarchy still informs crawl budget):
//   1.0    homepage
//   0.9    pricing, features                   (top conversion pages)
//   0.8    migrations index, vs index          (high-intent landing)
//   0.7    vs/{competitor}, migrations/{from}, integrations/*, docs, changelog
//   0.6    blog, customers, roadmap, mcp, migrate-anywhere
//   0.5    secondary, status, about, security
//   0.3    legal/*

import type { MetadataRoute } from "next";

import { INTEGRATIONS } from "@/lib/integrations";
import { listBlogPosts, listBlogTags } from "@/lib/blog";
import { listBlogAuthors } from "@/lib/blog-authors";
import { publicReleaseApproved } from "@/lib/public-release";
import { publicSiteOrigin } from "@/lib/site-url";

// Keep publication approval runtime-switchable on the exact signed image.
// Static generation would permanently capture the build environment instead.
export const dynamic = "force-dynamic";

const SITE_URL = publicSiteOrigin();

// Built once per server-render so a redeploy refreshes lastModified across
// all entries. Individual MDX-backed posts will override this once the
// blog/customers indexes ship.
const NOW = new Date();

type Freq = MetadataRoute.Sitemap[number]["changeFrequency"];

interface Route {
  path: string;
  changeFrequency: Freq;
  priority: number;
  /** Optional override; defaults to the build-time NOW. */
  lastModified?: Date;
}

const ROUTES: Route[] = [
  // ── Core ─────────────────────────────────────────────────────────────────
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.9 },
  { path: "/features", changeFrequency: "monthly", priority: 0.9 },

  // ── Migrations ───────────────────────────────────────────────────────────
  { path: "/migrations", changeFrequency: "monthly", priority: 0.8 },
  {
    path: "/migrations/activecampaign",
    changeFrequency: "monthly",
    priority: 0.7,
  },
  { path: "/migrations/hubspot", changeFrequency: "monthly", priority: 0.7 },
  { path: "/migrations/mailchimp", changeFrequency: "monthly", priority: 0.7 },
  { path: "/migrations/substack", changeFrequency: "monthly", priority: 0.7 },
  { path: "/migrations/beehiiv", changeFrequency: "monthly", priority: 0.7 },
  { path: "/migrations/convertkit", changeFrequency: "monthly", priority: 0.7 },
  { path: "/migrations/mailerlite", changeFrequency: "monthly", priority: 0.7 },
  { path: "/migrations/sendy", changeFrequency: "monthly", priority: 0.7 },
  { path: "/migrate-anywhere", changeFrequency: "monthly", priority: 0.6 },

  // ── Product surfaces ────────────────────────────────────────────────────
  { path: "/mcp", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.7 },
  { path: "/changelog", changeFrequency: "weekly", priority: 0.7 },
  { path: "/roadmap", changeFrequency: "monthly", priority: 0.6 },

  // ── Capability pages (platform surfaces) ────────────────────────────────
  { path: "/deliverability", changeFrequency: "monthly", priority: 0.8 },
  { path: "/voice", changeFrequency: "monthly", priority: 0.8 },
  { path: "/audiences", changeFrequency: "monthly", priority: 0.8 },
  { path: "/commerce", changeFrequency: "monthly", priority: 0.8 },
  { path: "/sms", changeFrequency: "monthly", priority: 0.8 },
  { path: "/automations", changeFrequency: "monthly", priority: 0.8 },
  { path: "/developers", changeFrequency: "monthly", priority: 0.8 },
  { path: "/forge", changeFrequency: "monthly", priority: 0.7 },
  { path: "/api-docs", changeFrequency: "weekly", priority: 0.7 },
  { path: "/analytics", changeFrequency: "monthly", priority: 0.8 },
  { path: "/podcasts", changeFrequency: "monthly", priority: 0.7 },
  { path: "/forms", changeFrequency: "monthly", priority: 0.8 },
  { path: "/landing-pages", changeFrequency: "monthly", priority: 0.8 },

  // ── Editorial and trust routes. Blog post slugs are appended from the
  // filesystem-backed content index below so removed posts cannot leave 404s.
  { path: "/blog", changeFrequency: "weekly", priority: 0.6 },
  { path: "/customers", changeFrequency: "monthly", priority: 0.6 },
  { path: "/security", changeFrequency: "monthly", priority: 0.5 },
  // The European Accessibility Act expects the statement to be findable by the
  // people who need it, which is the opposite of leaving it out of the sitemap
  // and reachable only from a footer link.
  { path: "/accessibility", changeFrequency: "monthly", priority: 0.5 },

  // ── Integrations index. Per-provider slugs are appended dynamically in
  // sitemap() from the INTEGRATIONS catalog, so new providers are crawled
  // automatically without editing this file.
  { path: "/integrations", changeFrequency: "monthly", priority: 0.7 },

  // ── Company ─────────────────────────────────────────────────────────────
  { path: "/about", changeFrequency: "monthly", priority: 0.5 },
  { path: "/status", changeFrequency: "weekly", priority: 0.4 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!publicReleaseApproved()) return [];
  // Per-provider integration detail pages, derived from the catalog so the
  // sitemap and /integrations/[slug] generateStaticParams never drift.
  const integrationRoutes: Route[] = INTEGRATIONS.map((i) => ({
    path: `/integrations/${i.slug}`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const blogRoutes: Route[] = (await listBlogPosts()).map((post) => ({
    path: `/blog/${post.slug}`,
    changeFrequency: "yearly",
    priority: 0.5,
    lastModified: new Date(post.date),
  }));

  // Tag and author listing pages, derived from the same content index so they
  // never point at empty taxonomy pages.
  const tagRoutes: Route[] = (await listBlogTags()).map((t) => ({
    path: `/blog/tag/${t.slug}`,
    changeFrequency: "weekly",
    priority: 0.4,
  }));

  const authorRoutes: Route[] = (await listBlogAuthors()).map((a) => ({
    path: `/blog/author/${a.slug}`,
    changeFrequency: "weekly",
    priority: 0.4,
  }));

  return [
    ...ROUTES,
    ...integrationRoutes,
    ...blogRoutes,
    ...tagRoutes,
    ...authorRoutes,
  ].map((r) => ({
    url: `${SITE_URL}${r.path}`,
    lastModified: r.lastModified ?? NOW,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
