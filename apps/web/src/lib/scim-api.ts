// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for SCIM admin: bearer-token mint/revoke + SCIM group→role
// mappings. Backend: apps/api/internal/scim/role_mappings.go (all ScopeAdmin).
// The minted token is returned ONCE and never re-readable.

import { api } from "@/lib/api";

export interface ScimToken {
  id: string;
  prefix: string;
  description: string;
  created_at: string;
  revoked_at?: string | null;
  last_used_at?: string | null;
}

export interface MintedToken {
  token: string;
  prefix: string;
  warning: string;
}

export interface RoleMapping {
  id: string;
  group_name: string;
  role: string;
  precedence: number;
  created_at: string;
}

export interface UpsertRoleMappingInput {
  group_name: string;
  role: string;
  precedence?: number;
}

export interface ScimRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

// The IdP role enum the backend validates against.
export const SCIM_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type ScimRole = (typeof SCIM_ROLES)[number];

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function listScimTokens(
  options: Pick<ScimRequestOptions, "signal"> = {},
): Promise<ScimToken[]> {
  const body = await api.get<unknown>("/api/v1/scim/tokens", {
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("SCIM-token response was malformed.");
  }
  const tokens = (body as Record<string, unknown>).tokens;
  if (!Array.isArray(tokens) || tokens.length > 1_000) {
    throw new Error("SCIM-token response was malformed.");
  }
  const parsed = tokens.map(parseScimToken);
  if (new Set(parsed.map((token) => token.id)).size !== parsed.length) {
    throw new Error("SCIM-token response repeated a token.");
  }
  return parsed;
}

export async function mintScimToken(
  description?: string,
  options: ScimRequestOptions = {},
): Promise<MintedToken> {
  return parseMintedToken(
    await api.post<unknown>(
      "/api/v1/scim/tokens",
      { description: (description ?? "").trim() },
      mutationOptions(options),
    ),
  );
}

export function revokeScimToken(
  id: string,
  options: ScimRequestOptions = {},
): Promise<void> {
  return api.delete<void>(
    `/api/v1/scim/tokens/${encodeURIComponent(id)}`,
    mutationOptions(options),
  );
}

// ---------------------------------------------------------------------------
// Role mappings
// ---------------------------------------------------------------------------

export async function listRoleMappings(
  options: Pick<ScimRequestOptions, "signal"> = {},
): Promise<RoleMapping[]> {
  const body = await api.get<unknown>("/api/v1/scim/role-mappings", {
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("SCIM role-mapping response was malformed.");
  }
  const mappings = (body as Record<string, unknown>).mappings;
  if (!Array.isArray(mappings) || mappings.length > 5_000) {
    throw new Error("SCIM role-mapping response was malformed.");
  }
  const parsed = mappings.map(parseRoleMapping);
  if (new Set(parsed.map((mapping) => mapping.id)).size !== parsed.length) {
    throw new Error("SCIM role-mapping response repeated a mapping.");
  }
  return parsed;
}

export async function upsertRoleMapping(
  input: UpsertRoleMappingInput,
  options: ScimRequestOptions = {},
): Promise<RoleMapping> {
  return parseRoleMapping(
    await api.post<unknown>(
      "/api/v1/scim/role-mappings",
      normalizeRoleMappingInput(input),
      mutationOptions(options),
    ),
  );
}

export function deleteRoleMapping(
  id: string,
  options: ScimRequestOptions = {},
): Promise<void> {
  return api.delete<void>(
    `/api/v1/scim/role-mappings/${encodeURIComponent(id)}`,
    mutationOptions(options),
  );
}

function mutationOptions(options: ScimRequestOptions) {
  return {
    cache: "no-store" as const,
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
  };
}

function boundedText(
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function optionalTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      value.length <= 128 &&
      Number.isFinite(Date.parse(value)))
  );
}

function parseScimToken(value: unknown): ScimToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SCIM-token response contained an invalid token.");
  }
  const row = value as Record<string, unknown>;
  if (
    !boundedText(row.id, 512) ||
    !boundedText(row.prefix, 256) ||
    !boundedText(row.description, 1_024, true) ||
    !optionalTimestamp(row.created_at) ||
    typeof row.created_at !== "string" ||
    !optionalTimestamp(row.revoked_at) ||
    !optionalTimestamp(row.last_used_at)
  ) {
    throw new Error("SCIM-token response contained an invalid token.");
  }
  return row as unknown as ScimToken;
}

function parseMintedToken(value: unknown): MintedToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SCIM token creation returned an invalid receipt.");
  }
  const row = value as Record<string, unknown>;
  if (
    !boundedText(row.token, 16 * 1024) ||
    !boundedText(row.prefix, 256) ||
    !boundedText(row.warning, 2_048, true)
  ) {
    throw new Error("SCIM token creation returned an invalid receipt.");
  }
  return row as unknown as MintedToken;
}

function parseRoleMapping(value: unknown): RoleMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SCIM role-mapping response contained an invalid mapping.");
  }
  const row = value as Record<string, unknown>;
  if (
    !boundedText(row.id, 512) ||
    !boundedText(row.group_name, 1_024) ||
    !SCIM_ROLES.includes(row.role as ScimRole) ||
    !Number.isSafeInteger(row.precedence) ||
    Number(row.precedence) < 0 ||
    Number(row.precedence) > 1_000 ||
    !optionalTimestamp(row.created_at) ||
    typeof row.created_at !== "string"
  ) {
    throw new Error("SCIM role-mapping response contained an invalid mapping.");
  }
  return row as unknown as RoleMapping;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Validates + normalizes a role-mapping form. Throws for inputs the API
 * would reject (empty group, bad role, out-of-range precedence). */
export function normalizeRoleMappingInput(
  input: UpsertRoleMappingInput,
): UpsertRoleMappingInput {
  const group_name = (input.group_name ?? "").trim();
  if (!group_name) throw new Error("Group name is required.");
  const role = (input.role ?? "").trim().toLowerCase();
  if (!SCIM_ROLES.includes(role as ScimRole)) {
    throw new Error(`Role must be one of: ${SCIM_ROLES.join(", ")}.`);
  }
  const precedence = input.precedence ?? 0;
  if (!Number.isFinite(precedence) || precedence < 0 || precedence > 1000) {
    throw new Error("Precedence must be between 0 and 1000.");
  }
  return { group_name, role, precedence: Math.round(precedence) };
}

/** Whether a token is still usable (not revoked). */
export function isTokenActive(t: ScimToken): boolean {
  return !t.revoked_at;
}
