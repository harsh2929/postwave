// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the api-keys endpoints. Mirrors the forms-api /
// webhooks-api patterns: real fetch by default; mocks are opt-in via
// NEXT_PUBLIC_USE_MOCKS=1.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

export type ApiKeyScope =
  | "read:subscribers"
  | "write:subscribers"
  | "read:campaigns"
  | "write:campaigns"
  | "send:transactional"
  | "read:reports"
  | "admin"
  | "audit:read"
  | "audit:read_pii"
  | "audit:read_all_tenants"
  | "audit:configure_sinks"
  | "audit:configure_retention"
  | "audit:execute_actions";

export const ALL_API_KEY_SCOPES: { value: ApiKeyScope; label: string }[] = [
  { value: "read:subscribers", label: "Read subscribers" },
  { value: "write:subscribers", label: "Write subscribers" },
  { value: "read:campaigns", label: "Read campaigns" },
  { value: "write:campaigns", label: "Write campaigns" },
  { value: "send:transactional", label: "Send transactional" },
  { value: "read:reports", label: "Read reports" },
  { value: "admin", label: "Admin (everything)" },
  { value: "audit:read", label: "Read audit events" },
  { value: "audit:read_pii", label: "Read audit PII" },
  { value: "audit:read_all_tenants", label: "Read all tenants' audits" },
  { value: "audit:configure_sinks", label: "Configure audit sinks" },
  {
    value: "audit:configure_retention",
    label: "Configure audit retention",
  },
  { value: "audit:execute_actions", label: "Execute audit actions" },
];

export interface ApiKey {
  id: string;
  tenantId: string;
  label: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  sandboxOnly?: boolean;
  /** Optional expiry (SETC-036); null = never. */
  expiresAt?: string | null;
}

export interface CreateApiKeyInput {
  label: string;
  scopes: ApiKeyScope[];
  sandbox_only?: boolean;
  /** RFC3339 expiry; omitted = never expires (SETC-036). */
  expires_at?: string;
  /** Optional CIDR / bare-IP allowlist. Requests from other IPs are rejected
   * server-side. Empty/omitted = no network restriction (SETC-051). */
  allowed_ips?: string[];
}

/**
 * Validates an IP-allowlist entry as a bare IPv4/IPv6 address or a CIDR block,
 * mirroring the server's per-entry check so a bad entry is caught inline before
 * the create round-trips. Returns null when valid, else an error string.
 */
export function validateAllowedIp(entry: string): string | null {
  const value = entry.trim();
  if (!value) return "Empty allowlist entry.";
  const [addr, maskRaw, ...rest] = value.split("/");
  if (rest.length > 0) return `"${entry}" is not a valid IP or CIDR.`;
  const isV4 =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(addr) &&
    addr.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255);
  // Loose IPv6 shape check — the server does the authoritative parse.
  const isV6 = addr.includes(":") && /^[0-9a-fA-F:]+$/.test(addr);
  if (!isV4 && !isV6) return `"${entry}" is not a valid IP or CIDR.`;
  if (maskRaw !== undefined) {
    const mask = Number(maskRaw);
    const max = isV4 ? 32 : 128;
    if (!Number.isInteger(mask) || mask < 0 || mask > max) {
      return `"${entry}" has an invalid CIDR prefix.`;
    }
  }
  return null;
}

export interface CreateApiKeyResponse {
  key: ApiKey;
  /** The full plaintext key. Returned exactly once at creation time. */
  plaintext: string;
}

export interface RotateApiKeyResponse extends CreateApiKeyResponse {
  revoked_id: string;
}

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./api-keys-mocks");

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function listApiKeys(signal?: AbortSignal): Promise<ApiKey[]> {
  return withMockFallback(
    () => api.get<ApiKey[]>("/api/v1/api-keys", { signal }),
    async () => (await loadMocks()).mockListApiKeys(),
  );
}

/** One recorded request made with an API key (SETC-041). */
export interface ApiKeyCall {
  id: number;
  method: string;
  path: string;
  toolName?: string;
  statusCode: number;
  latencyMs: number;
  remoteIp?: string;
  errorCode?: string;
  calledAt: string;
}

/** Recent requests for one key, via the existing api_key_calls feed. */
export function listApiKeyUsage(id: string, signal?: AbortSignal): Promise<ApiKeyCall[]> {
  return api
    .get<{ rows: ApiKeyCall[] }>(
      `/api/v1/mcp/executions?include=all&api_key_id=${encodeURIComponent(id)}&limit=50`,
      { signal },
    )
    .then((r) => Array.isArray(r.rows) ? r.rows : []);
}

export function createApiKey(
  input: CreateApiKeyInput,
  signal?: AbortSignal,
): Promise<CreateApiKeyResponse> {
  return withMockFallback(
    () => api.post<CreateApiKeyResponse>("/api/v1/api-keys", input, { signal }),
    async () => (await loadMocks()).mockCreateApiKey(input),
  );
}

export function revokeApiKey(id: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return withMockFallback(
    () =>
      api.delete<{ ok: true }>(`/api/v1/api-keys/${encodeURIComponent(id)}`, { signal }),
    async () => {
      (await loadMocks()).mockRevokeApiKey(id);
      return { ok: true as const };
    },
  );
}

/** Edit a key's label + scopes in place, no rotation (SETC-040). */
export function updateApiKey(
  id: string,
  input: { label: string; scopes: ApiKeyScope[] },
  signal?: AbortSignal,
): Promise<ApiKey> {
  return api.patch<ApiKey>(
    `/api/v1/api-keys/${encodeURIComponent(id)}`,
    input,
    { signal },
  );
}

export function rotateApiKey(id: string, signal?: AbortSignal): Promise<RotateApiKeyResponse> {
  return withMockFallback(
    () =>
      api.post<RotateApiKeyResponse>(
        `/api/v1/api-keys/${encodeURIComponent(id)}/rotate`,
        undefined,
        { signal },
      ),
    async () => (await loadMocks()).mockRotateApiKey(id),
  );
}

/** Renders the masked-tail shorthand the list view uses. */
export function maskedDisplay(key: ApiKey): string {
  return `${key.prefix}${"\u2022".repeat(4)}`;
}
