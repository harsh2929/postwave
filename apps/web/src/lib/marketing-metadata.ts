// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { publicSiteOrigin } from "@/lib/site-url";

const SITE_URL = publicSiteOrigin();

export type PageMetadataInput = {
  title: string;
  description: string;
  /** Optional eyebrow shown small + teal in the OG image (e.g. "vs Mailchimp"). */
  eyebrow?: string;
  /** Optional subtitle line in the OG image. Falls back to `description`. */
  ogSubtitle?: string;
  /** Optional canonical path (e.g. "/pricing"). */
  path?: string;
};

/**
 * Builds the absolute URL to the dynamic OG image route.
 * Routes through `/og?title=…&subtitle=…&eyebrow=…` and URL-encodes inputs.
 */
export function ogImageUrl(input: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
}): string {
  const params = new URLSearchParams();
  params.set("title", input.title);
  if (input.subtitle) params.set("subtitle", input.subtitle);
  if (input.eyebrow) params.set("eyebrow", input.eyebrow);
  return `${SITE_URL}/og?${params.toString()}`;
}

/**
 * Returns a Next.js `Metadata` object for a marketing page, with
 * canonical URL, OpenGraph, Twitter card, and dynamic OG image wired up.
 */
export function pageMetadata(input: PageMetadataInput): Metadata {
  const { title, description, eyebrow, ogSubtitle, path } = input;
  const subtitle = ogSubtitle ?? description;

  const image = ogImageUrl({
    title,
    subtitle,
    eyebrow,
  });

  const canonicalPath = path ? safeMarketingPath(path) : "";
  const url = canonicalPath ? `${SITE_URL}${canonicalPath}` : undefined;

  return {
    title,
    description,
    alternates: url ? { canonical: url } : undefined,
    openGraph: {
      type: "website",
      url,
      title,
      description,
      siteName: "Moosewave",
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
      creator: "@postwave",
    },
  };
}

export function safeMarketingPath(path: string): string {
  if (!path || path.length > 1024) return "";
  if (!path.startsWith("/") || path.startsWith("//")) return "";
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "";
  const rawPath = path.split(/[?#]/, 1)[0] ?? "";
  for (const part of rawPath.split("/")) {
    let decoded = part;
    for (let i = 0; i < 2; i += 1) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        break;
      }
    }
    if (decoded === "." || decoded === "..") return "";
  }
  return path;
}
