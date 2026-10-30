// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const CSV_BYTE_CAP = 10 * 1024 * 1024;

export function analyticsTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "campaign_link_report",
      description:
        "Per-link click breakdown for one campaign. Returns each clicked URL with total clicks, distinct unique clickers, and CTR (unique clickers / total recipients). Sorted by clicks desc.",
      schema: z.object({ campaign_id: z.string() }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.analytics.linkReport(campaign_id);
        } catch (err) {
          throw wrapErr("campaign_link_report", err);
        }
      },
    },
    {
      name: "report_export_csv",
      description:
        "Stream the per-subscriber lifecycle CSV for a campaign (sent/delivered/opened/clicked/bounced/complained/unsubscribed). Bodies larger than ~10 MiB are truncated and the response includes a `truncated: true` flag plus the row count so the caller can re-issue with offset/limit.",
      schema: z.object({
        campaign_id: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50000).optional(),
      }),
      handler: async ({ campaign_id, offset, limit }) => {
        try {
          const result = await client.analytics.reportCSV(campaign_id, { offset, limit });
          if (result.csv.length > CSV_BYTE_CAP) {
            return {
              csv: result.csv.slice(0, CSV_BYTE_CAP),
              truncated: true,
              note: "csv exceeded 10 MiB; re-issue with ?offset/limit to paginate",
              bytes: result.csv.length,
            };
          }
          return { csv: result.csv, truncated: false, bytes: result.csv.length };
        } catch (err) {
          throw wrapErr("report_export_csv", err);
        }
      },
    },
    {
      name: "campaigns_compare",
      description:
        "Side-by-side comparison of up to 25 campaigns. Returns per-campaign open_rate, click_rate, bounce_rate, complaint_rate, unsub_rate, and total_recipients.",
      schema: z.object({ campaign_ids: z.array(z.string()).min(1).max(25) }),
      handler: async ({ campaign_ids }) => {
        try {
          return await client.analytics.compare(campaign_ids);
        } catch (err) {
          throw wrapErr("campaigns_compare", err);
        }
      },
    },
    {
      name: "campaign_geography",
      description:
        "Per-country open/click totals for one campaign. Country is derived from the IP recorded at engagement time; rows without a resolved country bucket into 'unknown'.",
      schema: z.object({ campaign_id: z.string() }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.analytics.geography(campaign_id);
        } catch (err) {
          throw wrapErr("campaign_geography", err);
        }
      },
    },
    {
      name: "campaign_devices",
      description:
        "Per-mail-client open/click totals for one campaign. Client family is parsed from User-Agent: Gmail / Outlook / Apple Mail / Yahoo / Other.",
      schema: z.object({ campaign_id: z.string() }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.analytics.devices(campaign_id);
        } catch (err) {
          throw wrapErr("campaign_devices", err);
        }
      },
    },
    {
      name: "campaign_bounces",
      description:
        "Bounce category breakdown for one campaign: hard, soft, spam_trap, total. Categorization heuristics: 5xx -> hard, 4xx -> soft, 'trap' substring -> spam_trap.",
      schema: z.object({ campaign_id: z.string() }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.analytics.bounces(campaign_id);
        } catch (err) {
          throw wrapErr("campaign_bounces", err);
        }
      },
    },
    {
      name: "analytics_cohorts",
      description:
        "Cohort matrix: subscribers grouped by signup month for the past 12 cohorts, with the chosen metric (open_rate, click_rate, retention) over the first N weeks since signup. Default weeks=12.",
      schema: z.object({
        bucket: z.literal("month").optional(),
        metric: z.enum(["open_rate", "click_rate", "retention"]).optional(),
        weeks: z.number().int().min(1).max(26).optional(),
      }),
      handler: async ({ bucket, metric, weeks }) => {
        try {
          return await client.analytics.cohorts({ bucket, metric, weeks });
        } catch (err) {
          throw wrapErr("analytics_cohorts", err);
        }
      },
    },
    {
      name: "campaign_revenue",
      description:
        "Stripe-attributed revenue for one campaign. Attributes a paid signup or upgrade to the most recent campaign opened by the subscriber within 7 days before payment. Returns {attributed_revenue_cents, currency, conversions, attribution_window_days}; `note: 'no_billing_data'` if the underlying paid_subscriptions table is not present.",
      schema: z.object({ campaign_id: z.string() }),
      handler: async ({ campaign_id }) => {
        try {
          return await client.analytics.revenue(campaign_id);
        } catch (err) {
          throw wrapErr("campaign_revenue", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
