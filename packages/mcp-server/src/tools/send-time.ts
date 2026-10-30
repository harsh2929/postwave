// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function sendTimeTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "subscriber_best_send_time",
      description:
        "Read the cached modal hour-of-week (0-167, Sunday 00:00 UTC = 0) at which a subscriber has historically opened email. Cold subscribers (< 5 opens) return -1.",
      schema: z.object({ subscriber_id: z.string().min(1) }),
      handler: async ({ subscriber_id }) => {
        try {
          return await client.sendTime.getBestTime(subscriber_id);
        } catch (err) {
          throw wrap("subscriber_best_send_time", err);
        }
      },
    },
    {
      name: "campaign_schedule_by_best_time",
      description:
        "Reschedule a campaign to send each recipient at their best hour-of-week within the next `within_days` window. Recipients without a cached best hour fall back to the tenant mean.",
      schema: z.object({
        campaign_id: z.string().min(1),
        within_days: z.number().int().min(1).max(30).default(7),
      }),
      handler: async ({ campaign_id, within_days }) => {
        try {
          return await client.sendTime.scheduleCampaignByBestTime(campaign_id, within_days);
        } catch (err) {
          throw wrap("campaign_schedule_by_best_time", err);
        }
      },
    },
  ];
}

function wrap(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
