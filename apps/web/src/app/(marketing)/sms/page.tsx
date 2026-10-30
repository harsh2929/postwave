// SPDX-License-Identifier: AGPL-3.0-only
//
// Public SMS source/presentation inventory. Keep hosted effects explicitly
// release-held until provider isolation, reconciliation, deployment, and
// independent acceptance evidence are promoted together.
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
import {
  SMS_PRESENTATION_SCOPE_COPY,
  SMS_RELEASE_HOLD_CODES,
  SMS_RELEASE_STATUS_COPY,
  SMS_RELEASE_VERDICT,
} from "@/lib/sms-release-status";

const PAGE_URL = "https://moosewave.com/sms";
const PAGE_DESCRIPTION =
  "SMS source, draft, consent, suppression, and bounded inbox presentation surfaces. Hosted dispatch, A2P registration, provider callbacks, MMS, and financial evidence are release-held.";

export const metadata: Metadata = {
  title: "SMS source surfaces — HOLD / NO-GO | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave SMS source surfaces — HOLD / NO-GO",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/sms/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave SMS source surfaces with hosted dispatch release-held",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave SMS source surfaces — HOLD / NO-GO",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "Can I connect a provider and send SMS from hosted Moosewave?",
    answer: `${SMS_RELEASE_VERDICT}. Provider and sender models exist in source for Twilio, Telnyx, and Bandwidth, but hosted customer credentials require a tenant-bound provider vault and ownership resolver. Live reply, test, campaign, and broadcast dispatch remain structurally held; do not configure customer traffic or process-global provider credentials.`,
  },
  {
    question: "What SMS records can the current surfaces show?",
    answer:
      "Authorized surfaces can present tenant-bound sender drafts, consent and suppression records, campaign or broadcast drafts, and bounded retained inbox records. A loaded page is not complete provider history or proof of delivery, cost, legal consent authority, or current readiness. System and carrier suppressions remain authoritative and locked.",
  },
  {
    question: "Can Moosewave submit or poll A2P 10DLC registration?",
    answer: `No. Sender and registration draft fields are source evidence, but submit and poll actions return ${SMS_RELEASE_HOLD_CODES.a2p}. Carrier registration and provider-side resources remain operator-owned and do not make hosted Moosewave ready to send.`,
  },
  {
    question: "Can I test, schedule, or broadcast SMS or MMS?",
    answer: `No. Draft modeling does not dispatch. Test sends return ${SMS_RELEASE_HOLD_CODES.test}; campaign and broadcast dispatch are held by ${SMS_RELEASE_HOLD_CODES.campaign} and ${SMS_RELEASE_HOLD_CODES.broadcast}; MMS readiness returns ${SMS_RELEASE_HOLD_CODES.mms}.`,
  },
  {
    question:
      "Are delivery, click, cost, and export reports production evidence?",
    answer: `No. Private campaign evidence projections remain ${SMS_RELEASE_HOLD_CODES.evidence}; tracked-click resolution is ${SMS_RELEASE_HOLD_CODES.clickResolver}; the authoritative financial ledger is ${SMS_RELEASE_HOLD_CODES.financial}. Source schemas and UI placeholders are not provider receipts or complete reports.`,
  },
  {
    question: "Does an operational mobile notification prove SMS delivery?",
    answer:
      "No. First-party operational notifications are a separate presentation plane. A notification or inbox badge is not a carrier receipt, proof that an automated compliance response was sent, or evidence that hosted SMS dispatch and provider callbacks are released.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "SMS", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — SMS source and presentation surfaces",
  description: PAGE_DESCRIPTION,
  brand: { "@type": "Brand", name: "Moosewave" },
  url: PAGE_URL,
  category: "SMS source and presentation software",
};

interface Screenshot {
  alt: string;
  variant: ProductShotVariant;
}

