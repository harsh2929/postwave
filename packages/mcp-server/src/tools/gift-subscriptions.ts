// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function giftSubscriptionTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "gift_subscription_list",
      description:
        "List bounded, identity-minimized historical gift lifecycle records. Personal identities and provider credentials are not returned.",
      schema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
        q: z
          .string()
          .min(8)
          .max(32)
          .regex(/^[0-9A-Fa-f]{8,32}$/u)
          .optional(),
        filter: z
          .enum([
            "all",
            "open",
            "pending",
            "redeemed",
            "closed",
            "cancelled",
            "expired",
            "refunded",
          ])
          .optional(),
        sort: z.enum(["newest", "oldest", "duration", "status"]).optional(),
      }),
      handler: async (args) => {
        try {
          return await client.giftSubscriptions.list(args);
        } catch (err) {
          throw wrap("gift_subscription_list", err);
        }
      },
    },
  ];
}

function wrap(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
