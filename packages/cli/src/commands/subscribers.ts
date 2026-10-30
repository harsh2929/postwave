// SPDX-License-Identifier: MIT

import chalk from "chalk";
import type { Subscriber, SubscriberStatus } from "@postwave/sdk";
import { createClient } from "../lib/client.js";
import { readTextFileLimited } from "../lib/input.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface SubscribersOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  query?: string;
  email?: string;
  output?: OutputFormat;
}

export interface SubscriberWriteOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  email?: string;
  status?: string;
  // CAC delivers an explicit `--tags ""` as the number 0 rather than an empty
  // string, so the runtime type is widened to let parseTags distinguish "absent"
  // (undefined) from "clear" (empty -> []).
  tags?: string | number;
  customFields?: string;
  yes?: boolean;
  file?: string;
  output?: OutputFormat;
}

const SUBSCRIBER_STATUSES = [
  "enabled",
  "disabled",
  "blocklisted",
  "unconfirmed",
] as const satisfies readonly SubscriberStatus[];

export async function subscribersList(opts: SubscribersOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.subscribers.list();
  console.log(formatOutput(out, opts.output ?? "table"));
}

export async function subscribersSearch(opts: SubscribersOpts = {}): Promise<void> {
  if (!opts.query) {
    console.error("Pass --query <text>");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  const out = await client.subscribers.search(opts.query);
  console.log(formatOutput(out, opts.output ?? "table"));
}

export async function subscribersSuppress(opts: SubscribersOpts = {}): Promise<void> {
  if (!opts.email) {
    console.error("Pass --email <address>");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  const page = await client.subscribers.search(opts.email);
  const match = page.items.find((s) => s.email.toLowerCase() === opts.email?.toLowerCase());
  await client.subscribers.suppress((match as { id?: string } | undefined)?.id ?? opts.email);
  console.log(chalk.green(`Suppressed ${opts.email}.`));
}

export async function subscribersCreate(opts: SubscriberWriteOpts = {}): Promise<void> {
  let input: Partial<Subscriber> & Pick<Subscriber, "email">;
  try {
    input = subscriberCreateInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }
  const client = createClient(opts);
  const out = await client.subscribers.create(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function subscribersUpdate(
  id: string | undefined,
  opts: SubscriberWriteOpts = {},
): Promise<void> {
  const subscriberId = requireId(id, "subscriber id");
  if (!subscriberId) return;
  let patch: Partial<Subscriber>;
  try {
    patch = subscriberPatchFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }
  const client = createClient(opts);
  const out = await client.subscribers.update(subscriberId, patch);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function subscribersDelete(
  id: string | undefined,
  opts: SubscriberWriteOpts = {},
): Promise<void> {
  const subscriberId = requireId(id, "subscriber id");
  if (!subscriberId) return;
  if (!opts.yes) {
    console.error("This permanently deletes the subscriber. Pass --yes to confirm.");
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  await client.subscribers.delete(subscriberId);
  console.log(chalk.green(`Deleted subscriber ${subscriberId}.`));
}

export async function subscribersImport(opts: SubscriberWriteOpts = {}): Promise<void> {
  if (!opts.file) {
    console.error("Pass --file <path> to a CSV file.");
    process.exitCode = 1;
    return;
  }
  let csv: string;
  try {
    csv = readTextFileLimited(opts.file);
  } catch (err) {
    printCommandError(err);
    return;
  }
  const filename = basename(opts.file);
  const client = createClient(opts);
  const out = await client.subscribers.importCsv(filename, csv);
  console.log(formatOutput(out, opts.output ?? "json"));
  // The import endpoint returns 200 even when individual rows fail to parse, so
  // without this the CLI would exit 0 on a malformed CSV and an automation would
  // treat the partial/failed import as a success. Surface the error count and
  // exit non-zero so scripts can detect it.
  if (typeof out?.errored === "number" && out.errored > 0) {
    console.error(
      chalk.red(
        `Import completed with ${out.errored} errored row(s) out of ${out.total_rows}. ` +
          "See the per-row results above.",
      ),
    );
    process.exitCode = 1;
  }
}

/**
 * Cross-platform basename for the `X-Postwave-Filename` header. `split("/")`
 * alone leaves a Windows backslash path intact, so the whole path would be sent
 * as the filename. Split on both separators and take the last non-empty segment.
 */
function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]?.trim();
    if (segment) return segment;
  }
  return "import.csv";
}

export function subscriberCreateInputFromOptions(
  opts: SubscriberWriteOpts,
): Partial<Subscriber> & Pick<Subscriber, "email"> {
  const customFields = parseJsonObjectOption(opts.customFields, "--custom-fields");
  const input: Partial<Subscriber> & { email?: string } = customFields
    ? { custom_fields: customFields }
    : {};
  const email = (opts.email ?? "").trim();
  if (email) input.email = email;
  const status = optionalEnum(opts.status, SUBSCRIBER_STATUSES, "--status");
  if (status) input.status = status;
  const tags = parseTags(opts.tags);
  if (tags) input.tags = tags;
  if (!input.email) throw new Error("Pass --email <address> to create a subscriber.");
  return input as Partial<Subscriber> & Pick<Subscriber, "email">;
}

export function subscriberPatchFromOptions(opts: SubscriberWriteOpts): Partial<Subscriber> {
  const customFields = parseJsonObjectOption(opts.customFields, "--custom-fields");
  const patch: Partial<Subscriber> = customFields ? { custom_fields: customFields } : {};
  const email = (opts.email ?? "").trim();
  if (email) patch.email = email;
  const status = optionalEnum(opts.status, SUBSCRIBER_STATUSES, "--status");
  if (status) patch.status = status;
  const tags = parseTags(opts.tags);
  if (tags) patch.tags = tags;
  if (Object.keys(patch).length === 0) {
    throw new Error("Pass at least one of --email, --status, --tags, or --custom-fields to update.");
  }
  return patch;
}

/**
 * Parse `--tags`. Returns:
 *   undefined -> flag absent, leave tags untouched
 *   []        -> explicit clear (`--tags ""`), replace existing tags with none
 *   string[]  -> the parsed tag list
 *
 * CAC surfaces an explicit empty value as the number 0 (not ""), so the numeric
 * form is normalized into the clear intent instead of crashing on `0.trim()`.
 */
function parseTags(value: string | number | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((t) => t.trim())
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

function optionalEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  throw new Error(`Pass ${label} as one of: ${allowed.join(", ")}.`);
}

function requireId(value: string | undefined, label: string): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    console.error(`Pass a ${label}.`);
    process.exitCode = 1;
    return null;
  }
  return trimmed;
}

function printCommandError(err: unknown): void {
  console.error(chalk.red((err as Error).message));
  process.exitCode = 1;
}
