// SPDX-License-Identifier: AGPL-3.0-only
//
// tenants.ts — typed server-side fetch of GET /api/internal/ops/views/tenants.
// Mirrors board.ts: cookie forwarded (session-only), no cache, 5s timeout, and a
// non-OK / malformed response is a distinct loud failure — never an empty list.
// An empty ops surface reads as "no tenants", the falsely-green bug this console
// exists to prevent.
import { fetchOpsViewJSON, viewStatusMessage } from "./opsViewFetch";
import {
  containsControlCharacter,
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedText,
  isCanonicalUUID,
  isRecord,
  isTimestamp,
  MAX_VIEW_ROWS,
  MAX_VIEW_RESPONSE_BYTES,
  parseTruncatedEnvelope,
} from "./viewSchema";

export const MAX_TENANT_ROWS = MAX_VIEW_ROWS;
export const MAX_TENANTS_RESPONSE_BYTES = MAX_VIEW_RESPONSE_BYTES;
export const MAX_TENANT_SEARCH_LENGTH = 128;

const MAX_TENANT_SLUG_LENGTH = 128;
const MAX_TENANT_NAME_LENGTH = 256;
const MAX_TENANT_TIER_LENGTH = 64;

export type TenantHealth = "ok" | "dunning" | "suspended";

export interface TenantRow {
  tenant_id: string;
  slug: string;
  name: string;
  tier: string;
  current_period_end?: string;
  dunning: boolean;
  sending_paused: boolean;
  health: TenantHealth;
  created_at: string;
}

export type TenantsResult =
  | { ok: true; tenants: TenantRow[]; truncated: boolean }
  | { ok: false; message: string };

function parseTenantRow(value: unknown): TenantRow | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(
      value,
      ["tenant_id", "slug", "name", "tier", "dunning", "sending_paused", "health", "created_at"],
      ["current_period_end"],
    )
  ) return undefined;
  if (!isCanonicalUUID(value.tenant_id)) return undefined;
  if (!isBoundedText(value.slug, MAX_TENANT_SLUG_LENGTH)) return undefined;
  if (!isBoundedText(value.name, MAX_TENANT_NAME_LENGTH)) return undefined;
  if (!isBoundedText(value.tier, MAX_TENANT_TIER_LENGTH)) return undefined;
  if (typeof value.dunning !== "boolean") return undefined;
  if (typeof value.sending_paused !== "boolean") return undefined;
  if (
    value.health !== "ok" &&
    value.health !== "dunning" &&
    value.health !== "suspended"
  ) {
    return undefined;
  }
  const expectedHealth: TenantHealth = value.sending_paused
    ? "suspended"
    : value.dunning
      ? "dunning"
      : "ok";
  if (value.health !== expectedHealth) return undefined;
  if (!isTimestamp(value.created_at)) return undefined;
  if (
    value.current_period_end !== undefined &&
    !isTimestamp(value.current_period_end)
  ) {
    return undefined;
  }

  // Copy only the documented fields. This keeps future or accidental internal
  // fields out of the rendering boundary even when the API adds them.
  return {
    tenant_id: value.tenant_id,
    slug: value.slug,
    name: value.name,
    tier: value.tier,
    ...(value.current_period_end === undefined
      ? {}
      : { current_period_end: value.current_period_end }),
    dunning: value.dunning,
    sending_paused: value.sending_paused,
    health: value.health,
    created_at: value.created_at,
  };
}

// parseTenantsResponse turns a (status, body) into a typed result. Pure, so the
// fail-loud contract is unit-tested without a network.
export function parseTenantsResponse(
  status: number,
  body: unknown,
): TenantsResult {
  if (status !== 200) {
    return { ok: false, message: viewStatusMessage(status, "the tenant directory") };
  }
  const envelope = parseTruncatedEnvelope(body, "tenants");
  if (!envelope) {
    return { ok: false, message: "tenant directory returned an unexpected shape" };
  }

  const tenants: TenantRow[] = [];
  for (const candidate of envelope.rows) {
    const tenant = parseTenantRow(candidate);
    if (!tenant) {
      return { ok: false, message: "tenant directory returned an unexpected shape" };
    }
    tenants.push(tenant);
  }
  if (hasDuplicateKey(tenants, (tenant) => tenant.tenant_id)) {
    return { ok: false, message: "tenant directory returned an unexpected shape" };
  }
  return { ok: true, tenants, truncated: envelope.truncated };
}

export async function fetchTenants(search = ""): Promise<TenantsResult> {
  const normalizedSearch = search.trim();
  if (
    [...normalizedSearch].length > MAX_TENANT_SEARCH_LENGTH ||
    new TextEncoder().encode(
      normalizedSearch.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"),
    ).byteLength > MAX_TENANT_SEARCH_LENGTH ||
    containsControlCharacter(normalizedSearch)
  ) {
    return { ok: false, message: "the tenant search is invalid" };
  }

  const query = new URLSearchParams({ limit: String(MAX_TENANT_ROWS) });
  if (normalizedSearch) query.set("search", normalizedSearch);
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/tenants?${query.toString()}`,
  );
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.kind === "configuration"
          ? "the ops console is not configured safely"
          : result.kind === "invalid" && result.status === 200
            ? "tenant directory returned invalid data"
            : viewStatusMessage(result.status, "the tenant directory"),
    };
  }
  return parseTenantsResponse(result.status, result.body);
}
