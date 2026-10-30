// SPDX-License-Identifier: MIT

import type {
  APIKey,
  CreateAPIKeyInput,
  InboundWebhookEndpoint,
  InboundWebhookTriggerInput,
  WebhookDelivery,
  WebhookSubscription,
  WebhookSubscriptionInput,
  WebhookSubscriptionUpdate,
} from "@postwave/sdk";
import { createClient, type ClientOpts } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface DeveloperToolsOpts extends ClientOpts {
  /** Required confirmation for destructive commands. */
  yes?: boolean;
  output?: OutputFormat;
  payload?: string;
  label?: string;
  scopes?: string;
  sandboxOnly?: string | boolean;
  url?: string;
  events?: string;
  cursor?: string;
  limit?: string | number;
  idempotencyKey?: string;
  graceMinutes?: string | number;
  transformJq?: string;
  enabled?: string | boolean;
  name?: string;
}

type RowValue = string | number | boolean | null | undefined;
type TableRow = Record<string, RowValue>;

export async function apiKeysList(opts: DeveloperToolsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.apiKeys.list();
  printWithDefaultTable(opts.output, out, compactApiKeyRows(out));
}

export async function apiKeysGet(
  keyId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(keyId, "API key id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.apiKeys.get(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function apiKeysCreate(opts: DeveloperToolsOpts = {}): Promise<void> {
  let input: CreateAPIKeyInput;
  try {
    input = apiKeyInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.apiKeys.create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function apiKeysRotate(
  keyId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(keyId, "API key id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.apiKeys.rotate(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function apiKeysRevoke(
  keyId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(keyId, "API key id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.apiKeys.revoke(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function webhooksList(opts: DeveloperToolsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.webhooks.list({
    limit: positiveIntegerOption(opts.limit, "--limit", 1, 500),
    cursor: optionalTrimmed(opts.cursor) || undefined,
  });
  printWithDefaultTable(opts.output, out, compactWebhookRows(out.webhooks));
}

export async function webhooksCreate(opts: DeveloperToolsOpts = {}): Promise<void> {
  let input: WebhookSubscriptionInput;
  try {
    input = webhookInputFromOptions(opts, true) as WebhookSubscriptionInput;
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.webhooks.create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function webhooksUpdate(
  webhookId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(webhookId, "webhook id");
  if (!id) return;

  let input: WebhookSubscriptionUpdate;
  try {
    input = webhookInputFromOptions(opts, false) as WebhookSubscriptionUpdate;
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.webhooks.update(id, input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function webhooksDelete(
  webhookId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(webhookId, "webhook id");
  if (!id) return;
  if (!opts.yes) {
    console.error(
      "This permanently deletes the webhook subscription; deliveries stop immediately. Pass --yes to confirm.",
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient(opts);
  await client.webhooks.delete(id);
  console.log(formatOutput({ id, status: "deleted" }, opts.output ?? "json"));
}

export async function webhooksTest(
  webhookId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(webhookId, "webhook id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.webhooks.test(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function webhooksDeliveries(
  webhookId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(webhookId, "webhook id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.webhooks.deliveriesList(id, {
    cursor: optionalTrimmed(opts.cursor) || undefined,
    limit: positiveIntegerOption(opts.limit, "--limit", 1, 500),
  });
  printWithDefaultTable(opts.output, out, compactDeliveryRows(out.deliveries));
}

export async function webhooksReplay(
  deliveryId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(deliveryId, "delivery id");
  if (!id) return;
  const key = optionalTrimmed(opts.idempotencyKey);
  if (!key) {
    console.error("Pass --idempotency-key so retries cannot create duplicate replay deliveries.");
    process.exitCode = 1;
    return;
  }
  const out = await createClient(opts).webhooks.replay(id, key);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function webhooksRotate(
  webhookId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(webhookId, "webhook id");
  if (!id) return;
  const graceMinutes =
    positiveIntegerOption(opts.graceMinutes, "--grace-minutes", 1, 7 * 24 * 60) ?? 1440;
  const out = await createClient(opts).webhooks.rotateSecret(id, graceMinutes);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function inboundWebhooksList(opts: DeveloperToolsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.inboundWebhooks.list({
    limit: positiveIntegerOption(opts.limit, "--limit", 1, 500),
    cursor: optionalTrimmed(opts.cursor) || undefined,
  });
  printWithDefaultTable(opts.output, out, compactInboundWebhookRows(out.items));
}

export async function inboundWebhooksCreate(opts: DeveloperToolsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.inboundWebhooks.create({
    name: optionalTrimmed(opts.name) || undefined,
    transform_jq: optionalTrimmed(opts.transformJq) || undefined,
  });
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function inboundWebhooksGet(
  endpointId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  if (!id) return;
  console.log(formatOutput(await createClient(opts).inboundWebhooks.get(id), opts.output ?? "json"));
}

export async function inboundWebhooksUpdate(
  endpointId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  if (!id) return;
  const patch = parseJsonObjectOption(opts.payload, "--payload") ?? {};
  const name = optionalTrimmed(opts.name);
  const transformJq = optionalTrimmed(opts.transformJq);
  if (name) patch.name = name;
  if (transformJq) patch.transform_jq = transformJq;
  const enabled = optionalBooleanOption(opts.enabled, "--enabled");
  if (enabled !== undefined) patch.enabled = enabled;
  if (Object.keys(patch).length === 0) {
    console.error("Pass --name, --enabled, --transform-jq, or --payload.");
    process.exitCode = 1;
    return;
  }
  const out = await createClient(opts).inboundWebhooks.update(id, patch);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function inboundWebhooksRotate(
  endpointId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  if (!id) return;
  const out = await createClient(opts).inboundWebhooks.rotate(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function inboundWebhooksEvents(
  endpointId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  if (!id) return;
  const out = await createClient(opts).inboundWebhooks.events(id, {
    limit: positiveIntegerOption(opts.limit, "--limit", 1, 500),
    cursor: optionalTrimmed(opts.cursor) || undefined,
  });
  printWithDefaultTable(opts.output, out, out.items as unknown as TableRow[]);
}

export async function inboundWebhooksReplay(
  endpointId: string | undefined,
  eventId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  const event = normalizeDeveloperId(eventId, "inbound event id");
  if (!id || !event) return;
  const key = optionalTrimmed(opts.idempotencyKey);
  if (!key) {
    console.error("Pass --idempotency-key so retries cannot queue duplicate actions.");
    process.exitCode = 1;
    return;
  }
  const out = await createClient(opts).inboundWebhooks.replay(id, event, key);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function inboundWebhooksTriggers(
  endpointId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  if (!id) return;
  const out = await createClient(opts).inboundWebhooks.triggers(id);
  printWithDefaultTable(opts.output, out, out.items as unknown as TableRow[]);
}

export async function inboundWebhooksTriggerCreate(
  endpointId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  if (!id) return;
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  if (!payload) {
    console.error("Pass --payload with the complete trigger contract.");
    process.exitCode = 1;
    return;
  }
  const out = await createClient(opts).inboundWebhooks.createTrigger(
    id,
    payload as unknown as InboundWebhookTriggerInput,
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function inboundWebhooksDelete(
  endpointId: string | undefined,
  opts: DeveloperToolsOpts = {},
): Promise<void> {
  const id = normalizeDeveloperId(endpointId, "inbound webhook endpoint id");
  if (!id) return;
  if (!opts.yes) {
    console.error(
      "This permanently deletes the inbound endpoint; upstream POSTs will 404. Pass --yes to confirm.",
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient(opts);
  await client.inboundWebhooks.delete(id);
  console.log(formatOutput({ id, status: "deleted" }, opts.output ?? "json"));
}

export function apiKeyInputFromOptions(opts: DeveloperToolsOpts): CreateAPIKeyInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Partial<CreateAPIKeyInput> = payload ? { ...payload } : {};
  const label = optionalTrimmed(opts.label);
  if (label) input.label = label;
  const scopes = parseCsvList(opts.scopes);
  if (scopes.length > 0) input.scopes = scopes as CreateAPIKeyInput["scopes"];
  const sandboxOnly = optionalBooleanOption(opts.sandboxOnly, "--sandbox-only");
  if (sandboxOnly !== undefined) input.sandbox_only = sandboxOnly;
  if (!input.label) throw new Error("Pass --label for API key create.");
  if (!input.scopes || input.scopes.length === 0) {
    throw new Error("Pass --scopes as a comma-separated list for API key create.");
  }
  return input as CreateAPIKeyInput;
}

export function webhookInputFromOptions(
  opts: DeveloperToolsOpts,
  requireAny: boolean,
): WebhookSubscriptionInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Partial<WebhookSubscriptionInput> = payload ? { ...payload } : {};
  const url = optionalTrimmed(opts.url);
  if (url) input.url = url;
  const events = parseCsvList(opts.events);
  if (events.length > 0) input.events = events as WebhookSubscriptionInput["events"];
  if (requireAny) {
    if (!input.url) throw new Error("Pass --url for webhook create.");
    if (!input.events || input.events.length === 0) {
      throw new Error("Pass --events for webhook create.");
    }
  } else if (Object.keys(input).length === 0) {
    throw new Error("Pass --url, --events, or --payload for webhook update.");
  }
  return input as WebhookSubscriptionInput;
}

function compactApiKeyRows(items: APIKey[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    prefix: item.prefix,
    scopes: summarizeList(item.scopes ?? []),
    sandbox_only: item.sandboxOnly ?? "",
    last_used_at: item.lastUsedAt ?? "",
    revoked_at: item.revokedAt ?? "",
  }));
}

function compactWebhookRows(items: WebhookSubscription[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    url: item.url,
    events: summarizeList(item.events ?? []),
    active: item.active,
    created_at: item.created_at ?? "",
  }));
}

function compactDeliveryRows(items: WebhookDelivery[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    webhook_id: item.webhook_id,
    event: item.event_type,
    status: item.status,
    status_code: item.last_status_code ?? "",
    attempt: item.attempt_count,
    error: item.last_error ?? "",
    created_at: item.created_at,
  }));
}

function compactInboundWebhookRows(items: InboundWebhookEndpoint[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    slug: item.slug,
    name: item.name,
    enabled: item.enabled,
    created_at: item.createdAt,
  }));
}

function normalizeDeveloperId(value: string | undefined, label: string): string | null {
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

function parseCsvList(value: string | undefined): string[] {
  return optionalTrimmed(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function summarizeList(values: readonly string[], limit = 4): string {
  if (values.length <= limit) return values.join(",");
  return `${values.slice(0, limit).join(",")} +${values.length - limit}`;
}

function printWithDefaultTable(output: OutputFormat | undefined, full: unknown, rows: TableRow[]): void {
  const format = output ?? "table";
  console.log(formatOutput(format === "table" ? rows : full, format));
}

function printCommandError(err: unknown): void {
  console.error((err as Error).message);
  process.exitCode = 1;
}
