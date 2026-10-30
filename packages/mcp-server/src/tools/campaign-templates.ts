// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import { compactCampaignTemplateSearch } from "../lib/campaign-template-format.js";
import { planExactTemplateChange } from "../lib/campaign-template-exact-change.js";
import type { AnyToolDef } from "../lib/register.js";

const TemplateId = z.string().trim().min(1).max(256);
// Reads and draft creation resolve a template by its ID or its slug, so an
// agent can use the stable name it saw in a search row or a doc.
const TemplateIdOrSlug = TemplateId.describe(
  "The template's ID or its slug (for example newsletter-one-link).",
);
const Slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/);
const Goal = z.enum([
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
]);
const Source = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe(
    "Ownership source (all/platform/mine/team) or an external provider slug.",
  );
const FlexibleObject = z.record(z.unknown());
const Variable = z.record(z.unknown());
const ReferenceTemplateIds = z
  .array(TemplateId)
  .max(3)
  .describe("Up to three internal visual template IDs to use as references.");
const AdditionalReferenceTemplateIds = z
  .array(TemplateId)
  .max(2)
  .describe("Up to two additional internal visual template IDs.");
const TemplateETag = z
  .string()
  .max(512)
  .regex(/^"[^"\r\n]+"$/)
  .describe(
    "Exact strong etag returned by campaign_template_get or the latest mutation. Do not reconstruct it from version.",
  );
const ExactChangeSchema = z.object({
  template_id: TemplateId,
  if_match: TemplateETag,
  format: z.enum(["html", "mjml"]),
  find: z.string().min(1).max(64 * 1024),
  replace: z.string().max(64 * 1024),
}).strict();
const CollectionETag = z
  .string()
  .max(512)
  .regex(/^"campaign-template-collection:[^"\\\s,]+:v[1-9]\d*"$/)
  .describe(
    "Exact strong etag returned by campaign_template_collection_get or the latest collection mutation. Pass it unchanged as if_match.",
  );
const SavedSearchETag = z
  .string()
  .max(512)
  .regex(/^"campaign-template-saved-search:[^"\\\s,]+:v[1-9]\d*"$/)
  .describe(
    "Exact strong etag returned by campaign_template_saved_search_get or the latest saved-search mutation. Pass it unchanged as if_match.",
  );
const TemplateRevisionVersion = z.number().int().min(1);
const DesignId = z.string().trim().min(1).max(256);
const DesignRevision = z.number().int().min(1);
const DesignOutputHash = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/)
  .describe("Exact output_hash returned with the reviewed design revision.");
const IdempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001F\u007F-\u009F]+$/u)
  .describe(
    "Caller-stable key for this exact mutation. Reuse it only to retry an unchanged request after a lost or uncertain response; use a new key when any input changes.",
  );
const PageCursor = z
  .string()
  .trim()
  .min(16)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe(
    "Opaque continuation token returned as next_cursor by a prior search. Pass it unchanged with the same filters and sort.",
  );

const SearchSchema = z.object({
  q: z.string().trim().min(1).max(500).optional(),
  goal: Goal.optional(),
  category: z.string().trim().min(1).max(100).optional(),
  source: Source.optional(),
  provider: z.string().trim().min(1).max(100).optional(),
  style: z.string().trim().min(1).max(100).optional(),
  layout: z.string().trim().min(1).max(100).optional(),
  industry: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(["editable", "reference"]).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  featured: z.boolean().optional(),
  favorited: z
    .boolean()
    .optional()
    .describe(
      "True returns only favorites; false applies no favorites filter.",
    ),
  archived: z.enum(["active", "archived", "all"]).optional(),
  sort: z.enum(["recommended", "name", "most_used"]).optional(),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("One-based catalog page. Takes precedence over cursor."),
  cursor: PageCursor.optional(),
  per_page: z.number().int().min(1).max(100).optional(),
});

const CreateSchema = z
  .object({
    slug: Slug,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4_000).optional(),
    category: z.string().trim().max(100).optional(),
    goal: Goal.optional(),
    subject: z.string().max(998).optional(),
    preview_text: z.string().max(500).optional(),
    body_html: z.string().max(1_048_576).optional(),
    body_mjml: z.string().max(1_048_576).optional(),
    variables: z.array(Variable).max(100).optional(),
    tags: z.array(z.string().max(120)).max(50).optional(),
    style: z.string().trim().max(100).optional(),
    layout: z.string().trim().max(100).optional(),
    industry: z.string().trim().max(100).optional(),
    thumbnail_url: z.string().url().max(4_000).optional(),
    design_metadata: FlexibleObject.optional(),
  })
  .strict();

