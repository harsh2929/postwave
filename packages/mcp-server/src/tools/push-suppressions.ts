// SPDX-License-Identifier: MIT

import type { PostwaveClient } from "@postwave/sdk";
import { z } from "zod";

import type { AnyToolDef } from "../lib/register.js";

const TenantUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const RowUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const Platform = z.enum(["apns", "fcm", "web"]);
const Reason = z.enum([
  "manual",
  "unregistered",
  "expired",
  "complaint",
  "user_opt_out",
]);
const Cursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/u);
const HashPrefix = z.string().regex(/^[0-9a-f]{8,16}$/u);
const Token = z.string().superRefine((value, context) => {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (
    bytes < 20 ||
    bytes > 4096 ||
    value.trim() !== value ||
    /\s/u.test(value) ||
    /\p{Cc}/u.test(value) ||
    /[\ud800-\udfff]/u.test(value)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "device_token must be the exact 20–4096 UTF-8 bytes without whitespace or controls",
    });
  }
});

const AddItem = z
  .object({
    device_token: Token,
    platform: Platform,
    reason: z.literal("manual").optional(),
  })
  .strict();
const RemoveItem = z
  .object({
    id: RowUuid,
    expected_version: z.number().int().safe().positive(),
  })
  .strict();

function rejectDuplicateAdds(
  items: Array<{ device_token: string; platform: "apns" | "fcm" | "web" }>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const key = `${item.platform}\u0000${item.device_token}`;
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "platform/device_token identities must be unique",
        path: [index],
      });
    }
    seen.add(key);
  }
}

function rejectDuplicateRemovals(
  items: Array<{ id: string }>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "suppression ids must be unique",
        path: [index],
      });
    }
    seen.add(item.id);
  }
}

function wrap(name: string, error: unknown): Error {
  return new Error(
    `${name}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function pushSuppressionTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "push_suppression_list",
      description:
        "Exact-admin read of one tenant-bound Route43 authority snapshot page. Returns only 16-hex display fingerprints and an explicit opaque cursor, never raw tokens or full digests. Customer runtime, audience materialization, live APNs/FCM providers, automatic provider feedback, and Web delivery remain release-held; do not interpret registry rows as evidence that a live send ran.",
      schema: z
        .object({
          tenant_id: TenantUuid,
          platform: Platform.optional(),
          reason: Reason.optional(),
          hash_prefix: HashPrefix.optional(),
          cursor: Cursor.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      requiredScopes: ["admin"],
      annotations: {
        title: "List push suppression authorities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ tenant_id, hash_prefix, ...input }) => {
        try {
          return await client.pushSuppressions.list({
            tenantId: tenant_id,
            ...input,
            ...(hash_prefix ? { hashPrefix: hash_prefix } : {}),
          });
        } catch (error) {
          throw wrap("push_suppression_list", error);
        }
      },
    },
    {
      name: "push_suppression_add",
      description:
        "Exact-admin add or reassert of one reversible manual/dashboard authority. The raw customer token is sensitive: obtain explicit user approval, never place it in logs or evidence, and pass its exact bytes without normalization. This cannot mint provider, user, complaint, or legacy authority.",
      schema: z
        .object({
          tenant_id: TenantUuid,
          device_token: Token,
          platform: Platform,
          confirm_manual_hold: z.literal(true),
        })
        .strict(),
      requiredScopes: ["admin"],
      annotations: {
        title: "Add manual push hold",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ tenant_id, device_token, platform }) => {
        try {
          return await client.pushSuppressions.add(
            { device_token, platform, reason: "manual" },
            { tenantId: tenant_id },
          );
        } catch (error) {
          throw wrap("push_suppression_add", error);
        }
      },
    },
    {
      name: "push_suppression_remove",
      description:
        "Exact-admin compare-and-swap removal of one reviewed manual/dashboard authority. Locked authorities remain fail-closed. Success may return stillSuppressed=true when another independent authority remains.",
      schema: z
        .object({
          tenant_id: TenantUuid,
          suppression_id: RowUuid,
          expected_version: z.number().int().safe().positive(),
          confirm_manual_hold_removal: z.literal(true),
        })
        .strict(),
      requiredScopes: ["admin"],
      annotations: {
        title: "Remove manual push hold",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ tenant_id, suppression_id, expected_version }) => {
        try {
          return await client.pushSuppressions.remove(
            suppression_id,
            expected_version,
            { tenantId: tenant_id },
          );
        } catch (error) {
          throw wrap("push_suppression_remove", error);
        }
      },
    },
    {
      name: "push_suppression_bulk_import",
      description:
        "Exact-admin atomic add/reassert of 1–100 unique manual/dashboard authorities. Raw tokens are sensitive and must never enter logs or durable evidence. Any invalid, duplicate, storage, or audit outcome rolls back every item.",
      schema: z
        .object({
          tenant_id: TenantUuid,
          items: z
            .array(AddItem)
            .min(1)
            .max(100)
            .superRefine(rejectDuplicateAdds),
          confirm_manual_holds: z.literal(true),
        })
        .strict(),
      requiredScopes: ["admin"],
      annotations: {
        title: "Bulk add manual push holds",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ tenant_id, items }) => {
        try {
          return await client.pushSuppressions.bulkImport(
            items.map(
              (item: {
                device_token: string;
                platform: "apns" | "fcm" | "web";
                reason?: "manual";
              }) => ({ ...item, reason: "manual" as const }),
            ),
            { tenantId: tenant_id },
          );
        } catch (error) {
          throw wrap("push_suppression_bulk_import", error);
        }
      },
    },
    {
      name: "push_suppression_bulk_remove",
      description:
        "Exact-admin atomic compare-and-swap removal of 1–100 unique reviewed manual/dashboard authorities. One stale, missing, locked, invalid, storage, or audit outcome rolls back every removal; each receipt reports remaining-authority truth.",
      schema: z
        .object({
          tenant_id: TenantUuid,
          items: z
            .array(RemoveItem)
            .min(1)
            .max(100)
            .superRefine(rejectDuplicateRemovals),
          confirm_manual_hold_removals: z.literal(true),
        })
        .strict(),
      requiredScopes: ["admin"],
      annotations: {
        title: "Bulk remove manual push holds",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ tenant_id, items }) => {
        try {
          return await client.pushSuppressions.bulkRemove(items, {
            tenantId: tenant_id,
          });
        } catch (error) {
          throw wrap("push_suppression_bulk_remove", error);
        }
      },
    },
  ];
}
