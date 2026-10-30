// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "Moosewave migration toolkit", "newsletter migration library",
// "open source newsletter migration", "Go migration adapter newsletter".

import type { Metadata } from "next";
import Link from "next/link";

import { CopyablePre } from "@/components/marketing/copyable-pre";
import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
  type JsonLdObject,
} from "@/components/seo/json-ld";

const PAGE_URL = "https://moosewave.com/migrate-anywhere";
const PAGE_DESCRIPTION =
  "The MIT-licensed Moosewave migration toolkit reads supported newsletter and CRM sources into a canonical newsletter schema. The renamed standalone distribution is Coming soon.";

export const metadata: Metadata = {
  title: "Moosewave open-source migration toolkit — Coming soon",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave open-source migration toolkit — Coming soon",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/migrate-anywhere/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave open-source migration toolkit",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave open-source migration toolkit — Coming soon",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "What does the Moosewave migration toolkit do?",
    answer:
      "It's an MIT-licensed Go module that reads source-supported subscribers, segments, automation definitions or rebuild evidence, paid-subscription records on explicitly supported source paths, archives, and consent/suppression provenance from major newsletter and CRM platforms (ActiveCampaign via API token, HubSpot via private app token, Mailchimp via OAuth, ConvertKit via OAuth, Klaviyo via API key, Customer.io via App API key, Substack via its official ZIP/CSV export, Beehiiv via API key, Brevo via API key, MailerLite via API key, Sendy and eight other platforms via their own CSV exports, and a generic CSV fallback) and normalises them into a canonical Go schema. It does not upgrade list membership into permission to send. Source-specific gaps remain explicit: Substack and Beehiiv preserve paid-tier metadata but no live Stripe/Apple billing objects; Beehiiv and MailerLite dynamic segment or automation behavior remains rebuild evidence; MailerLite's documented read API also omits rendered campaign HTML; ActiveCampaign has its own rebuild and consent/exclusion reviews; and HubSpot stays a CRM bridge. Use it locally to extract your data, ship it to your own destination, or contribute a new source platform.",
  },
  {
    question: "How is the Moosewave migration toolkit licensed?",
    answer:
      "The toolkit source is MIT-licensed. The renamed standalone Moosewave module and public repository are Coming soon; until then, this page does not present a legacy package namespace as a Moosewave install target.",
  },
  {
    question: "Which platforms does the migration library support?",
    answer:
      "Supported sources today: ActiveCampaign (API token + account URL — contacts, lists, tags, campaigns, automation definitions for rebuild review, CRM/custom-object inventory), HubSpot (private app token — portal-bound CRM contacts, exact identity/property/preference inventory, conservative current-primary-email eligibility, and frozen list/subscription tags), Mailchimp (OAuth 2.0 — selected audiences, subscribers, supported segments, the validated Classic welcome-series subset as paused runtime records, archive, and other workflow/Journey manual-review evidence), ConvertKit/Kit (OAuth 2.0), Substack (official ZIP/CSV — conservative subscriber snapshot, tier/status provenance, email-sent post archive, aggregate evidence, and explicit consent/billing/ecosystem gaps; no live billing migration), Beehiiv (API key — subscribers, frozen segment memberships, newsletter-list history, automation rebuild evidence, sent-post archive, and premium metadata; no Stripe billing migration), MailerLite (API token — subscribers, custom-field definitions and values, exact group tags, saved-segment/automation rebuild evidence, sent campaign/report/variant metadata, and draft/ready campaign/form/shop source evidence), Brevo (API key), Klaviyo (API key with the revision header — profiles, list and segment metadata, email plus SMS archive, and provider consent/suppression evidence), Customer.io (App API key, US or EU region — people, exact frozen segment and topic memberships, Design Studio templates, and sent email newsletters), Sendy (subscriber CSV export — subscribers only), Constant Contact, AWeber, Drip, Campaign Monitor, Omnisend, Loops, Flodesk and Bento (each via its own subscriber CSV export — subscribers only), and CSV universal (file upload — subscribers only). Ghost and Buttondown are open contribution targets.",
  },
  {
    question: "Can I use the toolkit without a Moosewave account?",
    answer:
      "Yes. The library is standalone: bring your own credentials for each source platform, instantiate an adapter, iterate the canonical types, and ship the data wherever you want. You don't need a Moosewave account, an API key, or a paid plan. If you do migrate to Moosewave Cloud, the same library powers a dry-run-first migration with a verification report and 7-day rollback wrapped around it.",
  },
  {
    question: "Does the toolkit preserve consent and suppression data?",
    answer:
      "It preserves the evidence each source actually exposes, without upgrading membership into permission to send. Mailchimp, ConvertKit, Brevo, MailerLite, and Klaviyo map provider-available consent/suppression evidence into canonical types. Beehiiv subscription creation, status, and membership are retained as provenance but remain unknown portable consent until reviewed separately. ActiveCampaign list status and subscription dates are provenance only: incomplete email-channel or exclusion evidence stays unconfirmed, while SMS evidence remains non-sendable archive material under the current HOLD / NO-GO. HubSpot contact creation/list membership is not consent; its bridge separately requires all active email definitions SUBSCRIBED, no scoped/wide opt-out, and no current-email bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restriction. That is conservative import eligibility, not exact HubSpot sendability parity. Customer.io exposes no consent timestamp at all. Substack, Sendy, the CSV-export sources, and generic CSV do not expose portable consent evidence through their standard import surfaces — a Substack export carries only a signup date, recorded as import provenance — so add reviewed email consent records before an eligible email send.",
  },
  {
    question: "How do I contribute a new source platform adapter?",
    answer:
      "The renamed public contribution repository is Coming soon. In the meantime, contact support@moosewave.com with the source platform and export/API surface you want to contribute.",
  },
];

