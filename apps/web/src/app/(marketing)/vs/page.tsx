// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "Moosewave vs", "best Mailchimp alternative", "Substack alternative",
// "newsletter platform comparison". This is the comparison-hub landing page.
import type { Metadata } from "next";
import Link from "next/link";

import { FaqAccordion } from "@/components/marketing/faq-accordion";
import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { publicSiteOrigin } from "@/lib/site-url";
import {
  SMS_RELEASE_HOLD_CODES,
  SMS_RELEASE_VERDICT,
} from "@/lib/sms-release-status";
import { asRoute } from "@/lib/typed-routes";

const SITE_URL = publicSiteOrigin();
const PAGE_URL = `${SITE_URL}/vs`;
const DESCRIPTION =
  "Compare Moosewave to Mailchimp, Substack, Beehiiv, ConvertKit, MailerLite, and Sendy. Honest, dimension-by-dimension breakdowns with current pricing and migration paths.";

export const metadata: Metadata = {
  title: "Moosewave vs the alternatives | Moosewave",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  // Consistent with the /vs layout noindex backstop and robots.txt: the
  // comparison surface renders but stays out of the index until the dated
  // third-party claims pass publication review (MKTC-008). The ItemList /
  // Breadcrumb / FAQ JSON-LD below now references URLs that return 200.
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave vs the alternatives",
    description: DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/vs/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave compared to six newsletter platforms",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave vs the alternatives",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

const COMPETITORS: Array<{
  slug: string;
  name: string;
  tagline: string;
  bestFit: string;
}> = [
  {
    slug: "mailchimp",
    name: "Mailchimp",
    tagline: "The original, now the most expensive per contact",
    bestFit: "Refugees from the Jan 2026 pricing changes",
  },
  {
    slug: "substack",
    name: "Substack",
    tagline: "10% of paid revenue, forever, in exchange for hosting",
    bestFit: "Paid newsletters earning > $500/mo",
  },
  {
    slug: "beehiiv",
    name: "Beehiiv",
    tagline: "Strong subscription SaaS with a built-in ad network",
    bestFit:
      "Writers who want explicit operating boundaries without an ad network",
  },
  {
    slug: "convertkit",
    name: "ConvertKit (Kit)",
    tagline: "Creator-favorite with a mature visual automation builder",
    bestFit: "Creators paying Creator / Creator Pro tier and feeling it",
  },
  {
    slug: "mailerlite",
    name: "MailerLite",
    tagline: "Gentlest of the per-subscriber pricers",
    bestFit: "MailerLite escapees scaling past 50K subs",
  },
  {
    slug: "sendy",
    name: "Sendy",
    tagline: "Dollar-cheapest, if you enjoy running servers",
    bestFit: "Sendy operators tired of weekend server admin",
  },
];

// Platform-breadth matrix. Moosewave shipped a broader platform than a pure
// newsletter tool (ad-audience sync, multi-platform commerce, SMS + push,
// a developer/agent platform), so we surface those as honest, dimension-by-
// dimension columns here on the hub. Values: "Yes" / "No" / "Partial" /
// "Roadmap". Competitor cells are verified against each vendor's current
// first-party docs (see the inline source note on each); a genuinely
// unverifiable cell would use a neutral "—" rather than assert.
//
// Moosewave self-assessment stays conservative on competitor facts. The visual
// editor ships as a typed configuration surface, but enrollment, scheduling,
// execution, and delivery do not; the matrix therefore marks it Partial.
type BreadthValue = "Yes" | "No" | "Partial" | "Roadmap" | "—";

const BREADTH_COLUMNS: Array<{ slug: string; short: string }> = [
  { slug: "moosewave", short: "Moosewave" },
  { slug: "mailchimp", short: "Mailchimp" },
  { slug: "substack", short: "Substack" },
  { slug: "beehiiv", short: "Beehiiv" },
  { slug: "convertkit", short: "Kit" },
  { slug: "mailerlite", short: "MailerLite" },
  { slug: "sendy", short: "Sendy" },
];

const BREADTH_ROWS: Array<{
  dimension: string;
  note: string;
  values: Record<string, BreadthValue>;
}> = [
  {
    dimension: "Ad-audience sync",
    note: "Push segments as custom audiences to Meta, Google Ads, TikTok, LinkedIn, and Snap.",
    values: {
      // Meta is live; Google Ads, TikTok, LinkedIn and Snap have delivery
      // foundations with live certification still gating promotion (see
      // /audiences). MailerLite is marked "Partial" for the same Meta-only
      // state, so "Yes" here would score us on a softer scale than the
      // competitors this table is comparing us against.
      moosewave: "Partial",
      mailchimp: "Partial", // Google/Meta retargeting + lookalikes, not the full five
      substack: "No",
      beehiiv: "Partial", // Meta Pixel + CSV only; custom-audience sync to ad platforms needs a 3rd-party tool
      convertkit: "Partial", // Facebook custom audience integration exists; broader coverage unverified
      mailerlite: "Partial", // native Meta Custom Audiences (paid plans) only; Google/TikTok/LinkedIn/Snap need a 3rd-party tool
      sendy: "No",
    },
  },
  {
    dimension: "Commerce integrations",
    note: "Native Shopify / WooCommerce / BigCommerce / Adobe Commerce / Wix / Square sync with product + order data.",
    values: {
      // All six connectors are RuntimePartial in the integration catalog, and
      // /commerce says live store activation is gated on provider
      // certification. Beehiiv and MailerLite are marked "Partial" here for
      // narrower coverage, so the same scale has to apply to us.
      moosewave: "Partial",
      mailchimp: "Yes",
      substack: "No",
      beehiiv: "Partial", // Shopify integration pushes checkout email only; no catalog/order data for segmentation
      convertkit: "Yes", // Shopify + commerce integrations
      mailerlite: "Partial", // Shopify/WooCommerce e-commerce integrations, narrower than the above
      sendy: "No",
    },
  },
  {
    dimension: "SMS",
    note: `Moosewave has bounded inbox and draft/evidence presentation only; hosted dispatch and A2P/provider effects are ${SMS_RELEASE_VERDICT} (${SMS_RELEASE_HOLD_CODES.broadcast}).`,
    values: {
      moosewave: "Partial",
      mailchimp: "Yes", // SMS Marketing add-on (US/CA/UK)
      substack: "No",
      beehiiv: "No",
      convertkit: "Partial", // SMS via a 3rd-party SlickText integration, not a native channel
      mailerlite: "No",
      sendy: "No",
    },
  },
  {
    dimension: "Push notifications",
    note: "Web / mobile push as a first-class channel alongside email.",
    values: {
      // Moosewave's push relays operational alerts (unsubscribe, spam
      // complaint, campaign sent, approval requested) to the marketer's own
      // first-party mobile app — see /sms, section "Operational alerts".
      // That is the same thing Mailchimp is marked "No" for on this row, so
      // crediting ourselves "Yes" would disqualify a competitor for exactly
      // the capability we claim.
      moosewave: "No",
      mailchimp: "No", // "push" is admin-app alerts to the marketer, not a customer-facing channel
      substack: "Partial", // app push for the Substack reader app, not a campaign push channel
      beehiiv: "Partial", // reader-app opt-in notifications only, not a marketer-controlled push channel
      convertkit: "No",
      mailerlite: "No",
      sendy: "No",
    },
  },
  {
    dimension: "Visual automation builder",
    note: "Drag-and-drop automation canvas. Moosewave supports typed flow authoring and validation; enrollment, scheduling, execution, and delivery are release-held.",
    values: {
      moosewave: "Partial", // visual typed configuration only; execution is held
      mailchimp: "Yes", // Customer Journeys
      substack: "No",
      beehiiv: "Yes", // Automations / journeys
      convertkit: "Yes", // mature visual automation builder
      mailerlite: "Yes", // visual workflow builder
      sendy: "No",
    },
  },
  {
    dimension: "Landing pages",
    note: "Hosted landing pages and signup/forms surfaces.",
    values: {
      // Hosted forms handle live capture today, but /landing-pages states the
      // block editor, custom domains, SEO controls and page metrics are still
      // being staged — so this is not the full builder the "Yes" columns have.
      moosewave: "Partial",
      mailchimp: "Yes",
      substack: "Partial", // publication/about pages, not a general landing-page builder
      beehiiv: "Yes",
      convertkit: "Yes",
      mailerlite: "Yes",
      sendy: "No",
    },
  },
  {
    dimension: "Developer / agent platform",
    note: "Public API and developer marketplace; MCP is a release-held source candidate with unsupported private evaluation only.",
    values: {
      moosewave: "Partial", // REST + webhooks + marketplace; MCP distribution is release-held
      mailchimp: "Partial", // mature REST API, but no MCP/agent surface
      substack: "No",
      beehiiv: "Partial", // API exists; no agent surface
      convertkit: "Partial", // API exists; no agent surface
      mailerlite: "Partial", // API exists; no agent surface
      sendy: "Partial", // self-hosted API; no agent surface
    },
  },
];

const ITEM_LIST_JSON_LD: JsonLdObject = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  itemListElement: COMPETITORS.map((c, idx) => ({
    "@type": "ListItem",
    position: idx + 1,
    url: `${SITE_URL}/vs/${c.slug}`,
    name: `Moosewave vs ${c.name}`,
  })),
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: SITE_URL },
  { name: "Compare", url: PAGE_URL },
]);

