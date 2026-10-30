// SPDX-License-Identifier: MIT

import type {
  DeveloperMarketplaceApp,
  DeveloperMarketplaceAppInput,
  DeveloperMarketplaceAuditLog,
  DeveloperMarketplaceInstallation,
  DeveloperMarketplaceInstallationInput,
  DeveloperMarketplaceListing,
  DeveloperMarketplaceListingInput,
  DeveloperMarketplaceOAuthAuthorizeInput,
  DeveloperMarketplaceOAuthClient,
  DeveloperMarketplaceOAuthClientInput,
  DeveloperMarketplaceOAuthRevokeRequest,
  DeveloperMarketplaceOAuthTokenRequest,
  DeveloperMarketplacePartnerProfile,
  DeveloperMarketplacePartnerProfileInput,
  DeveloperMarketplacePartnerProfileReviewDecisionInput,
  DeveloperMarketplaceReviewDecisionInput,
  DeveloperMarketplaceReviewQueueQuery,
  DeveloperMarketplaceTestAccount,
  DeveloperMarketplaceTestAccountInput,
  DeveloperMarketplaceWebhookSubscription,
  DeveloperMarketplaceWebhookSubscriptionInput,
} from "@postwave/sdk";
import { createClient, type ClientOpts } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface DeveloperMarketplaceOpts extends ClientOpts {
  output?: OutputFormat;
  payload?: string;
  status?: string;
  category?: string;
  profileType?: string;
  reviewSecret?: string;
  kind?: string;
  state?: string;
  limit?: string | number;
  tenantId?: string;
  decision?: string;
  notes?: string;
  partnerLevel?: string;
}

type RowValue = string | number | boolean | null | undefined;
type TableRow = Record<string, RowValue>;

export async function developerMarketplaceCatalog(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.developerMarketplace.catalog();
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function developerMarketplaceAppsList(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.developerMarketplace.listApps(optionalTrimmed(opts.status) || undefined);
  printWithDefaultTable(opts.output, out, compactAppRows(responseItems(out)));
}

export async function developerMarketplaceAppValidate(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.validateApp(input as DeveloperMarketplaceAppInput),
  );
}

export async function developerMarketplaceAppCreate(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.createApp(input as DeveloperMarketplaceAppInput),
  );
}

export async function developerMarketplaceAppGet(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.developerMarketplace.getApp(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function developerMarketplaceAppUpdate(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.updateApp(id, input as DeveloperMarketplaceAppInput),
  );
}

export async function developerMarketplaceAppSubmitReview(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runAppAction(appId, opts, (client, id) => client.developerMarketplace.submitAppReview(id));
}

export async function developerMarketplaceAppMonitoring(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.developerMarketplace.monitoring(id);
  printWithDefaultTable(opts.output, out, [
    {
      app_id: id,
      ready: out.ready,
      status: out.status,
      blockers: out.blockers?.length ?? 0,
      warnings: out.warnings?.length ?? 0,
      oauth_clients: out.counts.oauth_clients.total,
      installations: out.counts.installations.total,
      webhook_subscriptions: out.counts.webhook_subscriptions.total,
      test_accounts: out.counts.test_accounts.total,
    },
  ]);
}

export async function developerMarketplaceOAuthClientsList(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.developerMarketplace.listOAuthClients(id);
  printWithDefaultTable(opts.output, out, compactOAuthClientRows(responseItems(out)));
}

export async function developerMarketplaceOAuthClientCreate(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.createOAuthClient(
      id,
      input as unknown as DeveloperMarketplaceOAuthClientInput,
    ),
  );
}

export async function developerMarketplaceOAuthClientRevoke(
  appId: string | undefined,
  clientId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const app = normalizeMarketplaceId(appId, "marketplace app id");
  const client = normalizeMarketplaceId(clientId, "OAuth client id");
  if (!app || !client) return;

  const pw = createClient(opts);
  const out = await pw.developerMarketplace.revokeOAuthClient(app, client);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function developerMarketplaceTestAccountsList(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.developerMarketplace.listTestAccounts(id);
  printWithDefaultTable(opts.output, out, compactTestAccountRows(responseItems(out)));
}

export async function developerMarketplaceTestAccountCreate(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.createTestAccount(id, input as DeveloperMarketplaceTestAccountInput),
  );
}

