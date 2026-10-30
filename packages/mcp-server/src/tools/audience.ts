// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function audienceTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "list_create",
      description:
        "Create a Listmonk audience list. type defaults to 'private', optin defaults to 'single'. Returns the upstream Listmonk envelope.",
      schema: z.object({
        name: z.string().min(1),
        type: z.enum(["private", "public"]).optional(),
        optin: z.enum(["single", "double"]).optional(),
        tags: z.array(z.string()).optional(),
        description: z.string().optional(),
      }),
      handler: async (args) => client.lists.create(args),
    },
    {
      name: "list_list",
      description:
        "List audience lists for the tenant. Returns the upstream Listmonk envelope; consume `data.results` for the array.",
      schema: z.object({}),
      handler: async () => client.lists.list(),
    },
    {
      name: "list_members",
      description:
        "The subscribers that belong to ONE list, paginated. This is the only list-scoped membership read — subscribers_list has no list filter and returns the whole tenant. `id` accepts a Moosewave UUID or a legacy Listmonk numeric id. Optional q (email substring), status (enabled|disabled|blocklisted|unconfirmed), page, per_page (max 200).",
      schema: z.object({
        id: z.union([z.number().int(), z.string().min(1)]),
        q: z.string().min(1).optional(),
        status: z
          .enum(["enabled", "disabled", "blocklisted", "unconfirmed"])
          .optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(200).optional(),
      }),
      handler: async ({ id, ...params }) => client.lists.members(id, params),
    },
    {
      name: "list_delete",
      description: "Delete an audience list by numeric Listmonk id.",
      schema: z.object({ id: z.union([z.number().int(), z.string()]) }),
      handler: async ({ id }) => client.lists.delete(id),
    },
    {
      name: "tag_create",
      description:
        "Register a tenant-scoped tag in the catalog. Returns the persisted row.",
      schema: z.object({ name: z.string().min(1) }),
      handler: async ({ name }) => client.tags.create(name),
    },
    {
      name: "tag_list",
      description: "List tenant-scoped tags ordered by name.",
      schema: z.object({}),
      handler: async () => client.tags.list(),
    },
    {
      name: "tag_delete",
      description: "Delete a catalog tag by id. Does not strip the tag from existing subscribers.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => client.tags.delete(id),
    },
    {
      name: "suppression_import",
      description:
        "Bulk import addresses into the suppression list. Conflicts are skipped, not erred. Returns {imported, skipped, errors}.",
      schema: z.object({
        emails: z.array(z.string().email()).min(1).max(50000),
        reason: z.string().optional(),
      }),
      handler: async (args) => client.suppressions.bulkImport(args),
    },
    {
      name: "subscribers_import_csv",
      description:
        "Import subscribers from CSV. Pass the CSV body as a base64 string. Headers must include `email`; `name` and any extra columns are folded into custom_fields. Upserts in batches of 500.",
      schema: z.object({
        filename: z.string().default("upload.csv"),
        csv_base64: z.string().min(1),
      }),
      handler: async ({ filename, csv_base64 }) => {
        const bytes = Uint8Array.from(Buffer.from(csv_base64, "base64"));
        return client.subscribers.importCsv(filename, bytes);
      },
    },
    {
      name: "subscribers_export_csv",
      description:
        "Export the tenant's subscribers as CSV. Truncates at ~5MB; use `limit` to bound row count for large audiences and paginate from the dashboard for the full set.",
      schema: z.object({ limit: z.number().int().min(1).max(100000).optional() }),
      handler: async ({ limit }) => {
        const csv = await client.subscribers.exportCsv({ limit });
        const max = 5 * 1024 * 1024;
        if (csv.length > max) {
          return {
            csv: csv.slice(0, max),
            truncated: true,
            note: `output capped at ${max} bytes; pass a smaller \`limit\` or page from the dashboard`,
          };
        }
        return { csv, truncated: false };
      },
    },
    {
      name: "subscriber_merge",
      description:
        "Merge a duplicate subscriber into a primary. Moves events, suppressions, tags, and custom fields under the primary id, then deletes the duplicate. Wrapped in a single transaction.",
      schema: z.object({
        primary_id: z.string().min(1),
        duplicate_id: z.string().min(1),
      }),
      handler: async (args) => client.subscribers.merge(args),
    },
    {
      name: "subscriber_activity",
      description:
        "Recent engagement events for one subscriber (newest first). Default limit 50 (max 500). Pass `before` (RFC3339) to page backwards in time.",
      schema: z.object({
        id: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
        before: z.string().datetime().optional(),
      }),
      handler: async ({ id, limit, before }) =>
        client.subscribers.activity(id, { limit, before }),
    },
    {
      name: "subscriber_engagement",
      description:
        "Compute the 0-100 engagement score for one subscriber, or a batch (pass `ids` instead of `id`). Window is the trailing 90 days. Score is cached on the subscriber row.",
      schema: z
        .object({
          id: z.string().optional(),
          ids: z.array(z.string()).optional(),
        })
        .refine((v) => Boolean(v.id) !== Boolean(v.ids && v.ids.length), {
          message: "pass exactly one of `id` or `ids`",
        }),
      handler: async ({ id, ids }) => {
        if (ids && ids.length) return client.subscribers.engagementBatch(ids);
        return client.subscribers.engagement(id!);
      },
    },
  ];
}
