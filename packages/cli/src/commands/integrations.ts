// SPDX-License-Identifier: MIT

import type {
  AudienceDestination,
  AudienceDestinationCreateInput,
  AudienceDestinationJob,
  AudienceDestinationUpdateInput,
  AudienceSyncRun,
  AnalyticsEventInput,
  AnalyticsIntegrationInput,
  AnalyticsSyncRequest,
  ChatIntegration,
  ChatIntegrationCreateInput,
  ChatIntegrationProvider,
  ChatIntegrationUpdateInput,
  CommerceNativeIntegrationCreateInput,
  CommerceNativeProviderSpec,
  CommerceNativeSyncInput,
  CRMSyncRequest,
  IntegrationBadge,
  IntegrationCatalogItem,
  IntegrationCatalogQuery,
  IntegrationCapability,
  IntegrationCategoryCoverage,
  IntegrationConnection,
  IntegrationCustomerStackCoverage,
  IntegrationReadinessCheck,
  IntegrationReadinessReport,
  IntegrationRecipe,
  IntegrationRecipesQuery,
  LeadSubmissionInput,
  LeadSyncRequest,
  ManagedNativeIntegrationInput,
  NativeIntegrationCreateInput,
  NativeIntegrationIngestInput,
  NativeIntegrationLifecycleInput,
  NativeIntegrationProviderSpec,
  LoyaltyEventInput,
  LoyaltySyncRequest,
  ReviewInput,
  ReviewSyncRequest,
  SubscriptionLifecycleEventInput,
  SubscriptionSyncRequest,
  SupportEventInput,
  SupportIntegrationListOptions,
  SupportIntegrationListResponse,
  SupportSyncRequest,
  WarehouseNativeConnectionInput,
  WarehouseNativeRunInput,
} from "@postwave/sdk";
import { createClient, type ClientOpts } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface IntegrationsOpts extends ClientOpts {
  output?: OutputFormat;
  query?: string;
  category?: string;
  badge?: string;
  capability?: string;
  source?: string;
  target?: string;
  provider?: string;
  available?: boolean;
}

export interface NativeIntegrationsOpts extends IntegrationsOpts {
  provider?: string;
  name?: string;
  redirectTo?: string;
  shopDomain?: string;
  config?: string;
  credentials?: string;
  credentialRef?: string;
  scopes?: string;
  metadata?: string;
  payload?: string;
  since?: string;
  cursor?: string;
  full?: boolean;
  objects?: string;
  reason?: string;
  direction?: string;
  cadence?: string;
  backfillDays?: string | number;
  limit?: string | number;
}

export interface AudienceDestinationsOpts extends IntegrationsOpts {
  listId?: string;
  segmentId?: string;
  externalAudienceId?: string;
  status?: string;
  config?: string;
}

export interface ChatIntegrationsOpts extends IntegrationsOpts {
  /** Required confirmation for destructive commands. */
  yes?: boolean;
  url?: string;
  events?: string;
  channelHint?: string;
  enabled?: string | boolean;
}

export const INTEGRATION_BADGES = [
  "native",
  "partner",
  "zapier",
  "webhook",
  "api_sdk",
  "migration_only",
  "planned",
] as const satisfies readonly IntegrationBadge[];

export const INTEGRATION_CAPABILITIES = [
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
] as const satisfies readonly IntegrationCapability[];

export const NATIVE_INTEGRATION_FAMILIES = [
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
] as const;

export type NativeIntegrationFamily =
  (typeof NATIVE_INTEGRATION_FAMILIES)[number];

export const NATIVE_INGEST_FAMILIES = [
  "lead",
  "reviews",
  "loyalty",
  "subscriptions",
  "support",
  "analytics",
] as const satisfies readonly NativeIntegrationFamily[];

export const SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE =
  "support_integration_runtime_held";
const SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE = `${SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE}: Support integration create, sync, backfill, ingest, pause, disconnect, and run history are release-held.`;
const SUPPORT_LIST_UNSAFE_CURSOR_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const SUPPORT_LIST_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SUPPORT_LIST_PROVIDER_RE = /^[a-z0-9_-]{1,64}$/u;
const SUPPORT_LIST_TIMESTAMP_RE =
  /^(20[0-9]{2})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/u;
const SUPPORT_LIST_STATUS = new Set([
  "connected",
  "active",
  "paused",
  "error",
  "disconnected",
]);
const SUPPORT_LIST_ROW_KEYS = [
  "created_at",
  "credential_configured",
  "hold_code",
  "id",
  "name",
  "provider",
  "runtime_status",
  "status",
  "tenantId",
  "tenant_id",
  "updated_at",
] as const;

export const CHAT_INTEGRATION_PROVIDERS = [
  "slack",
  "discord",
  "teams",
] as const satisfies readonly ChatIntegrationProvider[];

type RowValue = string | number | boolean | null | undefined;
type TableRow = Record<string, RowValue>;
type NativeCommandCreateInput =
  | NativeIntegrationCreateInput
  | AnalyticsIntegrationInput
  | CommerceNativeIntegrationCreateInput
  | ManagedNativeIntegrationInput
  | WarehouseNativeConnectionInput;
type NativeCommandLifecycleInput =
  | NativeIntegrationLifecycleInput
  | AnalyticsSyncRequest
  | MarketingSyncRequest
  | CommerceNativeSyncInput
  | CRMSyncRequest
  | LeadSyncRequest
  | ReviewSyncRequest
  | LoyaltySyncRequest
  | SubscriptionSyncRequest
  | SupportSyncRequest
  | WarehouseNativeRunInput;
type NativeCommandIngestInput =
  | NativeIntegrationIngestInput
  | AnalyticsEventInput
  | LeadSubmissionInput
  | ReviewInput
  | LoyaltyEventInput
  | SubscriptionLifecycleEventInput
  | SupportEventInput;
type MarketingSyncRequest = {
  run_mode?: "manual" | "scheduled" | "backfill" | "retry" | "dry_run";
  cursor?: string;
  metadata?: Record<string, unknown>;
};
type NativeConnectionTableItem = {
  id?: string;
  provider?: string;
  name?: string;
  status?: string;
  health_state?: string;
  health?: string;
  last_sync_at?: string | null;
  updated_at?: string | null;
  last_error?: string | null;
  error_message?: string | null;
  error?: string | null;
};
type NativeRunTableItem = {
  id?: string;
  provider?: string;
  action?: string;
  run_mode?: string;
  status?: string;
  attempts?: number;
  retry_count?: number;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
};
type AudienceDestinationTableItem = Pick<
  AudienceDestination,
  | "id"
  | "provider"
  | "list_id"
  | "segment_id"
  | "external_audience_id"
  | "status"
  | "last_synced_at"
  | "updated_at"
>;
type AudienceDestinationJobTableItem = Pick<
  AudienceDestinationJob,
  | "id"
  | "destination_id"
  | "status"
  | "members_synced"
  | "external_job_id"
  | "external_audience_id"
  | "provider_message"
  | "provider_status"
  | "provider_checked_at"
  | "provider_next_check_at"
  | "provider_poll_attempts"
  | "started_at"
  | "finished_at"
  | "error"
