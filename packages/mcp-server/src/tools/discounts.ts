// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function discountTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "discount_list",
      description:
        "List one bounded page of sanitized local discount-history records newest first. Redeemable codes, tenant/provider identifiers, and subscriber identities are omitted; this is not checkout truth.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:reports"],
      schema: z.object({
        record_id: z
          .string()
          .uuid()
          .optional()
          .describe("Exact opaque discount record UUID; never a redeemable code."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum records to return (1-100; default 50)."),
        offset: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe("Number of newest records to skip (0-10000; default 0)."),
      }),
      handler: async ({ record_id, limit, offset }) => {
        try {
          return await client.discounts.list({ record_id, limit, offset });
        } catch (err) {
          throw wrap("discount_list", err);
        }
      },
    },
    {
      name: "discount_redemptions",
      description:
        "List a bounded page of PII-free redemption events for an opaque discount-history record UUID. Returns only redemption time and whether a subscriber record was linked.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:reports"],
      schema: z.object({
        record_id: z
          .string()
          .uuid()
          .describe("Opaque discount record UUID returned by discount_list; never a redeemable code."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum events to return (1-100; default 50)."),
        offset: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe("Number of newest events to skip (0-10000; default 0)."),
      }),
      handler: async ({ record_id, limit, offset }) => {
        try {
          return await client.discounts.redemptions(record_id, {
            limit,
            offset,
          });
        } catch (err) {
          throw wrap("discount_redemptions", err);
        }
      },
    },
  ];
}

function wrap(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
