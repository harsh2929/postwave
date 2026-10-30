// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Support-provider (customer-service) integration transport — desktop parity
 * platform-91 (apps/desktop/src/lib/api/support-integrations.ts).
 *
 * Two verbs:
 *   - `listSupportProviders` reads the static server catalog. The decoder is
 *     exact: every row must be a held entry with the runtime hold code, and
 *     the envelope must declare itself a non-tenant-bound static catalog.
 *     Anything else is a contract error, never an empty list.
 *   - `connectSupportIntegration` is the real create against the mounted
 *     POST /api/v1/support-integrations. It refuses before transport while
 *     SUPPORT_INTEGRATION_RUNTIME_AVAILABLE is false, exactly as desktop's
 *     `create` does; the server answers the same call with 503
 *     `support_integration_runtime_held`.
 */

import { api } from "@/lib/api";
import {
  requireSupportRuntime,
  SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
} from "@/lib/support-integration-operational-availability";

export interface SupportProviderSpec {
  key: string;
  name: string;
  runtime_status: "held";
  hold_code: typeof SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE;
}

export interface SupportProviderCatalog {
  items: SupportProviderSpec[];
  complete: true;
  provenance: {
    tenant_bound: false;
    source: "static_server_catalog";
  };
}

export interface SupportIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface SupportIntegration {
  id: string;
  tenant_id?: string;
  provider: string;
  name: string;
  status: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export class SupportCatalogContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportCatalogContractError";
  }
}

const SAFE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DISPLAY_CONTROL_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(row);
  return (
    present.length === keys.length && keys.every((key) => present.includes(key))
  );
}

function boundedDisplay(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !DISPLAY_CONTROL_RE.test(value)
  );
}

/**
 * Exact decoder for GET /api/v1/support-integrations/providers. Mirrors the
 * desktop decoder field for field so both clients accept precisely the same
 * static held projection. Returns null for any deviation.
 */
export function decodeSupportProviderCatalog(
  value: unknown,
): SupportProviderCatalog | null {
  const envelope = record(value);
  if (
    !envelope ||
    !exactKeys(envelope, ["items", "complete", "provenance"]) ||
    envelope.complete !== true ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > 100
  ) {
    return null;
  }
  const provenance = record(envelope.provenance);
  if (
    !provenance ||
    !exactKeys(provenance, ["tenant_bound", "source"]) ||
    provenance.tenant_bound !== false ||
    provenance.source !== "static_server_catalog"
  ) {
    return null;
  }
  const seen = new Set<string>();
  const items: SupportProviderSpec[] = [];
  for (const candidate of envelope.items) {
    const item = record(candidate);
    if (
      !item ||
      !exactKeys(item, ["key", "name", "runtime_status", "hold_code"]) ||
      typeof item.key !== "string" ||
      !SAFE_KEY_RE.test(item.key) ||
      seen.has(item.key) ||
      !boundedDisplay(item.name, 200) ||
      item.runtime_status !== "held" ||
      item.hold_code !== SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE
    ) {
      return null;
    }
    seen.add(item.key);
    items.push({
      key: item.key,
      name: item.name,
      runtime_status: "held",
      hold_code: SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
    });
  }
  return {
    items,
    complete: true,
    provenance: { tenant_bound: false, source: "static_server_catalog" },
  };
}

/** GET /api/v1/support-integrations/providers — the static held catalog. */
export async function listSupportProviders(
  signal?: AbortSignal,
): Promise<SupportProviderSpec[]> {
  const raw = await api.get<unknown>("/api/v1/support-integrations/providers", {
    signal,
    requireOnline: true,
    maxAttempts: 1,
  });
  const decoded = decodeSupportProviderCatalog(raw);
  if (!decoded) {
    throw new SupportCatalogContractError(
      "The support provider catalog did not match its static held projection.",
    );
  }
  return decoded.items;
}

/**
 * POST /api/v1/support-integrations — create a support-provider connection.
 * Release-held: refuses before transport until the runtime is qualified.
 */
export async function connectSupportIntegration(
  input: SupportIntegrationInput,
  options: { signal?: AbortSignal } = {},
): Promise<SupportIntegration> {
  requireSupportRuntime();
  const provider = input.provider.trim();
  if (!SAFE_KEY_RE.test(provider)) {
    throw new Error("Pick a provider from the support catalog.");
  }
  return api.post<SupportIntegration>(
    "/api/v1/support-integrations",
    {
      provider,
      name: input.name?.trim() || provider,
      status: input.status ?? "connected",
      scopes: Array.isArray(input.scopes) ? input.scopes : [],
      credentials_ref: input.credentials_ref?.trim() ?? "",
      settings: input.settings ?? {},
    },
    { ...options, requireOnline: true, maxAttempts: 1 },
  );
}