>;
type AudienceSyncRunTableItem = Pick<
  AudienceSyncRun,
  | "id"
  | "sync_id"
  | "status"
  | "rows_exported"
  | "batches_sent"
  | "external_job_id"
  | "external_audience_id"
  | "provider_message"
  | "provider_status"
  | "provider_checked_at"
  | "provider_next_check_at"
  | "provider_poll_attempts"
  | "excluded_count"
  | "started_at"
  | "finished_at"
  | "error"
>;
type ChatIntegrationTableItem = Pick<
  ChatIntegration,
  | "id"
  | "channel_hint"
  | "events"
  | "enabled"
  | "last_delivery_status"
  | "last_delivery_at"
  | "last_delivery_error"
  | "updated_at"
>;

interface NativeCommandResource {
  providers(): Promise<unknown>;
  list(options?: SupportIntegrationListOptions): Promise<unknown>;
  create(input: NativeCommandCreateInput): Promise<unknown>;
  get(id: string): Promise<unknown>;
  sync(id: string, input: NativeCommandLifecycleInput): Promise<unknown>;
  backfill(id: string, input: NativeCommandLifecycleInput): Promise<unknown>;
  ingest?: (id: string, input: NativeCommandIngestInput) => Promise<unknown>;
  pause(id: string): Promise<unknown>;
  disconnect(id: string): Promise<unknown>;
  runs?: (id: string, limit?: number) => Promise<unknown>;
  oauthAvailability?: (provider: string) => Promise<unknown>;
  oauthStartUrl?: (
    provider: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ) => string;
}