const SOFTWARE_SOURCE_CODE_JSON_LD: JsonLdObject = {
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  name: "Moosewave migration toolkit",
  programmingLanguage: "Go",
  license: "https://opensource.org/licenses/MIT",
  codeRepository: PAGE_URL,
  description:
    "Open-source migration toolkit that reads from newsletter and CRM platforms into a canonical Go schema.",
};

const PRODUCT_JSON_LD: JsonLdObject = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Moosewave open-source migration toolkit",
  description: PAGE_DESCRIPTION,
  brand: { "@type": "Brand", name: "Moosewave" },
  url: PAGE_URL,
  category: "Open-source newsletter migration library",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/PreOrder",
    url: PAGE_URL,
    description: "Renamed standalone distribution Coming soon.",
  },
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Migrate Anywhere (OSS)", url: PAGE_URL },
]);

const STEPS: { num: string; title: string; body: string; code: string }[] = [
  {
    num: "1",
    title: "Install",
    body: "The renamed standalone Go module is Coming soon.",
    code: "Moosewave migration module — Coming soon",
  },
  {
    num: "2",
    title: "Authenticate",
    body: "Bring your own credentials. OAuth tokens for Mailchimp and ConvertKit, an API token for ActiveCampaign, a HubSpot private app token, API keys for Beehiiv, MailerLite, Brevo and Klaviyo, an App API key for Customer.io, file paths for Substack and every CSV-export source.",
    code: `creds := adapter.Credentials{
  AccessToken: os.Getenv("MAILCHIMP_OAUTH_TOKEN"),
  AccountID:   os.Getenv("MAILCHIMP_DC"),
}`,
  },
  {
    num: "3",
    title: "Read",
    body: "Iterate subscribers, segments, automations, and archives through a uniform interface.",
    code: `ad, _ := adapter.Get("mailchimp")
sess, _ := ad.Authenticate(ctx, creds)
subs, cursor, err := ad.ListSubscribers(ctx, sess, "")`,
  },
  {
    num: "4",
    title: "Use the canonical types",
    body: "Every adapter normalizes to the same shapes. Ship the data anywhere.",
    code: `for _, s := range subs {
  fmt.Println(s.Email, s.Status, s.ConsentTimestamp)
}`,
  },
];

interface CapabilityRow {
  source: string;
  auth: string;
  subscribers: boolean;
  segments: boolean;
  automations: boolean | "review";
  archive: boolean;
  paid: boolean;
  // What the Consent column means, so the cells stay decidable. The module has
  // no consent column of its own, and an undefined column is how three rows
  // drifted into contradicting the consent FAQ further down this page:
  //   true     the adapter maps provider-available consent/suppression
  //            evidence into canonical consent types
  //   "review" evidence arrives as provenance only and has to be reconciled
  //            before it can be treated as permission to send
  //   false    no portable consent evidence through the standard surface; a
  //            carried-over timestamp is a signup date, not permission
  consent: boolean | "review";
}

