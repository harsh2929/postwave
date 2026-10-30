// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";
import {
  normalizeTrackProperties,
  type TrackProperties,
} from "@/lib/track-api";

const PAGE_SIZE = 50;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TIMESTAMP_LENGTH = 128;

export interface ConversionRow {
  id: number;
  tenant_id: string;
  subscriber_email?: string;
  event_name: string;
  amount_cents?: number | null;
  currency?: string;
  campaign_id?: string;
  attributed_via?:
    | "explicit"
    | "last_touch"
    | "none"
    | "code_redemption"
    | "campaign_vanity_path";
  properties: TrackProperties;
  occurred_at: string;
}

export interface ConversionCursor {
  before: string;
  beforeId: number;
}

export interface ConversionPage {
  items: ConversionRow[];
  nextCursor: ConversionCursor | null;
}

export interface TrackingKey {
  id: string;
  tenant_id: string;
  label: string;
  prefix: string;
  revoked_at?: string | null;
  created_at: string;
}

export interface CreateTrackingKeyResponse {
  key: TrackingKey;
  plaintext: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    (allowEmpty || value.trim().length > 0)
  );
}

function timestamp(value: unknown): value is string {
  return (
    boundedString(value, MAX_TIMESTAMP_LENGTH) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseConversionRow(
  value: unknown,
  expectedTenantId: string,
): ConversionRow | null {
  const row = record(value);
  if (!row) return null;
  const properties = normalizeTrackProperties(row.properties);
  if (
    !Number.isSafeInteger(row.id) ||
    Number(row.id) <= 0 ||
    row.tenant_id !== expectedTenantId ||
    !boundedString(row.event_name, 128) ||
    (row.subscriber_email !== undefined &&
      !boundedString(row.subscriber_email, 320)) ||
    (row.amount_cents !== undefined &&
      row.amount_cents !== null &&
      !Number.isSafeInteger(row.amount_cents)) ||
    (row.currency !== undefined && !/^[A-Z]{3}$/.test(String(row.currency))) ||
    (row.campaign_id !== undefined &&
      !boundedString(row.campaign_id, MAX_IDENTIFIER_LENGTH)) ||
    (row.attributed_via !== undefined &&
      ![
        "explicit",
        "last_touch",
        "none",
        "code_redemption",
        "campaign_vanity_path",
      ].includes(
        String(row.attributed_via),
      )) ||
    !timestamp(row.occurred_at) ||
    !properties
  ) {
    return null;
  }
  return {
    id: Number(row.id),
    tenant_id: row.tenant_id,
    ...(row.subscriber_email !== undefined
      ? { subscriber_email: row.subscriber_email as string }
      : {}),
    event_name: row.event_name,
    ...(row.amount_cents !== undefined
      ? { amount_cents: row.amount_cents as number | null }
      : {}),
    ...(row.currency !== undefined ? { currency: row.currency as string } : {}),
    ...(row.campaign_id !== undefined
      ? { campaign_id: row.campaign_id as string }
      : {}),
    ...(row.attributed_via !== undefined
      ? {
          attributed_via: row.attributed_via as
            | "explicit"
            | "last_touch"
            | "none"
            | "code_redemption"
            | "campaign_vanity_path",
        }
      : {}),
    properties,
    occurred_at: row.occurred_at,
  };
}

export function parseConversionPage(
  payload: unknown,
  expectedTenantId: string,
): ConversionPage {
  if (!Array.isArray(payload) || payload.length > PAGE_SIZE) {
    throw new Error("Conversion feed response was malformed.");
  }
  const items: ConversionRow[] = [];
  const ids = new Set<number>();
  let previousTime = Number.POSITIVE_INFINITY;
  let previousId = Number.POSITIVE_INFINITY;
  for (const value of payload) {
    const row = parseConversionRow(value, expectedTenantId);
    if (!row || ids.has(row.id)) {
      throw new Error("Conversion feed contained an invalid row.");
    }
    const at = Date.parse(row.occurred_at);
    if (at > previousTime || (at === previousTime && row.id >= previousId)) {
      throw new Error("Conversion feed ordering could not be verified.");
    }
    previousTime = at;
    previousId = row.id;
    ids.add(row.id);
    items.push(row);
  }
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      items.length === PAGE_SIZE && last
        ? { before: last.occurred_at, beforeId: last.id }
        : null,
  };
}

function parseTrackingKey(
  value: unknown,
  expectedTenantId?: string,
): TrackingKey | null {
  const key = record(value);
  if (
    !key ||
    !boundedString(key.id, MAX_IDENTIFIER_LENGTH) ||
    !boundedString(key.tenant_id, MAX_IDENTIFIER_LENGTH) ||
    (expectedTenantId !== undefined && key.tenant_id !== expectedTenantId) ||
    !boundedString(key.label, 120) ||
    !boundedString(key.prefix, 128, true) ||
    (key.revoked_at !== undefined &&
      key.revoked_at !== null &&
      !timestamp(key.revoked_at)) ||
    !timestamp(key.created_at)
  ) {
    return null;
  }
  return {
    id: key.id,
    tenant_id: key.tenant_id,
    label: key.label,
    prefix: key.prefix,
    ...(key.revoked_at !== undefined
      ? { revoked_at: key.revoked_at as string | null }
      : {}),
    created_at: key.created_at,
  };
}

export function parseTrackingKeys(
  payload: unknown,
  expectedTenantId?: string,
): TrackingKey[] {
  if (!Array.isArray(payload) || payload.length > 1_000) {
    throw new Error("Conversion tracking-key register was malformed.");
  }
  const keys = payload.map((value) =>
    parseTrackingKey(value, expectedTenantId),
  );
  if (keys.some((key) => key === null)) {
    throw new Error(
      "Conversion tracking-key register contained an invalid row.",
    );
  }
  const parsed = keys as TrackingKey[];
  if (new Set(parsed.map((key) => key.id)).size !== parsed.length) {
    throw new Error(
      "Conversion tracking-key register contained duplicate IDs.",
    );
  }
  return parsed;
}

export function conversionTrackingKeyLabelError(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return "Give the key a label so keys can be distinguished.";
  if (Array.from(trimmed).length > 120 || /\p{Cc}/u.test(trimmed)) {
    return "Use a label without control characters (120 characters maximum).";
  }
  return null;
}

export function formatConversionAmount(
  amountCents: number | null | undefined,
  currency: string | undefined,
): string {
  if (amountCents == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

export async function listConversions(options: {
  tenantId: string;
  cursor?: ConversionCursor | null;
  signal?: AbortSignal;
}): Promise<ConversionPage> {
  const cursor = options.cursor ?? undefined;
  if (
    cursor &&
    (!timestamp(cursor.before) ||
      !Number.isSafeInteger(cursor.beforeId) ||
      cursor.beforeId <= 0)
  ) {
    throw new Error("Conversion cursor is invalid.");
  }
  const response = await api.get<unknown>("/api/v1/conversions", {
    query: cursor
      ? { before: cursor.before, before_id: cursor.beforeId }
      : undefined,
    signal: options.signal,
  });
  return parseConversionPage(response, options.tenantId);
}

export const conversionsApi = {
  listKeys: async (
    options: {
      expectedTenantId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<TrackingKey[]> => {
    const response = await api.get<unknown>("/api/v1/conversions/keys", {
      signal: options.signal,
    });
    return parseTrackingKeys(response, options.expectedTenantId);
  },

  createKey: async (
    rawLabel: string,
    options: { expectedTenantId?: string; idempotencyKey?: string } = {},
  ): Promise<CreateTrackingKeyResponse> => {
    const label = rawLabel.trim();
    const labelError = conversionTrackingKeyLabelError(label);
    if (labelError) throw new Error(labelError);
    const response = await api.post<unknown>(
      "/api/v1/conversions/keys",
      { label },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: options.idempotencyKey,
      },
    );
    const envelope = record(response);
    const key = envelope
      ? parseTrackingKey(envelope.key, options.expectedTenantId)
      : null;
    if (
      !envelope ||
      !key ||
      !boundedString(envelope.plaintext, 4_096) ||
      (key.prefix && !envelope.plaintext.startsWith(key.prefix))
    ) {
      throw new Error(
        "The key may have been created, but its one-time secret response could not be verified. Review the key register before retrying.",
      );
    }
    return { key, plaintext: envelope.plaintext };
  },

  revokeKey: async (
    id: string,
    options: { idempotencyKey?: string } = {},
  ): Promise<{ ok: true }> => {
    const normalized = id.trim();
    if (!boundedString(normalized, MAX_IDENTIFIER_LENGTH)) {
      throw new Error("Tracking-key ID is invalid.");
    }
    const response = await api.delete<unknown>(
      `/api/v1/conversions/keys/${encodeURIComponent(normalized)}`,
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: options.idempotencyKey,
      },
    );
    if (record(response)?.ok !== true) {
      throw new Error("Tracking-key revocation acknowledgement was malformed.");
    }
    return { ok: true };
  },
};
