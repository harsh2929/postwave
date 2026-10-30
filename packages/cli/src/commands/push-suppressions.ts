// SPDX-License-Identifier: MIT

import { readFileSync, statSync } from "node:fs";

import type {
  PushSuppressionAddInput,
  PushSuppressionPlatform,
  PushSuppressionReason,
} from "@postwave/sdk";

import { createClient, type ClientOpts } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface PushSuppressionOpts extends ClientOpts {
  output?: OutputFormat;
  platform?: string;
  reason?: string;
  hashPrefix?: string;
  cursor?: string;
  limit?: string | number;
  tenantUuid?: string;
  tokenFile?: string;
  payloadFile?: string;
  expectedVersion?: string | number;
  yes?: boolean;
}

const PLATFORMS = ["apns", "fcm", "web"] as const;
const REASONS = [
  "manual",
  "unregistered",
  "expired",
  "complaint",
  "user_opt_out",
] as const;
const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const HASH_PREFIX = /^[0-9a-f]{8,16}$/u;
const MAX_BULK_BYTES = 512 * 1024;

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function tenantFrom(opts: PushSuppressionOpts): string | null {
  const value = typeof opts.tenantUuid === "string" ? opts.tenantUuid : "";
  if (!TENANT_UUID.test(value)) {
    fail("--tenant-uuid is required and must be a canonical lowercase UUID");
    return null;
  }
  return value;
}

function platformFrom(value: unknown): PushSuppressionPlatform | null {
  if (
    typeof value !== "string" ||
    !PLATFORMS.includes(value as PushSuppressionPlatform)
  ) {
    fail("--platform must be one of apns, fcm, or web");
    return null;
  }
  return value as PushSuppressionPlatform;
}

function canonicalPositiveInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^[1-9][0-9]*$/u.test(text) ||
    !Number.isSafeInteger(Number(text)) ||
    Number(text) > maximum
  ) {
    fail(`${label} must be a canonical positive integer`);
    return null;
  }
  return Number(text);
}

function tokenIsSafe(token: string): boolean {
  const bytes = Buffer.byteLength(token, "utf8");
  return (
    bytes >= 20 &&
    bytes <= 4096 &&
    token.trim() === token &&
    !/\s/u.test(token) &&
    !/\p{Cc}/u.test(token) &&
    !/[\ud800-\udfff]/u.test(token)
  );
}

function tokenFromFile(path: unknown): string | null {
  if (typeof path !== "string" || path.trim() !== path || path.length < 1) {
    fail(
      "--token-file is required; raw tokens are deliberately not accepted on the command line",
    );
    return null;
  }
  let token: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 20 || stat.size > 4096) throw new Error();
    token = readFileSync(path, "utf8");
  } catch {
    fail("--token-file must be one readable 20–4096-byte file");
    return null;
  }
  if (!tokenIsSafe(token)) {
    fail(
      "--token-file must contain only the exact token bytes, with no newline, whitespace, controls, or encoding ambiguity",
    );
    return null;
  }
  return token;
}

function jsonFile(path: unknown): unknown | null {
  if (typeof path !== "string" || path.trim() !== path || path.length < 1) {
    fail("--payload-file is required");
    return null;
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_BULK_BYTES) {
      throw new Error();
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("--payload-file must be readable strict JSON no larger than 512 KiB");
    return null;
  }
}

function addItems(value: unknown): PushSuppressionAddInput[] | null {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).items
      : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    fail(
      "bulk import payload must be an array, or {items}, with 1–100 entries",
    );
    return null;
  }
  const seen = new Set<string>();
  const result: PushSuppressionAddInput[] = [];
  for (const candidate of items) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      fail("every bulk import entry must be a strict object");
      return null;
    }
    const row = candidate as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          key !== "device_token" && key !== "platform" && key !== "reason",
      ) ||
      typeof row.device_token !== "string" ||
      !tokenIsSafe(row.device_token) ||
      typeof row.platform !== "string" ||
      !PLATFORMS.includes(row.platform as PushSuppressionPlatform) ||
      (row.reason !== undefined && row.reason !== "manual")
    ) {
      fail(
        "every bulk import entry requires one exact token, supported platform, and optional reason=manual",
      );
      return null;
    }
    const key = `${row.platform}\u0000${row.device_token}`;
    if (seen.has(key)) {
      fail("bulk import cannot repeat a platform and token");
      return null;
    }
    seen.add(key);
    result.push({
      device_token: row.device_token,
      platform: row.platform as PushSuppressionPlatform,
      reason: "manual",
    });
  }
  return result;
}

