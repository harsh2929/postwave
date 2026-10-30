// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "private podcast for paid newsletter", "tokenized
// podcast RSS feed", "tier-gated podcast access", "Spotify Open Access
// newsletter". Primary intent is the paid-newsletter operator who wants to
// ship audio episodes to paying subscribers without bolting on a second tool.
import type { Metadata } from "next";
import Link from "next/link";

import { SectionNav } from "@/components/marketing/section-nav";

import {
  ProductShot,
  type ProductShotVariant,
} from "@/components/marketing/product-shot";
import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
} from "@/components/seo/json-ld";

const PAGE_URL = "https://moosewave.com/podcasts";
const PAGE_DESCRIPTION =
  "Private podcasting for paid newsletters: a per-subscriber tokenized RSS feed, tier-gated episodes only active paid subs can hear, and Spotify Open Access compatibility via token-in-path auth.";

export const metadata: Metadata = {
  title: "Private podcasts for paid newsletters | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave private podcasts: tokenized, tier-gated RSS",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/podcasts/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave private podcasting for paid newsletters",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave private podcasts: tokenized, tier-gated RSS",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "How do paid subscribers get a private podcast feed?",
    answer:
      "Each subscriber gets their own tokenized RSS URL. You mint a token for a subscriber's email and Moosewave returns a feed URL like /api/public/podcast/{your-slug}/feed/{token}.xml plus the raw secret to ship them. The token is a 256-bit random base64url secret bound to one (tenant, subscriber_email) row, so no two subscribers share a URL. When a subscriber opens that URL in Apple Podcasts, Overcast, Spotify, or Pocket Casts, the token resolves to their email and the feed renders exactly the episodes they're entitled to. There's also a public free-only feed at /feed.xml for directory submission, with no token and no gated episodes.",
  },
  {
    question: "Which episodes does a subscriber actually hear?",
    answer:
      "Free episodes (no required tier) are always included. A tier-gated episode is only included when the subscriber has a paid subscription with status = 'active' that matches the episode's required tier. If you've renamed a plan so the tier name no longer matches any plan, Moosewave falls back to unlocking the episode for any active paid subscription — a deliberate guard against silently locking out paying subscribers. Cancelled or lapsed subscribers drop back to the free episodes automatically, because the entitlement check runs on every feed fetch, not at mint time.",
  },
  {
    question: "Does this work with Spotify Open Access and CDN-hosted audio?",
    answer:
      "Yes. The entitlement token rides as a path segment, not a query string — /feed/{token}.xml — so audio hosts and aggregators that strip query strings (some CDNs, some podcast directories) still authenticate cleanly. Personal feeds are served with Cache-Control: private, no-store and an itunes:block 'yes' tag so they're never indexed by Apple Podcasts or cached by a shared proxy, matching how Substack and Ghost treat private feeds. The public free-only feed is cacheable and submittable to directories.",
  },
  {
    question: "Can I rotate or revoke a subscriber's access?",
    answer:
      "Yes — both are one admin call. Re-minting a token rotates the secret in place: the old URL stops working immediately and every other subscriber's URL is untouched. Revoking sets revoked_at on the row, so the next fetch returns 401 'feed revoked' and the dashboard can show 'revoked' rather than 'never minted'. A previously revoked subscriber can be re-issued by a single mint call, which clears the revoked flag. A token minted for one tenant's subscriber can never fetch another tenant's feed, even if someone copies the URL.",
  },
  {
    question: "Where do episodes come from — do I record in Moosewave?",
    answer:
      "You attach audio to a campaign. Each campaign carries podcast metadata — audio URL, MIME type, byte length, duration in seconds, a public flag, and a required tier — alongside the archive fields the feed already surfaces (title, summary, hero image, author). Moosewave renders the iTunes-namespaced RSS 2.0 envelope from those fields, including the enclosure, itunes:duration, and cover art. Host the audio wherever you like; Moosewave is the feed and the entitlement layer, not the recording studio.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Podcasts", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Private podcasts",
  description: PAGE_DESCRIPTION,
  brand: { "@type": "Brand", name: "Moosewave" },
  url: PAGE_URL,
  category: "Newsletter and email marketing platform",
};

