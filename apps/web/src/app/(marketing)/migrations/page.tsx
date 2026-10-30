// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "newsletter migration", "migrate Mailchimp to ...",
// "migrate Substack to ...", "newsletter platform migration tool". AIO target:
// "how to migrate a newsletter without losing data".
import type { Metadata } from "next";
import Link from "next/link";

import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const PAGE_URL = "https://moosewave.com/migrations";
const PAGE_DESCRIPTION =
  "Plan and run a verified migration to Moosewave. Supported paths cover ActiveCampaign, HubSpot, Mailchimp, Kit/ConvertKit, Brevo, Sendy CSV exports, CSV, and source-bound paid-reader imports; assisted beta paths cover Substack, Beehiiv, and MailerLite pending account validation. Substack and Beehiiv tier metadata does not move live billing.";

export const metadata: Metadata = {
  title: "Newsletter migrations with dry-run verification | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave migrations with dry-run verification",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/migrations/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave migration adapters for newsletter and CRM platforms",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave migrations with dry-run verification",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "Which newsletter platforms can Moosewave migrate from?",
    answer:
      "Production-supported paths today are ActiveCampaign API-token plus account-URL import, HubSpot private-app-token CRM bridge, Mailchimp OAuth, Kit/ConvertKit OAuth (including its declared Stripe-backed paid-reader path), Brevo API key, Sendy CSV export import, and CSV fallback. Substack, Beehiiv, and MailerLite are available as assisted migrations that require a dry-run report before commit; Substack and Beehiiv tier metadata does not move live billing. The migration report calls out consent, suppression, custom-field, segment, automation/rebuild inventory, CRM/SMS inventory, and billing fidelity separately instead of hiding partial coverage.",
  },
  {
    question: "How long does a typical newsletter migration take?",
    answer:
      "Small accounts can finish quickly, but the safe planning number is one focused setup session plus the import job. Timing depends on API limits, history depth, paid-reader mapping, and whether automations need manual review. Jobs are idempotent and resumable so a network blip does not double-import records.",
  },
  {
    question:
      "Will Moosewave preserve my consent records and suppression list?",
    answer:
      "Yes when the source exposes them. Subscribers are imported with available consent timestamps, provenance, and suppression status preserved, never silently re-confirmed. The suppression list (unsubscribes, bounces, complaints) is imported and enforced at the engine level, so you can't accidentally re-mail a complainer. This is the difference between a real migration and a CSV import that calls itself a migration.",
  },
  {
    question: "What if the migration goes wrong?",
    answer:
      "You see a dry-run verification report before any data is written, with data-fidelity percentage, custom-field mapping, automation translation or rebuild-review map, and a per-resource warnings list. You only commit if the diff looks right. After commit, you have a 7-day rollback window where one click reverts your Moosewave workspace to pre-import state. We don't touch your source platform, you cut over at your own pace.",
  },
  {
    question: "Do I have to pay before migrating?",
    answer:
      "No. Run a dry-run review showing exactly what would import, what would be skipped, and what needs manual mapping. The dry-run includes data-fidelity scoring and per-resource warnings; you make the buy decision after you see the report.",
  },
  {
    question: "What happens to my paid newsletter subscribers?",
    answer:
      "Stripe-backed paid readers can be mapped without re-billing when the source account exposes the needed Stripe customer and subscription identifiers. The dry-run separates direct Stripe compatibility from platform-specific export limits so you know whether the transition can be automated or needs concierge handling.",
  },
];

const HOW_TO_JSON_LD: JsonLdObject = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "How to migrate your newsletter to Moosewave",
  description:
    "Move subscribers, consent records, suppression lists, automations, and paid Stripe subscriptions from supported newsletter platforms to Moosewave with a dry-run verification report before commit.",
  totalTime: "PT1H",
  supply: [
    {
      "@type": "HowToSupply",
      name: "Source platform credentials (OAuth, API key, or API token)",
    },
    {
      "@type": "HowToSupply",
      name: "Stripe Connect account (only for paid subscriptions)",
    },
    {
      "@type": "HowToSupply",
      name: "DNS access for sender authentication (SPF/DKIM/DMARC)",
    },
  ],
  step: [
    {
      "@type": "HowToStep",
      position: 1,
      name: "Connect your source platform",
      text: "Pick your current platform inside Moosewave and complete the OAuth handshake (Mailchimp, ConvertKit), paste the API token plus account API URL (ActiveCampaign), paste a private app token (HubSpot), paste an API key (Brevo, Beehiiv, MailerLite), or upload a CSV (Substack, Sendy, generic). Moosewave stores credentials encrypted with KMS envelope encryption.",
    },
    {
      "@type": "HowToStep",
      position: 2,
      name: "Run discovery",
      text: "Moosewave snapshots subscribers, automation or rebuild inventory, audiences, and the campaign archive in about 60 seconds. Nothing is written to your Moosewave workspace yet.",
    },
    {
      "@type": "HowToStep",
      position: 3,
      name: "Review the dry-run verification report",
      text: "See the data-fidelity score, custom-field mappings, automations Moosewave can faithfully migrate vs flag, segment translation results, and a per-resource warnings list. Decide whether to proceed before any data is written.",
    },
    {
      "@type": "HowToStep",
      position: 4,
      name: "Commit the import",
      text: "Moosewave imports subscribers with available consent evidence, tags, segments translated to Postgres DSL, automations translated where supported or preserved for rebuild review, suppression lists, and the campaign archive as read-only history. Idempotent and resumable.",
    },
    {
      "@type": "HowToStep",
      position: 5,
      name: "Verify with Inbox Reality and cut over",
      text: "Authenticate your sending domain via the in-product DNS wizard, then, when controlled testing is enabled, run an Inbox Reality test send and review observations from the active seed roster. You have a 7-day rollback window after commit.",
    },
  ],
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Migrations", url: PAGE_URL },
]);

