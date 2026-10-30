/**
 * api/deliverabilityProviders.ts — the ESP connections that feed
 * deliverability evidence (bounce/complaint webhooks, suppression mirrors).
 *
 *   GET    /api/v1/deliverability/providers        (viewer)
 *   POST   /api/v1/deliverability/providers        (admin — upsert by provider)
 *   PATCH  /api/v1/deliverability/providers/{id}   (admin)
 *   DELETE /api/v1/deliverability/providers/{id}   (admin)
 *
 * Secrets never travel raw: the GET masks stored values as "redacted", the
 * server MERGES an echoed redacted sentinel back to the stored value, and a
 * `credential_ref` is a runtime-secret NAME, not credential material
 * (apps/api/internal/webhooks/provider_config.go). All writes are ONLINE-ONLY
 * and never queued — they carry secret-adjacent configuration.
 */
import { rawRequest, type AIApiError } from "./request";

import { itemsOf, str, WireShapeError } from "@/lib/deliverabilityContracts";

class ProvidersError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ProvidersError";
    this.status = error.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ProviderConnection {
  id: string;
  provider: string;
  displayName: string;
  active: boolean;
  updatedAt: string;
  /** Redacted on the wire — presence-only claims are derived from this. */
  config: Record<string, unknown>;
}

function parseConnection(row: Record<string, unknown>): ProviderConnection | null {
  const id = str(row.id).trim();
  const provider = str(row.provider).trim();
  if (!id || !provider) return null;
  return {
    id,
    provider,
    displayName: str(row.display_name),
    active: row.active === true,
    updatedAt: str(row.updated_at),
    config: isRecord(row.config) ? row.config : {},
  };
}

/** GET — `{items: [...]}` (handler writes the envelope's items key). */
export async function fetchProviderConnections(): Promise<ProviderConnection[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/deliverability/providers");
  if (res.error) {
    throw new ProvidersError(res.error, "Couldn't load provider connections.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("provider connections");
  const out: ProviderConnection[] = [];
  for (const row of itemsOf(res.data.items ?? [], "provider connections")) {
    if (!isRecord(row)) continue;
    const parsed = parseConnection(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface ProviderUpsertInput {
  provider: string;
  displayName: string;
  /** Raw webhook token (32–512 chars) — hashed at rest server-side. */
  webhookToken?: string;
  /** Runtime-secret NAME for suppression-mirror credentials. */
  credentialRef?: string;
  active?: boolean;
}

function upsertBody(input: ProviderUpsertInput): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (input.webhookToken?.trim()) config.webhook_token = input.webhookToken.trim();
  if (input.credentialRef?.trim()) config.credential_ref = input.credentialRef.trim();
  const body: Record<string, unknown> = {
    provider: input.provider,
    display_name: input.displayName.trim(),
    config,
  };
  if (input.active !== undefined) body.active = input.active;
  return body;
}

/** POST — create (or update by provider name). Returns the saved row. */
export async function createProviderConnection(
  input: ProviderUpsertInput,
): Promise<ProviderConnection> {
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/deliverability/providers",
    upsertBody(input),
  );
  if (res.error) {
    throw new ProvidersError(res.error, "Couldn't save the provider connection.");
  }
  const item = isRecord(res.data) && isRecord(res.data.item) ? res.data.item : null;
  const parsed = item ? parseConnection(item) : null;
  if (!parsed) throw new WireShapeError("provider connection");
  return parsed;
}

/**
 * PATCH — flip active (or rename) on one connection. The FULL redacted config
 * is echoed back because the handler stores what it is sent after merging:
 * redacted sentinels keep stored secrets, but an omitted config would still
 * merge onto the stored one server-side — echoing is belt and braces against
 * that contract drifting.
 */
export async function setProviderConnection(
  connection: ProviderConnection,
  patch: { active?: boolean; displayName?: string },
): Promise<ProviderConnection> {
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/deliverability/providers/${encodeURIComponent(connection.id)}`,
    {
      provider: connection.provider,
      display_name: patch.displayName ?? connection.displayName,
      config: connection.config,
      active: patch.active ?? connection.active,
    },
  );
  if (res.error) {
    throw new ProvidersError(res.error, "Couldn't update the provider connection.");
  }
  const item = isRecord(res.data) && isRecord(res.data.item) ? res.data.item : null;
  const parsed = item ? parseConnection(item) : null;
  if (!parsed) throw new WireShapeError("provider connection");
  return parsed;
}

/** DELETE — the server must confirm (`{ok: true}`), desktop's parseMutationOk rule. */
export async function deleteProviderConnection(id: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/deliverability/providers/${encodeURIComponent(id)}`,
  );
  if (res.error) {
    throw new ProvidersError(res.error, "Couldn't remove the provider connection.");
  }
  if (!isRecord(res.data) || res.data.ok !== true) {
    throw new Error("The server did not confirm the removal.");
  }
}
