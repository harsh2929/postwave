// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "ecommerce email marketing", "Shopify email automation",
// "newsletter revenue attribution", "paid newsletter subscriptions Stripe". Primary
// intent is the store operator or paid-newsletter publisher evaluating Moosewave's
// commerce stack: store sync, conversion + revenue tracking, and read-only
// paid/gift subscription evidence.
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

const PAGE_URL = "https://moosewave.com/commerce";
const PAGE_DESCRIPTION =
  "Sync Shopify, BigCommerce, Adobe Commerce, PayPal, and Razorpay. Track campaign revenue, recommend products, and review read-only paid and identity-minimized gift-subscription history.";

export const metadata: Metadata = {
  title: "Commerce: store sync, revenue tracking, history | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave commerce: store sync, revenue, subscription history",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/commerce/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave commerce overview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave commerce: store sync, revenue, subscription history",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "Which stores and payment providers can Moosewave sync?",
    answer:
      "Moosewave connects Shopify (OAuth + GraphQL with bulk backfill), BigCommerce, Adobe Commerce (Magento 2), PayPal, and Razorpay, plus Stripe, Square, WooCommerce, Wix Stores, and Squarespace Commerce. Each integration does two things: a one-time bulk backfill of your existing catalog, customers, and orders, then real-time webhooks for everything that happens afterward. Shopify subscribes to orders/create, orders/paid, orders/cancelled, products/create, customers/create, and more; BigCommerce subscribes to store/order/created, store/order/refund/created, and the matching product and inventory topics. Every integration exposes its own sync health and cursor state so you can see exactly where a backfill is and whether a retry is due.",
  },
  {
    question: "How does Moosewave attribute revenue to a campaign?",
    answer:
      "A public, no-auth tracking endpoint (POST /api/public/track/conversion) records each conversion fact. It accepts both a 1×1 transparent GIF pixel for <img> placement and a JSON body for fetch()-driven uploads that carries amount_cents and properties. Attribution is last-touch: an explicit campaign_id query param always wins, otherwise Moosewave joins the conversion to the subscriber's most recent email click within a 7-day window, falling back to the pw_campaign cookie. Every conversion row records how it was attributed — explicit, last-touch, or none — so attribution is never presented as more certain than it is.",
  },
  {
    question: "Can Moosewave handle multiple currencies?",
    answer:
      "Yes, and it never lies about them. Every conversion stores amount_cents paired with an ISO-4217 currency, and tenants can mix currencies freely. Moosewave never sums across currencies. Each revenue figure in a report is denominated in a single dominant currency (the one with the most revenue in the window, ties broken by conversion count then alphabetically), and the full per-currency breakdown is disclosed alongside it. Unattributed revenue is reported explicitly as its own line, never silently dropped.",
  },
  {
    question: "Does Moosewave recommend products inside emails?",
    answer:
      "Yes. The compose-time recommendation endpoint (GET /api/v1/commerce/recommendations) ranks products for an anchor subscriber so you can preview a recommendation block against a real reader before scheduling. The compose-time ranker is deterministic — it scores by whether the subscriber has ordered the product, price-tier similarity to their average order, and a bounded popularity tie-breaker — and returns a per-product score plus a human-readable reason for a 'Why this product?' hover. Full personalization runs at send time via the product-feed resolver wired into email blocks.",
  },
  {
    question:
      "How do paid subscriptions work, and do existing subscribers get re-charged?",
    answer:
      "Paid-subscription mutations are not supported in this release. Moosewave exposes historical paid-commerce records for reporting, but it does not create, re-price, or mark Stripe subscriptions as changed until a verified provider adapter and reconciliation workflow are certified.",
  },
  {
    question:
      "What's the difference between a paid subscription and a gift subscription?",
    answer:
      "Moosewave currently treats paid subscription records and gift lifecycle data as historical reporting only. Gift history is bounded and identity-minimized: it omits purchaser and recipient identities, free-text messages, redemption material, tenant and subscriber identifiers, and provider identifiers or credentials. Purchase, payment-link creation, claim, cancellation, entitlement grant, and expiration automation remain unavailable until the provider lifecycle can be verified and reconciled end to end.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Commerce", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Commerce",
  description: PAGE_DESCRIPTION,
  brand: { "@type": "Brand", name: "Moosewave" },
  url: PAGE_URL,
  category: "Newsletter and email marketing platform",
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: "0",
    highPrice: "349",
    offerCount: "4",
    url: "https://moosewave.com/pricing",
  },
};

interface Screenshot {
  alt: string;
  variant: ProductShotVariant;
}

