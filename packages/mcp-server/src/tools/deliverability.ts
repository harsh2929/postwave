// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";
import { campaignAssuranceTools } from "./campaign-assurance.js";

export function deliverabilityTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "diagnose_campaign",
      description:
        "Run the AI Diagnostician on a sent campaign. Returns a ranked list of fixes (each with severity, evidence, and a suggested action) for any deliverability issues observed across the seedlist.",
      schema: z.object({
        campaign_id: z.string(),
      }),
      handler: async ({ campaign_id }) => client.inboxReality.diagnose(campaign_id),
    },
    {
      name: "predict_placement",
      description:
        "Predict inbox placement (Primary / Promotions / Spam) for a draft email BEFORE you send. Takes raw HTML and a subject line.",
      schema: z.object({
        html: z.string(),
        subject: z.string(),
      }),
      handler: async ({ html, subject }) => client.inboxReality.predict({ html, subject }),
    },
    {
      name: "check_reputation",
      description:
        "Sender-reputation snapshot for the tenant's sending domain + IP. Returns SenderScore, blocklist status, and Postmaster Tools signals when available.",
      // No params: reputation.get() is tenant-scoped. (Previously declared a
      // `domain` override the handler silently ignored — removed.)
      schema: z.object({}),
      handler: async () => client.reputation.get(),
    },
    {
      name: "check_auth",
      description:
        "Status of SPF, DKIM, DMARC, and BIMI for the tenant's sending domain. Returns each record with pass/fail and a remediation hint when failing.",
      // No params: authChecks.list() is tenant-scoped. (Previously declared a
      // dead `domain` param the handler ignored — removed.)
      schema: z.object({}),
      handler: async () => client.authChecks.list(),
    },
    {
      name: "render_cross_client",
      description:
        "Render an HTML email across major clients (Gmail web/mobile, Outlook desktop/web, Apple Mail, Yahoo) and return one preview URL per environment.",
      schema: z.object({
        html: z.string(),
        environments: z
          .array(z.string())
          .optional()
          .describe("Subset of clients to render. Default: all."),
      }),
      handler: async ({ html, environments }) =>
        client.inboxReality.render({ html, environments: environments ?? [] }),
    },
    {
      name: "inbox_report",
      description:
        "Full Inbox Reality report for a sent campaign: placement from the active controlled seed roster, opens/clicks per observed provider, and any auth/content signals that fired.",
      schema: z.object({
        campaign_id: z.string(),
      }),
      handler: async ({ campaign_id }) => client.inboxReality.getCampaignReport(campaign_id),
    },
    {
      name: "render_preview_html",
      description:
        "Preview raw HTML across major email clients without saving anything. Wraps the same render pipeline as render_cross_client but takes HTML directly so an agent can iterate on a draft before any campaign object exists.",
      schema: z.object({
        html: z.string(),
        environments: z
          .array(z.string())
          .optional()
          .describe("Subset of clients to render. Default: all."),
      }),
      handler: async ({ html, environments }) =>
        client.inboxReality.render({ html, environments: environments ?? [] }),
    },
    ...campaignAssuranceTools(client),
  ];
}