const FAQ: FaqEntry[] = [
  {
    question: "Why choose Moosewave over other newsletter platforms?",
    answer:
      "Moosewave combines finite monthly allowances, dry-run-first migrations that translate supported journey formats while preserving available consent and suppression evidence, explicit rebuild evidence for unsupported surfaces, controlled-inbox placement reporting from the active seed roster, and voice-trained AI sequence generation with a fidelity score. Checkout and controlled-inbox availability remain subject to the release status shown on their respective surfaces.",
  },
  {
    question:
      "Can I migrate from ActiveCampaign, HubSpot, Mailchimp, Substack, Beehiiv, ConvertKit, MailerLite, or Sendy?",
    answer:
      "Yes. ActiveCampaign uses an API token plus account API URL; HubSpot uses a private app token as a CRM bridge; Mailchimp and ConvertKit use OAuth; Beehiiv, Brevo, and MailerLite use API keys; Substack uses the official ZIP or subscriber CSV; Sendy is CSV. Every adapter runs a dry-run verification report before any data is written, preserves consent timestamps and suppression lists where the source exposes them, and gives you a rollback window after commit. Substack signup dates are provenance and active rows remain unconfirmed; paid tiers are metadata and Stripe/Apple billing requires a separate provider handoff. ActiveCampaign, Beehiiv, and MailerLite automation definitions are preserved as rebuild-review evidence instead of being activated as live Moosewave automations; MailerLite saved-segment predicates and rendered campaign HTML are not exposed by its documented read API. Beehiiv premium memberships remain metadata rather than Stripe billing objects. HubSpot remains the CRM system of record while source-event replay, final delta import, rollback rehearsal, and token cleanup evidence gate cutover.",
  },
  {
    question: "How long does a typical Moosewave migration take?",
    answer:
      "Plan on one focused setup session plus the import job. Timing depends on API limits, history depth, paid-reader mapping, and whether automations need rebuild review. Discovery and dry-run happen before commit, and idempotent/resumable jobs mean a network blip mid-import doesn't double-import or lose progress.",
  },
  {
    question: "Will switching break my paid subscriber relationships?",
    answer:
      "Billing continuity is source-specific and must be verified before cutover. Stripe-backed paths only map customers when the migration has a tenant-owned, source-bound Stripe connection. The current Beehiiv adapter preserves premium membership/tier metadata but does not migrate Stripe customers, products, prices, subscriptions, renewals, or billing ownership, so Beehiiv paid-reader continuity requires a separate reviewed handoff.",
  },
];