export async function developerMarketplaceListingsList(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.developerMarketplace.listListings(optionalTrimmed(opts.category) || undefined);
  printWithDefaultTable(opts.output, out, compactListingRows(responseItems(out)));
}

export async function developerMarketplaceListingUpsert(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.upsertListing(id, input as DeveloperMarketplaceListingInput),
  );
}

export async function developerMarketplaceListingSubmitReview(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runAppAction(appId, opts, (client, id) => client.developerMarketplace.submitListingReview(id));
}

export async function developerMarketplaceInstallationsList(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.developerMarketplace.listInstallations(optionalTrimmed(opts.status) || undefined);
  printWithDefaultTable(opts.output, out, compactInstallationRows(responseItems(out)));
}

export async function developerMarketplaceInstallApp(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.installApp(id, input as DeveloperMarketplaceInstallationInput),
  );
}

export async function developerMarketplaceInstallationRevoke(
  installationId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(installationId, "installation id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.developerMarketplace.revokeInstallation(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function developerMarketplaceWebhooksList(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.developerMarketplace.listWebhookSubscriptions(id);
  printWithDefaultTable(opts.output, out, compactWebhookRows(responseItems(out)));
}

export async function developerMarketplaceWebhookCreate(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.createWebhookSubscription(
      id,
      input as DeveloperMarketplaceWebhookSubscriptionInput,
    ),
  );
}

export async function developerMarketplacePartnerProfilesList(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.developerMarketplace.listPartnerProfiles(
    optionalTrimmed(opts.profileType) as never,
  );
  printWithDefaultTable(opts.output, out, compactPartnerProfileRows(responseItems(out)));
}

export async function developerMarketplacePartnerProfileUpsert(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.upsertPartnerProfile(
      input as DeveloperMarketplacePartnerProfileInput,
    ),
  );
}