interface Section {
  id: string;
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "stores",
    number: "1.0",
    eyebrow: "Store sync",
    title: "Connect the store. Backfill the history. Stream the rest.",
    subhead:
      "Each integration does a one-time bulk backfill of your existing catalog, customers, and orders, then keeps up in real time over webhooks. Catalog, orders, and customers land in one canonical model, with per-integration sync health you can actually read.",
    bullets: [
      "First-class integrations for Shopify (OAuth + Admin GraphQL with a bulk-operation backfill), BigCommerce (REST backfill), Adobe Commerce / Magento 2 (token + REST backfill), PayPal (OAuth reporting + transaction-search backfill), and Razorpay (REST backfill) — plus Stripe, Square, WooCommerce, Wix Stores, and Squarespace Commerce.",
      "Catalog + product sync: products and prices land in a canonical commerce_products table that feeds the in-email recommendation block and the send-time product-feed resolver.",
      "Customer sync ties store customers to Moosewave subscribers by email, so an order can be attributed to a person and their traits recomputed.",
      "Order webhook events fire on every store change — Shopify subscribes to orders/create, orders/paid, orders/updated, orders/cancelled, orders/fulfilled, refunds/create, plus products and customers; BigCommerce to store/order/created, store/order/refund/created, and the matching product + inventory topics.",
      "Order events become commerce facts that automation can trigger on: an ingested order recomputes the subscriber's favorite-category and last-viewed-SKU traits out of band, after the ingesting transaction commits.",
      "Per-integration sync health + cursor state: every integration reports its sync mode (cursor backfill, async bulk operation, complete) and surfaces retry-due / next-attempt timing when a backfill needs another pass.",
      "Backfill workers are idempotent and resumable — a network blip mid-import resumes from the cursor instead of double-importing or losing progress.",
      "On disconnect, Moosewave stops the local integration, preserves audit evidence, and deletes provider webhooks or returns cleanup guidance where the connector supports it.",
    ],
    shots: [
      {
        alt: "Commerce integrations grid — Shopify, BigCommerce, Adobe Commerce, PayPal, Razorpay, Stripe, Square, WooCommerce",
        variant: "commerce",
      },
      {
        alt: "Integration sync health panel with backfill cursor state and retry-due timing",
        variant: "commerce",
      },
      {
        alt: "Order webhook event stream feeding subscriber traits and automation triggers",
        variant: "commerce",
      },
    ],
  },
  {
    id: "tracking",
    number: "2.0",
    eyebrow: "Conversion tracking",
    title: "One pixel. One JSON call. Honest attribution.",
    subhead:
      "Drop a 1×1 pixel or POST a JSON conversion. Moosewave records the fact, attributes it last-touch to a campaign, and never pretends the attribution is more certain than it is.",
    bullets: [
      "Public, no-auth tracking endpoint (POST /api/public/track/conversion) gated by a per-tenant tracking key you ship in your site's JS.",
      "Two shapes: a 43-byte transparent GIF89a pixel for <img src=…> placement (event-name only), and a JSON body for fetch()-driven uploads that carries amount_cents + properties.",
      "Last-touch attribution: an explicit campaign_id query param always wins; otherwise Moosewave joins the conversion to the subscriber's most recent email click within a 7-day look-back window, then falls back to the pw_campaign cookie.",
      "Every conversion row records how it was attributed — explicit, last-touch, or none — so the dashboard surfaces provenance instead of presenting a guess as a fact.",
      "Attributed conversions are mirrored into the existing campaign report-events pipeline, so revenue shows up in the digest cron, the campaign report, and the live SSE stream without a second integration.",
      "The conversion fact table is the source of truth; the analytics mirror is best-effort and instrumented, so you can tell when analytics drifts from reality.",
    ],
    shots: [
      {
        alt: "Conversion tracking setup showing the pixel tag and JSON track snippet",
        variant: "commerce",
      },
      {
        alt: "Conversion feed with per-row attributed-via provenance badges",
        variant: "commerce",
      },
    ],
  },
  {
    id: "revenue",
    number: "3.0",
    eyebrow: "Revenue",
    title: "Revenue per send. In every currency. Never summed wrong.",
    subhead:
      "Tie revenue back to the campaign that earned it. Mix currencies freely — Moosewave reports a dominant currency and discloses the full breakdown rather than adding dollars to euros.",
    bullets: [
      "Per-campaign revenue + ROI built on the conversions fact table: GET /api/v1/conversions/attribution/campaigns and a timeseries endpoint over a configurable window (default 90 days, max 365).",
      "Multi-currency by construction: amount_cents is paired with an ISO-4217 currency per row, tenants may mix currencies, and Moosewave never sums across them.",
      "Each monetary figure is denominated in a single dominant currency (most revenue in the window; ties broken by conversion count, then alphabetically), with the full per-currency breakdown disclosed alongside.",
      "Unattributed revenue is reported as its own explicit line (unattributed_cents + unattributed_conversions), never silently dropped into a total.",
      "Revenue-per-send uses true per-recipient send counts as the denominator, so the number means what an operator expects it to mean.",
      "Attribution is campaign-level and honest: conversions carry a campaign_id, and the API returns an explicit 'unsupported' code for sequence-level attribution rather than fabricating zeros.",
    ],
    shots: [
      {
        alt: "Revenue attribution dashboard with per-campaign revenue and dominant-currency disclosure",
        variant: "commerce",
      },
      {
        alt: "Per-currency revenue breakdown panel showing currencies never summed together",
        variant: "commerce",
      },
    ],
  },
  {
    id: "recommendations",
    number: "4.0",
    eyebrow: "Recommendations",
    title: "Recommend the right products. Preview against a real reader.",
    subhead:
      "A behavioral recommendation feed picks products for a specific subscriber, so you can preview the recommendation block against a real anchor before you schedule — then let full personalization run at send time.",
    bullets: [
      "Compose-time endpoint (GET /api/v1/commerce/recommendations?subscriber_id=X&limit=N) ranks products for an anchor subscriber so the operator previews the block against a real person.",
      "Deterministic ranking signal: +1.0 if the subscriber has ordered the product, +0.3 for price-tier similarity to their average order (within ±30%), and a bounded log-scaled popularity tie-breaker. Catalog recency is surfaced as a reason label rather than a score.",
      "Each result carries a numeric score and a human-readable reason, so the preview card can answer 'Why this product?' on hover.",
      "Graceful empty state: tenants with no connected store get a 'Connect a store' prompt instead of an error, and the ranker degrades cleanly when a subscriber has no order history.",
      "Full personalization runs at send time via the product-feed resolver already wired into email blocks — the compose-time feed is the fast, stable preview.",
    ],
    shots: [
      {
        alt: "In-email product recommendation block previewed against an anchor subscriber",
        variant: "commerce",
      },
      {
        alt: "Recommendation card with score and Why-this-product reason text",
        variant: "commerce",
      },
    ],
  },
  {
    id: "subscriptions",
    number: "5.0",
    eyebrow: "Historical subscription evidence",
    title: "Audit the lifecycle. Keep money movement off.",
    subhead:
      "Review existing paid-subscription evidence and bounded, identity-minimized gift lifecycle records. Moosewave does not create, re-price, claim, cancel, expire, or reconcile those records in this release.",
    bullets: [
      "Read-only by design: paid and gift subscription mutations are unavailable, and no local record is presented as proof that a provider-side payment, entitlement, delivery, or cancellation completed.",
      "Gift history is returned in bounded pages with aggregate lifecycle counts; operators can filter and sort normalized historical states or search by a generated record prefix.",
      "Each gift row exposes only a generated record label, an allowlisted plan label, duration, normalized status, lifecycle timestamps, and boolean evidence flags.",
      "Purchaser and recipient identities, free-text messages and reasons, tenant and subscriber identifiers, redemption tokens, and provider identifiers, links, or credentials stay outside the reporting projection.",
      "An evidence flag means only that a link was recorded locally. It does not claim live provider verification, payment reconciliation, entitlement grant, or message delivery.",
      "Gift purchase, payment-link creation, attribution, claim, cancellation, and expiration automation remain release-gated until the provider lifecycle is certified end to end.",
    ],
    shots: [
      {
        alt: "Read-only paid subscription history with provider status clearly marked as unverified",
        variant: "commerce",
      },
      {
        alt: "Identity-minimized gift lifecycle history with bounded status filters",
        variant: "commerce",
      },
      {
        alt: "Gift history privacy boundary showing excluded identity, token, and provider fields",
        variant: "commerce",
      },
    ],
  },
];

