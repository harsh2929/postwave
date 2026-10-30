// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "newsletter platform features", "newsletter migration tool",
// "email deliverability AI", "voice-trained newsletter AI". Primary intent is the
// switcher evaluating Moosewave's three pillars in detail.
import type { Metadata } from "next";
import Link from "next/link";

import { BackToTop } from "@/components/marketing/back-to-top";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import {
  ProductShot,
  type ProductShotVariant,
} from "@/components/marketing/product-shot";
import { SectionNav } from "@/components/marketing/section-nav";
import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
} from "@/components/seo/json-ld";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_SOURCE_CANDIDATE_LABEL,
} from "@/lib/mcp-release-status";
import {
  SMS_RELEASE_HOLD_CODES,
  SMS_RELEASE_VERDICT,
} from "@/lib/sms-release-status";
import { asRoute } from "@/lib/typed-routes";

const PAGE_URL = "https://moosewave.com/features";
const PAGE_DESCRIPTION =
  "Three pillars in detail: verified migrations with dry-run reports, controlled-inbox placement with an AI diagnostician, and voice-trained AI sequences. Everything else is the engine.";

export const metadata: Metadata = {
  title: "Features: migration, deliverability, voice AI | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave features: migration, deliverability, voice AI",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/features/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave features overview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave features: migration, deliverability, voice AI",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "What does Moosewave do that other newsletter platforms don't?",
    answer:
      "Moosewave specialises in three things: dry-run-first migrations that preserve consent evidence, segments, and automation logic where the source supports safe translation, with rebuild evidence when it does not; controlled-inbox placement reporting from the active seed roster with an AI diagnostician that explains placement in plain English; and voice-trained AI sequence generation with a fidelity score. Core sending integrates a pinned upstream Listmonk service rather than claiming a proprietary fork.",
  },
  {
    question:
      "Does Moosewave's migration preserve consent and suppression data?",
    answer:
      "Yes when the source exposes it. Subscribers are imported with available consent timestamps, provenance, and suppression status preserved, never silently re-confirmed. The suppression list (unsubscribes, bounces, complaints) is imported and enforced at the engine level, so you can't accidentally re-mail a complainer. The dry-run verification report shows the diff — a data-fidelity score, the custom-field map, and a per-resource warnings list — before you commit, and a 7-day rollback window follows the commit.",
  },
  {
    question: "How does Inbox Reality measure deliverability?",
    answer:
      "When controlled inbox testing is enabled, Moosewave uses the deployment's configured active seed roster. The poller categorises completed observations as Primary, Promotions, Updates, or Spam and the report identifies exactly which providers responded. Reputation is monitored across configured reputation sources and DNSBLs. Authentication validation covers SPF, DKIM, DMARC, BIMI, and PTR. The Gemini-powered AI Diagnostician translates available evidence into plain-English fixes ranked by impact.",
  },
  {
    question: "Can Moosewave's Voice AI write in my actual voice?",
    answer:
      "Yes. The voice profile is built from up to six source types: imported newsletter archive, Twitter or X, blog RSS, podcast transcripts, LinkedIn, or pasted samples. The profile combines stylistic features, a vocabulary fingerprint, structural patterns, and a tonal vector. Each generated email gets a 0–100 fidelity score from embedding cosine similarity plus stylistic-feature distance plus vocabulary alignment plus structural fit. Anything below 60 is auto-regenerated before you ever see it. Paid plans include finite monthly AI-credit allowances shown on the pricing page.",
  },
  {
    question: "What automations does Moosewave support today?",
    answer:
      "Moosewave supports authoring, validating, versioning, and publishing typed flow definitions for triggers, branches, delays, and actions. This deployment does not activate those definitions or enroll, schedule, execute, or deliver subscriber journeys. Migration support is source-specific and produces stored review configuration or rebuild evidence, never automatic runtime activation.",
  },
  {
    question: "Is the Moosewave engine open source?",
    answer:
      "Moosewave application code is licensed AGPL-3.0-only. Reusable packages such as the migration library, MCP server, CLI, SDKs, and React components are MIT-licensed; trademarks and brand assets are licensed separately. Source availability does not currently promise a production-supported self-host package, escrow, continuity service, or shutdown support—only an executed order form can add those commitments.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Features", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave",
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

interface PillarSection {
  id: "migration" | "deliverability" | "voice-ai";
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: PillarSection[] = [
  {
    id: "migration",
    number: "1.0",
    eyebrow: "Migrate",
    title: "Move with a dry run first. Cut over with proof.",
    subhead:
      "We don't just transfer email addresses. We map subscribers, consent, segments, automation or rebuild inventory, paid subscriptions, suppression lists, and archive history into Moosewave's canonical model, then show you the diff before you commit.",
    bullets: [
      "Adapters for ActiveCampaign (API token), HubSpot (private app token CRM bridge), Mailchimp (OAuth), ConvertKit (OAuth), Substack (official ZIP/CSV with tier metadata and explicit billing handoff), Beehiiv (API), Brevo (API), MailerLite (API), and a universal CSV fallback.",
      "Subscribers imported with available consent evidence and suppression status preserved, not silently re-confirmed.",
      "Translates Mailchimp segment match-conditions to a canonical AST, then compiles to Postgres-native segmentation. Same for ConvertKit tags + segments.",
      "Automations translated where supported; ActiveCampaign and other rebuild surfaces are preserved with explicit warnings and review evidence instead of being silently activated.",
      "Supported Stripe evidence can be linked for migration reporting without creating charges or mutating subscriptions; live paid-commerce behavior remains release-gated.",
      "Suppression list (unsubs, bounces, complaints) imported and enforced at the engine level so you can't accidentally re-mail a complainer.",
      "Custom fields auto-mapped where shapes match; manual mapping UI for the rest. Archived campaigns imported as read-only history.",
      "Dry-run mode: full discover + translate, with a verification report showing data fidelity %, custom-field map, and a per-resource warnings list. You only commit if the diff looks right.",
      "Idempotent and resumable jobs: a network blip mid-import doesn't double-import or lose progress.",
      "7-day rollback window after commit, one click reverts the workspace to pre-import state.",
    ],
    shots: [
      {
        alt: "Migration source picker. ActiveCampaign, HubSpot, Mailchimp, ConvertKit, Substack, Beehiiv, Brevo, MailerLite, CSV",
        variant: "migration",
      },
      {
        alt: "Migration dry-run verification report with data-fidelity score and per-resource warnings",
        variant: "migration",
      },
      {
        alt: "Migration progress with per-resource progress bars and live counts",
        variant: "migration",
      },
    ],
  },
  {
    id: "deliverability",
    number: "2.0",
    eyebrow: "Inbox Reality",
    title: "Stop guessing. See where you landed.",
    subhead:
      "Controlled inbox testing reports observations from the deployment's active seed roster. Reputation, authentication, content, and an AI diagnostician explain available placement evidence and provide remediation guidance.",
    bullets: [
      "The report lists the active controlled mailboxes and providers that actually returned observations; the poller categorizes completed results as Primary / Promotions / Updates / Spam.",
      "Reputation monitoring across Google Postmaster Tools, Microsoft SNDS, Validity SenderScore, and a panel of DNSBLs (Spamhaus, SpamCop, Barracuda, SORBS, PSBL, and more).",
      "Authentication validation: SPF, DKIM, DMARC (with aggregate-report parsing for forensic reports), BIMI, and PTR.",
      "Content analysis layer: ML spam-trigger detection, image-to-text ratio, link reputation per-domain, subject-line scoring, and HTML quality (broken tags, inline-CSS coverage, image-without-alt count).",
      "AI Diagnostician. Gemini Pro, rubric-prompted, translates all four layers into a ranked list of plain-English fixes gated by a checked eval suite.",
      "Pre-Send Predictor: paste subject + HTML, get predicted placement before you ship. Gemini Flash can provide an optional second opinion when enabled.",
      "Remediation guidance for deterministic problems such as a missing DMARC record, misconfigured DKIM CNAME, BIMI without VMC, or sender-authentication mismatch.",
      "Full Inbox Reality reports are capped per calendar month: 5 on Launch, 25 on Growth, and 100 on Scale. Sandbox does not include production reports.",
      "Dedicated-IP inventory and warmup evidence may be reviewed, but managed provisioning and assignment are release-held.",
    ],
    shots: [
      {
        alt: "Inbox Reality dashboard, observed seedlist placement with primary, promotions, and spam breakdown",
        variant: "inbox",
      },
      {
        alt: "AI Diagnostician explaining a Promotions placement with a ranked list of fixes",
        variant: "inbox",
      },
      {
        alt: "Pre-send predictor showing predicted placement for a draft campaign",
        variant: "inbox",
      },
    ],
  },
  {
    id: "voice-ai",
    number: "3.0",
    eyebrow: "Voice AI",
    title: "Sequences in your voice. Not chatbot voice.",
    subhead:
      "Train once on what you've already written. Pick a template. Get a sequence that reads like you wrote it, with a per-email fidelity score that flags anything that doesn't.",
    bullets: [
      "Voice profile built from up to six source types: imported newsletter archive (from your migration), Twitter / X, blog RSS, podcast transcripts, LinkedIn, or pasted samples.",
      "Voice profile = stylistic features + vocabulary fingerprint + structural patterns + tonal vector + persona signals. Roughly 3KB of JSON plus 8K tokens of representative samples for few-shot prompting.",
      "50 launch templates across 13 categories: welcome series, course launch, product launch, re-engagement, newsletter series, SaaS onboarding, partnership announcements, year-in-review, crisis / apology, cold-warm transition, community, sales, and general-purpose.",
      "Per-email voice-fidelity score: embedding cosine similarity + stylistic-feature distance + vocabulary alignment + structural fit, returned as a 0–100 score with a sub-score breakdown.",
      "Generations under 60 are auto-flagged for regeneration before you see them, you don't get the bad outputs.",
      "Per-email regenerate with a hint textarea and four style sliders: humor, directness, length, formality.",
      "Each rewrite remains a review-only candidate until you explicitly accept it against the sequence version you reviewed.",
      "Variables auto-extracted from the template (product name, launch date, audience description) and rendered as a form so non-technical users can customize without touching prompts.",
      "AI use is finite and credit-metered each calendar month: 250 credits on Launch, 1,250 on Growth, and 5,000 on Scale. The workspace shows remaining credits before a metered action runs.",
      "We never train models on your subscriber data or your generated content. Voice profiles stay scoped to your workspace.",
    ],
    shots: [
      {
        alt: "Voice sequence editor showing a 7-email welcome sequence with per-email fidelity badges",
        variant: "voice",
      },
      {
        alt: "Voice profile page with stylistic feature chart and vocabulary tag cloud",
        variant: "voice",
      },
      {
        alt: "Template picker, filterable grid of 50 sequence templates",
        variant: "voice",
      },
    ],
  },
];

interface SecondaryFeature {
  title: string;
  body: string;
  /** Optional dedicated capability page. Renders the card as a link. */
  href?: string;
  /** Optional anchor target for the Product mega-menu (e.g. #editor). */
  id?: string;
}

const SECONDARY: SecondaryFeature[] = [
  {
    id: "editor",
    title: "Block + markdown editor",
    body: "Tiptap markdown for fast writers, GrapesJS + MJML for email-perfect blocks, sandboxed cross-client preview across 10 mailbox environments.",
  },
  {
    title: "Audiences & ad sync",
    body: "Consent-gated Meta audience sync, segments, identity aliases, cohorts, heat-map, and historical referral reporting. Referral operations remain held.",
    href: "/audiences",
  },
  {
    title: "Flow configuration",
    body: "A visual builder for durable typed definitions — triggers, branches, waits, and tag actions. Enrollment, execution, and delivery remain release-held.",
    href: "/automations",
  },
  {
    title: "Commerce",
    body: "Shopify, BigCommerce, Adobe Commerce, PayPal, and Razorpay. Conversion tracking, revenue attribution, and read-only paid and identity-minimized gift-subscription history.",
    href: "/commerce",
  },
  {
    title: `SMS source surfaces — ${SMS_RELEASE_VERDICT}`,
    body: `Tenant-bound draft, consent, suppression, and bounded inbox presentation exists. Hosted dispatch, A2P, callbacks, MMS, and financial evidence remain held (${SMS_RELEASE_HOLD_CODES.broadcast}, ${SMS_RELEASE_HOLD_CODES.a2p}).`,
    href: "/sms",
  },
  {
    title: "Forms",
    body: "Multi-step embeddable signup forms with custom fields, double opt-in, and five embed flavors — consent proof captured for you.",
    href: "/forms",
  },
  {
    title: "Landing pages",
    body: "Create landing-page records and reserve slugs; hosted forms remain the live capture path while the editor, domains, SEO, and metrics are staged.",
    href: "/landing-pages",
  },
  {
    title: "Analytics & goals",
    body: "Device, geography, and per-link reports, side-by-side campaign comparison, and goals with live ahead / on-track / behind pacing.",
    href: "/analytics",
  },
  {
    title: "Developer platform",
    body: `A marketplace, scoped API keys, and signed webhooks. MCP is a ${MCP_SOURCE_CANDIDATE_LABEL}; ${MCP_RELEASE_HOLD_CODE}.`,
    href: "/developers",
  },
  {
    id: "archive",
    title: "Archive & remix drafts",
    body: "A public, searchable newsletter archive plus deterministic template-based drafts for repurposing an issue. Reader comments and an LLM-backed remix service are not available in this release.",
  },
  {
    title: "Private podcasts",
    body: "Per-subscriber tokenized RSS with tier-gated episodes and Spotify Open Access for paid audio feeds.",
    href: "/podcasts",
  },
  {
    title: "Source licensing",
    body: "Moosewave application code is AGPL-3.0-only and reusable packages are MIT. A supported self-host distribution is still a qualification-roadmap item, not a current service promise.",
  },
  {
    title: "Audit log + GDPR export",
    body: "Per-tenant audit log, audit alerts, one-click GDPR Article 20 export, signed DPA on every plan, per-region data residency.",
    href: "/security",
  },
];

export default function FeaturesPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            The whole platform, in detail.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Migration, deliverability, and voice are the three hard parts —
            covered in depth below. Then the rest of the platform you actually
            run a newsletter business on.
          </p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6">
        {/* On-page section nav across the three pillars (MKTC-017). */}
        <div className="sticky top-14 z-30 -mx-6 border-b border-pw-ink2/10 bg-pw-paper/90 px-6 py-3 backdrop-blur">
          <SectionNav
            ariaLabel="Jump to a pillar"
            items={[
              { id: "migration", label: "Migrate" },
              { id: "deliverability", label: "Deliverability" },
              { id: "voice-ai", label: "Voice AI" },
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

        {/* The rest of the platform */}
        <section className="py-24">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            And the rest of the platform.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-2xl">
            Everything a working newsletter business runs on — built to the same
            standard as the three above, and yours to own.
          </p>
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {SECONDARY.map((f) => {
              const cardClass =
                "block h-full border border-pw-ink2/10 rounded-xl p-5 bg-pw-paper scroll-mt-20";
              const inner = (
                <>
                  <h3 className="font-semibold text-pw-ink2 m-0">
                    {f.title}
                    {f.href ? (
                      <span aria-hidden className="text-pw-ember-600">
                        {" "}
                        →
                      </span>
                    ) : null}
                  </h3>
                  <p className="mt-2 text-sm text-pw-muted-on-paper leading-relaxed">
                    {f.body}
                  </p>
                </>
              );
              return f.href ? (
                <Link
                  key={f.title}
                  id={f.id}
                  href={asRoute(f.href)}
                  className={`${cardClass} transition-colors hover:border-pw-ember-500`}
                >
                  {inner}
                </Link>
              ) : (
                <div key={f.title} id={f.id} className={cardClass}>
                  {inner}
                </div>
              );
            })}
          </div>
        </section>

        {/* FAQ */}
        <section
          aria-labelledby="faq-heading"
          className="py-20 border-t border-pw-ink2/10"
        >
          <h2
            id="faq-heading"
            className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
          >
            Frequently asked about features
          </h2>
          <div className="mt-8">
            <FaqAccordion items={FAQ} idPrefix="faq" />
          </div>
        </section>

        {/* Closer CTA */}
        <section className="text-center border-t border-pw-ink2/10 py-20">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Try the migration before you pay.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Connect an approved source in a sandbox and inspect the dry-run
            report before any commit. Paid checkout and refund terms remain
            unavailable until commercial and legal approval.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/migrations"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              Start a dry-run →
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
      <BackToTop />
    </div>
  );
}
