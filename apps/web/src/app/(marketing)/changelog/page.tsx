// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: changelog entries are dated release notes; rank for "Moosewave
// changelog", "Moosewave releases". Set max-snippet:-1 so AIO can quote freely.
import Link from "next/link";
import type { Metadata } from "next";

import { BackToTop } from "@/components/marketing/back-to-top";
import {
  ChangelogList,
  type ChangelogEntry,
} from "@/components/marketing/changelog-list";
import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { publicSiteOrigin } from "@/lib/site-url";
import {
  AGENT_INTERACTIVE_RELEASE_HOLD_CODE,
  MCP_RELEASE_HOLD_CODE,
} from "@/lib/mcp-release-status";
import {
  SMS_RELEASE_HOLD_CODES,
  SMS_RELEASE_VERDICT,
} from "@/lib/sms-release-status";

const SITE_URL = publicSiteOrigin();
const PAGE_URL = `${SITE_URL}/changelog`;
const DESCRIPTION =
  "Dated source milestones, immutable-artifact notes, and current release holds.";

export const metadata: Metadata = {
  title: "Changelog | Moosewave",
  description: DESCRIPTION,
  alternates: {
    canonical: PAGE_URL,
    types: {
      "application/atom+xml": "/changelog.xml",
    },
  },
  robots: {
    index: true,
    follow: true,
    "max-snippet": -1,
  },
  openGraph: {
    type: "article",
    url: PAGE_URL,
    title: "Moosewave changelog",
    description: DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/changelog/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave changelog",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave changelog",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

type Entry = ChangelogEntry;

// `planned: true` means the release has not happened. Five historical entries
// carried it — v0.2.0, v0.1.0-beta, v0.0.3, v0.0.2, v0.0.1 — while releases
// above each of them were listed as shipped with dates: v0.0.4 on 2026-04-30,
// v0.2.1 on 2026-05-11, up to v0.4.0. A release cannot still be pending once
// its successor has shipped, and the content confirms it independently —
// v0.2.0 is where MCP/CLI source first appeared. That historical source event
// is not an npm-artifact parity claim: the independently observed immutable
// The legacy MCP artifact exposes 133 names, while today's mutable
// repository catalogue is materially larger. v0.2.1's own note tells
// operators migrating "from earlier versions" to rename an env var.
//
// Their ship dates are not recorded anywhere in the repo (no release tags, no
// root CHANGELOG), so the flag is cleared and the date left absent rather than
// invented. __tests__/changelog-release-order.test.ts holds the invariant.
const ENTRIES: Entry[] = [
  {
    version: "v0.4.0",
    date: "2026-06-20",
    summary: `Historical source milestone: marketing source expanded across audience sync, commerce, SMS, and an agent candidate; the mutable native registry snapshot reached 22 definitions. This was not an installed/deployed runtime claim, and ${AGENT_INTERACTIVE_RELEASE_HOLD_CODE} is current.`,
    highlights: [
      "10 new marketing capability pages plus a Product mega-menu and platform footer column — the public site now maps to the full IA, not just email",
      "Integrations catalog expanded 9 → 29 with a dynamic sitemap covering the new capability and integration routes",
      `Historical source snapshots recorded 22 native and 211 proxy definitions; these were not installed-artifact counts. The verified npm 0.1.0 artifact exposes 133 names and current distribution is ${MCP_RELEASE_HOLD_CODE}.`,
      `Anthropic BYOK source implementation landed for review; it did not establish a supported runtime, and ${AGENT_INTERACTIVE_RELEASE_HOLD_CODE} remains authoritative`,
    ],
  },
  {
    version: "v0.3.1",
    date: "2026-06-19",
    summary: `Historical source milestone: candidate session, token/cost, scope-filter, and tracing implementations landed alongside web craft changes. These source paths did not establish a supported runtime; ${AGENT_INTERACTIVE_RELEASE_HOLD_CODE} is current.`,
    highlights: [
      "Candidate session persistence, SSE, and per-request LLM resolver seams landed in source; runtime durability and availability were not qualified",
      "Candidate token/cost recording, proxy scope filtering, and bounded OTel spans landed in source; they were not billing, audit, or full-telemetry proof",
      "UI-craft waves 7–9: unified EmptyState across forms + sequences, a first-send celebration, and tabular figures on the analytics KPI tiles",
      "UI-craft wave 10: ad-hoc status colors remapped onto semantic design tokens",
      "UI-craft waves 11–12: in-product motion behind a reduced-motion guard, and a real dark mode (toggle + ink-warm theme)",
      "UI-craft waves 13–15: subscribers bulk-select + pagination, an in-app ⌘K command palette, and drag-to-reorder form fields",
    ],
  },
  {
    version: "v0.3.0",
    date: "2026-06-16",
    summary: `Historical source milestone: growth-channel models and presentation candidates landed for audience sync, commerce, SMS, and operational mobile notifications. It did not establish a live SMS/provider release; current SMS verdict is ${SMS_RELEASE_VERDICT}.`,
    highlights: [
      "Audience sync to Meta, Google Ads, TikTok, LinkedIn, and Snap, with scheduled syncs that keep ad-platform audiences current",
      "Commerce providers: BigCommerce, Adobe Commerce, PayPal, and Razorpay join Shopify and Stripe",
      "Conversion tracking and revenue attribution across the commerce integrations",
      `SMS source models named Twilio, Telnyx, and Bandwidth plus sender, consent, inbox, and campaign shapes; hosted dispatch is ${SMS_RELEASE_HOLD_CODES.campaign} and A2P effects are ${SMS_RELEASE_HOLD_CODES.a2p}`,
      "Operational mobile-notification source landed as a separate presentation plane; it was not customer-facing SMS delivery or carrier-receipt proof",
    ],
  },
  {
    version: "v0.2.1",
    date: "2026-05-11",
    summary:
      "Foundation-model swap: AI Diagnostician and Voice AI move from Anthropic Claude to Google Gemini 3. Same interfaces, same prompts, same eval cases — different upstream. Cost drops materially (Gemini 3 Pro is ~30% cheaper input / ~33% cheaper output than Claude Sonnet at comparable quality); reasoning quality measured equivalent on our 45-case Diagnostician eval. Operators migrating from earlier versions: rename `ANTHROPIC_API_KEY` to `GEMINI_API_KEY` (legacy var accepted with a deprecation warn for one release).",
    highlights: [
      "GeminiClient replaces ClaudeClient in services/voice — hand-rolled HTTP against generateContent + streamGenerateContent",
      "GeminiClient replaces AnthropicClient in services/deliverability — anthropic-sdk-go and 7 transitive deps removed",
      "Models: gemini-3.1-pro-preview for Diagnostician (deep reasoning), gemini-3-flash-preview for Voice AI + Pre-Send Predictor (cost-effective, faster)",
      "Sub-processor list updated: Anthropic → Google (Gemini API) with corresponding DPA link",
      "Legacy env-var fallback: ANTHROPIC_API_KEY still works for one release with an audible deprecation warn",
    ],
  },
  {
    version: "v0.2.0",
    summary:
      "Phase 5, the platform extension phase. Moosewave grows a programmable surface (MCP server, CLI, an OSS React component library), extracts a permissively licensed migration core, and adds the campaign primitives that operators have been asking for: A/B testing, behavioral triggers, a visual segment builder, topics, and admin UIs for the things that used to be DB-only.",
    highlights: [
      `MCP/CLI source introduced with a 211-definition snapshot, plus the email React package. That count did not identify the immutable legacy npm artifact; verified version 0.1.0 exposes 133 names and remains ${MCP_RELEASE_HOLD_CODE}.`,
      "The migration toolkit was extracted as a standalone MIT-licensed Go module under its legacy namespace",
      "A/B testing with deterministic hash sampling and z-test winner decision at a 95% confidence floor",
      "Behavioral triggers (opened / clicked / did_not_open) with a Listmonk webhook ingester and a one-time evaluator",
      "Visual segment builder backed by the canonical SegmentNode AST with a live preview count",
      "Topics and a per-subscriber preference center with granular consent tracking",
      "Webhook subscriptions and API key admin UIs (previously DB-only)",
      "Diagnostician eval expanded to 45 hand-labeled cases with a v0.2.0 acceptance gate at >= 85% overall and >= 75% per scenario class",
    ],
  },
  {
    version: "v0.1.0-beta",
    summary:
      "Public beta launch of Moosewave. Forms and the GrapesJS block editor land alongside typed flow authoring; automation enrollment, scheduling, execution, and delivery remain release-held.",
    highlights: [
      "6 migration adapters: Mailchimp, ConvertKit, Substack, Beehiiv, MailerLite, CSV universal",
      "Inbox Reality with AI Diagnostician (Gemini Pro) + optional Gemini Flash Pre-Send Predictor blend",
      "Voice-native sequences with 50 launch templates across 10 categories",
      "GrapesJS block editor + MJML compilation, 90+ email-client coverage",
      "Automation configuration: typed AST authoring and validation; runtime release-held",
      "Hosted forms with double opt-in by default and embed snippets",
      "An early one-time-sale proposal was retired before the Moosewave launch catalog opened",
    ],
  },
  {
    version: "v0.0.4",
    date: "2026-04-30",
    summary:
      "Phase 4 milestone, the launch-readiness phase. Documentation, public APIs, comparison content, legal drafts, billing plumbing, and infrastructure all reach a state where we can credibly invite outside developers and counsel to look at them.",
    highlights: [
      "Docs site (66 pages) covering product, API, migrations, deliverability, voice",
      "OpenAPI 3.1 spec + first-party SDKs for TypeScript and Python",
      "6 competitor comparison pages (Mailchimp, Substack, Beehiiv, ConvertKit, MailerLite, Sendy)",
      "Substantive Terms of Service / Privacy Policy / DPA drafts (counsel review pending)",
      "Affiliate program source prototype; public signup and admin console are release-held and not mounted in production",
      "Stripe webhook → tenant provisioning end-to-end",
      "Postgres-backed stores replacing in-memory fakes for billing and affiliates",
      "KMS envelope encryption for OAuth tokens and per-tenant secrets",
      "Hetzner + Cloudflare Terraform module + status page",
    ],
  },
  {
    version: "v0.0.3",
    summary:
      "Phase 3 polish. Deliverability gets honest scoring and real reputation data; migration gets a 7-day rollback safety net; the marketing surface and forms stack reach feature-complete; voice templates and editor preview deepen.",
    highlights: [
      "Calibrated logistic spam scorer replacing the heuristic stub",
      "Real link reputation via URIBL / SURBL + 12 RBLs",
      "7-day post-migration rollback (subscriber + automation snapshots)",
      "Forms builder + hosted pages + double opt-in flow",
      "Settings + billing UI (plan / usage / invoices / portal)",
      "Marketing site (landing, features, pricing, migrations, vs/*)",
      "Voice template library 30 → 50",
      "HCTI cross-client preview across 10 mailbox environments",
      "7 ops runbooks (incident, blocklist, key rotation, etc.)",
      "k6 scale tests + accessibility pass on dashboard surface",
    ],
  },
  {
    version: "v0.0.2",
    summary:
      "Phase 2, pillar depth. The skeleton from v0.0.1 gets the second tier of adapters, voice generation, typed automation configuration, and an Anthropic SDK wired into Diagnostician and Voice AI. Flow execution remains release-held.",
    highlights: [
      "Substack + Beehiiv + MailerLite + CSV migration adapters",
      "Listmonk-AST automation translator",
      "Voice generation engine (embedding-based fidelity scoring + auto-regen)",
      "30 launch sequence templates",
      "Automation AST and worker scaffolding (not a released execution runtime)",
      "Postmark Streams integration + IP warming schedule",
      "Real Anthropic SDK wired into AI Diagnostician + Voice AI",
    ],
  },
  {
    version: "v0.0.1",
    summary:
      "Phase 1 foundations. The bones of the platform: multi-tenant Postgres, the first two migration adapters, the voice ingestion pipeline, and the deliverability skeleton that everything else hangs off of.",
    highlights: [
      "Multi-tenant Postgres with row-level security (RLS)",
      "Mailchimp + ConvertKit OAuth migration adapters",
      "Voice profile + ingestion pipeline (RSS, archive, paste-in)",
      "Migration wizard UI (5-step state machine)",
      "Deliverability skeletons across all 5 layers",
      "Inbox Reality dashboard (reputation + auth + recent campaigns)",
    ],
  },
];

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: SITE_URL },
  { name: "Changelog", url: PAGE_URL },
]);

function buildItemListJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Moosewave releases",
    itemListElement: ENTRIES.map((entry, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Article",
        headline: `Moosewave ${entry.version}`,
        ...(entry.date ? { datePublished: entry.date } : {}),
        description: entry.summary,
        url: `${PAGE_URL}#${entry.version}`,
        publisher: {
          "@type": "Organization",
          name: "Moosewave",
        },
        author: {
          "@type": "Organization",
          name: "Moosewave",
        },
      },
    })),
  };
}

export default function ChangelogPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[BREADCRUMBS_JSON_LD, buildItemListJsonLd()]} />
      <section className="border-b border-pw-line">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <p className="text-xs uppercase tracking-widest text-pw-muted-on-paper">
            Changelog
          </p>
          <h1 className="mt-3 text-4xl md:text-5xl font-semibold tracking-tight">
            Changelog
          </h1>
          <p className="mt-5 text-lg text-pw-muted-on-paper max-w-3xl leading-relaxed">
            Entries record dated or versioned source milestones. They do not by
            themselves prove a matching immutable artifact, deployment, or
            runtime. Artifact identities are stated where independently known,
            and current release holds override historical source descriptions.
          </p>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-6 py-16">
        <ChangelogList entries={ENTRIES} />

        <footer className="mt-16 border-t pt-8 text-sm text-pw-muted-on-paper">
          <p>
            The Moosewave application source is licensed AGPL-3.0-only, and the
            reusable packages — SDKs, the CLI, the MCP server, the migration
            library, and the React email components — under their own MIT
            licenses. The{" "}
            <Link
              className="underline underline-offset-4 hover:text-pw-ink2"
              href="/legal/terms"
            >
              Terms
            </Link>{" "}
            §6 set out what that does and does not include. You can also{" "}
			<Link
			  className="underline underline-offset-4 hover:text-pw-ink2"
			  href="/docs"
			>
			  read the documentation
			</Link>
            .
          </p>
          <p className="mt-2">
            Subscribe via{" "}
            <a
              className="underline underline-offset-4 hover:text-pw-ink2"
              href="/changelog.xml"
            >
              RSS / Atom feed
            </a>
            .
          </p>
        </footer>
      </section>
      <BackToTop />
    </div>
  );
}
