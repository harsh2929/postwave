/**
 * Hero illustration registry — maps Section ids and arbitrary slugs to
 * the photographic illustrations under `src/assets/illustrations/`.
 *
 * Importing the WebP through Vite returns a hashed URL, so screens
 * use `heroFor("section")` instead of hard-coding paths. We ship WebP
 * because at q=85 the visual quality is indistinguishable from the
 * source PNGs but the bundled size drops ~97% (1.5 MB → ~40 KB per
 * image). The originals are not retained in the repo.
 */

import type { Section } from "./store";

import home from "../assets/illustrations/hero-home.webp";
import subscribers from "../assets/illustrations/hero-subscribers.webp";
import campaigns from "../assets/illustrations/hero-campaigns.webp";
import sequences from "../assets/illustrations/hero-sequences.webp";
import forms from "../assets/illustrations/hero-forms.webp";
import track from "../assets/illustrations/hero-track.webp";
import analytics from "../assets/illustrations/hero-analytics.webp";
import templates from "../assets/illustrations/hero-templates.webp";
import sendTime from "../assets/illustrations/hero-send-time.webp";
import outboundWebhooks from "../assets/illustrations/hero-outbound-webhooks.webp";
import inboundWebhooks from "../assets/illustrations/hero-inbound-webhooks.webp";
import inboundRoutes from "../assets/illustrations/hero-inbound-routes.webp";
import discounts from "../assets/illustrations/hero-discounts.webp";
import domains from "../assets/illustrations/hero-custom-domains.webp";
import dmarc from "../assets/illustrations/hero-dmarc.webp";
import audit from "../assets/illustrations/hero-audit.webp";
import approvals from "../assets/illustrations/hero-approvals.webp";
import compliance from "../assets/illustrations/hero-compliance.webp";
import assets from "../assets/illustrations/hero-assets.webp";
import tags from "../assets/illustrations/hero-tags.webp";
import lists from "../assets/illustrations/hero-lists.webp";
import suppressions from "../assets/illustrations/hero-suppressions.webp";
import archive from "../assets/illustrations/hero-archive.webp";
import referrals from "../assets/illustrations/hero-referrals.webp";
import gifts from "../assets/illustrations/hero-gift-subs.webp";
import smsInbox from "../assets/illustrations/hero-sms-inbox.webp";
import apiPlayground from "../assets/illustrations/hero-api-playground.webp";
import mcp from "../assets/illustrations/hero-mcp.webp";
import sending from "../assets/illustrations/hero-sending-settings.webp";
import scim from "../assets/illustrations/hero-scim.webp";
import agency from "../assets/illustrations/hero-agency.webp";
import migrations from "../assets/illustrations/hero-migrations.webp";
import auditSinks from "../assets/illustrations/hero-audit-sinks.webp";
import ai from "../assets/illustrations/hero-postwave-ai.webp";
import webhookSimulator from "../assets/illustrations/hero-webhook-simulator.webp";

const HERO_BY_SECTION: Partial<Record<Section, string>> = {
  dashboard: home,
  subscribers,
  campaigns,
  sequences,
  forms,
  track,
  analytics,
  templates,
  sendtime: sendTime,
  outboundWebhooks,
  webhooks: outboundWebhooks,
  inboundRoutes,
  discounts,
  domains,
  dmarc,
  audit,
  approvals,
  compliance,
  hipaa: compliance,
  assets,
  tags,
  lists,
  suppressions,
  archive,
  referrals,
  gifts,
  smsInbox,
  apiPlayground,
  mcp,
  sending,
  scim,
  agency,
  migrations,
  auditSinks,
  ai,
  webhookSimulator,
};

export function heroFor(section: Section): string | null {
  return HERO_BY_SECTION[section] ?? null;
}

/* Direct exports for screens that take an extra hero image (e.g.
 * separate inbound vs outbound under one section). */
export const HERO = {
  home,
  subscribers,
  campaigns,
  sequences,
  forms,
  track,
  analytics,
  templates,
  sendTime,
  outboundWebhooks,
  inboundWebhooks,
  inboundRoutes,
  discounts,
  domains,
  dmarc,
  audit,
  approvals,
  compliance,
  assets,
  tags,
  lists,
  suppressions,
  archive,
  referrals,
  gifts,
  smsInbox,
  apiPlayground,
  mcp,
  sending,
  scim,
  agency,
  migrations,
  auditSinks,
  ai,
  webhookSimulator,
} as const;
