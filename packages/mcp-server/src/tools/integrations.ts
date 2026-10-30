// SPDX-License-Identifier: MIT
import { z } from "zod";
import type {
  PostwaveClient,
  SupportIntegrationListOptions,
} from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const NativeFamilyEnum = z.enum([
  "commerce",
  "crm",
  "lead",
  "reviews",
  "loyalty",
  "subscriptions",
  "support",
  "analytics",
  "marketing",
  "warehouse",
]);

const NativeIngestFamilyEnum = z.enum([
  "lead",
  "reviews",
  "loyalty",
  "subscriptions",
  "support",
  "analytics",
]);

const BadgeEnum = z.enum([
  "native",
  "partner",
  "zapier",
  "webhook",
  "api_sdk",
  "migration_only",
  "planned",
]);

const CapabilityEnum = z.enum([
  "profiles",
  "events",
  "lists",
  "segments",
  "commerce",
  "orders",
  "products",
  "reviews",
  "subscriptions",
  "support",
  "ads_audiences",
  "warehouse_export",
  "warehouse_import",
  "automation_triggers",
]);

const DirectionEnum = z.enum(["export", "import", "bidirectional"]);
const CadenceEnum = z.enum(["manual", "hourly", "daily", "weekly"]);
const AudienceDestinationProviderEnum = z.enum([
  "meta",
  "google_ads",
  "tiktok",
  "linkedin",
  "snap",
]);
const AudienceDestinationStatusEnum = z.enum([
  "draft",
  "active",
  "paused",
  "syncing",
  "error",
]);

type NativeFamily = z.infer<typeof NativeFamilyEnum>;
type NativeIngestFamily = z.infer<typeof NativeIngestFamilyEnum>;
type NativeCommandCreateInput =
  | Record<string, unknown>
  | {
      provider: string;
      name?: string;
      config?: Record<string, unknown>;
      scopes?: string[];
    };
type NativeCommandLifecycleInput = Record<string, unknown>;

const SUPPORT_RUNTIME_HELD_CODE = "support_integration_runtime_held";
const SUPPORT_RUNTIME_HELD_MESSAGE =
  "Support-provider configuration, synchronization, ingestion, lifecycle, and run-history tools are release-held while Helpdesk privacy governance is incomplete.";
const SUPPORT_LIST_UNSAFE_CURSOR_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const NativeIntegrationIdSchema = z
  .string()
  .length(36)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    "id must be a lowercase canonical UUID",
  )
  .describe("Lowercase canonical native-integration UUID");

interface NativeCommandResource {
  providers(): Promise<unknown>;
  list(options?: SupportIntegrationListOptions): Promise<unknown>;
  create(input: NativeCommandCreateInput): Promise<unknown>;
  get(id: string): Promise<unknown>;
  sync(id: string, input: NativeCommandLifecycleInput): Promise<unknown>;
  backfill(id: string, input: NativeCommandLifecycleInput): Promise<unknown>;
  ingest?: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  pause(id: string): Promise<unknown>;
  disconnect(id: string): Promise<unknown>;
  runs?: (id: string, limit?: number) => Promise<unknown>;
}

const createSchema = z.object({
  family: NativeFamilyEnum,
  provider: z.string().min(1),
  name: z.string().min(1).optional(),
  shop_domain: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  credential_ref: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  objects: z.array(z.string().min(1)).optional(),
  direction: DirectionEnum.optional(),
  cadence: CadenceEnum.optional(),
  backfill_days: z.number().int().min(1).max(3650).optional(),
});

const SupportListCursorSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value === value.trim() && !SUPPORT_LIST_UNSAFE_CURSOR_RE.test(value),
    {
      message:
        "cursor must not contain controls, bidi markers, or surrounding whitespace",
    },
  );

