// SPDX-License-Identifier: AGPL-3.0-only
//
// Robots policy. Two layers:
//   1. Default rule for all crawlers — allow the marketing surface, block
//      authenticated app routes, internal APIs, framework chunks, and any
//      URL that contains a one-time token (confirmation links, magic links,
//      password resets). Tokenised URLs must never end up in a search index.
//   2. AI-training crawlers (GPTBot, Google-Extended, etc.) get tighter
//      restrictions: comparison and legal pages are excluded from training
//      corpora — they're high-investment editorial we'd rather not have
//      regurgitated wholesale.

import type { MetadataRoute } from "next";

import { locales } from "@/i18n/locales";
import { publicReleaseApproved } from "@/lib/public-release";
import { publicSiteOrigin } from "@/lib/site-url";

// The approval is an ECS runtime value, not a browser-build input. Without a
// dynamic metadata route Next would freeze the fail-closed build-time result
// into the signed image and an approved runtime could never publish safely.
export const dynamic = "force-dynamic";

const SITE_URL = publicSiteOrigin();
const HOST = new URL(SITE_URL).host;

const AI_BOTS = [
  "GPTBot",
  "Google-Extended",
  "CCBot",
  "anthropic-ai",
  "ClaudeBot",
  "PerplexityBot",
  "Bytespider",
  "Amazonbot",
];

// Paths that must never be indexed.
//   /app/                 — authenticated dashboard
//   /api/                 — backend endpoints
//   /_next/               — framework chunks, source maps
//   /forms/*/confirm/*    — single-use double-opt-in tokens
//   /preferences/*        — token-scoped subscriber preference pages
//   /verify-email         — one-time email verification flow
//   /reset-password       — token-scoped reset flow
//   /forgot-password      — gate page; no SEO value, leak risk via referrer
//   /magic-link           — token-scoped passwordless login
//   /totp-challenge       — auth challenge pages
//   /accept-invite        — single-use team-invitation credential
//   /browser-auth/*       — browser handoff for tokenized auth links
//   /cli/auth             — device/CLI authorization consent
//   /login, /signup       — auth surfaces (allow but de-emphasised; index ok)
const LOCALIZED_PRIVATE_PATHS = locales.flatMap((locale) => [
  `/${locale}/forms/`,
  `/${locale}/preferences/`,
  `/${locale}/gift/`,
]);

const COMMON_DISALLOW = [
  "/app/",
  "/api/",
  "/_next/",
  "/forms/",
  "/preferences/",
  "/verify-email",
  "/reset-password",
  "/forgot-password",
  "/magic-link",
  "/totp-challenge",
  "/accept-invite",
  "/browser-auth/",
  "/cli/auth",
  "/legal/",
  "/vs/",
  "/affiliates",
  "/gift/",
  ...LOCALIZED_PRIVATE_PATHS,
];

export default function robots(): MetadataRoute.Robots {
  if (!publicReleaseApproved()) {
    return {
      rules: { userAgent: "*", disallow: "/" },
      host: HOST,
    };
  }
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: COMMON_DISALLOW,
      },
      ...AI_BOTS.map((ua) => ({
        userAgent: ua,
        // AI crawlers get the same path exclusions plus our high-investment
        // editorial that we'd rather not see regurgitated.
        disallow: [...COMMON_DISALLOW, "/legal/", "/vs/"],
      })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: HOST,
  };
}
