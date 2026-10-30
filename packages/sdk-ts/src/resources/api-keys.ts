// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

/** Canonical API-key scope catalogue, kept in parity with apikeys.AllScopes. */
export const API_KEY_SCOPES = [
  "read:subscribers",
  "write:subscribers",
  "read:campaigns",
  "write:campaigns",
  "send:transactional",
  "read:reports",
  "admin",
  "audit:read",
  "audit:read_pii",
  "audit:read_all_tenants",
  "audit:configure_sinks",
  "audit:configure_retention",
  "audit:execute_actions",
  "mcp",
] as const;

export type APIKeyScope = (typeof API_KEY_SCOPES)[number];

export interface APIKey {
  id: string;
  tenantId: string;
  label: string;
  prefix: string;
  scopes: APIKeyScope[];
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  userId?: string;
  actorType: "human" | "agent";
  actorLabel?: string;
  sendsPerDay?: number;
  dollarsPerMonthCents?: number;
  allowedIps?: string[];
  rateLimitPerMin?: number;
  rateLimitPerDay?: number;
  rateLimitBurst?: number;
  sandboxOnly: boolean;
  expiresAt?: string | null;
}

export interface CreateAPIKeyInput {
  label: string;
  scopes: APIKeyScope[];
  expires_at?: string;
  allowed_ips?: string[];
  sandbox_only?: boolean;
}

export interface CreateAPIKeyResponse {
  key: APIKey;
  /** The full plaintext key. Returned exactly once at creation time. */
  plaintext: string;
}

/**
 * RotateAPIKeyResponse: returned by `pw.apiKeys.rotate(id)`.
 *
 * The OLD plaintext stops working the instant this resolves — there is
 * NO grace period. To migrate without downtime, `create` a second key,
 * deploy your callers, then `revoke` the original.
 */
export interface RotateAPIKeyResponse {
  key: APIKey;
  /** The new plaintext key. Returned exactly once. */
  plaintext: string;
  /** ID of the just-revoked source key. Useful for audit-log copy. */
  revoked_id: string;
}

export class APIKeysResource extends Resource {
  list(): Promise<APIKey[]> {
    return this.client.request("GET", "/api/v1/api-keys");
  }

  /** Fetch a single key (no plaintext). */
  get(id: string): Promise<APIKey> {
    return this.client.request(
      "GET",
      `/api/v1/api-keys/${encodeURIComponent(id)}`,
    );
  }

  create(input: CreateAPIKeyInput): Promise<CreateAPIKeyResponse> {
    return this.client.request("POST", "/api/v1/api-keys", { body: input });
  }

  /**
   * Rotate a key: atomically revokes the source + creates a new one
   * inheriting the same label, scopes, and budget caps. The new
   * plaintext is echoed once — store it before the promise resolves
   * is consumed.
   */
  rotate(id: string): Promise<RotateAPIKeyResponse> {
    return this.client.request(
      "POST",
      `/api/v1/api-keys/${encodeURIComponent(id)}/rotate`,
    );
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/api-keys/${encodeURIComponent(id)}`,
    );
  }

  /** Alias of delete(). Revokes the key — subsequent requests using it return 401. */
  revoke(id: string): Promise<{ ok: boolean }> {
    return this.delete(id);
  }
}
