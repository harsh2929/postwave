/**
 * api/scimMappings.ts — the SCIM role-mapping WRITES (the read stays with the
 * SDK in api/ops.ts).
 *
 *   POST   /api/v1/scim/role-mappings        upsert on (tenant, group_name)
 *   DELETE /api/v1/scim/role-mappings/{id}
 *
 * Both admin (family:admin, manifest-reviewed). ONLINE-ONLY, never the
 * offline outbox: a role mapping decides who becomes an admin at SSO time —
 * replaying one hours later, after a colleague already fixed the matrix,
 * would silently re-grant the very privilege being removed.
 */
import { rawRequest, type AIApiError } from "./request";

const BASE = "/api/v1/scim/role-mappings";

export class ScimMappingError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ScimMappingError";
    this.status = error.status;
    this.code = error.code;
  }
}

export interface UpsertScimMappingInput {
  groupName: string;
  role: string;
  precedence: number;
}

export interface ScimMappingResult {
  id: string;
  groupName: string;
  role: string;
  precedence: number;
}

export async function upsertScimRoleMapping(
  input: UpsertScimMappingInput,
): Promise<ScimMappingResult> {
  const res = await rawRequest<Record<string, unknown>>("POST", BASE, {
    group_name: input.groupName.trim(),
    role: input.role,
    precedence: input.precedence,
  });
  if (res.error) {
    throw new ScimMappingError(res.error, "Saving the role mapping");
  }
  const raw = res.data ?? {};
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    groupName: typeof raw.group_name === "string" ? raw.group_name : "",
    role: typeof raw.role === "string" ? raw.role : input.role,
    precedence:
      typeof raw.precedence === "number" ? raw.precedence : input.precedence,
  };
}

export async function deleteScimRoleMapping(id: string): Promise<void> {
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("A mapping id is required.");
  const res = await rawRequest<unknown>(
    "DELETE",
    `${BASE}/${encodeURIComponent(trimmed)}`,
    undefined,
  );
  if (res.error) {
    throw new ScimMappingError(res.error, "Deleting the role mapping");
  }
}
