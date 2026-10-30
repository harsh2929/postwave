// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "visual automation builder", "email marketing flow builder",
// "behavioral email triggers", "win-back automation", "churn prediction email".
// Primary intent is the operator evaluating Moosewave's automations against
// Klaviyo / Mailchimp Customer Journeys / ConvertKit visual automations.
import type { Metadata } from "next";
import Link from "next/link";

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
import { MCP_RELEASE_HOLD_CODE } from "@/lib/mcp-release-status";
import {
  RETENTION_WINBACK_RELEASE_HOLD_CODE,
  RETENTION_WINBACK_RELEASE_VERDICT,
} from "@/lib/retention-winback-release-status";

const PAGE_URL = "https://moosewave.com/automations";
const PAGE_DESCRIPTION =
  "Visual flow authoring for durable typed definitions: create, validate, version, and publish configuration. Enrollment, scheduling, trigger execution, delivery, and automatic promotion remain release-held.";

export const metadata: Metadata = {
  title: "Automations: visual flow builder, triggers, retention | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave automations: visual flow builder, triggers, retention",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/automations/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave automations overview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave automations: visual flow builder, triggers, retention",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "Is the visual automation builder available now?",
    answer:
      "Flow authoring is available; flow execution is not. You can create, edit, validate, version, and publish a stored graph of send, wait, branch, and tag definitions. In this deployment no subscriber is enrolled, no trigger fires, no node is scheduled or executed, and no message is delivered from that graph. Published means stored configuration, not a live automation.",
  },
  {
    question: "What kinds of triggers can start a flow?",
    answer:
      "The builder can store definitions for opens, clicks, page visits, inactivity, list or tag changes, custom events, inbound webhooks, replies, profile dates, and manual entry. Their configuration fields are validated and retained, but none starts a flow in this deployment. Manual subscriber enrollment is also unavailable while the execution runtime is release-held.",
  },
  {
    question: "How precise are wait and delay steps?",
    answer:
      "A wait definition stores a bounded duration in seconds, and the editor can validate that configuration. It does not currently hold or advance a subscriber because enrollment and scheduling are unavailable. Recipient-timezone campaign sending is a separate campaign capability and is not evidence that a flow wait executed.",
  },
  {
    question: "How does Moosewave decide who gets a win-back?",
    answer: `Churn-risk projections can be stored for subscribers, and workspace owners or admins can review the stored threshold, scoring coverage, offer rows, and aggregate funnel counters. Automated outbound win-back dispatch is ${RETENTION_WINBACK_RELEASE_VERDICT} under ${RETENTION_WINBACK_RELEASE_HOLD_CODE}; no mounted worker currently selects or sends a win-back, and the stored evidence does not prove presentation, acceptance, or coupon application.`,
  },
  {
    question: "Can I prove an automation actually caused the result?",
    answer:
      "No automation execution claim can be made in this deployment because flows do not enroll or run. Separately, campaign holdout and tenant control-group reports can compare treated and withheld campaign engagement. Those campaign reports do not prove that a stored flow definition executed or caused an outcome.",
  },
  {
    question: "What's the relationship between the builder and the runtime?",
    answer: `The builder stores a durable typed AST through the documented REST configuration boundary, but no mounted runner consumes it in this deployment. Publication changes stored version state only; activation, trigger polling, enrollment, scheduling, node effects, delivery, and automatic A/B promotion remain release-held. The repository MCP catalogue contains automation adapter candidates, but ${MCP_RELEASE_HOLD_CODE} means they are not a published or hosted callable surface. Migrated definitions may open in the canvas for review; they do not become executable automations.`,
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Automations", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Automations",
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
  id: "flow-builder" | "triggers" | "lifecycle";
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "flow-builder",
    number: "1.0",
    eyebrow: "Flow builder",
    title: "Draw and validate a stored flow definition.",
    subhead:
      "Build a configuration graph of send and wait nodes, conditional splits, tag actions, edges, and trigger definitions. The typed AST is durable and reviewable, but no mounted runtime enrolls subscribers or executes the graph in this deployment.",
    bullets: [
      "Definition types in the catalog: send email, time delay (wait), conditional split (branch), and profile/list actions — add-tag, remove-tag, move-to-list, unsubscribe.",
      "A branch is an if/then/else split with explicit true_next and false_next edges, so every condition has two named exits and there is no implicit fall-through.",
      "Wait definitions store a duration in seconds plus an optional optimized-delay preference; neither schedules subscriber work while execution is held.",
      "Tag-action definitions name intended profile/list effects; saving them does not mutate the subscriber-tag store.",
      "Flows are versioned and durable: save a draft, snapshot versions, and promote one to published configuration. Publication is not activation.",
      "Validation checks graph shape and catalog support — unsupported or planned-only definitions, dangling edges, and duplicate node IDs — but a valid graph still does not run.",
      "The validator returns a per-node definition-support report plus warnings so configuration gaps are visible before review.",
      "Source-supported migration definitions can open in the canvas for review. Mailchimp Customer Journeys and non-translatable sources remain rebuild evidence; no imported definition is activated by this surface.",
    ],
    shots: [
      {
        alt: "Visual flow builder canvas with trigger, send, wait, and branch nodes connected by edges",
        variant: "automations",
      },
      {
        alt: "Branch node configuration showing a true-next and false-next split",
        variant: "automations",
      },
      {
        alt: "Flow validation report with supported, planned, and unsupported node counts",
        variant: "automations",
      },
    ],
  },
  {
    id: "triggers",
    number: "2.0",
    eyebrow: "Triggers",
    title: "Define future entry conditions without implying they fire.",
    subhead:
      "The configuration model records behavioral, list, tag, date-field, custom-event, webhook, reply, and manual trigger definitions. Trigger evaluation and subscriber enrollment remain release-held.",
    bullets: [
      "Behavioral triggers: campaign opened or not opened, link clicked or not clicked, page visited, and no-activity — each with its own knobs (campaign_id, url_pattern, within_days / after_days).",
      "Lifecycle and list triggers: joined a list, entered a segment, a tag was added or removed.",
      "Time- and date-based triggers: a profile date field (e.g. N days before a subscription renews) with a configurable day offset.",
      "Custom-event and inbound-webhook definitions can be stored, but incoming events do not start these flows.",
      "Email-reply trigger definitions are configuration only; replies do not advance a stored graph.",
      "Manual-trigger definitions can be authored, but manual subscriber enrollment and one-off flow sends are unavailable.",
      "Catalog status describes definition support, not evidence of a running trigger or subscriber journey.",
      "Trigger definitions are configurable through the REST API. The execution endpoints and similarly named MCP source definitions are not available runtime surfaces.",
    ],
    shots: [
      {
        alt: "Trigger picker showing behavioral, list, date-field, custom-event, and manual trigger types",
        variant: "automations",
      },
      {
        alt: "Behavioral trigger config for campaign-not-opened with an after-days field",
        variant: "automations",
      },
      {
        alt: "Manual trigger definition shown in the flow configuration editor",
        variant: "automations",
      },
    ],
  },
  {
    id: "lifecycle",
    number: "3.0",
    eyebrow: "Lifecycle & retention",
    title: "Keep the subscribers you already earned.",
    subhead:
      "A per-subscriber lifecycle stage and score, churn projections, stored retention-offer settings and rows, aggregate funnel counters, resend-to-non-openers, recipient-timezone sending, and holdout groups.",
    bullets: [
      "Per-subscriber lifecycle stage (subscriber → lead → MQL → SQL → opportunity → customer → evangelist) with a 1–5 stage score, a stage-distribution histogram, and a logged event on every transition.",
      "Churn risk on every subscriber: the order-recency predictive model for commerce tenants, and an engagement-recency fallback (banded 0.10 → 0.95 by days since last open or click) so newsletter tenants get a real churn signal too.",
      "Ranked, human-readable churn drivers per profile (recency, order cadence, soft-bounce trend) — top three, highest impact first — so 'at risk' comes with a reason.",
      `Win-back evidence: owners and admins can review the stored churn threshold, scoring coverage, offer rows, and aggregate funnel counters. Automated outbound dispatch remains ${RETENTION_WINBACK_RELEASE_VERDICT} (${RETENTION_WINBACK_RELEASE_HOLD_CODE}).`,
      "Stored retention-offer rows can describe percent-off or fixed-amount-off coupons for a set number of months. Offer authoring, subscriber-portal acceptance, coupon application, and automated delivery are not mounted in this release.",
      "Resend to non-openers: clone a campaign to everyone who got it but never opened, supplying a fresh subject (it reuses the parent's if you omit one) and the send time you choose.",
      "Recipient-timezone scheduling can be stored as campaign planning data, but timezone-by-timezone release and recipient delivery are unavailable while campaign scheduling remains release-held.",
      "Holdout and control groups for incrementality: withhold 0–50% of an audience (deterministic per subscriber) and read the click-rate lift the send actually caused — per-campaign holdouts or a tenant-wide control cohort.",
    ],
    shots: [
      {
        alt: "Lifecycle pipeline widget showing subscriber counts across stages",
        variant: "analytics",
      },
      {
        alt: "Churn-risk profile card with ranked churn drivers and stored win-back configuration",
        variant: "automations",
      },
      {
        alt: "Holdout lift report comparing sent and held-out click rates with incremental lift",
        variant: "analytics",
      },
    ],
  },
];

export default function AutomationsPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Flow configuration with an explicit runtime hold.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Author, validate, version, and publish a typed graph of sends,
            waits, branches, tags, and trigger definitions. Enrollment,
            scheduling, execution, delivery, and automatic promotion remain
            release-held.
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
            Frequently asked about automations
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
            Author and review a flow definition.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            The editor provides durable graph configuration and validation.
            Production activation, enrollment, scheduling, node effects, and
            delivery are unavailable in this deployment.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/features"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              See all features →
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