function removeItems(
  value: unknown,
): Array<{ id: string; expected_version: number }> | null {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).items
      : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    fail(
      "bulk removal payload must be an array, or {items}, with 1–100 entries",
    );
    return null;
  }
  const seen = new Set<string>();
  const result: Array<{ id: string; expected_version: number }> = [];
  for (const candidate of items) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      fail("every bulk removal entry must be a strict object");
      return null;
    }
    const row = candidate as Record<string, unknown>;
    const version =
      typeof row.expected_version === "number" &&
      Number.isSafeInteger(row.expected_version) &&
      row.expected_version >= 1
        ? row.expected_version
        : null;
    if (
      Object.keys(row).some(
        (key) => key !== "id" && key !== "expected_version",
      ) ||
      typeof row.id !== "string" ||
      !UUID_V4.test(row.id) ||
      version === null ||
      seen.has(row.id)
    ) {
      fail(
        "every bulk removal entry requires one unique UUIDv4 id and positive expected_version",
      );
      return null;
    }
    seen.add(row.id);
    result.push({ id: row.id, expected_version: version });
  }
  return result;
}

export async function pushSuppressionsList(
  opts: PushSuppressionOpts = {},
): Promise<void> {
  const tenantId = tenantFrom(opts);
  if (!tenantId) return;
  const limit =
    opts.limit === undefined
      ? 50
      : canonicalPositiveInteger(opts.limit, "--limit", 100);
  if (limit === null) return;
  const platform =
    opts.platform === undefined ? undefined : platformFrom(opts.platform);
  if (platform === null) return;
  const reason = opts.reason;
  if (
    reason !== undefined &&
    (typeof reason !== "string" ||
      !REASONS.includes(reason as PushSuppressionReason))
  ) {
    fail("--reason is not a supported push suppression reason");
    return;
  }
  if (opts.hashPrefix !== undefined && !HASH_PREFIX.test(opts.hashPrefix)) {
    fail("--hash-prefix must be 8–16 lowercase hexadecimal characters");
    return;
  }
  if (
    opts.cursor !== undefined &&
    (opts.cursor.length < 1 ||
      opts.cursor.length > 2048 ||
      !CURSOR.test(opts.cursor))
  ) {
    fail(
      "--cursor must be the opaque base64url continuation from the prior page",
    );
    return;
  }
  const out = await createClient(opts).pushSuppressions.list({
    tenantId,
    limit,
    ...(platform ? { platform } : {}),
    ...(reason ? { reason: reason as PushSuppressionReason } : {}),
    ...(opts.hashPrefix ? { hashPrefix: opts.hashPrefix } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  });
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function pushSuppressionAdd(
  opts: PushSuppressionOpts = {},
): Promise<void> {
  const tenantId = tenantFrom(opts);
  const platform = platformFrom(opts.platform);
  const token = tokenFromFile(opts.tokenFile);
  if (!tenantId || !platform || !token) return;
  const out = await createClient(opts).pushSuppressions.add(
    { device_token: token, platform, reason: "manual" },
    { tenantId },
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function pushSuppressionRemove(
  id: string | undefined,
  opts: PushSuppressionOpts = {},
): Promise<void> {
  if (!opts.yes) {
    fail("Pass --yes to remove the reviewed manual authority");
    process.exitCode = 1;
    return;
  }
  const tenantId = tenantFrom(opts);
  const version = canonicalPositiveInteger(
    opts.expectedVersion,
    "--expected-version",
  );
  if (!tenantId || !id || !UUID_V4.test(id) || version === null) {
    if (id && !UUID_V4.test(id))
      fail("suppression id must be a canonical UUIDv4");
    return;
  }
  const out = await createClient(opts).pushSuppressions.remove(id, version, {
    tenantId,
  });
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function pushSuppressionsBulkImport(
  opts: PushSuppressionOpts = {},
): Promise<void> {
  const tenantId = tenantFrom(opts);
  const raw = jsonFile(opts.payloadFile);
  const items = raw === null ? null : addItems(raw);
  if (!tenantId || !items) return;
  const out = await createClient(opts).pushSuppressions.bulkImport(items, {
    tenantId,
  });
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function pushSuppressionsBulkRemove(
  opts: PushSuppressionOpts = {},
): Promise<void> {
  if (!opts.yes) {
    fail("Pass --yes to atomically remove the reviewed manual authorities");
    process.exitCode = 1;
    return;
  }
  const tenantId = tenantFrom(opts);
  const raw = jsonFile(opts.payloadFile);
  const items = raw === null ? null : removeItems(raw);
  if (!tenantId || !items) return;
  const out = await createClient(opts).pushSuppressions.bulkRemove(items, {
    tenantId,
  });
  console.log(formatOutput(out, opts.output ?? "json"));
}