export async function integrationsCatalog(
  opts: IntegrationsOpts = {},
): Promise<void> {
  let query: IntegrationCatalogQuery;
  try {
    query = catalogQueryFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.integrations.catalog(query);
  printWithDefaultTable(opts.output, out, compactCatalogRows(out.items));
}

export async function integrationsConnections(
  opts: IntegrationsOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.integrations.connections();
  printWithDefaultTable(opts.output, out, compactConnectionRows(out.items));
}

export async function integrationsCoverage(
  opts: IntegrationsOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.integrations.coverage();
  printWithDefaultTable(opts.output, out, compactCoverageRows(out.categories));
}

export async function integrationsStacks(
  opts: IntegrationsOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.integrations.stacks();
  printWithDefaultTable(opts.output, out, compactStackRows(out.stacks));
}

export async function integrationsReadiness(
  opts: IntegrationsOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.integrations.readiness();
  printWithDefaultTable(opts.output, out, compactReadinessRows(out));
}

export async function integrationsRecipes(
  opts: IntegrationsOpts = {},
): Promise<void> {
  let query: IntegrationRecipesQuery;
  try {
    query = recipeQueryFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.integrations.recipes(query);
  printWithDefaultTable(opts.output, out, compactRecipeRows(out.items));
}

export async function integrationsRecipe(
  id: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  const recipeId = normalizeIntegrationId(id, "recipe id");
  if (!recipeId) return;

  const client = createClient(opts);
  const out = await client.integrations.recipe(recipeId);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsApplyRecipe(
  id: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  const recipeId = normalizeIntegrationId(id, "recipe id");
  if (!recipeId) return;

  const client = createClient(opts);
  const out = await client.integrations.applyRecipe(recipeId);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsDetail(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  const integrationSlug = normalizeIntegrationId(slug);
  if (!integrationSlug) return;

  const client = createClient(opts);
  const out = await client.integrations.detail(integrationSlug);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsContract(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  const integrationSlug = normalizeIntegrationId(slug);
  if (!integrationSlug) return;

  const client = createClient(opts);
  const out = await client.integrations.contract(integrationSlug);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsHealth(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  const integrationSlug = normalizeIntegrationId(slug);
  if (!integrationSlug) return;

  const client = createClient(opts);
  const out = await client.integrations.health(integrationSlug);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export function integrationsConnectStart(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  return runIntegrationAction(slug, opts, (client, integrationSlug) =>
    client.integrations.startConnect(integrationSlug),
  );
}

export function integrationsConnectCallback(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  return runIntegrationAction(slug, opts, (client, integrationSlug) =>
    client.integrations.finishConnect(integrationSlug),
  );
}

export function integrationsSync(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  return runIntegrationAction(slug, opts, (client, integrationSlug) =>
    client.integrations.sync(integrationSlug),
  );
}

export function integrationsBackfill(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  return runIntegrationAction(slug, opts, (client, integrationSlug) =>
    client.integrations.backfill(integrationSlug),
  );
}

export function integrationsPause(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  return runIntegrationAction(slug, opts, (client, integrationSlug) =>
    client.integrations.pause(integrationSlug),
  );
}

export function integrationsDisconnect(
  slug: string | undefined,
  opts: IntegrationsOpts = {},
): Promise<void> {
  return runIntegrationAction(slug, opts, (client, integrationSlug) =>
    client.integrations.disconnect(integrationSlug),
  );
}

export async function integrationsNativeProviders(
  family: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  const nativeFamily = normalizeNativeFamily(family);
  if (!nativeFamily) return;

  const client = createClient(opts);
  const out = await nativeFamilyResource(client, nativeFamily).providers();
  printWithDefaultTable(
    opts.output,
    out,
    compactNativeProviderRows(responseItems(out)),
  );
}

export async function integrationsNativeList(
  family: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  const nativeFamily = normalizeNativeFamily(family);
  if (!nativeFamily) return;

  if (
    nativeFamily !== "support" &&
    (opts.limit !== undefined || opts.cursor !== undefined)
  ) {
    console.error(
      "--limit and --cursor pagination are available only for the support read projection.",
    );
    process.exitCode = 1;
    return;
  }

  let supportOptions: SupportIntegrationListOptions = {};
  if (nativeFamily === "support") {
    try {
      supportOptions = supportIntegrationListOptionsFromOptions(opts);
    } catch (err) {
      printCommandError(err);
      return;
    }
  }

  const client = createClient(opts);
  const resource = nativeFamilyResource(client, nativeFamily);
  const out =
    nativeFamily === "support"
      ? await resource.list(supportOptions)
      : await resource.list();
  if (nativeFamily === "support") {
    let response: SupportIntegrationListResponse;
    try {
      response = decodeSupportIntegrationListResponse(
        out,
        supportOptions.limit ?? 50,
      );
    } catch {
      console.error(
        "Support list response failed its bounded tenant projection contract; no output was written.",
      );
      process.exitCode = 1;
      return;
    }
    const format = opts.output ?? "table";
    console.log(
      formatOutput(
        format === "table"
          ? compactNativeConnectionRows(response.items)
          : response,
        format,
      ),
    );
    if (format === "table") printSupportListPageMetadata(response.page);
    return;
  }
  printWithDefaultTable(
    opts.output,
    out,
    compactNativeConnectionRows(responseItems(out)),
  );
}

export async function integrationsNativeCreate(
  family: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  const nativeFamily = normalizeNativeFamily(family);
  if (!nativeFamily) return;
  if (holdSupportIntegrationRuntime(nativeFamily)) return;

  let input: NativeCommandCreateInput;
  try {
    input = nativeCreateInputFromOptions(opts, nativeFamily);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await nativeFamilyResource(client, nativeFamily).create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsNativeGet(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  const nativeFamily = normalizeNativeFamily(family);
  const integrationId = normalizeIntegrationId(id, "native integration id");
  if (!nativeFamily || !integrationId) return;

  const client = createClient(opts);
  const out = await nativeFamilyResource(client, nativeFamily).get(
    integrationId,
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

export function integrationsNativeSync(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  return runNativeIntegrationAction(
    family,
    id,
    opts,
    (resource, integrationId, input) => resource.sync(integrationId, input),
  );
}

export function integrationsNativeBackfill(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  return runNativeIntegrationAction(
    family,
    id,
    opts,
    (resource, integrationId, input) => resource.backfill(integrationId, input),
  );
}

export async function integrationsNativeIngest(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  const nativeFamily = normalizeNativeFamily(family);
  if (!nativeFamily) return;
  if (holdSupportIntegrationRuntime(nativeFamily)) return;
  const integrationId = normalizeIntegrationId(id, "native integration id");
  if (!integrationId) return;

  if (!supportsNativeIngest(nativeFamily)) {
    console.error(`Native ${nativeFamily} integrations do not support ingest.`);
    process.exitCode = 1;
    return;
  }

  let input: NativeCommandIngestInput;
  try {
    input = nativeIngestInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const resource = nativeFamilyResource(client, nativeFamily);
  if (!resource.ingest) {
    console.error(`Native ${nativeFamily} integrations do not support ingest.`);
    process.exitCode = 1;
    return;
  }
  const out = await resource.ingest(integrationId, input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export function integrationsNativePause(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  return runNativeIntegrationAction(
    family,
    id,
    opts,
    (resource, integrationId) => resource.pause(integrationId),
  );
}

export function integrationsNativeDisconnect(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  return runNativeIntegrationAction(
    family,
    id,
    opts,
    (resource, integrationId) => resource.disconnect(integrationId),
  );
}

export async function integrationsNativeRuns(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  const nativeFamily = normalizeNativeFamily(family);
  if (!nativeFamily) return;
  if (holdSupportIntegrationRuntime(nativeFamily)) return;
  const integrationId = normalizeIntegrationId(id, "native integration id");
  if (!integrationId) return;

  let limit: number;
  try {
    limit = normalizeLimit(opts.limit, 25);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const resource = nativeFamilyResource(client, nativeFamily);
  if (!resource.runs) {
    const label =
      nativeFamily === "commerce"
        ? "commerce integrations"
        : `native ${nativeFamily} integrations`;
    console.error(`Run history is not available for ${label}.`);
    process.exitCode = 1;
    return;
  }
  const out = await resource.runs(integrationId, limit);
  printWithDefaultTable(
    opts.output,
    out,
    compactNativeRunRows(responseItems(out)),
  );
}

export async function integrationsNativeCrmOAuthAvailability(
  provider: string | undefined,
  opts: NativeIntegrationsOpts = {},
): Promise<void> {
  const normalizedProvider = normalizeIntegrationId(provider, "CRM provider");
  if (!normalizedProvider) return;

  const client = createClient(opts);
  const resource = nativeFamilyResource(client, "crm");
  if (!resource.oauthAvailability) {
    console.error(
      "Native CRM OAuth availability is not supported by this SDK.",
    );
    process.exitCode = 1;
    return;
  }
  const out = await resource.oauthAvailability(normalizedProvider);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export function integrationsNativeCrmOAuthStartUrl(
  provider: string | undefined,
  opts: NativeIntegrationsOpts = {},
): void {
  const normalizedProvider = normalizeIntegrationId(provider, "CRM provider");
  if (!normalizedProvider) return;

  const client = createClient(opts);
  const resource = nativeFamilyResource(client, "crm");
  if (!resource.oauthStartUrl) {
    console.error("Native CRM OAuth start URLs are not supported by this SDK.");
    process.exitCode = 1;
    return;
  }
  let query: Record<string, string | number | boolean | null | undefined>;
  try {
    query = crmOAuthStartQueryFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }
  const out = {
    provider: normalizedProvider,
    start_url: resource.oauthStartUrl(normalizedProvider, query),
  };
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudienceProviders(
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.audienceDestinations.providers();
  printWithDefaultTable(
    opts.output,
    out,
    out.providers.map((provider) => ({ provider })),
  );
}

export async function integrationsAudienceList(
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const provider = optionalTrimmed(opts.provider);
  const client = createClient(opts);
  const out = await client.audienceDestinations.list(provider);
  printWithDefaultTable(
    opts.output,
    out,
    compactAudienceDestinationRows(out.items),
  );
}

export async function integrationsAudienceCreate(
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  let input: AudienceDestinationCreateInput;
  try {
    input = audienceDestinationCreateInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.audienceDestinations.create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudienceGet(
  id: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationId = normalizeIntegrationId(id, "audience destination id");
  if (!destinationId) return;

  const client = createClient(opts);
  const out = await client.audienceDestinations.get(destinationId);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudienceUpdate(
  id: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationId = normalizeIntegrationId(id, "audience destination id");
  if (!destinationId) return;

  let input: AudienceDestinationUpdateInput;
  try {
    input = audienceDestinationUpdateInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.audienceDestinations.update(destinationId, input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudienceReadiness(
  provider: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationProvider = normalizeIntegrationId(
    provider,
    "audience destination provider",
  );
  if (!destinationProvider) return;

  let config: Record<string, unknown> | undefined;
  try {
    config = parseJsonObjectOption(opts.config, "--config");
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.audienceDestinations.readiness(
    destinationProvider,
    config ?? {},
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudiencePreview(
  id: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationId = normalizeIntegrationId(id, "audience destination id");
  if (!destinationId) return;

  const client = createClient(opts);
  const out = await client.audienceDestinations.preview(destinationId);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudienceSync(
  id: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationId = normalizeIntegrationId(id, "audience destination id");
  if (!destinationId) return;

  const client = createClient(opts);
  const out = await client.audienceDestinations.sync(destinationId);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudienceJobs(
  id: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationId = normalizeIntegrationId(id, "audience destination id");
  if (!destinationId) return;

  const client = createClient(opts);
  const out = await client.audienceDestinations.jobs(destinationId);
  printWithDefaultTable(
    opts.output,
    out,
    compactAudienceDestinationJobRows(out.items),
  );
}

export async function integrationsAudienceJobDiagnostics(
  id: string | undefined,
  jobId: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationId = normalizeIntegrationId(id, "audience destination id");
  const destinationJobId = normalizeIntegrationId(
    jobId,
    "audience destination job id",
  );
  if (!destinationId || !destinationJobId) return;

  const client = createClient(opts);
  const out = await client.audienceDestinations.jobDiagnostics(
    destinationId,
    destinationJobId,
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsAudienceSyncRuns(
  id: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const syncId = normalizeIntegrationId(id, "audience sync id");
  if (!syncId) return;

  const client = createClient(opts);
  const out = await client.audienceSyncs.runs(syncId);
  printWithDefaultTable(
    opts.output,
    out,
    compactAudienceSyncRunRows(out.items),
  );
}

export async function integrationsAudienceDisconnect(
  id: string | undefined,
  opts: AudienceDestinationsOpts = {},
): Promise<void> {
  const destinationId = normalizeIntegrationId(id, "audience destination id");
  if (!destinationId) return;

  const client = createClient(opts);
  const out = await client.audienceDestinations.disconnect(destinationId);
  console.log(
    formatOutput(
      out ?? { status: "deleted", id: destinationId },
      opts.output ?? "json",
    ),
  );
}

export async function integrationsChatList(
  provider: string | undefined,
  opts: ChatIntegrationsOpts = {},
): Promise<void> {
  const chatProvider = normalizeChatProvider(provider);
  if (!chatProvider) return;

  const client = createClient(opts);
  const out = await client.chatIntegrations.forProvider(chatProvider).list();
  printWithDefaultTable(opts.output, out, compactChatIntegrationRows(out));
}

export async function integrationsChatCreate(
  provider: string | undefined,
  opts: ChatIntegrationsOpts = {},
): Promise<void> {
  const chatProvider = normalizeChatProvider(provider);
  if (!chatProvider) return;

  let input: ChatIntegrationCreateInput;
  try {
    input = chatIntegrationCreateInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.chatIntegrations
    .forProvider(chatProvider)
    .create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsChatUpdate(
  provider: string | undefined,
  id: string | undefined,
  opts: ChatIntegrationsOpts = {},
): Promise<void> {
  const chatProvider = normalizeChatProvider(provider);
  const integrationId = normalizeIntegrationId(id, "chat integration id");
  if (!chatProvider || !integrationId) return;

  let input: ChatIntegrationUpdateInput;
  try {
    input = chatIntegrationUpdateInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.chatIntegrations
    .forProvider(chatProvider)
    .update(integrationId, input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function integrationsChatDelete(
  provider: string | undefined,
  id: string | undefined,
  opts: ChatIntegrationsOpts = {},
): Promise<void> {
  const chatProvider = normalizeChatProvider(provider);
  const integrationId = normalizeIntegrationId(id, "chat integration id");
  if (!chatProvider || !integrationId) return;
  if (!opts.yes) {
    console.error(
      "This permanently deletes the chat integration; notifications stop. Pass --yes to confirm.",
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient(opts);
  const out = await client.chatIntegrations
    .forProvider(chatProvider)
    .delete(integrationId);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export function catalogQueryFromOptions(
  opts: IntegrationsOpts,
): IntegrationCatalogQuery {
  const query: IntegrationCatalogQuery = {};
  if (opts.query) query.q = opts.query;
  if (opts.category) query.category = opts.category;
  if (opts.badge) query.badge = normalizeBadge(opts.badge);
  if (opts.capability) query.capability = normalizeCapability(opts.capability);
  return query;
}

export function recipeQueryFromOptions(
  opts: IntegrationsOpts,
): IntegrationRecipesQuery {
  const query: IntegrationRecipesQuery = {};
  if (opts.query) query.q = opts.query;
  if (opts.source) query.source = opts.source;
  if (opts.target) query.target = opts.target;
  if (opts.provider) query.provider = opts.provider;
  if (opts.badge) query.badge = normalizeBadge(opts.badge);
  if (opts.capability) query.capability = normalizeCapability(opts.capability);
  if (opts.available === true) query.available = true;
  return query;
}

export function normalizeIntegrationId(
  value: string | undefined,
  label = "integration slug",
): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    console.error(`Pass a ${label}.`);
    process.exitCode = 1;
    return null;
  }
  const segments = trimmed.split("/");
  const valid = segments.every((segment) =>
    /^[a-z0-9][a-z0-9._-]*$/i.test(segment),
  );
  if (!valid) {
    console.error(
      `Pass a valid ${label} using slash-separated letters, numbers, dots, dashes, or underscores.`,
    );
    process.exitCode = 1;
    return null;
  }
  return trimmed;
}

export function normalizeNativeFamily(
  value: string | undefined,
): NativeIntegrationFamily | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    console.error("Pass a native integration family.");
    process.exitCode = 1;
    return null;
  }
  if (isNativeIntegrationFamily(trimmed)) return trimmed;
  console.error(
    `Unsupported native integration family "${value}". Use one of: ${NATIVE_INTEGRATION_FAMILIES.join(", ")}`,
  );
  process.exitCode = 1;
  return null;
}

export function normalizeBadge(value: string): IntegrationBadge {
  if (isIntegrationBadge(value)) return value;
  throw new Error(
    `Unsupported badge "${value}". Use one of: ${INTEGRATION_BADGES.join(", ")}`,
  );
}

export function normalizeCapability(value: string): IntegrationCapability {
  if (isIntegrationCapability(value)) return value;
  throw new Error(
    `Unsupported capability "${value}". Use one of: ${INTEGRATION_CAPABILITIES.join(", ")}`,
  );
}

export function compactCatalogRows(
  items: IntegrationCatalogItem[],
): TableRow[] {
  return items.map((item) => ({
    slug: item.slug,
    name: item.name,
    category: item.category,
    badge: item.badge,
    status: item.runtime_status,
    native: item.native,
    capabilities: summarizeList(item.capabilities),
  }));
}

export function compactConnectionRows(
  items: IntegrationConnection[],
): TableRow[] {
  return items.map((item) => ({
    slug: item.slug,
    name: item.name,
    connected: item.connected,
    status: item.status,
    count: item.count,
    health: item.health_state,
    last_sync_at: item.last_sync_at ?? "",
    primary_connection_id: item.primary_connection_id ?? "",
  }));
}

export function compactRecipeRows(items: IntegrationRecipe[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    provider: item.provider,
    source: item.source_slug,
    target: item.target_slug ?? "",
    badge: item.badge,
    available: item.available,
    minutes: item.estimated_minutes,
  }));
}

export function compactCoverageRows(
  items: IntegrationCategoryCoverage[],
): TableRow[] {
  return items.map((item) => ({
    category: item.key,
    total: item.total,
    native: item.native_managed,
    verified: item.native_verified,
    partial: item.native_partial,
    delegated: item.native_delegated,
    bridge_ready: item.bridge_ready,
    planned: item.planned,
    recipes: item.available_recipes,
    maturity: item.maturity,
  }));
}

export function compactStackRows(
  items: IntegrationCustomerStackCoverage[],
): TableRow[] {
  return items.map((item) => ({
    key: item.key,
    segment: item.segment,
    status: item.status,
    coverage_pct: item.coverage_pct,
    required: `${item.required_covered}/${item.required_total}`,
    optional: `${item.optional_covered}/${item.optional_total}`,
    native: item.native_managed,
    bridge_ready: item.bridge_ready,
  }));
}

export function compactReadinessRows(
  report: IntegrationReadinessReport,
): TableRow[] {
  const checks =
    report.checks.length > 0 ? report.checks : fallbackReadinessChecks(report);
  return checks.map((check) => ({
    check: check.key,
    state: check.state,
    severity: check.severity,
    count: check.count,
    message: check.message,
  }));
}

type NativeProviderTableItem =
  | NativeIntegrationProviderSpec
  | CommerceNativeProviderSpec;

export function compactNativeProviderRows(
  items: NativeProviderTableItem[],
): TableRow[] {
  return items.map((item) => {
    const row: TableRow = {
      key: "key" in item ? item.key : item.provider,
      name: item.name,
      category: item.category ?? "",
      auth_modes: summarizeList(
        "auth_mode" in item ? [item.auth_mode] : (item.auth_modes ?? []),
      ),
      sync_objects: summarizeList(item.sync_objects ?? []),
      webhook_topics: summarizeList(item.webhook_topics ?? []),
    };
    if (item.sync_model) row.sync_model = item.sync_model;
    if (item.verification_mode) row.verification = item.verification_mode;
    return row;
  });
}

export function compactNativeConnectionRows(
  items: NativeConnectionTableItem[],
): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    provider: item.provider ?? "",
    name: item.name ?? "",
    status: item.status ?? "",
    health: item.health_state ?? item.health ?? "",
    last_sync_at: item.last_sync_at ?? item.updated_at ?? "",
    last_error: item.last_error ?? item.error_message ?? item.error ?? "",
  }));
}

export function compactNativeRunRows(items: NativeRunTableItem[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    provider: item.provider ?? "",
    action: item.action ?? item.run_mode ?? "",
    status: item.status ?? "",
    attempts: item.attempts ?? item.retry_count ?? "",
    started_at: item.started_at ?? "",
    completed_at: item.completed_at ?? "",
    error: item.error ?? "",
  }));
}

export function compactAudienceDestinationRows(
  items: AudienceDestinationTableItem[],
): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    provider: item.provider,
    status: item.status,
    list_id: item.list_id ?? "",
    segment_id: item.segment_id ?? "",
    external_audience_id: item.external_audience_id ?? "",
    last_synced_at: item.last_synced_at ?? "",
    updated_at: item.updated_at ?? "",
  }));
}

export function compactAudienceDestinationJobRows(
  items: AudienceDestinationJobTableItem[],
): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    destination_id: item.destination_id,
    status: item.status,
    members_synced: item.members_synced,
    external_job_id: item.external_job_id ?? "",
    external_audience_id: item.external_audience_id ?? "",
    provider_message: item.provider_message ?? "",
    provider_status: item.provider_status ?? "",
    provider_checked_at: item.provider_checked_at ?? "",
    provider_next_check_at: item.provider_next_check_at ?? "",
    provider_poll_attempts: item.provider_poll_attempts ?? 0,
    started_at: item.started_at,
    finished_at: item.finished_at ?? "",
    error: item.error ?? "",
  }));
}

export function compactAudienceSyncRunRows(
  items: AudienceSyncRunTableItem[],
): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    sync_id: item.sync_id,
    status: item.status,
    rows_exported: item.rows_exported,
    batches_sent: item.batches_sent,
    external_job_id: item.external_job_id ?? "",
    external_audience_id: item.external_audience_id ?? "",
    provider_message: item.provider_message ?? "",
    provider_status: item.provider_status ?? "",
    provider_checked_at: item.provider_checked_at ?? "",
    provider_next_check_at: item.provider_next_check_at ?? "",
    provider_poll_attempts: item.provider_poll_attempts ?? 0,
    excluded_count: item.excluded_count ?? 0,
    started_at: item.started_at,
    finished_at: item.finished_at ?? "",
    error: item.error ?? "",
  }));
}

export function audienceDestinationCreateInputFromOptions(
  opts: AudienceDestinationsOpts,
): AudienceDestinationCreateInput {
  const provider = optionalTrimmed(opts.provider);
  if (!provider)
    throw new Error("Pass --provider for audience destination create.");
  const input: AudienceDestinationCreateInput = { provider };
  const listId = optionalTrimmed(opts.listId);
  if (listId) input.list_id = listId;
  const segmentId = optionalTrimmed(opts.segmentId);
  if (segmentId) input.segment_id = segmentId;
  if (!listId && !segmentId) {
    throw new Error(
      "Pass --list-id or --segment-id for audience destination create.",
    );
  }
  const externalAudienceId = optionalTrimmed(opts.externalAudienceId);
  if (externalAudienceId) input.external_audience_id = externalAudienceId;
  const config = parseJsonObjectOption(opts.config, "--config");
  if (config) {
    rejectRawAudienceDestinationCredentials(config);
    input.config = config;
  }
  return input;
}

export function audienceDestinationUpdateInputFromOptions(
  opts: AudienceDestinationsOpts,
): AudienceDestinationUpdateInput {
  const input: AudienceDestinationUpdateInput = {};
  const status = optionalTrimmed(opts.status);
  if (status) input.status = status;
  const externalAudienceId = optionalTrimmed(opts.externalAudienceId);
  if (externalAudienceId) input.external_audience_id = externalAudienceId;
  const config = parseJsonObjectOption(opts.config, "--config");
  if (config) {
    rejectRawAudienceDestinationCredentials(config);
    input.config = config;
  }
  if (Object.keys(input).length === 0) {
    throw new Error(
      "Pass --status, --external-audience-id, or --config for audience destination update.",
    );
  }
  return input;
}

const AUDIENCE_DESTINATION_RAW_CREDENTIAL_KEYS = new Set([
  "access_token",
  "api_key",
  "api_secret",
  "client_secret",
  "developer_token",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "token",
]);

const AUDIENCE_DESTINATION_UNSAFE_TRANSPORT_KEYS = new Set([
  "api_base",
  "base_url",
  "endpoint_url",
]);

function rejectRawAudienceDestinationCredentials(
  config: Record<string, unknown>,
): void {
  const blocked = findBlockedAudienceDestinationConfigKey(config);
  if (blocked) {
    if (blocked.kind === "credential") {
      throw new Error(
        `Audience destination config must store credential references, not raw ${blocked.path}.`,
      );
    }
    throw new Error(
      `Audience destination config cannot override provider API hosts (${blocked.path}).`,
    );
  }
}

function findBlockedAudienceDestinationConfigKey(
  value: unknown,
  prefix = "",
): { kind: "credential" | "transport"; path: string } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBlockedAudienceDestinationConfigKey(item, prefix);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const normalized = key.trim().toLowerCase();
    const path = prefix ? `${prefix}.${key}` : key;
    if (AUDIENCE_DESTINATION_RAW_CREDENTIAL_KEYS.has(normalized)) {
      return { kind: "credential", path };
    }
    if (AUDIENCE_DESTINATION_UNSAFE_TRANSPORT_KEYS.has(normalized)) {
      return { kind: "transport", path };
    }
    const found = findBlockedAudienceDestinationConfigKey(
      (value as Record<string, unknown>)[key],
      path,
    );
    if (found) return found;
  }
  return null;
}

export function normalizeChatProvider(
  value: string | undefined,
): ChatIntegrationProvider | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    console.error("Pass a chat integration provider.");
    process.exitCode = 1;
    return null;
  }
  if (isChatIntegrationProvider(trimmed)) return trimmed;
  console.error(
    `Unsupported chat integration provider "${value}". Use one of: ${CHAT_INTEGRATION_PROVIDERS.join(", ")}`,
  );
  process.exitCode = 1;
  return null;
}

export function compactChatIntegrationRows(
  items: ChatIntegrationTableItem[],
): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    channel_hint: item.channel_hint ?? "",
    events: summarizeList(item.events ?? []),
    enabled: item.enabled,
    last_delivery_status: item.last_delivery_status ?? "",
    last_delivery_at: item.last_delivery_at ?? "",
    last_delivery_error: item.last_delivery_error ?? "",
    updated_at: item.updated_at ?? "",
  }));
}

export function chatIntegrationCreateInputFromOptions(
  opts: ChatIntegrationsOpts,
): ChatIntegrationCreateInput {
  const url = optionalTrimmed(opts.url);
  if (!url) throw new Error("Pass --url for chat integration create.");
  const events = parseCsvList(opts.events);
  if (events.length === 0)
    throw new Error("Pass --events for chat integration create.");
  const input: ChatIntegrationCreateInput = { url, events };
  const channelHint = optionalTrimmed(opts.channelHint);
  if (channelHint) input.channel_hint = channelHint;
  return input;
}

export function chatIntegrationUpdateInputFromOptions(
  opts: ChatIntegrationsOpts,
): ChatIntegrationUpdateInput {
  const input: ChatIntegrationUpdateInput = {};
  const url = optionalTrimmed(opts.url);
  if (url) input.url = url;
  const channelHint = optionalTrimmed(opts.channelHint);
  if (channelHint) input.channel_hint = channelHint;
  const events = parseCsvList(opts.events);
  if (events.length > 0) input.events = events;
  const enabled = optionalBooleanOption(opts.enabled, "--enabled");
  if (enabled !== undefined) input.enabled = enabled;
  if (Object.keys(input).length === 0) {
    throw new Error(
      "Pass --url, --channel-hint, --events, or --enabled for chat integration update.",
    );
  }
  return input;
}

export function nativeCreateInputFromOptions(
  opts: NativeIntegrationsOpts,
  family: NativeIntegrationFamily = "crm",
): NativeCommandCreateInput {
  const provider = (opts.provider ?? "").trim();
  if (!provider)
    throw new Error("Pass --provider for native integration create.");

  if (family === "commerce")
    return commerceCreateInputFromOptions(provider, opts);
  if (family === "warehouse")
    return warehouseCreateInputFromOptions(provider, opts);
  if (family === "analytics")
    return analyticsCreateInputFromOptions(provider, opts);
  if (
    family === "crm" ||
    family === "lead" ||
    family === "marketing" ||
    family === "reviews" ||
    family === "loyalty" ||
    family === "subscriptions" ||
    family === "support"
  ) {
    return managedCanonicalCreateInputFromOptions(provider, opts, family);
  }

  const input: NativeIntegrationCreateInput = { provider };
  const name = (opts.name ?? "").trim();
  if (name) input.name = name;
  const config = parseJsonObjectOption(opts.config, "--config");
  if (config) input.config = config;
  const credentials = parseJsonObjectOption(opts.credentials, "--credentials");
  if (credentials) input.credentials = credentials;
  const metadata = parseJsonObjectOption(opts.metadata, "--metadata");
  if (metadata) input.metadata = metadata;
  const scopes = parseCsvList(opts.scopes);
  if (scopes.length > 0) input.scopes = scopes;
  return input;
}

export function nativeLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
  family: NativeIntegrationFamily = "crm",
): NativeCommandLifecycleInput {
  if (family === "commerce") return commerceLifecycleInputFromOptions(opts);
  if (family === "warehouse") return warehouseLifecycleInputFromOptions(opts);
  if (family === "analytics") return analyticsLifecycleInputFromOptions(opts);
  if (family === "marketing") return marketingLifecycleInputFromOptions(opts);
  if (family === "crm") return crmLifecycleInputFromOptions(opts);
  if (family === "lead") return leadLifecycleInputFromOptions(opts);
  if (family === "reviews") return reviewLifecycleInputFromOptions(opts);
  if (family === "loyalty") return loyaltyLifecycleInputFromOptions(opts);
  if (family === "subscriptions")
    return subscriptionLifecycleInputFromOptions(opts);
  if (family === "support") return supportLifecycleInputFromOptions(opts);

  const input: NativeIntegrationLifecycleInput = {};
  const since = (opts.since ?? "").trim();
  if (since) input.since = since;
  if (opts.full === true) input.full = true;
  const objects = parseCsvList(opts.objects);
  if (objects.length > 0) input.objects = objects;
  const reason = (opts.reason ?? "").trim();
  if (reason) input.reason = reason;
  const metadata = parseJsonObjectOption(opts.metadata, "--metadata");
  if (metadata) input.metadata = metadata;
  return input;
}

export function nativeIngestInputFromOptions(
  opts: NativeIntegrationsOpts,
): NativeCommandIngestInput {
  const input = parseJsonObjectOption(opts.payload, "--payload");
  if (!input)
    throw new Error(
      "Pass --payload as a JSON object for native integration ingest.",
    );
  return input;
}

function crmOAuthStartQueryFromOptions(
  opts: NativeIntegrationsOpts,
): Record<string, string | number | boolean | null | undefined> {
  const query: Record<string, string | number | boolean | null | undefined> =
    {};
  const name = (opts.name ?? "").trim();
  if (name) query.name = name;
  const redirectTo = (opts.redirectTo ?? "").trim();
  if (redirectTo) query.redirect_to = redirectTo;
  const config = parseJsonObjectOption(opts.config, "--config");
  for (const [key, value] of Object.entries(config ?? {})) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      query[key] = value;
    }
  }
  return query;
}

function fallbackReadinessChecks(
  report: IntegrationReadinessReport,
): IntegrationReadinessCheck[] {
  return [
    {
      key: "public_catalog_parity",
      label: "Public catalog parity",
      state: report.public_parity ? "pass" : "fail",
      severity: report.public_parity ? "ok" : "blocker",
      count: report.public_entries,
      message: `${report.public_entries}/${report.target_public_entries} visible integrations cataloged.`,
    },
    {
      key: "native_managed_parity",
      label: "Native-managed parity",
      state: report.native_parity ? "pass" : "fail",
      severity: report.native_parity ? "ok" : "blocker",
      count: report.native_managed,
      message: `${report.native_managed}/${report.target_native_managed} native-managed connectors cataloged.`,
    },
    {
      key: "native_api_verified_parity",
      label: "Native API verification parity",
      state: report.native_verification_parity ? "pass" : "fail",
      severity: report.native_verification_parity ? "ok" : "warning",
      count: report.native_verified,
      message: `${report.native_verified}/${report.target_native_verified} native connectors are API-verified.`,
    },
    {
      key: "blocking_issues",
      label: "Blocking readiness issues",
      state: report.ready ? "pass" : "fail",
      severity: report.ready ? "ok" : "blocker",
      count: report.issue_counts["severity:blocker"] ?? 0,
      message: `${report.issue_counts["severity:blocker"] ?? 0} blocker issue(s) found.`,
    },
  ];
}

function isIntegrationBadge(value: string): value is IntegrationBadge {
  return INTEGRATION_BADGES.includes(value as IntegrationBadge);
}

function isIntegrationCapability(
  value: string,
): value is IntegrationCapability {
  return INTEGRATION_CAPABILITIES.includes(value as IntegrationCapability);
}

function isNativeIntegrationFamily(
  value: string,
): value is NativeIntegrationFamily {
  return NATIVE_INTEGRATION_FAMILIES.includes(value as NativeIntegrationFamily);
}

function isChatIntegrationProvider(
  value: string,
): value is ChatIntegrationProvider {
  return CHAT_INTEGRATION_PROVIDERS.includes(value as ChatIntegrationProvider);
}

export function supportsNativeIngest(family: NativeIntegrationFamily): boolean {
  return (NATIVE_INGEST_FAMILIES as readonly string[]).includes(family);
}

function summarizeList(values: readonly string[], limit = 4): string {
  if (values.length <= limit) return values.join(",");
  return `${values.slice(0, limit).join(",")} +${values.length - limit}`;
}

function optionalTrimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

function parseCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObjectOption(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function commerceCreateInputFromOptions(
  provider: string,
  opts: NativeIntegrationsOpts,
): CommerceNativeIntegrationCreateInput {
  rejectRawCredentials(opts, "commerce");
  const settings = parseJsonObjectOption(opts.config, "--config");
  const input: CommerceNativeIntegrationCreateInput = { provider };
  const shopDomain = firstString(
    (opts.shopDomain ?? "").trim(),
    stringFromRecord(settings, "shop_domain"),
  );
  if (shopDomain) input.shop_domain = shopDomain;
  const credentialRef = credentialRefFromOptions(opts, settings);
  if (credentialRef) input.credential_ref = credentialRef;
  const scopes = parseCsvList(opts.scopes);
  if (scopes.length > 0) input.scopes = scopes;
  const cleanedSettings = withoutCredentialRefs(settings);
  if (cleanedSettings) input.settings = cleanedSettings;
  return input;
}

function warehouseCreateInputFromOptions(
  provider: string,
  opts: NativeIntegrationsOpts,
): WarehouseNativeConnectionInput {
  rejectRawCredentials(opts, "warehouse");
  const name = (opts.name ?? "").trim();
  if (!name)
    throw new Error("Pass --name for native warehouse integration create.");
  const config = parseJsonObjectOption(opts.config, "--config");
  const input: WarehouseNativeConnectionInput = { name, provider };
  const direction = (opts.direction ?? "").trim();
  if (direction) input.direction = direction;
  const cadence = (opts.cadence ?? "").trim();
  if (cadence) input.cadence = cadence;
  const credentialRef = credentialRefFromOptions(opts, config);
  if (credentialRef) input.credentials_ref = credentialRef;
  const objects = parseCsvList(opts.objects);
  if (objects.length > 0) input.object_selection = objects;
  const backfillDays = positiveIntegerOption(
    opts.backfillDays,
    "--backfill-days",
    1,
    3650,
  );
  if (backfillDays !== undefined) input.backfill_days = backfillDays;
  const cleanedConfig = withoutCredentialRefs(config);
  if (cleanedConfig) input.config = cleanedConfig;
  return input;
}

function analyticsCreateInputFromOptions(
  provider: string,
  opts: NativeIntegrationsOpts,
): AnalyticsIntegrationInput {
  rejectRawCredentials(opts, "analytics");
  const settings = parseJsonObjectOption(opts.config, "--config");
  const input: AnalyticsIntegrationInput = { provider };
  const name = (opts.name ?? "").trim();
  if (name) input.name = name;
  const credentialRef = credentialRefFromOptions(opts, settings);
  if (credentialRef) input.credentials_ref = credentialRef;
  const scopes = parseCsvList(opts.scopes);
  if (scopes.length > 0) input.scopes = scopes;
  const cleanedSettings = withoutCredentialRefs(settings);
  if (cleanedSettings) input.settings = cleanedSettings;
  return input;
}

function managedCanonicalCreateInputFromOptions(
  provider: string,
  opts: NativeIntegrationsOpts,
  family:
    | "crm"
    | "lead"
    | "marketing"
    | "reviews"
    | "loyalty"
    | "subscriptions"
    | "support",
): ManagedNativeIntegrationInput {
  rejectRawCredentials(opts, family);
  const settings = parseJsonObjectOption(opts.config, "--config");
  const input: ManagedNativeIntegrationInput = { provider };
  const name = (opts.name ?? "").trim();
  if (name) input.name = name;
  const credentialRef = credentialRefFromOptions(opts, settings);
  if (credentialRef) input.credentials_ref = credentialRef;
  const scopes = parseCsvList(opts.scopes);
  if (scopes.length > 0) input.scopes = scopes;
  const cleanedSettings = withoutCredentialRefs(settings);
  if (cleanedSettings) input.settings = cleanedSettings;
  return input;
}

function commerceLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): CommerceNativeSyncInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: CommerceNativeSyncInput = payload ? { ...payload } : {};
  const cursor = (opts.cursor ?? "").trim();
  if (cursor) input.cursor = cursor;
  return input;
}

function crmLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): CRMSyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: CRMSyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  return input;
}

function leadLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): LeadSyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: LeadSyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  return input;
}

function subscriptionLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): SubscriptionSyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: SubscriptionSyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  return input;
}

function reviewLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): ReviewSyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: ReviewSyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  return input;
}

function loyaltyLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): LoyaltySyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: LoyaltySyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  return input;
}

function supportLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): SupportSyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: SupportSyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  return input;
}

function analyticsLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): AnalyticsSyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: AnalyticsSyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  return input;
}

function marketingLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): MarketingSyncRequest {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: MarketingSyncRequest = payload ? { ...payload } : {};
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) input.cursor = cursor;
  const metadata = parseJsonObjectOption(opts.metadata, "--metadata");
  if (metadata) input.metadata = metadata;
  return input;
}

function warehouseLifecycleInputFromOptions(
  opts: NativeIntegrationsOpts,
): WarehouseNativeRunInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: WarehouseNativeRunInput = payload ? { ...payload } : {};
  const objects = parseCsvList(opts.objects);
  if (objects.length > 0) input.object_selection = objects;
  const cursor = firstString(
    (opts.cursor ?? "").trim(),
    (opts.since ?? "").trim(),
  );
  if (cursor) {
    throw new Error(
      "Warehouse runs do not accept --cursor/--since; use connection backfill_days, import_prefix, input_uri, or --payload import_rows.",
    );
  }
  const metrics = parseJsonObjectOption(opts.metadata, "--metadata");
  if (metrics) {
    throw new Error(
      "Warehouse run metrics are server-generated; --metadata is not accepted for warehouse sync/backfill.",
    );
  }
  return input;
}

