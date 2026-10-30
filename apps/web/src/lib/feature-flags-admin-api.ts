// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

const MUTATION_OPTIONS = { requireOnline: true, maxAttempts: 1 } as const;
const MAX_FLAGS = 10_000;

export interface FeatureFlagRecord {
  id: string;
  key: string;
  value: string;
  note: string;
  tenantId: string | null;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureFlagResolution {
  key: string;
  value: string;
  source: "tenant" | "default" | "missing";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  name: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`Invalid feature flag ${name}`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  const parsed = boundedText(value, name, 128);
  if (
    !/^\d{4}-\d{2}-\d{2}T/u.test(parsed) ||
    !Number.isFinite(Date.parse(parsed))
  ) {
    throw new Error(`Invalid feature flag ${name}`);
  }
  return parsed;
}

function parseFlag(
  value: unknown,
  expectedTenantId: string,
): FeatureFlagRecord {
  if (!record(value)) throw new Error("Invalid feature flag row");
  const isDefault = value.is_default;
  const enabled = value.enabled;
  if (typeof isDefault !== "boolean" || typeof enabled !== "boolean") {
    throw new Error("Invalid feature flag row");
  }
  const tenantWire = value.tenant_id;
  const tenantId =
    tenantWire === undefined || tenantWire === null || tenantWire === ""
      ? null
      : boundedText(tenantWire, "tenant_id", 128);
  if (
    (isDefault && tenantId !== null) ||
    (!isDefault && tenantId !== expectedTenantId)
  ) {
    throw new Error("Feature flag row crossed the current workspace boundary");
  }
  return {
    id: boundedText(value.id, "id", 128),
    key: boundedText(value.key, "key", 200),
    value: boundedText(value.value, "value", 200),
    note:
      value.note === undefined || value.note === null
        ? ""
        : boundedText(value.note, "note", 3_500, true),
    tenantId,
    isDefault,
    enabled,
    createdAt: timestamp(value.created_at, "created_at"),
    updatedAt: timestamp(value.updated_at, "updated_at"),
  };
}

export async function listFeatureFlagRegistry(
  expectedTenantId: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<FeatureFlagRecord[]> {
  const response = await api.get<unknown>("/api/v1/feature-flags", {
    signal: options.signal,
    ...(options.fresh ? MUTATION_OPTIONS : {}),
  });
  if (
    !record(response) ||
    !Array.isArray(response.flags) ||
    response.flags.length > MAX_FLAGS ||
    !Number.isSafeInteger(response.count) ||
    response.count !== response.flags.length
  ) {
    throw new Error("Invalid feature flags response");
  }
  const parsed = response.flags.map((value) =>
    parseFlag(value, expectedTenantId),
  );
  const identities = new Set<string>();
  for (const flag of parsed) {
    const identity = `${flag.isDefault ? "default" : "tenant"}:${flag.key}`;
    if (identities.has(identity)) {
      throw new Error("Invalid duplicate feature flag row");
    }
    identities.add(identity);
  }
  return parsed;
}

export async function upsertFeatureFlagOverride(
  input: { key: string; value: string; note: string },
  signal?: AbortSignal,
): Promise<{ id: string; key: string; value: string }> {
  const normalized = normalizeFeatureFlagInput(input);
  const response = await api.post<unknown>(
    "/api/v1/feature-flags",
    normalized,
    { ...MUTATION_OPTIONS, signal },
  );
  if (!record(response)) throw new Error("Invalid feature flag write receipt");
  const parsed = {
    id: boundedText(response.id, "receipt.id", 128),
    key: boundedText(response.key, "receipt.key", 200),
    value: boundedText(response.value, "receipt.value", 200),
  };
  if (parsed.key !== normalized.key || parsed.value !== normalized.value) {
    throw new Error("Feature flag write receipt did not match the request");
  }
  return parsed;
}

export function featureFlagDraftError(input: {
  key: string;
  value: string;
  note: string;
}): string | null {
  try {
    normalizeFeatureFlagInput(input);
    return null;
  } catch (caught) {
    return caught instanceof Error
      ? caught.message
      : "Invalid feature flag draft";
  }
}

function normalizeFeatureFlagInput(input: {
  key: string;
  value: string;
  note: string;
}): { key: string; value: string; note: string } {
  const normalized = {
    key: input.key.trim(),
    value: input.value.trim(),
    note: input.note.trim(),
  };
  if (!normalized.key || utf8Bytes(normalized.key) > 200) {
    throw new Error("Key must contain 1 to 200 UTF-8 bytes.");
  }
  if (!normalized.value || utf8Bytes(normalized.value) > 200) {
    throw new Error("Value must contain 1 to 200 UTF-8 bytes.");
  }
  if (utf8Bytes(normalized.note) > 3_000) {
    throw new Error("Operator note must be 3,000 UTF-8 bytes or fewer.");
  }
  if (utf8Bytes(JSON.stringify(normalized)) > 3_800) {
    throw new Error("Feature flag request is too large.");
  }
  return normalized;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export async function removeFeatureFlagOverride(
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  await api.delete<void>(`/api/v1/feature-flags/${encodeURIComponent(key)}`, {
    ...MUTATION_OPTIONS,
    signal,
  });
}

export async function resolveFeatureFlag(
  key: string,
  signal?: AbortSignal,
): Promise<FeatureFlagResolution> {
  const normalized = key.trim();
  if (!normalized || utf8Bytes(normalized) > 200) {
    throw new Error("Flag key must contain 1 to 200 UTF-8 bytes.");
  }
  const response = await api.get<unknown>(
    `/api/v1/feature-flags/${encodeURIComponent(normalized)}/resolve`,
    { requireOnline: true, maxAttempts: 1, signal },
  );
  if (!record(response)) throw new Error("Invalid feature flag resolution");
  const source = response.source;
  if (!(["tenant", "default", "missing"] as const).includes(source as never)) {
    throw new Error("Invalid feature flag resolution source");
  }
  const resolved = {
    key: boundedText(response.key, "resolution.key", 200),
    value: boundedText(response.value, "resolution.value", 200, true),
    source: source as FeatureFlagResolution["source"],
  };
  if (
    resolved.key !== normalized ||
    (resolved.source === "missing" && resolved.value !== "")
  ) {
    throw new Error("Feature flag resolution did not match the requested key");
  }
  return resolved;
}

export function sameFeatureFlagRevision(
  left: FeatureFlagRecord,
  right: FeatureFlagRecord,
): boolean {
  return (
    left.id === right.id &&
    left.key === right.key &&
    left.value === right.value &&
    left.note === right.note &&
    left.tenantId === right.tenantId &&
    left.isDefault === right.isDefault &&
    left.enabled === right.enabled &&
    left.updatedAt === right.updatedAt
  );
}