export async function developerMarketplacePartnerProfileSubmitReview(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.developerMarketplace.submitPartnerProfileReview();
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function developerMarketplaceReviewQueue(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const secret = reviewSecretFromOptions(opts);
  if (!secret) return;

  let query: DeveloperMarketplaceReviewQueueQuery;
  try {
    query = reviewQueueQueryFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.developerMarketplace.reviewQueue(secret, query);
  printWithDefaultTable(opts.output, out, out.items.map((item) => ({
    kind: item.kind,
    app_id: item.app_id,
    tenant_id: item.tenant_id,
    name: item.name,
    app_status: item.app_status,
    review_state: item.review_state ?? "",
    partner_level: item.partner_level ?? "",
    updated_at: item.updated_at,
  })));
}

export async function developerMarketplaceReviewAppDecision(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runReviewDecision(appId, opts, (client, id, input, secret) =>
    client.developerMarketplace.reviewAppDecision(id, input, secret),
  );
}

export async function developerMarketplaceReviewListingDecision(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runReviewDecision(appId, opts, (client, id, input, secret) =>
    client.developerMarketplace.reviewListingDecision(id, input, secret),
  );
}

export async function developerMarketplaceReviewPartnerProfileDecision(
  tenantId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const tenant = normalizeMarketplaceId(tenantId, "tenant id");
  const secret = reviewSecretFromOptions(opts);
  if (!tenant || !secret) return;

  let input: DeveloperMarketplacePartnerProfileReviewDecisionInput;
  try {
    input = partnerProfileDecisionInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.developerMarketplace.reviewPartnerProfileDecision(
    tenant,
    input,
    secret,
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function developerMarketplaceOAuthAuthorize(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.authorize(
      input as unknown as DeveloperMarketplaceOAuthAuthorizeInput,
    ),
  );
}

export async function developerMarketplaceOAuthToken(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.token(
      input as unknown as DeveloperMarketplaceOAuthTokenRequest,
    ),
  );
}

export async function developerMarketplaceOAuthRevoke(
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  await runPayloadCommand(opts, "--payload", async (client, input) =>
    client.developerMarketplace.revoke(
      input as unknown as DeveloperMarketplaceOAuthRevokeRequest,
    ),
  );
}

export async function developerMarketplaceAuditLogsList(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts = {},
): Promise<void> {
  const client = createClient(opts);
  const out = await client.developerMarketplace.listAuditLogs(
    optionalTrimmed(appId) || undefined,
  );
  printWithDefaultTable(opts.output, out, compactAuditLogRows(responseItems(out)));
}

export function reviewQueueQueryFromOptions(
  opts: DeveloperMarketplaceOpts,
): DeveloperMarketplaceReviewQueueQuery {
  const query: DeveloperMarketplaceReviewQueueQuery = {};
  const kind = optionalTrimmed(opts.kind);
  if (kind) query.kind = kind as DeveloperMarketplaceReviewQueueQuery["kind"];
  const state = optionalTrimmed(opts.state);
  if (state) query.state = state as DeveloperMarketplaceReviewQueueQuery["state"];
  const limit = positiveIntegerOption(opts.limit, "--limit", 1, 500);
  if (limit !== undefined) query.limit = limit;
  return query;
}

function appReviewDecisionInputFromOptions(
  opts: DeveloperMarketplaceOpts,
): DeveloperMarketplaceReviewDecisionInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Partial<DeveloperMarketplaceReviewDecisionInput> = payload ? { ...payload } : {};
  const tenantId = optionalTrimmed(opts.tenantId);
  if (tenantId) input.tenant_id = tenantId;
  const decision = optionalTrimmed(opts.decision);
  if (decision) input.decision = decision as DeveloperMarketplaceReviewDecisionInput["decision"];
  const notes = optionalTrimmed(opts.notes);
  if (notes) input.notes = notes;
  const partnerLevel = optionalTrimmed(opts.partnerLevel);
  if (partnerLevel) input.partner_level = partnerLevel as DeveloperMarketplaceReviewDecisionInput["partner_level"];
  if (!input.tenant_id) throw new Error("Pass --tenant-id for marketplace review decisions.");
  if (!input.decision) throw new Error("Pass --decision approve or reject for marketplace review decisions.");
  return input as DeveloperMarketplaceReviewDecisionInput;
}

function partnerProfileDecisionInputFromOptions(
  opts: DeveloperMarketplaceOpts,
): DeveloperMarketplacePartnerProfileReviewDecisionInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Partial<DeveloperMarketplacePartnerProfileReviewDecisionInput> = payload ? { ...payload } : {};
  const decision = optionalTrimmed(opts.decision);
  if (decision) input.decision = decision as DeveloperMarketplacePartnerProfileReviewDecisionInput["decision"];
  const notes = optionalTrimmed(opts.notes);
  if (notes) input.notes = notes;
  const partnerLevel = optionalTrimmed(opts.partnerLevel);
  if (partnerLevel) input.partner_level = partnerLevel as DeveloperMarketplacePartnerProfileReviewDecisionInput["partner_level"];
  if (!input.decision) throw new Error("Pass --decision approve or reject for partner profile review decisions.");
  return input as DeveloperMarketplacePartnerProfileReviewDecisionInput;
}

function compactAppRows(items: DeveloperMarketplaceApp[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    name: item.name,
    slug: item.slug ?? "",
    type: item.app_type,
    distribution: item.distribution,
    status: item.status,
    scopes: summarizeList(item.scopes ?? []),
    updated_at: item.updated_at ?? "",
  }));
}

function compactOAuthClientRows(items: DeveloperMarketplaceOAuthClient[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    client_id: item.client_id ?? "",
    status: item.status,
    scopes: summarizeList(item.scopes ?? []),
    redirect_uris: summarizeList(item.redirect_uris ?? []),
    updated_at: item.updated_at ?? "",
  }));
}

function compactTestAccountRows(items: DeveloperMarketplaceTestAccount[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    name: item.name,
    status: item.status,
    sandbox_tenant_id: item.sandbox_tenant_id ?? "",
    expires_at: item.expires_at ?? "",
  }));
}

function compactListingRows(items: DeveloperMarketplaceListing[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    app_id: item.app_id ?? "",
    name: item.name,
    category: item.category,
    status: item.status,
    review_state: item.review_state,
    partner_level: item.partner_level ?? "",
  }));
}

function compactInstallationRows(items: DeveloperMarketplaceInstallation[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    app_id: item.app_id,
    status: item.status,
    scopes: summarizeList(item.granted_scopes ?? []),
    installed_by: item.installed_by ?? "",
    updated_at: item.updated_at ?? "",
  }));
}