function rejectRawCredentials(
  opts: NativeIntegrationsOpts,
  family: NativeIntegrationFamily,
): void {
  if ((opts.credentials ?? "").trim()) {
    throw new Error(
      `Native ${family} connections use credential references; pass --credential-ref instead of --credentials.`,
    );
  }
}

function credentialRefFromOptions(
  opts: NativeIntegrationsOpts,
  config: Record<string, unknown> | undefined,
): string {
  return firstString(
    (opts.credentialRef ?? "").trim(),
    stringFromRecord(config, "credential_ref"),
    stringFromRecord(config, "credentials_ref"),
  );
}

function withoutCredentialRefs(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const cleaned: Record<string, unknown> = { ...input };
  delete cleaned.credential_ref;
  delete cleaned.credentials_ref;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function stringFromRecord(
  input: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = input?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: string[]): string {
  return values.find((value) => value.trim() !== "") ?? "";
}

function positiveIntegerOption(
  value: string | number | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Pass ${label} as an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function optionalBooleanOption(
  value: string | boolean | undefined,
  label: string,
): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`Pass ${label} as true or false.`);
}

function responseItems<T>(out: unknown): T[] {
  if (Array.isArray(out)) return out as T[];
  if (out && typeof out === "object") {
    const items = (out as { items?: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}

function normalizeLimit(
  value: string | number | undefined,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("Pass --limit as an integer from 1 to 500.");
  }
  return parsed;
}

function supportIntegrationListOptionsFromOptions(
  opts: NativeIntegrationsOpts,
): SupportIntegrationListOptions {
  const options: SupportIntegrationListOptions = {};
  if (opts.limit !== undefined) {
    const parsed = (() => {
      if (typeof opts.limit === "number") return opts.limit;
      if (!/^[1-9][0-9]{0,2}$/u.test(opts.limit)) return Number.NaN;
      return Number(opts.limit);
    })();
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new Error("Pass --limit as an integer from 1 to 100.");
    }
    options.limit = parsed;
  }
  if (opts.cursor !== undefined) {
    options.cursor = validateSupportListCursor(opts.cursor);
  }
  return options;
}

function validateSupportListCursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !validUnicodeString(value) ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    SUPPORT_LIST_UNSAFE_CURSOR_RE.test(value)
  ) {
    throw new Error(
      "Pass --cursor as an opaque token without controls, bidi markers, or surrounding whitespace (maximum 4096 characters).",
    );
  }
  return value;
}