const CAPABILITIES: CapabilityRow[] = [
  {
    source: "ActiveCampaign",
    auth: "API token + URL",
    subscribers: true,
    segments: true,
    automations: "review",
    archive: true,
    paid: false,
    // Supports.ConsentTimestamps = false. List status and subscription dates
    // are provenance until channel and exclusion evidence is reconciled —
    // which is what the consent FAQ below has always said.
    consent: "review",
  },
  {
    source: "HubSpot",
    auth: "Private app token",
    subscribers: true,
    segments: true,
    automations: false,
    archive: false,
    paid: false,
    consent: false,
  },
  {
    source: "Mailchimp",
    auth: "OAuth 2.0",
    subscribers: true,
    segments: true,
    automations: true,
    archive: true,
    paid: false,
    consent: true,
  },
  {
    source: "ConvertKit / Kit",
    auth: "OAuth 2.0",
    subscribers: true,
    segments: true,
    automations: true,
    archive: true,
    // ListPaidSubs is implemented (Supports.PaidSubs = true): Commerce paid
    // relationships map through Stripe Connect.
    paid: true,
    consent: true,
  },
  {
    source: "Substack",
    auth: "Official ZIP or CSV",
    subscribers: true,
    segments: false,
    automations: false,
    archive: true,
    paid: false,
    // Signup date is namespaced provenance, never consent. Active membership
    // remains unconfirmed until reviewed destination permission exists.
    consent: false,
  },
  {
    source: "Beehiiv",
    auth: "API key",
    subscribers: true,
    segments: true,
    // Automation metadata is rebuild-review evidence and is never activated —
    // the same status ActiveCampaign carries in this table.
    automations: "review",
    archive: true,
    // Supports.PaidSubs = false. Premium membership metadata comes across;
    // Stripe customers, prices, subscriptions and renewals do not.
    paid: false,
    // Supports.ConsentTimestamps = false. Subscription creation, status, and
    // membership come across as provenance, not portable consent.
    consent: "review",
  },
  {
    source: "Brevo",
    auth: "API key",
    subscribers: true,
    segments: true,
    automations: "review",
    archive: true,
    paid: false,
    consent: true,
  },
  {
    source: "MailerLite",
    auth: "API key",
    subscribers: true,
    segments: true,
    automations: "review",
    archive: true,
    paid: false,
    consent: true,
  },
  {
    source: "Klaviyo",
    auth: "API key + revision",
    subscribers: true,
    segments: true,
    automations: "review",
    archive: true,
    paid: false,
    // Reads consent, consent_timestamp, suppression and list_suppressions.
    consent: true,
  },
  {
    source: "Customer.io",
    auth: "App API key (US/EU)",
    subscribers: true,
    segments: true,
    automations: "review",
    archive: true,
    paid: false,
    // Supports.ConsentTimestamps = false — no consent field is exposed.
    consent: false,
  },
  {
    source: "Sendy",
    auth: "CSV export",
    subscribers: true,
    segments: false,
    automations: false,
    archive: false,
    paid: false,
    consent: false,
  },
  {
    // One row for the eight adapters that share the exportcsv implementation,
    // matching how the module's own README groups them. They are registered
    // and shipping — this page previously listed AWeber as something still to
    // be contributed.
    source:
      "Constant Contact, AWeber, Drip, Campaign Monitor, Omnisend, Loops, Flodesk, Bento",
    auth: "CSV export",
    subscribers: true,
    segments: false,
    automations: false,
    archive: false,
    paid: false,
    consent: false,
  },
  {
    source: "CSV universal",
    auth: "File upload",
    subscribers: true,
    segments: false,
    automations: false,
    archive: false,
    paid: false,
    consent: false,
  },
];