function compactWebhookRows(items: DeveloperMarketplaceWebhookSubscription[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    app_id: item.app_id ?? "",
    installation_id: item.installation_id ?? "",
    endpoint_url: item.endpoint_url,
    topics: summarizeList(item.topics ?? []),
    status: item.status,
    failure_count: item.failure_count ?? 0,
  }));
}

function compactPartnerProfileRows(items: DeveloperMarketplacePartnerProfile[]): TableRow[] {
  return items.map((item) => ({
    id: item.id ?? "",
    tenant_id: item.tenant_id ?? "",
    organization_name: item.organization_name,
    profile_type: item.profile_type,
    status: item.status,
    level: item.certification_level,
    updated_at: item.updated_at ?? "",
  }));
}

function compactAuditLogRows(items: DeveloperMarketplaceAuditLog[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    app_id: item.app_id ?? "",
    actor: item.actor ?? "",
    action: item.action,
    created_at: item.created_at,
  }));
}

async function runAppAction(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts,
  action: (client: ReturnType<typeof createClient>, appId: string) => Promise<unknown>,
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  if (!id) return;

  const client = createClient(opts);
  const out = await action(client, id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

async function runPayloadCommand(
  opts: DeveloperMarketplaceOpts,
  label: string,
  action: (
    client: ReturnType<typeof createClient>,
    input: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<void> {
  let input: Record<string, unknown>;
  try {
    input = requiredPayloadFromOptions(opts, label);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await action(client, input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

async function runReviewDecision(
  appId: string | undefined,
  opts: DeveloperMarketplaceOpts,
  action: (
    client: ReturnType<typeof createClient>,
    appId: string,
    input: DeveloperMarketplaceReviewDecisionInput,
    reviewSecret: string,
  ) => Promise<unknown>,
): Promise<void> {
  const id = normalizeMarketplaceId(appId, "marketplace app id");
  const secret = reviewSecretFromOptions(opts);
  if (!id || !secret) return;

  let input: DeveloperMarketplaceReviewDecisionInput;
  try {
    input = appReviewDecisionInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await action(client, id, input, secret);
  console.log(formatOutput(out, opts.output ?? "json"));
}

function reviewSecretFromOptions(opts: DeveloperMarketplaceOpts): string | null {
  const secret = optionalTrimmed(opts.reviewSecret) || optionalTrimmed(process.env.POSTWAVE_MARKETPLACE_REVIEW_SECRET);
  if (secret) return secret;
  console.error("Pass --review-secret or set POSTWAVE_MARKETPLACE_REVIEW_SECRET.");
  process.exitCode = 1;
  return null;
}

function normalizeMarketplaceId(value: string | undefined, label: string): string | null {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    console.error(`Pass a ${label}.`);
    process.exitCode = 1;
    return null;
  }
  const valid = trimmed
    .split("/")
    .every((segment) => /^[a-z0-9][a-z0-9._:-]*$/i.test(segment));
  if (!valid) {
    console.error(`Pass a valid ${label}.`);
    process.exitCode = 1;
    return null;
  }
  return trimmed;
}

function requiredPayloadFromOptions(opts: DeveloperMarketplaceOpts, label: string): Record<string, unknown> {
  const input = parseJsonObjectOption(opts.payload, label);
  if (!input) throw new Error(`Pass ${label} as a JSON object.`);
  return input;
}

function parseJsonObjectOption(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  const trimmed = optionalTrimmed(value);
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

function optionalTrimmed(value: string | undefined): string {
  return (value ?? "").trim();
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

function summarizeList(values: readonly string[], limit = 4): string {
  if (values.length <= limit) return values.join(",");
  return `${values.slice(0, limit).join(",")} +${values.length - limit}`;
}

function responseItems<T>(out: unknown): T[] {
  if (Array.isArray(out)) return out as T[];
  if (out && typeof out === "object") {
    const items = (out as { items?: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}

function printWithDefaultTable(output: OutputFormat | undefined, full: unknown, rows: TableRow[]): void {
  const format = output ?? "table";
  console.log(formatOutput(format === "table" ? rows : full, format));
}

function printCommandError(err: unknown): void {
  console.error((err as Error).message);
  process.exitCode = 1;
}
