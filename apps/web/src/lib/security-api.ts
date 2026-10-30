// SPDX-License-Identifier: AGPL-3.0-only
//
// Tenant security policy client. Backend: handlers/security.go.
// Moosewave enforces its own session/TOTP policy. The SSO fields are legacy
// storage only in this deployment: the API preserves unchanged values, permits
// clearing them, and refuses new configuration while no sign-in runtime exists.

import { api } from "@/lib/api";

export interface SecuritySettings {
  require_2fa_for_admins: boolean;
  require_2fa_for_all: boolean;
  allow_trusted_devices?: boolean | null;
  sso_provider?: string | null;
  sso_metadata_url?: string | null;
  session_max_minutes?: number | null;
}

export interface SecurityRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export async function getSecuritySettings(
  options: Pick<SecurityRequestOptions, "signal"> = {},
): Promise<SecuritySettings> {
  return parseSecuritySettings(
    await api.get<unknown>("/api/v1/security/settings", {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    }),
  );
}

export async function updateSecuritySettings(
  settings: SecuritySettings,
  options: SecurityRequestOptions = {},
): Promise<SecuritySettings> {
  return parseSecuritySettings(
    await api.put<unknown>("/api/v1/security/settings", settings, {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
      idempotencyKey: options.idempotencyKey,
    }),
  );
}

function nullableBoundedString(value: unknown, max: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length <= max)
  );
}

export function parseSecuritySettings(value: unknown): SecuritySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Security-policy response was malformed.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.require_2fa_for_admins !== "boolean" ||
    typeof row.require_2fa_for_all !== "boolean" ||
    !(
      row.allow_trusted_devices === undefined ||
      row.allow_trusted_devices === null ||
      typeof row.allow_trusted_devices === "boolean"
    ) ||
    !nullableBoundedString(row.sso_provider, 128) ||
    !nullableBoundedString(row.sso_metadata_url, 8 * 1024) ||
    !(
      row.session_max_minutes === undefined ||
      row.session_max_minutes === null ||
      (Number.isSafeInteger(row.session_max_minutes) &&
        Math.abs(Number(row.session_max_minutes)) <= 10_000_000)
    )
  ) {
    throw new Error("Security-policy response was malformed.");
  }
  return {
    require_2fa_for_admins: row.require_2fa_for_admins,
    require_2fa_for_all: row.require_2fa_for_all,
    ...(row.allow_trusted_devices !== undefined
      ? { allow_trusted_devices: row.allow_trusted_devices as boolean | null }
      : {}),
    ...(row.sso_provider !== undefined
      ? { sso_provider: row.sso_provider as string | null }
      : {}),
    ...(row.sso_metadata_url !== undefined
      ? { sso_metadata_url: row.sso_metadata_url as string | null }
      : {}),
    ...(row.session_max_minutes !== undefined
      ? { session_max_minutes: row.session_max_minutes as number | null }
      : {}),
  };
}