// Accessible capability cell: the glyph is decorative and the yes/no/review
// meaning is exposed to assistive tech via sr-only text (MKTP-014).
function CapabilityCell({ value }: { value: boolean | "review" }): JSX.Element {
  if (value === "review") {
    return (
      <>
        <span aria-hidden>Review</span>
        <span className="sr-only">Review required</span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden>{value ? "✓" : "·"}</span>
      <span className="sr-only">{value ? "Supported" : "Not supported"}</span>
    </>
  );
}

export default function MigrateAnywherePage() {
  return (
    <div className="bg-pw-paper text-pw-ink2">
      <JsonLd
        data={[
          PRODUCT_JSON_LD,
          SOFTWARE_SOURCE_CODE_JSON_LD,
          BREADCRUMBS_JSON_LD,
          faqPageSchema(FAQ),
        ]}
      />

      <section className="bg-pw-ink text-pw-paper">
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <div className="text-xs uppercase tracking-widest text-pw-ember-300">
            Open source
          </div>
          <h1 className="mt-4 text-4xl md:text-6xl font-semibold tracking-tight">
            Migrate from anywhere.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-pw-muted-on-ink">
            MIT-licensed Go module. Read your data out of any newsletter
            platform into a canonical shape, then ship it where you want.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
			<Link
			  href="/docs"
			  className="rounded-md bg-pw-ember-500 px-5 py-3 font-medium text-pw-paper shadow-[0_2px_0_0_#7A081B] hover:bg-pw-ember-600"
			>
			  Renamed module — Coming soon
			</Link>
            <a
              href="#capabilities"
              className="rounded-md border border-pw-line/30 px-5 py-3 font-medium text-pw-paper hover:border-pw-line/60"
            >
              See what each adapter does
            </a>
          </div>
        </div>
      </section>

      <section className="border-t border-pw-line">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">
            Four steps from credentials to canonical data.
          </h2>
          <div className="mt-12 grid gap-10 md:grid-cols-2">
            {STEPS.map((step) => (
              <div key={step.num} className="min-w-0">
                <div className="text-5xl font-semibold tracking-tight text-pw-ember-500">
                  {step.num}
                </div>
                <h3 className="mt-3 text-xl font-semibold">{step.title}</h3>
                <p className="mt-2 text-pw-muted-on-paper">{step.body}</p>
                <CopyablePre
                  className="mt-4"
                  label={step.title}
                  value={step.code}
                  codeClassName="text-xs leading-relaxed"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="capabilities"
        className="border-t border-pw-line bg-pw-surface"
      >
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">
            Adapter capability matrix
          </h2>
          <p className="mt-3 text-pw-muted-on-paper">
            Supported sources, one canonical schema. Tags, segments,
            automations, and paid subscriptions translate to a shared AST where
            supported, with rebuild review called out separately.
          </p>
          <div
            role="region"
            aria-label="Adapter capability matrix"
            tabIndex={0}
            className="not-prose mt-10 overflow-x-auto rounded-lg border border-pw-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
          >
            <table className="min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-pw-line text-left text-pw-muted-on-paper">
                  <th scope="col" className="py-3 pr-4">
                    Source
                  </th>
                  <th scope="col" className="py-3 pr-4">
                    Auth
                  </th>
                  <th scope="col" className="py-3 pr-4">
                    Subs
                  </th>
                  <th scope="col" className="py-3 pr-4">
                    Segments
                  </th>
                  <th scope="col" className="py-3 pr-4">
                    Automations
                  </th>
                  <th scope="col" className="py-3 pr-4">
                    Archive
                  </th>
                  <th scope="col" className="py-3 pr-4">
                    Paid subs
                  </th>
                  <th scope="col" className="py-3">
                    Consent
                  </th>
                </tr>
              </thead>
              <tbody>
                {CAPABILITIES.map((row) => (
                  <tr key={row.source} className="border-b border-pw-line">
                    <th
                      scope="row"
                      className="py-3 pr-4 text-left font-medium text-pw-ink2"
                    >
                      {row.source}
                    </th>
                    <td className="py-3 pr-4 text-pw-muted-on-paper">
                      {row.auth}
                    </td>
                    <td className="py-3 pr-4">
                      <CapabilityCell value={row.subscribers} />
                    </td>
                    <td className="py-3 pr-4">
                      <CapabilityCell value={row.segments} />
                    </td>
                    <td className="py-3 pr-4">
                      <CapabilityCell value={row.automations} />
                    </td>
                    <td className="py-3 pr-4">
                      <CapabilityCell value={row.archive} />
                    </td>
                    <td className="py-3 pr-4">
                      <CapabilityCell value={row.paid} />
                    </td>
                    <td className="py-3">
                      <CapabilityCell value={row.consent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-t border-pw-line">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">
            Why open-source the adapters
          </h2>
          <p className="mt-6 text-pw-muted-on-paper">
            Migrating between newsletter platforms is a portability problem, not
            a competitive moat. The data was always yours; the adapter should be
            too.
          </p>
          <p className="mt-4 text-pw-muted-on-paper">
            We use this library inside Moosewave Cloud to power dry-run-first
            migration. By keeping it open, anyone can run the same migration
            locally, build their own destination, contribute new source
            platforms (Ghost, Buttondown), or audit what each adapter reads. The
            canonical schema is the standard worth holding open.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="faq-heading"
        className="border-t border-pw-line"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="faq-heading"
            className="text-2xl md:text-3xl font-semibold tracking-tight"
          >
            Frequently asked about the Moosewave migration toolkit
          </h2>
          <div className="mt-8 space-y-3">
            {FAQ.map((item) => (
              <details
                key={item.question}
                className="group rounded-lg border border-pw-line bg-pw-paper px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
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
        </div>
      </section>

      <section className="border-t border-pw-line bg-pw-ink text-pw-paper">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Or skip the local install.
          </h2>
          <p className="mt-3 text-pw-muted-on-ink">
            Moosewave Cloud handles end-to-end migration with a verification
            report and a 7-day rollback window.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/migrations"
              className="rounded-md bg-pw-ember-500 px-5 py-3 font-medium text-pw-paper shadow-[0_2px_0_0_#7A081B] hover:bg-pw-ember-600"
            >
              See Moosewave Cloud migration
            </Link>
            <Link
              href="/mcp"
              className="rounded-md border border-pw-line/30 px-5 py-3 font-medium text-pw-paper hover:border-pw-line/60"
            >
              Review MCP release hold
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
