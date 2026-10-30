// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const AudienceSchema = z.object({
  list_id: z.number().int().optional(),
  segment_id: z.string().optional(),
});

const VariantSchema = z.object({
  variant_label: z.string(),
  subject: z.string().optional(),
  body_mjml: z.string().optional(),
  body_html: z.string().optional(),
  from_name: z.string().optional(),
  weight: z.number().min(0).max(100).default(50),
});

const ABSettingsSchema = z.object({
  winner_metric: z.enum(["open_rate", "click_rate", "reply_rate"]),
  evaluation_window_hours: z.number().int().min(1).max(720).default(24),
  winner_recipients_pct: z.number().min(0).max(100).default(100),
});

interface RawClient {
  request: <T>(method: string, path: string, opts?: { body?: unknown }) => Promise<T>;
}

export function campaignTools(client: PostwaveClient): AnyToolDef[] {
  const raw = client as unknown as RawClient;
  return [
    {
      name: "campaign_create",
      description:
        "Draft a single-variant campaign. Body is MJML. Audience can be a list_id or a segment_id. Returns the campaign as a draft — call campaign_send to actually send.",
      schema: z.object({
        subject: z.string(),
        body_mjml: z.string(),
        audience: AudienceSchema,
      }),
      handler: async (input) => raw.request("POST", "/api/v1/campaigns", { body: input }),
    },
    {
      name: "campaign_send",
      description:
        "Send a draft campaign immediately. The campaign must already be in 'draft' status with an audience attached.",
      schema: z.object({
        campaign_id: z.string(),
      }),
      handler: async ({ campaign_id }) =>
        raw.request("POST", `/api/v1/campaigns/${encodeURIComponent(campaign_id)}/send`),
    },
    {
      name: "campaign_create_ab",
      description:
        "Configure an A/B test for a campaign: upsert 2-4 variants and (optionally) the settings (winner_metric, evaluation_window_hours, winner_recipients_pct). Each variant has a weight (any non-negative number — they'll be normalized).",
      schema: z.object({
        campaign_id: z.string(),
        variants: z.array(VariantSchema).min(2).max(4),
        settings: ABSettingsSchema.optional(),
      }),
      handler: async ({ campaign_id, variants, settings }) => {
        try {
          const created = await client.campaignsAB.createVariants(campaign_id, variants);
          let appliedSettings = null;
          if (settings) {
            appliedSettings = await client.campaignsAB.setABSettings(campaign_id, settings);
          }
          return { variants: created, settings: appliedSettings };
        } catch (err) {
          throw wrapErr("campaign_create_ab", err);
        }
      },
    },
    {
      name: "campaign_ab_results",
      description:
        "Per-variant aggregate results for an A/B campaign. Returns settings, all variants, per-variant counts (recipients, opens, clicks, unsubscribes, complaints), and the winning variant id once a winner has been decided (95% confidence two-proportion z-test).",
      schema: z.object({
        campaign_id: z.string(),
      }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.campaignsAB.getAB(campaign_id);
        } catch (err) {
          throw wrapErr("campaign_ab_results", err);
        }
      },
    },
    {
      name: "send_test_email",
      description:
        "Send a one-off transactional message via the tenant's sending pipeline. Useful for previewing a draft body in a real inbox before promoting it to a campaign. Provide either body_html OR body_mjml (server compiles MJML).",
      schema: z
        .object({
          to_email: z.string().email(),
          subject: z.string().min(1),
          body_html: z.string().optional(),
          body_mjml: z.string().optional(),
        })
        .refine((v) => Boolean(v.body_html || v.body_mjml), {
          message: "Provide body_html or body_mjml",
        }),
      handler: async ({ to_email, subject, body_html, body_mjml }) => {
        try {
          return await client.campaigns.sendTest({
            toEmail: to_email,
            subject,
            bodyHtml: body_html,
            bodyMjml: body_mjml,
          });
        } catch (err) {
          throw wrapErr("send_test_email", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