const lifecycleSchema = z.object({
  family: NativeFamilyEnum,
  id: z.string().min(1),
  since: z.string().optional(),
  cursor: z.string().optional(),
  full: z.boolean().optional(),
  objects: z.array(z.string().min(1)).optional(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  payload: z.record(z.unknown()).optional(),
});

const audienceDestinationCreateSchema = z.object({
  provider: AudienceDestinationProviderEnum,
  list_id: z.string().min(1).optional(),
  segment_id: z.string().min(1).optional(),
  external_audience_id: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
});

const audienceDestinationUpdateSchema = z.object({
  id: z.string().min(1),
  status: AudienceDestinationStatusEnum.optional(),
  external_audience_id: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
});

export function integrationTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "integrations_catalog",
      description:
        "Search the honest Moosewave integrations catalog. Badges distinguish Native, Partner, Zapier, Webhook, API/SDK, Migration-only, and Planned support.",
      schema: z.object({
        q: z.string().optional(),
        category: z.string().optional(),
        badge: BadgeEnum.optional(),
        capability: CapabilityEnum.optional(),
      }),
      handler: async (query) => {
        try {
          return await client.integrations.catalog(query);
        } catch (err) {
          throw wrapErr("integrations_catalog", err);
        }
      },
    },
    {
      name: "integrations_connections",
      description:
        "List installed integration state across all connector surfaces, including connection ids, health state, last sync, and errors.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.integrations.connections();
        } catch (err) {
          throw wrapErr("integrations_connections", err);
        }
      },
    },
    {
      name: "audience_destination_providers",
      description:
        "List readiness-gated Moosewave-owned ad audience destination foundations: Meta, Google Ads, TikTok, LinkedIn, and Snap.",
      schema: z.object({}),
      handler: async () => {
        try {
          return await client.audienceDestinations.providers();
        } catch (err) {
          throw wrapErr("audience_destination_providers", err);
        }
      },
    },
    {
      name: "audience_destination_list",
      description:
        "List adapter-backed ad audience destinations, optionally filtered by provider.",
      schema: z.object({
        provider: AudienceDestinationProviderEnum.optional(),
      }),
      handler: async ({ provider }) => {
        try {
          return await client.audienceDestinations.list(provider);
        } catch (err) {
          throw wrapErr("audience_destination_list", err);
        }
      },
    },
    {
      name: "audience_destination_create",
      description:
        "Create an adapter-backed ad audience destination from a list or segment. Use readiness first to identify provider config keys and unresolved credential prerequisites.",
      schema: audienceDestinationCreateSchema,
      handler: async (input) => {
        if (!input.list_id && !input.segment_id) {
          throw new Error(
            "audience_destination_create: list_id or segment_id is required",
          );
        }
        try {
          return await client.audienceDestinations.create(input);
        } catch (err) {
          throw wrapErr("audience_destination_create", err);
        }
      },
    },
    {
      name: "audience_destination_get",
      description: "Get one adapter-backed ad audience destination by id.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.audienceDestinations.get(id);
        } catch (err) {
          throw wrapErr("audience_destination_get", err);
        }
      },
    },
    {
      name: "audience_destination_update",
      description:
        "Update status, external audience id, or non-secret provider config for an adapter-backed ad audience destination.",
      schema: audienceDestinationUpdateSchema,
      handler: async ({ id, ...input }) => {
        if (!input.status && !input.external_audience_id && !input.config) {
          throw new Error(
            "audience_destination_update: status, external_audience_id, or config is required",
          );
        }
        try {
          return await client.audienceDestinations.update(id, input);
        } catch (err) {
          throw wrapErr("audience_destination_update", err);
        }
      },
    },
    {
      name: "audience_destination_readiness",
      description:
        "Validate ad audience provider config and return exact missing keys or driver prerequisites before a sync is attempted.",
      schema: z.object({
        provider: AudienceDestinationProviderEnum,
        config: z.record(z.unknown()).optional(),
      }),
      handler: async ({ provider, config }) => {
        try {
          return await client.audienceDestinations.readiness(
            provider,
            config ?? {},
          );
        } catch (err) {
          throw wrapErr("audience_destination_readiness", err);
        }
      },
    },
    {
      name: "audience_destination_preview",
      description:
        "Preview consent-firewall exclusions for an ad audience destination without shipping members to the platform.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.audienceDestinations.preview(id);
        } catch (err) {
          throw wrapErr("audience_destination_preview", err);
        }
      },
    },
    {
      name: "audience_destination_sync",
      description:
        "Attempt a readiness-gated ad audience sync through Meta, Google Ads, TikTok, LinkedIn, or Snap; missing credentials or unfinished drivers are recorded as failed jobs.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.audienceDestinations.sync(id);
        } catch (err) {
          throw wrapErr("audience_destination_sync", err);
        }
      },
    },
    {
      name: "audience_destination_jobs",
      description:
        "List sync jobs for an adapter-backed ad audience destination.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          return await client.audienceDestinations.jobs(id);
        } catch (err) {
          throw wrapErr("audience_destination_jobs", err);
        }
      },
    },
    {
      name: "audience_destination_job_diagnostics",
      description:
        "Retrieve provider diagnostics for an ad audience destination sync job using stored provider-side evidence such as a Google Data Manager requestId.",
      schema: z.object({
        id: z.string().min(1),
        job_id: z.string().min(1),
      }),
      handler: async ({ id, job_id }) => {
        try {
          return await client.audienceDestinations.jobDiagnostics(id, job_id);
        } catch (err) {
          throw wrapErr("audience_destination_job_diagnostics", err);
        }
      },
    },
    {
      name: "audience_destination_disconnect",
      description:
        "Delete/disconnect an adapter-backed ad audience destination by id.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => {
        try {
          await client.audienceDestinations.disconnect(id);
          return { id, status: "deleted" };
        } catch (err) {
          throw wrapErr("audience_destination_disconnect", err);
        }
      },
    },
    {
      name: "native_integration_providers",
      description:
        "List provider specs for a first-party native integration family. For family=support this is a static release-held catalog only: runtime_status is held and no provider execution, credentials, callback, sync, or lifecycle readiness is implied.",
      schema: z.object({ family: NativeFamilyEnum }),
      handler: async ({ family }) => {
        try {
          return await nativeResource(client, family).providers();
        } catch (err) {
          throw wrapErr("native_integration_providers", err);
        }
      },
    },
    {
      name: "native_integration_list",
      description:
        "List stored first-party native integration records for one family. For family=support this is a minimized historical projection only, with optional limit (1-100; default 50) and opaque cursor pagination. A row is not evidence of a live connection, valid credentials, callback reachability, synchronization, or run history, and runtime_status remains held.",
      schema: z.object({
        family: NativeFamilyEnum,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Support-only page size; omit for server default 50"),
        cursor: SupportListCursorSchema.optional().describe(
          "Support-only opaque continuation cursor; copy page.next_cursor exactly"
        ),
      }),
      handler: async ({ family, limit, cursor }) => {
        try {
          const resource = nativeResource(client, family);
          if (family !== "support") {
            if (limit !== undefined || cursor !== undefined) {
              throw new Error(
                "limit and cursor pagination are available only for family=support",
              );
            }
            return await resource.list();
          }
          return await resource.list({
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          });
        } catch (err) {
          throw wrapErr("native_integration_list", err);
        }
      },
    },
    {
      name: "native_integration_get",
      description:
        "Read one stored first-party native integration by lowercase canonical UUID. For family=support this returns only the tenant-bound minimized historical projection; it is not evidence of live credentials, callback reachability, synchronization, or run history, and runtime_status remains held.",
      schema: z.object({
        family: NativeFamilyEnum,
        id: NativeIntegrationIdSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      handler: async ({ family, id }) => {
        try {
          return await nativeResource(client, family).get(id);
        } catch (err) {
          throw wrapErr("native_integration_get", err);
        }
      },
    },
    {
      name: "native_integration_create",
      description:
        "Create a first-party native integration. Commerce, CRM, lead, reviews, loyalty, subscriptions, analytics, marketing, and warehouse use credential_ref/settings-style credential references; do not pass raw credentials in config. Support is release-held with code support_integration_runtime_held.",
      schema: createSchema,
      handler: async (input) => {
        assertSupportRuntimeAvailable(
          "native_integration_create",
          input.family,
        );
        try {
          return await nativeResource(client, input.family).create(
            createPayload(input),
          );
        } catch (err) {
          throw wrapErr("native_integration_create", err);
        }
      },
    },
    {
      name: "native_integration_sync",
      description:
        "Run a first-party native sync/import. Commerce, CRM, lead, reviews, loyalty, subscriptions, and marketing accept canonical payload rows or empty provider-managed pulls when the configured provider exposes a native puller or delegated foundation handoff; analytics requires canonical rows; warehouse accepts object selection plus supported run fields through payload. Support is release-held with code support_integration_runtime_held.",
      schema: lifecycleSchema,
      handler: async (input) => {
        assertSupportRuntimeAvailable("native_integration_sync", input.family);
        try {
          return await nativeResource(client, input.family).sync(
            input.id,
            lifecyclePayload(input.family, input),
          );
        } catch (err) {
          throw wrapErr("native_integration_sync", err);
        }
      },
    },
    {
      name: "native_integration_backfill",
      description:
        "Run a first-party native backfill or canonical-row import. Uses the same family-aware payload rules as native_integration_sync, including empty provider-managed pulls for providers that expose native backfillers. Support is release-held with code support_integration_runtime_held.",
      schema: lifecycleSchema,
      handler: async (input) => {
        assertSupportRuntimeAvailable(
          "native_integration_backfill",
          input.family,
        );
        try {
          return await nativeResource(client, input.family).backfill(
            input.id,
            lifecyclePayload(input.family, input),
          );
        } catch (err) {
          throw wrapErr("native_integration_backfill", err);
        }
      },
    },
    {
      name: "native_integration_ingest",
      description:
        "Ingest a canonical Moosewave payload for lead, reviews, loyalty, subscriptions, or analytics connectors. Raw provider webhook payload verification is exposed only after a family has a verified adapter. Support is release-held with code support_integration_runtime_held.",
      schema: z.object({
        family: NativeIngestFamilyEnum,
        id: z.string().min(1),
        payload: z.record(z.unknown()),
      }),
      handler: async ({ family, id, payload }) => {
        assertSupportRuntimeAvailable("native_integration_ingest", family);
        const resource = nativeResource(client, family);
        if (!resource.ingest) {
          return {
            family,
            id,
            supported: false,
            message: "Ingest is not available for this family.",
          };
        }
        try {
          return await resource.ingest(id, payload);
        } catch (err) {
          throw wrapErr("native_integration_ingest", err);
        }
      },
    },
    {
      name: "native_integration_pause",
      description:
        "Pause a first-party native integration connection by family and id. Support is release-held with code support_integration_runtime_held.",
      schema: z.object({ family: NativeFamilyEnum, id: z.string().min(1) }),
      handler: async ({ family, id }) => {
        assertSupportRuntimeAvailable("native_integration_pause", family);
        try {
          return await nativeResource(client, family).pause(id);
        } catch (err) {
          throw wrapErr("native_integration_pause", err);
        }
      },
    },
    {
      name: "native_integration_disconnect",
      description:
        "Disconnect/delete a first-party native integration connection by family and id. Support is release-held with code support_integration_runtime_held.",
      schema: z.object({ family: NativeFamilyEnum, id: z.string().min(1) }),
      handler: async ({ family, id }) => {
        assertSupportRuntimeAvailable("native_integration_disconnect", family);
        try {
          return await nativeResource(client, family).disconnect(id);
        } catch (err) {
          throw wrapErr("native_integration_disconnect", err);
        }
      },
    },
    {
      name: "native_integration_runs",
      description:
        "List sync/backfill run history for native families that expose runs. Commerce currently returns an explanatory unsupported response; Support is release-held with code support_integration_runtime_held.",
      schema: z.object({
        family: NativeFamilyEnum,
        id: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      handler: async ({ family, id, limit }) => {
        assertSupportRuntimeAvailable("native_integration_runs", family);
        const resource = nativeResource(client, family);
        if (!resource.runs) {
          return {
            family,
            id,
            supported: false,
            message: "Run history is not available for this family.",
          };
        }
        try {
          return await resource.runs(id, limit);
        } catch (err) {
          throw wrapErr("native_integration_runs", err);
        }
      },
    },
  ];
}

function assertSupportRuntimeAvailable(
  tool: string,
  family: NativeFamily | NativeIngestFamily,
): void {
  if (family === "support") {
    throw new Error(
      `${tool}: ${SUPPORT_RUNTIME_HELD_CODE}: ${SUPPORT_RUNTIME_HELD_MESSAGE}`,
    );
  }
}

function nativeResource(
  client: PostwaveClient,
  family: NativeFamily | NativeIngestFamily,
): NativeCommandResource {
  switch (family) {
    case "commerce":
      return client.nativeIntegrations
        .commerce as unknown as NativeCommandResource;
    case "crm":
      return client.nativeIntegrations.crm as unknown as NativeCommandResource;
    case "lead":
      return client.nativeIntegrations.lead as unknown as NativeCommandResource;
    case "reviews":
      return client.nativeIntegrations
        .reviews as unknown as NativeCommandResource;
    case "loyalty":
      return client.nativeIntegrations
        .loyalty as unknown as NativeCommandResource;
    case "subscriptions":
      return client.nativeIntegrations
        .subscriptions as unknown as NativeCommandResource;
    case "support":
      return client.nativeIntegrations
        .support as unknown as NativeCommandResource;
    case "analytics":
      return client.nativeIntegrations
        .analytics as unknown as NativeCommandResource;
    case "marketing":
      return client.nativeIntegrations
        .marketing as unknown as NativeCommandResource;
    case "warehouse":
      return client.nativeIntegrations
        .warehouse as unknown as NativeCommandResource;
  }
}

function createPayload(
  input: z.infer<typeof createSchema>,
): NativeCommandCreateInput {
  if (input.family === "commerce") {
    return cleanObject({
      provider: input.provider,
      shop_domain: input.shop_domain,
      settings: input.config,
      credential_ref: input.credential_ref,
      scopes: input.scopes,
    });
  }
  if (input.family === "warehouse") {
    if (!input.name)
      throw new Error(
        "native_integration_create: name is required for warehouse",
      );
    return cleanObject({
      provider: input.provider,
      name: input.name,
      config: input.config,
      credentials_ref: input.credential_ref,
      object_selection: input.objects,
      direction: input.direction,
      cadence: input.cadence,
      backfill_days: input.backfill_days,
    });
  }
  if (input.family === "analytics" || input.family === "marketing") {
    return cleanObject({
      provider: input.provider,
      name: input.name,
      settings: input.config,
      credentials_ref: input.credential_ref,
      scopes: input.scopes,
    });
  }
  if (
    input.family === "crm" ||
    input.family === "lead" ||
    input.family === "reviews" ||
    input.family === "loyalty" ||
    input.family === "subscriptions" ||
    input.family === "support"
  ) {
    return cleanObject({
      provider: input.provider,
      name: input.name,
      settings: input.config,
      credentials_ref: input.credential_ref,
      scopes: input.scopes,
    });
  }
  return cleanObject({
    provider: input.provider,
    name: input.name,
    config: input.config,
    scopes: input.scopes,
  });
}

function lifecyclePayload(
  family: NativeFamily,
  input: z.infer<typeof lifecycleSchema>,
): NativeCommandLifecycleInput {
  if (family === "commerce") {
    return cleanObject({ cursor: input.cursor });
  }
  if (family === "warehouse") {
    return cleanObject({
      ...(input.payload ?? {}),
      object_selection: input.objects,
    });
  }
  if (family === "analytics" || family === "marketing") {
    return cleanObject({
      ...(input.payload ?? {}),
      cursor: input.cursor ?? input.since,
      metadata: input.metadata,
    });
  }
  if (
    family === "crm" ||
    family === "lead" ||
    family === "reviews" ||
    family === "loyalty" ||
    family === "subscriptions" ||
    family === "support"
  ) {
    return cleanObject({
      ...(input.payload ?? {}),
      cursor: input.cursor ?? input.since,
    });
  }
  return cleanObject({
    since: input.since,
    full: input.full,
    objects: input.objects,
    reason: input.reason,
    metadata: input.metadata,
  });
}

function cleanObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
