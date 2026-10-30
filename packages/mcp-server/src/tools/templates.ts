// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const TemplateCategoryEnum = z.enum([
  "welcome",
  "course_launch",
  "product_launch",
  "re_engagement",
  "newsletter_series",
  "saas_onboarding",
  "partnership",
  "year_in_review",
  "crisis",
  "cold_warm",
  "sales",
  "community",
  "misc",
]);

const IdOrSlug = z.string().trim().min(1).max(200);

const TemplateVariable = z.object({
  key: z.string().min(1).max(80),
  label: z.string().max(200),
  required: z.boolean(),
  example: z.string().max(2_000),
});

const TemplateEmail = z.object({
  position: z.number().int().min(1),
  delay_seconds: z.number().int().min(0),
  subject_skeleton: z.string().max(2_000),
  body_skeleton: z.string().max(200_000),
  notes: z.string().max(4_000),
});

const TemplatePerformance = z.object({
  open_rate: z.number(),
  click_rate: z.number(),
  conversion_rate: z.number(),
  sample_size: z.number().int().min(0),
});

// Create requires the full template shape the backend persists. id is
// server-assigned, so it is optional on create (ignored if supplied).
const TemplateCreateSchema = z.object({
  id: z.string().max(200).optional(),
  slug: z.string().trim().min(1).max(200),
  category: TemplateCategoryEnum,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4_000),
  length: z.number().int().min(1),
  variables: z.array(TemplateVariable),
  emails: z.array(TemplateEmail).min(1),
  tags: z.array(z.string().max(80)),
  author: z.string().max(200),
  performance: TemplatePerformance,
});

// Update is a partial of the same shape, addressed by id-or-slug.
const TemplateUpdateSchema = z.object({
  id_or_slug: IdOrSlug,
  patch: z
    .object({
      slug: z.string().trim().min(1).max(200).optional(),
      category: TemplateCategoryEnum.optional(),
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(4_000).optional(),
      length: z.number().int().min(1).optional(),
      variables: z.array(TemplateVariable).optional(),
      emails: z.array(TemplateEmail).optional(),
      tags: z.array(z.string().max(80)).optional(),
      author: z.string().max(200).optional(),
      performance: TemplatePerformance.optional(),
    })
    .describe("Fields to change. Omitted fields are left untouched."),
});

export function templateTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "template_list",
      description:
        "List the tenant's saved voice templates. Optionally filter by category (welcome, sales, newsletter_series, etc.). Returns the full template objects including variables, email skeletons, and historical performance.",
      schema: z.object({ category: TemplateCategoryEnum.optional() }),
      annotations: { readOnlyHint: true },
      handler: async ({ category }) => {
        try {
          return await client.templates.list(category as never);
        } catch (err) {
          throw wrapErr("template_list", err);
        }
      },
    },
    {
      name: "template_get",
      description:
        "Fetch a single saved template by its id or slug. Returns the full template object (category, variables, per-position email skeletons, tags, author, performance).",
      schema: z.object({ id_or_slug: IdOrSlug }),
      annotations: { readOnlyHint: true },
      handler: async ({ id_or_slug }) => {
        try {
          return await client.templates.get(id_or_slug);
        } catch (err) {
          throw wrapErr("template_get", err);
        }
      },
    },
    {
      name: "template_create",
      description:
        "Create and save a new voice template. Supply slug, category, name, the variable list, and at least one email skeleton (position + subject/body skeletons). The created template can then drive sequence_generate.",
      schema: TemplateCreateSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      handler: async (input) => {
        try {
          return await client.templates.create(input as never);
        } catch (err) {
          throw wrapErr("template_create", err);
        }
      },
    },
    {
      name: "template_update",
      description:
        "Update an existing saved template in place, addressed by id or slug. Only the fields you include in `patch` are changed; everything else is preserved.",
      schema: TemplateUpdateSchema,
      annotations: { idempotentHint: true },
      handler: async ({ id_or_slug, patch }) => {
        try {
          return await client.templates.update(id_or_slug, patch as never);
        } catch (err) {
          throw wrapErr("template_update", err);
        }
      },
    },
    {
      name: "template_delete",
      description:
        "Permanently delete a saved template by id or slug. This cannot be undone; sequences already generated from it are unaffected.",
      schema: z.object({ id_or_slug: IdOrSlug }),
      annotations: { destructiveHint: true, idempotentHint: true },
      handler: async ({ id_or_slug }) => {
        try {
          await client.templates.delete(id_or_slug);
          return { deleted: true, id_or_slug };
        } catch (err) {
          throw wrapErr("template_delete", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