interface Screenshot {
  alt: string;
  variant: ProductShotVariant;
}

interface Section {
  id: "private-feed" | "open-access" | "control";
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "private-feed",
    number: "1.0",
    eyebrow: "Private podcasting",
    title: "A private feed for every paying subscriber.",
    subhead:
      "Ship audio to your paid list the same way you ship email. Each subscriber gets a personal tokenized RSS URL, and the feed renders only the episodes they're entitled to — checked live, on every fetch.",
    bullets: [
      "Per-subscriber tokenized RSS URL: the token is a 256-bit random base64url secret bound to exactly one (tenant, subscriber_email) row, so no two subscribers share a feed.",
      "Free episodes (no required tier) are always included; tier-gated episodes are added only when the subscriber has a paid subscription with status = 'active' that matches the episode's required tier.",
      "Entitlement is verified inline in SQL on every feed fetch — a cancelled or lapsed subscriber drops back to the free episodes automatically, with no scheduled re-sync to wait on.",
      "Plan-rename guard: if a tier name no longer matches any plan, the episode unlocks for any active paid subscription instead of silently locking out paying readers.",
      "A separate public, free-only feed (podcast_public = true and no required tier) is built for Apple Podcasts / Spotify directory submission — no token, no gated episodes.",
      "Per-subscriber feeds salt their cache validator with the token hash, so two subscribers with different entitlements never share a cached response.",
    ],
    shots: [
      {
        alt: "Per-subscriber tokenized podcast feed URL with a copy-to-ship button",
        variant: "podcasts",
      },
      {
        alt: "Episode list showing free episodes and tier-gated episodes for an active paid subscriber",
        variant: "podcasts",
      },
      {
        alt: "Entitlement check resolving a subscriber's active paid subscription to unlocked episodes",
        variant: "podcasts",
      },
    ],
  },
  {
    id: "open-access",
    number: "2.0",
    eyebrow: "Spotify Open Access",
    title: "Works with the apps your readers already use.",
    subhead:
      "The entitlement token rides in the URL path, not a query string — so the feed authenticates cleanly even through CDNs and aggregators that strip query strings. Apple Podcasts, Overcast, Spotify, Pocket Casts all just work.",
    bullets: [
      "Token-in-path authentication: /api/public/podcast/{slug}/feed/{token}.xml. CDNs and directories that strip query strings still resolve the subscriber, the standard Spotify Open Access pattern.",
      "Feeds are no-cookie and no-CSRF, because podcast apps can't preserve session cookies between fetches anyway — the token is the authenticator.",
      "Personal feeds carry itunes:block 'yes' and X-Robots-Tag noindex so private URLs are never indexed by Apple Podcasts, matching how Substack and Ghost treat private feeds.",
      "Personal feeds are served Cache-Control: private, no-store so a shared proxy can never hand one subscriber's feed to another.",
      "iTunes-namespaced RSS 2.0 envelope: channel author, summary, explicit flag, category, and cover art, so the feed validates against Apple Podcasts and Spotify directory requirements.",
      "The free public feed is cacheable (public, max-age=300) and submittable to directories; the private feed stays scoped to one reader.",
    ],
    shots: [
      {
        alt: "Private podcast playing in a podcast app authenticated by a token-in-path feed URL",
        variant: "podcasts",
      },
      {
        alt: "Public free-only podcast feed ready for Apple Podcasts and Spotify directory submission",
        variant: "podcasts",
      },
      {
        alt: "iTunes-namespaced RSS channel metadata with cover art, author, and category",
        variant: "podcasts",
      },
    ],
  },
  {
    id: "control",
    number: "3.0",
    eyebrow: "Security & control",
    title: "Mint, rotate, revoke. Per subscriber.",
    subhead:
      "Access is a token you own. Rotate one subscriber without touching anyone else's URL, revoke instantly, and attach audio metadata to any campaign you've already written.",
    bullets: [
      "Mint a token per subscriber email; the admin response returns the raw secret once plus the ready-to-ship feed URL you can drop into a welcome email.",
      "Rotate by re-minting: the secret is replaced in place, the old URL stops working immediately, and every other subscriber's URL is untouched.",
      "Revoke sets revoked_at on the row — the next fetch returns 401 'feed revoked', and the row stays so the dashboard can show 'revoked' instead of 'never minted'. Re-minting clears the flag.",
      "Cross-tenant defence-in-depth: a token minted for one tenant's subscriber always 401s against another tenant's feed, even if the URL is copied — and the error never leaks which tenant the token belongs to.",
      "Audio episode metadata attaches to a campaign: audio URL, MIME type, byte length, duration in seconds, a public flag, and the required tier that gates access.",
      "Token management is gated behind an admin-scoped API key; the lookup endpoint is admin-only by design and is never exposed publicly, so the bearer-token model holds.",
    ],
    shots: [
      {
        alt: "Admin token management showing mint, rotate, and revoke actions for a subscriber",
        variant: "podcasts",
      },
      {
        alt: "Campaign editor with podcast audio metadata: audio URL, duration, public flag, and required tier",
        variant: "podcasts",
      },
      {
        alt: "Revoked subscriber token row showing a revoked-at timestamp in the dashboard",
        variant: "podcasts",
      },
    ],
  },
];

