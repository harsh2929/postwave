// SPDX-License-Identifier: AGPL-3.0-only
//
// Client for the trusted-device API (GET/DELETE /auth/trusted-devices +
// revoke-all). Mirrors apps/api/internal/auth's handlers.
//
// A trusted device is a standing MFA bypass: it lets a sign-in skip the second
// factor. The endpoints shipped with a mobile consumer only, so a web user
// could enrol a bypass and then had no way to see or revoke it from the surface
// where they manage everything else. Guarded by
// scripts/check-identity-surface-parity.mjs.

import { api } from "./api";

export interface TrustedDeviceInfo {
  id: string;
  trust_days: number;
  issued_at: string;
  last_used_at?: string;
  expires_at: string;
  ip?: string;
  user_agent?: string;
  current: boolean;
  // Server-derived. Rendered verbatim rather than re-parsed from the user
  // agent — three clients each hand-rolling a parser is how one machine ends up
  // with three different names.
  device_label?: string;
  device_type?: string;
  device_os?: string;
  device_client?: string;
}

export interface TrustedDevicesEnvelope {
  // `trusted_devices`, NOT `devices` — see device_trust_handlers.go. The
  // sibling client apps/mobile/src/lib/trustedDeviceContract.ts already had
  // this right; diverging from a working sibling is how the card ended up
  // permanently empty.
  trusted_devices: TrustedDeviceInfo[];
  /**
   * The workspace POLICY, not a reason to hide the list. When false, existing
   * trusted devices are still shown and still revocable: a bypass that policy
   * has since forbidden is exactly the one a user most needs to be able to see.
   */
  allowed?: boolean;
  allowed_durations?: number[];
  max_days?: number;
  default_days?: number;
}

interface AccountRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

const TRUST_DAYS = new Set([30, 90, 180]);

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    Number.isFinite(Date.parse(value))
  );
}

function optionalText(
  value: unknown,
  max: number,
): value is string | undefined {
  return (
    value === undefined || (typeof value === "string" && value.length <= max)
  );
}

function parseTrustedDevice(value: unknown): TrustedDeviceInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Trusted-device response contained an invalid record.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    row.id.length > 512 ||
    !TRUST_DAYS.has(Number(row.trust_days)) ||
    !timestamp(row.issued_at) ||
    !timestamp(row.expires_at) ||
    Date.parse(row.issued_at) > Date.parse(row.expires_at) ||
    (row.last_used_at !== undefined && !timestamp(row.last_used_at)) ||
    typeof row.current !== "boolean" ||
    !optionalText(row.ip, 256) ||
    !optionalText(row.user_agent, 4096) ||
    !optionalText(row.device_label, 256) ||
    !optionalText(row.device_type, 64) ||
    !optionalText(row.device_os, 128) ||
    !optionalText(row.device_client, 128)
  ) {
    throw new Error("Trusted-device response contained an invalid record.");
  }
  return {
    id: row.id,
    trust_days: Number(row.trust_days),
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    current: row.current,
    ...(row.last_used_at !== undefined
      ? { last_used_at: row.last_used_at }
      : {}),
    ...(row.ip !== undefined ? { ip: row.ip } : {}),
    ...(row.user_agent !== undefined ? { user_agent: row.user_agent } : {}),
    ...(row.device_label !== undefined
      ? { device_label: row.device_label }
      : {}),
    ...(row.device_type !== undefined ? { device_type: row.device_type } : {}),
    ...(row.device_os !== undefined ? { device_os: row.device_os } : {}),
    ...(row.device_client !== undefined
      ? { device_client: row.device_client }
      : {}),
  };
}

export function parseTrustedDevicesEnvelope(
  value: unknown,
): TrustedDevicesEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Trusted-device response was malformed.");
  }
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.trusted_devices) ||
    body.trusted_devices.length > 1_000 ||
    typeof body.allowed !== "boolean" ||
    !Array.isArray(body.allowed_durations) ||
    !body.allowed_durations.every((days) => TRUST_DAYS.has(Number(days))) ||
    !Number.isSafeInteger(body.max_days) ||
    !Number.isSafeInteger(body.default_days)
  ) {
    throw new Error("Trusted-device response was malformed.");
  }
  const trustedDevices = body.trusted_devices.map(parseTrustedDevice);
  if (
    new Set(trustedDevices.map((row) => row.id)).size !== trustedDevices.length
  ) {
    throw new Error("Trusted-device response repeated a record.");
  }
  if (trustedDevices.filter((row) => row.current).length > 1) {
    throw new Error(
      "Trusted-device response identified multiple current devices.",
    );
  }
  return {
    trusted_devices: trustedDevices,
    allowed: body.allowed,
    allowed_durations: body.allowed_durations.map(Number),
    max_days: Number(body.max_days),
    default_days: Number(body.default_days),
  };
}

function confirmedCount(value: unknown): number {
  const count =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).revoked_count
      : undefined;
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw new Error(
      "The server did not confirm how many trusted devices were revoked.",
    );
  }
  return Number(count);
}

export const trustedDevicesApi = {
  async list(options: Pick<AccountRequestOptions, "signal"> = {}) {
    const payload = await api.get<unknown>("/api/v1/auth/trusted-devices", {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    });
    return parseTrustedDevicesEnvelope(payload);
  },
  async revoke(id: string, options: AccountRequestOptions = {}) {
    const payload = await api.delete<unknown>(
      `/api/v1/auth/trusted-devices/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
      },
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as Record<string, unknown>).revoked !== true
    ) {
      throw new Error("The server did not confirm trusted-device revocation.");
    }
    return { revoked: true as const };
  },
  async revokeAll(options: AccountRequestOptions = {}) {
    const payload = await api.post<unknown>(
      "/api/v1/auth/trusted-devices/revoke-all",
      undefined,
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
      },
    );
    return { revoked_count: confirmedCount(payload) };
  },
};
