// Moosewave docs - server-only search index builder.
//
// Imports the OpenAPI and MCP skill loaders (both of which use node:fs) and
// emits a cached `SearchIndex` used only by the compact server search route.
// The full corpus never crosses the React Server Component boundary.

import { listOperations, operationsByTag } from "./loadOpenAPI";
import { listSkills } from "./loadSkills";
import { type SearchDoc, type SearchIndex, tokenize } from "./search";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_SOURCE_CANDIDATE_LABEL,
} from "../mcp-release-status";

export const STATIC_DOCS: {
  title: string;
  url: string;
  section: string;
  body: string;
}[] = [
  {
    title: "Getting started",
    url: "/docs/getting-started",
    section: "Get Started",
    body: "Sign up for Moosewave, connect your sending domain, import subscribers from Mailchimp ConvertKit Beehiiv Substack MailerLite or CSV. Build your voice profile from past archive sources. Send your first campaign. Monitor deliverability with Inbox Reality. Quickstart authentication concepts.",
  },
  {
    title: "Quickstart",
    url: "/docs/quickstart",
    section: "Get Started",
    body: "Five step quickstart: sign up connect domain, import subscribers, build voice profile, send first campaign, monitor deliverability. API examples curl POST /api/v1/campaigns voice profile sequences.",
  },
  {
    title: "API reference",
    url: "/docs/api",
    section: "API",
    body: `OpenAPI 3.1 REST API reference ${listOperations().length} endpoints across ${operationsByTag().length} tags Migrations Subscribers Campaigns Sequences Templates Voice Forms Inbox Reality Reputation Sending Webhooks Topics Audit Privacy Approvals Sandbox Cost Safety Events Paid Subs Segments Custom Fields.`,
  },
  {
    title: "Skills (MCP)",
    url: "/docs/skills",
    section: "API",
    body: `Moosewave MCP ${MCP_SOURCE_CANDIDATE_LABEL}. ${MCP_RELEASE_HOLD_CODE}; unsupported private source evaluation only, not installed or hosted availability. Migration integrations marketplace deliverability voice subscribers forms campaigns sms admin automations topics agent events analytics audience platform templates domains archive referrals billing.`,
  },
  {
    title: "Migrations",
    url: "/docs/migrations",
    section: "Guides",
    body: "Migration guides for ActiveCampaign API token plus account API URL, HubSpot private-app token, Customer.io App API key with US or EU workspace binding, Mailchimp and ConvertKit OAuth, Brevo Beehiiv MailerLite API key, Substack Sendy CSV import. Dry run, proof gates, final delta, rollback.",
  },
  {
    title: "HubSpot migration",
    url: "/docs/migrations/hubspot",
    section: "Guides",
    body: "HubSpot migration: private-app token contact bridge, lifecycle fields, custom properties, exact list-membership tags, source-event replay, final delta import, rollback rehearsal, pilot acceptance, private-app-token cleanup evidence.",
  },
  {
    title: "ActiveCampaign migration",
    url: "/docs/migrations/activecampaign",
    section: "Guides",
    body: "ActiveCampaign migration: contacts tags lists campaigns automation rebuild evidence CRM custom objects SMS inventory. API URL and token, account_id extra.api_url credential shape, source-event replay, dry run, final delta, rollback rehearsal, parity report.",
  },
  {
    title: "Customer.io migration",
    url: "/docs/migrations/customerio",
    section: "Guides",
    body: "Customer.io migration: dedicated App API key rather than Track API site key, US or EU region, numeric workspace binding, immutable cio_id profile identity, complete email-addressable profile snapshots, global + resolved email-channel + applicable-topic eligibility, separate sender-specific SMS/WhatsApp opt-outs, frozen segment and subscription-topic membership, ESP suppression review, sent email newsletter archive with explicit empty-language default/A-B representative and source layout composition, exact-source Design Studio HTML templates, campaign and API-broadcast rebuild evidence, final full delta, shadow check, rollback rehearsal, six cutover reviews, and no source-event polling.",
  },
  {
    title: "Mailchimp migration",
    url: "/docs/migrations/mailchimp",
    section: "Guides",
    body: "Mailchimp migration: subscribers segments automations campaign archive. OAuth flow, dry run, commit, 7-day rollback.",
  },
  {
    title: "ConvertKit migration",
    url: "/docs/migrations/convertkit",
    section: "Guides",
    body: "ConvertKit (Kit) migration: subscribers tags sequences forms broadcasts. API key authentication, dry run.",
  },
  {
    title: "Brevo migration",
    url: "/docs/migrations/brevo",
    section: "Guides",
    body: "Brevo (Sendinblue) migration: contacts lists transactional templates campaigns. API key import.",
  },
  {
    title: "Beehiiv migration",
    url: "/docs/migrations/beehiiv",
    section: "Guides",
    body: "Beehiiv migration: one workspace-validated publication, cursor subscribers, frozen segment snapshots, newsletter-list history, automation rebuild evidence, eligible sent-post archive, premium metadata without Stripe billing migration, and a final full delta.",
  },
  {
    title: "Substack migration",
    url: "/docs/migrations/substack",
    section: "Guides",
    body: "Substack migration: official ZIP CSV subscribers tier metadata unconfirmed consent post HTML archive Stripe Apple billing handoff.",
  },
  {
    title: "MailerLite migration",
    url: "/docs/migrations/mailerlite",
    section: "Guides",
    body: "MailerLite API-token migration: authoritative subscriber status, opted-in evidence, custom-field definitions and values, group tags, saved-segment and automation rebuild definitions, sent campaign metadata/plain text/variants/reports, draft and ready campaign rebuild records, form and ecommerce-shop source evidence, explicit sites/templates/rendered-HTML gaps.",
  },
  {
    title: "CSV migration",
    url: "/docs/migrations/csv",
    section: "Guides",
    body: "CSV import: header mapping consent timestamp custom fields validation suppression.",
  },
  {
    title: "Integrations",
    url: "/docs/integrations",
    section: "Guides",
    body: "Integrations: Customer.io partial native provider-row and delegated migration handoff, Slack approvals and slash commands, read-only Stripe commerce backfill plus signed webhook ingestion, Postmark Mailgun SES sending and feedback, sending-identity DNS checks, and verified inbound webhook ingestion.",
  },
  {
    title: "Customer.io integration",
    url: "/docs/integrations/customerio",
    section: "Guides",
    body: "Customer.io native foundation: App API credential reference, US or EU region and numeric workspace handoff evidence, row-preserving pause and disconnect, marketing sync run history, delegated customerio_handoff full-snapshot migration cursor, no Track API writeback, no complete source-event feed, and no live workspace certification.",
  },
  {
    title: "Slack integration",
    url: "/docs/integrations/slack",
    section: "Guides",
    body: "Slack integration: approval workflows, slash commands, channel routing, OAuth installation.",
  },
  {
    title: "Stripe integration",
    url: "/docs/integrations/stripe",
    section: "Guides",
    body: "Stripe integration: restricted-key read-only customer payment invoice dispute credit-note subscription and refund evidence, signed webhook ingestion, operator-managed provider cleanup, no charges, subscription mutation, customer portal, or plan upgrades.",
  },
  {
    title: "Postmark integration",
    url: "/docs/integrations/postmark",
    section: "Guides",
    body: "Postmark sending integration: streams, message-stream id, bounce webhook, suppression sync.",
  },
  {
    title: "Mailgun integration",
    url: "/docs/integrations/mailgun",
    section: "Guides",
    body: "Mailgun sending integration: domain verification, webhook events, suppression list.",
  },
  {
    title: "SES integration",
    url: "/docs/integrations/ses",
    section: "Guides",
    body: "Amazon SES integration: configuration set, SNS topic for bounces, IAM role.",
  },
  {
    title: "Custom domains",
    url: "/docs/integrations/custom-domains",
    section: "Guides",
    body: "Sending-identity DNS source contract: generated DKIM public-key, SPF, and monitor-only DMARC TXT records with explicit on-demand verification and per-record results; provider provisioning, certificates, customer-host routing, and live deployment remain unqualified.",
  },
  {
    title: "Inbound webhooks",
    url: "/docs/integrations/inbound-webhooks",
    section: "Guides",
    body: "Inbound webhook receive handlers: the upstream sender signs timestamp, stable event identity, and raw body; Moosewave verifies HMAC before persistence, deduplicates exact retries, and durably retries matched product actions.",
  },
  {
    title: "Changelog",
    url: "/docs/changelog",
    section: "Guides",
    body: "Moosewave release notes versions changelog history.",
  },
];