interface Section {
  id: "senders" | "consent" | "campaigns" | "push";
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "senders",
    number: "1.0",
    eyebrow: "Provider boundary",
    title: "Sender drafts exist. Hosted provider activation does not.",
    subhead: `${SMS_RELEASE_STATUS_COPY} ${SMS_RELEASE_HOLD_CODES.a2p} is the exact A2P boundary.`,
    bullets: [
      "Source models cover US/Canada sender drafts for Twilio, Telnyx, and Bandwidth; a configured-looking record is not verified provider ownership or readiness.",
      "Hosted provider credentials require tenant-bound vault resolution. Process-global credentials are not an acceptable customer-isolation boundary.",
      `A2P brand submit, campaign submit, and status polling are unavailable under ${SMS_RELEASE_HOLD_CODES.a2p}.`,
      `Hosted inbound/status callbacks are unavailable under ${SMS_RELEASE_HOLD_CODES.providerCallback}; checked-in routes are not deployment proof.`,
      "Provider-console applications, profiles, messaging services, number assignment, toll-free verification, and carrier approval remain external operator work.",
      "No setup, readiness, or certification view overrides the structural dispatch and callback holds.",
    ],
    shots: [
      {
        alt: "Illustrative SMS sender draft list; hosted activation is release-held",
        variant: "sms",
      },
      {
        alt: "Illustrative A2P draft status; submit and poll are release-held",
        variant: "sms",
      },
      {
        alt: "Illustrative SMS readiness blockers; not deployment certification",
        variant: "sms",
      },
    ],
  },
  {
    id: "consent",
    number: "2.0",
    eyebrow: "Recorded evidence",
    title:
      "Consent and suppression records are evidence, not permission to send.",
    subhead:
      "Authorized admin surfaces retain scoped consent and suppression records. Legal authority, identity ambiguity, reasonable revocation language, quiet-hour applicability, and carrier state still require exact evidence and review.",
    bullets: [
      "Eligible list evidence must be tenant-bound, timestamped, non-ambiguous, and tied to the exact US/Canada phone identity and purpose.",
      "STOP, carrier, and complaint suppressions are authoritative and non-reversible in Moosewave; only manual suppressions are manually removable.",
      "Free-form potential revocations need audited review. A badge alone is not complete consent authority.",
      "Quiet-hour configuration is retained policy input; it cannot certify a live provider send while dispatch is held.",
      `Custom and HELP outbound auto-replies are held under ${SMS_RELEASE_HOLD_CODES.autoReply}; inbound evidence does not prove an automated response was delivered.`,
      "No current consent record releases reply, test, campaign, broadcast, A2P, callback, financial, or MMS actions.",
    ],
    shots: [
      {
        alt: "Illustrative SMS consent evidence rows with source and time",
        variant: "sms",
      },
      {
        alt: "Illustrative compliance evidence with structural release holds",
        variant: "sms",
      },
      {
        alt: "Illustrative no-send decision; hosted SMS dispatch remains held",
        variant: "sms",
      },
    ],
  },
  {
    id: "campaigns",
    number: "3.0",
    eyebrow: "Drafts only",
    title: "Compose and inspect drafts. Do not dispatch them.",
    subhead:
      "Campaign and broadcast records are preparation surfaces. Send, schedule, resume, retry, test, tracked-click, MMS, cost, and private report evidence remain held; no displayed count is a live-delivery promise.",
    bullets: [
      "Draft bodies, audience references, sender references, and lifecycle metadata can be modeled without implying provider delivery.",
      `Campaign dispatch is ${SMS_RELEASE_HOLD_CODES.campaign}; scheduling is ${SMS_RELEASE_HOLD_CODES.campaignSchedule}; broadcast dispatch is ${SMS_RELEASE_HOLD_CODES.broadcast}.`,
      `One-recipient test dispatch is ${SMS_RELEASE_HOLD_CODES.test}; it does not return a live provider receipt.`,
      `MMS readiness is ${SMS_RELEASE_HOLD_CODES.mms}; a media URL field is not proof of inbound or outbound media support.`,
      "Provider-accepted counts, if retained, are not device delivery. Mutable status can change after a created-at pagination boundary.",
      `Private report/export evidence is ${SMS_RELEASE_HOLD_CODES.evidence}; financial truth is ${SMS_RELEASE_HOLD_CODES.financial}.`,
      `Tracked-link resolution is ${SMS_RELEASE_HOLD_CODES.clickResolver}; source URL fields are not a working redirect claim.`,
    ],
    shots: [
      {
        alt: "Illustrative SMS campaign draft composer; dispatch is release-held",
        variant: "sms",
      },
      {
        alt: "Illustrative test-send hold with no provider request",
        variant: "sms",
      },
      {
        alt: "Illustrative report schema; private evidence reads are release-held",
        variant: "sms",
      },
    ],
  },
  {
    id: "push",
    number: "4.0",
    eyebrow: "Presentation planes",
    title: "An interface event is not a carrier receipt.",
    subhead: SMS_PRESENTATION_SCOPE_COPY,
    bullets: [
      "Desktop presents strict admin-only conversation pages and loaded message records; raw phone selection and search remain out of durable URL/history state.",
      "Web presents route-specific setup, draft, consent, and suppression records; it must not synthesize delivery, cost, or provider readiness.",
      "Mobile presents bounded conversation and policy views with role and identity teardown; it is not an offline-complete archive.",
      "Operational notification navigation carries a generic inbox destination, never a phone number or message body.",
      "A notification about a retained record does not prove the provider callback, automated reply, or customer-device delivery happened.",
    ],
    shots: [
      {
        alt: "Illustrative operational notification; not an SMS delivery receipt",
        variant: "sms",
      },
      {
        alt: "Illustrative notification mapping with content-minimized inbox destination",
        variant: "sms",
      },
      {
        alt: "Illustrative presentation flow separated from hosted SMS callbacks",
        variant: "sms",
      },
    ],
  },
];

export default function SmsPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            SMS source surfaces. Hosted sending is held.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            {SMS_RELEASE_STATUS_COPY}
          </p>
          <p className="mt-4 font-mono text-sm text-pw-muted-on-ink max-w-3xl">
            {SMS_RELEASE_HOLD_CODES.reply} · {SMS_RELEASE_HOLD_CODES.broadcast}
            {" · "}
            {SMS_RELEASE_HOLD_CODES.a2p}
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
                    •
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
            Frequently asked about SMS
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
            Do not activate customer SMS traffic.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Review the source and presentation surfaces only. Hosted provider
            credentials, A2P registration, callbacks, replies, tests, campaigns,
            broadcasts, MMS, click resolution, and financial evidence remain{" "}
            {SMS_RELEASE_VERDICT} until independently promoted.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              View pricing →
            </Link>
            <Link
              href="/features"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              See all features
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