export default function ComparisonsIndexPage(): JSX.Element {
  return (
    <div>
      <JsonLd
        data={[ITEM_LIST_JSON_LD, BREADCRUMBS_JSON_LD, faqPageSchema(FAQ)]}
      />
      <section className="border-b border-pw-line">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <p className="text-xs uppercase tracking-widest text-pw-muted-on-paper">
            Comparisons
          </p>
          <h1 className="mt-3 text-4xl md:text-5xl font-semibold tracking-tight">
            Moosewave vs the alternatives
          </h1>
          <p className="mt-5 text-lg text-pw-muted-on-paper max-w-3xl leading-relaxed">
            Honest, dimension-by-dimension breakdowns. We use the competitor’s
            public pricing pages as the source of truth. We tell you when a
            competitor is a better fit. No FUD; no asterisks.
          </p>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {COMPETITORS.map((c) => (
            <Link
              key={c.slug}
              href={asRoute(`/vs/${c.slug}`)}
              className="block"
            >
              <Card className="h-full hover:border-foreground/30 transition-colors">
                <CardHeader>
                  <CardTitle>Moosewave vs {c.name}</CardTitle>
                  <CardDescription>{c.tagline}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-pw-muted-on-paper">
                    Best fit for switchers: {c.bestFit}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="breadth-heading"
        className="border-t border-pw-line bg-pw-surface"
      >
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2
            id="breadth-heading"
            className="text-2xl md:text-3xl font-semibold tracking-tight"
          >
            Platform breadth, side by side
          </h2>
          <p className="mt-2 text-pw-muted-on-paper max-w-2xl">
            Most of these tools started as a newsletter editor. Moosewave grew
            into a broader platform, ad-audience sync, commerce, SMS and push,
            and a developer surface. Here is the honest scorecard. Where we
            can&apos;t verify a competitor&apos;s capability we mark it
            &ldquo;&mdash;&rdquo; rather than guess.
          </p>
          <div
            role="region"
            aria-label="Capability comparison"
            tabIndex={0}
            className="mt-8 overflow-x-auto rounded-lg border bg-pw-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
          >
            <table className="w-full text-sm">
              <thead className="bg-pw-surface">
                <tr>
                  <th scope="col" className="text-left p-3 font-medium">
                    Capability
                  </th>
                  {BREADTH_COLUMNS.map((col) => (
                    <th
                      scope="col"
                      key={col.slug}
                      className="text-left p-3 font-medium"
                    >
                      {col.short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {BREADTH_ROWS.map((row) => (
                  <tr key={row.dimension} className="border-t align-top">
                    <td className="p-3">
                      <div className="font-medium">{row.dimension}</div>
                      <div className="mt-1 text-xs text-pw-muted-on-paper">
                        {row.note}
                      </div>
                    </td>
                    {BREADTH_COLUMNS.map((col) => (
                      <td
                        key={col.slug}
                        className="p-3 text-pw-muted-on-paper whitespace-nowrap"
                      >
                        {row.values[col.slug] ?? "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-pw-muted-on-paper">
            &ldquo;Roadmap&rdquo; means shipping but not yet generally
            available. Moosewave&apos;s visual flow editor ships as
            configuration only; activation, enrollment, scheduling, execution,
            and delivery remain release-held. Competitor capabilities reflect
            each provider&apos;s public docs; we update within 30 days of
            changes.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="faq-heading"
        className="max-w-3xl mx-auto px-6 pb-20"
      >
        <h2
          id="faq-heading"
          className="text-2xl md:text-3xl font-semibold tracking-tight"
        >
          Frequently asked about switching
        </h2>
        <div className="mt-8">
          <FaqAccordion items={FAQ} idPrefix="faq" />
        </div>
      </section>
    </div>
  );
}