let cachedIndex: SearchIndex | null = null;

export function getSearchIndex(): SearchIndex {
  if (cachedIndex) return cachedIndex;
  const docs: SearchDoc[] = [];
  let id = 0;

  for (const s of STATIC_DOCS) {
    docs.push({
      id: id++,
      title: s.title,
      url: s.url,
      section: s.section,
      body: s.body,
    });
  }

  for (const op of listOperations()) {
    docs.push({
      id: id++,
      title: `${op.method.toUpperCase()} ${op.path}`,
      url: `/docs/api/${op.slug}`,
      section: `API · ${op.primaryTag}`,
      body: `${op.summary} ${op.description} ${op.operationId} ${op.tags.join(" ")}`,
    });
  }

  for (const skill of listSkills()) {
    docs.push({
      id: id++,
      title: `${skill.name} · release-held MCP source candidate`,
      url: `/docs/skills/${skill.slug}`,
      section: `Skills · ${skill.category}`,
      body: `${MCP_RELEASE_HOLD_CODE} unsupported private source evaluation; no supported install, hosted connector, working-key setup, or governed-write guarantee. ${skill.description} ${skill.fullDescription} ${skill.inputFields
        .map((f) => f.name)
        .join(" ")}`,
    });
  }

  const postings: Record<string, number[]> = {};
  for (const d of docs) {
    const seen = new Set<string>();
    for (const tok of tokenize(`${d.title} ${d.body}`)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (!postings[tok]) postings[tok] = [];
      postings[tok].push(d.id);
    }
  }

  cachedIndex = { docs, postings };
  return cachedIndex;
}

export function indexSizeBytes(index: SearchIndex): number {
  return Buffer.byteLength(JSON.stringify(index), "utf8");
}