export default function PodcastsPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Private podcasts for paid newsletters.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            A personal, tokenized feed for every subscriber. Tier-gated episodes
            only active paid subs can hear. No second tool.
          </p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6">
        {/* On-page section nav (MKTN-017) */}
        <div className="sticky top-14 z-30 -mx-6 border-b border-pw-ink2/10 bg-pw-paper/90 px-6 py-3 backdrop-blur">
          <SectionNav
            ariaLabel="Jump to a section"
            items={[
              { id: "private-feed", label: "Private feed" },
              { id: "open-access", label: "Open Access" },
              { id: "control", label: "Security & control" },
            ]}
          />
        </div>
        {SECTIONS.map((s) => (
          <section
            key={s.id}
            id={s.id}
            className="py-24 md:py-32 border-b border-pw-ink2/10 scroll-mt-20"
          >
            <div className="flex items-baseline gap-3 mb-6">
              <span className="font-mono text-sm text-pw-ember-600 tabular-nums">
                {s.number}
              </span>
              <span className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
                {s.eyebrow}
              </span>
            </div>
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-pw-ink2 leading-tight max-w-3xl">
              {s.title}
            </h2>
            <p className="mt-5 text-base md:text-lg text-pw-muted-on-paper max-w-3xl leading-relaxed">
              {s.subhead}
            </p>

            <ul className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 text-sm text-pw-ink2/80">
              {s.bullets.map((b) => (
                <li key={b} className="flex min-w-0 items-start gap-2">
                  <span aria-hidden className="text-pw-ember-600 leading-6">
                    ✓
                  </span>
                  <span className="min-w-0 break-words leading-relaxed [overflow-wrap:anywhere]">
                    {b}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
              {s.shots.map((shot, i) => (
                <ProductShot
                  key={shot.alt}
                  alt={shot.alt}
                  variant={shot.variant}
                  view={(["trend", "list", "grid"] as const)[i % 3]}
                />
              ))}
            </div>
          </section>
        ))}

        {/* FAQ */}
        <section
          aria-labelledby="faq-heading"
          className="py-20 border-t border-pw-ink2/10"
        >
          <h2
            id="faq-heading"
            className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
          >
            Frequently asked about private podcasts
          </h2>
          <div className="mt-8 space-y-3">
            {FAQ.map((item) => (
              <details
                key={item.question}
                className="group rounded-lg border border-pw-ink2/10 bg-pw-paper px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-start justify-between gap-4 list-none">
                  <h3 className="text-sm font-medium text-pw-ink2">
                    {item.question}
                  </h3>
                  <span
                    aria-hidden
                    className="font-mono text-pw-muted-on-paper/70 text-sm shrink-0 group-open:rotate-45 transition-transform motion-reduce:transition-none"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 break-words text-sm leading-relaxed text-pw-muted-on-paper [overflow-wrap:anywhere]">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* Closer CTA */}
        <section className="text-center border-t border-pw-ink2/10 py-20">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Give your paid list a feed they can’t share.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Evaluate tokenized feed and access-control behavior only against an
            approved release candidate. This page does not promise paid-audio
            availability, migration coverage, or refund rights.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/migrations"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              Migrate your paid list →
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              View pricing
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