export default function CommercePage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Sell. Track it. Get paid.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Connect your store, attribute revenue back to the email that earned
            it, recommend the right products, and review historical subscription
            evidence. Paid and gift money movement stays disabled until provider
            reconciliation is certified.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 px-5 py-3 text-sm font-medium text-pw-paper shadow-[0_2px_0_0_#7A081B] transition-colors hover:bg-pw-ember-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              View pricing
            </Link>
            <Link
              href="/features"
              className="inline-flex items-center justify-center rounded-md border border-pw-line/30 px-5 py-3 text-sm font-medium text-pw-paper transition-colors hover:border-pw-line/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
            >
              See features
            </Link>
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6">
        {/* On-page section nav (MKTP-018) */}
        <div className="sticky top-14 z-30 -mx-6 border-b border-pw-ink2/10 bg-pw-paper/90 px-6 py-3 backdrop-blur">
          <SectionNav
            ariaLabel="Jump to a section"
            items={[
              { id: "stores", label: "Stores" },
              { id: "tracking", label: "Tracking" },
              { id: "revenue", label: "Revenue" },
              { id: "recommendations", label: "Recommendations" },
              { id: "subscriptions", label: "Subscriptions" },
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
                <li key={b} className="flex gap-2 items-start">
                  <span aria-hidden className="text-pw-ember-600 leading-6">
                    ✓
                  </span>
                  <span className="leading-relaxed">{b}</span>
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
            Frequently asked about commerce
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
                <p className="mt-3 text-sm text-pw-muted-on-paper leading-relaxed">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* Closer CTA */}
        <section className="text-center border-t border-pw-ink2/10 py-20">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Connect a store. Watch the revenue line up.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Inspect catalog, order, conversion, and attribution support against
            the exact release catalog. Live store activation remains gated on
            provider certification and an approved deployment.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/integrations"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              Connect your store →
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