const SOURCES = [
  {
    slug: "mailchimp",
    name: "Mailchimp",
    note: "OAuth. Subscribers, segments, automations, audiences, consent timestamps. Suppression list preserved.",
  },
  {
    slug: "activecampaign",
    name: "ActiveCampaign",
    note: "API token plus account API URL. Contacts, lists/tags, campaign archive, CRM/SMS inventory, and automation rebuild evidence.",
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    note: "Private app token. CRM contact bridge with lifecycle fields, contact properties, and exact list-membership tags.",
  },
  {
    slug: "substack",
    name: "Substack",
    note: "Assisted beta. CSV/export-based subscribers, archive, and Stripe mapping where source data is complete.",
  },
  {
    slug: "beehiiv",
    name: "Beehiiv",
    note: "Assisted beta. API-key discovery with dry-run warnings for referrals, automations, and custom fields.",
  },
  {
    slug: "convertkit",
    name: "ConvertKit",
    note: "OAuth. Subscribers, tags, sequences with their emails, and custom fields. Visual Automations, forms, and landing pages are counted for rebuild, not imported.",
  },
  {
    slug: "mailerlite",
    name: "MailerLite",
    note: "Assisted beta. Subscriber status, custom fields, and group tags import; saved segments, automations, forms, templates, sites, and commerce dependencies require rebuild review.",
  },
  {
    slug: "sendy",
    name: "Sendy CSV",
    note: "CSV export path. Subscribers and status fields import with Sendy provenance; segments and campaigns are flagged for rebuild.",
  },
];

const COMPARE_ROWS = [
  { feature: "Subscribers", moosewave: true, others: true },
  { feature: "Consent timestamps preserved", moosewave: true, others: false },
  { feature: "Suppression list preserved", moosewave: true, others: false },
  { feature: "Custom fields auto-mapped", moosewave: true, others: false },
  {
    feature: "Automations translated or rebuild-gated",
    moosewave: true,
    others: false,
  },
  {
    feature: "Substack tier metadata + explicit billing handoff gate",
    moosewave: true,
    others: false,
  },
  { feature: "Dry-run before commit", moosewave: true, others: false },
  { feature: "Rollback within 7 days", moosewave: true, others: false },
  {
    feature: "Per-resource warnings before commit",
    moosewave: true,
    others: false,
  },
];

export default function MigrationsLandingPage() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-16 space-y-20">
      <JsonLd
        data={[HOW_TO_JSON_LD, BREADCRUMBS_JSON_LD, faqPageSchema(FAQ)]}
      />
      <header className="text-center space-y-4 max-w-3xl mx-auto">
        <h1 className="text-3xl md:text-5xl font-semibold tracking-tight">
          Move with a dry-run first.
        </h1>
        <p className="text-lg text-pw-muted-on-paper">
          Subscribers, consent records, suppression lists, automations, and
          paid-reader metadata and billing boundaries are checked before
          anything is committed. Production paths are explicit; assisted-beta
          paths show warnings before you make the switch.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <Button asChild size="lg">
            <Link href="/signup">Start a migration</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing">See pricing</Link>
          </Button>
        </div>
      </header>

      <section>
        <h2 className="text-xl font-semibold tracking-tight mb-6">
          Pick your current platform.
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {SOURCES.map((s) => (
            <Link key={s.slug} href={`/migrations/${s.slug}`} className="block">
              <Card className="h-full hover:border-pw-ember-500/60 transition-colors">
                <CardHeader>
                  <CardTitle className="text-lg">{s.name}</CardTitle>
                  <CardDescription>{s.note}</CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-pw-muted-on-paper">
                  Read the {s.name} migration guide →
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-y bg-pw-surface rounded-md">
        <div className="p-8">
          <h2 className="text-xl font-semibold tracking-tight mb-4">
            Detailed feature comparison.
          </h2>
          <p className="text-sm text-pw-muted-on-paper mb-6 max-w-2xl">
            Most migration tools transfer email addresses and call it done.
            Moosewave moves the things that actually matter for compliance and
            for not breaking your existing flows.
          </p>
          <div className="border rounded-md bg-pw-paper overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-pw-surface text-pw-muted-on-paper">
                <tr>
                  <th scope="col" className="text-left px-4 py-3 font-medium">
                    Feature
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Moosewave
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Generic CSV import
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.feature} className="border-t border-pw-line">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      {row.feature}
                    </th>
                    <td className="px-4 py-3 text-center text-pw-ember-600">
                      <span aria-hidden>{row.moosewave ? "✓" : "·"}</span>
                      <span className="sr-only">
                        {row.moosewave ? "Supported" : "Not supported"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-pw-muted-on-paper">
                      <span aria-hidden>{row.others ? "✓" : "·"}</span>
                      <span className="sr-only">
                        {row.others ? "Supported" : "Not supported"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="faq-heading">
        <h2
          id="faq-heading"
          className="text-2xl md:text-3xl font-semibold tracking-tight mb-6"
        >
          Frequently asked about migrations
        </h2>
        <div className="space-y-3">
          {FAQ.map((item) => (
            <details
              key={item.question}
              className="group rounded-lg border bg-pw-paper px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex cursor-pointer items-start justify-between gap-4 list-none">
                <h3 className="text-sm font-medium m-0">{item.question}</h3>
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
    </div>
  );
}