function decodeSupportIntegrationListResponse(
  value: unknown,
  limit: number,
): SupportIntegrationListResponse {
  if (!exactRecordKeys(value, ["items", "page", "tenantId"])) {
    throw new Error("support list envelope invalid");
  }
  const tenantId = value.tenantId;
  const items = value.items;
  const page = value.page;
  if (
    typeof tenantId !== "string" ||
    !SUPPORT_LIST_UUID_RE.test(tenantId) ||
    !Array.isArray(items) ||
    items.length > limit ||
    !exactRecordKeys(page, [
      "as_of",
      "consistency",
      "has_more",
      "may_reorder",
      "next_cursor",
    ])
  ) {
    throw new Error("support list envelope invalid");
  }
  const asOf = normalizeSupportListTimestamp(page.as_of);
  if (
    !asOf ||
    page.consistency !== "mutable_window" ||
    page.may_reorder !== true ||
    typeof page.has_more !== "boolean" ||
    (page.has_more && items.length !== limit) ||
    (page.has_more
      ? validateSupportListCursor(page.next_cursor) !== page.next_cursor
      : page.next_cursor !== null)
  ) {
    throw new Error("support list page invalid");
  }

  const ids = new Set<string>();
  let previous: { updatedAt: string; id: string } | null = null;
  for (const candidate of items) {
    if (!exactRecordKeys(candidate, SUPPORT_LIST_ROW_KEYS)) {
      throw new Error("support list row invalid");
    }
    const createdAt = normalizeSupportListTimestamp(candidate.created_at);
    const updatedAt = normalizeSupportListTimestamp(candidate.updated_at);
    if (
      candidate.tenantId !== tenantId ||
      candidate.tenant_id !== tenantId ||
      typeof candidate.id !== "string" ||
      !SUPPORT_LIST_UUID_RE.test(candidate.id) ||
      ids.has(candidate.id) ||
      typeof candidate.provider !== "string" ||
      !SUPPORT_LIST_PROVIDER_RE.test(candidate.provider) ||
      typeof candidate.name !== "string" ||
      candidate.name.trim().length === 0 ||
      !validUnicodeString(candidate.name) ||
      Buffer.byteLength(candidate.name, "utf8") > 200 ||
      SUPPORT_LIST_UNSAFE_CURSOR_RE.test(candidate.name) ||
      typeof candidate.status !== "string" ||
      !SUPPORT_LIST_STATUS.has(candidate.status) ||
      candidate.runtime_status !== "held" ||
      candidate.hold_code !== SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE ||
      typeof candidate.credential_configured !== "boolean" ||
      !createdAt ||
      !updatedAt ||
      createdAt > updatedAt ||
      updatedAt > asOf ||
      (previous !== null &&
        (previous.updatedAt < updatedAt ||
          (previous.updatedAt === updatedAt && previous.id <= candidate.id)))
    ) {
      throw new Error("support list row invalid");
    }
    ids.add(candidate.id);
    previous = { updatedAt, id: candidate.id };
  }
  return value as unknown as SupportIntegrationListResponse;
}

function exactRecordKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function validUnicodeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeSupportListTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = SUPPORT_LIST_TIMESTAMP_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() !== month - 1 ||
    timestamp.getUTCDate() !== day ||
    timestamp.getUTCHours() !== hour ||
    timestamp.getUTCMinutes() !== minute ||
    timestamp.getUTCSeconds() !== second
  ) {
    return null;
  }
  return `${value.slice(0, 19)}.${(match[7] ?? "").padEnd(9, "0")}Z`;
}

function printSupportListPageMetadata(
  page: SupportIntegrationListResponse["page"],
): void {
  if (!page.has_more) {
    console.error("Support page: has_more=false; no next page.");
    return;
  }
  console.error(
    `Support page: has_more=true; page.next_cursor=${JSON.stringify(page.next_cursor)}. Continue with --cursor using this exact value.`,
  );
}

function printWithDefaultTable(
  output: OutputFormat | undefined,
  full: unknown,
  rows: TableRow[],
): void {
  const format = output ?? "table";
  console.log(formatOutput(format === "table" ? rows : full, format));
}

function printCommandError(err: unknown): void {
  console.error((err as Error).message);
  process.exitCode = 1;
}

async function runIntegrationAction(
  slug: string | undefined,
  opts: IntegrationsOpts,
  action: (
    client: ReturnType<typeof createClient>,
    integrationSlug: string,
  ) => Promise<unknown>,
): Promise<void> {
  const integrationSlug = normalizeIntegrationId(slug);
  if (!integrationSlug) return;

  const client = createClient(opts);
  const out = await action(client, integrationSlug);
  console.log(formatOutput(out, opts.output ?? "json"));
}

async function runNativeIntegrationAction(
  family: string | undefined,
  id: string | undefined,
  opts: NativeIntegrationsOpts,
  action: (
    resource: NativeCommandResource,
    integrationId: string,
    input: NativeCommandLifecycleInput,
  ) => Promise<unknown>,
): Promise<void> {
  const nativeFamily = normalizeNativeFamily(family);
  if (!nativeFamily) return;
  if (holdSupportIntegrationRuntime(nativeFamily)) return;
  const integrationId = normalizeIntegrationId(id, "native integration id");
  if (!integrationId) return;

  let input: NativeCommandLifecycleInput;
  try {
    input = nativeLifecycleInputFromOptions(opts, nativeFamily);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await action(
    nativeFamilyResource(client, nativeFamily),
    integrationId,
    input,
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

function holdSupportIntegrationRuntime(
  family: NativeIntegrationFamily,
): boolean {
  if (family !== "support") return false;
  console.error(SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE);
  process.exitCode = 1;
  return true;
}

function nativeFamilyResource(
  client: ReturnType<typeof createClient>,
  family: NativeIntegrationFamily,
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
