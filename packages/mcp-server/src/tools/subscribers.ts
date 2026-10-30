// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const SegmentNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    op: z.enum(["and", "or", "not", "leaf"]),
    field: z.string().optional(),
    comparator: z.string().optional(),
    value: z.unknown().optional(),
    children: z.array(SegmentNodeSchema).optional(),
  }),
);

export function subscriberTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "subscribers_list",
      description:
        "Paginated subscriber list across the WHOLE tenant. Optional filters: q, status, page, per_page. There is no list filter here — use list_members to read the subscribers of one list. Returns items with email, status, consent metadata, tags, custom fields.",
      schema: z.object({
        q: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(500).optional(),
      }),
      handler: async (args) => client.subscribers.list(args),
    },
    {
      name: "subscribers_search",
      description:
        "Full-text search subscribers by email, name, or custom fields. Returns up to 100 matches.",
      schema: z.object({
        query: z.string().min(1),
      }),
      handler: async ({ query }) => client.subscribers.search(query),
    },
    {
      name: "subscriber_create",
      description:
        "Create a single subscriber. Email is required. Custom fields and tags are optional. Idempotent on email (returns existing record if already present).",
      schema: z.object({
        email: z.string().email(),
        custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        tags: z.array(z.string()).optional(),
      }),
      handler: async (args) =>
        client.subscribers.create({
          email: args.email,
          custom_fields: args.custom_fields ?? {},
          tags: args.tags ?? [],
        } as never),
    },
    {
      name: "subscriber_suppress",
      description:
        "Move a subscriber to the suppression list. Idempotent: subsequent calls are no-ops. Resolves the email to its subscriber ID first.",
      schema: z.object({
        email: z.string().email(),
      }),
      handler: async ({ email }) => {
        const page = await client.subscribers.search(email);
        const match = page.items.find((s) => s.email.toLowerCase() === email.toLowerCase());
        if (!match) throw new Error(`subscriber not found: ${email}`);
        const id = (match as { id?: string }).id ?? match.email;
        await client.subscribers.suppress(id);
        return { email, status: "suppressed" };
      },
    },
    {
      name: "custom_field_create",
      description:
        "Create a tenant-scoped custom field on the subscriber schema. `key` is the machine slug, `label` is the human display name, `type` is one of string/number/boolean/date. Returns the persisted field.",
      schema: z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        type: z.enum(["string", "number", "boolean", "date"]),
      }),
      handler: async (args) => client.subscribers.customFieldCreate(args),
    },
    {
      name: "segment_create",
      description:
        "Persist a saved segment from a SegmentNode AST. The AST follows @postwave/schema (and/or/not/leaf with field+comparator+value). Optional description is shown in the UI. Returns the segment id.",
      schema: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        query_ast: SegmentNodeSchema,
      }),
      handler: async ({ name, description, query_ast }) =>
        client.segments.create({ name, description, query_ast }),
    },
    {
      name: "segment_list",
      description:
        "List saved segments for the tenant, cursor-paginated. Returns id, name, query_ast, and created_at for each.",
      schema: z.object({
        cursor: z.string().optional(),
      }),
      handler: async ({ cursor }) => client.segments.list({ cursor }),
    },
    {
      name: "segment_delete",
      description:
        "Delete a saved segment by id. Refused with 409 segment_in_use while a campaign that hasn't started sending uses the segment as its audience; the error names those campaigns, so move them to another audience (or delete them) and retry. A segment that no longer exists returns 404 not_found. Does not affect subscribers; only removes the saved query definition.",
      schema: z.object({
        id: z.string().min(1),
      }),
      handler: async ({ id }) => client.segments.delete(id),
    },
    {
      name: "segment_compile_from_text",
      description:
        "Compile a natural-language audience description (e.g. 'people who opened the last campaign but did not click') into a canonical SegmentNode AST. Pair with segment_create or segment_eval.",
      schema: z.object({
        text: z.string().min(1),
      }),
      handler: async ({ text }) => client.segments.compileFromNaturalLanguage(text),
    },
    {
      name: "segment_eval",
      description:
        "Evaluate a canonical Segment AST against the subscriber base. Returns the matching count and a sample of up to 25 subscriber records. Useful for previewing audience size before sending.",
      schema: z.object({
        segment_ast: SegmentNodeSchema.describe("Canonical AST per @postwave/schema."),
      }),
      handler: async ({ segment_ast }) => {
        // The segment evaluator endpoint is not yet a top-level resource on the
        // SDK; it lives behind /api/v1/segments/eval. We use the low-level
        // request method explicitly so this works the day the SDK adds the
        // typed wrapper.
        return await (client as unknown as {
          request: <T>(m: string, p: string, opts?: { body?: unknown }) => Promise<T>;
        }).request("POST", "/api/v1/segments/eval", { body: { ast: segment_ast } });
      },
    },
    {
      name: "batch_subscriber_upsert",
      description:
        "Upsert up to 1000 subscriber records in one call. Each record: {email (required), status?, first_name?, last_name?, custom_fields?, merge_fields?, tags?}. Idempotent on email; returns per-record created/updated/error outcomes. Use this instead of looping subscriber_create.",
      schema: z.object({
        subscribers: z
          .array(
            z.object({
              email: z.string().email(),
              status: z.string().optional(),
              first_name: z.string().optional(),
              last_name: z.string().optional(),
              custom_fields: z
                .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                .optional(),
              merge_fields: z
                .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                .optional(),
              tags: z.array(z.string()).optional(),
            }),
          )
          .min(1)
          .max(1000),
      }),
      handler: async (args) =>
        client.subscribers.batchUpsert(args.subscribers as never),
    },
  ];
}
