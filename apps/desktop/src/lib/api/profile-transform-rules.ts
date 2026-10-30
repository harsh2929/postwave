// Typed client for the profile-transform-rules surface — a genuine
// "engine, no client" win. The backend (apps/api/internal/subscribers,
// property_transforms.go) derives normalized keys under custom_fields from
// existing profile fields (copy / lowercase / trim / date / json_path / …),
// with full GET/POST/DELETE, but shipped without any UI or client — operators
// could not see or manage their tenant's transform rules from either app.
// This is the client layer the desktop Subscribers > Transform-rules panel
// drives. Shapes verified against the Go handlers + PropertyTransformRule.
import type { ApiRequester, ApiResult } from "./result";

// The valid transform kinds the server accepts (else 422 validation_failed).
export type TransformKind =
  | "copy"
  | "lowercase"
  | "uppercase"
  | "trim"
  | "date"
  | "number"
  | "boolean"
  | "json_path";

// The valid rule statuses the server accepts (else 422 validation_failed).
export type TransformStatus = "active" | "paused" | "archived";

// Core resource — the upserted row (id is server-generated).
export interface PropertyTransformRule {
  id: string; // uuid
  name: string; // unique per tenant (upsert key)
  source_path: string; // key in custom_fields/merge_fields; dotted for json_path
  target_key: string; // key under custom_fields where the derived value is written
  transform: string; // one of TransformKind
  status: string; // one of TransformStatus
}

// Create-or-update payload — NO id (server-generated); transform/status optional
// (default to "copy" / "active" server-side when empty).
export interface PropertyTransformRuleInput {
  name: string;
  source_path: string;
  target_key: string;
  transform?: string;
  status?: string;
}

// The bare GET envelope — NOT the {data:...} wrapper; a plain object.
interface RulesList {
  items: PropertyTransformRule[];
  total: number;
}

interface DeleteResult {
  ok: boolean;
}

const BASE = "/api/v1/profile-transform-rules";

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// createprofileTransformRulesApi wires typed methods over the 3 mounted routes.
export function createprofileTransformRulesApi(request: ApiRequester) {
  return {
    // GET /profile-transform-rules — ALL rules for the tenant, any status,
    // ordered by name ASC. Unwrapped to the inner array, preserving .error.
    list(): Promise<ApiResult<PropertyTransformRule[]>> {
      return request<RulesList>(BASE).then(unwrapItems);
    },

    // GET /profile-transform-rules — the raw {items,total} envelope, for callers
    // that want the server-reported total alongside the rows.
    listWithTotal(): Promise<ApiResult<RulesList>> {
      return request<RulesList>(BASE);
    },

    // POST /profile-transform-rules — create-or-update by (tenant_id, name).
    // Returns the upserted row (bare object, with generated id).
    upsert(input: PropertyTransformRuleInput): Promise<ApiResult<PropertyTransformRule>> {
      return request<PropertyTransformRule>(BASE, postJson(input));
    },

    // DELETE /profile-transform-rules/{id} — {id} must be a UUID (else 400).
    // Returns { ok: true }; 404 when no row matched.
    remove(id: string): Promise<ApiResult<DeleteResult>> {
      return request<DeleteResult>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

// unwrapItems flattens the server's {items,total} envelope to T[], preserving
// the ApiErr branch unchanged so callers still discriminate on `.error`.
function unwrapItems(res: ApiResult<RulesList>): ApiResult<PropertyTransformRule[]> {
  if (res.error) return res;
  return { data: res.data.items ?? [] };
}

export type ProfileTransformRulesApi = ReturnType<typeof createprofileTransformRulesApi>;