const CollectionName = z.string().trim().min(1).max(120);
const CollectionDescription = z.string().max(1_000);
const CollectionTemplateIds = z
  .array(TemplateId)
  .max(100)
  .refine((values) => new Set(values).size === values.length, {
    message: "template_ids must be unique",
  });
const SavedSearchFiltersSchema = SearchSchema.omit({
  cursor: true,
  page: true,
  per_page: true,
}).strict();

const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4_000).optional(),
    category: z.string().trim().max(100).optional(),
    goal: Goal.optional(),
    subject: z.string().max(998).optional(),
    preview_text: z.string().max(500).optional(),
    body_html: z.string().max(1_048_576).optional(),
    body_mjml: z.string().max(1_048_576).optional(),
    variables: z.array(Variable).max(100).optional(),
    tags: z.array(z.string().max(120)).max(50).optional(),
    style: z.string().trim().max(100).optional(),
    layout: z.string().trim().max(100).optional(),
    industry: z.string().trim().max(100).optional(),
    thumbnail_url: z.string().url().max(4_000).optional(),
    design_metadata: FlexibleObject.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must contain at least one editable field",
  });

const AdaptSchema = z.object({
  idempotency_key: IdempotencyKey,
  template_id: TemplateId,
  instructions: z.string().trim().min(1).max(4_000).optional(),
  tone: z.string().trim().max(500).optional(),
  fidelity: z.enum(["close", "balanced", "inspired"]).optional(),
  subject: z.string().max(998).optional(),
  content: FlexibleObject.optional(),
  brand: FlexibleObject.optional(),
  variables: FlexibleObject.optional(),
  reference_template_ids: AdditionalReferenceTemplateIds.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  preview_text: z.string().max(500).optional(),
  audience: z.string().max(1_500).optional(),
  industry: z.string().trim().max(120).optional(),
  style: z.string().trim().max(120).optional(),
  layout: z.string().trim().max(120).optional(),
  sections: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  cta: z.string().trim().max(1_500).optional(),
});

const GenerateSchema = z.object({
  idempotency_key: IdempotencyKey,
  brief: z.string().trim().min(1).max(8_000),
  kind: z.enum(["newsletter", "promo", "announcement"]).optional(),
  tone: z.string().trim().max(500).optional(),
  fidelity: z.enum(["close", "balanced", "inspired"]).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  goal: Goal.optional(),
  category: z.string().trim().max(120).optional(),
  subject: z.string().max(998).optional(),
  preview_text: z.string().max(500).optional(),
  audience: z.string().max(1_500).optional(),
  style: z.string().trim().max(120).optional(),
  layout: z.string().trim().max(120).optional(),
  industry: z.string().trim().max(120).optional(),
  brand: FlexibleObject.optional(),
  content: FlexibleObject.optional(),
  variables: FlexibleObject.optional(),
  sections: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  cta: z.string().trim().max(1_500).optional(),
  reference_template_ids: ReferenceTemplateIds.optional(),
});

const DesignCommitSchema = z.object({
  idempotency_key: IdempotencyKey,
  design_id: DesignId,
  revision: DesignRevision,
  output_hash: DesignOutputHash,
});

const SaveReviewedDesignSchema = DesignCommitSchema.extend({
  slug: Slug,
  name: z.string().trim().min(1).max(200).optional(),
  subject: z.string().trim().min(1).max(998).optional(),
  preview_text: z.string().max(500).optional(),
});

const RefineDesignSchema = z.object({
  idempotency_key: IdempotencyKey,
  design_id: DesignId,
  instructions: z.string().trim().min(1).max(4_000),
  base_revision: DesignRevision,
});

const CreateCampaignFromDesignSchema = DesignCommitSchema.extend({
  name: z.string().trim().min(1).max(200).optional(),
  subject: z.string().max(2_000).optional(),
  preview_text: z.string().max(2_000).optional(),
  variables: FlexibleObject.optional(),
  segment_id: z.string().trim().min(1).max(256).optional(),
  list_id: z
    .union([z.number().int().positive(), z.string().regex(/^(?!0+$)[0-9]+$/)])
    .optional(),
});

