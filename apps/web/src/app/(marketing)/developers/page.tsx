// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "build on newsletter platform API", "newsletter app
// marketplace", "email platform agent tools", "MCP newsletter API", "webhook
// HMAC newsletter". Primary intent is the developer / agent builder evaluating
// Moosewave as a platform to build apps and agents on, not just a place to send.
import type { Metadata } from "next";
import Link from "next/link";

import { InstallTabs } from "@/components/marketing/install-tabs";
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
import { NATIVE_TOOL_COUNT } from "@/lib/mcp-catalog-stats";
import {
  AGENT_INTERACTIVE_RELEASE_HOLD_CODE,
  AGENT_INTERACTIVE_RELEASE_STATUS_COPY,
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
  MCP_SOURCE_CANDIDATE_LABEL,
} from "@/lib/mcp-release-status";
import { DEVELOPER_INSTALL_TABS } from "./install-tabs-data";

const PAGE_URL = "https://moosewave.com/developers";
const PAGE_DESCRIPTION = `Build on Moosewave with a ${NATIVE_TOOL_COUNT}-tool native source registry. The separate MCP catalogue is a ${MCP_SOURCE_CANDIDATE_LABEL}; distribution is release-held.`;

export const metadata: Metadata = {
  title: "Build on Moosewave: apps, webhooks, and agents | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Build on Moosewave — developer platform; agent source held",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/developers/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave developer platform with release-held agent source",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Build on Moosewave — developer platform; agent source held",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "What can I build on Moosewave?",
    answer:
      "Three app types ship today: private apps (installed with an API key), public OAuth apps (authorization-code flow, scoped consent, installable across tenants), and a catalog-only listing for discovery without an install surface. A native-integration type exists as a foundation status. You declare the OAuth scopes and webhook topics your app needs, validate the draft against the marketplace catalog, then submit it for review — Moosewave's reviewer approves or rejects app, listing, and partner-profile transitions separately. The whole catalog (app types, scopes, webhook topics, OAuth runtime, revocation paths) is readable from one endpoint, /api/v1/developer-marketplace/catalog, so you can build against the live contract instead of a doc that drifts.",
  },
  {
    question: "How do API keys and scopes work?",
    answer: `Keys are created, rotated, and revoked over /api/v1/api-keys. The plaintext is returned exactly once at create time; rotation is an atomic two-row swap so the old key keeps working only until you deploy the new one. Permissions are explicit, additive scopes — read:subscribers, write:subscribers, read:campaigns, write:campaigns, send:transactional, read:reports, mcp, a family of audit:* scopes, and admin as a wildcard. The mcp scope exists in source policy, but ${MCP_RELEASE_HOLD_CODE} blocks MCP distribution and ${AGENT_INTERACTIVE_RELEASE_HOLD_CODE} blocks the in-app agent route family.`,
  },
  {
    question:
      "Are outbound webhooks signed, and what happens when an endpoint is down?",
    answer:
      "The web dashboard manages the legacy /api/v1/webhooks surface. When the gateway envelope cipher is configured, new endpoints on that surface receive a Moosewave-Signature header of the form t=<unix>,v1=<hex>, where v1 is an HMAC-SHA256 of the timestamp and raw body keyed by a per-endpoint secret returned once at create or rotate time. To verify, recompute HMAC-SHA256 over the exact bytes '<t>.' followed by the raw request body, and compare in constant time before parsing. v1 is the only outbound scheme. Failed deliveries use the shared durable outbox retry budget, and retained deliveries can be inspected and replayed per endpoint. A separate canonical /api/v1/outbound-webhooks implementation adds selective retry, auto-disable, filters, transforms, playground requests, cross-endpoint search, and 24-hour aggregates. Its routes and workers are composed in gateway source, but equivalent web management and live-deployment certification are not attested here.",
  },
  {
    question:
      "Can agents run against Moosewave with their own LLM keys and a real budget?",
    answer: `No supported runtime is mounted. ${AGENT_INTERACTIVE_RELEASE_STATUS_COPY}`,
  },
  {
    question: "How is the native tool registry different from the MCP server?",
    answer: `They are distinct candidates, not one qualified surface. The retained native agent source registry contains ${NATIVE_TOOL_COUNT} definitions, but the entire /api/v1/ai-agent/* family is structurally release-held. The proxy repository catalogue is ${MCP_SOURCE_CANDIDATE_LABEL}, but installed-artifact parity, complete scope metadata, protocol lifecycle, hosted authorization, and deployment are not qualified. ${MCP_RELEASE_HOLD_CODE} is the current distribution status.`,
  },
  {
    question: "Can I receive webhooks from my own systems into Moosewave?",
    answer:
      "Yes — inbound webhooks are the receive side. Each tenant endpoint has a slug and a per-endpoint secret. Send X-Moosewave-Timestamp (current Unix seconds), X-Moosewave-Event-Id (a stable provider delivery id), and X-Moosewave-Signature = 'v2=' + hex(HMAC-SHA256(secret, 'v2:<len(timestamp)>:<timestamp>:<len(eventId)>:<eventId>:' + raw body)) — the payload is length-prefixed so an event id containing a delimiter cannot shift the field boundaries. Requests outside the five-minute window and missing event identities are rejected before persistence. Exact retries are acknowledged without re-firing fanout or triggers; reusing an event id with different payload bytes is rejected.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Developers", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — developer platform; agent source release-held",
  description: PAGE_DESCRIPTION,
  brand: { "@type": "Brand", name: "Moosewave" },
  url: PAGE_URL,
  category: "Developer platform for newsletter and email marketing",
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

interface PlatformSection {
  id: string;
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: PlatformSection[] = [
  {
    id: "marketplace",
    number: "1.0",
    eyebrow: "Developer Marketplace",
    title: "Build an app. Ship it to other tenants.",
    subhead:
      "Declare the scopes and webhook topics you need, validate against the live catalog, and submit for review. Moosewave's reviewer signs off on apps, listings, and partner profiles independently — you don't ship until the queue clears.",
    bullets: [
      "Four app types: private apps (install via API key), public OAuth apps (authorization-code flow), native integrations (platform-managed, foundation status), and catalog-only listings for discovery with no install surface.",
      "Declare OAuth scopes and webhook topics on the app draft. Validation rejects unsupported topics and flags missing OAuth redirect URIs, so a misconfigured public app can't reach review.",
      "Webhook topic catalog with a source product per topic — campaign.sent, campaign.conversion, profile.created, profile.updated, event.created, segment.membership_changed, form.submitted — so you know exactly which dependencies an install picks up.",
      "OAuth runtime: per-app OAuth clients you create and revoke, an authorize endpoint, and a bearer-token resolver that turns a consented install into a scoped runtime credential.",
      "Installations are first-class: each carries the scopes the tenant actually granted, and an install can be revoked independently of the OAuth client that issued it.",
      "Listings and partner profiles with review state and partner level — the public-facing surface, gated behind the same reviewer authority as the app itself.",
      "Review queue with pending / resolved filters and live counts across apps, listings, and partner profiles; each decision is an explicit approve or reject with notes.",
      "Validate → submit: validation runs a readiness checklist (active OAuth client, declared topics have a delivery endpoint, redirect URIs present for public apps) before you can submit for review.",
      "Marketplace audit log records every reviewer transition and revocation, so partner distribution decisions are reconstructable.",
    ],
    shots: [
      {
        alt: "Developer marketplace app builder showing app type, declared scopes, and webhook topics with a validation checklist",
        variant: "developers",
      },
      {
        alt: "Marketplace review queue with pending and resolved counts across apps, listings, and partner profiles",
        variant: "developers",
      },
      {
        alt: "OAuth client management panel with create and revoke actions and a granted-scopes view of an installation",
        variant: "developers",
      },
    ],
  },
  {
    id: "keys",
    number: "2.0",
    eyebrow: "API keys & scopes",
    title: "Issue a key that can do exactly one thing.",
    subhead:
      "Keys are scoped, rotatable, and revocable. The proxy enforces the scope set on every tool, so a narrow key stays narrow — you grant send:transactional to the sender and nothing else.",
    bullets: [
      "Create over POST /api/v1/api-keys; the plaintext is returned exactly once and never again. Keys are prefixed (pw_…) and stored hashed.",
      "Rotate is an atomic two-row swap: the new plaintext is issued while the old key keeps working only until you deploy, so there's no window where both or neither work.",
      "Revoke is a soft delete via revoked_at — the audit trail of what a key did survives its revocation.",
      "Additive scopes: read:subscribers, write:subscribers, read:campaigns, write:campaigns, send:transactional, read:reports, plus the audit:* family and an mcp scope, with admin as a wildcard.",
      "The mcp scope is reserved for the native preview boundary; it is not a grant for a hosted or published connector while distribution is release-held.",
      "Current proxy source fails closed when scope introspection or per-tool classification is missing. That local candidate behavior is not installed-artifact parity evidence.",
      "Optional IP allowlists and short-lived stream tokens for browser-driven SSE, so a long-lived secret never has to live in a frontend.",
    ],
    shots: [
      {
        alt: "API key creation dialog with a scope picker and the one-time plaintext key shown once",
        variant: "developers",
      },
      {
        alt: "API key list with rotate and revoke actions and per-key scope chips",
        variant: "developers",
      },
      {
        alt: "Scope picker mapping read and write scopes to the tools each one unlocks",
        variant: "developers",
      },
    ],
  },
  {
    id: "webhooks",
    number: "3.0",
    eyebrow: "Webhooks",
    title: "Signed events out. Verified events in.",
    subhead:
      "The dashboard-managed legacy webhook surface provides signed outbound delivery and per-endpoint inspection. A richer canonical API is composed in source but is not represented as web-control-plane or live-deployment parity.",
    bullets: [
      "Outbound signatures: with the gateway envelope cipher configured, new dashboard-managed /api/v1/webhooks endpoints carry Moosewave-Signature of the form t=<unix>,v1=<hex> — an HMAC-SHA256 of the timestamp and raw body, keyed by a per-endpoint secret returned once at create / rotate. Legacy rows without a recoverable encrypted secret must be recreated before signed testing.",
      "Verify by recomputing HMAC-SHA256 over '<t>.' + the raw body with your endpoint secret, compared in constant time — reject anything whose t falls outside your own tolerance window. v1 is the only outbound scheme, so there is no algorithm negotiation to implement.",
      "The legacy dashboard surface filters by selected event topics, retries failed sends through the shared outbox, and can inspect or replay a retained delivery from that endpoint's delivery page.",
      "Canonical /api/v1/outbound-webhooks source adds payload filters and transforms, a seven-attempt widening retry schedule, permanent handling for non-429 4xx responses, auto-disable after 100 consecutive failures, a playground, cross-endpoint search, and a 24-hour aggregate.",
      "Those canonical routes and delivery workers are composed in the gateway source. The current web app only reads canonical endpoints on the Routing page; create, edit, test, replay, playground, and unified-delivery management are not web-wired, and this page is not live-environment certification.",
      "Inbound webhooks: each tenant endpoint has a slug and a per-endpoint secret; the upstream sender signs timestamp, stable event id, and raw body, then POSTs to /api/public/inbound/{slug}. Moosewave verifies X-Moosewave-Signature; outbound deliveries use Moosewave-Signature.",
      "Unsigned or mis-signed inbound POSTs are rejected without persisting the body, so a forgery loop can't fill your inbound_events table.",
      "Inbound replays are de-duplicated by a sender-stable event identity — an exact provider re-send is acknowledged without duplicating the stored event, while matched Moosewave actions use their own bounded durable retry worker.",
    ],
    shots: [
      {
        alt: "Outbound webhook endpoint configuration with HMAC signing secret, topic filter, and a signed example payload",
        variant: "developers",
      },
      {
        alt: "Legacy webhook delivery inspector showing attempts and a replay action for retained payloads",
        variant: "developers",
      },
      {
        alt: "Inbound webhook endpoint with its slug, per-endpoint secret, and recent verified events",
        variant: "developers",
      },
    ],
  },
  {
    id: "agents",
    number: "4.0",
    eyebrow: "Agent platform",
    title: "Review held native agent source.",
    subhead:
      "The native runtime and MCP proxy are separate source candidates with different execution, authorization, output, telemetry, and protocol boundaries.",
    bullets: [
      `Native agent source registry: ${NATIVE_TOOL_COUNT} definitions. The entire /api/v1/ai-agent/* family is structurally held before authentication or side effects; this count is not a deployed or callable inventory.`,
      `MCP proxy catalogue: ${MCP_SOURCE_CANDIDATE_LABEL}. It is mutable source inventory, not an installed or hosted surface; ${MCP_RELEASE_HOLD_CODE} blocks setup guidance.`,
      `${AGENT_INTERACTIVE_RELEASE_STATUS_COPY}`,
      "Governance and audit code are source evidence only: one self-information exception is intentionally unscoped, quota/telemetry coupling is provisional, writes are held, and audit fallback is best-effort rather than durable proof.",
      "Cross-surface parity is not claimed. A qualified future release needs explicit runtime, output, authorization, telemetry, and evidence verification.",
    ],
    shots: [
      {
        alt: "Agent tool registry view showing native tools with read-only and write-tier annotations and required scopes",
        variant: "developers",
      },
      {
        alt: "Release-held agent session and telemetry source illustration; no running session, stream, or billing ledger is shown",
        variant: "developers",
      },
      {
        alt: "BYOK LLM configuration panel for a tenant provider key with a per-tenant send budget meter",
        variant: "developers",
      },
    ],
  },
];

export default function DevelopersPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Build on Moosewave.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            A developer marketplace, scoped API keys, outbound webhook signing,
            inbound signature verification, plus release-held native agent
            source. The API and webhook surfaces do not imply MCP distribution
            or an agent runtime.
          </p>
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

        {/* MCP cross-link */}
        <section className="py-24">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Already in an editor?
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-2xl">
            {MCP_RELEASE_STATUS_COPY} The linked page exposes the candidate
            catalogue and qualification boundary.
          </p>
          <div className="mt-6">
            <Link
              href="/mcp"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              MCP release status →
            </Link>
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
            Frequently asked about building on Moosewave
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
            Build against the reviewed API surface.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Create a scoped API key for the reviewed API and webhook surfaces.
            MCP distribution and the in-app agent route family remain
            release-held.
          </p>
          <div className="mt-8 max-w-xl mx-auto text-left">
            <InstallTabs tabs={DEVELOPER_INSTALL_TABS} />
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/mcp"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              Review MCP release status →
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
