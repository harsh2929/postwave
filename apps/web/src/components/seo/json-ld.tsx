// SPDX-License-Identifier: AGPL-3.0-only
//
// Reusable JSON-LD primitives for structured data + AI-overview optimization.
//
// SECURITY NOTE — why dangerouslySetInnerHTML is appropriate here:
//   - The data is serialized as JSON and every `<` is escaped so an embedded
//     `</script>` sequence cannot terminate the script element.
//   - This is the standard Next.js + Google-recommended pattern for embedding
//     schema.org JSON-LD blocks. Using next/script is unnecessary because the
//     payload is data, not code. DOMPurify would be misapplied here — it
//     sanitizes HTML, but our payload is JSON inside a non-rendering script.
//   - See: https://nextjs.org/docs/app/guides/json-ld

import { headers } from "next/headers";
import type { ReactElement } from "react";

/**
 * Minimal JSON-LD shape — every block must have @context (almost always
 * https://schema.org) and @type. The remaining fields vary by type.
 */
export type JsonLdObject = {
  "@context": "https://schema.org";
  "@type": string;
  [key: string]: unknown;
};

interface JsonLdProps {
  data: JsonLdObject | JsonLdObject[];
  /** Optional id, useful for de-duping if the same block renders in two places. */
  id?: string;
}

export function serializeJsonLd(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

/**
 * Render one or more JSON-LD blocks. If passed an array we wrap in a single
 * @graph for cleaner emission.
 */
export async function JsonLd({ data, id }: JsonLdProps): Promise<ReactElement> {
  const payload = Array.isArray(data)
    ? { "@context": "https://schema.org", "@graph": data }
    : data;
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <script
      type="application/ld+json"
      id={id}
      nonce={nonce}
      // The browser blanks the CSP `nonce` content attribute from the DOM after
      // applying it, so the SSR `nonce="…"` never matches the now-empty client
      // attribute → a React hydration mismatch on every page that renders
      // structured data. suppressHydrationWarning scopes the exception to this
      // one script (same fix as the root-layout pre-paint scripts). This was the
      // residual site-wide hydration error the T03 root-layout fix missed.
      suppressHydrationWarning
      // SAFETY: serializeJsonLd escapes HTML-significant opening brackets.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(payload) }}
    />
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — return well-shaped JSON-LD objects so callers can compose
// them without re-typing @context / @type strings.
// ---------------------------------------------------------------------------

export interface OrganizationSchemaOpts {
  name: string;
  url: string;
  logo: string;
  description?: string;
  sameAs?: string[];
  email?: string;
  foundingDate?: string;
}

export function organizationSchema(opts: OrganizationSchemaOpts): JsonLdObject {
  const obj: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: opts.name,
    url: opts.url,
    logo: opts.logo,
  };
  if (opts.description) obj.description = opts.description;
  if (opts.sameAs && opts.sameAs.length > 0) obj.sameAs = opts.sameAs;
  if (opts.foundingDate) obj.foundingDate = opts.foundingDate;
  if (opts.email) {
    obj.contactPoint = {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: opts.email,
      availableLanguage: ["English"],
    };
  }
  return obj;
}

export interface SoftwareApplicationSchemaOpts {
  name: string;
  description: string;
  url: string;
  applicationCategory?: string;
  operatingSystem?: string;
  /** Lowest tier price as a numeric string, e.g. "0". */
  priceLow?: string;
  /** Highest tier price as a numeric string, e.g. "700". */
  priceHigh?: string;
  priceCurrency?: string;
  /** Optional aggregateRating; OMIT if you can't justify with real data. */
  aggregateRating?: {
    ratingValue: string;
    ratingCount: string;
    bestRating?: string;
  };
  publisherName?: string;
  publisherUrl?: string;
}

export function softwareApplicationSchema(
  opts: SoftwareApplicationSchemaOpts,
): JsonLdObject {
  const obj: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: opts.name,
    description: opts.description,
    url: opts.url,
    applicationCategory: opts.applicationCategory ?? "BusinessApplication",
    operatingSystem: opts.operatingSystem ?? "Web",
  };

  if (opts.priceLow !== undefined && opts.priceHigh !== undefined) {
    obj.offers = {
      "@type": "AggregateOffer",
      priceCurrency: opts.priceCurrency ?? "USD",
      lowPrice: opts.priceLow,
      highPrice: opts.priceHigh,
      offerCount: "4",
    };
  } else if (opts.priceLow !== undefined) {
    obj.offers = {
      "@type": "Offer",
      price: opts.priceLow,
      priceCurrency: opts.priceCurrency ?? "USD",
    };
  }

  if (opts.aggregateRating) {
    obj.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: opts.aggregateRating.ratingValue,
      ratingCount: opts.aggregateRating.ratingCount,
      bestRating: opts.aggregateRating.bestRating ?? "5",
    };
  }

  if (opts.publisherName) {
    obj.publisher = {
      "@type": "Organization",
      name: opts.publisherName,
      ...(opts.publisherUrl ? { url: opts.publisherUrl } : {}),
    };
  }

  return obj;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export function faqPageSchema(faqs: FaqEntry[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: f.answer,
      },
    })),
  };
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export function breadcrumbSchema(items: BreadcrumbItem[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export interface ArticleSchemaOpts {
  headline: string;
  description: string;
  url: string;
  image?: string | string[];
  datePublished: string;
  dateModified?: string;
  authorName: string;
  authorUrl?: string;
  publisherName: string;
  publisherLogo: string;
  /** Use "BlogPosting" for blog posts, "Article" for general editorial. */
  variant?: "Article" | "BlogPosting" | "NewsArticle";
}

export function articleSchema(opts: ArticleSchemaOpts): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": opts.variant ?? "Article",
    headline: opts.headline,
    description: opts.description,
    url: opts.url,
    ...(opts.image ? { image: opts.image } : {}),
    datePublished: opts.datePublished,
    dateModified: opts.dateModified ?? opts.datePublished,
    author: {
      "@type": "Person",
      name: opts.authorName,
      ...(opts.authorUrl ? { url: opts.authorUrl } : {}),
    },
    publisher: {
      "@type": "Organization",
      name: opts.publisherName,
      logo: {
        "@type": "ImageObject",
        url: opts.publisherLogo,
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": opts.url,
    },
  };
}