const CreateCampaignSchema = z.object({
  template_id: TemplateIdOrSlug,
  name: z.string().trim().min(1).max(200).optional(),
  subject: z.string().max(2_000).optional(),
  preview_text: z.string().max(2_000).optional(),
  variables: FlexibleObject.optional(),
  content: FlexibleObject.optional(),
  brand: FlexibleObject.optional(),
  segment_id: z.string().trim().min(1).max(256).optional(),
  list_id: z
    .union([z.number().int().positive(), z.string().regex(/^(?!0+$)[0-9]+$/)])
    .optional(),
});

export function campaignTemplateTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "campaign_template_search",
      description:
        "Search every page of the visual newsletter design library by text, goal, source, style, layout, industry, tags, and favorites. Returns at most 100 compact rows plus total, has_more, next_page, and next_cursor; continue with next_cursor (or next_page) while preserving filters. Fetch only a chosen design with campaign_template_get.",
      schema: SearchSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async (input) => {
        try {
          const { cursor, ...filters } = input;
          const result = await client.campaignTemplates.search({
            ...filters,
            ...(filters.page === undefined && cursor !== undefined
              ? { cursor }
              : {}),
          });
          return compactCampaignTemplateSearch(result);
        } catch (err) {
          throw wrapErr("campaign_template_search", err);
        }
      },
    },
    {
      name: "campaign_template_compare",
      description:
        "Resolve two to four template IDs or slugs without persisting compare state. Available items retain relative request order; unavailable_identifiers reports missing, inaccessible, rejected, or archived selections in exact request order.",
      schema: z.object({
        templates: z
          .array(TemplateId)
          .min(2)
          .max(4)
          .refine(
            (values) =>
              new Set(values.map((value) => value.toLowerCase())).size ===
              values.length,
            { message: "templates must be unique" },
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ templates }) => {
        try {
          return await client.campaignTemplates.compare(templates);
        } catch (err) {
          throw wrapErr("campaign_template_compare", err);
        }
      },
    },
    {
      name: "campaign_template_favorite",
      description:
        "Idempotently favorite one visible campaign template for the authenticated user. API keys use their non-impersonable bound dashboard-user principal; legacy unbound keys fail closed.",
      schema: z.object({ template_id: TemplateId }),
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id }) => {
        try {
          return await client.campaignTemplates.favorite(template_id);
        } catch (err) {
          throw wrapErr("campaign_template_favorite", err);
        }
      },
    },
    {
      name: "campaign_template_unfavorite",
      description:
        "Idempotently remove one visible campaign template from the authenticated user's favorites. API keys use their non-impersonable bound dashboard-user principal; legacy unbound keys fail closed.",
      schema: z.object({ template_id: TemplateId }),
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id }) => {
        try {
          return await client.campaignTemplates.unfavorite(template_id);
        } catch (err) {
          throw wrapErr("campaign_template_unfavorite", err);
        }
      },
    },
    {
      name: "campaign_template_recent_record",
      description:
        "Record an authenticated user's view of one catalog template. Repeated views update one durable recent item and its view count.",
      schema: z.object({ template_id: TemplateId }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id }) => {
        try {
          return await client.campaignTemplates.recordView(template_id);
        } catch (err) {
          throw wrapErr("campaign_template_recent_record", err);
        }
      },
    },
    {
      name: "campaign_template_recent_list",
      description:
        "List the authenticated user's recent templates newest-first with compact metadata and view counts.",
      schema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ limit }) => {
        try {
          return await client.campaignTemplates.recent(limit);
        } catch (err) {
          throw wrapErr("campaign_template_recent_list", err);
        }
      },
    },
    {
      name: "campaign_template_recent_clear",
      description:
        "Clear one template or the entire authenticated user's recent-template history. Repeating the same clear is safe.",
      schema: z.object({ template_id: TemplateId.optional() }),
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id }) => {
        try {
          return await client.campaignTemplates.clearRecent(template_id);
        } catch (err) {
          throw wrapErr("campaign_template_recent_clear", err);
        }
      },
    },
    {
      name: "campaign_template_collection_list",
      description:
        "List the authenticated user's named template collections and item counts.",
      schema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async () => {
        try {
          return await client.campaignTemplates.listCollections();
        } catch (err) {
          throw wrapErr("campaign_template_collection_list", err);
        }
      },
    },
    {
      name: "campaign_template_collection_get",
      description:
        "Get one personal collection with its ordered template IDs and compact, favorite-aware catalog items.",
      schema: z.object({ collection_id: TemplateId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ collection_id }) => {
        try {
          return await client.campaignTemplates.getCollection(collection_id);
        } catch (err) {
          throw wrapErr("campaign_template_collection_get", err);
        }
      },
    },
    {
      name: "campaign_template_collection_create",
      description:
        "Create a user-private named collection with up to 100 unique templates in the supplied order. Reuse idempotency_key only for an exact retry of the unchanged create after a lost or uncertain response; use a new key when any input changes.",
      schema: z.object({
        idempotency_key: IdempotencyKey,
        name: CollectionName,
        description: CollectionDescription.optional(),
        template_ids: CollectionTemplateIds.optional(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ idempotency_key, ...input }) => {
        try {
          return await client.campaignTemplates.createCollection(
            input,
            idempotency_key,
          );
        } catch (err) {
          throw wrapErr("campaign_template_collection_create", err);
        }
      },
    },
    {
      name: "campaign_template_collection_update",
      description:
        "Rename or update one personal collection using optimistic concurrency. First get the collection, then pass its exact current etag unchanged as if_match. A stale token fails safely; fetch the latest collection and review it before retrying.",
      schema: z
        .object({
          collection_id: TemplateId,
          if_match: CollectionETag,
          name: CollectionName.optional(),
          description: CollectionDescription.optional(),
        })
        .refine(
          (value) =>
            value.name !== undefined || value.description !== undefined,
          {
            message: "name or description is required",
          },
        ),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ collection_id, if_match, ...input }) => {
        try {
          return await client.campaignTemplates.updateCollection(
            collection_id,
            input,
            if_match,
          );
        } catch (err) {
          throw wrapErr("campaign_template_collection_update", err);
        }
      },
    },
    {
      name: "campaign_template_collection_replace_items",
      description:
        "Atomically replace a collection's ordered membership with up to 100 unique template IDs. Pass the exact current collection etag unchanged as if_match. A successful change returns a fresh etag; after an uncertain response, get the collection and reconcile before retrying.",
      schema: z.object({
        collection_id: TemplateId,
        if_match: CollectionETag,
        template_ids: CollectionTemplateIds,
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ collection_id, if_match, template_ids }) => {
        try {
          return await client.campaignTemplates.replaceCollectionItems(
            collection_id,
            template_ids,
            if_match,
          );
        } catch (err) {
          throw wrapErr("campaign_template_collection_replace_items", err);
        }
      },
    },
    {
      name: "campaign_template_collection_delete",
      description:
        "Delete one personal collection without deleting its templates. Pass the exact current etag unchanged as if_match. If the response is lost, get/list collections to reconcile: a blind retry can return not-found because the first delete may have committed.",
      schema: z.object({
        collection_id: TemplateId,
        if_match: CollectionETag,
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ collection_id, if_match }) => {
        try {
          return await client.campaignTemplates.deleteCollection(
            collection_id,
            if_match,
          );
        } catch (err) {
          throw wrapErr("campaign_template_collection_delete", err);
        }
      },
    },
    {
      name: "campaign_template_saved_search_list",
      description:
        "List the authenticated user's named catalog searches. Every saved search includes authoritative obsolete_filters for persisted taxonomy values that disappeared; this never relies on bounded facet frequency.",
      schema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async () => {
        try {
          return await client.campaignTemplates.listSavedSearches();
        } catch (err) {
          throw wrapErr("campaign_template_saved_search_list", err);
        }
      },
    },
    {
      name: "campaign_template_saved_search_get",
      description:
        "Get one user-private saved catalog filter definition, its exact current etag, and authoritative obsolete_filters. Remove obsolete values through campaign_template_saved_search_update with this etag.",
      schema: z.object({ saved_search_id: TemplateId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ saved_search_id }) => {
        try {
          return await client.campaignTemplates.getSavedSearch(saved_search_id);
        } catch (err) {
          throw wrapErr("campaign_template_saved_search_get", err);
        }
      },
    },
    {
      name: "campaign_template_saved_search_create",
      description:
        "Save a named catalog query for the authenticated user. Cursor and pagination position are intentionally not stored. Reuse idempotency_key only for an exact retry of the unchanged create after a lost or uncertain response.",
      schema: z.object({
        idempotency_key: IdempotencyKey,
        name: CollectionName,
        filters: SavedSearchFiltersSchema,
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ idempotency_key, ...input }) => {
        try {
          return await client.campaignTemplates.createSavedSearch(
            input,
            idempotency_key,
          );
        } catch (err) {
          throw wrapErr("campaign_template_saved_search_create", err);
        }
      },
    },
    {
      name: "campaign_template_saved_search_update",
      description:
        "Rename or replace one personal saved search using optimistic concurrency. First get it, then pass its exact current etag unchanged as if_match. This is the safe cleanup path for obsolete_filters: remove the reported values from the complete filters object and submit it with the latest etag. A stale token fails safely.",
      schema: z
        .object({
          saved_search_id: TemplateId,
          if_match: SavedSearchETag,
          name: CollectionName.optional(),
          filters: SavedSearchFiltersSchema.optional(),
        })
        .refine(
          (value) => value.name !== undefined || value.filters !== undefined,
          {
            message: "name or filters is required",
          },
        ),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ saved_search_id, if_match, ...input }) => {
        try {
          return await client.campaignTemplates.updateSavedSearch(
            saved_search_id,
            input,
            if_match,
          );
        } catch (err) {
          throw wrapErr("campaign_template_saved_search_update", err);
        }
      },
    },
    {
      name: "campaign_template_saved_search_results",
      description:
        "Run one saved search and return a stable compact page. Continue with its opaque next_cursor.",
      schema: z.object({
        saved_search_id: TemplateId,
        cursor: PageCursor.optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ saved_search_id, ...params }) => {
        try {
          return compactCampaignTemplateSearch(
            await client.campaignTemplates.savedSearchResults(
              saved_search_id,
              params,
            ),
          );
        } catch (err) {
          throw wrapErr("campaign_template_saved_search_results", err);
        }
      },
    },
    {
      name: "campaign_template_saved_search_delete",
      description:
        "Delete one personal saved search without changing templates or favorites. Pass its exact current etag unchanged as if_match. If the response is lost, get/list saved searches to reconcile instead of blindly retrying.",
      schema: z.object({
        saved_search_id: TemplateId,
        if_match: SavedSearchETag,
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ saved_search_id, if_match }) => {
        try {
          return await client.campaignTemplates.deleteSavedSearch(
            saved_search_id,
            if_match,
          );
        } catch (err) {
          throw wrapErr("campaign_template_saved_search_delete", err);
        }
      },
    },
    {
      name: "campaign_template_get",
      description:
        "Fetch one visual campaign template by ID or slug, including its version, exact strong etag, lifecycle capabilities, design metadata, provenance, variables, and editable MJML/HTML when available. Reference-only records may contain a thumbnail instead of reusable source. Use after campaign_template_search selects a candidate, and pass the returned etag unchanged to any update/archive/restore operation.",
      schema: z.object({ template_id: TemplateIdOrSlug }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id }) => {
        try {
          return await client.campaignTemplates.get(template_id);
        } catch (err) {
          throw wrapErr("campaign_template_get", err);
        }
      },
    },
    {
      name: "campaign_template_revisions",
      description:
        "List immutable history for an editable tenant-owned visual template, newest first. Returns compact transition metadata, snapshot times, and historical etags; select one version with campaign_template_revision_get to inspect its full snapshot.",
      schema: z.object({
        template_id: TemplateId,
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id, page, per_page }) => {
        try {
          return await client.campaignTemplates.listRevisions(template_id, {
            page,
            per_page,
          });
        } catch (err) {
          throw wrapErr("campaign_template_revisions", err);
        }
      },
    },
    {
      name: "campaign_template_revision_get",
      description:
        "Get one immutable historical snapshot of an editable tenant-owned visual template by positive version. This is read-only evidence; use the current template etag from campaign_template_get for new mutations.",
      schema: z.object({
        template_id: TemplateId,
        version: TemplateRevisionVersion,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id, version }) => {
        try {
          return await client.campaignTemplates.getRevision(
            template_id,
            version,
          );
        } catch (err) {
          throw wrapErr("campaign_template_revision_get", err);
        }
      },
    },
    {
      name: "campaign_template_create",
      description:
        "Create a tenant-owned editable visual campaign template. Provenance, review, licensing, import, quality, and generation-lineage fields are server controlled; use campaign_template_save for reviewed generated output.",
      schema: CreateSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async (input) => {
        try {
          return await client.campaignTemplates.create(input);
        } catch (err) {
          throw wrapErr("campaign_template_create", err);
        }
      },
    },
    {
      name: "campaign_template_update",
      description:
        "Update an active editable tenant-owned visual campaign template using optimistic concurrency. First fetch the current template, then pass its exact strong etag as if_match. A stale etag fails safely instead of overwriting another edit. An MJML body is authoritative; editing HTML retires previous MJML, while editing MJML retires previous HTML. Inspiration/library references are read-only; use campaign_template_adapt (Make it mine) instead.",
      schema: z.object({
        template_id: TemplateId,
        if_match: TemplateETag,
        patch: PatchSchema.describe("Only supplied fields are changed."),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ template_id, if_match, patch }) => {
        try {
          return await client.campaignTemplates.update(
            template_id,
            patch,
            if_match,
          );
        } catch (err) {
          throw wrapErr("campaign_template_update", err);
        }
      },
    },
    {
      name: "campaign_template_change_preview",
      description:
        "Preview one exact source-fragment replacement on an editable template. Requires the current strong ETag and a target that occurs exactly once. Returns short before/after excerpts and a hash; it does not mutate, compile, or send.",
      schema: ExactChangeSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["read:campaigns"],
      handler: async ({ template_id, if_match, format, find, replace }) => {
        try {
          const template = await client.campaignTemplates.get(template_id);
          const plan = planExactTemplateChange(template, {
            templateId: template_id,
            ifMatch: if_match,
            format,
            find,
            replace,
          });
          return {
            template_id,
            if_match,
            format,
            preview_hash: plan.preview_hash,
            before_excerpt: plan.before_excerpt,
            after_excerpt: plan.after_excerpt,
            notice: "Review the excerpts and run rendering/QA after applying. This is not a human approval or a send.",
          };
        } catch (err) {
          throw wrapErr("campaign_template_change_preview", err);
        }
      },
    },
    {
      name: "campaign_template_change_apply",
      description:
        "Apply exactly the reviewed source-fragment replacement. Supply the hash from campaign_template_change_preview plus the same ETag, format, find and replace values. The server ETag rejects concurrent edits. Never sends a campaign.",
      schema: ExactChangeSchema.extend({
        preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ template_id, if_match, format, find, replace, preview_hash }) => {
        try {
          const template = await client.campaignTemplates.get(template_id);
          const plan = planExactTemplateChange(template, {
            templateId: template_id,
            ifMatch: if_match,
            format,
            find,
            replace,
          });
          if (plan.preview_hash !== preview_hash) {
            throw new Error("Preview hash mismatch. Preview this exact change again before applying.");
          }
          return await client.campaignTemplates.update(
            template_id,
            format === "mjml" ? { body_mjml: plan.after } : { body_html: plan.after },
            if_match,
          );
        } catch (err) {
          throw wrapErr("campaign_template_change_apply", err);
        }
      },
    },
    {
      name: "campaign_template_clone",
      description:
        "Clone a visible editable template into a tenant-owned copy. Inspiration/reference templates cannot be cloned; use campaign_template_adapt (Make it mine) so copied brand/content is not reused verbatim.",
      schema: z.object({
        template_id: TemplateId,
        name: z.string().trim().min(1).max(200).optional(),
        slug: Slug.optional(),
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ template_id, name, slug }) => {
        try {
          return await client.campaignTemplates.clone(template_id, {
            name,
            slug,
          });
        } catch (err) {
          throw wrapErr("campaign_template_clone", err);
        }
      },
    },
    {
      name: "campaign_template_archive",
      description:
        "Archive an active editable tenant-owned visual template without deleting its content or immutable history. Pass the exact current etag as if_match; use campaign_template_restore with the returned fresh etag to recover it.",
      schema: z.object({
        template_id: TemplateId,
        if_match: TemplateETag,
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ template_id, if_match }) => {
        try {
          return await client.campaignTemplates.archive(template_id, if_match);
        } catch (err) {
          throw wrapErr("campaign_template_archive", err);
        }
      },
    },
    {
      name: "campaign_template_restore",
      description:
        "Restore an archived editable tenant-owned visual template as a fresh immutable revision. Pass the archived template's exact current etag as if_match; a stale etag fails safely.",
      schema: z.object({
        template_id: TemplateId,
        if_match: TemplateETag,
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ template_id, if_match }) => {
        try {
          return await client.campaignTemplates.restore(template_id, if_match);
        } catch (err) {
          throw wrapErr("campaign_template_restore", err);
        }
      },
    },
    {
      name: "campaign_template_delete",
      description:
        "Deprecated compatibility alias that safely archives an active editable tenant-owned visual template. It never permanently deletes content or immutable history. Prefer campaign_template_archive and pass the exact current etag as if_match.",
      schema: z.object({
        template_id: TemplateId,
        if_match: TemplateETag,
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ template_id, if_match }) => {
        try {
          return await client.campaignTemplates.delete(template_id, if_match);
        } catch (err) {
          throw wrapErr("campaign_template_delete", err);
        }
      },
    },
    {
      name: "campaign_template_adapt",
      description:
        "Start a durable Make-it-mine job from an approved inspiration reference. Returns a queued design_id immediately; poll campaign_template_design_get until ready, inspect its validation and output_hash, optionally refine, then save or create a campaign from that exact revision. Reuse idempotency_key only for an exact retry after a lost or uncertain response; use a new key when any input changes.",
      schema: AdaptSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ idempotency_key, template_id, ...input }) => {
        try {
          return await client.campaignTemplates.adapt(template_id, input, {
            idempotencyKey: idempotency_key,
          });
        } catch (err) {
          throw wrapErr("campaign_template_adapt", err);
        }
      },
    },
    {
      name: "campaign_template_generate",
      description:
        "Start a durable newsletter-design job from a brief and optional governed references. Returns a queued design_id immediately; poll campaign_template_design_get, then review/refine and commit the exact revision. Reuse idempotency_key only for an exact retry after a lost or uncertain response; use a new key when any input changes.",
      schema: GenerateSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ idempotency_key, ...input }) => {
        try {
          return await client.campaignTemplates.generate(input, {
            idempotencyKey: idempotency_key,
          });
        } catch (err) {
          throw wrapErr("campaign_template_generate", err);
        }
      },
    },
    {
      name: "campaign_template_design_list",
      description:
        "Recover active durable newsletter-design jobs created by this exact authenticated tenant and actor, newest first. Returns at most 50 compact summaries and an optional actor-bound next_cursor; archived and expired jobs are excluded. Fetch only a selected design with campaign_template_design_get to inspect its original request and immutable generated output.",
      schema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Page size from 1 through 50; defaults to 20."),
        cursor: z
          .string()
          .max(1_024)
          .refine((value) => value === value.trim(), {
            message: "cursor must be passed unchanged without outer whitespace",
          })
          .refine((value) => new TextEncoder().encode(value).length <= 1_024, {
            message: "cursor must be at most 1024 UTF-8 bytes",
          })
          .optional()
          .describe(
            "Opaque actor-bound next_cursor from the previous page; pass it unchanged.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ limit, cursor }) => {
        try {
          return await client.campaignTemplates.listDesigns({ limit, cursor });
        } catch (err) {
          throw wrapErr("campaign_template_design_list", err);
        }
      },
    },
    {
      name: "campaign_template_design_get",
      description:
        "Get a durable design job and its current immutable revision. When status is queued or generating, wait retry_after_seconds and poll again. When ready, inspect validation, warnings, revision, and output_hash before refining, saving, or creating a campaign.",
      schema: z.object({ design_id: DesignId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ design_id }) => {
        try {
          return await client.campaignTemplates.getDesign(design_id);
        } catch (err) {
          throw wrapErr("campaign_template_design_get", err);
        }
      },
    },
    {
      name: "campaign_template_design_revisions",
      description:
        "List immutable revisions for a durable newsletter design, newest first. Use this to compare prior results or recover the exact revision and output_hash a user selected.",
      schema: z.object({ design_id: DesignId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      requiredScopes: ["read:campaigns"],
      handler: async ({ design_id }) => {
        try {
          return await client.campaignTemplates.listDesignRevisions(design_id);
        } catch (err) {
          throw wrapErr("campaign_template_design_revisions", err);
        }
      },
    },
    {
      name: "campaign_template_design_refine",
      description:
        "Queue a refinement of the current ready design. base_revision is an optimistic-concurrency guard; on conflict fetch the design again. Poll campaign_template_design_get for the next immutable revision. Reuse idempotency_key only for an exact retry after a lost or uncertain response; use a new key when any input changes.",
      schema: RefineDesignSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ idempotency_key, design_id, ...input }) => {
        try {
          return await client.campaignTemplates.refineDesign(design_id, input, {
            idempotencyKey: idempotency_key,
          });
        } catch (err) {
          throw wrapErr("campaign_template_design_refine", err);
        }
      },
    },
    {
      name: "campaign_template_design_retry",
      description:
        "Retry a failed durable design job with the exact original request. This is valid only when status is failed; poll campaign_template_design_get after it is accepted. Reuse idempotency_key only for an exact retry after a lost or uncertain response; use a new key for a new retry operation.",
      schema: z.object({
        idempotency_key: IdempotencyKey,
        design_id: DesignId,
      }),
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ idempotency_key, design_id }) => {
        try {
          return await client.campaignTemplates.retryDesign(design_id, {
            idempotencyKey: idempotency_key,
          });
        } catch (err) {
          throw wrapErr("campaign_template_design_retry", err);
        }
      },
    },
    {
      name: "campaign_template_save",
      description:
        "Save the exact immutable design revision the user or agent reviewed. Pass design_id, revision, and output_hash from campaign_template_design_get; caller-supplied HTML and governance fields are never accepted. Reuse idempotency_key only for an exact retry after a lost or uncertain response; use a new key when any commit input changes.",
      schema: SaveReviewedDesignSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ idempotency_key, design_id, ...input }) => {
        try {
          return await client.campaignTemplates.saveDesign(design_id, input, {
            idempotencyKey: idempotency_key,
          });
        } catch (err) {
          throw wrapErr("campaign_template_save", err);
        }
      },
    },
    {
      name: "campaign_template_design_create_campaign",
      description:
        "Create an editable campaign draft from the exact reviewed design revision and optional audience/merge values. This never sends. Pass revision and output_hash exactly as returned by campaign_template_design_get. Reuse idempotency_key only for an exact retry after a lost or uncertain response; use a new key when any draft input changes.",
      schema: CreateCampaignFromDesignSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ idempotency_key, design_id, ...input }) => {
        try {
          return await client.campaignTemplates.createCampaignFromDesign(
            design_id,
            input,
            { idempotencyKey: idempotency_key },
          );
        } catch (err) {
          throw wrapErr("campaign_template_design_create_campaign", err);
        }
      },
    },
    {
      name: "campaign_template_design_archive",
      description:
        "Archive a completed, failed, or abandoned durable design job. Immutable revision evidence remains retained; a currently generating job cannot be archived. Reuse idempotency_key only for an exact retry after a lost or uncertain response; use a new key for a distinct archive operation.",
      schema: z.object({
        idempotency_key: IdempotencyKey,
        design_id: DesignId,
      }),
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async ({ idempotency_key, design_id }) => {
        try {
          return await client.campaignTemplates.archiveDesign(design_id, {
            idempotencyKey: idempotency_key,
          });
        } catch (err) {
          throw wrapErr("campaign_template_design_archive", err);
        }
      },
    },
    {
      name: "campaign_create_from_template",
      description:
        "Create an editable campaign draft from a visual template (by ID or slug), applying variable, content, brand, subject, and preview-text overrides atomically. This never sends the campaign; sending remains a separate approval-gated action.",
      schema: CreateCampaignSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScopes: ["write:campaigns"],
      handler: async (input) => {
        try {
          return await client.campaignTemplates.createCampaign(input);
        } catch (err) {
          throw wrapErr("campaign_create_from_template", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): unknown {
  if (err instanceof Error) {
    try {
      Object.defineProperty(err, "tool", {
        value: tool,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Preserve the typed SDK error even when it is non-extensible.
    }
    return err;
  }
  return Object.assign(new Error(String(err)), { tool });
}
